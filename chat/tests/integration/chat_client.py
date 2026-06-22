"""
Integration-test client for /v1/chat/completions.

The OpenAI-compatible shim is the only chat surface this project exposes
(POST /api/v1/chat/completions). This helper takes the chat-call kwargs
that read naturally in test code (prompt, collection_ids, agentic_rag_enabled,
deep_research_enabled, attachments, …), folds them into the OpenAI envelope
plus its `scrapalot` extras block, streams the SSE response, and re-wraps
each chat.completion.chunk back into the {"ind", "obj"} packet shape that
parse_ndjson() / get_accumulated_content() / etc. already understand.

Usage:

    from tests.integration.chat_client import chat_post

    response = chat_post(
        authenticated_session, api_base_url,
        prompt="What is the main theme?",
        collection_ids=[str(test_collection["id"])],
        timeout=60,
    )
    packets = parse_ndjson(response.text)

Returns a dataclass with `.status_code` (int), `.text` (NDJSON-shaped string),
and `.headers` so existing assertions (`response.status_code == 200`,
`response.text[:200]`) keep working as-is.
"""

from __future__ import annotations

from dataclasses import dataclass
import json

import requests


@dataclass
class ChatResponse:
    """The minimal slice of `requests.Response` that the integration suite
    consumes after a streamed chat call has been buffered into NDJSON form."""

    status_code: int
    text: str
    headers: dict[str, str]


# Boolean flags on the request kwargs map onto scrapalot.mode (single-value
# enum on the server). Order is the same priority order ChatService.routeToGrpc
# applies on the backend so tests can set multiple flags without surprises.
def _resolve_mode(payload: dict) -> str | None:
    if payload.get("deep_research_enabled"):
        return "deep_research"
    if payload.get("agentic_rag_enabled"):
        return "agentic"
    if payload.get("tutor_mode"):
        return "tutor"
    if payload.get("thought_partner_mode"):
        return "thought_partner"
    if payload.get("web_search_enabled"):
        return "web_search"
    return None


# Fields handed straight through into the scrapalot extras block. Anything
# not on this list and not a top-level OpenAI field is silently dropped.
# `session_id` is intentionally NOT here — it travels in the Conversation-Id
# HTTP header (the OpenAI-compat shim's session-continuity convention).
_PASSTHROUGH_KEYS = (
    "workspace_id",
    "collection_ids",
    "document_ids",
    "saved_search_ids",
    "user_message_id",
    "research_breadth",
    "research_depth",
    "attachments",
    "annotation_color_filter",
    "similarity_threshold",
    "top_k",
    "source_preferences",
    "min_confidence_threshold",
    "max_sources",
    "language",
    "mentions",
    "prompt_template_name",
    "clarification_answers",
    "clarification_request_id",
    "approved_plan_id",
    "template_type",
    "council_enabled",
    "continue_research_plan_id",
    "continuation_context",
    "deep_synthesis_enabled",
)


def _build_openai_body(payload: dict) -> dict:
    extras: dict = {}
    mode = _resolve_mode(payload)
    if mode:
        extras["mode"] = mode
    for k in _PASSTHROUGH_KEYS:
        v = payload.get(k)
        if v is None:
            continue
        if isinstance(v, list | tuple) and not v:
            continue
        extras[k] = v
    # `model` deliberately fails the `scrapalot:<slug>` regex on the backend
    # so resolveModelSlug() falls back to the user's default workspace —
    # cleaner than hard-coding a slug that may not exist for every test user.
    # extras.workspace_id / collection_ids in the body still take priority.
    return {
        "model": "scrapalot-default",
        "messages": [{"role": "user", "content": payload["prompt"]}],
        "stream": True,
        "scrapalot": extras,
    }


def _unwrap_chunk(chunk: dict, index: int) -> dict | None:
    """Convert one chat.completion.chunk into the internal {ind, obj} shape."""
    choice = (chunk.get("choices") or [None])[0]
    if not choice:
        return None
    delta = choice.get("delta") or {}
    if isinstance(delta.get("scrapalot"), dict):
        return {"ind": index, "obj": delta["scrapalot"]}
    if delta.get("content"):
        return {"ind": index, "obj": {"type": "message_delta", "content": delta["content"]}}
    if choice.get("finish_reason") == "stop":
        return {"ind": index, "obj": {"type": "stream_end", "reason": "completed"}}
    return None


def chat_post(
    session: requests.Session,
    api_base_url: str,
    *,
    timeout: int = 120,
    headers: dict[str, str] | None = None,
    **payload,
) -> ChatResponse:
    """Issue a streaming chat request against /v1/chat/completions and return
    a ChatResponse whose `.text` is the NDJSON-shaped packet stream the
    integration tests parse with parse_ndjson() / get_accumulated_content().
    `payload` keys mirror the chat-call fields the suites already use
    (prompt, collection_ids, document_ids, agentic_rag_enabled,
    deep_research_enabled, web_search_enabled, attachments, …).
    """
    body = _build_openai_body(payload)
    extra_headers = {"Accept": "text/event-stream"}
    # Legacy session_id maps onto the OpenAI-compat Conversation-Id header.
    session_id = payload.get("session_id")
    if session_id:
        extra_headers["Conversation-Id"] = str(session_id)
    if headers:
        extra_headers.update(headers)

    response = session.post(
        f"{api_base_url}/chat/completions",
        json=body,
        timeout=timeout,
        stream=True,
        headers=extra_headers,
    )
    if response.status_code != 200:
        return ChatResponse(
            status_code=response.status_code,
            text=response.text,
            headers=dict(response.headers),
        )

    packets: list[dict] = []
    counter = 0
    for raw in response.iter_lines(decode_unicode=True):
        if not raw or not raw.startswith("data:"):
            continue
        sse_payload = raw[len("data:") :].strip()
        if sse_payload == "[DONE]":
            break
        try:
            chunk = json.loads(sse_payload)
        except json.JSONDecodeError:
            continue
        unwrapped = _unwrap_chunk(chunk, counter)
        if unwrapped is None:
            continue
        packets.append(unwrapped)
        counter += 1

    ndjson_text = "\n".join(json.dumps(p) for p in packets)
    return ChatResponse(
        status_code=200,
        text=ndjson_text,
        headers=dict(response.headers),
    )
