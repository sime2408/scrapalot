"""
SettingsAIService gRPC Implementation

Implements the SettingsAIService defined in settings_ai.proto.
Wraps Python's model provider management, embedding config, RAG strategies, and service status.
"""

import json

import grpc

from src.main.grpc import common_pb2, settings_ai_pb2, settings_ai_pb2_grpc
from src.main.grpc.grpc_utils import grpc_db_session
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# noinspection PyUnresolvedReferences
def _model_to_proto(m):
    """Convert a ModelProviderModel DB object to a settings_ai_pb2.ModelInfo proto."""
    return settings_ai_pb2.ModelInfo(
        id=str(m.id),
        provider_id=str(m.provider_id),
        model_name=m.model_name or "",
        display_name=m.display_name or m.model_name or "",
        model_type=m.model_type or "NORMAL",
        context_window=m.context_window or 0,
        dimensions=m.dimensions or 0,
        icon=getattr(m, "icon", "") or "",
        is_default=bool(getattr(m, "is_default", False)),
    )


def _build_provider_payload(provider):
    """Build the event payload dict for a model provider Redis Streams event."""
    return {
        "id": str(provider.id),
        "user_id": str(provider.user_id) if provider.user_id else None,
        "name": provider.name,
        "provider_type": provider.provider_type,
        "status": provider.status or "active",
        "api_base": provider.api_base,
        "show_models": provider.show_models,
        "description": provider.description,
    }


# noinspection PyUnresolvedReferences
class SettingsAIServiceServicer(settings_ai_pb2_grpc.SettingsAIServiceServicer):
    """SettingsAIService gRPC implementation."""

    async def ListProviders(self, request, context):
        logger.info("SettingsAIService.ListProviders called - user_id=%s", request.user_id)
        try:
            from sqlalchemy import case, or_

            from src.main.models.sqlmodel_providers import ModelProvider, ModelProviderModel

            with grpc_db_session() as db:
                query = db.query(ModelProvider)
                if request.provider_id:
                    # noinspection PyTypeChecker
                    query = query.filter(ModelProvider.id == request.provider_id)

                # Filter by user: show user's own providers + global providers (user_id IS NULL)
                if request.user_id:
                    query = query.filter(
                        or_(
                            ModelProvider.user_id == request.user_id,
                            ModelProvider.user_id.is_(None),
                        )
                    )

                # Order: system providers first, then alphabetical
                # noinspection PyTypeChecker
                query = query.order_by(
                    case(
                        (ModelProvider.provider_type == "system", 0),
                        else_=1,
                    ),
                    ModelProvider.name,
                )

                providers = query.all()
                provider_infos = []
                for p in providers:
                    # noinspection PyTypeChecker
                    models = db.query(ModelProviderModel).filter(ModelProviderModel.provider_id == p.id).all()

                    provider_infos.append(
                        settings_ai_pb2.ProviderInfo(
                            id=str(p.id),
                            name=p.name or "",
                            api_base=p.api_base or "",
                            provider_type=p.provider_type or "",
                            status=p.status or "active",
                            icon=getattr(p, "icon", "") or "",
                            is_enabled=getattr(p, "is_enabled", True),
                            created_at=p.created_at.isoformat() if p.created_at else "",
                            updated_at=p.updated_at.isoformat() if p.updated_at else "",
                            models=[_model_to_proto(m) for m in models],
                            has_api_key=bool(p.api_key and p.api_key.strip()),
                        )
                    )

                return settings_ai_pb2.ListProvidersResponse(providers=provider_infos)
        except Exception as e:
            logger.exception("Error in ListProviders: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, str(e))

    async def CreateProvider(self, request, context):
        logger.info("SettingsAIService.CreateProvider called - name=%s", request.name)
        try:
            import uuid

            from src.main.models.sqlmodel_providers import ModelProvider

            with grpc_db_session() as db:
                provider = ModelProvider(
                    id=str(uuid.uuid4()),
                    name=request.name,
                    api_key=request.api_key or None,
                    api_base=request.api_base or None,
                    provider_type=request.provider_type,
                    status="active",
                )
                db.add(provider)
                db.commit()
                db.refresh(provider)

                from src.main.service.model_provider_snapshot import publish_model_provider_event

                publish_model_provider_event(
                    event_type="MODEL_PROVIDER_CREATED",
                    provider_id=str(provider.id),
                    payload=_build_provider_payload(provider),
                    db=db,
                )

                if request.auto_sync:
                    try:
                        from src.main.service.remote_model_sync import RemoteModelSyncService

                        sync_service = RemoteModelSyncService()
                        await sync_service.sync_provider(db, provider)
                    except Exception as sync_err:
                        logger.warning("Auto-sync failed for provider %s: %s", request.name, str(sync_err))

                return settings_ai_pb2.ProviderResponse(
                    success=True,
                    provider=settings_ai_pb2.ProviderInfo(
                        id=str(provider.id),
                        name=provider.name or "",
                        provider_type=provider.provider_type or "",
                        status=provider.status or "active",
                    ),
                )
        except Exception as e:
            logger.exception("Error in CreateProvider: %s", str(e))
            return settings_ai_pb2.ProviderResponse(success=False, error=str(e))

    async def UpdateProvider(self, request, context):
        logger.info("SettingsAIService.UpdateProvider called - id=%s", request.provider_id)
        try:
            from src.main.models.sqlmodel_providers import ModelProvider, ModelProviderModel

            with grpc_db_session() as db:
                # noinspection PyTypeChecker
                provider = db.query(ModelProvider).filter(ModelProvider.id == request.provider_id).first()
                if not provider:
                    return settings_ai_pb2.ProviderResponse(success=False, error="Provider not found")

                if request.name:
                    provider.name = request.name
                if request.api_key:
                    provider.api_key = request.api_key
                if request.api_base:
                    provider.api_base = request.api_base
                if request.provider_type:
                    provider.provider_type = request.provider_type

                # Sync models when selected_model_names is provided
                selected_names = list(request.selected_model_names)
                if selected_names:
                    # Delete deselected models
                    # noinspection PyTypeChecker
                    deleted = (
                        db.query(ModelProviderModel)
                        .filter(
                            ModelProviderModel.provider_id == request.provider_id,
                            ModelProviderModel.model_name.notin_(selected_names),
                        )
                        .delete(synchronize_session=False)
                    )
                    if deleted:
                        logger.info(
                            "Deleted %s deselected models for provider %s",
                            deleted,
                            request.provider_id,
                        )

                    # Add newly selected models that don't exist in DB yet
                    existing_names = {
                        m.model_name
                        for m in db.query(ModelProviderModel.model_name)
                        .filter(
                            ModelProviderModel.provider_id == request.provider_id,
                        )
                        .all()
                    }
                    import uuid

                    new_models = [n for n in selected_names if n not in existing_names]
                    for model_name in new_models:
                        db.add(
                            ModelProviderModel(
                                id=str(uuid.uuid4()),
                                provider_id=request.provider_id,
                                model_name=model_name,
                                display_name=model_name,
                                model_type="NORMAL",
                                is_default=False,
                            )
                        )
                    if new_models:
                        logger.info(
                            "Added %s new models for provider %s: %s",
                            len(new_models),
                            request.provider_id,
                            new_models,
                        )

                db.commit()

                from src.main.service.model_provider_snapshot import publish_model_provider_event

                publish_model_provider_event(
                    event_type="MODEL_PROVIDER_UPDATED",
                    provider_id=str(provider.id),
                    payload=_build_provider_payload(provider),
                    db=db,
                )

                if request.auto_sync:
                    try:
                        from src.main.service.remote_model_sync import RemoteModelSyncService

                        sync_service = RemoteModelSyncService()
                        await sync_service.sync_provider(db, provider)
                    except Exception as sync_err:
                        logger.warning("Auto-sync failed: %s", str(sync_err))

                return settings_ai_pb2.ProviderResponse(
                    success=True,
                    provider=settings_ai_pb2.ProviderInfo(
                        id=str(provider.id),
                        name=provider.name or "",
                        provider_type=provider.provider_type or "",
                    ),
                )
        except Exception as e:
            logger.exception("Error in UpdateProvider: %s", str(e))
            return settings_ai_pb2.ProviderResponse(success=False, error=str(e))

    async def DeleteProvider(self, request, context):
        logger.info("SettingsAIService.DeleteProvider called - id=%s", request.provider_id)
        try:
            from src.main.models.sqlmodel_providers import ModelProvider, ModelProviderModel

            with grpc_db_session() as db:
                # noinspection PyTypeChecker
                db.query(ModelProviderModel).filter(ModelProviderModel.provider_id == request.provider_id).delete()
                # noinspection PyTypeChecker
                db.query(ModelProvider).filter(ModelProvider.id == request.provider_id).delete()
                db.commit()

                from src.main.service.model_provider_snapshot import publish_model_provider_event

                publish_model_provider_event(
                    event_type="MODEL_PROVIDER_DELETED",
                    provider_id=request.provider_id,
                    payload={"id": request.provider_id},
                    db=db,
                )

                return common_pb2.StatusResponse(success=True, message="Provider deleted")
        except Exception as e:
            logger.exception("Error in DeleteProvider: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def ListModels(self, request, context):
        logger.info("SettingsAIService.ListModels called")
        try:
            from src.main.models.sqlmodel_providers import ModelProvider, ModelProviderModel

            with grpc_db_session() as db:
                # noinspection PyTypeChecker
                models = db.query(ModelProviderModel).join(ModelProvider).filter(ModelProvider.status == "active").all()

                return settings_ai_pb2.ListModelsResponse(models=[_model_to_proto(m) for m in models])
        except Exception as e:
            logger.exception("Error in ListModels: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, str(e))

    async def SetSelectedModel(self, request, context):
        logger.info("SettingsAIService.SetSelectedModel called - model=%s", request.model_name)
        try:
            from src.main.models.sqlmodel_models import UserSetting

            with grpc_db_session() as db:
                setting = (
                    db.query(UserSetting)
                    .filter(
                        UserSetting.user_id == request.user_id,
                        UserSetting.setting_key == "selected_model",
                    )
                    .first()
                )

                value = json.dumps(
                    {
                        "model": request.model_id,
                        "model_name": request.model_name,
                        "provider_type": request.provider_type,
                    }
                )

                if setting:
                    setting.setting_value = value
                else:
                    setting = UserSetting(
                        user_id=request.user_id,
                        setting_key="selected_model",
                        setting_value=value,
                    )
                    db.add(setting)

                db.commit()
                return settings_ai_pb2.SelectedModelResponse(
                    success=True,
                    model_id=request.model_id,
                    display_name=request.model_name,
                    provider_type=request.provider_type,
                )
        except Exception as e:
            logger.exception("Error in SetSelectedModel: %s", str(e))
            return settings_ai_pb2.SelectedModelResponse(success=False, error=str(e))

    async def GetEmbeddingConfig(self, request, context):
        logger.info("SettingsAIService.GetEmbeddingConfig called")
        try:
            from src.main.models.sqlmodel_models import UserSetting

            with grpc_db_session() as db:
                setting = (
                    db.query(UserSetting)
                    .filter(
                        UserSetting.user_id == request.user_id,
                        UserSetting.setting_key == "embedding",
                    )
                    .first()
                )

                if setting:
                    return settings_ai_pb2.EmbeddingConfigResponse(
                        settings_json=setting.setting_value or "",
                    )
                return settings_ai_pb2.EmbeddingConfigResponse()
        except Exception as e:
            logger.exception("Error in GetEmbeddingConfig: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, str(e))

    async def SetEmbeddingConfig(self, request, context):
        logger.info("SettingsAIService.SetEmbeddingConfig called - model=%s", request.embedding_model)
        try:
            from src.main.models.sqlmodel_models import UserSetting

            with grpc_db_session() as db:
                setting = (
                    db.query(UserSetting)
                    .filter(
                        UserSetting.user_id == request.user_id,
                        UserSetting.setting_key == "embedding",
                    )
                    .first()
                )

                value = json.dumps({"embedding_model": request.embedding_model})
                if setting:
                    setting.setting_value = value
                else:
                    setting = UserSetting(
                        user_id=request.user_id,
                        setting_key="embedding",
                        setting_value=value,
                    )
                    db.add(setting)

                db.commit()
                return common_pb2.StatusResponse(success=True, message="Embedding config updated")
        except Exception as e:
            logger.exception("Error in SetEmbeddingConfig: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def ListEmbeddingModels(self, request, context):
        logger.info("SettingsAIService.ListEmbeddingModels called")
        try:
            from src.main.models.sqlmodel_providers import ModelProviderModel

            with grpc_db_session() as db:
                # noinspection PyTypeChecker
                models = db.query(ModelProviderModel).filter(ModelProviderModel.model_type == "EMBEDDING").all()

                return settings_ai_pb2.ListModelsResponse(models=[_model_to_proto(m) for m in models])
        except Exception as e:
            logger.exception("Error in ListEmbeddingModels: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, str(e))

    async def ListRagStrategies(self, request, context):
        logger.info("SettingsAIService.ListRagStrategies called")
        try:
            from src.main.service.rag.rag_strategy_registry import get_rag_strategies

            strategies = get_rag_strategies()
            return settings_ai_pb2.RagStrategiesResponse(
                strategies_json=json.dumps(strategies),
            )
        except Exception as e:
            logger.exception("Error in ListRagStrategies: %s", str(e))
            return settings_ai_pb2.RagStrategiesResponse(strategies_json="[]")

    async def GetServiceStatus(self, request, context):
        logger.info("SettingsAIService.GetServiceStatus called")
        try:
            import time

            import psutil

            from src.main.utils.config.loader import resolved_config

            process = psutil.Process()
            config = resolved_config.get("service", {})

            return settings_ai_pb2.ServiceStatusResponse(
                service_name="scrapalot-chat",
                version=config.get("version", "unknown"),
                status="running",
                host="0.0.0.0",
                port=int(config.get("port", 8090)),
                uptime_seconds=time.time() - process.create_time(),
                memory_usage=f"{process.memory_info().rss / 1024 / 1024:.1f}MB",
                cpu_percent=process.cpu_percent(),
            )
        except Exception as e:
            logger.exception("Error in GetServiceStatus: %s", str(e))
            return settings_ai_pb2.ServiceStatusResponse(status="error")

    async def SyncUserSetting(self, request, context):
        """Receive a user setting push from Kotlin backend and store it locally."""
        logger.info(
            "SettingsAIService.SyncUserSetting called - user=%s, key=%s, op=%s",
            request.user_id,
            request.setting_key,
            request.operation,
        )
        try:
            from src.main.service.user_settings_service import UserSettingsService

            with grpc_db_session() as db:
                service = UserSettingsService(db)

                if request.operation == "DELETE":
                    service.delete_setting(request.user_id, request.setting_key)
                    return common_pb2.StatusResponse(success=True, message="Setting deleted")

                value = json.loads(request.setting_value_json) if request.setting_value_json else {}
                service.set_setting(request.user_id, request.setting_key, value)
                return common_pb2.StatusResponse(success=True, message="Setting synced")
        except Exception as e:
            logger.exception("Error in SyncUserSetting: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def GetSystemAgentConfig(self, request, context):
        """Get the system agent LLM configuration from server_settings."""
        logger.info("SettingsAIService.GetSystemAgentConfig called")
        try:
            from src.main.models.sqlmodel_settings import ServerSetting

            with grpc_db_session() as db:
                setting = (
                    db.query(ServerSetting)
                    .filter(
                        ServerSetting.setting_key == "system_agent_config",
                    )
                    .first()
                )

                if setting and setting.setting_value:
                    config = setting.setting_value
                    # Sanitize config_json before returning: never expose raw API
                    # keys (top-level OR the synthesis sub-config). Surface only a
                    # boolean has_api_key per block so the UI can show "key set".
                    safe = dict(config)
                    safe.pop("api_key", None)
                    if isinstance(safe.get("synthesis"), dict):
                        syn = dict(safe["synthesis"])
                        syn["has_api_key"] = bool(syn.pop("api_key", None))
                        safe["synthesis"] = syn
                    return settings_ai_pb2.SystemAgentConfigResponse(
                        provider_type=config.get("provider_type", "openai"),
                        model_name=config.get("model_name", "gpt-4o-mini"),
                        api_key="",  # Never return the actual API key
                        api_base=config.get("api_base", ""),
                        config_json=json.dumps(safe),
                        has_api_key=bool(config.get("api_key")),
                    )

                # Return defaults from config.yaml if no DB setting exists
                from src.main.utils.config.loader import get_resolved_config

                yaml_config = get_resolved_config()
                agents_config = yaml_config.get("llm", {}).get("agents", {})

                return settings_ai_pb2.SystemAgentConfigResponse(
                    provider_type=agents_config.get("default_provider", "openai"),
                    model_name=agents_config.get("default_model", "gpt-4o-mini"),
                    api_key="",
                    api_base="",
                    config_json=json.dumps(
                        {
                            "provider_type": agents_config.get("default_provider", "openai"),
                            "model_name": agents_config.get("default_model", "gpt-4o-mini"),
                            "model_overrides": agents_config.get("model_overrides", {}),
                        }
                    ),
                    has_api_key=False,
                )
        except Exception as e:
            logger.exception("Error in GetSystemAgentConfig: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, str(e))

    async def SetSystemAgentConfig(self, request, context):
        """Save the system agent LLM configuration to server_settings."""
        logger.info(
            "SettingsAIService.SetSystemAgentConfig called - provider=%s, model=%s",
            request.provider_type,
            request.model_name,
        )
        try:
            from src.main.models.sqlmodel_settings import ServerSetting

            with grpc_db_session() as db:
                setting = (
                    db.query(ServerSetting)
                    .filter(
                        ServerSetting.setting_key == "system_agent_config",
                    )
                    .first()
                )

                # Build config value
                config_value = {
                    "provider_type": request.provider_type,
                    "model_name": request.model_name,
                    "api_base": request.api_base or "",
                }

                # Parse optional extra config (model_overrides, synthesis, etc.)
                extra = {}
                if request.config_json:
                    try:
                        extra = json.loads(request.config_json)
                        if "model_overrides" in extra:
                            config_value["model_overrides"] = extra["model_overrides"]
                    except json.JSONDecodeError:
                        extra = {}

                # Two-model "Scrapalot AI": the optional `synthesis` sub-config is
                # the DeepSeek answer model (free-text RAG synthesis + reflection).
                # It rides inside config_json (no proto change). Preserve its API
                # key when the UI re-saves without re-sending it, and never wipe an
                # existing synthesis config on a save that omits it.
                existing_syn = (setting.setting_value.get("synthesis") if setting and setting.setting_value else None) or {}
                incoming_syn = extra.get("synthesis") if isinstance(extra, dict) else None
                if isinstance(incoming_syn, dict) and incoming_syn.get("model_name"):
                    syn = {
                        "provider_type": incoming_syn.get("provider_type") or "",
                        "model_name": incoming_syn.get("model_name") or "",
                        "api_base": incoming_syn.get("api_base") or "",
                    }
                    syn_key = incoming_syn.get("api_key") or existing_syn.get("api_key")
                    if syn_key:
                        syn["api_key"] = syn_key
                    config_value["synthesis"] = syn
                elif existing_syn:
                    config_value["synthesis"] = existing_syn

                # Handle API key: only update if provided (non-empty)
                if request.api_key:
                    config_value["api_key"] = request.api_key
                elif setting and setting.setting_value:
                    # Preserve existing API key if not provided in request
                    existing_key = setting.setting_value.get("api_key")
                    if existing_key:
                        config_value["api_key"] = existing_key

                if setting:
                    setting.setting_value = config_value
                else:
                    setting = ServerSetting(
                        setting_key="system_agent_config",
                        setting_value=config_value,
                    )
                    db.add(setting)

                db.commit()

                logger.info(
                    "System agent config saved: %s:%s",
                    request.provider_type,
                    request.model_name,
                )
                return common_pb2.StatusResponse(
                    success=True,
                    message="System agent config updated",
                )
        except Exception as e:
            logger.exception("Error in SetSystemAgentConfig: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def GetAdminDefaultSystemPrompt(self, request, context):
        """Read the effective default system prompt.

        This drives Settings → Prompts → Default System Prompt textarea.
        Resolution order:
          1. DB override — server_settings(setting_key='admin_default_system_prompt')
          2. File default — prompts.yaml → rag_agent.system_prompt
             (the prompt tool_based_rag_agent.create_rag_agent reads on
             every agentic chat). Surfacing it in the editor lets the
             admin see what's currently in effect and edit-then-save
             creates the DB override that wins on the next chat.

        `is_set=true` means the response body is the DB override.
        `is_set=false` means the editor is showing the YAML seed value.
        """
        logger.info("SettingsAIService.GetAdminDefaultSystemPrompt called")
        try:
            from src.main.models.sqlmodel_settings import ServerSetting
            from src.main.utils.config.loader import resolved_prompts

            with grpc_db_session() as db:
                # noinspection PyTypeChecker
                setting = db.query(ServerSetting).filter(ServerSetting.setting_key == "admin_default_system_prompt").first()

                if setting and isinstance(setting.setting_value, dict):
                    prompt = setting.setting_value.get("prompt")
                    if isinstance(prompt, str) and prompt.strip():
                        return settings_ai_pb2.AdminDefaultSystemPromptResponse(
                            prompt=prompt,
                            is_set=True,
                        )

                # Fall back to the file default so the editor is never
                # empty on a fresh install — admin can edit it in place.
                yaml_default = resolved_prompts.get("rag_agent", {}).get("system_prompt", "") or ""
                return settings_ai_pb2.AdminDefaultSystemPromptResponse(
                    prompt=yaml_default if isinstance(yaml_default, str) else "",
                    is_set=False,
                )
        except Exception as e:
            logger.exception("Error in GetAdminDefaultSystemPrompt: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, str(e))

    async def SetAdminDefaultSystemPrompt(self, request, context):
        """Save (or clear) the admin-managed global system prompt.

        Empty string deletes the row so GetAdminDefaultSystemPrompt
        falls back to the prompts.yaml seed (`rag_agent.system_prompt`).

        Both branches use raw SQL keyed by setting_key. The
        ServerSetting model's id column is declared as UUID by
        SQLModel's BaseModel but the underlying server_settings table
        stores it as VARCHAR — ORM-driven UPDATE/DELETE generate
        `WHERE id = '...'::UUID` which Postgres rejects without an
        explicit cast. Going via raw SQL on setting_key sidesteps the
        whole id round-trip.
        """
        import json

        from sqlalchemy import text as sa_text

        logger.info("SettingsAIService.SetAdminDefaultSystemPrompt called - len=%d", len(request.prompt or ""))
        try:
            with grpc_db_session() as db:
                value = (request.prompt or "").strip()

                if not value:
                    db.execute(
                        sa_text("DELETE FROM server_settings WHERE setting_key = :key"),
                        {"key": "admin_default_system_prompt"},
                    )
                    db.commit()
                    return common_pb2.StatusResponse(success=True, message="Admin default system prompt cleared")

                # Atomic upsert keyed on setting_key (which has a
                # unique index — see migrations).
                db.execute(
                    sa_text(
                        """
                        INSERT INTO server_settings (id, setting_key, setting_value, created_at, updated_at)
                        VALUES (gen_random_uuid()::text, :key, CAST(:value AS json), NOW(), NOW())
                        ON CONFLICT (setting_key) DO UPDATE
                          SET setting_value = EXCLUDED.setting_value,
                              updated_at = NOW()
                        """
                    ),
                    {
                        "key": "admin_default_system_prompt",
                        "value": json.dumps({"prompt": value}),
                    },
                )
                db.commit()
                return common_pb2.StatusResponse(success=True, message="Admin default system prompt updated")
        except Exception as e:
            logger.exception("Error in SetAdminDefaultSystemPrompt: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def GetSpeechConfig(self, request, context):
        """Get the speech services configuration (STT + TTS) from server_settings."""
        logger.info("SettingsAIService.GetSpeechConfig called")
        try:
            from src.main.models.sqlmodel_settings import ServerSetting

            with grpc_db_session() as db:
                # Check if system_agent_config has an OpenAI key (fallback for STT)
                agent_setting = (
                    db.query(ServerSetting)
                    .filter(
                        ServerSetting.setting_key == "system_agent_config",
                    )
                    .first()
                )
                has_agent_openai_key = bool(
                    agent_setting
                    and agent_setting.setting_value
                    and agent_setting.setting_value.get("provider_type") == "openai"
                    and agent_setting.setting_value.get("api_key")
                )

                setting = (
                    db.query(ServerSetting)
                    .filter(
                        ServerSetting.setting_key == "speech_config",
                    )
                    .first()
                )

                if setting and setting.setting_value:
                    config = setting.setting_value
                    # STT key available if speech_config has one OR system_agent_config has OpenAI key
                    has_stt_key = bool(config.get("stt_api_key")) or has_agent_openai_key
                    return settings_ai_pb2.SpeechConfigResponse(
                        stt_provider=config.get("stt_provider", "openai"),
                        stt_model=config.get("stt_model", "whisper-1"),
                        tts_provider=config.get("tts_provider", "edge"),
                        tts_default_voice=config.get("tts_default_voice", ""),
                        has_stt_api_key=has_stt_key,
                        has_elevenlabs_key=bool(config.get("elevenlabs_api_key")),
                        config_json=json.dumps({k: v for k, v in config.items() if k not in ("stt_api_key", "elevenlabs_api_key")}),
                    )

                # No speech_config in DB — return defaults
                from src.main.utils.config.loader import get_resolved_config

                yaml_config = get_resolved_config()
                stt_config = yaml_config.get("stt", {})
                tts_config = yaml_config.get("tts", {})

                has_stt_key = bool(stt_config.get("openai_api_key")) or has_agent_openai_key

                return settings_ai_pb2.SpeechConfigResponse(
                    stt_provider=stt_config.get("provider", "openai"),
                    stt_model=stt_config.get("openai_model", "whisper-1"),
                    tts_provider=tts_config.get("provider", "edge"),
                    tts_default_voice="",
                    has_stt_api_key=has_stt_key,
                    has_elevenlabs_key=bool(tts_config.get("elevenlabs_api_key")),
                    config_json="{}",
                )
        except Exception as e:
            logger.exception("Error in GetSpeechConfig: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, str(e))

    async def SetSpeechConfig(self, request, context):
        """Save the speech services configuration to server_settings."""
        logger.info(
            "SettingsAIService.SetSpeechConfig called - stt=%s, tts=%s",
            request.stt_provider,
            request.tts_provider,
        )
        try:
            from src.main.models.sqlmodel_settings import ServerSetting

            with grpc_db_session() as db:
                setting = (
                    db.query(ServerSetting)
                    .filter(
                        ServerSetting.setting_key == "speech_config",
                    )
                    .first()
                )

                config_value = {
                    "stt_provider": request.stt_provider or "openai",
                    "stt_model": request.stt_model or "whisper-1",
                    "tts_provider": request.tts_provider or "edge",
                    "tts_default_voice": request.tts_default_voice or "",
                }

                # Parse optional extra config
                if request.config_json:
                    try:
                        extra = json.loads(request.config_json)
                        config_value.update({k: v for k, v in extra.items() if k not in ("stt_api_key", "elevenlabs_api_key")})
                    except json.JSONDecodeError as e:
                        logger.debug("Ignoring malformed config_json: %s", e)

                # Handle API keys: only update if provided (non-empty)
                existing = setting.setting_value if setting and setting.setting_value else {}

                if request.stt_api_key:
                    config_value["stt_api_key"] = request.stt_api_key
                elif existing.get("stt_api_key"):
                    config_value["stt_api_key"] = existing["stt_api_key"]

                if request.elevenlabs_api_key:
                    config_value["elevenlabs_api_key"] = request.elevenlabs_api_key
                elif existing.get("elevenlabs_api_key"):
                    config_value["elevenlabs_api_key"] = existing["elevenlabs_api_key"]

                if setting:
                    setting.setting_value = config_value
                else:
                    setting = ServerSetting(
                        setting_key="speech_config",
                        setting_value=config_value,
                    )
                    db.add(setting)

                db.commit()

                logger.info(
                    "Speech config saved: stt=%s/%s, tts=%s",
                    request.stt_provider,
                    request.stt_model,
                    request.tts_provider,
                )
                return common_pb2.StatusResponse(
                    success=True,
                    message="Speech config updated",
                )
        except Exception as e:
            logger.exception("Error in SetSpeechConfig: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def GetServiceLogs(self, request, context):
        logger.info("SettingsAIService.GetServiceLogs called - lines=%d", request.lines)
        try:
            from datetime import datetime, timedelta
            import re as re_module

            from src.main.service.admin.docker_log_service import DockerLogService

            log_service = DockerLogService()
            tail_lines = request.lines or 100

            raw_logs = log_service.get_container_logs(tail_lines=tail_lines)

            if raw_logs is None:
                return settings_ai_pb2.ServiceLogsResponse(
                    logs_json=json.dumps(
                        {
                            "logs": "No logs available - log file not found",
                            "file_exists": False,
                            "lines_requested": tail_lines,
                            "lines_returned": 0,
                            "timestamp": datetime.now().isoformat(),
                        }
                    ),
                )

            logs_lines = raw_logs.strip().split("\n") if raw_logs.strip() else []
            total_lines_before_filter = len(logs_lines)

            # Apply level filter (match log level prefix like [ERROR  ] or [WARNING])
            level = request.level if request.level else None
            lines_filtered_by_level = 0
            if level and level.upper() != "ALL":
                level_pattern = re_module.compile(
                    r"\[" + str(re_module.escape(level.upper())) + r"\s*\]",
                )
                filtered = []
                for line in logs_lines:
                    if level_pattern.search(line.upper()):
                        filtered.append(line)
                    else:
                        lines_filtered_by_level += 1
                logs_lines = filtered

            # Apply time range filter (1h, 6h, 24h, 7d)
            time_range = request.time_range if request.time_range else None
            if time_range and time_range != "all":
                now = datetime.now()
                range_map = {
                    "1h": timedelta(hours=1),
                    "6h": timedelta(hours=6),
                    "24h": timedelta(hours=24),
                    "7d": timedelta(days=7),
                }
                delta = range_map.get(str(time_range))
                if delta:
                    cutoff = now - delta
                    time_filtered = []
                    for line in logs_lines:
                        match = re_module.match(r"(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})", line)
                        if match:
                            try:
                                log_time = datetime.strptime(match.group(1), "%Y-%m-%d %H:%M:%S")
                                if log_time >= cutoff:
                                    time_filtered.append(line)
                            except ValueError:
                                time_filtered.append(line)
                        else:
                            time_filtered.append(line)
                    logs_lines = time_filtered

            final_logs = "\n".join(logs_lines)

            result = {
                "logs": final_logs if final_logs else "No matching logs found",
                "file_exists": True,
                "lines_requested": tail_lines,
                "lines_returned": len(logs_lines),
                "total_lines_before_filter": total_lines_before_filter,
                "total_lines_processed": total_lines_before_filter,
                "lines_filtered_by_level": lines_filtered_by_level,
                "timestamp": datetime.now().isoformat(),
                "level_filter": level,
                "time_range_filter": time_range,
            }

            return settings_ai_pb2.ServiceLogsResponse(logs_json=json.dumps(result))
        except Exception as e:
            logger.exception("Error in GetServiceLogs: %s", str(e))
            return settings_ai_pb2.ServiceLogsResponse(
                logs_json=json.dumps(
                    {
                        "logs": "Error fetching logs: %s" % str(e),
                        "file_exists": False,
                        "lines_requested": request.lines or 100,
                        "lines_returned": 0,
                        "timestamp": None,
                    }
                ),
            )
