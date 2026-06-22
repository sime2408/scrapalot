"""OpenAI image generation adapter (DALL-E 3, gpt-image-1)."""

from __future__ import annotations

import base64
from typing import Literal

import aiohttp

from src.main.service.chat.image_generation.base import (
    GeneratedImage,
    ImageProviderError,
    ImageSize,
)
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_OPENAI_IMAGE_ENDPOINT = "https://api.openai.com/v1/images/generations"
_REQUEST_TIMEOUT_S = 120  # DALL-E HD 1792x1024 routinely takes 60s+
_PNG_MIME = "image/png"

# DALL-E 3 returns 1024x1024 / 1792x1024 / 1024x1792.
# gpt-image-1 also supports 1024x1536 / 1536x1024 portrait/landscape extras.
_SUPPORTED_SIZES: dict[str, frozenset[str]] = {
    "dall-e-3": frozenset({"1024x1024", "1024x1792", "1792x1024"}),
    "dall-e-2": frozenset({"256x256", "512x512", "1024x1024"}),
    "gpt-image-1": frozenset({"1024x1024", "1024x1536", "1536x1024"}),
}


class OpenAIImageProvider:
    """OpenAI ``/v1/images/generations`` adapter.

    Uses ``response_format=b64_json`` so the orchestrator never has to download
    a signed URL (which would expire 60 minutes later, breaking re-renders).
    """

    name = "openai"

    def __init__(self, api_key: str, model_name: str = "dall-e-3") -> None:
        if not api_key:
            raise ImageProviderError("OpenAIImageProvider requires an api_key.")
        self._api_key = api_key
        self.model_name = model_name

    async def generate(
        self,
        prompt: str,
        *,
        size: ImageSize = "1024x1024",
        n: int = 1,
        quality: Literal["standard", "hd"] = "standard",
    ) -> list[GeneratedImage]:
        self._validate_size(size)
        payload = self._build_payload(prompt=prompt, size=size, n=n, quality=quality)
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=_REQUEST_TIMEOUT_S),
            ) as session:
                async with session.post(_OPENAI_IMAGE_ENDPOINT, json=payload, headers=headers) as resp:
                    body = await resp.json()
                    if resp.status != 200:
                        msg = self._extract_error(body) or f"OpenAI image API returned {resp.status}"
                        raise ImageProviderError(msg)
                    return self._parse_response(body, size)
        except TimeoutError as e:
            raise ImageProviderError(f"OpenAI image generation timed out after {_REQUEST_TIMEOUT_S}s") from e
        except aiohttp.ClientError as e:
            raise ImageProviderError(f"OpenAI image generation transport error: {e}") from e

    def _build_payload(
        self,
        *,
        prompt: str,
        size: str,
        n: int,
        quality: str,
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "model": self.model_name,
            "prompt": prompt,
            "size": size,
            "n": n,
            "response_format": "b64_json",
        }
        # ``quality`` and ``hd`` are DALL-E-3-only; gpt-image-1 ignores or rejects.
        if self.model_name == "dall-e-3":
            payload["quality"] = quality
        return payload

    def _validate_size(self, size: str) -> None:
        allowed = _SUPPORTED_SIZES.get(self.model_name)
        if allowed and size not in allowed:
            raise ImageProviderError(
                f"Model {self.model_name} does not support size {size}; allowed: {sorted(allowed)}",
            )

    @staticmethod
    def _parse_response(body: dict, size: str) -> list[GeneratedImage]:
        data = body.get("data") or []
        if not data:
            raise ImageProviderError("OpenAI image API returned no data")
        width, _, height = size.partition("x")
        try:
            w, h = int(width), int(height)
        except ValueError as e:
            raise ImageProviderError(f"Invalid size string: {size}") from e
        out: list[GeneratedImage] = []
        for entry in data:
            b64 = entry.get("b64_json")
            if not b64:
                # If a deployment forgot response_format=b64_json the payload only
                # contains a URL — surface a clean error instead of crashing.
                raise ImageProviderError(
                    "OpenAI image API returned no b64_json (URL fallback not supported)",
                )
            try:
                img_bytes = base64.b64decode(b64)
            except (TypeError, ValueError) as e:
                raise ImageProviderError("Could not decode b64_json from OpenAI") from e
            out.append(
                GeneratedImage(
                    image_bytes=img_bytes,
                    mime_type=_PNG_MIME,
                    width=w,
                    height=h,
                    revised_prompt=entry.get("revised_prompt"),
                )
            )
        return out

    @staticmethod
    def _extract_error(body: dict) -> str | None:
        err = body.get("error") if isinstance(body, dict) else None
        if isinstance(err, dict):
            return err.get("message") or err.get("code")
        return None
