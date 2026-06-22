"""Model-knowledge reflection step.

After a sourced answer (from the user's collections and/or the web) has been
streamed, optionally run a thinking-capable model that reflects on what was found
and adds the model's OWN knowledge as a distinct, clearly-separate insight.

- Its chain-of-thought is streamed as ``reasoning_delta`` (the existing UI
  thinking panel / collapsible section).
- The insight text is streamed as ``model_insight_delta`` (a distinct "model
  insight" block rendered below the sourced answer).

Gated by the request flag (``deep_synthesis_enabled``) so the extra thinking-model
call only runs on demand — the user toggles it.

The reflection model is resolved from the single source of truth via
``agent_type="reflection"`` (system_agent_config.model_overrides), so it can be a
thinking model (e.g. DeepSeek V4-Flash thinking) even while tool orchestration
stays on a non-thinking model.
"""

from collections.abc import AsyncGenerator
import json

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def _peek(packet: str) -> tuple[str, str]:
    """Return (type, content) from a yielded NDJSON packet string (best-effort)."""
    try:
        obj = json.loads(packet)
        obj = obj.get("obj", obj) if isinstance(obj, dict) else {}
        return obj.get("type", ""), str(obj.get("content") or "")
    except Exception:
        return "", ""


async def with_model_reflection(
    inner: AsyncGenerator[str, None],
    *,
    request,
    emitter,
    user_id: str | None = None,
    force_reflection: bool = False,
) -> AsyncGenerator[str, None]:
    """Wrap a chat packet generator: stream it through, and — when
    ``request.deep_synthesis_enabled`` is set (or ``force_reflection`` is
    True) — append a thinking-model reflection (reasoning_delta +
    model_insight) just before the final ``stream_end``. A no-op
    pass-through otherwise.

    ``force_reflection`` is used by the no-collection direct path: when the
    chat had no books and fell back to a web-grounded answer, we always want
    the model's own-knowledge insight below it regardless of the UI
    "thinking" toggle. The ``saw_sources`` gate below still applies, so the
    extra thinking-model call only runs when the answer was actually grounded
    in sources (web citations) — a pure general-knowledge reply with no
    citations skips it.
    """
    if not force_reflection and not getattr(request, "deep_synthesis_enabled", False):
        async for packet in inner:
            yield packet
        return

    answer_parts: list[str] = []
    saw_stream_end = False
    saw_sources = False
    async for packet in inner:
        ptype, content = _peek(packet)
        if ptype == "stream_end":
            saw_stream_end = True  # hold the end until the reflection is appended
            continue
        if ptype == "message_delta" and content:
            answer_parts.append(content)
        elif ptype.startswith("citation"):
            saw_sources = True  # retrieval actually grounded the answer
        yield packet

    # Reflection only makes sense as "the model's OWN knowledge added to a SOURCED
    # answer". If retrieval produced no sources (no citation packets) — a greeting
    # short-circuited by triage, or a query the pipeline answered from general
    # knowledge / found nothing for — there is no sourced answer to reflect on, so
    # skip the extra thinking-model call entirely instead of asking it to reflect on
    # "(no sourced answer was produced)".
    sourced_answer = "".join(answer_parts).strip()
    if saw_sources and sourced_answer:
        try:
            async for rpacket in stream_model_reflection(
                query=getattr(request, "prompt", "") or "",
                sourced_answer=sourced_answer,
                emitter=emitter,
                user_id=user_id,
                language=getattr(request, "language", None),
            ):
                yield rpacket
        except Exception as e:
            logger.warning("with_model_reflection: reflection failed: %s", str(e))
    else:
        logger.info("Model reflection skipped: no sources retrieved (saw_sources=%s)", saw_sources)

    if saw_stream_end:
        yield emitter.emit_stream_end(reason="completed")


_DEFAULT_SYSTEM_PROMPT = (
    "You are the reflection layer of a retrieval-augmented research assistant. The "
    "user's question was already answered from their library and/or the web. Add the "
    "model's OWN knowledge ONLY when it is genuinely SUPPLEMENTARY — broader context, "
    "non-obvious implications or connections, relevant facts the sources do not "
    "contain, or a gentle flag where sources and general knowledge disagree. Do NOT "
    "repeat or merely rephrase the sourced answer, and do not pad. Be honest about the "
    "limits of your own knowledge. Keep it to a few tight paragraphs.\n\n"
    "CRITICAL: if the sourced answer already covers the topic well and you have nothing "
    "of real, non-redundant value to add, respond with EXACTLY the token NO_INSIGHT "
    "(and nothing else). A missing insight is better than a forced, redundant one — "
    "only produce a separate insight when it stands on its own merit."
)


def _system_prompt(language: str | None, user_prompt: str | None = None) -> str:
    prompt = _DEFAULT_SYSTEM_PROMPT
    try:
        from src.main.utils.config.loader import resolved_prompts

        configured = resolved_prompts.get("model_reflection", {}).get("system_prompt")
        if isinstance(configured, str) and configured.strip():
            prompt = configured
    except Exception:
        pass
    # Reuse the canonical, Croatian-aware language directive (anti-Serbian-drift
    # guard) instead of a bare ISO code. Falls back to the generic instruction if
    # the helper can't be imported for any reason.
    directive = ""
    try:
        from src.main.utils.text.language import language_directive

        directive = language_directive(language, prompt=user_prompt)
    except Exception:
        if language and language.lower() != "en":
            directive = f"Respond in the user's language (ISO 639-1 code: {language})."
    if directive:
        # This is a thinking model: its reasoning trace (reasoning_content) is shown
        # to the user in the "Razmišljanje" panel, so it must REASON in the user's
        # language too — not only write the final insight in it. A plain "respond in
        # X" leaves DeepSeek thinking in English while the answer is Croatian.
        prompt += (
            "\n\nLANGUAGE — this is strict and applies to BOTH your step-by-step "
            "reasoning/thinking AND your final response: produce all of it in the "
            "user's language. Your reasoning is shown to the user, so it must not be "
            f"in English when the user's language is not English. {directive}"
        )
    return prompt


async def stream_model_reflection(
    *,
    query: str,
    sourced_answer: str,
    emitter,
    user_id: str | None = None,
    language: str | None = None,
) -> AsyncGenerator[str, None]:
    """Stream the model-knowledge reflection as reasoning_delta + model_insight_delta.

    Best-effort: any failure is logged and the generator simply ends (the main
    answer is already delivered, so the reflection must never break a response).

    Streams via the raw OpenAI-compatible client (not LangChain): LangChain's
    ChatOpenAI drops DeepSeek's separate ``reasoning_content`` field, so the
    thinking tokens would be lost. The reflection model + key + base come from
    the single source of truth — ``system_agent_config`` (agent_type="reflection").
    """
    from openai import AsyncOpenAI

    from src.main.utils.llm.agent_model_utils import get_system_agent_model

    if not (query or "").strip():
        return

    try:
        cfg = get_system_agent_model(agent_type="reflection")
    except Exception as e:
        logger.warning("Model reflection: could not resolve reflection model: %s", str(e))
        return

    api_key = getattr(cfg, "api_key", None)
    if not api_key:
        logger.warning("Model reflection: reflection provider has no API key, skipping")
        return
    base_url = (getattr(cfg, "api_base", None) or "https://api.deepseek.com").rstrip("/")
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    messages = [
        {"role": "system", "content": _system_prompt(language, query)},
        {
            "role": "user",
            "content": (
                f"User question:\n{query}\n\n"
                f"Answer already given from the user's sources:\n{(sourced_answer or '').strip() or '(no sourced answer was produced)'}\n\n"
                "Now add your own-knowledge reflection per your instructions."
            ),
        },
    ]

    # Stream the reasoning (thinking) live, but BUFFER the insight text so we can
    # decide whether it's worth its own block. The model returns the sentinel
    # NO_INSIGHT when the sourced answer already covers everything — in that case
    # we emit no "Uvid modela" block at all, instead of force-separating a
    # redundant restatement of what the answer (or the model's own knowledge
    # already woven into it) said. The insight is short (a few paragraphs), so
    # buffering it costs nothing and avoids a half-rendered block we'd retract.
    insight_buf: list[str] = []
    try:
        stream = await client.chat.completions.create(model=cfg.model_name, messages=messages, stream=True)
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            reasoning = getattr(delta, "reasoning_content", None)
            if reasoning:
                yield emitter.emit_reasoning_delta(reasoning, streamed=True)
            content = getattr(delta, "content", None)
            if content:
                insight_buf.append(content)
    except Exception as e:
        logger.warning("Model reflection stream failed: %s", str(e))

    insight = "".join(insight_buf).strip()
    # Sentinel (tolerate leading markdown emphasis the model sometimes adds).
    if not insight or insight.upper().lstrip("*_#> ").startswith("NO_INSIGHT"):
        logger.info("Model reflection: no supplementary insight; block suppressed")
        return
    yield emitter.emit_model_insight_start()
    yield emitter.emit_model_insight_delta(insight)
