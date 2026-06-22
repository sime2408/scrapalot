"""Image generation orchestrator.

Coordinates: provider lookup → optional content moderation → upstream image
synthesis → on-disk persistence. Returns a list of :class:`PersistedImage`
records the gRPC layer (M3) wraps in ``ImageAttachedPacket`` packets and the
chat persistence layer turns into ``chat_message_attachments`` rows.

This module deliberately stops short of the streaming/gRPC plumbing and the
chat_message_attachments INSERT — those responsibilities live in M3 and the
Kotlin gRPC handler respectively. Keeping the orchestrator framework-agnostic
makes it equally usable from a future REST endpoint or a notebook.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
import re
from typing import Literal
from uuid import UUID

import aiofiles
import aiohttp

from src.main.service.chat.image_generation.base import (
    GeneratedImage,
    ImageProvider,
    ImageProviderError,
    ImageSize,
)
from src.main.service.chat.image_generation.cost import cost_cents_per_image
from src.main.service.chat.image_generation.providers import build_image_provider
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# Resolves to /app/data/generated/images inside the container; on the host this
# is the ``scrapalot_data`` Docker volume so artifacts survive container restarts.
_DATA_ROOT = os.environ.get("SCRAPALOT_DATA_ROOT", "/app/data")
_IMAGE_SUBDIR = "generated/images"

_MODERATION_ENDPOINT = "https://api.openai.com/v1/moderations"
_MODERATION_TIMEOUT_S = 10
_MODERATION_MODEL = "omni-moderation-latest"


@dataclass(frozen=True)
class PersistedImage:
    """A :class:`GeneratedImage` after persistence.

    ``storage_path`` is the relative-to-``data/`` path that goes into
    ``chat_message_attachments.storage_path``; it never carries the
    ``/app/data/`` prefix so the same row is portable across host volumes.
    """

    storage_path: str
    mime_type: str
    width: int
    height: int
    prompt: str
    revised_prompt: str | None
    model_name: str
    idx: int
    cost_cents: int | None = None


class ContentModerationBlocked(ImageProviderError):
    """Raised when the upstream moderation endpoint flags the prompt."""


class ImageGenerationOrchestrator:
    """High-level entry point for image generation."""

    def __init__(
        self,
        *,
        data_root: str | None = None,
        moderation_api_key: str | None = None,
        moderation_enabled: bool = True,
    ) -> None:
        self._data_root = data_root or _DATA_ROOT
        self._moderation_api_key = moderation_api_key
        self._moderation_enabled = moderation_enabled

    async def generate(
        self,
        *,
        prompt: str,
        user_id: UUID | str,
        message_id: UUID | str,
        provider_type: str,
        model_name: str,
        api_key: str | None,
        size: ImageSize = "1024x1024",
        n: int = 1,
        quality: Literal["standard", "hd"] = "standard",
    ) -> list[PersistedImage]:
        """Run the full pipeline. Raises :class:`ImageProviderError` on failure."""
        if not prompt or not prompt.strip():
            raise ImageProviderError("Prompt must not be empty")
        if n < 1 or n > 4:
            raise ImageProviderError("n must be between 1 and 4")

        if self._moderation_enabled:
            await self._moderate(prompt)

        provider = build_image_provider(provider_type=provider_type, model_name=model_name, api_key=api_key)
        images = await provider.generate(prompt, size=size, n=n, quality=quality)

        cost_cents = cost_cents_per_image(
            provider_type=provider_type,
            model_name=provider.model_name,
            size=size,
            quality=quality,
        )

        return await self._persist_all(
            images=images,
            user_id=str(user_id),
            message_id=str(message_id),
            prompt=prompt,
            provider=provider,
            cost_cents=cost_cents,
        )

    # ------------------------------------------------------------------ #
    # Moderation
    # ------------------------------------------------------------------ #

    async def _moderate(self, prompt: str) -> None:
        """Call OpenAI's moderation endpoint; raise if any category fires.

        No-op when no moderation API key is configured. Network failures fall
        through (we don't block image generation on a moderation outage).
        """
        if not self._moderation_api_key:
            logger.debug("Skipping moderation — no api_key configured")
            return

        headers = {
            "Authorization": f"Bearer {self._moderation_api_key}",
            "Content-Type": "application/json",
        }
        body = {"model": _MODERATION_MODEL, "input": prompt}

        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=_MODERATION_TIMEOUT_S),
            ) as session:
                async with session.post(_MODERATION_ENDPOINT, json=body, headers=headers) as resp:
                    if resp.status != 200:
                        logger.warning("Moderation API returned %s — allowing prompt", resp.status)
                        return
                    payload = await resp.json()
        except (aiohttp.ClientError, TimeoutError) as e:
            logger.warning("Moderation API unreachable (%s) — allowing prompt", e)
            return

        results = payload.get("results", [])
        if results and results[0].get("flagged"):
            categories = [k for k, v in (results[0].get("categories") or {}).items() if v]
            raise ContentModerationBlocked(
                f"Prompt blocked by content moderation: {', '.join(categories) or 'unknown'}",
            )

    # ------------------------------------------------------------------ #
    # Persistence
    # ------------------------------------------------------------------ #

    async def _persist_all(
        self,
        *,
        images: list[GeneratedImage],
        user_id: str,
        message_id: str,
        prompt: str,
        provider: ImageProvider,
        cost_cents: int | None,
    ) -> list[PersistedImage]:
        target_dir = os.path.join(self._data_root, _IMAGE_SUBDIR, user_id)
        os.makedirs(target_dir, exist_ok=True)

        persisted: list[PersistedImage] = []
        for idx, image in enumerate(images):
            ext = self._extension_for(image.mime_type)
            filename = f"{message_id}_{idx}{ext}"
            abs_path = os.path.join(target_dir, filename)

            async with aiofiles.open(abs_path, "wb") as f:
                await f.write(image.image_bytes)

            relative = os.path.join(_IMAGE_SUBDIR, user_id, filename)
            persisted.append(
                PersistedImage(
                    storage_path=relative,
                    mime_type=image.mime_type,
                    width=image.width,
                    height=image.height,
                    prompt=prompt,
                    revised_prompt=image.revised_prompt,
                    model_name=provider.model_name,
                    idx=idx,
                    cost_cents=cost_cents,
                )
            )
            logger.info(
                "Persisted generated image idx=%d path=%s bytes=%d",
                idx,
                relative,
                len(image.image_bytes),
            )

        return persisted

    @staticmethod
    def _extension_for(mime_type: str) -> str:
        mapping = {
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/webp": ".webp",
            "image/gif": ".gif",
        }
        return mapping.get(mime_type, "") or _guess_ext_from_mime(mime_type)


def _guess_ext_from_mime(mime: str) -> str:
    # Cheap fallback so an exotic MIME doesn't end up extension-less on disk.
    match = re.match(r"image/([a-z0-9]+)", mime)
    if match:
        return f".{match.group(1)}"
    return ".bin"
