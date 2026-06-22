"""Edge TTS provider (Microsoft, free, no API key required)."""

from collections.abc import AsyncIterator
from typing import Any

from src.main.service.speech.tts_base import BaseTTS
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class EdgeTTS(BaseTTS):
    """Text-to-Speech using Microsoft Edge TTS (free, high-quality)."""

    async def synthesize(
        self,
        text: str,
        voice: str = "",
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> dict[str, Any]:
        import edge_tts

        voice = voice or "en-US-AriaNeural"

        # edge-tts 7.x defaults `boundary` to 'SentenceBoundary' — without this
        # override the service emits sentence-level events only, never
        # WordBoundary, so the frontend's per-word highlight tracker sees 0
        # boundaries and freezes on the first block regardless of voice/language.
        communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, boundary="WordBoundary")
        audio_chunks = []
        word_boundaries = []

        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_chunks.append(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                word_boundaries.append(
                    {
                        "text": chunk.get("text", ""),
                        "offset": chunk.get("offset", 0),
                        "duration": chunk.get("duration", 0),
                    }
                )

        audio_data = b"".join(audio_chunks)

        duration_ms = 0.0
        if word_boundaries:
            last = word_boundaries[-1]
            duration_ms = (last["offset"] + last["duration"]) / 10000.0

        return {
            "audio": audio_data,
            "word_boundaries": word_boundaries,
            "duration_ms": duration_ms,
            "provider": "edge",
        }

    async def synthesize_streaming(
        self,
        text: str,
        voice: str = "",
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> AsyncIterator[bytes]:
        """Stream MP3 audio chunks as Edge-TTS produces them.

        ``edge_tts.Communicate.stream()`` already yields chunks
        asynchronously; the regular ``synthesize`` path accumulates them.
        For voice mode we want to forward each chunk to the browser the
        moment it arrives so the assistant starts speaking before the full
        sentence has finished synthesising.
        """
        import edge_tts

        voice = voice or "en-US-AriaNeural"
        # WordBoundary on the streaming path too — kept symmetric with the
        # one-shot ``synthesize`` so the per-word highlight tracker on the
        # frontend can reuse its existing parser.
        communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, boundary="WordBoundary")

        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                data = chunk.get("data")
                if data:
                    yield data

    async def list_voices(self) -> list[dict[str, str]]:
        import edge_tts

        voices = await edge_tts.list_voices()
        return [
            {
                "name": v.get("ShortName", ""),
                "display_name": v.get("FriendlyName", ""),
                "locale": v.get("Locale", ""),
                "gender": v.get("Gender", ""),
                "language": v.get("Locale", "").split("-")[0].upper() if v.get("Locale") else "",
            }
            for v in voices
        ]
