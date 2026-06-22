"""Voice conversation orchestrator tests.

Pure logic — Redis is faked via ``fakeredis`` (the chat container's default
when ``redislite`` is absent), so these run without a live Redis instance.

PRD CATEGORY_06 §6.3 M3.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import cast

import pytest

from src.main.service.chat.chat_voice_conversation import (
    VoiceConversationOrchestrator,
    buffer_sentences,
)

# ---------------------------------------------------------------------------
# State machine
# ---------------------------------------------------------------------------


def test_start_returns_idle_state() -> None:
    conv = VoiceConversationOrchestrator.start(user_id="u1", language="en")
    try:
        assert conv.state == "idle"
        assert conv.user_id == "u1"
        assert conv.language == "en"
        assert conv.turn_count == 0
        assert conv.in_flight_message_id is None
        assert conv.history == []
    finally:
        VoiceConversationOrchestrator.end(conv.conversation_id)


def test_start_rejects_blank_user_id() -> None:
    with pytest.raises(ValueError, match="user_id"):
        VoiceConversationOrchestrator.start(user_id="")


def test_state_walk_through_full_turn() -> None:
    conv = VoiceConversationOrchestrator.start(user_id="u2")
    try:
        cid = conv.conversation_id
        VoiceConversationOrchestrator.transition(cid, "listening")
        VoiceConversationOrchestrator.transition(cid, "transcribing")
        VoiceConversationOrchestrator.transition(cid, "generating")
        VoiceConversationOrchestrator.transition(cid, "speaking")
        VoiceConversationOrchestrator.transition(cid, "listening")
        loaded = VoiceConversationOrchestrator.get(cid)
        assert loaded is not None
        assert loaded.state == "listening"
    finally:
        VoiceConversationOrchestrator.end(conv.conversation_id)


def test_illegal_jump_is_rejected() -> None:
    conv = VoiceConversationOrchestrator.start(user_id="u3")
    try:
        # listening -> speaking skips transcribing + generating; must not be allowed.
        VoiceConversationOrchestrator.transition(conv.conversation_id, "listening")
        with pytest.raises(ValueError, match="Illegal voice state transition"):
            VoiceConversationOrchestrator.transition(conv.conversation_id, "speaking")
    finally:
        VoiceConversationOrchestrator.end(conv.conversation_id)


def test_barge_in_path_from_speaking() -> None:
    """Speaking → barged_in → listening loops without going through idle."""
    conv = VoiceConversationOrchestrator.start(user_id="u4")
    try:
        cid = conv.conversation_id
        VoiceConversationOrchestrator.transition(cid, "listening")
        VoiceConversationOrchestrator.transition(cid, "transcribing")
        VoiceConversationOrchestrator.transition(cid, "generating")
        VoiceConversationOrchestrator.transition(cid, "speaking")
        VoiceConversationOrchestrator.transition(cid, "barged_in")
        VoiceConversationOrchestrator.transition(cid, "listening")
        loaded = VoiceConversationOrchestrator.get(cid)
        assert loaded is not None
        assert loaded.state == "listening"
    finally:
        VoiceConversationOrchestrator.end(conv.conversation_id)


def test_record_turn_appends_history_and_caps_at_10() -> None:
    conv = VoiceConversationOrchestrator.start(user_id="u5")
    try:
        cid = conv.conversation_id
        for i in range(12):
            VoiceConversationOrchestrator.record_turn(cid, f"q{i}", f"a{i}")
        loaded = VoiceConversationOrchestrator.get(cid)
        assert loaded is not None
        # last 10 turns kept (plus the current one being appended) → max 20 messages.
        assert len(loaded.history) <= 20
        assert loaded.history[-1] == {"role": "assistant", "content": "a11"}
        assert loaded.turn_count == 12
    finally:
        VoiceConversationOrchestrator.end(conv.conversation_id)


def test_attach_stt_session_id() -> None:
    conv = VoiceConversationOrchestrator.start(user_id="u6")
    try:
        cid = conv.conversation_id
        VoiceConversationOrchestrator.attach_stt_session(cid, "stt-session-abc")
        loaded = VoiceConversationOrchestrator.get(cid)
        assert loaded is not None
        assert loaded.stt_session_id == "stt-session-abc"
    finally:
        VoiceConversationOrchestrator.end(conv.conversation_id)


def test_mark_in_flight_for_barge_in_cancellation() -> None:
    conv = VoiceConversationOrchestrator.start(user_id="u7")
    try:
        cid = conv.conversation_id
        VoiceConversationOrchestrator.mark_in_flight(cid, "msg-42")
        loaded = VoiceConversationOrchestrator.get(cid)
        assert loaded is not None
        assert loaded.in_flight_message_id == "msg-42"
    finally:
        VoiceConversationOrchestrator.end(conv.conversation_id)


def test_get_returns_none_for_missing_conversation() -> None:
    assert VoiceConversationOrchestrator.get("nonexistent-id") is None


def test_end_is_idempotent() -> None:
    conv = VoiceConversationOrchestrator.start(user_id="u8")
    VoiceConversationOrchestrator.end(conv.conversation_id)
    VoiceConversationOrchestrator.end(conv.conversation_id)  # second call must not raise


# ---------------------------------------------------------------------------
# buffer_sentences
# ---------------------------------------------------------------------------


async def _to_iter(items: list[str]) -> AsyncIterator[str]:
    for item in items:
        yield item


@pytest.mark.asyncio
async def test_sentence_buffer_yields_on_terminator() -> None:
    sentences = [s async for s in buffer_sentences(_to_iter(["Hello", " world", ".", " Next"]))]
    assert sentences[0] == "Hello world."


@pytest.mark.asyncio
async def test_sentence_buffer_handles_terminator_inside_token() -> None:
    """LLM emits ``. How`` as one token — split on the inner period."""
    chunks = ["Hello world", ". How are you", "?"]
    sentences = [s async for s in buffer_sentences(_to_iter(chunks))]
    assert sentences == ["Hello world.", "How are you?"]


@pytest.mark.asyncio
async def test_sentence_buffer_yields_long_runons_at_max_chars() -> None:
    """A sentence with no punctuation that crosses ``max_chars`` is yielded
    so the TTS pipeline doesn't starve."""
    long_token = "no punctuation here just words and more words and even more"
    sentences = [s async for s in buffer_sentences(_to_iter([long_token]), max_chars=20)]
    assert sentences == [long_token.strip()]


@pytest.mark.asyncio
async def test_sentence_buffer_yields_trailing_partial_on_stream_end() -> None:
    sentences = [s async for s in buffer_sentences(_to_iter(["Hi ", "there"]))]
    assert sentences == ["Hi there"]


@pytest.mark.asyncio
async def test_sentence_buffer_skips_empty_tokens() -> None:
    sentences = [s async for s in buffer_sentences(_to_iter(["", "Hi.", "", " There.", ""]))]
    assert sentences == ["Hi.", "There."]


@pytest.mark.asyncio
async def test_sentence_buffer_handles_ellipsis() -> None:
    sentences = [s async for s in buffer_sentences(_to_iter(["Wait", "…", " then go."]))]
    assert sentences == ["Wait…", "then go."]


@pytest.mark.asyncio
async def test_sentence_buffer_empty_input_yields_nothing() -> None:
    sentences: list[str] = []
    async for s in buffer_sentences(_to_iter([])):
        sentences.append(s)
    # Cast for type-checkers — empty AsyncIterator yields nothing.
    assert cast(list[str], sentences) == []
