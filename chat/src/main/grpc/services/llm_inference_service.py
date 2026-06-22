"""
LlmInferenceService gRPC Implementation

Implements the LlmInferenceService defined in llm_inference.proto.
Wraps Python's LLM model management, GPU operations, and provider sync.
"""

from collections.abc import AsyncIterator
import json

from src.main.grpc import common_pb2, llm_inference_pb2, llm_inference_pb2_grpc
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def _get_llm_inference_service():
    """Lazy import to avoid circular dependencies."""
    from src.main.service.llm_inference import llm_inference_service

    return llm_inference_service


# noinspection PyUnresolvedReferences
class LlmInferenceServiceServicer(llm_inference_pb2_grpc.LlmInferenceServiceServicer):
    """LlmInferenceService gRPC implementation."""

    async def ListDatabaseModels(self, request, context):
        logger.info("LlmInference.ListDatabaseModels - provider_id=%s", request.provider_id)
        try:
            service = _get_llm_inference_service()
            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                result = await service.list_database_models(
                    db=db,
                    provider_id=request.provider_id or None,
                    page=request.page or 1,
                    limit=request.limit or 20,
                )
                return llm_inference_pb2.ListDatabaseModelsResponse(
                    models_json=json.dumps(result, default=str),
                )
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error in ListDatabaseModels: %s", str(e))
            return llm_inference_pb2.ListDatabaseModelsResponse(
                models_json=json.dumps({"models": [], "error": str(e)}),
            )

    async def ListProviderModels(self, request, context):
        logger.info("LlmInference.ListProviderModels - providers=%s", list(request.providers))
        try:
            service = _get_llm_inference_service()
            result = await service.list_provider_models(
                providers=list(request.providers) or None,
                model_type=request.model_type or None,
                search=request.search or None,
                page=request.page or 1,
                limit=request.limit or 50,
                refresh=request.refresh,
            )
            return llm_inference_pb2.GroupedProviderModelsResponse(
                response_json=json.dumps(result, default=str),
            )
        except Exception as e:
            logger.exception("Error in ListProviderModels: %s", str(e))
            return llm_inference_pb2.GroupedProviderModelsResponse(
                response_json=json.dumps({"error": str(e)}),
            )

    async def ListEmbeddingModels(self, request, context):
        logger.info("LlmInference.ListEmbeddingModels called")
        try:
            from src.main.config.database import SessionLocal
            from src.main.models.sqlmodel_providers import ModelProviderModel

            db = SessionLocal()
            try:
                # noinspection PyTypeChecker
                models = db.query(ModelProviderModel).filter(ModelProviderModel.model_type == "EMBEDDING").all()
                result = [
                    {
                        "id": str(m.id),
                        "model_name": m.model_name,
                        "display_name": m.display_name,
                        "provider_id": str(m.provider_id),
                        "dimensions": m.dimensions,
                    }
                    for m in models
                ]
                return llm_inference_pb2.EmbeddingModelsResponse(models_json=json.dumps(result))
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return llm_inference_pb2.EmbeddingModelsResponse(models_json="[]")

    async def GetFeaturedModels(self, request, context):
        # Optional filters from FeaturedModelsRequest (proto3 presence). The
        # old rpc took Empty, which silently dropped the frontend's search box
        # input — HuggingFace search never reached this service.
        search = request.search if request.HasField("search") else None
        min_params = request.min_parameters if request.HasField("min_parameters") else None
        max_params = request.max_parameters if request.HasField("max_parameters") else None
        logger.info("LlmInference.GetFeaturedModels called (search=%s, min=%s, max=%s)", search, min_params, max_params)
        try:
            service = _get_llm_inference_service()
            featured = await service.get_featured_models(search=search, min_parameters=min_params, max_parameters=max_params)
            return llm_inference_pb2.FeaturedModelsResponse(models_json=json.dumps(featured, default=str))
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return llm_inference_pb2.FeaturedModelsResponse(models_json="[]")

    async def GetInstalledModels(self, request, context):
        logger.info("LlmInference.GetInstalledModels called")
        try:
            service = _get_llm_inference_service()
            result = await service.get_installed_models()
            return llm_inference_pb2.InstalledModelsResponse(models_json=json.dumps(result, default=str))
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return llm_inference_pb2.InstalledModelsResponse(models_json="[]")

    async def GetStatus(self, request, context):
        logger.info("LlmInference.GetStatus called")
        try:
            service = _get_llm_inference_service()
            result = await service.get_service_status()
            return llm_inference_pb2.LlmStatusResponse(status_json=json.dumps(result, default=str))
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return llm_inference_pb2.LlmStatusResponse(status_json=json.dumps({"status": "error", "error": str(e)}))

    async def GetSystemCapabilities(self, request, context):
        logger.info("LlmInference.GetSystemCapabilities called")
        try:
            from src.main.utils.gpu.devices import get_system_capabilities

            caps = get_system_capabilities()
            return llm_inference_pb2.SystemCapabilitiesResponse(
                gpu_available=caps.get("gpu_available", False),
                cuda_version=caps.get("cuda_version", ""),
                capabilities_json=json.dumps(caps, default=str),
            )
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return llm_inference_pb2.SystemCapabilitiesResponse(gpu_available=False)

    async def GetDeploymentStatus(self, request, context):
        logger.info("LlmInference.GetDeploymentStatus called")
        try:
            service = _get_llm_inference_service()
            status = await service.get_service_status()
            installed = await service.get_installed_models()
            result = {**status, "deployed_models": len(installed) if isinstance(installed, list) else 0}
            return llm_inference_pb2.DeploymentStatusResponse(status_json=json.dumps(result, default=str))
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return llm_inference_pb2.DeploymentStatusResponse(status_json=json.dumps({"error": str(e)}))

    async def GetConfig(self, request, context):
        logger.info("LlmInference.GetConfig called")
        try:
            from src.main.config.database import SessionLocal
            from src.main.models.sqlmodel_settings import ServerSetting

            db = SessionLocal()
            try:
                settings = db.query(ServerSetting).filter(ServerSetting.setting_key.like("llm_%")).all()
                config = {s.setting_key: s.setting_value for s in settings}
                return llm_inference_pb2.LlmConfigResponse(config_json=json.dumps(config))
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return llm_inference_pb2.LlmConfigResponse(config_json="{}")

    async def SetConfig(self, request, context):
        logger.info("LlmInference.SetConfig called")
        try:
            from src.main.config.database import SessionLocal
            from src.main.models.sqlmodel_settings import ServerSetting

            config = json.loads(request.config_json)
            db = SessionLocal()
            try:
                for key, value in config.items():
                    # noinspection PyTypeChecker
                    setting = db.query(ServerSetting).filter(ServerSetting.setting_key == key).first()
                    if setting:
                        setting.setting_value = str(value)
                    else:
                        db.add(ServerSetting(setting_key=key, setting_value=str(value)))
                db.commit()
                return common_pb2.StatusResponse(success=True, message="Config updated")
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def StartService(self, request, context):
        logger.info("LlmInference.StartService called")
        return common_pb2.StatusResponse(success=True, message="Service already running")

    async def StopService(self, request, context):
        logger.info("LlmInference.StopService called")
        return common_pb2.StatusResponse(success=True, message="Stop not supported via gRPC")

    async def RestartService(self, request, context):
        logger.info("LlmInference.RestartService called")
        return common_pb2.StatusResponse(success=True, message="Restart not supported via gRPC")

    async def ReinitializeLocalModels(self, request, context):
        logger.info("LlmInference.ReinitializeLocalModels called")
        try:
            from src.main.service.local_models.model_service import initialize_local_ai_service

            initialize_local_ai_service()
            return common_pb2.StatusResponse(success=True, message="Local models reinitialized")
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def DownloadModel(self, request, context):
        logger.info("LlmInference.DownloadModel - model=%s", request.model_name)
        try:
            service = _get_llm_inference_service()
            result = await service.download_model(request.model_name, request.provider)
            return common_pb2.StatusResponse(success=True, message=json.dumps(result, default=str))
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def DeleteModel(self, request, context):
        logger.info("LlmInference.DeleteModel - model=%s", request.model_name)
        return common_pb2.StatusResponse(success=False, message="Local model deletion is not yet supported")

    async def UndeployModel(self, request, context):
        logger.info("LlmInference.UndeployModel - model=%s", request.model_name)
        return common_pb2.StatusResponse(success=False, message="Model undeployment is not yet supported")

    async def GetLocalModelStatus(self, request, context):
        logger.info("LlmInference.GetLocalModelStatus - model=%s", request.model_name)
        try:
            service = _get_llm_inference_service()
            installed = await service.get_installed_models()
            model_info = next((m for m in installed if m.get("name") == request.model_name or m.get("id") == request.model_name), None)
            if model_info:
                result = {"status": "installed", "model": model_info}
            else:
                result = {"status": "not_found", "model_name": request.model_name}
            return llm_inference_pb2.LocalModelStatusResponse(status_json=json.dumps(result, default=str))
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return llm_inference_pb2.LocalModelStatusResponse(status_json=json.dumps({"error": str(e)}))

    async def StartModelGpu(self, request, context):
        logger.info("LlmInference.StartModelGpu - model=%s", request.model_name)
        try:
            service = _get_llm_inference_service()
            config = json.loads(request.config_json) if request.config_json else {}
            result = await service.start_model_on_gpu(
                request.model_name,
                gpu_layers=config.get("gpu_layers"),
                model_path=config.get("model_path"),
            )
            return common_pb2.StatusResponse(success=True, message=json.dumps(result, default=str))
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def StopModelGpu(self, request, context):
        logger.info("LlmInference.StopModelGpu - model=%s", request.model_name)
        return common_pb2.StatusResponse(success=False, message="GPU model stopping is not yet supported")

    async def GetGpuStatus(self, request, context):
        logger.info("LlmInference.GetGpuStatus - model=%s", request.model_name)
        try:
            service = _get_llm_inference_service()
            result = await service.get_gpu_status(request.model_name)
            return llm_inference_pb2.GpuStatusResponse(status_json=json.dumps(result, default=str))
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return llm_inference_pb2.GpuStatusResponse(status_json=json.dumps({"error": str(e)}))

    async def GetOverallGpuStatus(self, request, context):
        logger.info("LlmInference.GetOverallGpuStatus called")
        try:
            from src.main.utils.gpu.devices import get_system_capabilities

            caps = get_system_capabilities()
            return llm_inference_pb2.GpuStatusResponse(status_json=json.dumps(caps, default=str))
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return llm_inference_pb2.GpuStatusResponse(status_json=json.dumps({"error": str(e)}))

    async def RefreshProviderModels(self, request, context):
        logger.info("LlmInference.RefreshProviderModels called")
        try:
            from src.main.config.database import SessionLocal
            from src.main.service.remote_model_sync import RemoteModelSyncService

            db = SessionLocal()
            try:
                sync_service = RemoteModelSyncService()
                await sync_service.sync_all_providers(db)
                return common_pb2.StatusResponse(success=True, message="Provider models refreshed")
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def FetchProviderModels(self, request, context):
        logger.info("LlmInference.FetchProviderModels called")
        try:
            from src.main.config.database import SessionLocal
            from src.main.service.remote_model_sync import RemoteModelSyncService

            db = SessionLocal()
            try:
                sync_service = RemoteModelSyncService()
                await sync_service.fetch_and_cache_models(db)
                return common_pb2.StatusResponse(success=True, message="Provider models fetched")
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def GetDownloadProgress(self, request, context) -> AsyncIterator:
        logger.info("LlmInference.GetDownloadProgress - model=%s", request.model_name)
        try:
            service = _get_llm_inference_service()
            async for progress in service.stream_download_progress(request.model_name):
                yield llm_inference_pb2.DownloadProgressChunk(
                    progress=progress.get("progress", 0),
                    speed=progress.get("speed", 0),
                    eta=progress.get("eta", ""),
                    status=progress.get("status", ""),
                    message=progress.get("message", ""),
                )
        except Exception as e:
            logger.exception("Error: %s", str(e))
            yield llm_inference_pb2.DownloadProgressChunk(status="error", message=str(e))
