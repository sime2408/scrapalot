"""
Backfill embeddings for existing document_summaries rows that have no embedding yet.

Run inside Docker:
    docker exec scrapalot-chat python scripts/backfill/backfill_summary_embeddings.py
"""

import asyncio
from pathlib import Path
import sys

# Ensure project root is on the path
# File now lives at scripts/backfill/backfill_summary_embeddings.py — go up 3 levels to project root.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from sqlalchemy import text  # noqa: E402

from src.main.config.database import SessionLocal  # noqa: E402
from src.main.utils.core.logger import get_logger  # noqa: E402

logger = get_logger(__name__)


async def embed_text(text_to_embed: str) -> list | None:
    try:
        from src.main.service.llm.llm_factory import get_embeddings_model

        model = get_embeddings_model()
        loop = asyncio.get_event_loop()
        vectors = await loop.run_in_executor(None, model.embed_documents, [text_to_embed])
        return vectors[0] if vectors else None
    except Exception as exc:
        logger.warning("Embedding failed: %s", exc)
        return None


async def backfill() -> None:
    db = SessionLocal()
    try:
        rows = db.execute(text("SELECT id, summary_text FROM document_summaries WHERE embedding IS NULL AND summary_text IS NOT NULL")).fetchall()

        logger.info("Found %d summaries without embeddings", len(rows))

        for idx, (row_id, summary_text) in enumerate(rows, 1):
            logger.info("Embedding %d/%d (id=%s)", idx, len(rows), row_id)
            embedding = await embed_text(summary_text)
            if embedding is None:
                logger.warning("Skipping id=%s — embedding returned None", row_id)
                continue

            db.execute(
                text("UPDATE document_summaries SET embedding = CAST(:emb AS vector) WHERE id = :id"),
                {"emb": str(embedding), "id": str(row_id)},
            )
            db.commit()
            logger.info("Updated id=%s", row_id)

        logger.info("Backfill complete")
    finally:
        db.close()


if __name__ == "__main__":
    asyncio.run(backfill())
