"""Per-image cost lookup tests.

Pure unit tests — no DB / API / network. Verifies the published OpenAI rate
table and the free-tier provider behaviour for self-hosted backends.
"""

import pytest

from src.main.service.chat.image_generation.cost import cost_cents_per_image


@pytest.mark.parametrize(
    ("model", "size", "quality", "expected_cents"),
    [
        ("dall-e-3", "1024x1024", "standard", 4),
        ("dall-e-3", "1024x1792", "standard", 8),
        ("dall-e-3", "1792x1024", "standard", 8),
        ("dall-e-3", "1024x1024", "hd", 8),
        ("dall-e-3", "1024x1792", "hd", 12),
        ("dall-e-3", "1792x1024", "hd", 12),
        ("dall-e-2", "256x256", "standard", 2),
        ("dall-e-2", "512x512", "standard", 2),
        ("dall-e-2", "1024x1024", "standard", 2),
        ("gpt-image-1", "1024x1024", "standard", 4),
        ("gpt-image-1", "1024x1536", "standard", 6),
        ("gpt-image-1", "1536x1024", "standard", 6),
    ],
)
def test_openai_published_rates(model, size, quality, expected_cents) -> None:
    assert cost_cents_per_image(provider_type="openai", model_name=model, size=size, quality=quality) == expected_cents


def test_unknown_size_returns_none() -> None:
    # We never silently guess a price for an unpublished size; metrics layer
    # must leave cost_cents NULL rather than over-bill or under-bill.
    assert (
        cost_cents_per_image(
            provider_type="openai",
            model_name="dall-e-3",
            size="2048x2048",
            quality="standard",
        )
        is None
    )


def test_unknown_quality_returns_none() -> None:
    assert (
        cost_cents_per_image(
            provider_type="openai",
            model_name="dall-e-3",
            size="1024x1024",
            quality="ultra",
        )
        is None
    )


def test_case_insensitive_model_lookup() -> None:
    # OpenAI model names are case-insensitive in the catalogue; cost lookup must match.
    assert (
        cost_cents_per_image(
            provider_type="openai",
            model_name="DALL-E-3",
            size="1024x1024",
            quality="standard",
        )
        == 4
    )


@pytest.mark.parametrize("provider", ["stability", "flux", "ollama", "vllm", "llamacpp", "lmstudio"])
def test_self_hosted_providers_are_zero_cost(provider) -> None:
    # Self-hosted backends pay for GPU time, not per request.
    assert cost_cents_per_image(provider_type=provider, model_name="anything", size="1024x1024") == 0


def test_unknown_provider_returns_none() -> None:
    assert (
        cost_cents_per_image(
            provider_type="some-future-provider",
            model_name="x",
            size="1024x1024",
        )
        is None
    )
