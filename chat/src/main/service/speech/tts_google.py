"""Google TTS provider (free, uses Google Translate TTS)."""

import io
from typing import Any

from src.main.service.speech.tts_base import BaseTTS
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class GoogleTTS(BaseTTS):
    """Text-to-Speech using Google Translate TTS (gTTS, free, no API key)."""

    async def synthesize(
        self,
        text: str,
        voice: str = "",
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> dict[str, Any]:
        try:
            from gtts import gTTS
        except ImportError as e:
            raise ImportError("gTTS is not installed. Install with: pip install gTTS") from e

        # Voice parameter maps to language for gTTS
        lang = voice if voice and len(voice) <= 5 else "en"

        logger.info("Google TTS: synthesizing %d chars, lang=%s", len(text), lang)

        tts = gTTS(text=text, lang=lang)
        buffer = io.BytesIO()
        tts.write_to_fp(buffer)
        audio_data = buffer.getvalue()

        return {
            "audio": audio_data,
            "word_boundaries": [],  # gTTS does not provide word boundaries
            "duration_ms": 0.0,  # Cannot determine without audio parsing
            "provider": "google",
        }
