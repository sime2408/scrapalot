"""Abstract base class for Text-to-Speech providers."""

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Any


class BaseTTS(ABC):
    """Base class for TTS provider implementations."""

    @abstractmethod
    async def synthesize(
        self,
        text: str,
        voice: str = "",
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> dict[str, Any]:
        """Synthesize text to speech audio.

        Args:
            text: Text to synthesize.
            voice: Voice identifier (provider-specific).
            rate: Speech rate adjustment.
            pitch: Pitch adjustment.

        Returns:
            Dictionary with keys:
                - audio: bytes (raw audio data, MP3)
                - word_boundaries: list of dicts with text, offset, duration
                - duration_ms: float, total audio duration in ms
                - provider: str, provider name
        """

    async def synthesize_streaming(
        self,
        text: str,
        voice: str = "",
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> AsyncIterator[bytes]:
        """Stream raw audio bytes as the provider produces them.

        Default implementation falls back to one-shot ``synthesize`` and yields
        the whole result as a single chunk so providers without a true
        streaming surface still satisfy the contract. Real streaming providers
        (Edge-TTS, OpenAI ``stream_format=sse``) override this to yield chunks
        as soon as the upstream emits them.
        """
        result = await self.synthesize(text, voice=voice, rate=rate, pitch=pitch)
        audio = result.get("audio")
        if audio:
            yield audio
        # Make this an async generator regardless of whether audio was empty.
        if False:  # pragma: no cover — generator marker
            yield b""

    async def list_voices(self) -> list[dict[str, str]]:
        """List available voices. Override in subclasses that support it."""
        return []
