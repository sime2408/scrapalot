"""
Content deduplication service for content-addressable file storage.

Provides hash computation, duplicate detection, and cloning of processing
artifacts (embeddings, summaries, graph nodes) when identical content is uploaded.
"""

import hashlib
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.orm import Session

from src.main.models.sqlmodel_models import ContentStore
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def compute_file_hash(file_bytes: bytes) -> str:
    """Compute SHA-256 hash of raw file bytes."""
    return hashlib.sha256(file_bytes).hexdigest()


def find_content_by_hash(db: Session, file_hash: str) -> ContentStore | None:
    """Look up existing content store entry by file hash."""
    # noinspection PyTypeChecker
    return db.query(ContentStore).filter(ContentStore.file_hash == file_hash).first()


def create_or_increment_content_store(
    db: Session,
    file_hash: str,
    file_path: str,
    file_size: int,
    file_type: str | None,
    original_filename: str,
) -> tuple[ContentStore, bool]:
    """
    Create a content store entry or increment ref_count if one already exists.

    Uses INSERT ... ON CONFLICT for race-condition safety.

    Returns:
        Tuple of (content_store_entry, is_new) where is_new indicates
        whether a new entry was created (True) or an existing one was found (False).
    """
    content_store_id = str(uuid4())

    # Attempt upsert with ON CONFLICT
    result = db.execute(
        text("""
            INSERT INTO content_store (id, file_hash, file_path, file_size, file_type,
                                       original_filename, processing_status, ref_count,
                                       created_at, updated_at)
            VALUES (:id, :file_hash, :file_path, :file_size, :file_type,
                    :original_filename, 'pending', 1,
                    NOW(), NOW())
            ON CONFLICT (file_hash) DO UPDATE
            SET ref_count = content_store.ref_count + 1,
                updated_at = NOW()
            RETURNING id, (xmax = 0) AS is_new
        """),
        {
            "id": content_store_id,
            "file_hash": file_hash,
            "file_path": file_path,
            "file_size": file_size,
            "file_type": file_type,
            "original_filename": original_filename,
        },
    )
    row = result.fetchone()
    db.commit()

    # noinspection PyUnresolvedReferences
    actual_id = str(row[0])
    # noinspection PyUnresolvedReferences
    is_new = row[1]

    # noinspection PyTypeChecker
    content_store = db.query(ContentStore).filter(ContentStore.id == actual_id).first()
    if content_store is None:
        raise RuntimeError(f"ContentStore row not found for id: {actual_id}")
    # noinspection PyTypeChecker
    return content_store, bool(is_new)


def decrement_ref_count(db: Session, content_store_id: UUID) -> int:
    """
    Decrement ref_count on a content store entry and return the new count.

    Returns:
        The new ref_count after decrementing. Returns 0 if the entry was deleted.
    """
    result = db.execute(
        text("""
            UPDATE content_store
            SET ref_count = ref_count - 1, updated_at = NOW()
            WHERE id = :id
            RETURNING ref_count
        """),
        {"id": str(content_store_id)},
    )
    row = result.fetchone()
    if not row:
        return 0

    new_count = row[0]

    if new_count <= 0:
        db.execute(
            text("DELETE FROM content_store WHERE id = :id"),
            {"id": str(content_store_id)},
        )

    return max(new_count, 0)


def find_processed_source_document(db: Session, content_store_id: UUID) -> str | None:
    """
    Find a fully processed document that uses the same content store entry.

    Returns:
        The document_id (as string) of a completed source document, or None.
    """
    row = db.execute(
        text("""
            SELECT id FROM documents
            WHERE content_store_id = :cs_id
            AND processing_status = 'completed'
            ORDER BY created_at ASC
            LIMIT 1
        """),
        {"cs_id": str(content_store_id)},
    ).fetchone()
    return str(row[0]) if row else None


def clone_embeddings(
    db: Session,
    source_doc_id: str,
    target_doc_id: str,
    target_collection_id: str,
) -> int:
    """
    Clone embeddings from a source document to a target document in a different collection.

    Finds the langchain_pg_collection UUID for the target collection (creates it if missing),
    then copies all embedding rows with updated document_id in cmetadata.

    Returns:
        Number of embeddings cloned.
    """
    # Get or create langchain_pg_collection entry for the target collection
    lc_row = db.execute(
        text("SELECT uuid FROM langchain_pg_collection WHERE name = :name"),
        {"name": target_collection_id},
    ).fetchone()

    if lc_row:
        target_lc_uuid = str(lc_row[0])
    else:
        target_lc_uuid = str(uuid4())
        db.execute(
            text("""
                INSERT INTO langchain_pg_collection (uuid, name, cmetadata)
                VALUES (:uuid, :name, '{}')
            """),
            {"uuid": target_lc_uuid, "name": target_collection_id},
        )

    # Clone embeddings with updated document_id in metadata
    result = db.execute(
        text("""
            INSERT INTO langchain_pg_embedding (id, collection_id, document, cmetadata, embedding)
            SELECT gen_random_uuid(), CAST(:target_lc_uuid AS uuid), e.document,
                   jsonb_set(
                       COALESCE(e.cmetadata, '{}'),
                       '{document_id}',
                       to_jsonb(CAST(:target_doc_id AS text))
                   ),
                   e.embedding
            FROM langchain_pg_embedding e
            WHERE e.cmetadata->>'document_id' = :source_doc_id
        """),
        {
            "target_lc_uuid": target_lc_uuid,
            "target_doc_id": target_doc_id,
            "source_doc_id": source_doc_id,
        },
    )
    # noinspection PyUnresolvedReferences
    count = result.rowcount
    logger.info(
        "Cloned %d embeddings from document %s to %s (collection %s)",
        count,
        source_doc_id,
        target_doc_id,
        target_collection_id,
    )
    return count


def clone_summaries(
    db: Session,
    source_doc_id: str,
    target_doc_id: str,
    target_user_id: str,
) -> int:
    """
    Clone document summaries from a source to a target document.

    Returns:
        Number of summaries cloned.
    """
    result = db.execute(
        text("""
            INSERT INTO document_summaries (
                id, document_id, user_id, summary_type, summary_text,
                chapter_title, chapter_index, section_heading,
                chunk_start_index, chunk_end_index,
                token_count, model_used, generation_cost,
                created_at, updated_at
            )
            SELECT
                gen_random_uuid(), CAST(:target_doc_id AS uuid), CAST(:target_user_id AS uuid),
                summary_type, summary_text,
                chapter_title, chapter_index, section_heading,
                chunk_start_index, chunk_end_index,
                token_count, model_used, generation_cost,
                NOW(), NOW()
            FROM document_summaries
            WHERE document_id = CAST(:source_doc_id AS uuid)
        """),
        {
            "target_doc_id": target_doc_id,
            "target_user_id": target_user_id,
            "source_doc_id": source_doc_id,
        },
    )
    # noinspection PyUnresolvedReferences
    count = result.rowcount
    logger.info("Cloned %d summaries from document %s to %s", count, source_doc_id, target_doc_id)
    return count


async def clone_graph_nodes(source_doc_id: str, target_doc_id: str, target_collection_id: str, target_workspace_id: str) -> bool:
    """
    Clone Neo4j graph hierarchy from a source document to a target document.

    Reads the document_hierarchy from the source document and creates a new
    graph structure for the target document.

    Returns:
        True if graph nodes were cloned, False if graph is disabled or no hierarchy exists.
    """
    try:
        from src.main.config.database import SessionLocal
        from src.main.models.sqlmodel_models import Document

        db = SessionLocal()
        try:
            # noinspection PyTypeChecker
            source_doc = db.query(Document).filter(Document.id == UUID(source_doc_id)).first()
            if not source_doc or not source_doc.document_hierarchy:
                logger.info("No document hierarchy to clone for document %s", source_doc_id)
                return False

            # Capture values before closing session
            hierarchy_data = source_doc.document_hierarchy
            source_content = source_doc.content
            source_page_count = source_doc.page_count
            source_word_count = source_doc.word_count

            # Copy hierarchy data to target document
            # noinspection PyTypeChecker
            target_doc = db.query(Document).filter(Document.id == UUID(target_doc_id)).first()
            if not target_doc:
                return False

            target_filename = target_doc.filename
            target_title = target_doc.title

            target_doc.document_hierarchy = hierarchy_data
            target_doc.content = source_content
            target_doc.page_count = source_page_count
            target_doc.word_count = source_word_count
            db.commit()
        finally:
            db.close()

        # Create graph nodes for the target document
        from src.main.service.document_processing.documents import get_graph_integration_service

        graph_service = get_graph_integration_service()
        if not graph_service or not graph_service.is_graph_enabled():
            logger.info("Graph features disabled, skipping graph cloning")
            return False

        graph_service.create_document_hierarchy(
            document_id=target_doc_id,
            collection_id=target_collection_id,
            workspace_id=target_workspace_id,
            document_data={
                "filename": target_filename,
                "title": target_title,
                "document_hierarchy": hierarchy_data,
            },
            enriched_documents=[],
        )
        logger.info("Cloned graph hierarchy from document %s to %s", source_doc_id, target_doc_id)
        return True

    except ImportError:
        logger.warning("Graph services not available for cloning")
        return False
    except Exception as e:
        logger.error("Error cloning graph nodes from %s to %s: %s", source_doc_id, target_doc_id, e)
        return False


async def clone_all_artifacts(
    db: Session,
    source_doc_id: str,
    target_doc_id: str,
    target_collection_id: str,
    target_user_id: str,
    target_workspace_id: str,
) -> dict:
    """
    Clone all processing artifacts from the source to the target document.

    Clones embeddings, summaries, and graph nodes.
    Updates the target document status to 'completed'.

    Returns:
        Dict with clone counts and status.
    """
    from src.main.models.sqlmodel_models import Document

    embeddings_count = clone_embeddings(db, source_doc_id, target_doc_id, target_collection_id)
    summaries_count = clone_summaries(db, source_doc_id, target_doc_id, target_user_id)
    graph_cloned = await clone_graph_nodes(source_doc_id, target_doc_id, target_collection_id, target_workspace_id)

    # Copy content and metadata from source to target
    # noinspection PyTypeChecker
    source_doc = db.query(Document).filter(Document.id == UUID(source_doc_id)).first()
    # noinspection PyTypeChecker
    target_doc = db.query(Document).filter(Document.id == UUID(target_doc_id)).first()
    if source_doc and target_doc:
        target_doc.processing_status = "completed"
        target_doc.processing_progress = 100.0
        target_doc.processing_error = None
        target_doc.content = source_doc.content
        target_doc.page_count = source_doc.page_count
        target_doc.word_count = source_doc.word_count
        target_doc.content_hash = source_doc.content_hash
        target_doc.document_hierarchy = source_doc.document_hierarchy
        target_doc.file_metadata = source_doc.file_metadata
        target_doc.extracted_metadata = source_doc.extracted_metadata
        db.commit()
        logger.info("Updated target document %s status to completed (dedup clone)", target_doc_id)

    return {
        "embeddings_cloned": embeddings_count,
        "summaries_cloned": summaries_count,
        "graph_cloned": graph_cloned,
    }


async def notify_dedup_waiters(db: Session, content_store_id: UUID, source_doc_id: str) -> int:
    """
    After a document finishes processing, clone artifacts to all pending_dedup documents
    that reference the same content store entry.

    Returns:
        Number of waiting documents that were processed.
    """
    waiters = db.execute(
        text("""
            SELECT d.id, d.collection_id
            FROM documents d
            WHERE d.content_store_id = :cs_id
            AND d.processing_status = 'pending_dedup'
            AND d.id != CAST(:source_id AS uuid)
        """),
        {"cs_id": str(content_store_id), "source_id": source_doc_id},
    ).fetchall()

    if not waiters:
        return 0

    logger.info("Found %d pending_dedup documents waiting for content store %s", len(waiters), content_store_id)

    processed = 0
    for waiter in waiters:
        waiter_id = str(waiter[0])
        waiter_collection_id = str(waiter[1])
        try:
            # Resolve workspace info for the waiter's collection
            cwm_row = db.execute(
                text("SELECT workspace_id, owner_user_id FROM collection_workspace_map WHERE collection_id = :cid"),
                {"cid": waiter_collection_id},
            ).fetchone()

            if not cwm_row:
                logger.warning("No workspace mapping for collection %s, skipping dedup waiter %s", waiter_collection_id, waiter_id)
                continue

            workspace_id = str(cwm_row[0])
            owner_user_id = str(cwm_row[1])

            await clone_all_artifacts(
                db=db,
                source_doc_id=source_doc_id,
                target_doc_id=waiter_id,
                target_collection_id=waiter_collection_id,
                target_user_id=owner_user_id,
                target_workspace_id=workspace_id,
            )
            processed += 1
            logger.info("Cloned artifacts to pending_dedup document %s", waiter_id)

        except Exception as e:
            logger.error("Error processing dedup waiter %s: %s", waiter_id, e)
            # Mark the waiter as failed
            from src.main.utils.core.error_codes import to_status_code

            db.execute(
                text("UPDATE documents SET processing_status = 'failed', processing_error = :err WHERE id = :id"),
                # Status code per CLAUDE.md rule #3.
                {"err": to_status_code(e) if "Dedup" not in str(e) else "errorDedupCloneFailed", "id": waiter_id},
            )
            db.commit()

    return processed


async def handle_source_failed(db: Session, content_store_id: UUID, error_message: str) -> int:
    """
    When a source document's processing fails, propagate failure to all pending_dedup waiters.

    Returns:
        Number of waiters marked as failed.
    """
    # Status code per CLAUDE.md rule #3.
    result = db.execute(
        text("""
            UPDATE documents
            SET processing_status = 'failed',
                processing_error = :err
            WHERE content_store_id = :cs_id
            AND processing_status = 'pending_dedup'
        """),
        {"err": "errorSourceProcessingFailed", "cs_id": str(content_store_id)},
    )
    # noinspection PyUnresolvedReferences
    count = result.rowcount
    if count > 0:
        db.commit()
        logger.info("Marked %d pending_dedup documents as failed for content store %s", count, content_store_id)
    return count
