"""
LLM streaming utilities.

Handles streaming chunks from chat models and separates user-facing
content from inner thoughts / reasoning. Supports several model
families' thinking-tag formats:

* OpenRouter reasoning field (``additional_kwargs['reasoning']`` and
  ``choices[0].delta.reasoning``)
* GPT-OSS Harmony tags (``analysis`` / ``assistantfinal``)
* DeepSeek R1 reasoning prose patterns

Reasoning content is emitted as ``reasoning_delta`` packets so the UI can
render it in a collapsed pane. The final user-facing answer is emitted as
``message_delta`` packets.

Also exports :func:`token_metrics_to_dict` for converting a
``TokenMetrics`` dataclass into JSON-friendly dicts.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Inner-thought detection (DeepSeek R1 and similar)
# ---------------------------------------------------------------------------

_INNER_THOUGHT_STARTERS: tuple[str, ...] = (
    "we need to",
    "let me think",
    "i need to",
    "first, i",
    "let's analyze",
    "to solve this",
    "the user is asking",
    "this question",
    "i should",
    "let's break",
    "step by step",
    "thinking about",
    "considering",
    "analyzing",
    "generated conversation title:",
    "analysiswe need to produce",
    "we need to produce a concise",
)


def _is_inner_thought_content(content: str) -> bool:
    """Heuristic: ``True`` when ``content`` looks like reasoning prose."""
    if not content or not content.strip():
        return False
    lowered = content.lower().strip()
    return any(lowered.startswith(p) for p in _INNER_THOUGHT_STARTERS)


# ---------------------------------------------------------------------------
# Token metrics
# ---------------------------------------------------------------------------


def token_metrics_to_dict(metrics: Any, include_timestamp: bool = False) -> dict[str, Any]:
    """Convert a ``TokenMetrics`` dataclass to a JSON-friendly dict."""
    result = {
        "tokens_per_second": metrics.tokens_per_second,
        "total_tokens": metrics.total_tokens,
        "input_tokens": metrics.input_tokens,
        "output_tokens": metrics.output_tokens,
        "cost_usd": metrics.cost_usd,
        "latency_ms": metrics.latency_ms,
        "provider": metrics.provider,
        "model": metrics.model,
        "time_to_first_token": metrics.time_to_first_token,
    }
    if include_timestamp:
        result["timestamp"] = datetime.now(UTC).isoformat()
    return result


# ---------------------------------------------------------------------------
# Reasoning-aware streaming
# ---------------------------------------------------------------------------


def _extract_reasoning(chunk: Any) -> str | None:
    """Probe ``chunk`` for an OpenRouter/LangChain/DeepSeek reasoning field.

    DeepSeek thinking models (OpenAI-compatible) stream the chain-of-thought in a
    separate ``reasoning_content`` field — distinct from OpenRouter's ``reasoning``
    — so both keys are probed at every location.
    """
    additional = getattr(chunk, "additional_kwargs", None)
    if additional:
        if additional.get("reasoning_content"):
            return additional["reasoning_content"]
        if "reasoning" in additional:
            return additional["reasoning"]
        choices = additional.get("choices") if isinstance(additional, dict) else None
        if choices:
            delta = choices[0].get("delta", {}) if isinstance(choices[0], dict) else {}
            if delta.get("reasoning_content"):
                return delta["reasoning_content"]
            if delta.get("reasoning"):
                return delta["reasoning"]

    response_metadata = getattr(chunk, "response_metadata", None)
    if response_metadata:
        if response_metadata.get("reasoning_content"):
            return response_metadata["reasoning_content"]
        if "reasoning" in response_metadata:
            return response_metadata["reasoning"]

    direct = getattr(chunk, "reasoning_content", None) or getattr(chunk, "reasoning", None)
    if direct:
        return direct

    choices_attr = getattr(chunk, "choices", None)
    if choices_attr:
        choice = choices_attr[0]
        delta = getattr(choice, "delta", None)
        if delta and (getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)):
            return getattr(delta, "reasoning_content", None) or delta.reasoning

    if isinstance(chunk, dict):
        if chunk.get("reasoning_content"):
            return chunk["reasoning_content"]
        if chunk.get("reasoning"):
            return chunk["reasoning"]
        choices_dict = chunk.get("choices") or []
        if choices_dict:
            delta = choices_dict[0].get("delta", {})
            if delta.get("reasoning_content"):
                return delta["reasoning_content"]
            if delta.get("reasoning"):
                return delta["reasoning"]

    return None


async def handle_streaming_with_type(
    stream_iterator,
    emitter,  # PacketEmitter instance
    provider_type: str | None = None,
) -> AsyncIterator[str]:
    """Stream LLM responses through ``emitter``, filtering reasoning content.

    Yields JSON packet strings (``message_delta`` for user text,
    ``reasoning_delta`` for thinking content, ``error`` on failure).
    """
    try:
        async for packet in _handle_reasoning_stream(stream_iterator, emitter, provider_type):
            yield packet
    except Exception as e:
        logger.error("Error in stream iterator: %s", str(e))
        from src.main.constants.error_codes import ErrorCode

        yield emitter.emit_error(
            f"Error processing response stream: {e!s}",
            error_code=ErrorCode.PROCESS_FAILED.value,
        )


async def _handle_reasoning_stream(
    stream_iterator,
    emitter,
    provider_type: str | None = None,
) -> AsyncIterator[str]:
    """Inner workhorse for ``handle_streaming_with_type`` (kept separate for clarity)."""
    in_analysis_mode = False
    waiting_for_assistant_final = False
    _logged_structure = False
    _logged_content = False

    try:
        async for chunk in stream_iterator:
            try:
                if not _logged_structure:
                    chunk_attrs: list[str] = []
                    if hasattr(chunk, "__dict__"):
                        chunk_attrs = list(chunk.__dict__.keys())
                    elif hasattr(chunk, "__slots__"):
                        chunk_attrs = list(chunk.__slots__)
                    logger.debug(
                        "Reasoning model chunk type: %s, attributes: %s, provider: %s",
                        type(chunk).__name__,
                        chunk_attrs,
                        provider_type,
                    )
                    _logged_structure = True

                reasoning_content = _extract_reasoning(chunk)
                if reasoning_content:
                    yield emitter.emit_reasoning_delta(reasoning_content, streamed=True)

                content = getattr(chunk, "content", None)
                if content and not _logged_content:
                    logger.debug("Extracted content from chunk: %s...", str(content)[:50])
                    _logged_content = True

                if not content:
                    continue

                # GPT-OSS "analysis" — start of internal reasoning we hide.
                if "analysis" in content:
                    parts = content.split("analysis", 1)
                    if len(parts) == 2:
                        if parts[0].strip():
                            yield emitter.emit_message_delta(parts[0])
                        in_analysis_mode = True
                        waiting_for_assistant_final = True
                        continue

                # GPT-OSS "assistantfinal" — start of user-facing response.
                if "assistantfinal" in content:
                    parts = content.split("assistantfinal", 1)
                    if len(parts) == 2:
                        in_analysis_mode = False
                        waiting_for_assistant_final = False
                        user_content = parts[1]
                        if user_content.strip():
                            yield emitter.emit_message_delta(user_content)
                        continue

                if _is_inner_thought_content(str(content)):
                    # DeepSeek R1 reasoning prose — skip entirely.
                    continue

                if in_analysis_mode or waiting_for_assistant_final:
                    # Still inside hidden reasoning section.
                    continue

                yield emitter.emit_message_delta(content)

            except Exception as chunk_error:
                logger.error("Error processing reasoning model chunk: %s", str(chunk_error))
                continue

    except Exception as e:
        logger.error("Error in reasoning model stream iterator: %s", str(e))
        from src.main.constants.error_codes import ErrorCode

        yield emitter.emit_error(
            f"Error processing reasoning model stream: {e!s}",
            error_code=ErrorCode.PROCESS_FAILED.value,
        )
