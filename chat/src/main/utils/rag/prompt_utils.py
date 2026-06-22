"""
Shared RAG prompt utilities for consistent prompt initialization across RAG strategies.
"""

from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

from src.main.utils.config.loader import resolved_prompts
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def get_default_rag_system_prompt() -> str:
    """
    Get the default RAG system prompt template from prompts.yaml.
    Falls back to a minimal hardcoded prompt only if prompts are unavailable.

    Returns:
        RAG system prompts string from prompts.yaml or fallback
    """
    # Try to load from prompts.yaml first
    try:
        template = resolved_prompts.get("rag_templates", {}).get("template_system")
        if template:
            return template
    except Exception as e:
        logger.debug("Could not load RAG system prompt from config: %s", e)

    # Minimal fallback if prompts are unavailable
    return """You are a helpful AI assistant that accurately answers queries based on the provided documents and your general knowledge.

### Context:
<context>
{context}
</context>
"""


def get_rag_system_prompt() -> str:
    """
    Get RAG system prompt from prompts.yaml with fallback to default.

    Returns:
        System prompt string from prompts.yaml or default
    """
    system_prompt = resolved_prompts.get("rag_templates", {}).get("template_system")
    if not system_prompt:
        system_prompt = get_default_rag_system_prompt()
    return system_prompt


def create_rag_prompt_template() -> ChatPromptTemplate:
    """
    Create a standard RAG prompt template with system prompt, chat history, and question.

    Returns:
        ChatPromptTemplate configured for RAG
    """
    system_prompt = get_rag_system_prompt()

    return ChatPromptTemplate.from_messages(
        [
            ("system", system_prompt),
            MessagesPlaceholder(variable_name="chat_history"),
            ("human", "{question}"),
        ]
    )


def create_simple_rag_prompt_template() -> ChatPromptTemplate:
    """
    Create a simple RAG prompt template without chat history.
    Used by most RAG strategies that don't need conversation context.

    Returns:
        ChatPromptTemplate with system prompt and question only
    """
    system_prompt = get_rag_system_prompt()

    return ChatPromptTemplate.from_messages(
        [
            ("system", system_prompt),
            ("human", "{question}"),
        ]
    )


def get_rag_system_prompt_with_bridge(bridge_prepend: str) -> str:
    """
    Layer 3 — return the standard RAG system prompt with the
    bridge-mode cross-domain guidance block prepended. Callers pass the
    formatted prepend string produced by
    `bridge_orchestrator.build_bridge_prompt_prepend()`; if that returned
    None, the caller should call `get_rag_system_prompt()` instead.
    """
    system_prompt = get_rag_system_prompt()
    if not bridge_prepend:
        return system_prompt
    return f"{bridge_prepend.rstrip()}\n\n{system_prompt}"


def create_rag_prompt_template_with_bridge(bridge_prepend: str) -> ChatPromptTemplate:
    """Companion to create_rag_prompt_template() that includes bridge guidance."""
    system_prompt = get_rag_system_prompt_with_bridge(bridge_prepend)
    return ChatPromptTemplate.from_messages(
        [
            ("system", system_prompt),
            MessagesPlaceholder(variable_name="chat_history"),
            ("human", "{question}"),
        ]
    )
