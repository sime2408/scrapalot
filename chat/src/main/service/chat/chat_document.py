"""
Document QA Chat Handler

Extracted from chat.py to handle document Q&A requests for unprocessed documents.
This module processes chat requests when the target document hasn't been indexed yet.
"""

import asyncio
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlmodel import Session as SQLModelSession

from src.main.constants.status_codes import StatusCode
from src.main.models.sqlmodel_models import Document
from src.main.service.streaming.packet_emitter import PacketEmitter
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


async def process_document_qa(
    query: str,
    document: Document,
    db: SQLModelSession,
    emitter: PacketEmitter,
    assistant_message_id: UUID | None = None,
    user_id: UUID | None = None,
    conversation_context: dict[str, Any] | None = None,
    session_id: UUID | None = None,
    model_name: str | None = None,
    provider_type: str | None = None,
    subscription_tier: str | None = None,
) -> AsyncGenerator[str, None]:
    """
    Process a document Q&A request for an unprocessed document.

    This function handles documents that haven't been indexed yet (pending, uploading, failed).
    It uses DocumentQAAgent to answer questions directly from the file content.

    Args:
        query: User's question about the document
        document: Document object (must be unprocessed)
        db: Database session
        emitter: PacketEmitter for streaming responses
        assistant_message_id: ID of the assistant message to update
        user_id: Optional user ID for storing chat-generated summaries
        conversation_context: Optional dict with 'summary' and 'recent_messages' for history context
        session_id: Optional session ID for title generation
        model_name: Optional model name for title generation
        provider_type: Optional provider type for title generation
        subscription_tier: Optional subscription tier for title generation

    Yields:
        JSON packet strings for streaming response
    """
    logger.info(
        "Document %s is unprocessed (status: %s); direct document Q&A is not available in this edition",
        document.id,
        document.processing_status,
    )

    yield emitter.emit_status(StatusCode.DOCUMENT_QA_NOT_INDEXED.value, stage=StatusCode.DOCUMENT_QA.value)

    # Community Edition removes the DocumentQAAgent (direct file Q&A on unindexed
    # documents). Degrade gracefully: inform the user the document must finish
    # processing before it can be queried via the normal RAG retrieval path.
    yield emitter.emit_message_delta(
        "This document is still being processed and isn't indexed yet. "
        "Please wait for processing to complete, then ask your question again."
    )

    # Start background title generation for DocumentQA (non-blocking)
    if session_id and user_id and document and query:
        asyncio.create_task(
            _generate_and_update_title_for_document_qa(
                session_id=str(session_id),
                document_title=document.filename or "Unknown Document",
                user_question=query,
                model_name=model_name or "gpt-4o-mini",
                provider_type=provider_type or "openai",
                user_id=str(user_id),
                subscription_tier=subscription_tier,
            )
        )
        logger.info(
            "Started background title generation task for DocumentQA session: %s",
            session_id,
        )


async def _generate_and_update_title_for_document_qa(
    session_id: str,
    document_title: str,
    user_question: str,
    model_name: str,
    provider_type: str,
    user_id: str,
    subscription_tier: str | None = None,
):
    """
    Generate a session title for DocumentQA in the background.

    Creates a concise title based on document name and user's question.
    The title is sent via WebSocket notification; Kotlin backend owns the sessions table.

    Args:
        session_id: Session ID for the title
        document_title: Name/filename of the document
        user_question: User's question about the document
        model_name: LLM model to use for title generation
        provider_type: LLM provider type
        user_id: User ID
        subscription_tier: Optional subscription tier
    """
    from src.main.config.database import SessionLocal
    from src.main.service.history.messages import ChatMessageService

    db = SessionLocal()

    try:
        combined_message = f"Document: {document_title}\nQuestion: {user_question}"

        try:
            new_title = await ChatMessageService.generate_conversation_title(
                combined_message,
                db,
                model_name,
                provider_type,
                user_id,
                subscription_tier,
            )
            logger.info("Generated DocumentQA title: %s", new_title)
        except Exception as title_error:
            logger.error("DocumentQA title generation failed: %s", str(title_error))
            new_title = f"{document_title[:30]} - {datetime.now(UTC).strftime('%Y-%m-%d %H:%M')}"

        # Send WebSocket notification for title update (Kotlin backend persists it)
        try:
            from src.main.utils.websocket.manager import websocket_manager

            asyncio.create_task(
                websocket_manager.send_workspace_notification(
                    user_id=user_id,
                    event_type="session_title_updated",
                    workspace_data={
                        "session_id": session_id,
                        "title": new_title,
                    },
                )
            )
            logger.debug("Sent WebSocket notification for DocumentQA title update: %s", session_id)
        except Exception as ws_error:
            logger.warning("Failed to send WebSocket notification for DocumentQA title: %s", str(ws_error))

    except Exception as e:
        logger.error("Error in background DocumentQA title generation for session %s: %s", session_id, str(e))
    finally:
        try:
            db.close()
        except Exception as close_error:
            logger.warning("Error closing database session in DocumentQA title generation: %s", str(close_error))
