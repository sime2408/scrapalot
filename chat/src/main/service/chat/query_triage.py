"""Upfront query-complexity triage gate.

Runs ONCE, cheaply, before the agentic RAG pipeline. It answers a single
question: does this turn actually need retrieval / orchestration / strategy
routing at all — or is it a greeting, an acknowledgement, small talk, or a pure
formatting/meta instruction that the model can satisfy directly?

When no pipeline is needed, the same call also returns the direct answer (a
greeting answer is so cheap there is no reason to make a second call), so the
caller can stream it and return immediately — skipping collection resolution,
orchestration, retrieval, strategy routing AND the reflection layer.

Design constraints (from project rules):
- **Semantic LLM judgment, never a keyword list.** The model decides; we do not
  pattern-match phrases.
- **Fail OPEN.** Any error, ambiguity, or unparsable output → ``needs_pipeline=True``.
  A trivial query wrongly sent through the pipeline is merely slow; a substantive
  query wrongly short-circuited would be a correctness bug. We never risk the latter.
- **System provider, non-thinking, single short call** (``agent_type="triage"``),
  resolved from the single source of truth like every other system agent.
"""

from dataclasses import dataclass
import json

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


@dataclass
class TriageDecision:
    """Outcome of the upfront triage gate.

    ``needs_pipeline`` True  → run the full agentic RAG pipeline as before.
    ``needs_pipeline`` False → ``direct_answer`` is the complete response; the
    caller streams it and returns without any retrieval.
    """

    needs_pipeline: bool
    direct_answer: str = ""


_DEFAULT_SYSTEM_PROMPT = (
    "You are the triage layer of a retrieval-augmented assistant over the user's "
    "personal document library. For each user turn you decide ONE thing: is this an "
    "actual request for information about the world or the user's documents (which "
    "MUST go through the retrieval pipeline), or is it a non-informational "
    "conversational turn that can be answered directly?\n\n"
    "Answer DIRECTLY (needs_pipeline=false) ONLY for turns that carry no information "
    "request the documents or the web could satisfy:\n"
    "- greetings and farewells ('bok', 'hello', 'doviđenja');\n"
    "- thanks and acknowledgements ('hvala', 'ok', 'super');\n"
    "- small talk about the conversation itself ('kako si?');\n"
    "- meta/formatting instructions about your own previous reply ('say only X', "
    "'repeat that shorter', 'translate your last answer', 'make it a list');\n"
    "- self-contained arithmetic the user wrote out (e.g. '17 * 23').\n"
    "For these, write the full final reply yourself and honour any wording "
    "constraints exactly (if the user says 'say only hello and nothing else', the "
    "answer is literally that).\n\n"
    "Require the PIPELINE (needs_pipeline=true) for EVERY genuine information request: "
    "any question about a topic, person, work, event, concept, definition, fact, "
    "summary, comparison, or about the user's documents — anything that asks "
    "what/why/how/who/when about the world or their library. This holds EVEN IF you "
    "already know the answer from your own training: the user keeps these documents "
    "precisely so answers are grounded in and cited from THEM, not from your memory. "
    "Never skip the pipeline just because you could answer from general knowledge. A "
    "question like 'What does Sun Tzu say about spies?' ALWAYS uses the pipeline.\n\n"
    "Judge by MEANING, not by keywords. The bar for DIRECT is high — when in any "
    "doubt, choose the pipeline. A needless lookup is cheap; a missed one strips the "
    "answer of the user's own sources.\n\n"
    'Reply with STRICT JSON only, no prose: {"needs_pipeline": <true|false>, '
    '"answer": "<the full reply when needs_pipeline is false, else empty string>"}.'
)


def _system_prompt(language: str | None, user_prompt: str | None) -> str:
    prompt = _DEFAULT_SYSTEM_PROMPT
    try:
        from src.main.utils.config.loader import resolved_prompts

        configured = resolved_prompts.get("query_triage", {}).get("system_prompt")
        if isinstance(configured, str) and configured.strip():
            prompt = configured
    except Exception:
        pass

    # Reuse the canonical Croatian-aware language directive (anti-Serbian-drift)
    # so the DIRECT answer lands in the user's language with correct ijekavica.
    try:
        from src.main.utils.text.language import language_directive

        directive = language_directive(language, prompt=user_prompt)
    except Exception:
        directive = ""
        if language and language.lower() != "en":
            directive = f"Write the answer in the user's language (ISO 639-1 code: {language})."
    if directive:
        prompt += f"\n\nLANGUAGE — applies to the 'answer' field: {directive}"
    return prompt


def _parse(raw: str) -> TriageDecision:
    """Best-effort parse of the model's JSON. Fail open to the pipeline."""
    try:
        obj = json.loads(raw)
    except Exception:
        # Some providers wrap JSON in prose despite instructions; salvage the object.
        start, end = raw.find("{"), raw.rfind("}")
        if start == -1 or end <= start:
            return TriageDecision(needs_pipeline=True)
        try:
            obj = json.loads(raw[start : end + 1])
        except Exception:
            return TriageDecision(needs_pipeline=True)
    if not isinstance(obj, dict):
        return TriageDecision(needs_pipeline=True)
    needs = obj.get("needs_pipeline")
    if needs is not False:  # anything but an explicit False → run the pipeline
        return TriageDecision(needs_pipeline=True)
    answer = str(obj.get("answer") or "").strip()
    if not answer:
        # Claimed "no pipeline" but gave no answer — don't emit an empty reply.
        return TriageDecision(needs_pipeline=True)
    return TriageDecision(needs_pipeline=False, direct_answer=answer)


async def triage_query(
    *,
    query: str,
    conversation: str = "",
    language: str | None = None,
) -> TriageDecision:
    """Classify a turn and, when trivial, produce its direct answer in one call.

    Returns ``needs_pipeline=True`` on any failure so the caller always falls back
    to the full agentic pipeline — triage can never block a real question.
    """
    if not (query or "").strip():
        return TriageDecision(needs_pipeline=True)

    from openai import AsyncOpenAI

    from src.main.utils.llm.agent_model_utils import get_system_agent_model

    try:
        cfg = get_system_agent_model(agent_type="triage")
    except Exception as e:
        logger.warning("Query triage: could not resolve model, running full pipeline: %s", str(e))
        return TriageDecision(needs_pipeline=True)

    api_key = getattr(cfg, "api_key", None)
    if not api_key:
        logger.warning("Query triage: provider has no API key, running full pipeline")
        return TriageDecision(needs_pipeline=True)

    # Derive the endpoint from the provider, not a hardcoded default: the system
    # provider is whatever admin configured (OpenAI / DeepSeek / self-hosted). For
    # OpenAI we must let the client use its own default base — forcing DeepSeek's
    # URL would send gpt-4o-mini to the wrong endpoint and fail every call.
    api_base = getattr(cfg, "api_base", None)
    provider = (getattr(cfg, "provider_type", "") or "").lower()
    if api_base:
        base_url = api_base.rstrip("/")
    elif provider == "openai":
        base_url = None  # AsyncOpenAI defaults to https://api.openai.com
    else:
        base_url = "https://api.deepseek.com"
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    user_content = query
    if conversation and conversation.strip():
        user_content = f"{conversation.strip()}\n\n### Current user turn:\n{query}"

    messages = [
        {"role": "system", "content": _system_prompt(language, query)},
        {"role": "user", "content": user_content},
    ]

    try:
        resp = await client.chat.completions.create(
            model=cfg.model_name,
            messages=messages,
            temperature=0,
            response_format={"type": "json_object"},
        )
        raw = (resp.choices[0].message.content or "").strip() if resp.choices else ""
    except Exception as e:
        # Provider may not support response_format — retry once without it.
        try:
            resp = await client.chat.completions.create(model=cfg.model_name, messages=messages, temperature=0)
            raw = (resp.choices[0].message.content or "").strip() if resp.choices else ""
        except Exception as e2:
            logger.warning("Query triage call failed (%s / %s), running full pipeline", str(e), str(e2))
            return TriageDecision(needs_pipeline=True)

    decision = _parse(raw)
    logger.info(
        "Query triage: needs_pipeline=%s (query=%r)",
        decision.needs_pipeline,
        query[:80],
    )
    return decision
