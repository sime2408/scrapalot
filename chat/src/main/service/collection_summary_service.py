"""
Collection Memory Digest service.

Synthesizes a collection's per-book summaries into ONE bounded "memory" — a
continuously-refreshed description that (a) answers "themes of the collection"
questions and (b) steers the agentic collection_selector toward the right
collection(s). Kept compact so it never bloats the LLM context window.

The digest is generated on the synthesis model (DeepSeek via agent_type
"collection_digest") and PUBLISHED to Kotlin (source of truth for the collection
description); it is never written straight to the Kotlin-owned table from here.
"""

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import text

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# P→K stream: Kotlin (source of truth for collections.description) consumes this
# and writes the digest UNLESS the user has manually edited the description.
# Low-frequency + per-collection debounced, so a small bounded maxlen is plenty
# and the stream can never grow without bound.
_COLLECTION_SUMMARY_STREAM = "scrapalot:stream:collection_summary"
_STREAM_MAXLEN = 1000

# Hard bounds so the digest can never blow the context window, even if the model
# ignores the word limit in the prompt.
MAX_BOOK_SUMMARIES = 40  # input cap (per-book); huge collections sample the newest
MAX_DIGEST_CHARS = 1600  # output cap (~180 words ≈ ~1100 chars; 1600 is slack)


async def build_collection_digest(collection_id: UUID, db, existing_description: str | None = None) -> str | None:
    """Build the bounded collection memory from per-book summaries.

    Returns the digest text, or None when there is nothing to summarize (no book
    summaries yet) or generation fails. Does NOT persist — the caller publishes
    it to Kotlin.

    When `existing_description` is provided (the user clicked ✨ while editing a
    possibly hand-written description), the synthesis MERGES that text with the
    book summaries — preserving the user's wording/intent and enriching it —
    instead of writing a fresh digest from scratch.
    """
    row = db.execute(
        text("SELECT collection_name FROM collection_workspace_map WHERE collection_id = :cid"),
        {"cid": str(collection_id)},
    ).fetchone()
    if not row:
        logger.debug("Collection %s not in cache, skipping digest", collection_id)
        return None
    collection_name = row.collection_name or "Unnamed"

    summary_rows = db.execute(
        text("""
            SELECT d.title, ds.summary_text, count(*) OVER () AS total
            FROM document_summaries ds
            JOIN documents d ON ds.document_id = d.id
            WHERE ds.summary_type = 'book'
              AND ds.summary_text IS NOT NULL
              AND d.collection_id = :cid
            ORDER BY d.created_at DESC
            LIMIT :limit
        """),
        {"cid": str(collection_id), "limit": MAX_BOOK_SUMMARIES},
    ).fetchall()

    if not summary_rows:
        logger.debug("Collection %s has no book summaries yet, skipping digest", collection_id)
        return None

    total = summary_rows[0].total
    if total > MAX_BOOK_SUMMARIES:
        logger.warning(
            "Collection %s has %d book summaries; digest built from the %d newest",
            collection_id,
            total,
            MAX_BOOK_SUMMARIES,
        )

    blocks = []
    for r in summary_rows:
        title = r.title or "Untitled"
        blocks.append(f"- {title}: {r.summary_text.strip()}")
    book_summaries = "\n".join(blocks)

    digest = await _synthesize(collection_name, len(summary_rows), book_summaries, existing_description)
    if not digest:
        return None

    digest = digest.strip()
    if len(digest) > MAX_DIGEST_CHARS:
        digest = digest[:MAX_DIGEST_CHARS].rsplit(" ", 1)[0] + "…"
        logger.warning("Collection %s digest exceeded %d chars, truncated", collection_id, MAX_DIGEST_CHARS)
    return digest


def publish_collection_digest(collection_id: UUID, description: str) -> bool:
    """Publish a digest to Kotlin via Redis Streams (bounded, guaranteed delivery).

    Kotlin's consumer writes it to collections.description only when the user has
    not manually edited it, then the existing K→P collections stream replicates
    the new value back into the Python collection_workspace_map cache.
    """
    try:
        from src.main.utils.redis.client import get_redis_client

        fields = {
            "event_id": str(uuid4()),
            "type": "COLLECTION_SUMMARY_UPDATED",
            "source": "scrapalot-chat",
            "timestamp": datetime.now(UTC).isoformat(),
            "collection_id": str(collection_id),
            "description": description,
        }
        get_redis_client().xadd(_COLLECTION_SUMMARY_STREAM, fields, maxlen=_STREAM_MAXLEN)
        logger.info("Published collection digest for %s (%d chars)", str(collection_id)[:8], len(description))
        return True
    except Exception as exc:
        logger.warning("Failed to publish collection digest for %s: %s", str(collection_id)[:8], exc)
        return False


async def _synthesize(collection_name: str, book_count: int, book_summaries: str, existing_description: str | None = None) -> str:
    """Run the synthesis model (DeepSeek) over the book summaries.

    With a non-empty `existing_description`, use the refine prompt that merges the
    user's text with the summaries; otherwise build a fresh digest.
    """
    from src.main.service.llm.llm_manager import llm_manager
    from src.main.utils.config.loader import get_resolved_prompts

    prompts = get_resolved_prompts().get("collection_management", {})
    existing = (existing_description or "").strip()
    if existing:
        template = prompts.get("description_refine_with_summaries", "")
        if not template:
            logger.warning("description_refine_with_summaries prompt missing from prompts.yaml")
            return ""
        prompt = template.format(
            collection_name=collection_name,
            book_count=book_count,
            book_summaries=book_summaries,
            existing_description=existing,
        )
    else:
        template = prompts.get("collection_memory_digest", "")
        if not template:
            logger.warning("collection_memory_digest prompt missing from prompts.yaml")
            return ""
        prompt = template.format(
            collection_name=collection_name,
            book_count=book_count,
            book_summaries=book_summaries,
        )

    # Synthesis (free-text) role → resolves to the DeepSeek synthesis model.
    llm = await llm_manager.get_llm(
        model_name="system-synthesis",
        provider_type="system",
        agent_type="collection_digest",
        temperature=0.3,
        max_tokens=500,
    )
    if not llm:
        logger.warning("Could not get synthesis LLM for collection digest")
        return ""

    response = await llm.ainvoke(prompt)
    return response.content if hasattr(response, "content") else str(response)
