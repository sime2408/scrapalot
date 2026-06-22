"""
TtsService gRPC Implementation

Implements the TtsService defined in tts.proto.
Supports multiple TTS providers (Edge-TTS, Google TTS, ElevenLabs) via factory.

Markdown text is preprocessed into SSML-enhanced plain text before synthesis:
- Headers get pauses after them
- Bold text gets strong emphasis
- Italic text gets moderate emphasis
- Code blocks, links, images, and other Markdown syntax are stripped
"""

import asyncio
import re

import grpc

from src.main.grpc import common_pb2, tts_pb2, tts_pb2_grpc
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def _markdown_to_ssml_text(text: str) -> str:
    """Convert Markdown text to SSML-enhanced plain text for edge-tts.

    edge-tts wraps text in a <speak> SSML envelope, so inline SSML tags
    like <break/> and <emphasis> are valid inside the text parameter.
    """
    # Remove fenced code blocks (``` ... ```) — not useful for speech
    text = re.sub(r"```[\s\S]*?```", "", text)

    # Remove inline code (`code`) — just keep the code text
    text = re.sub(r"`([^`]+)`", r"\1", text)

    # Remove images ![alt](url)
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)

    # Convert links [text](url) → just the text
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)

    # Headers: # Header → Header + pause (longer pause for higher-level headers)
    text = re.sub(
        r"^#{1}\s+(.+)$",
        r'\1.<break time="800ms"/>',
        text,
        flags=re.MULTILINE,
    )
    text = re.sub(
        r"^#{2}\s+(.+)$",
        r'\1.<break time="600ms"/>',
        text,
        flags=re.MULTILINE,
    )
    text = re.sub(
        r"^#{3,6}\s+(.+)$",
        r'\1.<break time="400ms"/>',
        text,
        flags=re.MULTILINE,
    )

    # Bold + italic (***text*** or ___text___) → strong emphasis
    text = re.sub(
        r"\*{3}(.+?)\*{3}|_{3}(.+?)_{3}",
        lambda m: f'<emphasis level="strong">{m.group(1) or m.group(2)}</emphasis>',
        text,
    )

    # Bold (**text** or __text__) → strong emphasis
    text = re.sub(
        r"\*{2}(.+?)\*{2}|_{2}(.+?)_{2}",
        lambda m: f'<emphasis level="strong">{m.group(1) or m.group(2)}</emphasis>',
        text,
    )

    # Italic (*text* or _text_) → moderate emphasis
    # Avoid matching mid-word underscores (e.g. file_name)
    text = re.sub(
        r"(?<!\w)\*(.+?)\*(?!\w)|(?<!\w)_(.+?)_(?!\w)",
        lambda m: f'<emphasis level="moderate">{m.group(1) or m.group(2)}</emphasis>',
        text,
    )

    # Horizontal rules (---, ***, ___) → pause
    text = re.sub(r"^[\s]*[-*_]{3,}[\s]*$", '<break time="500ms"/>', text, flags=re.MULTILINE)

    # Blockquotes: > text → just the text with slight pause before
    text = re.sub(r"^>\s*(.+)$", r'<break time="200ms"/>\1', text, flags=re.MULTILINE)

    # Unordered list items: - item or * item → natural speech with micro-pause
    text = re.sub(r"^[\s]*[-*+]\s+(.+)$", r'<break time="150ms"/>\1.', text, flags=re.MULTILINE)

    # Ordered list items: 1. item → natural speech
    text = re.sub(r"^[\s]*\d+\.\s+(.+)$", r'<break time="150ms"/>\1.', text, flags=re.MULTILINE)

    # Tables: strip pipe characters, keep cell text
    text = re.sub(r"^\|[-:|\s]+\|$", "", text, flags=re.MULTILINE)  # separator rows
    text = re.sub(r"\|", " ", text)

    # Clean up multiple consecutive blank lines → single pause
    text = re.sub(r"\n{3,}", '\n<break time="300ms"/>\n', text)

    # Remove any leftover HTML-like artifacts that aren't our SSML
    # (but preserve our <break> and <emphasis> tags)
    text = re.sub(r"<(?!break|emphasis|/emphasis)[^>]+>", "", text)

    # Collapse excessive whitespace
    text = re.sub(r"[ \t]{2,}", " ", text)

    return text.strip()


def _strip_ssml(text: str) -> str:
    """Strip SSML tags for providers that don't support them."""
    text = re.sub(r"<break[^>]*/>", " ", text)
    text = re.sub(r"</?emphasis[^>]*>", "", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


class TtsServiceServicer(tts_pb2_grpc.TtsServiceServicer):
    """TtsService gRPC implementation."""

    # noinspection PyUnresolvedReferences
    async def Synthesize(
        self,
        # noinspection PyUnresolvedReferences
        request: tts_pb2.SynthesizeRequest,
        context: grpc.aio.ServicerContext,
    ) -> tts_pb2.SynthesizeResponse:
        """Synthesize text to speech audio with word boundaries."""
        logger.info(
            "TtsService.Synthesize called - voice=%s, text_length=%d",
            request.voice,
            len(request.text),
        )

        try:
            from src.main.service.speech.tts_factory import create_tts_provider

            voice = request.voice or "en-US-AriaNeural"
            rate = request.rate or "+0%"
            pitch = request.pitch or "+0Hz"
            text = _markdown_to_ssml_text(request.text)

            if not text or len(text) > 50000:
                await context.abort(
                    grpc.StatusCode.INVALID_ARGUMENT,
                    "Text must be between 1 and 50000 characters",
                )
                # noinspection PyUnresolvedReferences
                return tts_pb2.SynthesizeResponse()

            provider = create_tts_provider()

            # Non-Edge providers don't understand SSML
            provider_name = getattr(provider, "__class__", type(provider)).__name__
            if "Edge" not in provider_name:
                text = _strip_ssml(text)

            # Synthesize with retry logic
            max_retries = 3
            result = None

            for attempt in range(max_retries):
                try:
                    result = await provider.synthesize(
                        text=text,
                        voice=voice,
                        rate=rate,
                        pitch=pitch,
                    )
                    break
                except Exception as e:
                    if attempt < max_retries - 1:
                        wait_time = 2**attempt
                        logger.warning(
                            "TTS attempt %d failed, retrying in %ds: %s",
                            attempt + 1,
                            wait_time,
                            str(e),
                        )
                        await asyncio.sleep(wait_time)
                    else:
                        raise

            # noinspection PyUnresolvedReferences
            audio_data = result.get("audio", b"")
            word_boundaries = [
                # noinspection PyUnresolvedReferences
                tts_pb2.WordBoundary(
                    text=wb.get("text", ""),
                    offset=wb.get("offset", 0),
                    duration=wb.get("duration", 0),
                )
                # noinspection PyUnresolvedReferences
                for wb in result.get("word_boundaries", [])
            ]
            # noinspection PyUnresolvedReferences
            duration_ms = result.get("duration_ms", 0.0)

            # noinspection PyUnresolvedReferences
            return tts_pb2.SynthesizeResponse(
                audio=audio_data,
                word_boundaries=word_boundaries,
                duration_ms=duration_ms,
            )

        except Exception as e:
            logger.exception("Error in TtsService.Synthesize: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, f"TTS synthesis failed: {e!s}")
            # noinspection PyUnresolvedReferences
            return tts_pb2.SynthesizeResponse()

    # noinspection PyUnresolvedReferences
    async def ListVoices(
        self,
        request: common_pb2.Empty,
        context: grpc.aio.ServicerContext,
    ) -> tts_pb2.ListVoicesResponse:
        """List available TTS voices."""
        logger.info("TtsService.ListVoices called")

        try:
            from src.main.service.speech.tts_factory import create_tts_provider

            provider = create_tts_provider()
            voices = await provider.list_voices()

            voice_infos = [
                # noinspection PyUnresolvedReferences
                tts_pb2.VoiceInfo(
                    name=v.get("name", ""),
                    display_name=v.get("display_name", ""),
                    locale=v.get("locale", ""),
                    gender=v.get("gender", ""),
                    language=v.get("language", ""),
                )
                for v in voices
            ]

            # noinspection PyUnresolvedReferences
            return tts_pb2.ListVoicesResponse(voices=voice_infos)

        except Exception as e:
            logger.exception("Error in TtsService.ListVoices: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, f"Failed to list voices: {e!s}")
            # noinspection PyUnresolvedReferences
            return tts_pb2.ListVoicesResponse()
