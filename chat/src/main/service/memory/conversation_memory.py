import asyncio
import logging
import os
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
    LangChain ConversationSummaryBufferMemory with database-backed summary storage.

    This implementation:
    - Uses LangChain's proven ConversationSummaryBufferMemory (no recursion issues)
    - Stores conversation summaries in PostgreSQL for persistence
    - Combines Redis for recent messages + Database for compressed history
    - Eliminates all circular dependency issues
    """

    def __init__(
        self,
        session_id: str,
        llm: Any = None,
        redis_url: str = None,
        db_session: dbSession | None = None,
        max_token_limit: int = 2000,
        return_messages: bool = True,
    ):
        """
        Initialize the database-backed summary buffer memory.

        Args:
            session_id: Unique identifier for the conversation
            llm: The LLM to use for generating summaries
            redis_url: URL for connecting to Redis (optional, uses default if None)
            db_session: Database session for storing summaries
            max_token_limit: Maximum tokens before summarization kicks in
            return_messages: Whether to return messages or just summary
        """
        if not session_id:
            raise ValueError("session_id is required")

        self.session_id = session_id
        self.llm = llm
        self.db_session = db_session
        self.max_token_limit = max_token_limit
        self.return_messages = return_messages

        # Use default Redis URL if none provided
        if redis_url is None:
            redis_port = os.getenv("REDIS_PORT", "6379")
            redis_url = f"redis://localhost:{redis_port}"

        # Initialize cached summary
        self._cached_summary = ""

        # Initialize LangChain's built-in ConversationSummaryBufferMemory
        self._init_langchain_memory(redis_url)

    def _init_langchain_memory(self, redis_url: str) -> None:
        """Initialize memory with safe fallback approach to avoid recursion."""
        try:
            # Start with the simplest, most reliable approach
            from langchain_community.chat_message_histories import (
                RedisChatMessageHistory,
            )

            # Create simple Redis chat message history (proven to work)
            self.memory = RedisChatMessageHistory(session_id=self.session_id, url=redis_url, ttl=3600)  # 1 hour TTL

            # Load existing summary from database if available
            self._load_summary_from_db()

            logger.info(
                "Initialized simple RedisChatMessageHistory for session: %s",
                self.session_id,
            )

        except Exception as e:
            logger.error("Error initializing Redis memory: %s", str(e))
            # Final fallback to in-memory history
            from langchain_community.chat_message_histories import ChatMessageHistory

            self.memory = ChatMessageHistory()
            logger.info(
                "Using in-memory ChatMessageHistory as fallback for session: %s",
                self.session_id,
            )

    def _load_summary_from_db(self) -> None:
        """Load existing conversation summary from the conversation_summaries table."""
        if not self.db_session:
            self._cached_summary = ""
            return

        try:
            # Convert session_id to UUID for PostgreSQL compatibility
            try:
                session_uuid = uuid.UUID(self.session_id)
            except ValueError as e:
                logger.error("Invalid UUID format for session_id %s: %s", self.session_id, str(e))
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
                    "Loaded existing summary from database for session: %s",
                    self.session_id,
                )
            else:
                self._cached_summary = ""

        except Exception as e:
            logger.warning("Error loading summary from database: %s", str(e))
            self._cached_summary = ""

    def _save_summary_to_db(self) -> None:
        """Save current conversation summary to the conversation_summaries table."""
        if not self.db_session or not hasattr(self.memory, "moving_summary_buffer"):
            return

        try:
            summary_content = getattr(self.memory, "moving_summary_buffer", "")
            if not summary_content:
                return

            # Convert session_id to UUID for PostgreSQL compatibility
            try:
                session_uuid = uuid.UUID(self.session_id)
            except ValueError as e:
                logger.error("Invalid UUID format for session_id %s: %s", self.session_id, str(e))
                return

            self.db_session.execute(
                text(
                    "INSERT INTO conversation_summaries (session_id, summary, updated_at) "
                    "VALUES (:sid, :summary, NOW()) "
                    "ON CONFLICT (session_id) DO UPDATE SET summary = EXCLUDED.summary, updated_at = NOW()"
                ),
                {"sid": session_uuid, "summary": summary_content},
            )
            self.db_session.commit()
            logger.info(
                "Saved conversation summary to database for session: %s",
                self.session_id,
            )

        except Exception as e:
            logger.error("Error saving summary to database: %s", str(e))
            if self.db_session:
                self.db_session.rollback()

    @property
    def messages(self) -> list[Any]:
        """Retrieve all messages from the conversation history."""
        if hasattr(self.memory, "chat_memory"):
            return self.memory.chat_memory.messages
        elif hasattr(self.memory, "messages"):
            return self.memory.messages
        else:
            return []

    @property
    def summary(self) -> str:
        """Get the current conversation summary from database cache."""
        try:
            # Use cached summary from database to avoid LangChain recursion issues
            return getattr(self, "_cached_summary", "")
        except Exception as e:
            logger.warning("Error accessing summary: %s", str(e))
            return ""

    def add_user_message(self, message: str) -> None:
        """
        Add a user message to the conversation history.

        Handles manual summarization and database storage safely.
        """
        try:
            # Add message to Redis/memory
            if hasattr(self.memory, "add_user_message"):
                self.memory.add_user_message(message)

            # Check if we need to summarize (manual implementation to avoid recursion)
            self._maybe_summarize_conversation()

        except Exception as e:
            logger.error("Error adding user message: %s", str(e))

    def add_ai_message(self, message: str) -> None:
        """
        Add an AI message to the conversation history.

        Handles manual summarization and database storage safely.
        """
        try:
            # Add message to Redis/memory (only if memory object exists and has the method)
            if hasattr(self, "memory") and self.memory and hasattr(self.memory, "add_ai_message"):
                self.memory.add_ai_message(message)

            # Check if we need to summarize (manual implementation to avoid recursion)
            self._maybe_summarize_conversation()

        except Exception as e:
            logger.error("Error adding AI message: %s", str(e))

    def _maybe_summarize_conversation(self) -> None:
        """
        Check if conversation needs summarization and handle it safely.

        This is a manual implementation to avoid LangChain's recursion issues.
        """
        try:
            # Get current messages safely
            messages = self.messages
            if not messages or len(messages) < 4:  # Only summarize if we have at least 2 message pairs (user + assistant)
                return

            # Estimate token count (rough approximation: 1 token ≈ 4 characters)
            total_chars = sum(len(getattr(msg, "content", str(msg))) for msg in messages)
            estimated_tokens = total_chars // 4

            if estimated_tokens > self.max_token_limit:
                logger.info(
                    "Conversation exceeds token limit (%d > %d), creating summary",
                    estimated_tokens,
                    self.max_token_limit,
                )
                self._create_summary_and_compress(messages)

        except Exception as e:
            logger.error("Error in _maybe_summarize_conversation: %s", str(e))

    def _create_summary_and_compress(self, messages) -> None:
        """
        Create a summary of the conversation and compress it to database.

        This is a safe manual implementation without LangChain's complex logic.
        """
        try:
            # Create a simple text summary of the conversation
            summary_parts = []
            for msg in messages[:-3]:  # Keep last 3 messages, summarize the rest
                if hasattr(msg, "content"):
                    content = msg.content[:200]  # Truncate long messages
                    msg_type = getattr(msg.__class__, "__name__", "Message")
                    if "Human" in msg_type or "User" in msg_type:
                        summary_parts.append(f"User: {content}")
                    elif "AI" in msg_type or "Assistant" in msg_type:
                        summary_parts.append(f"Assistant: {content}")
                    else:
                        summary_parts.append(f"System: {content}")

            # Create summary text
            summary_text = "\n".join(summary_parts)
            if summary_text:
                # Save to database
                self._save_summary_to_db_direct(summary_text)
                logger.info(
                    "Created and saved conversation summary for session: %s",
                    self.session_id,
                )

        except Exception as e:
            logger.error("Error creating summary: %s", str(e))

    def _save_summary_to_db_direct(self, summary_text: str) -> None:
        """Save summary directly to the conversation_summaries table."""
        if not self.db_session or not summary_text:
            return

        try:
            # Convert session_id to UUID for PostgreSQL compatibility
            try:
                session_uuid = uuid.UUID(self.session_id)
            except ValueError as e:
                logger.error("Invalid UUID format for session_id %s: %s", self.session_id, str(e))
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
                "Saved conversation summary to database for session: %s",
                self.session_id,
            )

        except Exception as e:
            logger.error("Error saving summary to database: %s", str(e))
            if self.db_session:
                self.db_session.rollback()

    def get_chat_history(self) -> list[Any]:
        """
        Get the complete chat history for use in prompts.

        LangChain's ConversationSummaryBufferMemory handles this automatically.
        """
        try:
            if hasattr(self.memory, "buffer"):
                return self.memory.buffer
            elif hasattr(self.memory, "chat_memory") and hasattr(self.memory.chat_memory, "messages"):
                return self.memory.chat_memory.messages
            elif hasattr(self.memory, "messages"):
                return self.memory.messages
            else:
                return []
        except Exception as e:
            logger.error("Error getting chat history: %s", str(e))
            return []

    def get_context_for_llm(self) -> dict:
        """
        Get optimized context for LLM: summary + last exchange pattern.

        Returns:
            dict: Contains 'summary', 'last_exchange', and 'full_messages' for different use cases
        """
        try:
            messages = self.messages
            summary = self.summary

            # If we have a summary and more than 2 messages, use summary + last exchange
            if summary and len(messages) > 2:
                # Get the last user-assistant exchange (last 2 messages)
                last_exchange = messages[-2:] if len(messages) >= 2 else messages

                return {
                    "summary": summary,
                    "last_exchange": last_exchange,
                    "has_summary": True,
                    "full_messages": messages,  # Fallback for non-summary aware systems
                }
            else:
                # No summary yet, return all messages
                return {
                    "summary": "",
                    "last_exchange": [],
                    "has_summary": False,
                    "full_messages": messages,
                }

        except Exception as e:
            logger.error("Error getting context for LLM: %s", str(e))
            return {
                "summary": "",
                "last_exchange": [],
                "has_summary": False,
                "full_messages": [],
            }

    def clear(self) -> None:
        """Clear both the message history and summary."""
        try:
            if hasattr(self.memory, "clear"):
                self.memory.clear()
            elif hasattr(self.memory, "chat_memory"):
                self.memory.chat_memory.clear()

            # Also clear from database
            self._clear_summary_from_db()

        except Exception as e:
            logger.error("Error clearing memory: %s", str(e))

    def _clear_summary_from_db(self) -> None:
        """Delete conversation summary from the conversation_summaries table."""
        if not self.db_session:
            return

        try:
            # Convert session_id to UUID for PostgreSQL compatibility
            try:
                session_uuid = uuid.UUID(self.session_id)
            except ValueError as e:
                logger.error("Invalid UUID format for session_id %s: %s", self.session_id, str(e))
                return

            self.db_session.execute(
                text("DELETE FROM conversation_summaries WHERE session_id = :sid"),
                {"sid": session_uuid},
            )
            self.db_session.commit()
            logger.info(
                "Cleared conversation summary from database for session: %s",
                self.session_id,
            )

        except Exception as e:
            logger.error("Error clearing summary from database: %s", str(e))
            if self.db_session:
                self.db_session.rollback()


class DatabaseOnlyMemory:
    """
    Pure database-backed conversation memory with summary persistence.

    This implementation:
    - Stores conversation summaries in the conversation_summaries table (Python-owned)
    - Receives conversation history from the caller (Kotlin owns messages)
    - Completely avoids embedded Redis compatibility issues
    - Compatible with LangChain message format
    """

    def __init__(
        self,
        session_id: str,
        db_session: dbSession | None = None,
        max_token_limit: int = 2000,
        conversation_history: list[Any] | None = None,
    ):
        """
        Initialize database-only conversation memory.

        Args:
            session_id: Unique identifier for the conversation
            db_session: Database session for storing summaries
            max_token_limit: Maximum tokens before summarization kicks in
            conversation_history: List of message dicts from gRPC (each with 'role' and 'content')
        """
        if not session_id:
            raise ValueError("session_id is required")

        self.session_id = session_id
        self.db_session = db_session
        self.max_token_limit = max_token_limit
        self._cached_summary = ""
        self._message_cache = []
        self._cache_dirty = True

        # Load existing data from database and provided conversation history
        self._load_from_db(conversation_history=conversation_history)

    def _load_from_db(self, conversation_history: list[Any] | None = None) -> None:
        """Load summary from conversation_summaries table and messages from provided history.

        Args:
            conversation_history: List of message dicts from gRPC (each with 'role' and 'content').
                                  If None, the message cache remains empty.
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

            # Populate message cache from provided conversation history (Kotlin owns messages)
            from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

            self._message_cache = []
            if conversation_history:
                for msg in conversation_history:
                    role = msg.get("role", "") if isinstance(msg, dict) else getattr(msg, "role", "")
                    content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")

                    if role == "user":
                        self._message_cache.append(HumanMessage(content=content))
                    elif role == "assistant":
                        if content and content.strip():
                            self._message_cache.append(AIMessage(content=content))
                    elif role == "system":
                        self._message_cache.append(SystemMessage(content=content))

            self._cache_dirty = False
            logger.info(
                "Loaded %d messages from conversation history for session: %s",
                len(self._message_cache),
                self.session_id,
            )

        except Exception as e:
            logger.error("Error loading from database: %s", str(e))
            self._cached_summary = ""
            self._message_cache = []

    @property
    def messages(self) -> list[Any]:
        """Retrieve all messages from the conversation history."""
        if self._cache_dirty:
            self._load_from_db()
        return self._message_cache.copy()

    @property
    def summary(self) -> str:
        """Get the current conversation summary."""
        return self._cached_summary

    def add_user_message(self, message: str) -> None:
        """Add a user message to the conversation history."""
        try:
            from langchain_core.messages import HumanMessage

            # Add to cache
            msg = HumanMessage(content=message)
            self._message_cache.append(msg)

            # Database saving is handled by chat controller to prevent duplicates
            # self._save_message_to_db('user', message)  # REMOVED: Causes duplicate messages

            # Check if we need to summarize
            self._maybe_summarize_conversation()

        except Exception as e:
            logger.error("Error adding user message: %s", str(e))

    def add_ai_message(self, message: str) -> None:
        """Add an AI message to the conversation history."""
        try:
            from langchain_core.messages import AIMessage

            # Add to cache
            msg = AIMessage(content=message)
            self._message_cache.append(msg)

            # Database saving is handled by chat controller to prevent duplicates
            # self._save_message_to_db('assistant', message)  # REMOVED: Causes duplicate messages

            # Check if we need to summarize
            self._maybe_summarize_conversation()

        except Exception as e:
            logger.error("Error adding AI message: %s", str(e))

    def _maybe_summarize_conversation(self) -> None:
        """Check if conversation needs summarization and handle it safely."""
        try:
            messages = self._message_cache
            if not messages or len(messages) < 4:  # Only summarize if we have at least 2 message pairs (user + assistant)
                return

            # Estimate token count (rough approximation: 1 token ≈ 4 characters)
            total_chars = sum(len(getattr(msg, "content", str(msg))) for msg in messages)
            estimated_tokens = total_chars // 4

            if estimated_tokens > self.max_token_limit:
                logger.info(
                    "Conversation exceeds token limit (%d > %d), creating summary",
                    estimated_tokens,
                    self.max_token_limit,
                )
                self._create_summary_and_compress(messages)

        except Exception as e:
            logger.error("Error in _maybe_summarize_conversation: %s", str(e))

    def _create_summary_and_compress(self, messages) -> None:
        """
        Create a summary of the conversation and compress it to database.

        Detects async context and queues background task if running in async,
        otherwise falls back to simple truncation (no blocking LLM calls).
        """
        try:
            # Keep last 4 messages (2 exchanges), summarize the rest
            messages_to_summarize = messages[:-4] if len(messages) > 4 else messages[:-2]

            if not messages_to_summarize:
                logger.debug("Not enough messages to summarize")
                return

            # Format messages for summarization
            conversation_text = get_conversation_text_for_summarization(messages_to_summarize, max_messages=10)

            if not conversation_text:
                return

            # Try to detect if we're in an async context
            try:
                asyncio.get_running_loop()  # Raises RuntimeError if no running loop
                # We're in async context - create background task for LLM summarization
                asyncio.create_task(self._async_summarize_and_save(conversation_text))
                logger.debug("Queued async summarization task for session: %s", self.session_id)
            except RuntimeError:
                # No running loop - use simple truncation fallback (no blocking LLM calls)
                summary_text = self._simple_truncate_summary(conversation_text)
                if summary_text:
                    # Combine with existing summary if present
                    if self._cached_summary:
                        combined_summary = f"{self._cached_summary}\n\n{summary_text}"
                        if len(combined_summary) > 2000:
                            summary_text = combined_summary[:2000] + "..."
                        else:
                            summary_text = combined_summary

                    self._save_summary_to_db(summary_text)
                    self._cached_summary = summary_text
                    logger.info(
                        "Created truncation-based summary for session: %s (%d chars)",
                        self.session_id,
                        len(summary_text),
                    )

        except Exception as e:
            logger.error("Error creating summary: %s", str(e))

    async def _async_summarize_and_save(self, conversation_text: str) -> None:
        """
        Async background task to summarize conversation with LLM and save to DB.

        Opens a fresh database session to avoid reusing a caller session that may
        already be closed by the time this background task executes.
        """
        try:
            summary_text = await self._summarize_with_llm_async(conversation_text)

            if summary_text:
                # Combine with existing summary if present
                if self._cached_summary:
                    combined_summary = f"{self._cached_summary}\n\n{summary_text}"
                    if len(combined_summary) > 2000:
                        re_summarized = await self._summarize_with_llm_async(combined_summary)
                        if re_summarized:
                            summary_text = re_summarized
                        else:
                            summary_text = combined_summary[:2000] + "..."
                    else:
                        summary_text = combined_summary

                # Update in-memory cache immediately
                self._cached_summary = summary_text

                # Save to database with a fresh session (background tasks must not reuse caller sessions)
                try:
                    from src.main.config.database import SessionLocal

                    fresh_db = SessionLocal()
                    try:
                        actual_session_id = parse_composite_session_id(self.session_id)
                        session_uuid = uuid.UUID(actual_session_id)
                        fresh_db.execute(
                            text(
                                "INSERT INTO conversation_summaries (session_id, summary, updated_at) "
                                "VALUES (:sid, :summary, NOW()) "
                                "ON CONFLICT (session_id) DO UPDATE SET summary = EXCLUDED.summary, updated_at = NOW()"
                            ),
                            {"sid": session_uuid, "summary": summary_text},
                        )
                        fresh_db.commit()
                        logger.info(
                            "Created and saved LLM conversation summary for session: %s (%d chars)",
                            self.session_id,
                            len(summary_text),
                        )
                    finally:
                        fresh_db.close()
                except Exception as db_err:
                    logger.error("Error saving background summary to database: %s", str(db_err))

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

            # Get system-configured agent model
            agent_config = get_system_agent_model(db=self.db_session, agent_type="conversation_summarizer")
            model = agent_config.get_pydantic_ai_model()

            # Get prompt template from prompts.yaml
            prompt_template = resolved_prompts.get("conversation_memory", {}).get(
                "summarization_prompt", "Summarize this conversation concisely:\n{conversation_text}\n\nSummary:"
            )
            prompt = prompt_template.format(conversation_text=conversation_text)

            # Create summarization agent
            summarizer = Agent(model, system_prompt="You are a conversation summarizer. Create concise, informative summaries.")

            # Run async
            result = await summarizer.run(prompt)
            track_agent_usage(result, agent_type="conversation_memory_summary", model=agent_config.get_pydantic_ai_model_string())
            summary = result.output
            logger.debug("LLM summarization successful: %d chars", len(summary))
            return summary.strip()

        except ImportError as e:
            logger.warning("LLM summarization dependencies not available: %s", str(e))
        except Exception as e:
            logger.warning("LLM summarization failed, using fallback: %s", str(e))

        # Fallback: simple truncation-based summary
        return self._simple_truncate_summary(conversation_text)

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
                "Saved conversation summary to database for session: %s",
                self.session_id,
            )

        except Exception as e:
            logger.error("Error saving summary to database: %s", str(e))
            if self.db_session:
                self.db_session.rollback()

    def get_context_for_llm(self) -> dict:
        """
        Get optimized context for LLM: summary + last exchange pattern.

        Returns:
            dict: Contains 'summary', 'last_exchange', and 'full_messages' for different use cases
        """
        try:
            messages = self._message_cache
            summary = self._cached_summary

            # If we have a summary and more than 2 messages, use summary + last exchange
            if summary and len(messages) > 2:
                # Get the last user-assistant exchange (last 2 messages)
                last_exchange = messages[-2:] if len(messages) >= 2 else messages

                return {
                    "summary": summary,
                    "last_exchange": last_exchange,
                    "has_summary": True,
                    "full_messages": messages,  # Fallback for non-summary aware systems
                }
            else:
                # No summary yet, return all messages
                return {
                    "summary": "",
                    "last_exchange": [],
                    "has_summary": False,
                    "full_messages": messages,
                }

        except Exception as e:
            logger.error("Error getting context for LLM: %s", str(e))
            return {
                "summary": "",
                "last_exchange": [],
                "has_summary": False,
                "full_messages": [],
            }

    def clear(self) -> None:
        """Clear the message cache and delete the summary from conversation_summaries."""
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
            self._message_cache = []
            self._cached_summary = ""

            logger.info(
                "Cleared conversation summary for session: %s",
                self.session_id,
            )

        except Exception as e:
            logger.error("Error clearing conversation: %s", str(e))
            if self.db_session:
                self.db_session.rollback()


# Legacy aliases for backward compatibility
RedisSummaryBufferMemory = DatabaseOnlyMemory
