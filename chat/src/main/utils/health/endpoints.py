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
