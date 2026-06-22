"""Per-image cost lookup.

DALL-E and gpt-image-1 charge a flat per-image rate that depends on size and
quality (HD costs 2x of standard). For self-hosted Stable Diffusion / Flux the
cost is approximated as zero — the operator pays for GPU time, not per request.

Returns cents (int) so the chat_message_attachments.cost_cents column can store
without floating-point quirks. ``None`` means we don't have a published rate
for the model and the metrics layer should leave the column NULL.
"""

from __future__ import annotations

# Cents per image — sourced from OpenAI public pricing as of 2026-04.
# See https://openai.com/api/pricing/ for the canonical numbers.
_OPENAI_RATES: dict[tuple[str, str, str], int] = {
    # (model, size, quality) -> cents per image
    ("dall-e-3", "1024x1024", "standard"): 4,
    ("dall-e-3", "1024x1792", "standard"): 8,
    ("dall-e-3", "1792x1024", "standard"): 8,
    ("dall-e-3", "1024x1024", "hd"): 8,
    ("dall-e-3", "1024x1792", "hd"): 12,
    ("dall-e-3", "1792x1024", "hd"): 12,
    ("dall-e-2", "256x256", "standard"): 2,
    ("dall-e-2", "512x512", "standard"): 2,
    ("dall-e-2", "1024x1024", "standard"): 2,
    ("gpt-image-1", "1024x1024", "standard"): 4,
    ("gpt-image-1", "1024x1536", "standard"): 6,
    ("gpt-image-1", "1536x1024", "standard"): 6,
}

_FREE_PROVIDERS = frozenset({"stability", "flux", "ollama", "vllm", "llamacpp", "lmstudio"})


def cost_cents_per_image(
    *,
    provider_type: str,
    model_name: str,
    size: str,
    quality: str = "standard",
) -> int | None:
    """Look up the per-image cost in cents.

    Returns ``None`` when the rate is unknown so callers can leave
    ``cost_cents`` NULL rather than guessing.
    """
    pt = (provider_type or "").lower()
    if pt in _FREE_PROVIDERS:
        return 0

    rate = _OPENAI_RATES.get((model_name.lower(), size, quality))
    return rate
