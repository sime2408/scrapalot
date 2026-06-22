"""
Conversation Context Utilities.

Provides unified context building for LLM calls across all chat handlers.
Combines conversation summary + recent exchange + RAG context.
"""

from typing import Any

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def format_message_for_context(message: Any) -> str:
    """
    Format a single message for context display.

    Args:
        message: LangChain message object (HumanMessage, AIMessage, etc.)

    Returns:
        Formatted string like "User: message content" or "Assistant: message content"
    """
    content = getattr(message, "content", str(message))
    msg_type = getattr(message.__class__, "__name__", "Message")

    if "Human" in msg_type or "User" in msg_type:
        return f"User: {content}"
    elif "AI" in msg_type or "Assistant" in msg_type:
        return f"Assistant: {content}"
    else:
        return f"System: {content}"


def format_recent_exchange(messages: list[Any], max_messages: int = 4) -> str:
    """
    Format recent messages into a readable exchange.

    Args:
        messages: List of LangChain messages (last N messages)
        max_messages: Maximum messages to include (default 4 = 2 exchanges)

    Returns:
        Formatted string of recent conversation
    """
    if not messages:
        return ""

    # Take only the last max_messages
    recent = messages[-max_messages:] if len(messages) > max_messages else messages

    formatted = []
    for msg in recent:
        formatted.append(format_message_for_context(msg))

    return "\n".join(formatted)


def build_llm_context(
    conversation_summary: str | None = None,
    recent_messages: list[Any] | None = None,
    rag_context: str | None = None,
    max_recent_messages: int = 4,
    use_template: bool = True,
) -> str:
    """
    Build unified context for LLM calls.

    Combines:
    - Conversation summary (compressed history)
    - Recent exchange (last 2-4 messages for immediate context)
    - RAG context (retrieved documents/chunks)

    Args:
        conversation_summary: Summary of earlier conversation
        recent_messages: Recent messages (typically last 2-4)
        rag_context: Retrieved document context
        max_recent_messages: Max messages to include in recent exchange
        use_template: Whether to use the template from prompts.yaml

    Returns:
        Formatted context string ready for LLM
    """
    parts = []

    # Format recent exchange
    recent_exchange = ""
    if recent_messages:
        recent_exchange = format_recent_exchange(recent_messages, max_recent_messages)

    if use_template:
        # Use template from prompts.yaml
        # Only include sections that have content
        formatted_parts = []

        if conversation_summary and conversation_summary.strip():
            formatted_parts.append(f"### Previous Conversation Context:\n{conversation_summary}")

        if recent_exchange and recent_exchange.strip():
            formatted_parts.append(f"### Recent Exchange:\n{recent_exchange}")

        if rag_context and rag_context.strip():
            formatted_parts.append(f"### Retrieved Information:\n{rag_context}")

        return "\n\n".join(formatted_parts)
    else:
        # Simple concatenation without template
        if conversation_summary and conversation_summary.strip():
            parts.append(f"Previous context: {conversation_summary}")

        if recent_exchange and recent_exchange.strip():
            parts.append(f"Recent exchange:\n{recent_exchange}")

        if rag_context and rag_context.strip():
            parts.append(f"Retrieved information:\n{rag_context}")

        return "\n\n".join(parts)


def build_context_from_memory(
    memory: Any,
    rag_context: str | None = None,
    max_recent_messages: int = 4,
) -> dict[str, Any]:
    """
    Build context from a DatabaseOnlyMemory instance.

    This is the main entry point for chat handlers.

    Args:
        memory: DatabaseOnlyMemory or compatible memory instance
        rag_context: Retrieved document context (optional)
        max_recent_messages: Max messages for recent exchange

    Returns:
        Dict with:
        - 'formatted_context': Ready-to-use context string
        - 'summary': The conversation summary
        - 'recent_messages': The recent messages
        - 'has_summary': Whether a summary exists
    """
    # Get context using memory's method
    ctx = memory.get_context_for_llm()

    summary = ctx.get("summary", "")
    has_summary = ctx.get("has_summary", False)

    # Use last_exchange if available, otherwise fall back to full_messages
    if ctx.get("last_exchange"):
        recent_messages = ctx["last_exchange"]
    else:
        # Fall back to last N messages from full_messages
        full_messages = ctx.get("full_messages", [])
        recent_messages = full_messages[-max_recent_messages:] if full_messages else []

    # Build formatted context
    formatted_context = build_llm_context(
        conversation_summary=summary if has_summary else None,
        recent_messages=recent_messages,
        rag_context=rag_context,
        max_recent_messages=max_recent_messages,
    )

    return {
        "formatted_context": formatted_context,
        "summary": summary,
        "recent_messages": recent_messages,
        "has_summary": has_summary,
        "rag_context": rag_context,
    }


def get_conversation_text_for_summarization(messages: list[Any], max_messages: int = 10) -> str:
    """
    Format messages into text suitable for LLM summarization.

    Args:
        messages: List of LangChain messages to summarize
        max_messages: Maximum messages to include

    Returns:
        Formatted conversation text
    """
    if not messages:
        return ""

    # Take messages to summarize (excluding the most recent ones that we keep)
    to_summarize = messages[:max_messages] if len(messages) > max_messages else messages

    formatted = []
    for msg in to_summarize:
        formatted.append(format_message_for_context(msg))

    return "\n".join(formatted)
