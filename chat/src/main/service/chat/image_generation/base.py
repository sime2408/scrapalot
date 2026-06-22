"""Provider-agnostic types for image generation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable

ImageSize = Literal[
    "256x256",
    "512x512",
    "1024x1024",
    "1024x1536",
    "1536x1024",
    "1024x1792",
    "1792x1024",
]


class ImageProviderError(Exception):
    """Raised when an upstream image API rejects, times out, or returns malformed data."""


@dataclass(frozen=True)
class GeneratedImage:
    """A single image produced by an upstream provider.

    Always carries the raw bytes (not a URL) so the orchestrator can persist
    it locally without an extra round-trip and without leaking the upstream
    URL into the chat history (signed URLs expire).
    """

    image_bytes: bytes
    mime_type: str  # "image/png", "image/jpeg", "image/webp"
    width: int
    height: int
    revised_prompt: str | None = None  # DALL-E silently rewrites the prompt; capture it.


@runtime_checkable
class ImageProvider(Protocol):
    """Adapter contract for an upstream image-generation API.

    Each adapter must convert the upstream's response shape into a uniform list
    of :class:`GeneratedImage`. Failure modes (rate limit, content moderation
    block, bad credentials, ...) surface as :class:`ImageProviderError` so the
    orchestrator can map them to a user-visible error packet.
    """

    name: str  # human-readable identifier ("openai", "stability", "flux")
    model_name: str  # the actual upstream model ("dall-e-3", "gpt-image-1", ...)

    async def generate(
        self,
        prompt: str,
        *,
        size: ImageSize = "1024x1024",
        n: int = 1,
        quality: Literal["standard", "hd"] = "standard",
    ) -> list[GeneratedImage]:
        """Produce ``n`` images for ``prompt`` and return them as raw bytes."""
        ...
