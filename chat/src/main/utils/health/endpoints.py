"""
Health check utilities for FastAPI application.

This module provides health check and readiness probe endpoints.
"""

import datetime
import os

from fastapi import FastAPI, File, Form, UploadFile
from fastapi import WebSocket as FastAPIWebSocket
from starlette import status
from starlette.responses import JSONResponse

from src.main.utils.core.logger import get_logger
from src.main.utils.startup.state import get_startup_state
from src.main.utils.text.language import LANGUAGE_NAMES, language_name
from src.main.utils.websocket.manager import websocket_manager

logger = get_logger(__name__)


# Lazily-generated 300 ms silent MP3 segment prepended to every Edge-TTS
# response. Without it, Chrome's AudioContext + MP3 decoder + resampler
# priming windows (cumulative 100-300 ms on cold start) clip the first
# 1-2 syllables of every clip, no matter what client-side trick we try.
# Encoding the silence INSIDE the byte stream is the only fix that is
# invariant to browser audio lifecycle. Matches Edge-TTS's own format
# (MPEG-2 Layer III, 24 kHz, mono, 48 kbps) so the browser sees one
# continuous valid MP3 file. Generated once on first call and cached.
_SILENT_MP3_PREFIX: bytes | None = None


def _get_silent_mp3_prefix() -> bytes:
    """Generate (once) a 300 ms silent MP3 segment matching Edge-TTS's
    format. Subsequent calls return the cached bytes."""
    global _SILENT_MP3_PREFIX
    if _SILENT_MP3_PREFIX is not None:
        return _SILENT_MP3_PREFIX
    try:
        import io

        from pydub import AudioSegment

        silence = AudioSegment.silent(duration=300, frame_rate=24000).set_channels(1)
        buf = io.BytesIO()
        silence.export(buf, format="mp3", bitrate="48k", parameters=["-ac", "1", "-ar", "24000"])
        _SILENT_MP3_PREFIX = buf.getvalue()
        logger.info("Generated silent MP3 TTS prefix: %d bytes", len(_SILENT_MP3_PREFIX))
    except Exception as e:
        # Best-effort: an encoder hiccup must not break TTS entirely.
        # An empty prefix degrades back to the previous client-side
        # palliative behaviour, which is still better than no audio.
        logger.warning("Failed to generate silent MP3 prefix: %s", e)
        _SILENT_MP3_PREFIX = b""
    return _SILENT_MP3_PREFIX


def create_health_endpoints(app: FastAPI):
    """
    Create health check, readiness, and utility endpoints.

    Args:
        app: FastAPI application instance
    """

    @app.post("/api/v1/hypothesis", tags=["Notes"])
    async def generate_hypothesis_direct(request: dict = None):
        """Generate competing hypotheses (bypasses gRPC proto for new fields)."""
        if request is None:
            request = {}
        from src.main.service.notes_assistant.text_transform_service import generate_hypothesis

        try:
            result = await generate_hypothesis(
                context=request.get("context", ""),
                _collection_ids=request.get("collection_ids", []),
                locale=request.get("locale", "en"),
            )
            return result
        except Exception as e:
            return {"error": str(e), "hypothesis": "", "rationale": "", "experimental_design": ""}

    @app.post("/api/v1/what-if", tags=["Notes"])
    async def generate_scenario_analysis_direct(request: dict = None):
        """Generate what-if scenario analysis (bypasses gRPC proto)."""
        if request is None:
            request = {}
        from src.main.service.notes_assistant.text_transform_service import generate_scenario_analysis

        try:
            result = await generate_scenario_analysis(
                context=request.get("context", ""),
                _collection_ids=request.get("collection_ids", []),
                locale=request.get("locale", "en"),
            )
            return result
        except Exception as e:
            logger.error("Scenario analysis failed: %s", e)
            return {"error": str(e), "scenario_question": "", "branches": [], "synthesis": {}}

    @app.post("/api/v1/citations/classify-stance", tags=["Citations"])
    async def classify_citation_stance(request: dict | None = None):
        """Classify stance of citations against a claim (Scite integration).

        Request body:
            {
              "claim": "string",
              "candidates": [{"citation_num": int, "context": "string"}, ...]
            }

        Response:
            {"classifications": [{"citation_num", "stance", "confidence", "rationale"}]}
        """
        if request is None:
            request = {}
        from src.main.service.notes_assistant.citation_stance_classifier import CitationCandidate, classify_citations

        try:
            claim = str(request.get("claim", "")).strip()
            raw_candidates = request.get("candidates", [])
            if not claim or not raw_candidates:
                return {"classifications": []}

            candidates = [
                CitationCandidate(
                    citation_num=int(c.get("citation_num", i + 1)),
                    claim=claim,
                    context=str(c.get("context", "")),
                )
                for i, c in enumerate(raw_candidates)
                if c.get("context")
            ]
            classifications = await classify_citations(candidates)
            return {"classifications": [c.model_dump() for c in classifications]}
        except Exception as e:
            logger.error("Citation stance classification failed: %s", e)
            return {"error": str(e), "classifications": []}

    @app.post("/api/v1/voice/transcribe", tags=["Voice"])
    async def voice_transcribe(
        audio: UploadFile = File(...),
        user_id: str = Form(...),
        language: str = Form(""),
        focus_document_id: str = Form(""),
    ):
        """Whisper STT with per-user BYOK key.

        The browser uploads a MediaRecorder blob (WebM/Opus is the default on
        Chromium; Safari emits MP4). We stream the bytes to disk, route
        through `transcribe_voice_clip` which looks up the user's
        `voice_openai_api_key` and falls back to the system key.

        Form fields:
            audio     — multipart file, ~100 KB per ~10 s of speech
            user_id   — UUID used to resolve the BYOK key
            language  — optional ISO 639-1 hint (e.g. "hr")
            focus_document_id — optional UUID of the book the user is focused
                on; when set, Whisper is biased toward that book's title +
                graph entities so its proper nouns transcribe correctly

        Response: {text, language, duration_s, byok_used}
        """
        from src.main.config.database import SessionLocal
        from src.main.service.speech.voice_mode_service import transcribe_voice_clip
        from src.main.utils.core.error_codes import to_status_code

        try:
            audio_bytes = await audio.read()
            content_type = audio.content_type
            db = SessionLocal()
            try:
                return await transcribe_voice_clip(
                    db=db,
                    user_id=user_id,
                    audio_bytes=audio_bytes,
                    content_type=content_type,
                    language=language or None,
                    focus_document_id=focus_document_id or None,
                )
            finally:
                db.close()
        except Exception as e:
            logger.error("Voice transcribe failed: %s", e)
            return {"text": "", "error": to_status_code(e)}

    @app.post("/api/v1/voice/turn-complete", tags=["Voice"])
    async def voice_turn_complete(request: dict | None = None):
        """Semantic endpointing: is the user's spoken thought finished?

        The voice client calls this after each silence-ended segment. When it
        returns complete=false the client holds the fragment and stitches the
        next segment onto it instead of sending a half-sentence to the LLM —
        so "what do you know about… <pause> …Baal" arrives as one turn.

        Body: {"text": "<accumulated transcript so far>"}
        Response: {"complete": bool}
        """
        from src.main.service.speech.voice_mode_service import judge_turn_complete

        text = (request or {}).get("text", "") if isinstance(request, dict) else ""
        try:
            complete = await judge_turn_complete(str(text or ""))
            return {"complete": bool(complete)}
        except Exception as e:
            logger.debug("voice turn-complete failed (defaulting complete): %s", e)
            # Fail-open: never strand the user waiting on a reply.
            return {"complete": True}

    @app.post("/api/v1/voice/chat", tags=["Voice"])
    async def voice_chat(request: dict | None = None):
        """Low-latency conversational LLM for voice mode.

        Fast-by-default: plain LLM call (1-3 s). The agent is given progressively
        richer tools depending on what the caller scopes the conversation to:

        - ``collection_ids`` + ``user_id`` → optional ``search_collection(query)``
          tool (pgvector similarity, skip rerank, ~6-10 s escalated round-trip).
        - ``document_ids`` + ``user_id`` → Phase-1 lexical tools
          ``grep_search`` and ``cat_document`` against ``documents.content``.
          Millisecond-scale, returns verbatim text + surrounding context windows
          — ideal for a hands-free chat where the user is "reading a book aloud"
          and wants to dig into the material.

        Casual conversation never touches retrieval. The system prompt tells the
        LLM the latency cost of each tool so it self-rations.

        Request body:
            {
              "text": "...",
              "language": "hr",
              "history": [{"role", "content"}],
              "collection_ids": ["uuid", ...]   # optional — enables search_collection
              "document_ids":   ["uuid", ...]   # optional — enables grep + cat
              "user_id": "uuid"                 # required when either scope set
            }

        Response:
            {"text": "...", "used_rag": bool}
        """
        if request is None:
            request = {}
        import uuid as _uuid

        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        try:
            user_text = str(request.get("text") or "").strip()
            if not user_text:
                return {"text": "", "error": "empty_text"}
            language = (request.get("language") or "en").lower()
            history = request.get("history") or []
            raw_collection_ids = request.get("collection_ids") or []
            raw_document_ids = request.get("document_ids") or []
            user_id = str(request.get("user_id") or "").strip()
            # Active workspace ID for the workspace-introspection tools below
            # (list_workspace_collections, list_documents_in_collection, …).
            # Frontend sends the same workspace the user has open in the chat
            # surface so the LLM can answer "what's in my library" questions
            # without an explicit @-tag.
            workspace_id = str(request.get("workspace_id") or "").strip()

            # Only attach the tool when we have both the user AND collections.
            # No collections = no grounding surface = keep the fast path clean.
            collection_ids: list = []
            for cid in raw_collection_ids:
                try:
                    collection_ids.append(_uuid.UUID(str(cid)))
                except Exception:
                    continue

            document_ids: list = []
            for did in raw_document_ids:
                try:
                    document_ids.append(_uuid.UUID(str(did)))
                except Exception:
                    continue

            lang_name = language_name(language)
            lang_clause = ""
            if language != "en":
                lang_clause = f" Respond ONLY in {lang_name}, no matter what language the user writes."
            if language == "hr":
                lang_clause += (
                    " Use Croatian standard (ijekavica) — sljedeći NOT sledeći, Također NOT Takođe, "
                    "knjižnica NOT biblioteka, elektronički NOT elektronski."
                )

            # Resolve titles up-front so the system prompt can name the
            # books — without this the LLM answers overview questions
            # with "I don't know which book".
            _doc_titles: dict[str, str] = {}
            _doc_id_strs: list[str] = [str(d) for d in document_ids]
            if document_ids:
                try:
                    from sqlalchemy import text as _sql_text_pre

                    from src.main.utils.database.db_utils import get_db_session as _get_db_pre

                    with _get_db_pre() as _db_meta:
                        _rows = _db_meta.execute(
                            _sql_text_pre("SELECT id, title, filename FROM documents WHERE id = ANY(CAST(:ids AS uuid[]))"),
                            {"ids": _doc_id_strs},
                        ).fetchall()
                        for _r in _rows:
                            _doc_titles[str(_r.id)] = _r.title or _r.filename or "document"
                except Exception as _meta_exc:
                    logger.debug("voice_chat: failed to resolve doc titles: %s", _meta_exc)

            book_list_block = ""
            if _doc_titles:
                _lines = [f"- {tid} → {title}" for tid, title in _doc_titles.items()]
                book_list_block = "\n\nTAGGED BOOKS (document_id → title):\n" + "\n".join(_lines)

            # Load voice prompts from configs/prompts.yaml. Defensive
            # fallback to the Python literal so a missing yaml key never
            # takes voice mode down — see CLAUDE.md Critical Rule #8.
            from src.main.utils.config.loader import resolved_prompts as _resolved_prompts

            _voice_prompts = _resolved_prompts.get("voice_chat", {}) or {}

            def _voice_block(key: str, fallback: str) -> str:
                value = _voice_prompts.get(key)
                return value if isinstance(value, str) and value.strip() else fallback

            tool_clause = ""
            if document_ids and user_id:
                tool_clause = _voice_block(
                    "book_scope_tools",
                    "\n\nThe user is having a hands-free conversation about specific books they have "
                    "@-tagged. Speed matters more than completeness — they're waiting for an answer "
                    "with their voice on. Always know WHICH book the user means before answering; "
                    "the tagged-books list below names them.\n"
                    "- `get_book_summary(document_id)` — pre-computed book-level summary from the "
                    "  document_summaries table. ALWAYS the first call for overview questions like "
                    '  "what is this book about", "summarise the book", "describe the book". '
                    "  Returns 'no_summary' when none was generated yet; in that case fall back to "
                    "  cat_document(id, 0, 6000) to read the opening pages.\n"
                    "- `grep_search(pattern)` — Python regex over the tagged books, returns surrounding "
                    "  text windows. Use this for ANY question with a literal anchor.\n"
                    "- `cat_document(document_id, char_start, char_end)` — pull a contiguous slice.\n"
                    "- `dense_search_in_book(query, k?)` — pgvector semantic top-k restricted to the "
                    "  focused book(s). For CONCEPT questions where the user paraphrases.\n"
                    "- `hybrid_search_in_book(query, k?)` — dense + lexical grep, merged and deduped.\n"
                    "- `traverse_book_hierarchy(document_id)` — flat list of the book's heading tree.\n"
                    "Order of preference: get_book_summary / list_chapter_summaries first, then "
                    "grep_search for literal anchors, traverse_book_hierarchy for structure, "
                    "dense_search_in_book for concepts, hybrid_search_in_book when both.",
                )
            elif collection_ids and user_id:
                tool_clause = _voice_block(
                    "collection_scope_tools",
                    "\n\nYou have an OPTIONAL tool `search_collection(query)` that "
                    "looks up passages from the user's own library. Use it ONLY when "
                    "the question clearly needs specific content from their documents "
                    "(named books, quotes, detailed facts). For casual chat, reasoning, "
                    "or general knowledge — answer from memory, DO NOT call the tool. "
                    "Calling the tool adds ~5 seconds. Speed matters.",
                )

            # Workspace-introspection tool block. Independent of the
            # tagged-book / collection clauses above — answers "what's in
            # my library" questions without forcing an @-tag.
            workspace_tool_clause = ""
            if user_id and workspace_id:
                workspace_tool_clause = _voice_block(
                    "workspace_tools",
                    "\n\nYou ALSO have read-only tools that introspect the user's "
                    "library state. Call them when the user asks about WHAT they "
                    "have (not WHAT IS IN a book — that's grep_search/cat_document):\n"
                    '- `list_workspace_collections(query?)` — "which collections do I have?". '
                    "Returns name + document count per collection. "
                    "ALWAYS pass `query` when the user names a specific collection "
                    '(e.g. "UFO", "alchemy") — an unfiltered call alphabetically caps '
                    "at 50 and will silently miss collections later in the alphabet.\n"
                    '- `list_documents_in_collection(collection_id, query?)` — "which '
                    'books are in collection X?". Optional title substring filter.\n'
                    "- `search_documents_by_metadata(title?, year_from?, year_to?, file_type?)` — "
                    "cross-collection metadata search inside the active workspace.\n"
                    "- `list_user_papers(query?)` — the user's own generated research "
                    "papers (Scrapalot paper-generation flow output).\n"
                    "- `get_workspace_overview()` — one-shot snapshot: workspace name + "
                    'counts. Use this for opener-style questions like "what\'s here?".\n'
                    "- `search_books_by_topic(query, k?)` — TOPIC search "
                    "across the user's whole library (pgvector dense over "
                    "every collection in this workspace). USE THIS when the "
                    "user asks about a subject without first picking a book "
                    '("tell me about element 115", "what does my library say '
                    'about shamanic states"). Returns up to 8 books with '
                    "title + collection + a 300-char snippet. The right next "
                    "move is set_book_focus on the top one or two hits, then "
                    "dive in with dense_search_in_book or grep_search.\n"
                    "- `set_book_focus(document_ids)` — call when the user verbally "
                    "picks a book from a list you just read out (\"let's dig into "
                    'that Carleton book", "tell me more about the second one"), '
                    "OR when search_books_by_topic returned strong hits and you "
                    "want to ground the rest of the turn in them. Pass the "
                    "document_id(s) you returned earlier. After this the next "
                    "turn auto-unlocks grep_search / cat_document / get_book_summary "
                    "for those books — no @-tag needed.\n"
                    "- `list_chapter_summaries(document_id)` — chapter-level summaries "
                    'for a focused book. Use for structural questions: "walk me '
                    'through the chapters", "what\'s chapter three about". Pass the '
                    "document_id from a previous focus or search.\n"
                    "- `grep_in_collection(query, collection_id, max_hits?)` — "
                    "lexical grep across EVERY book in one collection. Use when "
                    "the user names a collection to search "
                    '("pretraži UFO kolekciju za element 115") OR when '
                    "search_books_by_topic landed on a single off-topic book "
                    "and you want to broaden lexically before giving up. Call "
                    "list_workspace_collections(query=name) first to resolve "
                    "the collection_id.\n"
                    "- `web_search(query)` — search the open web (SerpAPI / configured "
                    "provider). Returns up to 8 web hits with title + source + "
                    'snippet — weave them into a spoken reply and lead with "prema '
                    'internet izvorima" / "according to web sources" so the user '
                    "knows it's not from their library.\n"
                    "Each tool caps results at 50 rows. Don't dump tool output "
                    "verbatim — summarise at the length the user is currently "
                    "asking for (see ADAPTIVE LENGTH in the main prompt).\n\n"
                    "AUTO-ESCALATION RULES (do not wait for the user's permission):\n"
                    "0. SANITY-CHECK THE TRANSCRIPT FIRST. Voice transcription "
                    "sometimes mangles a short or spelled-out word into nonsense "
                    '(a spoken "BAAL" can arrive as "B-A-A-L-S-A-D-V-A..."). If '
                    "the topic you received is not a recognizable word, name, or "
                    "phrase in any language — i.e. it reads like something "
                    "misheard rather than something a person would actually say — do NOT "
                    "search, do NOT pick books, and do NOT guess a meaning. Say in "
                    "one short clause that you did not catch it and ask the user to "
                    "repeat or spell it slowly. Presenting unrelated books for a "
                    "garbled query is the single worst failure here; asking again "
                    "is always better. Judge this by meaning, not by any fixed list "
                    "of words.\n"
                    "1. A count=0 from `search_books_by_topic` is NOT proof the "
                    "library is empty, and it is NOT a cue to jump to the web. "
                    "That search ranks by meaning over an embedding index that is "
                    "weakest on non-English phrasing, so a topic the user spoke in "
                    "Croatian can score zero even when the book is right there. "
                    "Before concluding anything, exhaust the library lexically: "
                    "resolve the most relevant collection with "
                    "list_workspace_collections (the user's topic names it — an "
                    "alien-abduction / UFO question points at a UFO collection, an "
                    "alchemy question at an alchemy collection) and run "
                    "grep_in_collection there. Lexical grep is language-agnostic "
                    "and catches exactly what the embedding index missed.\n"
                    "2. If that lexical sweep surfaces a book, set_book_focus on it "
                    "and answer from the library — name the book and recommend it "
                    "as the next thing to read. Only when search_books_by_topic AND "
                    "the grep_in_collection sweep BOTH genuinely come up empty may "
                    "you escalate to web_search, and only after that to your own "
                    "general knowledge. (An off-topic single hit — user asked about "
                    '"element 115", only hit is a Siam-history book — counts as '
                    "empty: don't set_book_focus on it, broaden lexically first.)\n"
                    "3. NEVER respond with \"I can't find that, would you like me "
                    'to search the web?" — that wastes a turn. JUST search the '
                    "web (you have the tool), then answer.\n"
                    "4. When you end up using web or general knowledge, OPEN with "
                    "a one-clause disclaimer so the user knows the source: "
                    '"prema internet izvorima …" for web, '
                    '"iz mog općeg znanja, ne iz tvoje biblioteke — …" for '
                    "LLM-only. Never silently invent a citation to a book the "
                    "user does not have.",
                )

            voice_intro = _voice_block(
                "intro",
                "You are a friendly voice assistant having a SPOKEN conversation. "
                "Default reply length: SHORT — 1–3 sentences, max ~60 words. "
                "No markdown, no lists, no citations, no headings. Sound natural "
                "when read aloud.",
            )
            # voice_chat.intent_principles in the yaml already covers the
            # voice-channel intent rules (DEPTH PREFERENCE, brevity, no
            # permission-style questions). We DELIBERATELY do NOT prepend
            # the universal `shared_intent_principles` block here even
            # though it exists in the yaml — adding it on top of the
            # ~4 KB workspace_tools clause pushes total system-prompt
            # length past the sweet spot for gpt-4o-mini and visibly
            # slows multi-tool turns (~18 s on a workspace-wide "element
            # 115" query versus ~5 s without it). The regular text chat
            # surface still gets shared_intent_principles via
            # tool_based_rag_agent.py — that one runs on a richer model
            # with a different latency budget.
            voice_intent = _voice_block(
                "intent_principles",
                "DEPTH PREFERENCE (voice-specific). When you sense the user "
                "is asking for a more thorough answer — any signal of "
                "wanting depth, detail, breadth, more background, a longer "
                "reading, more examples, elaboration — switch to 4–8 "
                "sentences, up to ~250 words. Keep the natural spoken "
                "cadence (no markdown, no bullet lists) but use the extra "
                "room to cite specific passages and connect them. That "
                "preference STICKS for the rest of the conversation. Do "
                "NOT close longer replies with permission-style questions "
                'like "should I continue?" or "want more?" — the user '
                "already asked for depth, just deliver it.",
            )
            # Current-date + stale-knowledge directive. The model's own
            # training is frozen ~2 years back, so without today's date it
            # answers "today / latest / current" questions from memory and
            # quotes facts that are two years out of date. Inject the real
            # date and make web_search mandatory for anything time-sensitive
            # or outside the tagged books. Computed (not a static prompt), so
            # it lives here rather than in prompts.yaml — like book_list_block.
            _today = datetime.date.today().isoformat()
            _web_available = bool(user_id and workspace_id)
            date_clause = (
                f"\n\nTODAY'S DATE IS {_today}. Your own trained knowledge is frozen roughly "
                "two years in the past — treat every fact that can change over time (news, "
                "prices, schedules, who currently holds a role, 'today's' anything, recent "
                "events, ongoing situations) as STALE and unreliable. When the user asks "
                "about something current, time-sensitive, or any subject the tagged books do "
                "NOT cover"
                + (
                    ", you MUST call web_search and answer from what it returns — answering such a "
                    "question from memory is a failure. The search results are short snippets; when "
                    "the answer needs more than a headline, read the most relevant one or two links "
                    "in full with scrape_url before you reply. "
                    if _web_available
                    else ". You do not have web access on this turn, so say plainly that you can't "
                    "verify current information rather than guessing from old training data. "
                )
                + "If the user clearly switches to a NEW topic the tagged/focused books don't "
                "cover, do not stay locked to the book: treat the new topic on its own merits, "
                "and release any agent-set focus by calling set_book_focus with an empty list."
            )
            system_prompt = voice_intro + "\n\n" + voice_intent + lang_clause + date_clause + tool_clause + workspace_tool_clause + book_list_block

            from pydantic_ai import Agent

            agent_cfg = get_system_agent_model(agent_type="synthesis")
            model = agent_cfg.get_pydantic_ai_model()
            agent = Agent(model, system_prompt=system_prompt)

            used_rag_flag = {"hit": False}
            # Tool-controlled focus the response surfaces so the client can
            # persist the active book IDs across turns (replayed as
            # document_ids on the next /voice/chat call), and so the UI can
            # render a thumbnail badge for each focused book. Populated by
            # set_book_focus when registered below: `ids` is the bare UUID
            # list for the next request, `books` carries {document_id, title}
            # pairs the dialog feeds into BookThumbCard.
            focused_docs_state: dict[str, list] = {"ids": [], "books": []}

            if document_ids and user_id:
                # Lexical tools — registered as plain wrappers so the
                # voice agent can call them without the full RAGToolDependencies
                # plumbing the Pydantic-AI tool variants require. Same SQL the
                # text-chat grep_search/cat_document hit.
                from sqlalchemy import text as _sql_text

                from src.main.utils.database.db_utils import get_db_session

                @agent.tool_plain
                async def get_book_summary(document_id: str) -> str:
                    """Return the pre-computed book-level summary for a tagged book.

                    Reads `document_summaries` where `summary_type='book'`. This is
                    the right tool for overview questions ("what is this book
                    about", "summarise", "describe"). Returns 'no_summary' when
                    none was generated yet — fall back to cat_document(id, 0, 6000)
                    in that case.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        try:
                            req_uuid = _uuid.UUID(str(document_id))
                        except Exception:
                            return "document_not_in_scope"
                        if req_uuid not in document_ids:
                            return "document_not_in_scope"
                        with get_db_session() as _db:
                            try:
                                _db.rollback()
                            except Exception as e:
                                logger.debug("Rollback failed in health check: %s", e)
                            row = _db.execute(
                                _sql_text(
                                    "SELECT summary_text FROM document_summaries "
                                    "WHERE document_id = :id AND summary_type = 'book' "
                                    "AND summary_text IS NOT NULL "
                                    "ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST "
                                    "LIMIT 1"
                                ),
                                {"id": str(req_uuid)},
                            ).first()
                            if not row or not row.summary_text:
                                return "no_summary"
                            text = row.summary_text.strip()
                            if len(text) > 8000:
                                text = text[:8000]
                            return text
                    except Exception as e:
                        logger.warning("voice get_book_summary failed: %s", e)
                        return "no_summary"

                from src.main.service.agents.tools import grep_core as _grep_core

                @agent.tool_plain
                async def grep_search(pattern: str) -> str:
                    """Regex search across the user's @-tagged books.

                    Returns up to 8 hits, each prefixed with the book title and a
                    snippet of surrounding context. `pattern` is a Python regex
                    (case-insensitive). Returns 'no_matches' when nothing hits.

                    Implementation delegates to `grep_core.grep_documents_content`
                    so the regex compile / POSIX escape / SQL / snippet logic
                    stays in one place — regular-chat grep_tools.py will adopt
                    the same engine.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        with get_db_session() as _db:
                            hits, _skipped = await _grep_core.grep_documents_content(
                                _db,
                                pattern=pattern,
                                document_ids=_doc_id_strs,
                                max_hits=8,
                                context_chars=300,
                            )
                        if not hits:
                            return "no_matches"
                        lines: list[str] = []
                        for h in hits:
                            title = h.get("title") or _doc_titles.get(h.get("document_id", ""), "document")
                            lines.append(f"[{title}] {h.get('snippet', '')}")
                        return "\n\n".join(lines)
                    except Exception as e:
                        logger.warning("voice grep_search failed: %s", e)
                        return "no_matches"

                @agent.tool_plain
                async def cat_document(document_id: str, char_start: int = 0, char_end: int | None = None) -> str:
                    """Return a contiguous slice of a tagged book's markdown body.

                    Capped at 12 000 characters per call to keep voice replies fast.
                    Returns 'document_not_in_scope' when the id isn't one the user
                    @-tagged.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        with get_db_session() as _db:
                            slice_text, err = await _grep_core.read_document_slice(
                                _db,
                                document_id=document_id,
                                char_start=char_start,
                                char_end=char_end,
                                scope=_doc_id_strs,
                                max_chars=12_000,
                            )
                        # Voice keeps the old API: out-of-scope / invalid → a
                        # short sentinel the agent can recognise, everything
                        # else → the (possibly empty) slice as a plain string.
                        if err in ("invalid_uuid", "out_of_scope"):
                            return "document_not_in_scope"
                        return slice_text
                    except Exception as e:
                        logger.warning("voice cat_document failed: %s", e)
                        return ""

                # Deeper retrieval — dense / hybrid / hierarchy. Registered
                # alongside grep+cat because they all operate on the same
                # in-scope `document_ids` set (the @-tagged books or the
                # set_book_focus list replayed from the previous turn).
                from src.main.service.agents.tools import book_retrieval_tools as _brt

                _doc_id_strs_for_retrieval = [str(d) for d in document_ids]

                @agent.tool_plain
                async def dense_search_in_book(query: str, k: int = 5) -> dict:
                    """Semantic pgvector top-k restricted to the focused book(s).

                    Use for paraphrased / concept questions where literal
                    grep would miss (e.g. "what does the book say about the
                    shadow", "explain Mercurius"). Returns chunks with
                    chapter title and a 500-char snippet. Skip rerank so
                    voice latency stays under ~800 ms.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        return await _brt.dense_search_in_book(
                            user_id=user_id,
                            document_ids=_doc_id_strs_for_retrieval,
                            query=query,
                            k=k,
                        )
                    except Exception as e:
                        logger.warning("voice dense_search_in_book failed: %s", e)
                        return {"items": [], "count": 0, "error": "lookup_failed"}

                @agent.tool_plain
                async def hybrid_search_in_book(query: str, k: int = 6) -> dict:
                    """Dense + lexical, merged and deduped.

                    Use when the question mixes a literal anchor AND a
                    concept (e.g. "Mercurius in chapter three", "Carleton
                    on shamanism"). Runs dense_search_in_book and a
                    content ILIKE in parallel, dense wins on chunk overlap.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        with get_db_session() as _db:
                            return await _brt.hybrid_search_in_book(
                                _db,
                                user_id=user_id,
                                document_ids=_doc_id_strs_for_retrieval,
                                query=query,
                                k=k,
                            )
                    except Exception as e:
                        logger.warning("voice hybrid_search_in_book failed: %s", e)
                        return {"items": [], "count": 0, "error": "lookup_failed"}

                @agent.tool_plain
                async def traverse_book_hierarchy(document_id: str) -> dict:
                    """Flat list of the book's heading tree.

                    Returns title + depth + heading_level + chunk_range for
                    each entry, up to 60 rows. Use for structural questions
                    ("how many chapters", "list the section headings",
                    "what is chapter four called") — much cheaper than
                    reading any content. Returns {note: 'no_hierarchy'}
                    when the book lacks parsed headings.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        with get_db_session() as _db:
                            return await _brt.traverse_book_hierarchy(
                                _db,
                                document_id=document_id,
                                user_id=user_id,
                            )
                    except Exception as e:
                        logger.warning("voice traverse_book_hierarchy failed: %s", e)
                        return {"items": [], "count": 0, "error": "lookup_failed"}

            elif collection_ids and user_id:

                @agent.tool_plain
                async def search_collection(query: str) -> str:
                    """Search the user's library for passages relevant to `query`.

                    Returns at most 5 short excerpts, one per line, prefixed with
                    the document title. Returns 'no_relevant_content' when the
                    library has nothing on the topic.
                    """
                    try:
                        from src.main.service.retriever.retriever_manager import retriever_manager

                        used_rag_flag["hit"] = True
                        retriever = await retriever_manager.get_retriever(user_id=user_id, retriever_type="pgvector")
                        docs = await retriever.similarity_search(
                            prompt=query,
                            k=5,
                            collection_ids=collection_ids,
                            skip_reranking=True,  # no cross-encoder → saves ~5s
                            # Title/content lexical rescue so a non-English topic
                            # still surfaces a title-matched book the dense-only
                            # path would bury (cross-language "Cover-Up at Roswell").
                            include_lexical=True,
                        )
                        if not docs:
                            return "no_relevant_content"
                        parts: list[str] = []
                        for i, d in enumerate(docs[:5]):
                            title = d.metadata.get("document_title") or d.metadata.get("title") or d.metadata.get("source") or "source"
                            snippet = (d.page_content or "")[:300].strip().replace("\n", " ")
                            parts.append(f"[{i + 1}] {title}: {snippet}")
                        return "\n\n".join(parts)
                    except Exception as e:
                        logger.warning("voice search_collection failed: %s", e)
                        return "no_relevant_content"

            if user_id and workspace_id:
                # Workspace-context tools — let the agent answer "what
                # collections do I have / which books are in X / search by
                # title or year / list my generated papers / give me a
                # snapshot of this workspace" without an @-tag. All five
                # read-only, capped at 50 rows, ACL-checked against
                # collection_workspace_map.
                from src.main.service.agents.tools import workspace_tools as _wt
                from src.main.utils.database.db_utils import get_db_session as _get_db_wt

                @agent.tool_plain
                async def list_workspace_collections(query: str | None = None) -> dict:
                    """User's collections in the active workspace.

                    Returns each collection's name, ID, document count and a
                    short description. Pass `query` (substring of the
                    collection name) when the user asks about a specific
                    collection by name — the user can have hundreds of
                    collections, and an unfiltered call alphabetically caps
                    at 50 rows and silently hides the rest.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        with _get_db_wt() as _db:
                            return await _wt.list_workspace_collections(
                                _db,
                                workspace_id=workspace_id,
                                user_id=user_id,
                                query=query,
                            )
                    except Exception as e:
                        logger.warning("voice list_workspace_collections failed: %s", e)
                        return {"error": "lookup_failed", "items": []}

                @agent.tool_plain
                async def list_documents_in_collection(
                    collection_id: str,
                    query: str | None = None,
                ) -> dict:
                    """Documents inside a single collection of the active workspace.

                    `collection_id` must be a UUID the user owns; foreign IDs are
                    silently rejected. `query` is an optional case-insensitive
                    title/filename substring filter.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        with _get_db_wt() as _db:
                            return await _wt.list_documents_in_collection(
                                _db,
                                collection_id=collection_id,
                                user_id=user_id,
                                query=query,
                            )
                    except Exception as e:
                        logger.warning("voice list_documents_in_collection failed: %s", e)
                        return {"error": "lookup_failed", "items": []}

                @agent.tool_plain
                async def search_documents_by_metadata(
                    title: str | None = None,
                    year_from: int | None = None,
                    year_to: int | None = None,
                    file_type: str | None = None,
                ) -> dict:
                    """Cross-collection metadata search inside the active workspace.

                    Filters: `title` substring, `year_from`/`year_to` for the
                    publication year range, `file_type` (e.g. "pdf", "epub").
                    At least one filter should be set; otherwise this returns
                    the workspace's first 50 documents.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        with _get_db_wt() as _db:
                            return await _wt.search_documents_by_metadata(
                                _db,
                                workspace_id=workspace_id,
                                user_id=user_id,
                                title=title,
                                year_from=year_from,
                                year_to=year_to,
                                file_type=file_type,
                            )
                    except Exception as e:
                        logger.warning("voice search_documents_by_metadata failed: %s", e)
                        return {"error": "lookup_failed", "items": []}

                @agent.tool_plain
                async def list_user_papers(query: str | None = None) -> dict:
                    """User's generated research papers in the active workspace.

                    These are Scrapalot's paper-generation flow output (PDF /
                    Markdown). `query` is an optional title substring filter.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        with _get_db_wt() as _db:
                            return await _wt.list_user_papers(
                                _db,
                                workspace_id=workspace_id,
                                user_id=user_id,
                                query=query,
                            )
                    except Exception as e:
                        logger.warning("voice list_user_papers failed: %s", e)
                        return {"error": "lookup_failed", "items": []}

                @agent.tool_plain
                async def get_workspace_overview() -> dict:
                    """One-shot snapshot of the active workspace.

                    Returns workspace name plus counts (collections, documents,
                    papers). Always small payload — safe for opener-style
                    questions like "what's here?".
                    """
                    used_rag_flag["hit"] = True
                    try:
                        with _get_db_wt() as _db:
                            return await _wt.get_workspace_overview(
                                _db,
                                workspace_id=workspace_id,
                                user_id=user_id,
                            )
                    except Exception as e:
                        logger.warning("voice get_workspace_overview failed: %s", e)
                        return {"error": "lookup_failed"}

                @agent.tool_plain
                async def web_search(query: str) -> dict:
                    """Open-web search (SerpAPI / configured provider).

                    Last-resort fallback when the library has nothing on the
                    topic, or when the user explicitly asks to look online.
                    Returns up to 8 hits with {title, source, link, snippet};
                    on a missing provider key / network failure returns
                    {"items": [], "error": "..."} so the LLM can degrade
                    gracefully to its own general knowledge.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        from src.main.service.web_search.web_search_tools import (
                            web_search as _ws_tool,
                        )

                        # The LangChain @tool decorator wraps the underlying
                        # async function; call .ainvoke() to bypass the
                        # sync-tool entrypoint and stay on the asyncio loop.
                        results = await _ws_tool.ainvoke({"query": str(query)[:200]})
                        items = []
                        for r in results[:8]:
                            items.append(
                                {
                                    "title": getattr(r, "title", "") or "",
                                    "source": getattr(r, "source", "") or "",
                                    "link": getattr(r, "link", "") or "",
                                    "snippet": (getattr(r, "snippet", "") or "")[:400],
                                }
                            )
                        return {"items": items, "count": len(items)}
                    except Exception as e:
                        logger.warning("voice web_search failed: %s", e)
                        return {"items": [], "count": 0, "error": "web_search_unavailable"}

                @agent.tool_plain
                async def scrape_url(url: str) -> dict:
                    """Read the FULL text of a specific web page (not just a snippet).

                    After web_search returns promising hits, call this on the
                    best one or two links to read the page in full for a
                    grounded, current answer — web_search alone only gives
                    short snippets. Returns {title, url, content}. Keep it to
                    1-2 scrapes on voice (each adds 2-10 s).
                    """
                    used_rag_flag["hit"] = True
                    try:
                        from src.main.service.agents.tools.rag_web_tools import scrape_url_core

                        result = await scrape_url_core(str(url), max_chars=6000)
                        return {
                            "title": result.get("title", ""),
                            "url": result.get("url", url),
                            "content": result.get("content", ""),
                            "error": result.get("error", ""),
                        }
                    except Exception as e:
                        logger.warning("voice scrape_url failed: %s", e)
                        return {"title": "", "url": url, "content": "", "error": "scrape_unavailable"}

                @agent.tool_plain
                async def grep_in_collection(
                    query: str,
                    collection_id: str,
                    max_hits: int = 8,
                ) -> dict:
                    """Regex/literal grep across EVERY book in one collection.

                    Use when the user explicitly asks to search a whole
                    collection ("pretraži moju UFO kolekciju za element 115")
                    or when search_books_by_topic landed on a single
                    irrelevant hit and you want to broaden lexically.
                    Returns up to `max_hits` snippets with their document
                    title — feed those into set_book_focus + dense_search_in_book
                    if you find anything promising, or escalate to web_search
                    if you don't.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        _uuid.UUID(str(collection_id))
                    except Exception:
                        return {"items": [], "count": 0, "error": "invalid_collection_id"}
                    try:
                        from sqlalchemy import text as _grep_coll_sql

                        with _get_db_wt() as _db:
                            owner = _db.execute(
                                _grep_coll_sql("SELECT owner_user_id FROM collection_workspace_map WHERE collection_id = CAST(:cid AS uuid)"),
                                {"cid": str(collection_id)},
                            ).first()
                            if not owner or str(owner.owner_user_id) != str(user_id):
                                return {"items": [], "count": 0, "error": "not_found"}
                            from src.main.service.agents.tools import grep_core as _gc_local

                            hits, _skipped = await _gc_local.grep_documents_content(
                                _db,
                                pattern=query,
                                collection_scope=[str(collection_id)],
                                max_hits=max_hits,
                                context_chars=250,
                            )
                        if not hits:
                            return {"items": [], "count": 0}
                        items = [
                            {
                                "document_id": h.get("document_id"),
                                "title": h.get("title"),
                                "snippet": h.get("snippet", ""),
                            }
                            for h in hits
                        ]
                        return {"items": items, "count": len(items)}
                    except Exception as e:
                        logger.warning("voice grep_in_collection failed: %s", e)
                        return {"items": [], "count": 0, "error": "lookup_failed"}

                @agent.tool_plain
                async def search_books_by_topic(query: str, k: int = 8) -> dict:
                    """Workspace-wide content search — find books on a topic.

                    Use when the user asks ABOUT a subject and no book is
                    pinned yet ("tell me about element 115", "what does my
                    library say about shamanism"). Runs pgvector dense
                    across every collection the user owns in this workspace,
                    skips rerank for voice latency, dedups by book.
                    Returns up to `k` distinct books with title, collection,
                    and a 300-char snippet. Follow up with set_book_focus
                    on the top one or two hits.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        with _get_db_wt() as _db:
                            return await _wt.search_books_by_topic(
                                _db,
                                user_id=user_id,
                                workspace_id=workspace_id,
                                query=query,
                                k=k,
                            )
                    except Exception as e:
                        logger.warning("voice search_books_by_topic failed: %s", e)
                        return {"items": [], "count": 0, "error": "lookup_failed"}

                @agent.tool_plain
                async def set_book_focus(document_ids: list[str]) -> dict:
                    """Set the conversation focus to one or more documents.

                    Call this when the user verbally picks a book (or a
                    handful) from a list they just heard — "let's dig into
                    Carleton 2021", "tell me more about that Jung book".
                    The frontend will replay these IDs as document_ids on
                    the next turn so the phase-1 grep / cat tools light up
                    for the same books without an @-tag.

                    Pass an EMPTY list to RELEASE focus when the user switches
                    to a topic the focused books don't cover — the next turn
                    is then no longer scoped to the book and the UI clears the
                    book thumbnails.
                    """
                    used_rag_flag["hit"] = True
                    # Explicit release path: an empty list clears the agent-set
                    # focus. The response carries focused_document_ids=[] which
                    # the client treats as "drop the focused books".
                    if not document_ids:
                        focused_docs_state["ids"] = []
                        focused_docs_state["books"] = []
                        return {"focused_document_ids": [], "books": [], "released": True}
                    try:
                        with _get_db_wt() as _db:
                            result = await _wt.set_book_focus(
                                _db,
                                user_id=user_id,
                                workspace_id=workspace_id,
                                document_ids=document_ids,
                            )
                        if result.get("focused_document_ids"):
                            focused_docs_state["ids"] = result["focused_document_ids"]
                            focused_docs_state["books"] = result.get("books", [])
                        return result
                    except Exception as e:
                        logger.warning("voice set_book_focus failed: %s", e)
                        return {"error": "lookup_failed", "focused_document_ids": [], "books": []}

                @agent.tool_plain
                async def list_chapter_summaries(document_id: str) -> dict:
                    """List all chapter summaries for one of the user's books.

                    Returns up to 50 chapters with title + 800-char summary
                    excerpt. Use after the user has focused on a book and
                    asks "walk me through the chapters" / "what's chapter 3
                    about" / "summarise the structure". For full chapter
                    text fall back to cat_document.
                    """
                    used_rag_flag["hit"] = True
                    try:
                        with _get_db_wt() as _db:
                            return await _wt.list_chapter_summaries(
                                _db,
                                document_id=document_id,
                                user_id=user_id,
                            )
                    except Exception as e:
                        logger.warning("voice list_chapter_summaries failed: %s", e)
                        return {"error": "lookup_failed", "items": []}

            # Compact history — last 20 turns. The prior `[-6:]` cap was a
            # latency optimization but at 100-300 tokens per turn that's
            # only ~600-1800 prompt tokens. gpt-4o-mini has 128K context;
            # 20 turns sits at ~6 KB of prompt and gives the user the
            # multi-turn memory they expect from a normal chat. Reported
            # 2026-05-29: "history ne radi kako treba uspije eventualno
            # zapamtiti samo prošlu poruku ali ne pamti dulje razgovore".
            history_block = ""
            for turn in history[-20:]:
                role = (turn.get("role") or "").strip()
                content = (turn.get("content") or "").strip()
                if role and content:
                    history_block += f"{role.upper()}: {content}\n"
            user_prompt = (history_block + f"USER: {user_text}").strip() if history_block else user_text

            want_stream = bool(request.get("stream"))
            if want_stream:
                import json as _json

                from starlette.responses import StreamingResponse as _StreamingResponse

                # Human-readable phase labels (HR + EN) so the UI can
                # show a meaningful "thinking" line under the orb instead
                # of a generic spinner during 5-20 s multi-tool turns.
                _PHASE_HR = {
                    "search_books_by_topic": "Pretražujem biblioteku po temi…",
                    "grep_in_collection": "Tražim u kolekciji…",
                    "set_book_focus": "Postavljam fokus na knjigu…",
                    "get_book_summary": "Čitam sažetak knjige…",
                    "grep_search": "Tražim citate…",
                    "dense_search_in_book": "Semantički pretražujem knjigu…",
                    "hybrid_search_in_book": "Hibridna pretraga…",
                    "web_search": "Pretražujem internet…",
                    "scrape_url": "Čitam stranicu…",
                    "cat_document": "Čitam knjigu…",
                    "list_workspace_collections": "Provjeravam kolekcije…",
                    "list_documents_in_collection": "Provjeravam knjige…",
                    "search_documents_by_metadata": "Tražim po metapodacima…",
                    "list_user_papers": "Provjeravam radove…",
                    "get_workspace_overview": "Provjeravam workspace…",
                    "traverse_book_hierarchy": "Čitam strukturu knjige…",
                    "list_chapter_summaries": "Čitam sažetke poglavlja…",
                    "search_collection": "Pretražujem kolekciju…",
                }
                _PHASE_EN = {
                    "search_books_by_topic": "Searching library by topic…",
                    "grep_in_collection": "Searching the collection…",
                    "set_book_focus": "Focusing on the book…",
                    "get_book_summary": "Reading book summary…",
                    "grep_search": "Looking for quotes…",
                    "dense_search_in_book": "Semantic search…",
                    "hybrid_search_in_book": "Hybrid search…",
                    "web_search": "Searching the web…",
                    "scrape_url": "Reading the page…",
                    "cat_document": "Reading the book…",
                    "list_workspace_collections": "Checking collections…",
                    "list_documents_in_collection": "Checking documents…",
                    "search_documents_by_metadata": "Searching by metadata…",
                    "list_user_papers": "Checking your papers…",
                    "get_workspace_overview": "Checking workspace…",
                    "traverse_book_hierarchy": "Reading structure…",
                    "list_chapter_summaries": "Reading chapter summaries…",
                    "search_collection": "Searching the collection…",
                }
                _phase_map = _PHASE_HR if language == "hr" else _PHASE_EN

                async def _voice_event_stream():
                    """Yield SSE events: phase / text / final / done."""
                    from pydantic_ai.messages import (
                        FunctionToolCallEvent,
                        FunctionToolResultEvent,
                        PartDeltaEvent,
                        PartStartEvent,
                        TextPart,
                        TextPartDelta,
                    )

                    def _sse(event_type: str, payload: dict) -> str:
                        return f"event: {event_type}\ndata: {_json.dumps(payload)}\n\n"

                    reply_text = ""
                    try:
                        async for ev in agent.run_stream_events(user_prompt):
                            if isinstance(ev, FunctionToolCallEvent):
                                tool_name = getattr(ev.part, "tool_name", "") or ""
                                label = _phase_map.get(tool_name) or ("Pozivam alat…" if language == "hr" else "Calling tool…")
                                yield _sse(
                                    "phase",
                                    {"tool": tool_name, "label": label, "stage": "start"},
                                )
                            elif isinstance(ev, FunctionToolResultEvent):
                                tool_name = getattr(ev.result, "tool_name", "") or ""
                                yield _sse("phase", {"tool": tool_name, "stage": "done"})
                            elif isinstance(ev, PartStartEvent):
                                # pydantic-ai emits the FIRST piece of a text part as
                                # PartStartEvent (it carries the initial content), then
                                # PartDeltaEvent for the rest. Handling only deltas
                                # dropped that first token, so the reply — and its TTS —
                                # started mid-word ("Pozdrav!" → "drav!"). Emit the
                                # starting text too. Tool-call part starts are handled
                                # via FunctionToolCallEvent above, so only TextPart here.
                                part = ev.part
                                if isinstance(part, TextPart):
                                    chunk = part.content or ""
                                    if chunk:
                                        reply_text += chunk
                                        yield _sse("text", {"delta": chunk})
                            elif isinstance(ev, PartDeltaEvent):
                                delta = ev.delta
                                if isinstance(delta, TextPartDelta):
                                    chunk = getattr(delta, "content_delta", "") or ""
                                    if chunk:
                                        reply_text += chunk
                                        yield _sse("text", {"delta": chunk})
                        # Stream done — surface focus state + final payload
                        final: dict = {
                            "text": reply_text.strip(),
                            "used_rag": used_rag_flag["hit"],
                        }
                        if focused_docs_state["ids"]:
                            final["focused_document_ids"] = focused_docs_state["ids"]
                            final["focused_books"] = focused_docs_state["books"]
                        yield _sse("final", final)
                        yield _sse("done", {})
                    except Exception as e:
                        from src.main.utils.core.error_codes import to_status_code

                        logger.error("Voice chat stream failed: %s", e)
                        yield _sse("error", {"error": to_status_code(e)})

                return _StreamingResponse(
                    _voice_event_stream(),
                    media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                )

            result = await agent.run(user_prompt)
            reply = (result.output if isinstance(result.output, str) else str(result.output)).strip()
            response: dict = {"text": reply, "used_rag": used_rag_flag["hit"]}
            if focused_docs_state["ids"]:
                response["focused_document_ids"] = focused_docs_state["ids"]
                response["focused_books"] = focused_docs_state["books"]
            return response
        except Exception as e:
            from src.main.utils.core.error_codes import to_status_code

            logger.error("Voice chat failed: %s", e)
            return {"text": "", "error": to_status_code(e)}

    @app.post("/api/v1/explain/selection", tags=["ViewerActions"])
    async def explain_selection(request: dict | None = None):
        """Explain a passage the reader highlighted in a document viewer.

        Fast path — one direct LLM call on the selection + its neighbours,
        NOT a full RAG retrieval. Target latency ~1-2 s.

        Request body:
            {
              "text": "...",                   # the selection (required, <= 2000 chars)
              "context_before": "...",         # preceding paragraph, optional
              "context_after": "...",          # following paragraph, optional
              "language": "hr",                # reply language (ISO-639 short)
              "depth": "simple"|"standard"|"technical",   # default "standard"
              "document_title": "..."          # optional, improves grounding
            }

        Response:
            {"explanation": "...", "detected_type": "math|code|foreign|...|null"}
        """
        if request is None:
            request = {}
        import re

        from src.main.utils.config.loader import resolved_prompts
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        try:
            selection = str(request.get("text") or "").strip()
            if not selection:
                return {"explanation": "", "error": "empty_text"}
            if len(selection) > 2000:
                selection = selection[:2000]

            language = (request.get("language") or "en").lower()
            depth_raw = str(request.get("depth") or "standard").lower()
            depth = depth_raw if depth_raw in ("simple", "standard", "technical") else "standard"
            context_before = str(request.get("context_before") or "").strip()[:800]
            context_after = str(request.get("context_after") or "").strip()[:800]
            document_title = str(request.get("document_title") or "").strip()[:200] or "unknown"

            lang_name = LANGUAGE_NAMES.get(language, "English")

            template = (resolved_prompts.get("viewer_actions", {}) or {}).get("explain_selection")
            if not template:
                logger.warning("viewer_actions.explain_selection prompt missing from prompts.yaml")
                template = (
                    "Explain the SELECTED text in plain {language_name} at {depth} depth. "
                    "Document title: {document_title}\nBefore: {context_before}\n"
                    "SELECTED: {text}\nAfter: {context_after}"
                )
            prompt_body = template.format(
                language_name=lang_name,
                depth=depth,
                document_title=document_title,
                context_before=context_before or "(none)",
                context_after=context_after or "(none)",
                text=selection,
            )

            from pydantic_ai import Agent

            agent_cfg = get_system_agent_model(agent_type="synthesis")
            model = agent_cfg.get_pydantic_ai_model()
            agent = Agent(
                model,
                system_prompt=("You are a reading companion inside a document viewer. Explain highlighted passages concisely in plain prose."),
            )

            result = await agent.run(prompt_body)
            raw = (result.output if isinstance(result.output, str) else str(result.output)).strip()
            if raw == "NOT_EXPLAINABLE":
                return {"explanation": "", "detected_type": None, "error": "not_explainable"}

            detected_type = None
            match = re.match(r"^\[([a-z]+)\]\s+", raw)
            if match:
                tag = match.group(1)
                if tag in ("math", "code", "foreign", "technical", "figure", "quote"):
                    detected_type = tag
                    raw = raw[match.end() :].strip()

            return {"explanation": raw, "detected_type": detected_type}
        except Exception as e:
            logger.error("Explain selection failed: %s", e)
            return {"explanation": "", "error": str(e)}

    @app.post("/api/v1/explain/similar", tags=["ViewerActions"])
    async def explain_similar(request: dict | None = None):
        """Find passages in the user's library similar to a reader highlight.

        Uses the existing pgvector retriever with `skip_reranking=True` — no
        cross-encoder, so latency stays ~300-800 ms on top of embedding.
        Returns enough metadata per hit for the UI to open the source document
        in the right viewer at the right page.

        Request body:
            {
              "text": "...",                          # required, the highlight
              "user_id": "uuid",                      # required
              "collection_ids": ["uuid", ...],        # required (non-empty)
              "exclude_document_id": "uuid",          # optional — the document
                                                      # the user is reading; we
                                                      # filter it out of hits
                                                      # so the panel surfaces
                                                      # cross-source matches
              "k": 10                                 # optional, default 10,
                                                      # hard cap 25
            }

        Response:
            {
              "results": [
                {
                  "document_id": "uuid",
                  "document_title": "…",
                  "snippet": "… passage …",
                  "page": 12,
                  "chunk_index": 7,
                  "file_type": "pdf"|"epub"|"docx"|null,
                  "score": 0.0-1.0
                }, ...
              ]
            }
        """
        if request is None:
            request = {}
        import uuid as _uuid

        from sqlmodel import select

        try:
            text = str(request.get("text") or "").strip()
            if not text:
                return {"results": [], "error": "empty_text"}
            if len(text) > 2000:
                text = text[:2000]

            user_id = str(request.get("user_id") or "").strip()
            if not user_id:
                return {"results": [], "error": "missing_user_id"}

            raw_collection_ids = request.get("collection_ids") or []
            collection_ids: list = []
            for cid in raw_collection_ids:
                try:
                    collection_ids.append(_uuid.UUID(str(cid)))
                except Exception:
                    continue
            if not collection_ids:
                return {"results": [], "error": "missing_collection_ids"}

            exclude_raw = request.get("exclude_document_id")
            exclude_document_id: str | None = None
            if exclude_raw:
                try:
                    exclude_document_id = str(_uuid.UUID(str(exclude_raw)))
                except Exception:
                    exclude_document_id = None

            k = int(request.get("k") or 10)
            if k < 1:
                k = 10
            if k > 25:
                k = 25
            # Over-fetch a bit so the exclude filter doesn't leave us short.
            fetch_k = k + (5 if exclude_document_id else 0)

            from src.main.service.retriever.retriever_manager import retriever_manager

            retriever = await retriever_manager.get_retriever(user_id=user_id, retriever_type="pgvector")
            docs = await retriever.similarity_search(
                prompt=text,
                k=fetch_k,
                collection_ids=collection_ids,
                skip_reranking=True,
            )

            # Resolve document titles in a single DB round-trip.
            # Wrap SQLAlchemy session in SQLModel's Session to get .exec() +
            # scalar unwrapping on Document rows.
            from sqlmodel import Session as SQLModelSession

            from src.main.config.database import engine as _engine
            from src.main.models.sqlmodel_models import Document

            doc_ids_seen: list[str] = []
            for d in docs:
                did = d.metadata.get("document_id")
                if did and did not in doc_ids_seen:
                    doc_ids_seen.append(str(did))

            title_by_id: dict[str, str] = {}
            filetype_by_id: dict[str, str] = {}
            if doc_ids_seen:
                with SQLModelSession(_engine) as session:
                    rows = session.exec(select(Document).where(Document.id.in_(doc_ids_seen))).all()  # type: ignore[attr-defined]
                    for row in rows:
                        sid = str(row.id)
                        title_by_id[sid] = row.title or row.filename or sid
                        # infer file type from filename extension when not stored
                        fname = (row.filename or "").lower()
                        if fname.endswith(".pdf"):
                            filetype_by_id[sid] = "pdf"
                        elif fname.endswith(".epub"):
                            filetype_by_id[sid] = "epub"
                        elif fname.endswith(".docx"):
                            filetype_by_id[sid] = "docx"

            results: list[dict] = []
            seen_chunks: set[tuple[str, int]] = set()
            for d in docs:
                if len(results) >= k:
                    break
                did = d.metadata.get("document_id")
                if not did:
                    continue
                did = str(did)
                if exclude_document_id and did == exclude_document_id:
                    continue

                chunk_idx_raw = d.metadata.get("chunk_index")
                try:
                    chunk_idx = int(chunk_idx_raw) if chunk_idx_raw is not None else -1
                except (TypeError, ValueError):
                    chunk_idx = -1
                # Dedupe hits that point at the same chunk (can happen with
                # multi-vector chunks splitting a paragraph).
                key = (did, chunk_idx)
                if chunk_idx >= 0 and key in seen_chunks:
                    continue
                seen_chunks.add(key)

                page_raw = d.metadata.get("page") or d.metadata.get("pdf_page") or d.metadata.get("page_number")
                try:
                    page_val = int(page_raw) if page_raw is not None else None
                except (TypeError, ValueError):
                    page_val = None

                snippet = (d.page_content or "").strip()
                if len(snippet) > 400:
                    snippet = snippet[:400].rstrip() + "…"

                score_raw = d.metadata.get("relevance_score") or d.metadata.get("score")
                try:
                    score_val = float(score_raw) if score_raw is not None else None
                except (TypeError, ValueError):
                    score_val = None

                results.append(
                    {
                        "document_id": did,
                        "document_title": title_by_id.get(did, did),
                        "snippet": snippet,
                        "page": page_val,
                        "chunk_index": chunk_idx if chunk_idx >= 0 else None,
                        "file_type": filetype_by_id.get(did),
                        "score": score_val,
                    }
                )

            return {"results": results}
        except Exception as e:
            logger.error("Explain similar failed: %s", e)
            return {"results": [], "error": str(e)}

    @app.post("/api/v1/voice/synthesize", tags=["Voice"])
    async def voice_synthesize(request: dict | None = None):
        """Render a short text response to MP3 for voice-mode playback.

        Uses free Edge-TTS (neural voices, no API key). Streams MP3 bytes back
        directly — the voice-mode UI pipes them into an `<audio>` element.

        Request body:
            {"text": "…", "language": "hr", "voice": "…" (optional override),
             "speed": 1.0 (optional, 0.5-1.5 = -50%..+50%)}
        """
        if request is None:
            request = {}
        from fastapi.responses import StreamingResponse

        try:
            import edge_tts

            text_in = str(request.get("text") or "").strip()
            if not text_in:
                return {"error": "empty_text"}
            lang = (request.get("language") or "en").lower()
            voice = request.get("voice")
            if not voice:
                # Default neural voice per language; mirrors the host-B pick
                # used in the podcast pipeline so the two features sound
                # consistent.
                _default = {
                    "en": "en-US-AndrewMultilingualNeural",
                    "hr": "hr-HR-SreckoNeural",
                    "mk": "mk-MK-AleksandarNeural",
                    "de": "de-DE-ConradNeural",
                    "fr": "fr-FR-HenriNeural",
                    "es": "es-ES-AlvaroNeural",
                    "it": "it-IT-DiegoNeural",
                    "pt": "pt-PT-DuarteNeural",
                    "ru": "ru-RU-DmitryNeural",
                }
                voice = _default.get(lang, _default["en"])

            # User-facing speed multiplier: 1.0 = normal, 0.5 = half, 1.5 = 50% faster.
            # Edge-TTS rate is a percent string like "+10%" / "-25%". Clamp to a
            # comfortable range — Edge-TTS accepts wider but anything outside
            # 0.5..1.5 starts to sound chipmunk / drunk. Default to 1.0 when
            # missing or unparsable so we never block a turn on a bad value.
            try:
                speed = float(request.get("speed") or 1.0)
            except (TypeError, ValueError):
                speed = 1.0
            speed = max(0.5, min(1.5, speed))
            rate_pct = round((speed - 1.0) * 100)
            rate_str = f"{'+' if rate_pct >= 0 else ''}{rate_pct}%"

            communicate = edge_tts.Communicate(text_in, voice, rate=rate_str, pitch="+0Hz")
            chunks: list[bytes] = []
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    chunks.append(chunk["data"])
            # Prepend a fixed silent MP3 segment so the silence is part of
            # the byte stream the browser decodes. This eliminates the
            # first-syllable chop that no client-side trick (canplaythrough,
            # AudioContext pre-warm, currentTime seek, Web Audio decode +
            # silent prepend) could reliably mask, because the priming
            # windows of AudioContext + MP3 decoder + 24 kHz→48 kHz
            # resampler stack up to 100-300 ms on a cold context. See
            # `_get_silent_mp3_prefix` above.
            prefix = _get_silent_mp3_prefix()
            audio_bytes = prefix + b"".join(chunks)

            def _stream():
                yield audio_bytes

            return StreamingResponse(
                _stream(),
                media_type="audio/mpeg",
                headers={"Content-Length": str(len(audio_bytes))},
            )
        except Exception as e:
            logger.error("Voice synthesize failed: %s", e)
            return {"error": str(e)}

    @app.post("/api/v1/podcast/generate", tags=["Podcast"])
    async def generate_podcast(request: dict | None = None):
        """Kick off a NotebookLM-style two-host audio overview of a collection.

        The call returns immediately with the new podcast_id; the heavy work
        (dialogue agent + Edge-TTS render, 60–120 s) runs in the `fast` Celery
        queue. Poll `GET /api/v1/podcast/{id}` or listen to job_progress events
        for status.

        Request body:
            {"user_id": "uuid", "collection_id": "uuid", "language": "hr"}

        Response:
            {"podcast_id": "uuid", "status": "pending"}
        """
        if request is None:
            request = {}
        from src.main.config.database import SessionLocal
        from src.main.service.podcast.podcast_orchestrator import create_podcast_row
        from src.main.workers.celery_app import celery_app

        try:
            user_id = str(request.get("user_id") or "").strip()
            collection_id = str(request.get("collection_id") or "").strip()
            language = (request.get("language") or "en").strip().lower() or "en"
            if not user_id or not collection_id:
                return {"error": "missing_user_or_collection"}
            db = SessionLocal()
            try:
                podcast_id = create_podcast_row(db, collection_id, user_id, language)
            finally:
                db.close()
            celery_app.send_task(
                "scrapalot.generate_podcast",
                args=[podcast_id, collection_id, user_id, language],
                queue="fast",
            )
            return {"podcast_id": podcast_id, "status": "pending"}
        except Exception as e:
            logger.error("Podcast generate failed: %s", e)
            return {"error": str(e)}

    @app.get("/api/v1/podcast/{podcast_id}", tags=["Podcast"])
    async def get_podcast(podcast_id: str):
        """Return the current status + metadata for a podcast row.

        UI polls this while status is `pending | generating_script |
        rendering_audio`; once `completed`, `file_url` is a relative path the
        existing documents/file endpoint can serve.
        """
        from sqlalchemy import text

        from src.main.config.database import SessionLocal

        try:
            db = SessionLocal()
            try:
                row = db.execute(
                    text(
                        "SELECT id, collection_id, user_id, language, status, title, "
                        "file_path, file_size, duration_ms, script_json, error, "
                        "created_at, completed_at "
                        "FROM collection_podcasts WHERE id = :id"
                    ),
                    {"id": podcast_id},
                ).fetchone()
                if not row:
                    return {"error": "not_found"}
                return {
                    "podcast_id": str(row.id),
                    "collection_id": str(row.collection_id),
                    "user_id": str(row.user_id),
                    "language": row.language,
                    "status": row.status,
                    "title": row.title,
                    "file_path": row.file_path,
                    "file_size": row.file_size,
                    "duration_ms": row.duration_ms,
                    "script": row.script_json,
                    "error": row.error,
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                    "completed_at": row.completed_at.isoformat() if row.completed_at else None,
                }
            finally:
                db.close()
        except Exception as e:
            logger.error("Podcast fetch failed: %s", e)
            return {"error": str(e)}

    @app.get("/api/v1/podcast/collection/{collection_id}", tags=["Podcast"])
    async def list_podcasts_for_collection(collection_id: str):
        """List all podcast overviews for a given collection, newest first."""
        from sqlalchemy import text

        from src.main.config.database import SessionLocal

        try:
            db = SessionLocal()
            try:
                rows = db.execute(
                    text(
                        "SELECT id, status, title, language, duration_ms, file_path, "
                        "created_at, completed_at "
                        "FROM collection_podcasts "
                        "WHERE collection_id = :cid "
                        "ORDER BY created_at DESC LIMIT 50"
                    ),
                    {"cid": collection_id},
                ).fetchall()
                return {
                    "podcasts": [
                        {
                            "podcast_id": str(r.id),
                            "status": r.status,
                            "title": r.title,
                            "language": r.language,
                            "duration_ms": r.duration_ms,
                            "file_path": r.file_path,
                            "created_at": r.created_at.isoformat() if r.created_at else None,
                            "completed_at": r.completed_at.isoformat() if r.completed_at else None,
                        }
                        for r in rows
                    ]
                }
            finally:
                db.close()
        except Exception as e:
            logger.error("Podcast list failed: %s", e)
            return {"podcasts": [], "error": str(e)}

    @app.get("/api/v1/podcast/{podcast_id}/audio", tags=["Podcast"])
    async def download_podcast_audio(podcast_id: str):
        """Stream the MP3 file for a completed podcast."""
        import os

        from fastapi.responses import FileResponse
        from sqlalchemy import text

        from src.main.config.database import SessionLocal

        try:
            db = SessionLocal()
            try:
                row = db.execute(
                    text("SELECT file_path, status FROM collection_podcasts WHERE id = :id"),
                    {"id": podcast_id},
                ).fetchone()
                if not row or not row.file_path or row.status != "completed":
                    return {"error": "not_ready"}
                absolute_path = os.path.abspath(row.file_path)
                if not os.path.exists(absolute_path):
                    return {"error": "file_missing"}
                return FileResponse(absolute_path, media_type="audio/mpeg", filename=os.path.basename(absolute_path))
            finally:
                db.close()
        except Exception as e:
            logger.error("Podcast audio stream failed: %s", e)
            return {"error": str(e)}

    @app.post("/api/v1/doi-import", tags=["Collections"])
    async def import_dois(request: dict | None = None):
        """Create virtual documents from a DOI list (Scite item #10).

        Intentionally NOT under `/api/v1/collections/**` because that prefix
        is owned by Kotlin in the gateway routing table. Picking a dedicated
        top-level path avoids the "predicate-list specificity > order" trap
        where a python sub-route loses to the kotlin catch-all.

        Request body:
            {
              "collection_id": "uuid",
              "user_id": "uuid",
              "dois": ["10.1234/abcd", "https://doi.org/...", ...]
            }

        Response:
            {
              "imported": [{doi, document_id, title}],
              "failed":   [{doi, reason}]
            }
        """
        if request is None:
            request = {}
        from src.main.config.database import SessionLocal
        from src.main.service.document.doi_import_service import import_dois_to_collection

        try:
            user_id = str(request.get("user_id") or "").strip()
            collection_id = str(request.get("collection_id") or "").strip()
            dois = request.get("dois") or []
            if not user_id or not collection_id or not dois:
                return {"imported": [], "failed": [], "error": "missing_collection_user_or_dois"}
            db = SessionLocal()
            try:
                result = await import_dois_to_collection(db, user_id, collection_id, dois)
                return result
            finally:
                db.close()
        except Exception as e:
            logger.error("DOI import failed: %s", e)
            return {"imported": [], "failed": [], "error": str(e)}

    @app.get("/api/v1/papers/venues", tags=["Papers"])
    async def list_paper_venues():
        """Return venue-specific paper templates grouped by category.

        Feature 8: Venue-Specific Paper Templates. Venues are defined in
        config.yaml under `deep_research.paper_generation.venues`.
        """
        from src.main.utils.config.loader import resolved_config

        try:
            paper_cfg = (resolved_config.get("deep_research", {}) or {}).get("paper_generation", {}) or {}
            venues_cfg = paper_cfg.get("venues", {}) or {}
            venues = []
            for key, cfg in venues_cfg.items():
                venues.append(
                    {
                        "key": key,
                        "name": cfg.get("name", key),
                        "group": cfg.get("group", "other"),
                        "base_template": cfg.get("base_template", "scientific_paper"),
                        "citation_style": cfg.get("citation_style", "apa"),
                        "tone": cfg.get("tone", "objective"),
                        "word_limit": cfg.get("word_limit"),
                        "figure_limit": cfg.get("figure_limit"),
                        "section_overrides": cfg.get("section_overrides", []),
                    }
                )
            return {"venues": venues}
        except Exception as e:
            logger.error("Failed to list paper venues: %s", e)
            return {"venues": []}

    @app.get("/api/v1/council/{plan_id}", tags=["Research"])
    async def get_council_deliberation(plan_id: str):
        """Return council deliberation data for a research plan (bypasses gRPC proto)."""
        from sqlalchemy import text as sa_text

        from src.main.config.database import SessionLocal

        # noinspection PyBroadException
        try:
            with SessionLocal() as db:
                row = db.execute(
                    sa_text("SELECT council_deliberation FROM research_plans WHERE id = :pid"),
                    {"pid": plan_id},
                ).first()
                if row and row[0]:
                    return row[0]
            return {}
        except Exception:
            return {}

    # noinspection PyUnusedFunction
    @app.get("/health", tags=["System"])
    async def health_check():
        """
        Health check endpoint with initialization status tracking.
        Returns immediately for port detection but includes initialization progress.
        """
        startup_state = get_startup_state()
        status_summary = startup_state.get_status_summary()

        # Full health check for non-Render environments
        try:
            # Basic service check
            health_status = {
                "status": "ok",
                "service": "scrapalot-chat-api",
                "status_summary": status_summary,
                "version": app.version,
                "timestamp": datetime.datetime.now(datetime.UTC).isoformat(),
            }

            # Check for the main application instance
            main_instance = getattr(app.state, "main_instance", None)
            health_status["main_instance"] = "initialized" if main_instance else "not_initialized"

            import asyncio

            from sqlalchemy import text

            from src.main.config.database import engine
            from src.main.utils.redis.client import get_redis_client

            # Database connectivity — real ping, bounded so a down DB can't stall /health
            try:

                def _ping_db() -> None:
                    with engine.connect() as conn:
                        conn.execute(text("SELECT 1"))

                await asyncio.wait_for(asyncio.to_thread(_ping_db), timeout=2.0)
                health_status["database"] = "connected"
            except Exception as db_err:
                health_status["database"] = "error"
                health_status["database_error"] = str(db_err)

            # Redis connectivity — real ping, same bound
            try:
                redis_client = get_redis_client()
                await asyncio.wait_for(asyncio.to_thread(redis_client.ping), timeout=2.0)
                health_status["redis"] = "connected"
            except Exception as redis_err:
                health_status["redis"] = "error"
                health_status["redis_error"] = str(redis_err)

            # Check WebSocket server
            health_status["websocket"] = "available" if websocket_manager.get_app() else "unavailable"

            # Add production environment detection
            hostname = os.environ.get("HOSTNAME", "unknown")
            # noinspection PyTypeChecker
            environment = (
                "prod"
                if (
                    "scrapalot" in hostname.lower()
                    or os.path.exists("/.dockerenv")
                    or os.environ.get("ENVIRONMENT") == "prod"
                    or os.environ.get("NODE_ENV") == "production"
                )
                else "dev"
            )
            health_status["environment"] = environment
            health_status["hostname"] = hostname

            # Add port and binding information for debugging 502 errors
            health_status["server_port"] = "8090"
            health_status["server_host"] = "0.0.0.0"

            # Check MCP server status
            try:
                from src.main.mcp.mcp_server_manager import get_mcp_server_status

                mcp_status = get_mcp_server_status()
                health_status["mcp_server"] = mcp_status["status"]
                if mcp_status["pid"]:
                    health_status["mcp_server_pid"] = mcp_status["pid"]
            except Exception as mcp_err:
                health_status["mcp_server"] = "error"
                health_status["mcp_server_error"] = str(mcp_err)

            # Check background worker health
            try:
                from src.main.utils.jobs.dispatcher import get_worker_health

                worker_health = get_worker_health()
                health_status["workers"] = worker_health
            except Exception as worker_err:
                health_status["workers"] = {
                    "status": "error",
                    "error": str(worker_err),
                }

            # Add overall status
            if all(
                _status not in ["error", "not_initialized", "unavailable"]
                for _status in [
                    health_status.get("main_instance"),
                    health_status.get("database"),
                    health_status.get("redis"),
                ]
            ):
                health_status["status"] = "healthy"
            else:
                health_status["status"] = "degraded"

            return health_status
        except Exception as e6:
            logger.error("Health check failed: %s", str(e6))
            return JSONResponse(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                content={
                    "status": "error",
                    "service": "scrapalot-chat-api",
                    "error": str(e6),
                    "timestamp": datetime.datetime.now(datetime.UTC).isoformat(),
                },
            )

    # noinspection PyUnusedFunction
    @app.get("/ready", tags=["System"])
    async def readiness_check():
        """
        Readiness probe — returns 200 only when ALL initialization tasks (including gRPC)
        have completed. Docker healthcheck uses this to gate traffic to the container.
        """
        from src.main.utils.startup.state import get_startup_state

        startup_state = get_startup_state()
        is_ready = startup_state.is_ready()

        return JSONResponse(
            status_code=200 if is_ready else 503,
            content={
                "ready": is_ready,
                "service": "scrapalot-chat-api",
                "overall_status": startup_state.get_overall_status().value,
                "timestamp": datetime.datetime.now(datetime.UTC).isoformat(),
            },
        )


def create_websocket_test_endpoints(app: FastAPI):
    """
    Create WebSocket testing and debugging endpoints.

    Args:
        app: FastAPI application instance
    """
    from fastapi import Request

    from src.main.utils.config.loader import resolved_config

    # noinspection PyUnusedFunction
    @app.get("/websocket-test", tags=["WebSocket"])
    async def get_websocket_info():
        """Debug endpoint to get WebSocket server configuration for clients."""
        server_host = resolved_config.get("host", "localhost")
        server_port = resolved_config.get("port", 8090)
        # noinspection HttpUrlsUsage
        server_url = f"http://{server_host}:{server_port}"

        return {
            "status": "ok",
            "server_info": "Socket.IO server running",
            "client_config": {
                "url": f"{server_url}/ws",
                "path": "/",  # Empty path since we mount at /ws already
                "transports": ["websocket", "polling"],
            },
        }

    @app.get("/websocket-auth-test", tags=["WebSocket"])
    async def test_websocket_auth(request: Request):
        """Test endpoint to verify authentication for WebSocket connections."""
        auth_header = request.headers.get("Authorization", "")
        origin = request.headers.get("Origin", "Unknown")

        # Extract and validate the token
        token = None
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]

        # For testing, return what we received
        return {
            "status": "ok",
            "auth_received": bool(auth_header),
            "token_extracted": bool(token),
            "token_length": len(token) if token else 0,
            "origin": origin,
            "cors_would_accept": origin == "*" or origin.startswith("http://localhost:") or "localhost" in origin,
            "headers": {k: v for k, v in request.headers.items()},
            "instructions": "If auth_received and token_extracted are false, check your client authentication. "
            "If cors_would_accept is false, check CORS settings.",
        }

    # Simple WebSocket echo endpoint for testing connectivity
    ws_logger = get_logger(__name__)

    @app.websocket("/ws-echo")
    async def websocket_echo_endpoint(websocket: FastAPIWebSocket):
        """Simple WebSocket echo endpoint for testing connectivity."""
        ws_logger.info("🧪 WebSocket echo endpoint reached!")
        try:
            await websocket.accept()
            ws_logger.info("🧪 WebSocket connection accepted!")
            while True:
                data = await websocket.receive_text()
                ws_logger.info("🧪 Received: %s", data)
                await websocket.send_text(f"Echo: {data}")
        except Exception as e:
            ws_logger.error("🧪 WebSocket echo error: %s", e)

    # Direct STOMP WebSocket endpoint on main app (bypasses mounted sub-app)
    # Delegates to websocket_manager for proper subscription management

    @app.websocket("/stomp-direct/ws")
    async def stomp_direct_endpoint(websocket: FastAPIWebSocket):
        """
        Direct STOMP WebSocket endpoint that properly delegates to websocket_manager.
        This ensures subscriptions are registered and messages are delivered.
        """
        from src.main.utils.websocket.manager import logger as ws_mgr_logger
        from src.main.utils.websocket.manager import websocket_manager

        ws_mgr_logger.info("🔌 Direct STOMP endpoint reached - delegating to websocket_manager")

        # Delegate to the proper STOMP connection handler using the singleton
        # This ensures subscriptions are registered and messages are delivered
        await websocket_manager.handle_stomp_connection(websocket)
