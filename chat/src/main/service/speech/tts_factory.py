"""Factory for creating TTS provider instances.

Reads speech_config from server_settings DB first, falls back to config.yaml.
"""

from src.main.service.speech.tts_base import BaseTTS
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def create_tts_provider(provider_override: str | None = None) -> BaseTTS:
    """Create a TTS provider instance.

    Priority: provider_override > DB (server_settings) > config.yaml
    """
    from src.main.service.speech.stt_factory import _get_speech_config_from_db

    db_config = _get_speech_config_from_db()
    yaml_config = resolved_config.get("tts", {})

    provider = provider_override
    if not provider and db_config:
        provider = db_config.get("tts_provider")
    if not provider:
        provider = yaml_config.get("provider", "edge")

    if provider == "edge":
        from src.main.service.speech.tts_edge import EdgeTTS

        return EdgeTTS()

    elif provider == "google":
        from src.main.service.speech.tts_google import GoogleTTS

        return GoogleTTS()

    elif provider == "elevenlabs":
        from src.main.service.speech.tts_elevenlabs import ElevenLabsTTS

        # API key: DB > config.yaml
        api_key = ""
        if db_config:
            api_key = db_config.get("elevenlabs_api_key", "")
        if not api_key:
            api_key = yaml_config.get("elevenlabs_api_key", "")

        if not api_key:
            raise ValueError(
                "ElevenLabs TTS requires an API key. "
                "Configure it in Settings → General → Speech Services, or set tts.elevenlabs_api_key in config.yaml"
            )

        voice_id = yaml_config.get("elevenlabs_voice_id", "nPczCjzI2devNBz1zQrb")
        model = yaml_config.get("elevenlabs_model", "eleven_multilingual_v2")

        return ElevenLabsTTS(api_key=api_key, voice_id=voice_id, model=model)

    else:
        raise ValueError(f"Unsupported TTS provider: {provider}. Supported: edge, google, elevenlabs")
