"""
Improved Database-Backed Buffer Memory for Conversations.

This implementation combines the best of both worlds:
- Buffer pattern from DatabaseSummaryBufferMemory (recent messages and compressed history)
- Pure database approach (no Redis dependency)
- Async LLM summarization for better quality summaries
- Automatic summarization when conversation exceeds token limit

Key Features:
- Keeps recent messages in memory buffer (fast access)
- Automatically triggers LLM summarization when buffer grows
- Stores summaries in conversation_summaries table (Python-owned)
- Receives conversation history from gRPC caller (Kotlin owns messages)
- Sends optimized context to LLM: summary and recent messages
- No external dependencies (Redis-free)
"""

import asyncio
import logging
from typing import Any
import uuid

from sqlalchemy import text
from sqlalchemy.orm import Session as dbSession

from src.main.models.python_only_models import ConversationSummary
from src.main.utils.auth.sessions import parse_composite_session_id
from src.main.utils.config.loader import resolved_prompts
from src.main.utils.llm.conversation import get_conversation_text_for_summarization
from src.main.utils.llm.usage_tracker import track_agent_usage

logger = logging.getLogger(__name__)


class DatabaseSummaryBufferMemory:
    """
    Improved conversation memory with buffer pattern and LLM summarization.

    This implements the "buffered memory" concept:
    - Buffer: Keep last N messages in memory (fast access)
    - Summary: Compress older messages into LLM-generated summary stored in conversation_summaries
    - Automatic: Trigger summarization when the buffer exceeds the limit
    - Messages: Received from gRPC caller (Kotlin owns message persistence)

    Example:
        When conversation has 50 messages:
        - Messages 1-40: Summarized into conversation_summaries table (LLM)
        - Messages 41-50: Kept in buffer (exact text)
        - LLM receives: summary and messages 41-50
    """

    def __init__(
        self,
        session_id: str,
        db_session: dbSession | None = None,
        max_buffer_size: int = 10,  # Keep last 10 messages in buffer
        max_token_limit: int | None = None,  # Auto-calculated from model context_window if None
        min_messages_before_summary: int = 4,  # Minimum messages before summarizing
        conversation_history: list[Any] | None = None,
    ):
        """
        Initialize the improved buffer memory.

        Args:
            session_id: Unique identifier for the conversation
            db_session: Database session for persistence
            max_buffer_size: Maximum recent messages to keep in buffer (default: 10)
            max_token_limit: Token limit before triggering summarization.
                            If None, auto-calculated as 25% of the model's context_window.
            min_messages_before_summary: Minimum messages before the first summary (default: 4)
            conversation_history: List of message dicts from gRPC (each with 'role' and 'content')
        """
        if not session_id:
            raise ValueError("session_id is required")

        self.session_id = session_id
        self.db_session = db_session
        self.max_buffer_size = max_buffer_size
        self.min_messages_before_summary = min_messages_before_summary

        # Calculate max_token_limit from the model's context_window if not provided
        if max_token_limit is None:
            self.max_token_limit = self._calculate_max_token_limit()
        else:
            self.max_token_limit = max_token_limit

        # Buffer: recent messages kept in memory (fast access)
        self._message_buffer: list[Any] = []
        self._cached_summary = ""
        self._cache_dirty = True

        # Load existing data from database and provided conversation history
        self._load_from_db(conversation_history=conversation_history)

    def _calculate_max_token_limit(self) -> int:
        """
        Calculate max_token_limit based on the agent model's context_window.

        Uses 25% of context_window for conversation history, reserving the rest for:
        - System prompt and RAG context (~50%)
        - LLM response (~25%)

        Returns:
            Token limit for conversation memory (default: 32,000 tokens = 25% of 128K)
        """
        try:
            from src.main.utils.llm.agent_model_utils import get_system_agent_model

            # Get agent model config with context_window
            agent_config = get_system_agent_model(db=self.db_session, agent_type="conversation_summarizer")

            # Use 25% of context_window for conversation history
            context_window = agent_config.context_window
            max_token_limit = context_window // 4

            logger.info(
                "Auto-calculated max_token_limit=%d (25%% of context_window=%d)",
                max_token_limit,
                context_window,
            )
            return max_token_limit

        except Exception as e:
            logger.warning("Failed to calculate max_token_limit from context_window: %s. Using default 32000.", str(e))
            return 32000  # Default: 25% of the 128K context window

    def _load_from_db(self, conversation_history: list[Any] | None = None) -> None:
        """Load summary from conversation_summaries table and messages from provided history.

        Args:
            conversation_history: List of message dicts from gRPC (each with 'role' and 'content').
                                  If None, the message buffer remains empty.
        """
        try:
            # Extract actual session UUID from composite session_id (format: user_id:session_id)
            actual_session_id = parse_composite_session_id(self.session_id)
            if actual_session_id != self.session_id:
                logger.debug(
                    "Extracted session UUID %s from composite session_id %s",
                    actual_session_id,
                    self.session_id,
                )

            # Load summary from conversation_summaries table
            if self.db_session:
                try:
                    session_uuid = uuid.UUID(actual_session_id)
                except ValueError as e:
                    logger.error(
                        "Invalid UUID format for session_id %s: %s",
                        actual_session_id,
                        str(e),
                    )
                    return

                # noinspection PyTypeChecker
                summary_record = (
                    self.db_session.query(ConversationSummary)
                    # noinspection PyTypeChecker
                    .filter(ConversationSummary.session_id == session_uuid)
                    .first()
                )

                if summary_record and summary_record.summary:
                    self._cached_summary = summary_record.summary
                    logger.info(
                        "Loaded existing summary from conversation_summaries for session: %s",
                        self.session_id,
                    )
                else:
                    self._cached_summary = ""

            # Populate message buffer from provided conversation history (Kotlin owns messages)
            from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

            self._message_buffer = []
            if conversation_history:
                for msg in conversation_history:
                    role = msg.get("role", "") if isinstance(msg, dict) else getattr(msg, "role", "")
                    content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")

                    if role == "user":
                        self._message_buffer.append(HumanMessage(content=content))
                    elif role == "assistant":
                        if content and content.strip():
                            self._message_buffer.append(AIMessage(content=content))
                    elif role == "system":
                        self._message_buffer.append(SystemMessage(content=content))

            self._cache_dirty = False
            logger.info(
                "Loaded %d messages into buffer for session: %s",
                len(self._message_buffer),
                self.session_id,
            )

        except Exception as e:
            logger.error("Error loading from database: %s", str(e))
            self._cached_summary = ""
            self._message_buffer = []

    @property
    def messages(self) -> list[Any]:
        """
        Get all messages (summary is NOT included, use get_context_for_llm() instead).

        Returns:
            List of messages in the buffer (recent messages only)
        """
        if self._cache_dirty:
            self._load_from_db()
        return self._message_buffer.copy()

    @property
    def summary(self) -> str:
        """Get the current conversation summary."""
        return self._cached_summary

    def add_user_message(self, message: str) -> None:
        """
        Add a user message to the buffer and trigger summarization if needed.

        This implements the buffer pattern:
        1. Add a message to the buffer
        2. Check if summarization is needed
        3. If yes, trigger async LLM summarization in the background

        Args:
            message: User message content
        """
        try:
            from langchain_core.messages import HumanMessage

            # Add to buffer
            msg = HumanMessage(content=message)
            self._message_buffer.append(msg)

            logger.debug(
                "Added user message to buffer. Buffer size: %d messages",
                len(self._message_buffer),
            )

            # Database saving is handled by chat controller to prevent duplicates
            # Check if we need to summarize
            self._maybe_summarize_conversation()

        except Exception as e:
            logger.error("Error adding user message: %s", str(e))

    def add_ai_message(self, message: str) -> None:
        """
        Add an AI message to the buffer and trigger summarization if needed.

        Args:
            message: AI message content
        """
        try:
            from langchain_core.messages import AIMessage

            # Add to buffer
            msg = AIMessage(content=message)
            self._message_buffer.append(msg)

            logger.debug(
                "Added AI message to buffer. Buffer size: %d messages",
                len(self._message_buffer),
            )

            # Database saving is handled by chat controller to prevent duplicates
            # Check if we need to summarize
            self._maybe_summarize_conversation()

        except Exception as e:
            logger.error("Error adding AI message: %s", str(e))

    def _maybe_summarize_conversation(self) -> None:
        """
        Check if the conversation needs summarization and handle it.

        Triggers summarization when:
        1. Buffer has more than min_messages_before_summary messages
        2. Total estimated tokens exceed max_token_limit

        Uses async LLM summarization in the background to avoid blocking.
        """
        try:
            messages = self._message_buffer

            # Only summarize if we have enough messages
            if len(messages) < self.min_messages_before_summary:
                logger.debug(
                    "Not enough messages for summary (%d < %d)",
                    len(messages),
                    self.min_messages_before_summary,
                )
                return

            # Estimate token count (rough approximation: 1 token ≈ 4 characters)
            total_chars = sum(len(getattr(msg, "content", str(msg))) for msg in messages)
            estimated_tokens = total_chars // 4

            if estimated_tokens > self.max_token_limit:
                logger.info(
                    "Conversation exceeds token limit (%d > %d), triggering LLM summarization",
                    estimated_tokens,
                    self.max_token_limit,
                )

                # Try to detect if we're in an async context
                try:
                    asyncio.get_running_loop()  # Raises RuntimeError if no running loop
                    # We're in async context - create background task for LLM summarization
                    asyncio.create_task(self._async_summarize_and_compress())
                    logger.debug("Queued async summarization task for session: %s", self.session_id)
                except RuntimeError:
                    # No running loop - use simple truncation fallback (no blocking LLM calls)
                    logger.warning(
                        "Not in async context, using simple truncation fallback for session: %s",
                        self.session_id,
                    )
                    self._simple_truncate_and_compress()

        except Exception as e:
            logger.error("Error in _maybe_summarize_conversation: %s", str(e))

    async def _async_summarize_and_compress(self) -> None:
        """
        Async background task to summarize conversation with LLM and compress buffer.

        This implements the core buffer pattern:
        1. Take older messages (outside the buffer window)
        2. Summarize them with LLM
        3. Combine with the existing summary
        4. Keep only recent messages in the buffer
        5. Save summary to a database
        """
        try:
            messages = self._message_buffer

            if len(messages) <= self.max_buffer_size:
                logger.debug("Buffer within limits, no summarization needed")
                return

            # Messages to summarize: everything except the last max_buffer_size messages
            messages_to_summarize = messages[: -self.max_buffer_size]

            if not messages_to_summarize:
                return

            # Format messages for summarization
            conversation_text = get_conversation_text_for_summarization(messages_to_summarize, max_messages=20)

            if not conversation_text:
                return

            # Generate summary with LLM
            summary_text = await self._summarize_with_llm_async(conversation_text)

            if summary_text:
                # Combine with the existing summary if present
                if self._cached_summary:
                    combined_summary = f"{self._cached_summary}\n\n{summary_text}"
                    if len(combined_summary) > 2000:
                        # Re-summarize if combined is too long
                        re_summarized = await self._summarize_with_llm_async(combined_summary)
                        if re_summarized:
                            summary_text = re_summarized
                        else:
                            # Fallback: truncate combined summary
                            summary_text = combined_summary[:2000] + "..."
                    else:
                        summary_text = combined_summary

                # Save to a database and update cache
                self._save_summary_to_db(summary_text)
                self._cached_summary = summary_text

                # Compress buffer: keep only recent messages
                self._message_buffer = self._message_buffer[-self.max_buffer_size :]

                logger.info(
                    "Compressed buffer: %d → %d messages, summary: %d chars",
                    len(messages),
                    len(self._message_buffer),
                    len(summary_text),
                )

        except Exception as e:
            logger.error("Error in async summarization: %s", str(e))

    async def _summarize_with_llm_async(self, conversation_text: str) -> str | None:
        """
        Async LLM-based conversation summarization.

        Args:
            conversation_text: Formatted conversation text to summarize

        Returns:
            Summary string or None if failed
        """
        try:
            # noinspection PyUnresolvedReferences
            from pydantic_ai import Agent

            # noinspection PyUnresolvedReferences
            from src.main.utils.llm.agent_model_utils import get_system_agent_model

            # Get a system-configured agent model
            agent_config = get_system_agent_model(db=self.db_session, agent_type="conversation_summarizer")
            model = agent_config.get_pydantic_ai_model()

            # Get a prompt template from prompts.yaml
            prompt_template = resolved_prompts.get("conversation_memory", {}).get(
                "summarization_prompt", "Summarize this conversation concisely:\n{conversation_text}\n\nSummary:"
            )
            prompt = prompt_template.format(conversation_text=conversation_text)

            # Create a summarization agent
            summarizer = Agent(
                model,
                system_prompt="You are a conversation summarizer. Create concise, informative summaries that capture key points,"
                " decisions, and context.",
            )

            # Run async
            result = await summarizer.run(prompt)
            track_agent_usage(result, agent_type="conversation_summary", model=agent_config.get_pydantic_ai_model_string())
            summary = result.output
            logger.debug("LLM summarization successful: %d chars", len(summary))
            return summary.strip()

        except ImportError as e:
            logger.warning("LLM summarization dependencies not available: %s", str(e))
        except Exception as e:
            logger.warning("LLM summarization failed, using fallback: %s", str(e))

        # Fallback: simple truncation-based summary
        return self._simple_truncate_summary(conversation_text)

    def _simple_truncate_and_compress(self) -> None:
        """Fallback compression without LLM (used in non-async contexts)."""
        try:
            messages = self._message_buffer

            if len(messages) <= self.max_buffer_size:
                return

            # Simple truncation summary
            messages_to_summarize = messages[: -self.max_buffer_size]
            conversation_text = "\n".join(
                [f"{msg.__class__.__name__}: {getattr(msg, 'content', str(msg))[:200]}" for msg in messages_to_summarize[:10]]
            )

            summary_text = self._simple_truncate_summary(conversation_text)

            if summary_text:
                self._save_summary_to_db(summary_text)
                self._cached_summary = summary_text
                self._message_buffer = self._message_buffer[-self.max_buffer_size :]

                logger.info(
                    "Compressed buffer (fallback): %d → %d messages",
                    len(messages),
                    len(self._message_buffer),
                )

        except Exception as e:
            logger.error("Error in simple truncation fallback: %s", str(e))

    def _save_summary_to_db(self, summary_text: str) -> None:
        """Save summary to the conversation_summaries table via upsert."""
        if not self.db_session or not summary_text:
            return

        try:
            # Extract actual session UUID from composite session_id
            actual_session_id = parse_composite_session_id(self.session_id)

            # Convert session_id to UUID for PostgreSQL compatibility
            try:
                session_uuid = uuid.UUID(actual_session_id)
            except ValueError as e:
                logger.error(
                    "Invalid UUID format for session_id %s: %s",
                    actual_session_id,
                    str(e),
                )
                return

            self.db_session.execute(
                text(
                    "INSERT INTO conversation_summaries (session_id, summary, updated_at) "
                    "VALUES (:sid, :summary, NOW()) "
                    "ON CONFLICT (session_id) DO UPDATE SET summary = EXCLUDED.summary, updated_at = NOW()"
                ),
                {"sid": session_uuid, "summary": summary_text},
            )
            self.db_session.commit()
            logger.info(
                "Saved conversation summary to database for session: %s (%d chars)",
                self.session_id,
                len(summary_text),
            )

        except Exception as e:
            logger.error("Error saving summary to database: %s", str(e))
            if self.db_session:
                self.db_session.rollback()

    def get_context_for_llm(self) -> dict:
        """
        Get optimized context for LLM: summary and buffer messages.

        This implements the key strength of buffered memory:
        - Older context: Compressed LLM summary
        - Recent context: Exact messages from buffer

        Returns:
            dict: Contains 'summary', 'buffer_messages', and 'full_messages'
        """
        try:
            messages = self._message_buffer
            summary = self._cached_summary

            # If we have a summary, use a summary + buffer pattern
            if summary:
                return {
                    "summary": summary,
                    "buffer_messages": messages,  # Recent messages from buffer
                    "has_summary": True,
                    "total_messages_buried": len(messages),  # Messages hidden in summary
                    "full_messages": messages,  # Fallback for non-summary-aware systems
                }
            else:
                # No summary yet, return all messages
                return {
                    "summary": "",
                    "buffer_messages": messages,
                    "has_summary": False,
                    "total_messages_buried": 0,
                    "full_messages": messages,
                }

        except Exception as e:
            logger.error("Error getting context for LLM: %s", str(e))
            return {
                "summary": "",
                "buffer_messages": [],
                "has_summary": False,
                "total_messages_buried": 0,
                "full_messages": [],
            }

    def clear(self) -> None:
        """Clear the message buffer and delete the summary from conversation_summaries."""
        try:
            if self.db_session:
                # Extract actual session UUID from composite session_id
                actual_session_id = parse_composite_session_id(self.session_id)

                # Convert session_id to UUID for PostgreSQL compatibility
                try:
                    session_uuid = uuid.UUID(actual_session_id)
                except ValueError as e:
                    logger.error(
                        "Invalid UUID format for session_id %s: %s",
                        actual_session_id,
                        str(e),
                    )
                    return

                # Delete summary from conversation_summaries
                self.db_session.execute(
                    text("DELETE FROM conversation_summaries WHERE session_id = :sid"),
                    {"sid": session_uuid},
                )
                self.db_session.commit()

            # Clear cache
            self._message_buffer = []
            self._cached_summary = ""

            logger.info(
                "Cleared conversation summary for session: %s",
                self.session_id,
            )

        except Exception as e:
            logger.error("Error clearing conversation: %s", str(e))
            if self.db_session:
                self.db_session.rollback()
