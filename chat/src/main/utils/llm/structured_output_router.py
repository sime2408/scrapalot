"""
Structured Output Router — provider-aware schema enforcement for Pydantic AI agents.

Pydantic AI's ``output_type=PydanticModel`` is reliable on OpenAI / Anthropic / Google
native providers because Pydantic AI emits the right native artifact (function calling,
``response_format`` JSON-schema, or Google structured output). For OpenAI-compatible local
backends the underlying API surface differs and we must push provider-specific overrides
through ``extra_body``:

- Ollama (>= 0.5.0): ``extra_body={"format": <schema>}`` — strict schema enforcement.
- Ollama (< 0.5.0):  ``extra_body={"format": "json"}`` — broad JSON mode (no schema).
- vLLM:              ``extra_body={"guided_json": <schema>}`` triggers outlines / lm-format-enforcer.
- llamacpp:          ``extra_body={"json_schema": <schema>}`` (post-2024-09) or ``{"grammar": <gbnf>}``.
- LM Studio:         OpenAI-spec ``response_format`` works natively (Pydantic AI handles it).

For OpenAI / Anthropic / Google / LM Studio we return ``None`` so the caller passes nothing
extra to ``Agent(...)``. For everything else we return a ``ModelSettings`` whose ``extra_body``
holds the provider's grammar override.

Wire-up: call :func:`build_structured_output_settings` to compute the decision, or use
:func:`make_agent_with_structured_output` to build the ``Agent`` in one step.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.settings import ModelSettings

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

StructuredOutputMode = Literal[
    "native",
    "schema",
    "guided_json",
    "json_schema",
    "json_object",
    "prompt_only",
]

_NATIVELY_HANDLED = frozenset({"openai", "anthropic", "google", "lmstudio"})


class StructuredOutputDecision(TypedDict):
    """
    Result of routing an ``output_type`` to a provider's enforcement mechanism.

    ``mode`` is intended for logging / admin RAG-tracing observability.
    ``settings`` is what the caller merges into ``Agent(model_settings=...)``;
    when ``None`` no override is required (Pydantic AI handles it natively).
    """

    mode: StructuredOutputMode
    settings: ModelSettings | None


def _ollama_supports_schema(version: str | None) -> bool:
    """Ollama gained native ``format=<schema>`` enforcement in 0.5.0."""
    if not version:
        return False
    parts = version.lstrip("v").split(".")
    try:
        major = int(parts[0])
        minor = int(parts[1]) if len(parts) > 1 else 0
    except (ValueError, IndexError):
        return False
    return major >= 1 or (major == 0 and minor >= 5)


def build_structured_output_settings(
    provider_type: str,
    output_type: type[BaseModel] | type | None,
    provider_version: str | None = None,
) -> StructuredOutputDecision:
    """
    Decide which structured-output enforcement to apply for a given provider.

    Args:
        provider_type: Lower-cased provider name (``openai``, ``ollama``, ``vllm`` ...).
        output_type:   A Pydantic ``BaseModel`` subclass; ``None`` => no enforcement requested.
        provider_version: Provider semantic version string (e.g. ``"0.5.7"``). Used to gate
            Ollama's strict-schema mode.
    """
    if output_type is None:
        return {"mode": "native", "settings": None}

    provider = (provider_type or "").lower()

    if provider in _NATIVELY_HANDLED:
        return {"mode": "native", "settings": None}

    if not (isinstance(output_type, type) and issubclass(output_type, BaseModel)):
        return {"mode": "native", "settings": None}

    schema = output_type.model_json_schema()

    if provider == "ollama":
        if _ollama_supports_schema(provider_version):
            settings: ModelSettings = {"extra_body": {"format": schema}}
            return {"mode": "schema", "settings": settings}
        settings = {"extra_body": {"format": "json"}}
        return {"mode": "json_object", "settings": settings}

    if provider == "vllm":
        settings = {"extra_body": {"guided_json": schema}}
        return {"mode": "guided_json", "settings": settings}

    if provider == "llamacpp":
        settings = {"extra_body": {"json_schema": schema}}
        return {"mode": "json_schema", "settings": settings}

    logger.warning(
        "Unknown provider '%s' for structured output; falling back to {format: json}.",
        provider,
    )
    settings = {"extra_body": {"format": "json"}}
    return {"mode": "json_object", "settings": settings}


def _merge_model_settings(
    base: ModelSettings | dict[str, Any] | None,
    override: ModelSettings | None,
) -> ModelSettings | None:
    """
    Merge two ``ModelSettings`` dicts. ``override`` keys win, except ``extra_body`` is
    deep-merged when both sides are dicts so caller-supplied flags are preserved.
    """
    if not base and not override:
        return None
    merged: dict[str, Any] = dict(base or {})
    for key, value in (override or {}).items():
        if key == "extra_body":
            base_eb = merged.get("extra_body")
            if isinstance(base_eb, dict) and isinstance(value, dict):
                merged["extra_body"] = {**base_eb, **value}
            else:
                merged["extra_body"] = value
        else:
            merged[key] = value
    return merged  # type: ignore[return-value]


def make_agent_with_structured_output(
    model: Any,
    *,
    output_type: type[BaseModel] | type | None = None,
    provider_type: str | None = None,
    provider_version: str | None = None,
    model_settings: ModelSettings | dict[str, Any] | None = None,
    **agent_kwargs: Any,
) -> Agent:
    """
    Build a Pydantic AI ``Agent`` with provider-aware structured-output enforcement.

    Drop-in replacement for ``Agent(model, output_type=X, ...)``. When ``provider_type`` is
    omitted and ``model`` is a ``"provider:model"`` string, the prefix is used.

    Caller-supplied ``model_settings`` is preserved; provider-specific ``extra_body`` keys
    are deep-merged on top.
    """
    if provider_type is None and isinstance(model, str) and ":" in model:
        provider_type = model.split(":", 1)[0]

    decision = build_structured_output_settings(
        provider_type or "",
        output_type,
        provider_version,
    )

    final_settings = _merge_model_settings(model_settings, decision["settings"])
    if final_settings is not None:
        agent_kwargs["model_settings"] = final_settings

    if output_type is not None:
        agent_kwargs["output_type"] = output_type

    logger.debug(
        "Agent built with structured-output mode=%s provider=%s output_type=%s",
        decision["mode"],
        provider_type,
        getattr(output_type, "__name__", output_type),
    )

    return Agent(model, **agent_kwargs)
