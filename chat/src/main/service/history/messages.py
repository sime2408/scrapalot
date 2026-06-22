from datetime import UTC, datetime
import re
import uuid

# Configure Pydantic to allow arbitrary types
try:
    import pydantic.v1

    # The correct way to set this configuration
    class PydanticConfig(pydantic.v1.BaseConfig):
        arbitrary_types_allowed = True

except (ImportError, AttributeError):
    # pydantic.v1 shim unavailable on this install; legacy config is optional.
    pass

# Handle potential import errors with LangChain
try:
    from langchain_community.chat_message_histories import RedisChatMessageHistory
    from langchain_core.prompts import ChatPromptTemplate
except ImportError:
    pass  # Redis not available, will use database-only memory

    class RedisChatMessageHistory:
        def __init__(self, *args, **kwargs):
            raise ImportError("RedisChatMessageHistory could not be imported") from None

    class ChatPromptTemplate:
        def __init__(self, *args, **kwargs):
            raise ImportError("ChatPromptTemplate could not be imported") from None


from sqlalchemy.orm import Session as SQLAlchemySession

from src.main.service.llm.llm_manager import llm_manager
from src.main.utils.config.loader import get_model_config, get_resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

try:
    # noinspection PyUnresolvedReferences
    from src.main.config.database import get_db

    # Alias get_db as get_db_session for backward compatibility
    get_db_session = get_db
except ImportError as e:
    logger.error("Failed to import get_db: %s", str(e))
    get_db_session = None


class ChatMessageService:
    """
    Service for chat message utilities.

    Kotlin backend owns message and session persistence.
    This service provides:
    - Conversation title generation via LLM (used by GenerateTitle RPC)
    - Redis chat history access for LangChain memory integration
    """

    # Class-level storage for Redis histories
    chat_histories = {}

    @classmethod
    async def generate_conversation_title(
        cls,
        message_content: str,
        db: SQLAlchemySession,
        model_name: str = None,
        provider_type: str = None,
        user_id: str = None,
        subscription_tier: str = None,
        language: str = "en",
    ) -> str:
        """
        Generate a title for a new conversation based on the first user message.

        Args:
            message_content: The content of the user's first message
            db: Database session for LLM initialization
            model_name: Optional specific model to use for title generation
            provider_type: Optional specific provider to use for title generation
            user_id: Optional user ID for user-specific model lookup
            subscription_tier: Optional subscription tier for access control
            language: Language code for the generated title (default: "en")

        Returns:
            A generated title for the conversation
        """
        try:
            # Try to generate a title using the first message
            try:
                # Get the title generation template from config
                config = get_resolved_config()
                title_template = (
                    config.get("rag", {})
                    .get("prompt", {})
                    .get(
                        "template_generate_title",
                        "Given the following conversation message, generate a concise and "
                        "descriptive title (5 words maximum) "
                        "that captures the main topic or intent of the conversation.\n"
                        "Focus on keywords and the main subject. "
                        "Do not use quotes or markdown styles in the title, just plain text.\n\n"
                        "Message: {input}\n\n"
                        "Title:\n"
                        "Context: {context}",
                    )
                )

                # Add language instruction if not English
                if language and language != "en":
                    _lang_names = {"hr": "Croatian", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian"}
                    lang_name = _lang_names.get(language, language)
                    title_template = title_template.replace("Title:\n", f"IMPORTANT: Generate the title in {lang_name}.\n\nTitle:\n")

                # Create a prompt using the config template
                # noinspection PyUnresolvedReferences
                prompt = ChatPromptTemplate.from_messages([("human", title_template)])

                # Try to get the LLM using the cached manager
                try:
                    # Use the provided model / provider or fall back to the default configuration
                    if model_name and provider_type:
                        llm = await llm_manager.get_llm(
                            model_name=model_name,
                            provider_type=provider_type,
                            user_id=user_id,
                            subscription_tier=subscription_tier,
                        )
                    else:
                        # Get model configuration using the helper function
                        model_config = await get_model_config(model_type="chat", db=db)
                        logger.info("Using default model for title generation: %s (Provider: %s)", model_config["model"], model_config["provider"])

                        llm = await llm_manager.get_llm(
                            model_name=model_config["model"],
                            provider_type=model_config["provider"],
                            user_id=user_id,
                            subscription_tier=subscription_tier,
                        )
                except Exception as llm_init_error:
                    logger.warning("Error initializing LLM for title generation: %s", str(llm_init_error))
                    return f"New Conversation - {datetime.now(UTC).strftime('%Y-%m-%d %H:%M')}"

                if not llm:
                    logger.error("Failed to initialize LLM for title generation - get_llm returned None")
                    return f"New Conversation - {datetime.now(UTC).strftime('%Y-%m-%d %H:%M')}"

                # Format the prompt with the message using the correct keys from config template
                # The config template uses {input} and {context}, provide both
                formatted_prompt = prompt.format_messages(input=message_content, context="")

                # Generate the title using the LLM
                try:
                    logger.info("Invoking LLM for title generation")

                    # Add timeout for title generation to prevent hanging
                    from concurrent.futures import ThreadPoolExecutor
                    from concurrent.futures import TimeoutError as FutureTimeoutError

                    def invoke_llm_sync():
                        # Use input parameter for LangChain LLMs
                        return llm.invoke(input=formatted_prompt)

                    # Use ThreadPoolExecutor with timeout for LLM invocation
                    with ThreadPoolExecutor(max_workers=1) as executor:
                        try:
                            future = executor.submit(invoke_llm_sync)
                            response = future.result(timeout=120)  # 120 second timeout for thinking models
                        except FutureTimeoutError:
                            logger.warning("LLM invocation timed out after 120 seconds for title generation")
                            return f"New Conversation - {datetime.now(UTC).strftime('%Y-%m-%d %H:%M')}"

                    # Extract and clean the title
                    title = response.content.strip()

                    # Clean up HTML-like tags and unwanted formatting
                    # Remove HTML-like tags (e.g., </s>, <s>[USER], etc.)
                    title = re.sub(r"<[^>]*>", "", title)
                    # Remove square bracket content like [USER], [ASSISTANT]
                    title = re.sub(r"\[[^\]]*\]", "", title)
                    # Remove numbered list prefixes like "1. "
                    title = re.sub(r"^\d+\.\s*", "", title)
                    # Clean up extra whitespace
                    title = " ".join(title.split())

                    # Limit to 50 characters
                    if len(title) > 50:
                        title = title[:47] + "..."

                    # Fallback if title is empty after cleaning
                    if not title.strip():
                        title = f"New Conversation - {datetime.now(UTC).strftime('%Y-%m-%d %H:%M')}"

                    logger.info("Generated conversation title: %s", title)
                    return title
                except Exception as invoke_error:
                    logger.error("Error while invoking LLM: %s", str(invoke_error))
                    return f"New Conversation - {datetime.now(UTC).strftime('%Y-%m-%d %H:%M')}"
            except Exception as ex:
                logger.error("Error generating conversation title: %s", str(ex))
                return "New Conversation"
        except Exception as ex:
            logger.error("Error generating conversation title: %s", str(ex))
            return "New Conversation"

    @classmethod
    def get_chat_history_for_redis(cls, session_id: uuid.UUID, redis_url: str, ttl: int = 3600) -> RedisChatMessageHistory:
        """
        Get Redis chat history for a given history ID.

        Args:
            session_id: Chat history ID
            redis_url: Redis URL
            ttl: Time - to - live in seconds (default: 1 hour)

        Returns:
            RedisChatMessageHistory object
        """
        history_key = str(session_id)

        if history_key not in cls.chat_histories:
            cls.chat_histories[history_key] = RedisChatMessageHistory(session_id=history_key, url=redis_url, ttl=ttl)

        return cls.chat_histories[history_key]
