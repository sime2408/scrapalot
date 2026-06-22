"""ElevenLabs TTS provider (high-quality, requires API key)."""

import io
from typing import Any

from src.main.service.speech.tts_base import BaseTTS
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class ElevenLabsTTS(BaseTTS):
    """Text-to-Speech using ElevenLabs API."""

    def __init__(
        self,
        api_key: str,
        voice_id: str = "nPczCjzI2devNBz1zQrb",
        model: str = "eleven_multilingual_v2",
    ):
        self._api_key = api_key
        self._voice_id = voice_id
        self._model = model

    async def synthesize(
        self,
        text: str,
        voice: str = "",
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> dict[str, Any]:
        try:
            from elevenlabs.client import ElevenLabs
        except ImportError as e:
            raise ImportError("elevenlabs is not installed. Install with: pip install elevenlabs") from e

        voice_id = voice if voice else self._voice_id

        logger.info(
            "ElevenLabs TTS: synthesizing %d chars, voice=%s, model=%s",
            len(text),
            voice_id,
            self._model,
        )

        client = ElevenLabs(api_key=self._api_key)

        audio_iter = client.text_to_speech.convert(
            text=text,
            voice_id=voice_id,
            model_id=self._model,
            output_format="mp3_44100_128",
        )

        buffer = io.BytesIO()
        for chunk in audio_iter:
            buffer.write(chunk)
        audio_data = buffer.getvalue()

        return {
            "audio": audio_data,
            "word_boundaries": [],  # ElevenLabs streaming does not provide word boundaries
            "duration_ms": 0.0,
            "provider": "elevenlabs",
        }
