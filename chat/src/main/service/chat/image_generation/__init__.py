"""Image generation providers and helpers.

Public surface:

- :class:`GeneratedImage`           — provider-agnostic dataclass for a single
                                       produced image (raw bytes + metadata).
- :class:`ImageProvider`            — Protocol every provider adapter implements.
- :class:`OpenAIImageProvider`      — DALL-E 3 / gpt-image-1 backend.

Future providers (Stability, Flux via fal.ai or Replicate) plug into the same
Protocol and are wired in :func:`build_image_provider`.
"""

from src.main.service.chat.image_generation.base import (
    GeneratedImage,
    ImageProvider,
    ImageProviderError,
)
from src.main.service.chat.image_generation.openai_provider import OpenAIImageProvider
from src.main.service.chat.image_generation.providers import build_image_provider

__all__ = (
    "GeneratedImage",
    "ImageProvider",
    "ImageProviderError",
    "OpenAIImageProvider",
    "build_image_provider",
)
