"""Provider factory — picks the right :class:`ImageProvider` for a given model.

Discovery flow:

1. Caller supplies an explicit ``provider_type`` and ``model_name`` (from the
   user's selected provider in ``model_providers``).
2. We look up the API key from that provider row.
3. We instantiate the matching adapter (currently OpenAI; Stability and Flux
   are planned follow-ups).

Adapters refuse to instantiate without an API key — fail fast at the boundary
so the orchestrator can emit a clean ``error`` packet instead of crashing
mid-stream.
"""

from __future__ import annotations

from src.main.service.chat.image_generation.base import ImageProvider, ImageProviderError
from src.main.service.chat.image_generation.openai_provider import OpenAIImageProvider
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def build_image_provider(
    provider_type: str,
    model_name: str,
    api_key: str | None,
) -> ImageProvider:
    """Resolve an :class:`ImageProvider` for a configured model.

    Raises :class:`ImageProviderError` if the provider is unsupported, missing
    credentials, or the model name is not part of the provider's catalogue.
    """
    pt = (provider_type or "").lower()

    if pt == "openai":
        if not api_key:
            raise ImageProviderError("OpenAI image generation requires an API key.")
        if not _is_openai_image_model(model_name):
            raise ImageProviderError(
                f"Model {model_name!r} is not an OpenAI image model (expected dall-e-2 / dall-e-3 / gpt-image-1).",
            )
        return OpenAIImageProvider(api_key=api_key, model_name=model_name)

    raise ImageProviderError(
        f"No image-generation adapter registered for provider {provider_type!r}. Stability and Flux providers are planned.",
    )


def _is_openai_image_model(model_name: str) -> bool:
    n = (model_name or "").lower()
    return n.startswith(("dall-e-2", "dall-e-3", "gpt-image"))
