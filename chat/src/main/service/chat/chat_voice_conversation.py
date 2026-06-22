"""Voice conversation state machine + orchestrator.

A "voice conversation" is one open mic session: the user opens voice mode,
speaks a turn, the assistant replies, the user speaks again, and so on until
the user explicitly ends the conversation. State is per-conversation (not
per-session_id of the live STT) so that on barge-in we can cancel the
in-flight LLM completion and TTS playback while keeping the conversation
itself alive.

State graph:

    idle ─────► listening ─────► transcribing ─────► generating ─────► speaking
     ▲              ▲                  │                 │                 │
     │              └──────────────────┘                 │                 │
     │                                                   │                 │
     └───────────────  barged_in (M5)  ◄─────────────────┴─────────────────┘
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass, field
import json
import time
from typing import Literal
import uuid

from src.main.utils.core.logger import get_logger
from src.main.utils.redis.client import get_redis_client

logger = get_logger(__name__)

VoiceState = Literal[
    "idle",
    "listening",
    "transcribing",
    "generating",
    "speaking",
    "barged_in",
]

_VALID_TRANSITIONS: dict[VoiceState, frozenset[VoiceState]] = {
    "idle": frozenset({"listening"}),
    "listening": frozenset({"transcribing", "idle"}),
    "transcribing": frozenset({"generating", "listening", "idle"}),
    "generating": frozenset({"speaking", "barged_in", "listening", "idle"}),
    "speaking": frozenset({"listening", "barged_in", "idle"}),
    "barged_in": frozenset({"transcribing", "listening", "idle"}),
}

_REDIS_PREFIX = "voice_conversation:"
_REDIS_TTL_SECONDS = 30 * 60  # 30 min — voice convs are usually short, but
# long enough that a temporary tab focus loss + return doesn't drop state.


@dataclass
class VoiceConversation:
    """Snapshot of one voice-mode session."""

    conversation_id: str
    user_id: str
    state: VoiceState = "idle"
    language: str | None = None
    stt_session_id: str | None = None
    last_state_change_ms: int = 0
    # Number of completed turns (user said something + assistant replied).
    turn_count: int = 0
    # The current in-flight assistant message id, or None when not generating.
    in_flight_message_id: str | None = None
    history: list[dict[str, str]] = field(default_factory=list)


def _redis_key(conversation_id: str) -> str:
    return f"{_REDIS_PREFIX}{conversation_id}"


def _now_ms() -> int:
    return int(time.time() * 1000)


class VoiceConversationOrchestrator:
    """High-level façade for voice-mode lifecycle + state transitions.

    Stateless except for Redis — a process restart leaves conversations in
    place; the next call from the client picks up where it left off.
    """

    @staticmethod
    def start(user_id: str, language: str | None = None) -> VoiceConversation:
        """Open a new conversation; the client uses ``conversation_id`` for
        every subsequent transition / barge-in / end call.
        """
        if not user_id:
            raise ValueError("user_id is required")

        conv = VoiceConversation(
            conversation_id=str(uuid.uuid4()),
            user_id=user_id,
            language=language,
            last_state_change_ms=_now_ms(),
        )
        VoiceConversationOrchestrator._save(conv)
        logger.info("Voice conversation started: id=%s user=%s", conv.conversation_id, user_id)
        return conv

    @staticmethod
    def get(conversation_id: str) -> VoiceConversation | None:
        redis_client = get_redis_client()
        raw = redis_client.get(_redis_key(conversation_id))
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        data = json.loads(raw)
        return VoiceConversation(**data)

    @staticmethod
    def transition(conversation_id: str, new_state: VoiceState) -> VoiceConversation:
        """Drive the state machine, refusing illegal jumps.

        Raises ``ValueError`` when the transition is not in
        :data:`_VALID_TRANSITIONS` so accidental skips (e.g. ``listening``
        → ``speaking`` without going through ``transcribing`` and
        ``generating``) surface immediately instead of silently corrupting
        state.
        """
        conv = VoiceConversationOrchestrator.get(conversation_id)
        if conv is None:
            raise ValueError(f"Voice conversation not found: {conversation_id}")

        allowed = _VALID_TRANSITIONS.get(conv.state, frozenset())
        if new_state not in allowed and new_state != conv.state:
            raise ValueError(
                f"Illegal voice state transition {conv.state} → {new_state}; allowed: {sorted(allowed)}",
            )

        conv.state = new_state
        conv.last_state_change_ms = _now_ms()
        VoiceConversationOrchestrator._save(conv)
        return conv

    @staticmethod
    def attach_stt_session(conversation_id: str, stt_session_id: str) -> VoiceConversation:
        """Bind a live STT session id to this voice conversation."""
        conv = VoiceConversationOrchestrator.get(conversation_id)
        if conv is None:
            raise ValueError(f"Voice conversation not found: {conversation_id}")
        conv.stt_session_id = stt_session_id
        VoiceConversationOrchestrator._save(conv)
        return conv

    @staticmethod
    def record_turn(
        conversation_id: str,
        user_text: str,
        assistant_text: str,
        in_flight_message_id: str | None = None,
    ) -> VoiceConversation:
        """Append a completed turn to the conversation history (last 10 kept)
        and clear the in-flight message marker.
        """
        conv = VoiceConversationOrchestrator.get(conversation_id)
        if conv is None:
            raise ValueError(f"Voice conversation not found: {conversation_id}")

        conv.history = [
            *conv.history[-9:],
            {"role": "user", "content": user_text},
            {"role": "assistant", "content": assistant_text},
        ]
        conv.turn_count += 1
        conv.in_flight_message_id = None
        # Clear ID only when the just-finished turn matches.
        if in_flight_message_id is not None and conv.in_flight_message_id == in_flight_message_id:
            conv.in_flight_message_id = None
        VoiceConversationOrchestrator._save(conv)
        return conv

    @staticmethod
    def mark_in_flight(conversation_id: str, message_id: str) -> VoiceConversation:
        """Stamp the message id of the LLM completion currently being generated.
        Used by barge-in (M5) to cancel the right Pydantic AI ``Agent.run_stream``.
        """
        conv = VoiceConversationOrchestrator.get(conversation_id)
        if conv is None:
            raise ValueError(f"Voice conversation not found: {conversation_id}")
        conv.in_flight_message_id = message_id
        VoiceConversationOrchestrator._save(conv)
        return conv

    @staticmethod
    def end(conversation_id: str) -> None:
        """Hard-delete the conversation. Idempotent."""
        redis_client = get_redis_client()
        redis_client.delete(_redis_key(conversation_id))
        logger.info("Voice conversation ended: id=%s", conversation_id)

    @staticmethod
    def _save(conv: VoiceConversation) -> None:
        redis_client = get_redis_client()
        payload = json.dumps(
            {
                "conversation_id": conv.conversation_id,
                "user_id": conv.user_id,
                "state": conv.state,
                "language": conv.language,
                "stt_session_id": conv.stt_session_id,
                "last_state_change_ms": conv.last_state_change_ms,
                "turn_count": conv.turn_count,
                "in_flight_message_id": conv.in_flight_message_id,
                "history": conv.history,
            }
        )
        redis_client.setex(_redis_key(conv.conversation_id), _REDIS_TTL_SECONDS, payload)


# ---------------------------------------------------------------------------
# Sentence buffering for streaming TTS (used by M4)
# ---------------------------------------------------------------------------


_SENTENCE_TERMINATORS = (".", "!", "?", "…")
_DEFAULT_MAX_SENTENCE_CHARS = 80


async def buffer_sentences(
    tokens: AsyncIterator[str],
    *,
    max_chars: int = _DEFAULT_MAX_SENTENCE_CHARS,
    terminators: Iterable[str] = _SENTENCE_TERMINATORS,
) -> AsyncIterator[str]:
    """Group an LLM token stream into sentence-bounded chunks.

    Yields each sentence as soon as a terminator (``.``, ``!``, ``?``, ``…``)
    appears anywhere in the running buffer. A terminator inside an incoming
    token (e.g. an LLM emits ``. How``) is detected — we scan for the latest
    terminator on every token, not just the buffer tail. When no terminator
    arrives but the buffer crosses ``max_chars`` we yield it anyway so a
    runaway run-on doesn't starve the TTS pipeline. The trailing partial
    sentence is yielded on stream-end.

    Used by the M4 streaming TTS path so each sentence can be sent to the
    TTS engine as soon as it forms instead of waiting for the full LLM
    response.
    """
    buffer = ""
    term_set = tuple(terminators)

    async for token in tokens:
        if not token:
            continue
        buffer += token

        last_term = -1
        for term in term_set:
            idx = buffer.rfind(term)
            if idx > last_term:
                last_term = idx

        if last_term >= 0:
            cut = last_term + 1
            # Sweep up trailing whitespace so a leading space doesn't get
            # carried into the next sentence.
            while cut < len(buffer) and buffer[cut].isspace():
                cut += 1
            sentence = buffer[:cut].strip()
            if sentence:
                yield sentence
            buffer = buffer[cut:]
        elif len(buffer) >= max_chars:
            yield buffer.strip()
            buffer = ""

    tail = buffer.strip()
    if tail:
        yield tail


# ---------------------------------------------------------------------------
# Streaming token -> sentence -> audio bridge (used by M4 + M5)
# ---------------------------------------------------------------------------


@dataclass
class AudioChunk:
    """One streamed TTS audio chunk emitted by :func:`stream_tts_for_tokens`."""

    audio: bytes
    sentence_index: int
    chunk_index: int
    is_final_chunk: bool = False


SynthesizeStreaming = Callable[[str], AsyncIterator[bytes]]


async def stream_tts_for_tokens(
    tokens: AsyncIterator[str],
    *,
    synthesize_streaming: SynthesizeStreaming,
    max_sentence_chars: int = _DEFAULT_MAX_SENTENCE_CHARS,
    cancelled: asyncio.Event | None = None,
) -> AsyncIterator[AudioChunk]:
    """Bridge an LLM token stream to a streaming TTS provider.

    Buffers tokens into sentences via :func:`buffer_sentences`, sends each
    sentence to the TTS provider's ``synthesize_streaming`` callable, and
    yields :class:`AudioChunk` records the orchestrator (M4) wraps in
    ``audio_delta`` packets.

    ``cancelled`` is an optional ``asyncio.Event`` set on barge-in (M5) — the
    helper checks it between sentences and chunks so an in-flight TTS
    response can stop the moment the user starts speaking again.
    """
    sentence_idx = 0
    async for sentence in buffer_sentences(tokens, max_chars=max_sentence_chars):
        if cancelled is not None and cancelled.is_set():
            return

        # Emit each TTS chunk the moment it arrives. The prior implementation
        # peek-ahead-buffered one chunk so it could stamp `is_final_chunk=True`
        # on the last one, but that lag delayed the FIRST audio chunk by an
        # entire iteration of `synthesize_streaming`. When the upstream TTS
        # provider yields chunks slowly (Edge-TTS network hop), the first
        # chunk's attack — the start of the first word — arrived at the
        # browser late enough that the audio context dropped it and the user
        # heard `…vu riječ` instead of `prvu riječ`. Verified report from
        # user 2026-05-29: "stalno reže prvu riječ".
        #
        # Trade-off: we need a separate end-of-sentence signal for the UI
        # to flush its audio buffer between sentences, since no single
        # real chunk now carries `is_final_chunk=True`. Emit a zero-byte
        # sentinel after the last real chunk — frontend ignores the empty
        # payload but picks up the `is_final_chunk` transition to release
        # the buffer and roll into the next sentence's audio.
        chunk_idx = 0
        async for raw in synthesize_streaming(sentence):
            if cancelled is not None and cancelled.is_set():
                return
            yield AudioChunk(
                audio=raw,
                sentence_index=sentence_idx,
                chunk_index=chunk_idx,
                is_final_chunk=False,
            )
            chunk_idx += 1

        if chunk_idx > 0:
            yield AudioChunk(
                audio=b"",
                sentence_index=sentence_idx,
                chunk_index=chunk_idx,
                is_final_chunk=True,
            )
        sentence_idx += 1
