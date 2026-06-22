"""
Service for auto-generating collection descriptions using LLM.

Generates concise descriptions based on collection name and document titles,
enabling the agentic RAG collection_selector agent to match queries to the
right collections.
"""

import asyncio
from uuid import UUID

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Bounds concurrent description generations. Startup reconciliation schedules one
# task per collection lacking a description (50+ in a large workspace). Without a
# gate they all run at once, and since each held a DB connection across its LLM
# call, the connection pool (size 10 + overflow 15) was exhausted with sessions
# stuck "idle in transaction" — starving the FastAPI lifespan startup so port
# 8090 never bound and the container went unhealthy. Cap the fan-out.
_GEN_SEMAPHORE = asyncio.Semaphore(3)


async def generate_and_store_description(collection_id: UUID, force: bool = False) -> None:
    """Generate an LLM-based description for a collection and store it.

    Args:
        collection_id: Collection UUID
        force: If True, overwrite existing description
    """
    async with _GEN_SEMAPHORE:
        await _generate_and_store_description(collection_id, force)


async def _generate_and_store_description(collection_id: UUID, force: bool) -> None:
    from src.main.config.database import SessionLocal
    from src.main.service.collection_workspace_cache import update_collection_description

    try:
        from sqlalchemy import text

        # Read phase — open, read, then CLOSE the session BEFORE the slow LLM
        # call. Holding a pooled connection (with an open transaction) across
        # network I/O is what pinned 25+ sessions "idle in transaction" and
        # exhausted the pool. Never await a remote call while a session is open.
        db = SessionLocal()
        try:
            row = db.execute(
                text("SELECT collection_name, description FROM collection_workspace_map WHERE collection_id = :cid"),
                {"cid": str(collection_id)},
            ).fetchone()

            if not row:
                logger.debug("Collection %s not found in cache, skipping description generation", collection_id)
                return

            if row.description and not force:
                logger.debug("Collection %s already has a description, skipping", collection_id)
                return

            collection_name = row.collection_name or "Unnamed"

            doc_rows = db.execute(
                text("SELECT filename FROM documents WHERE collection_id = :cid ORDER BY created_at DESC LIMIT 20"),
                {"cid": str(collection_id)},
            ).fetchall()
            doc_names = [r.filename for r in doc_rows if r.filename]
        finally:
            db.close()

        # LLM call — no DB connection held here.
        description = await _generate_with_llm(collection_name, doc_names)
        if not description:
            return

        # Write phase — fresh short-lived session.
        db = SessionLocal()
        try:
            update_collection_description(db, collection_id, description)
            logger.info("Generated description for collection %s (%s): %s", collection_id, collection_name, description[:80])
        finally:
            db.close()

    except Exception as e:
        logger.warning("Failed to generate description for collection %s: %s", collection_id, e)


async def _generate_with_llm(collection_name: str, document_names: list) -> str:
    """Generate a collection description using LLM with prompts from prompts.yaml."""
    from src.main.utils.config.loader import get_resolved_prompts
    from src.main.utils.llm.agent_model_utils import get_agent_model_string

    model_string = get_agent_model_string()
    provider_type, model_name = model_string.split(":", 1)

    prompts = get_resolved_prompts()
    collection_prompts = prompts.get("collection_management", {})

    if document_names:
        template = collection_prompts.get("description_generation_with_documents", "")
        if template:
            doc_list = "\n".join(f"- {name}" for name in document_names)
            prompt = template.format(
                collection_name=collection_name,
                doc_count=len(document_names),
                doc_list=doc_list,
            )
        else:
            doc_list = ", ".join(document_names[:10])
            prompt = (
                f"Generate a brief, professional description (2-3 sentences) for a knowledge collection "
                f"named '{collection_name}' containing {len(document_names)} document(s): {doc_list}"
            )
    else:
        template = collection_prompts.get("description_generation_no_documents", "")
        if template:
            prompt = template.format(collection_name=collection_name)
        else:
            prompt = (
                f"Generate a brief, professional description (2-3 sentences) for a knowledge collection "
                f"named '{collection_name}'. Describe what it might be used for based on its name."
            )

    from src.main.service.llm.llm_manager import llm_manager

    llm = await llm_manager.get_llm(
        model_name=model_name,
        provider_type=provider_type,
    )
    if not llm:
        logger.warning("Failed to get LLM instance for description generation")
        return ""

    response = await llm.ainvoke(prompt)
    return response.content if hasattr(response, "content") else str(response)
