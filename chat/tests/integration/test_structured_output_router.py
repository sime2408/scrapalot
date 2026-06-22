"""Tests for the structured output router.

Pure unit tests — no DB, no LLM, no network. Validates that
``build_structured_output_settings`` and ``make_agent_with_structured_output``
produce the right ``ModelSettings.extra_body`` for each provider kind so that
local backends (Ollama, vLLM, llamacpp) get strict schema enforcement and
hosted ones (OpenAI / Anthropic / Google / LM Studio) defer to Pydantic AI's
native handling.
"""

from __future__ import annotations

from pydantic import BaseModel
import pytest

from src.main.utils.llm.structured_output_router import (
    StructuredOutputDecision,
    build_structured_output_settings,
    make_agent_with_structured_output,
)


class _Sample(BaseModel):
    intent: str
    score: int


# ---------------------------------------------------------------------------
# build_structured_output_settings
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("provider", ["openai", "anthropic", "google", "lmstudio"])
def test_native_providers_return_no_settings(provider: str) -> None:
    decision: StructuredOutputDecision = build_structured_output_settings(provider, _Sample)
    assert decision["mode"] == "native"
    assert decision["settings"] is None


def test_none_output_type_is_native_regardless_of_provider() -> None:
    decision = build_structured_output_settings("vllm", None)
    assert decision["mode"] == "native"
    assert decision["settings"] is None


def test_non_basemodel_output_type_is_native() -> None:
    # A bare ``str`` output_type doesn't need provider-specific enforcement;
    # callers like the synthesis agent rely on free-form text.
    decision = build_structured_output_settings("vllm", str)
    assert decision["mode"] == "native"
    assert decision["settings"] is None


def test_vllm_emits_guided_json() -> None:
    decision = build_structured_output_settings("vllm", _Sample)
    assert decision["mode"] == "guided_json"
    settings = decision["settings"]
    assert settings is not None
    extra_body = settings["extra_body"]
    assert "guided_json" in extra_body
    schema = extra_body["guided_json"]
    assert schema["title"] == "_Sample"
    assert "intent" in schema["properties"]


def test_llamacpp_emits_json_schema() -> None:
    decision = build_structured_output_settings("llamacpp", _Sample)
    assert decision["mode"] == "json_schema"
    settings = decision["settings"]
    assert settings is not None
    assert "json_schema" in settings["extra_body"]


def test_unknown_provider_falls_back_to_json_object() -> None:
    decision = build_structured_output_settings("totally-made-up", _Sample)
    assert decision["mode"] == "json_object"
    settings = decision["settings"]
    assert settings is not None
    assert settings["extra_body"] == {"format": "json"}


# ---------------------------------------------------------------------------
# Ollama version gating
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("version", "expected_mode"),
    [
        (None, "json_object"),
        ("", "json_object"),
        ("0.4.7", "json_object"),
        ("0.5.0", "schema"),
        ("0.5.7", "schema"),
        ("0.10.0", "schema"),
        ("1.2.3", "schema"),
        ("v0.5.10", "schema"),
        ("not-a-version", "json_object"),
    ],
)
def test_ollama_version_gates_schema_mode(version: str | None, expected_mode: str) -> None:
    decision = build_structured_output_settings("ollama", _Sample, provider_version=version)
    assert decision["mode"] == expected_mode

    settings = decision["settings"]
    assert settings is not None
    extra_body = settings["extra_body"]
    if expected_mode == "schema":
        # Native Ollama format=<schema> — extra_body.format is the JSON schema dict.
        assert isinstance(extra_body["format"], dict)
        assert extra_body["format"]["title"] == "_Sample"
    else:
        # Pre-0.5 fallback: broad json mode.
        assert extra_body == {"format": "json"}


# ---------------------------------------------------------------------------
# make_agent_with_structured_output
# ---------------------------------------------------------------------------


def test_make_agent_derives_provider_from_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    # When the caller passes a ``provider:model`` string for a Pydantic AI native
    # provider (openai / anthropic / google / ollama) the prefix should be enough
    # to short-circuit to mode=native (no model_settings injected).
    monkeypatch.setenv("OPENAI_API_KEY", "test-only")
    agent = make_agent_with_structured_output(
        "openai:gpt-4o-mini",
        output_type=_Sample,
        system_prompt="x",
    )
    # OpenAI is natively handled — no extra_body schema override needed.
    assert agent.model_settings is None


def test_make_agent_merges_user_and_provider_extra_body(monkeypatch: pytest.MonkeyPatch) -> None:
    # Caller-supplied keep_alive must survive provider-side schema injection.
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:11434")
    agent = make_agent_with_structured_output(
        "ollama:llama3:8b",
        output_type=_Sample,
        provider_version="0.5.7",
        model_settings={"temperature": 0.2, "extra_body": {"keep_alive": "5m"}},
        system_prompt="x",
    )
    settings = agent.model_settings
    assert settings is not None
    assert settings["temperature"] == 0.2
    assert settings["extra_body"]["keep_alive"] == "5m"
    assert isinstance(settings["extra_body"]["format"], dict)


def test_make_agent_no_output_type_attaches_no_settings() -> None:
    agent = make_agent_with_structured_output(
        "openai:gpt-4o-mini",
        provider_type="openai",
        system_prompt="x",
    )
    # No structured output requested + native provider => no model_settings override.
    assert agent.model_settings is None


def test_make_agent_explicit_provider_overrides_prefix() -> None:
    # The caller wires Ollama via the OpenAIChatModel wrapper using ``openai:``
    # prefix but supplies ``provider_type="ollama"`` so the router still gates
    # on Ollama's grammar API.
    agent = make_agent_with_structured_output(
        "openai:llama3:8b",
        output_type=_Sample,
        provider_type="ollama",
        provider_version="0.5.7",
        system_prompt="x",
    )
    settings = agent.model_settings
    assert settings is not None
    assert isinstance(settings["extra_body"]["format"], dict)
