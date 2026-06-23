# noinspection PyUnresolvedReferences
import asyncio
from collections.abc import AsyncGenerator
import contextlib
import json
import time
from typing import TYPE_CHECKING
from uuid import UUID

# Lazy import to avoid pydot startup delay
# from langchain_community.chat_message_histories import RedisChatMessageHistory
from langchain_core.documents import Document
from langchain_core.embeddings import Embeddings

if TYPE_CHECKING:
    from src.main.service.memory.conversation_memory import DatabaseOnlyMemory

from datetime import UTC

from src.main.constants.error_codes import ErrorCode
from src.main.constants.status_codes import StatusCode as StatusCodeEnum
from src.main.dto.chat import ChatRequest
from src.main.service.rag.citations.citation_prompt_template import CitationPromptTemplate
from src.main.service.retriever.retriever import Retriever
from src.main.utils.config.loader import get_model_config, resolved_config, resolved_prompts
from src.main.utils.core.logger import get_logger
from src.main.utils.llm.streaming import handle_streaming_with_type

logger = get_logger(__name__)

# Import LLM manager for centralized orchestration


def get_llm_manager():
    """Lazy import to avoid circular dependencies"""
    from src.main.app_instance import get_app

    app = get_app()
    return app.state.llm_manager


async def _standardize_model_and_get_history(
    request: ChatRequest,
) -> tuple[str, str, "DatabaseOnlyMemory | None"]:
    """
    Standardize model configuration and build conversation history.

    Uses DatabaseOnlyMemory backed by the conversation_history passed from Kotlin
    (Kotlin owns the messages table; Python owns conversation_summaries).

    Args:
        request: The chat request containing model, provider, session, and conversation_history

    Returns:
        Tuple of (model_name, provider_type, history)
    """
    # Initialize with safe defaults to ensure variables are always defined
    model_name = request.model_name or "unknown"
    provider_type = request.provider_type or "unknown"

    # Standardize model configuration if not already set
    if not model_name or not provider_type or model_name == "unknown" or provider_type == "unknown":
        try:
            from src.main.config.database import get_db

            db_session = next(get_db())
            try:
                model_config = await get_model_config(
                    provider=provider_type if provider_type != "unknown" else None,
                    model_name=model_name if model_name != "unknown" else None,
                    db=db_session,
                )
                if model_config:
                    model_name = model_config.get("model", model_name)
                    provider_type = model_config.get("provider", provider_type)
                    request.model_name = model_name
                    request.provider_type = provider_type
                    logger.info("Using standardized model configuration: %s", model_name)
            finally:
                db_session.close()
        except Exception as e:
            logger.exception("Error getting standardized model configuration: %s", str(e))
            model_name = getattr(request, "model", None) or "unknown"
            provider_type = getattr(request, "provider_type", None) or "unknown"

    history = build_conversation_memory(request)
    return model_name, provider_type, history


def build_conversation_memory(request: ChatRequest) -> "DatabaseOnlyMemory | None":
    """Build a DatabaseOnlyMemory from the conversation history Kotlin passed and
    kick off async summarization.

    Kotlin owns the messages table; Python owns conversation_summaries. This is
    the single source of conversation context — shared by the standard chat path
    (`process_chat_request_base`) and the agentic RAG path
    (`process_agentic_rag`) so both surface prior-conversation context and both
    benefit from the same summarization. Returns None when there is no session.
    """
    session_id = getattr(request, "session_id", None)
    if not session_id:
        return None
    try:
        from src.main.config.database import SessionLocal
        from src.main.service.memory.conversation_memory import DatabaseOnlyMemory

        db_for_memory = SessionLocal()
        history = DatabaseOnlyMemory(
            session_id=session_id,
            db_session=db_for_memory,
            conversation_history=getattr(request, "conversation_history", None) or [],
        )

        # On repeat: the summary in conversation_summaries may cover messages that Kotlin
        # has since deleted (user clicked "repeat" on an older message). Clear it so that
        # only the truncated history is used, and a fresh summary is built next time.
        # noinspection PyProtectedMember
        if getattr(request, "is_repeat", False) and history._cached_summary:
            import uuid as _uuid

            from sqlalchemy import text as sa_text

            from src.main.utils.auth.sessions import parse_composite_session_id

            try:
                actual_sid = parse_composite_session_id(session_id)
                session_uuid = _uuid.UUID(actual_sid)
                db_for_memory.execute(
                    sa_text("DELETE FROM conversation_summaries WHERE session_id = :sid"),
                    {"sid": session_uuid},
                )
                db_for_memory.commit()
                history._cached_summary = ""
                logger.info("Cleared stale summary for repeat request, session: %s", session_id)
            except Exception as repeat_err:
                logger.warning("Failed to clear stale summary on repeat: %s", str(repeat_err))

        # Trigger async LLM summarization for long conversations (fire-and-forget).
        # This runs in the background and does not block the streaming response.
        # noinspection PyProtectedMember
        history._maybe_summarize_conversation()
        return history

    except Exception as e:
        logger.exception("Error building conversation history: %s", str(e))
        return None


def _get_context_window_for_request(request: ChatRequest) -> int:
    """Get context window size for the model in the request from the database.

    Falls back to 128000 if not found.
    """
    default_context_window = 128000

    model_name = request.model_name
    provider_type = request.provider_type
    if not model_name or not provider_type:
        return default_context_window

    try:
        from src.main.config.database import SessionLocal

        db_session = SessionLocal()
        try:
            from sqlalchemy import text

            query = text("""
                SELECT m.context_window
                FROM model_provider_models m
                JOIN model_providers p ON p.id = m.provider_id
                WHERE LOWER(m.model_name) = LOWER(:model_name)
                AND LOWER(p.provider_type) = LOWER(:provider_type)
                AND p.status = 'active'
                AND m.context_window IS NOT NULL
                LIMIT 1
            """)
            result = db_session.execute(query, {"model_name": model_name, "provider_type": provider_type}).first()
            if result and result[0]:
                logger.debug("Found context_window=%d for %s:%s", result[0], provider_type, model_name)
                return result[0]
        finally:
            db_session.close()
    except Exception as e:
        logger.warning("Error looking up context_window: %s", str(e))

    return default_context_window


def _get_few_shot_messages(user_id: str) -> list:
    """
    Load the active prompt template's few-shot examples from user_settings.
    Returns a list of {"role": "user"/"assistant", "content": ...} dicts.
    """
    if not user_id:
        return []
    try:
        from src.main.config.database import SessionLocal
        from src.main.service.user_settings_service import UserSettingsService

        db = SessionLocal()
        try:
            svc = UserSettingsService(db)
            template = svc.get_setting(user_id, "active_prompt_template")
            if not template:
                return []
            examples = template.get("examples") if isinstance(template, dict) else None
            if not examples or not isinstance(examples, list):
                return []
            messages = []
            for ex in examples:
                inp = ex.get("input", "").strip()
                out = ex.get("output", "").strip()
                if inp and out:
                    messages.append({"role": "user", "content": inp})
                    messages.append({"role": "assistant", "content": out})
            return messages
        finally:
            db.close()
    except Exception as e:
        logger.warning("Failed to load few-shot examples for user %s: %s", user_id, e)
        return []


def _resolve_prompt_variables(content: str, user_id: str = None, workspace_id=None) -> str:
    """
    Replace dynamic variables in a prompt template with actual values.

    Supported variables:
    - {date}          → current UTC date (YYYY-MM-DD)
    - {time}          → current UTC time (HH:MM)
    - {datetime}      → YYYY-MM-DD HH:MM
    - {user.name}     → user's full name from Kotlin DB
    - {user.email}    → user's email from Kotlin DB
    - {workspace.name} → workspace name from collection_workspace_map
    """
    from datetime import datetime

    now = datetime.now(UTC)
    content = content.replace("{date}", now.strftime("%Y-%m-%d"))
    content = content.replace("{time}", now.strftime("%H:%M"))
    content = content.replace("{datetime}", now.strftime("%Y-%m-%d %H:%M"))

    if user_id and ("{user.name}" in content or "{user.email}" in content):
        try:
            from sqlalchemy import create_engine, text

            from src.main.utils.config.loader import resolved_config, resolved_secrets

            pg_host = resolved_config.get("database", {}).get("host", "pgvector")
            pg_port = resolved_config.get("database", {}).get("port", 5432)
            pg_pass = resolved_secrets.get("postgres_password", "")
            engine = create_engine(
                f"postgresql://scrapalot:{pg_pass}@{pg_host}:{pg_port}/scrapalot_backend",
                pool_size=1,
                max_overflow=0,
                connect_args={"connect_timeout": 3},
            )
            with engine.connect() as conn:
                # noinspection PyTypeChecker
                row = conn.execute(
                    text("SELECT first_name, last_name, email FROM scrapalot.users WHERE id = :uid LIMIT 1"),
                    {"uid": user_id},
                ).fetchone()
            engine.dispose()
            if row:
                full_name = f"{row[0] or ''} {row[1] or ''}".strip() or user_id
                content = content.replace("{user.name}", full_name)
                content = content.replace("{user.email}", row[2] or user_id)
            else:
                content = content.replace("{user.name}", user_id)
                content = content.replace("{user.email}", user_id)
        except Exception as e:
            logger.debug("Failed to resolve user variables: %s", str(e))
            content = content.replace("{user.name}", user_id or "")
            content = content.replace("{user.email}", user_id or "")

    if workspace_id and "{workspace.name}" in content:
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                row = db.execute(
                    text("SELECT workspace_name FROM collection_workspace_map WHERE workspace_id = :wid LIMIT 1"),
                    {"wid": str(workspace_id)},
                ).fetchone()
                content = content.replace("{workspace.name}", row[0] if row and row[0] else str(workspace_id))
            finally:
                db.close()
        except Exception as e:
            logger.debug("Failed to resolve workspace variable: %s", str(e))
            content = content.replace("{workspace.name}", str(workspace_id))

    return content


def _get_active_prompt_system_instruction(user_id: str, workspace_id=None) -> str:
    """
    Load the active prompt template's content as system instruction.
    Returns the template content with dynamic variables resolved, or empty string if none active.
    """
    if not user_id:
        return ""
    try:
        from src.main.config.database import SessionLocal
        from src.main.service.user_settings_service import UserSettingsService

        db = SessionLocal()
        try:
            svc = UserSettingsService(db)
            template = svc.get_setting(user_id, "active_prompt_template")
            if not template:
                return ""
            content = template.get("content", "").strip() if isinstance(template, dict) else ""
            if content:
                content = _resolve_prompt_variables(content, user_id=user_id, workspace_id=workspace_id)
            return content
        finally:
            db.close()
    except Exception as e:
        logger.warning("Failed to load active prompt template for user %s: %s", user_id, e)
        return ""


# noinspection SqlResolve


def get_model_type_from_db(request: ChatRequest) -> str:
    """
    Get the model type from the database.
    Models are now stored in the model_provider_models table, not in config.

    Args:
        request: The chat request containing model and provider information

    Returns:
        The model type ('NORMAL', etc.)
    """
    model_type = "NORMAL"  # Default fallback

    # Extract parameters directly from request
    provider_type_safe = request.provider_type or "local"
    model_safe = request.model_name

    # Check if model_safe is a UUID and resolve it to the actual model name
    if model_safe and len(model_safe) == 36 and model_safe.count("-") == 4:
        logger.debug(
            "Detected UUID model identifier: %s, resolving to actual model name",
            model_safe,
        )
        try:
            from src.main.config.database import SessionLocal

            db_session = SessionLocal()
            try:
                from sqlalchemy import text

                # First, try user-specific providers
                uuid_query = text("""
                    SELECT p.provider_type, m.model_name, m.model_type
                    FROM model_providers p
                    JOIN model_provider_models m ON p.id = m.provider_id
                    WHERE m.id = :model_id AND p.status = 'active'
                    LIMIT 1
                """)

                uuid_result = db_session.execute(uuid_query, {"model_id": model_safe}).first()

                if uuid_result:
                    resolved_provider_type = uuid_result[0]
                    resolved_model_name = uuid_result[1]
                    resolved_model_type = uuid_result[2]

                    logger.info(
                        "Resolved UUID %s to model: %s (provider: %s, type: %s)",
                        model_safe,
                        resolved_model_name,
                        resolved_provider_type,
                        resolved_model_type,
                    )

                    # Update the request with resolved values
                    request.model_name = resolved_model_name
                    request.provider_type = resolved_provider_type

                    # Update our safe variables
                    model_safe = resolved_model_name
                    provider_type_safe = resolved_provider_type

                    # Return the resolved model type directly
                    return resolved_model_type
                else:
                    logger.warning(
                        "UUID %s not found in database, using original values",
                        model_safe,
                    )
            finally:
                db_session.close()
        except Exception as e:
            logger.error("Error resolving UUID %s: %s", model_safe, str(e))

    # Check a database for model type
    if hasattr(request, "provider_type") and request.provider_type and hasattr(request, "model_name") and request.model_name:
        try:
            from src.main.config.database import SessionLocal

            db_session = None

            try:
                db_session = SessionLocal()
                from sqlalchemy import text

                # Find a provider by name or type (case-insensitive)
                provider_query = text("""
                    SELECT id FROM model_providers
                    WHERE (LOWER(name) = LOWER(:provider_name) OR LOWER(provider_type) = LOWER(:provider_name))
                    AND status = 'active'
                    LIMIT 1
                """)

                provider_result = db_session.execute(provider_query, {"provider_name": provider_type_safe}).first()

                if provider_result:
                    provider_id = provider_result[0]

                    # Get the model_type for this provider/model combo
                    # Query uses model_name OR display_name to match request.model
                    model_query = text("""
                        SELECT model_type FROM model_provider_models
                        WHERE provider_id = :provider_id
                        AND (model_name = :model_name OR display_name = :model_name)
                        LIMIT 1
                    """)

                    model_result = db_session.execute(
                        model_query,
                        {"provider_id": provider_id, "model_name": model_safe},
                    ).first()

                    if model_result and model_result[0]:
                        model_type = model_result[0]
                        logger.info(
                            "Found model_type='%s' in database for model '%s' (provider: %s)",
                            model_type,
                            model_safe,
                            provider_type_safe,
                        )
                    else:
                        logger.warning(
                            "Model '%s' not found in database for provider '%s', using default: %s",
                            model_safe,
                            provider_type_safe,
                            model_type,
                        )
                else:
                    logger.warning(
                        "Provider '%s' not found in database, using default model_type: %s",
                        provider_type_safe,
                        model_type,
                    )
            finally:
                if db_session:
                    # noinspection PyUnresolvedReferences
                    db_session.close()
        except Exception as e:
            logger.error(
                "Error checking database for model type: %s. Using default: %s",
                str(e),
                model_type,
            )
    else:
        safe_model_type = model_type if "model_type" in locals() else "unknown"
        logger.warning(
            "Missing provider_type or model in request, using default model_type: %s",
            safe_model_type,
        )

    return model_type


async def process_chat_request_base(
    request: ChatRequest,
    retrieved_documents: list = None,
    emitter=None,
    query_characteristics: dict | object | None = None,
) -> AsyncGenerator[str, None]:
    """
    Process a chat request with RAG context using packet streaming.
    Emits packets directly (no adapter needed).

    Args:
        request: ChatRequest containing the query and context
        retrieved_documents: Optional list of retrieved documents for RAG context
        emitter: Optional PacketEmitter to reuse for maintaining packet index sequence
        query_characteristics: when supplied (typically the
            QueryCharacteristics dict the strategy router produced), it is
            mapped to one of six prompt variants via
            ``prompt_variants.variant_prefix_for(qc)`` and the resolved prefix
            text is prepended to the synthesis system prompt. Default None
            preserves the prior behaviour (no category-conditioned prefix).

    Yields:
        Packet strings in the new format
    """
    from src.main.service.streaming.packet_emitter import PacketEmitter

    # Use provided emitter or create a new one (for backward compatibility)
    if emitter is None:
        emitter = PacketEmitter()
    query = request.prompt
    collection_ids = request.collection_ids  # Fixed: use collection_ids (plural) not collection_id

    # Emit message start packet
    yield emitter.emit_message_start(
        model_info={
            "model_name": request.model_name,
            "provider_type": getattr(request, "provider_type", "unknown"),
        }
    )

    # Standardize the model and get history
    model_name, provider_type, history = await _standardize_model_and_get_history(request)

    # Enhance chain input with citation-aware context formatting
    # Use get_context_for_llm() for efficient summary + recent exchange pattern
    # This avoids dumping ALL messages into the context window
    conversation_context = None
    recent_messages = []
    if history:
        try:
            # Get optimized context: summary + last exchange
            ctx = history.get_context_for_llm()
            conversation_context = ctx.get("summary", "") if ctx.get("has_summary") else None
            # Use last_exchange for recent messages (typically last 2-4)
            recent_messages = ctx.get("last_exchange", [])
            if not recent_messages:
                # Fallback: get last 4 messages from full_messages
                full_msgs = ctx.get("full_messages", [])
                recent_messages = full_msgs[-4:] if len(full_msgs) > 4 else full_msgs
            logger.debug(
                "Using conversation context: summary=%s, recent_count=%d",
                "yes" if conversation_context else "no",
                len(recent_messages),
            )
        except Exception as ctx_error:
            logger.warning("Error getting conversation context: %s", str(ctx_error))
            # Fallback to last 4 messages only (not all messages)
            if hasattr(history, "messages"):
                recent_messages = history.messages[-4:] if len(history.messages) > 4 else history.messages

    chain_input = {
        "question": query,
        "chat_history": recent_messages,  # Only recent messages, not all
        "conversation_summary": conversation_context,  # Summary of earlier conversation
        "collection_ids": collection_ids,
    }

    # If we have retrieved documents, format them with citations
    if retrieved_documents:
        context_window = _get_context_window_for_request(request)
        formatted_context = CitationPromptTemplate.format_context_with_citations(
            retrieved_documents,
            max_context_tokens=context_window,
        )
        chain_input["context"] = formatted_context
        logger.info(
            "Enhanced chain input with %d citation-formatted documents (context_window=%d)",
            len(retrieved_documents),
            context_window,
        )
    else:
        logger.warning("No retrieved documents provided to process_chat_request_base")

    logger.info(
        "Starting citation-aware chat stream for prompt: %s, collection_ids: %s, model: %s",
        query,
        collection_ids,
        model_name,
    )
    logger.debug("Chain input: %s", chain_input)

    try:
        # All models now use dynamic reasoning detection via <think> tags
        # No need for an explicit reasoning model flag

        # Format messages manually to avoid LangChain's synchronous prompt formatting flash
        try:
            from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

            llm_manager = get_llm_manager()
            # This is the deterministic RAG SYNTHESIS call — the user-facing
            # answer. For the system provider ("Scrapalot AI") it resolves to the
            # DeepSeek synthesis sub-config; for a user's own model agent_type is
            # ignored. The agentic path generates its answer via create_rag_agent
            # (gpt-4o-mini) and never reaches here.
            llm = await llm_manager.get_llm_from_request(
                request=request,
                user_id=request.user_id if hasattr(request, "user_id") else None,
                agent_type="rag_answer",
            )

            if not llm:
                raise RuntimeError(f"Failed to get LLM for model: {model_name}")

            logger.info("Using LLM directly for chat stream: %s", model_name)

            # Get the system message template from prompts.yaml and manually replace {context}
            system_template = resolved_prompts.get("rag_templates", {}).get("template_system", "")

            # Pick a category-conditioned prefix to prepend to the
            # system template. Routes to "default" (empty prefix) when the
            # dynamic-variants flag is off or no QueryCharacteristics arrived.
            # Community Edition removes dynamic prompt variants (prompt_variants);
            # always use the neutral "default" prefix (empty string).
            _variant_name = "default"
            _variant_prefix = ""

            # Build messages list manually (no LangChain prompt template to avoid flash)
            messages = []

            # Add a system message with context and conversation summary
            if system_template:
                # Replace {context} placeholder manually
                context_value = chain_input.get("context", "")
                system_content = system_template.replace("{context}", context_value)
                # Prepend the category-conditioned prefix (no-op
                # for the "default" variant or when the yaml key is missing).
                if _variant_prefix:
                    system_content = f"{_variant_prefix}\n\n{system_content}"

                # Add conversation summary to system message if available
                # This provides compressed history without dumping all messages
                conv_summary = chain_input.get("conversation_summary")
                if conv_summary:
                    system_content += f"\n\n### Previous Conversation Summary:\n{conv_summary}"

                # Inject language instruction if not English
                _lang = getattr(request, "language", "en") or "en"
                if _lang != "en":
                    _lang_names = {
                        "hr": "Croatian",
                        "de": "German",
                        "fr": "French",
                        "es": "Spanish",
                        "it": "Italian",
                        "pt": "Portuguese",
                        "ru": "Russian",
                        "ja": "Japanese",
                        "ko": "Korean",
                        "zh": "Chinese",
                        "ar": "Arabic",
                        "hi": "Hindi",
                    }
                    _lang_name = _lang_names.get(_lang, _lang)
                    system_content += (
                        "\n\n**LANGUAGE REQUIREMENT**: You MUST respond in %s. All explanations, analysis, and answers must be in %s regardless of the language of the source documents."
                        % (_lang_name, _lang_name)
                    )

                messages.append(SystemMessage(content=system_content))

            # Inject few-shot examples from the active prompt template (between system and history)
            _user_id = request.user_id if hasattr(request, "user_id") else None
            few_shot_msgs = _get_few_shot_messages(_user_id or "")
            if few_shot_msgs:
                for fs_msg in few_shot_msgs:
                    if fs_msg["role"] == "assistant":
                        messages.append(AIMessage(content=fs_msg["content"]))
                    else:
                        messages.append(HumanMessage(content=fs_msg["content"]))
                logger.debug("Injected %d few-shot messages for RAG request", len(few_shot_msgs))

            # Add recent chat history only (from get_context_for_llm, not ALL messages)
            # This is the key optimization: summary + last 2-4 messages instead of all history
            for msg in recent_messages:
                if hasattr(msg, "type"):
                    msg_type = getattr(msg, "type", "human")
                    content = getattr(msg, "content", "")
                elif isinstance(msg, dict):
                    msg_type = msg.get("type", "human")
                    content = msg.get("content", "")
                else:
                    msg_type = "human"
                    if hasattr(msg, "content"):
                        content = msg.content
                    else:
                        logger.warning(
                            "Message has no content attribute, skipping: %s",
                            type(msg),
                        )
                        continue

                # Skip corrupted messages
                if content and ("additional_kwargs={}" in content or "response_metadata={}" in content):
                    logger.warning("Skipping corrupted message in history: %s", content[:100])
                    continue

                # Add to the message list
                if msg_type == "ai":
                    messages.append(AIMessage(content=content))
                else:
                    messages.append(HumanMessage(content=content))

            # Add current user query
            messages.append(HumanMessage(content=query))

            # Emit RAG debug info for frontend trace UI
            system_content_local = ""
            if system_template:
                system_content_local = system_template.replace("{context}", chain_input.get("context", ""))
                conv_summary_local = chain_input.get("conversation_summary")
                if conv_summary_local:
                    system_content_local += f"\n\n### Previous Conversation Summary:\n{conv_summary_local}"
            yield emitter.emit_rag_debug_info(
                system_prompt_preview=system_content_local[:500] if system_content_local else "",
                system_prompt_length=len(system_content_local) if system_content_local else 0,
                context_document_count=len(retrieved_documents) if retrieved_documents else 0,
                context_token_estimate=len(str(chain_input.get("context", ""))) // 4,
                history_message_count=len(recent_messages),
                has_conversation_summary=bool(chain_input.get("conversation_summary")),
            )

            # Stream directly from LLM (no chain, no prompt template, no flash)
            chain_stream = llm.astream(messages)
        except Exception as llm_error:
            logger.error("Failed to get LLM for chat stream: %s", str(llm_error))
            yield emitter.emit_error(
                f"Failed to initialize LLM: {llm_error!s}",
                error_code=ErrorCode.SERVICE_UNAVAILABLE.value,
            )
            yield emitter.emit_stream_end(reason="error")
            return

        # Stream from LLM and process with handle_streaming_with_type
        try:
            # Create safe variables for use in conditions
            safe_provider_type = provider_type or "unknown"

            # Create a wrapper iterator to extract content from chunks
            async def extract_content():
                async for chunk in chain_stream:
                    try:
                        # All models now use dynamic reasoning detection
                        # Pass the raw chunk to stream_utils for proper reasoning token extraction

                        # Extract content based on the chunk structure for non-reasoning models
                        chunk_text = None

                        if isinstance(chunk, dict):
                            if "answer" in chunk:
                                answer = chunk["answer"]
                                if isinstance(answer, str):
                                    chunk_text = answer
                                elif hasattr(answer, "content"):
                                    chunk_text = answer.content
                                else:
                                    chunk_text = f"Unexpected answer type: {type(answer)}"
                            elif "error" in chunk:
                                yield type(
                                    "ChunkWithContent",
                                    (),
                                    {"content": f"Error: {chunk['error']}"},
                                )
                                continue
                        # Handle LangChain message objects (AIMessage, etc.)
                        elif hasattr(chunk, "content"):
                            chunk_text = chunk.content
                        else:
                            # Last resort: try to extract the content attribute or log the issue
                            logger.warning(
                                "Unexpected chunk type: %s, attributes: %s",
                                type(chunk),
                                dir(chunk),
                            )
                            chunk_text = getattr(chunk, "content", None)
                            if not chunk_text:
                                # Skip chunks with no content instead of stringifying the object
                                continue

                        if chunk_text:
                            # Create a simple object with a content attribute that won't stringify as [object Object]
                            class ChunkWithContent:
                                def __init__(self, text):
                                    self.content = text

                            yield ChunkWithContent(chunk_text)
                    except Exception as ex:
                        logger.error("Error extracting content from chunk: %s", str(ex))

                        class ChunkWithContent:
                            def __init__(self, text):
                                self.content = text

                        yield ChunkWithContent(f"Error: {ex!s}")

            # Stream packets directly from handle_streaming_with_type
            async for packet in handle_streaming_with_type(
                extract_content(),
                emitter=emitter,
                provider_type=safe_provider_type,
            ):
                yield packet

        except Exception as e:
            error_msg = f"Error in chat stream: {e!s}"
            logger.error(error_msg)
            yield emitter.emit_error(error_msg, error_code=ErrorCode.PROCESS_FAILED.value)
            yield emitter.emit_stream_end(reason="error")

    except Exception as e:
        error_msg = f"Error processing chat request: {e!s}"
        logger.error(error_msg)
        yield emitter.emit_error(error_msg, error_code=ErrorCode.PROCESS_FAILED.value)
        yield emitter.emit_stream_end(reason="error")


class _NoLibraryTools(Exception):
    """Signals the library-aware direct path can't run (no workspace / no
    accessible collections / setup failed) so the caller falls back to the plain
    tool-less LLM stream. Raised ONLY before any packet is yielded."""


async def _process_direct_llm_with_library_tools(
    request: ChatRequest,
    user_id: str,
    emitter,
    workspace_id: str,
) -> AsyncGenerator[str, None]:
    """Run the no-collection direct chat through a tool-enabled agent so the LLM
    can search the user's library on demand (e.g. "do you have anything from my
    books") instead of refusing like a tool-less model.

    Community Edition removes the tool-enabled RAG agent (create_rag_agent /
    RAGToolDependencies), so the library-aware path is unavailable. This always
    raises `_NoLibraryTools` before yielding anything, which makes the caller fall
    back to the plain tool-less LLM stream.
    """
    raise _NoLibraryTools()
    # Unreachable, but keeps this an async generator for the caller's
    # `async for` contract.
    yield ""  # pragma: no cover


_DIRECT_WEB_GATE_DEFAULT = (
    "You decide whether answering a user's question well REQUIRES current, "
    "real-time, or recent information from the web (today's date, current events, "
    "latest prices/versions/standings, who currently holds a role, anything that "
    "changes over time or post-dates training). Stable, historical, conceptual, "
    "definitional, or timeless questions do NOT need the web. Judge the meaning, "
    'not specific words. Answer with EXACTLY one word: "yes" or "no".'
)

_DIRECT_WEB_GROUNDING_DEFAULT = (
    "The user has no documents loaded, so live web results are provided below as "
    "CURRENT context. Ground any time-sensitive or factual claims in these web "
    "results and refer to them naturally; then enrich the answer with your own "
    "knowledge for background. If the web results do not cover something, say so "
    "rather than inventing specifics."
)


async def _direct_chat_needs_web(query: str) -> bool:
    """Semantic yes/no judgment: does this no-collection question need current /
    real-time web info? Decides whether the direct path supplements with a live
    web search. A semantic LLM judgment, never a keyword list. Best-effort —
    any failure returns False (answer from model knowledge only).
    """
    if not (query or "").strip():
        return False
    try:
        from openai import AsyncOpenAI

        from src.main.utils.config.loader import resolved_prompts
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        cfg = get_system_agent_model(agent_type="agentic_rag")
        api_key = getattr(cfg, "api_key", None)
        if not api_key:
            return False
        base_url = (getattr(cfg, "api_base", None) or "https://api.deepseek.com").rstrip("/")
        system = resolved_prompts.get("direct_web_search", {}).get("gate_system_prompt") or _DIRECT_WEB_GATE_DEFAULT
        client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        # The system model (deepseek-v4-flash) is a thinking model: it spends
        # tokens on reasoning_content before the visible answer, so a tiny
        # max_tokens cap leaves content empty and the gate always reads "no".
        # Budget enough for the short reasoning + the one-word verdict.
        resp = await client.chat.completions.create(
            model=cfg.model_name,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": query}],
            max_tokens=512,
            temperature=0,
        )
        answer = (resp.choices[0].message.content or "").strip().lower()
        return answer.startswith("y")
    except Exception as e:
        logger.warning("Direct web gate failed (defaulting to no web): %s", str(e))
        return False


async def _direct_web_supplement(query: str, emitter) -> tuple[list[str], str, bool]:
    """Fetch live web results for the no-collection path, building visible
    citation packets and a context block to ground the answer.

    Returns ``(citation_packets, context_block, used_web)``. The caller yields
    ``citation_packets`` (the frontend collects ``citation_info`` into a sources
    list) and injects ``context_block`` into the prompt. Best-effort — any
    failure returns empty so the chat degrades to plain model knowledge.
    """
    from src.main.service.rag.rag_strategy import _fetch_web_supplementary

    try:
        web_docs = await _fetch_web_supplementary(query)
    except Exception as e:
        logger.warning("Direct web supplement fetch failed: %s", str(e))
        return [], "", False
    if not web_docs:
        return [], "", False

    packets: list[str] = [emitter.emit_citation_start()]
    ctx_lines: list[str] = []
    for idx, doc in enumerate(web_docs, start=1):
        md = doc.metadata or {}
        title = md.get("title") or md.get("source") or "Web result"
        url = md.get("url") or ""
        packets.append(
            emitter.emit_citation_info(
                citation_num=idx,
                document_id=md.get("document_id", f"web_{idx}"),
                document_title=title,
                url=url or None,
                text=doc.page_content[:800],
                score=md.get("score"),
            )
        )
        ctx_lines.append(f"[{idx}] {title} ({url}): {doc.page_content}")
    logger.info("Direct chat: supplemented no-collection answer with %d web result(s)", len(ctx_lines))
    return packets, "\n\n".join(ctx_lines), True


async def process_direct_llm_chat(request: ChatRequest, user_id: str, emitter=None) -> AsyncGenerator[str, None]:
    """
    Process a direct LLM chat request without RAG or web search.
    Emits packets directly (no adapter needed).

    Args:
        request: The chat request
        user_id: The user ID
        emitter: Optional PacketEmitter to reuse for maintaining packet index sequence

    Yields:
        Packet-format JSON strings (indexed packets with type-safe structure)
    """
    from src.main.service.streaming.packet_emitter import PacketEmitter
    from src.main.utils.llm.streaming import handle_streaming_with_type

    _llm_start_time = time.monotonic()

    # Use provided emitter or create a new one (for backward compatibility)
    if emitter is None:
        emitter = PacketEmitter()
    query = request.prompt

    # Augment prompt with attachment context (documents, YouTube transcripts)
    if getattr(request, "attachments", None):
        from src.main.service.chat.attachment_processor import augment_prompt_with_attachments

        query = augment_prompt_with_attachments(query, request.attachments)

    logger.debug("Starting process_direct_llm_chat with model=%s", request.model_name)

    # Emit message start
    yield emitter.emit_message_start(
        model_info={
            "model_name": request.model_name,
            "provider_type": getattr(request, "provider_type", "unknown"),
        }
    )

    try:
        # Standardize the model and get history
        model_name, provider_type, history = await _standardize_model_and_get_history(request)
        logger.debug("After standardization: model=%s", model_name)

        # Create safe variables for use in conditions
        safe_provider_type = provider_type or "unknown"
    except Exception as e:
        logger.exception("Error standardizing model configuration for %s: %s", request.model_name, str(e))
        yield emitter.emit_error(
            f"Error standardizing model configuration: {e!s}",
            error_code=ErrorCode.INVALID_CONFIGURATION.value,
        )
        yield emitter.emit_stream_end(reason="error")
        return

    # noinspection PyUnusedLocal
    metrics_callback = None  # initialized before try so it's accessible in the finally-style cleanup below
    try:
        # Get LLM instance using centralized orchestration
        llm_manager = get_llm_manager()
        llm = await llm_manager.get_llm_from_request(request=request, user_id=user_id)

        if not llm:
            logger.error("Failed to get LLM for model %s", request.model_name)
            yield emitter.emit_error(
                f"Failed to initialize LLM: {request.model_name}",
                error_code=ErrorCode.SERVICE_UNAVAILABLE.value,
            )
            yield emitter.emit_stream_end(reason="error")
            return

        # Attach per-request token metrics callback for stream_end packet
        from src.main.service.llm.token_metrics import TokenMetricsTracker
        from src.main.service.llm.token_metrics_callback import TokenMetricsCallback

        metrics_callback = TokenMetricsCallback(
            metrics_tracker=TokenMetricsTracker(),
            db=None,  # type: ignore[arg-type]
            provider=getattr(request, "provider_type", "unknown") or "unknown",
            model=getattr(request, "model_name", "unknown") or "unknown",
            user_id=user_id,
        )
        if not hasattr(llm, "callbacks") or llm.callbacks is None:
            llm.callbacks = []
        llm.callbacks.append(metrics_callback)

    except Exception as llm_error:
        logger.error("Error getting LLM for model %s: %s", request.model_name, str(llm_error))
        yield emitter.emit_error(
            f"Failed to initialize LLM: {llm_error!s}",
            error_code=ErrorCode.SERVICE_UNAVAILABLE.value,
        )
        yield emitter.emit_stream_end(reason="error")
        return

    # All models now use dynamic reasoning detection via <think> tags
    # No need for an explicit reasoning model flag or model type check

    # Library-aware path: when the chat carries a workspace, give the LLM
    # library-search tools so "do you have anything from my books" actually
    # searches the user's collections instead of refusing like a tool-less LLM.
    # The agent decides semantically whether to search; falls back to the plain
    # stream below when there's nothing to search. (thought_partner mode never
    # carries a workspace_id, so it stays context-light.)
    _lib_workspace_id = getattr(request, "workspace_id", None)
    if _lib_workspace_id:
        produced_any = False
        try:
            async for _pkt in _process_direct_llm_with_library_tools(request, user_id, emitter, workspace_id=str(_lib_workspace_id)):
                produced_any = True
                yield _pkt
            return
        except _NoLibraryTools:
            pass  # nothing to search → fall through to the plain LLM stream
        except Exception as lib_err:
            logger.warning("Library-aware direct path failed: %s", str(lib_err))
            if produced_any:
                # Already streamed partial output — end the turn rather than
                # double-emitting via the plain path.
                yield emitter.emit_stream_end(reason="error")
                return

    try:
        # Prepare messages for the LLM
        messages = []

        # Always tell the model today's date so it can reason about recency
        # (it otherwise only knows its training cutoff). Cheap, and the basis
        # for the "is this question time-sensitive?" web gate below.
        from datetime import UTC, datetime

        messages.append({"role": "system", "content": f"Today's date is {datetime.now(UTC):%Y-%m-%d} (UTC)."})

        # Inject active prompt template as system instruction (if set by user)
        _workspace_id = getattr(request, "workspace_id", None)
        active_instruction = _get_active_prompt_system_instruction(user_id, workspace_id=_workspace_id)
        if active_instruction:
            # Inject language instruction if not English
            _lang = getattr(request, "language", "en") or "en"
            if _lang != "en":
                _lang_names = {
                    "hr": "Croatian",
                    "de": "German",
                    "fr": "French",
                    "es": "Spanish",
                    "it": "Italian",
                    "pt": "Portuguese",
                    "ru": "Russian",
                    "ja": "Japanese",
                    "ko": "Korean",
                    "zh": "Chinese",
                    "ar": "Arabic",
                    "hi": "Hindi",
                }
                _lang_name = _lang_names.get(_lang, _lang)
                active_instruction += (
                    "\n\n**LANGUAGE REQUIREMENT**: You MUST respond in %s. All explanations, analysis, and answers must be in %s regardless of the language of the source documents."
                    % (_lang_name, _lang_name)
                )
            messages.append({"role": "system", "content": active_instruction})

        # Inject few-shot examples from the active prompt template
        few_shot_msgs = _get_few_shot_messages(user_id)
        if few_shot_msgs:
            messages.extend(few_shot_msgs)
            logger.debug("Injected %d few-shot messages for user %s", len(few_shot_msgs), user_id)

        # Add history messages (if history exists)
        if history and hasattr(history, "messages"):
            for msg in history.messages:
                # Handle both dictionary and LangChain message objects
                if hasattr(msg, "type"):
                    # LangChain message object
                    msg_type = getattr(msg, "type", "human")
                    content = getattr(msg, "content", "")
                elif isinstance(msg, dict):
                    # Dictionary format
                    msg_type = msg.get("type", "human")
                    content = msg.get("content", "")
                else:
                    # Extract content from LangChain message objects
                    msg_type = "human"
                    if hasattr(msg, "content"):
                        content = msg.content
                    else:
                        logger.warning("Message has no content attribute, skipping: %s", type(msg))
                        continue

                # Skip messages with corrupted content (raw AIMessage representations)
                if content and ("additional_kwargs={}" in content or "response_metadata={}" in content):
                    logger.warning("Skipping corrupted message in history: %s", content[:100])
                    continue

                role = "assistant" if msg_type == "ai" else "user"
                messages.append({"role": role, "content": content})

        # No-collection web supplement: this plain path is reached only when
        # there are no books to search. When the question semantically needs
        # current/real-time info, supplement with a live web search so the
        # answer mixes web facts + the model's own knowledge. Gated on a
        # workspace context (thought-partner mode carries no workspace_id and
        # must stay a pure questioning turn). The emitted web citations make
        # GenerateDirectLLM's reflection wrapper append a visible model insight.
        if _workspace_id and await _direct_chat_needs_web(query):
            _web_packets, _web_ctx, _used_web = await _direct_web_supplement(query, emitter)
            for _wp in _web_packets:
                yield _wp
            if _web_ctx:
                from src.main.utils.config.loader import resolved_prompts

                _grounding = resolved_prompts.get("direct_web_search", {}).get("grounding_instruction") or _DIRECT_WEB_GROUNDING_DEFAULT
                messages.append({"role": "system", "content": f"{_grounding}\n\nWeb results:\n{_web_ctx}"})

        # Add current query
        messages.append({"role": "user", "content": query})

        # Use safe variables to avoid NameError
        safe_model_name = getattr(request, "model_name", None) or "unknown"
        logger.info("Sending direct chat request to LLM: %s", safe_model_name)
        logger.debug("Messages: %s", messages)

        # Emit status: generating
        yield emitter.emit_status(StatusCodeEnum.GENERATING_RESPONSE.value, stage="generation")

        # Emit RAG debug info for frontend trace UI (direct LLM, no RAG context)
        yield emitter.emit_rag_debug_info(
            history_message_count=len(messages) - 1,  # Exclude current query
        )

        # Stream response from LLM
        try:
            stream = llm.astream(input=messages)

            # Stream packets directly from handle_streaming_with_type
            async for packet in handle_streaming_with_type(
                stream,
                emitter=emitter,
                provider_type=safe_provider_type,
            ):
                yield packet

        except Exception as e:
            error_msg = f"Error in direct LLM chat stream: {e!s}"
            logger.error(error_msg)
            yield emitter.emit_error(error_msg, error_code=ErrorCode.PROCESS_FAILED.value)

    except Exception as e:
        error_msg = f"Error processing direct LLM chat request: {e!s}"
        # Use safe variables with fallbacks to avoid NameError
        safe_model_name = getattr(request, "model", None) or "unknown"
        logger.error(
            "Error processing direct LLM chat request for model %s: %s",
            safe_model_name,
            str(e),
        )
        yield emitter.emit_error(error_msg, error_code=ErrorCode.PROCESS_FAILED.value)
    finally:
        # Always emit the stream end with token metrics
        _duration_ms = int((time.monotonic() - _llm_start_time) * 1000)
        token_metrics = {}
        if metrics_callback and metrics_callback.last_metrics:
            m = metrics_callback.last_metrics
            # noinspection PyUnresolvedReferences
            token_metrics = {
                "input_tokens": m.input_tokens,
                "output_tokens": m.output_tokens,
                "total_tokens": m.total_tokens,
                "tokens_per_second": m.tokens_per_second,
                "cost_usd": m.cost_usd,
                "latency_ms": m.latency_ms,
                "provider": m.provider,
                "model": m.model,
            }
        # Remove per-request callback from cached LLM to prevent accumulation
        if metrics_callback and llm and hasattr(llm, "callbacks") and llm.callbacks:
            try:
                llm.callbacks.remove(metrics_callback)
            except ValueError:
                # Callback already absent from the cached LLM; nothing to clean up.
                pass
        yield emitter.emit_stream_end(reason="completed", duration_ms=_duration_ms, **token_metrics)


async def store_qa_pair(vectorstore, question: str, answer: str, collection_id: UUID | None = None):
    try:
        metadata = {"type": "generated_qa", "collection_id": collection_id}
        document = Document(page_content=f"Q: {question}\nA: {answer}", metadata=metadata)
        await vectorstore.add_documents([document])
        logger.info("Stored Q&A pair in vector database for collection: %s", collection_id)
    except Exception as e:
        logger.error("Error storing Q&A pair in vector database: %s", str(e))


async def rerank_documents(query: str, documents: list[Document], retriever: Retriever) -> list[Document]:
    """
    Rerank documents based on their similarity to the query.

    Args:
        query: The user queries
        documents: List of documents to rerank
        retriever: The retriever instance with embedding functionality

    Returns:
        Reranked list of documents
    """
    if not documents:
        return []

    try:
        # Get embeddings for the query and documents
        query_embedding = await retriever.get_embeddings([query])

        # Calculate similarity scores in parallel
        scored_docs = await asyncio.gather(*[_calculate_similarity(doc, query_embedding, retriever.embeddings_model) for doc in documents])

        # Sort by score (descending)
        scored_docs.sort(key=lambda x: x[1], reverse=True)

        # Store scores in document metadata and extract the sorted documents
        reranked_docs = []
        for doc, score in scored_docs:
            # Store the similarity score in metadata for citation display
            doc.metadata["score"] = float(score)
            reranked_docs.append(doc)

        return reranked_docs
    except Exception as e:
        logger.warning("Error during document reranking: %s. Returning original order.", str(e))
        return documents


async def combine_and_rerank_documents(query: str, *doc_lists: list[Document], retriever: Retriever) -> list[Document]:
    """
    Combine multiple document lists, deduplicate by page_content, and rerank based on the query.

    This is a common pattern used across various RAG orchestration strategies:
    1. Combine documents from different sources / techniques
    2. Deduplicate by using page_content as a key
    3. Rerank documents based on the original query
    4. Limit results to the configured maximum

    Args:
        query: The original user query
        *doc_lists: Multiple lists of documents to combine
        retriever: The retriever instance for reranking

    Returns:
        List of combined, deduplicated, and reranked documents limited to max_results
    """
    # Step 1: Combine and deduplicate documents
    combined_docs = {}
    for doc_list in doc_lists:
        for doc in doc_list:
            # Use page_content as a key to deduplicate
            combined_docs[doc.page_content] = doc

    # Step 2: Rerank documents based on the original query
    if combined_docs:
        reranked_docs = await rerank_documents(query, list(combined_docs.values()), retriever)
        max_results = resolved_config.get("rag", {}).get("max_results", 10)
        return reranked_docs[:max_results]

    return []


async def _calculate_similarity(document: Document, query_embedding: list[float], embeddings: Embeddings) -> tuple[Document, float]:
    """Calculate cosine similarity between document and query embedding."""
    try:
        # If a document already has an embedding, use it
        if hasattr(document, "embedding") and document.embedding:
            doc_embedding = document.embedding
        else:
            # Otherwise, generate embedding for document
            doc_embedding = await asyncio.to_thread(embeddings.embed_documents, [document.page_content])
            doc_embedding = doc_embedding[0] if doc_embedding else []

        # Calculate cosine similarity
        if doc_embedding and query_embedding:
            similarity = _cosine_similarity(query_embedding, doc_embedding)
        else:
            similarity = 0.0

        return document, similarity
    except Exception as e:
        logger.warning("Error calculating similarity: %s", str(e))
        return document, 0.0


def _cosine_similarity(vec1: list[float], vec2: list[float]) -> float:
    """Calculate cosine similarity between two vectors."""
    if not vec1 or not vec2 or len(vec1) != len(vec2):
        return 0.0

    dot_product = sum(a * b for a, b in zip(vec1, vec2, strict=False))
    magnitude1 = sum(a * a for a in vec1) ** 0.5
    magnitude2 = sum(b * b for b in vec2) ** 0.5

    if magnitude1 * magnitude2 == 0:
        return 0.0

    return dot_product / (magnitude1 * magnitude2)


def select_best_documents(docs_list: list[list[Document]], weights: list[float] = None) -> list[Document]:
    """
    Select the best documents from multiple lists, with optional weighting.

    Args:
        docs_list: List of document lists from different retrievers
        weights: Optional weights for each retriever's results

    Returns:
        Combined and deduplicated list of documents
    """
    if not docs_list:
        return []

    # Default equal weights if not provided
    if weights is None:
        weights = [1.0] * len(docs_list)

    # Normalize weights
    total_weight = sum(weights)
    if total_weight == 0:
        weights = [1.0] * len(docs_list)
        total_weight = sum(weights)

    normalized_weights = [w / total_weight for w in weights]

    # Calculate document scores
    doc_scores = {}
    for i, docs in enumerate(docs_list):
        for j, doc in enumerate(docs):
            # Score based on position and weight
            # Earlier positions get higher scores
            position_score = 1.0 / (j + 1)
            weighted_score = position_score * normalized_weights[i]

            # Use content hash as a key for deduplication
            content_hash = hash(doc.page_content)
            if content_hash in doc_scores:
                doc_scores[content_hash] = (
                    doc,
                    doc_scores[content_hash][1] + weighted_score,
                )
            else:
                doc_scores[content_hash] = (doc, weighted_score)

    # Sort by score
    sorted_docs = sorted(doc_scores.values(), key=lambda x: x[1], reverse=True)

    # Extract the sorted documents
    max_results = resolved_config.get("rag", {}).get("max_results", 10)
    return [doc for doc, _ in sorted_docs][:max_results]


async def fact_check(llm, answer: str, context: list[Document]) -> str:
    # Extract context text from documents
    context_text = "\n\n".join([doc.page_content for doc in context])

    # Get fact-checking prompt from configuration
    fact_check_prompt = None
    prompts = resolved_config.get("defaults", {}).get("prompts", [])
    for prompt_config in prompts:
        if prompt_config.get("name") == "Fact Checker":
            fact_check_prompt = prompt_config.get("content")
            break

    # Fallback to default prompt if not found in config
    if not fact_check_prompt:
        fact_check_prompt = (
            "Given the following answer and context, verify if the answer is supported by the context. "
            "If not, provide a corrected answer based only on the given context.\n\n"
            "Answer: {answer}\n\nContext: {context_text}\n\nVerified answer:"
        )

    # Format the prompt with actual values
    formatted_prompt = fact_check_prompt.format(answer=answer, context_text=context_text)
    response = await llm.apredict(formatted_prompt)
    return response.strip()


def reciprocal_rank_fusion(all_results: list[list[Document]], k: int = 60) -> list[Document]:
    fused_scores = {}
    doc_map = {}  # Map document content to Document object

    for docs in all_results:
        for rank, doc in enumerate(docs):
            doc_str = doc.page_content
            if doc_str not in fused_scores:
                fused_scores[doc_str] = 0
                doc_map[doc_str] = doc  # Store the Document object
            fused_scores[doc_str] += 1 / (rank + k)

    # Return Document objects sorted by their fusion scores
    return [doc_map[doc_str] for doc_str, _ in sorted(fused_scores.items(), key=lambda x: x[1], reverse=True)]


async def process_chat_request_with_fact_check(request: ChatRequest, strategy, emitter=None) -> AsyncGenerator[str, None]:
    """
    Process chat request with RAG and optional fact checking.

    This function:
    1. Retrieves context for the query
    2. Streams response from the LLM based on that context
    3. Optionally checks facts against retrieved sources

    Args:
        request: The chat request with prompt and other parameters
        strategy: The RAG strategy to use for execution
        emitter: Optional PacketEmitter to reuse for maintaining packet index sequence

    Yields:
        JSON - formatted response chunks for streaming
    """
    from src.main.service.streaming.packet_emitter import PacketEmitter

    rag_start_time = time.monotonic()

    # Use provided emitter or create a new one (for backward compatibility)
    if emitter is None:
        emitter = PacketEmitter()

    # If no collections selected, bypass RAG and go directly to the LLM
    if not request.collection_ids or len(request.collection_ids) == 0:
        logger.info("No collections selected, using direct LLM chat for: %s", request.prompt)
        async for chunk in process_direct_llm_chat(
            request,
            strategy.user_id if hasattr(strategy, "user_id") else "unknown",
            emitter,
        ):
            yield chunk
        return

    query = request.prompt
    collection_ids = request.collection_ids
    document_ids = request.document_ids

    # Attach per-request token metrics callback for stream_end packet
    rag_metrics_callback = None
    if hasattr(strategy, "llm") and strategy.llm:
        from src.main.service.llm.token_metrics import TokenMetricsTracker
        from src.main.service.llm.token_metrics_callback import TokenMetricsCallback

        rag_metrics_callback = TokenMetricsCallback(
            metrics_tracker=TokenMetricsTracker(),
            db=None,  # type: ignore[arg-type]
            provider=getattr(request, "provider_type", "unknown") or "unknown",
            model=getattr(request, "model_name", "unknown") or "unknown",
            user_id=strategy.user_id if hasattr(strategy, "user_id") else None,
        )
        if not hasattr(strategy.llm, "callbacks") or strategy.llm.callbacks is None:
            strategy.llm.callbacks = []
        strategy.llm.callbacks.append(rag_metrics_callback)

    logger.info(
        "Processing chat request with fact checking for: prompt='%s' session_id='%s' collection_ids=%s document_ids=%s model='%s' language='%s'",
        query,
        request.session_id,
        collection_ids,
        document_ids,
        request.model_name,
        request.language,
    )

    # Get context first for use in fact checking later
    # Only execute if documents haven't been retrieved yet (avoid duplicate execution)
    if not hasattr(strategy, "retrieved_documents") or not strategy.retrieved_documents:
        # execute() is a generator - iterate and yield packets
        execute_gen = strategy.execute(query, collection_ids, document_ids)
        async for packet_str in execute_gen:
            yield packet_str
        # Documents are now stored in strategy.retrieved_documents
        context = strategy.retrieved_documents
    else:
        # Documents already retrieved by a previous execute() call
        logger.debug("Documents already retrieved, skipping duplicate execute() call")
        context = strategy.retrieved_documents

    # Display warning if no context found
    if not context:
        logger.warning("No context found for query: %s", query)
        yield emitter.emit_error(
            "No relevant context found. The answer will be based on general knowledge.",
            error_code="NO_CONTEXT_FOUND",
        )

    # Accumulate the full response while yielding chunks
    full_response = ""

    # Initialize the citation processor if we have context
    citation_processor = None
    if context:
        from src.main.service.streaming.citation_processor import StreamingCitationProcessor

        citation_processor = StreamingCitationProcessor(
            context_docs=context,
            max_citation_num=len(context),
            user_query=getattr(request, "prompt", None),
        )
        # Emit citation start packet
        yield emitter.emit_citation_start()
        logger.debug("Initialized citation processor with %d documents", len(context))

    # Process chunks using a separate generator to collect the response
    async def collect_response_and_forward():
        nonlocal full_response
        # Call parent process_chat_request_base with retrieved context documents
        async for c in process_chat_request_base(request, retrieved_documents=context):
            # Extract token content from chunks
            with contextlib.suppress(json.JSONDecodeError, TypeError):
                if isinstance(c, str):
                    with contextlib.suppress(json.JSONDecodeError, TypeError):
                        chunk_data = json.loads(c)
                        if "token" in chunk_data:
                            full_response += chunk_data["token"]
                elif isinstance(c, dict) and "token" in c:
                    full_response += c["token"]

            # Process citations if we have a citation processor
            should_skip_forward = False
            if citation_processor and isinstance(c, str):
                try:
                    chunk_data = json.loads(c)
                    # The type is inside the "obj" field in the packet structure
                    packet_obj = chunk_data.get("obj", {})
                    chunk_type = packet_obj.get("type")

                    if chunk_type == "message_delta" and "content" in packet_obj:
                        token = packet_obj["content"]
                        display_text, citations = citation_processor.process_token(token)

                        # Always skip forwarding original token when citation processor is active
                        # The processor handles buffering and will emit text when ready
                        should_skip_forward = True

                        # Emit citations first
                        if citations:
                            logger.info("🎯 Emitting %s citations", len(citations))
                            for citation in citations:
                                yield emitter.emit(citation)

                            # Always emit display text when citations found (it has [[1]] format)
                            if display_text:
                                logger.debug("Emitting citation display text: %s...", display_text[:50])
                                yield emitter.emit_message_delta(display_text)
                        elif display_text:
                            # Emit buffered text (non-citation content released from buffer)
                            if display_text != token:
                                logger.debug(
                                    "Emitting buffered text (no citations): %s", display_text[:50] if len(display_text) > 50 else display_text
                                )
                            yield emitter.emit_message_delta(display_text)
                        # If display_text is empty, the token is buffered - don't emit anything
                except (json.JSONDecodeError, TypeError) as json_err:
                    logger.debug("Error processing chunk for citations: %s", json_err)

            # Forward the chunk (unless we already emitted a modified version)
            if not should_skip_forward:
                yield c if isinstance(c, str) else json.dumps(c) + "\n"

    # Process the request using the collect_response_and_forward generator
    async for chunk in collect_response_and_forward():
        yield chunk

    # Smart Citations (Scite): re-emit citations with stance classification.
    if citation_processor:
        try:
            updated_citations = await citation_processor.classify_stance_batch()
            for citation in updated_citations:
                yield emitter.emit(citation)
        except Exception as stance_err:
            logger.warning("Stance classification skipped: %s", stance_err)

    # Store the Q&A pair (this is handled by the parent process_chat_request)
    # We don't need to duplicate this code

    # Perform fact checking only when RAG is explicitly used (collections selected) and context was found
    # Skip fact-checking for regular chat without documents
    try:
        if request.collection_ids and len(request.collection_ids) > 0 and context and full_response:
            fact_checked_response = await fact_check(strategy.llm, full_response, context)
            logger.info("Fact - checked response: %s", fact_checked_response)
            yield emitter.emit_custom("fact_check", fact_checked_response)
        else:
            # Silently skip fact-checking when:
            # - No collections selected (regular chat)
            # - No context found (RAG search returned no results)
            # - No response generated
            if request.collection_ids and len(request.collection_ids) > 0:
                logger.debug(
                    "Skipping fact-check: context=%s, response_length=%d",
                    bool(context),
                    len(full_response),
                )
    except Exception as e:
        logger.error("Error during fact checking: %s", str(e))
        yield emitter.emit_error(f"Fact checking failed: {e!s}", error_code="FACT_CHECK_FAILED")

    # Signal the end of the stream with token metrics
    _duration_ms = int((time.monotonic() - rag_start_time) * 1000)
    token_metrics = {}
    if rag_metrics_callback and rag_metrics_callback.last_metrics:
        m = rag_metrics_callback.last_metrics
        # noinspection PyUnresolvedReferences
        token_metrics = {
            "input_tokens": m.input_tokens,
            "output_tokens": m.output_tokens,
            "total_tokens": m.total_tokens,
            "tokens_per_second": m.tokens_per_second,
            "cost_usd": m.cost_usd,
            "latency_ms": m.latency_ms,
            "provider": m.provider,
            "model": m.model,
        }
    # Remove per-request callback from cached LLM to prevent accumulation
    if rag_metrics_callback and hasattr(strategy, "llm") and strategy.llm and hasattr(strategy.llm, "callbacks") and strategy.llm.callbacks:
        try:
            strategy.llm.callbacks.remove(rag_metrics_callback)
        except ValueError:
            # Callback already absent from the cached LLM; nothing to clean up.
            pass
    yield emitter.emit_stream_end(reason="completed", duration_ms=_duration_ms, **token_metrics)
