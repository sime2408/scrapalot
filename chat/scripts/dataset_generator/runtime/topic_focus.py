"""Topic-focus prompt enrichment from the collection_workspace_map table.

When the pipeline is configured with direct-DB writes, the Kotlin backend
exposes a description column for each collection. We fetch it once at
pipeline startup and splice it into the Q&A prompt so Claude prioritises
collection-relevant insights over generic observations.
"""

from __future__ import annotations

import psycopg2

from scripts.dataset_generator.targets.postgres import DbWriteContext
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


_TOPIC_FOCUS_TEMPLATE = (
    'TOPIC FOCUS — collection "{collection_name}":\n'
    "{description}\n"
    "Prioritize questions that directly address this collection's subject matter. "
    "Generic insights about psychology or society are valuable ONLY when they illuminate "
    "the collection's core topic — not as standalone lessons divorced from it."
)


def fetch_collection_topic_focus(db_ctx: DbWriteContext, collection_name: str) -> str:
    """Return the formatted topic-focus block for ``collection_name``, or ``""``.

    Reads ``collection_workspace_map.description`` from the python DB. Returns
    an empty string when the row is missing, the description is blank, or the
    DB is unreachable — the pipeline degrades gracefully in all three cases.
    """
    try:
        with (
            psycopg2.connect(
                host=db_ctx.db_host,
                port=db_ctx.db_port,
                dbname=db_ctx.python_db,
                user=db_ctx.db_user,
                password=db_ctx.db_password,
                connect_timeout=10,
            ) as conn,
            conn.cursor() as cur,
        ):
            cur.execute(
                "SELECT description FROM collection_workspace_map WHERE collection_name = %s AND workspace_name = %s LIMIT 1",
                (collection_name, db_ctx.workspace_name),
            )
            row = cur.fetchone()
    except Exception as exc:
        logger.warning("Could not fetch collection description for topic focus: %s", exc)
        return ""

    if not row or not row[0]:
        logger.info("No description found for collection '%s' — topic focus disabled", collection_name)
        return ""

    description = row[0].strip()
    logger.info("Loaded topic focus for collection '%s' (%d chars)", collection_name, len(description))
    return _TOPIC_FOCUS_TEMPLATE.format(collection_name=collection_name, description=description)
