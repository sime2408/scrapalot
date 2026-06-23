"""
DocumentExtrasService gRPC Implementation

Implements the DocumentExtrasService defined in document_extras.proto.
Handles file serving, thumbnails, previews, uploads, reading positions,
and book summary translation.
"""

import asyncio
from datetime import UTC, datetime
import json
import os
import re

# noinspection PyUnresolvedReferences
import google.protobuf.empty_pb2
import grpc

from src.main.grpc import common_pb2, document_extras_pb2, document_extras_pb2_grpc
from src.main.grpc.grpc_utils import grpc_db_session
from src.main.utils.core.error_codes import to_status_code
from src.main.utils.core.logger import get_logger

# Plain or parametrized status code emitted by the backend.
# `errorWorkerDied`            → plain
# `lowExtractionYield:1:2:3`   → parametrized
_STATUS_CODE_RE = re.compile(r"^[a-z][a-zA-Z0-9_]*(:[^:]+)*$")

# ISO 639-1 code to full language name for LLM prompts
LANGUAGE_NAMES = {
    "hr": "Croatian",
    "en": "English",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "pl": "Polish",
    "cs": "Czech",
    "sk": "Slovak",
    "sl": "Slovenian",
    "sr": "Serbian",
    "bs": "Bosnian",
}

logger = get_logger(__name__)


def _format_job_error(raw: str) -> str | None:
    """Reduce a raw Python traceback (from `jobs.error_message`) to a
    camelCase status code that the frontend translates via
    `knowledge.uploader.<code>` (CLAUDE.md rule #3 — backend never emits
    raw English).

    Strategy: pull the terminal exception line out of the traceback, drop
    the fully-qualified module path and our own ``Failed to process …``
    wrapper, then route through `to_status_code()`. Already-coded values
    (the Celery worker increasingly stores codes directly) pass through
    unchanged. Unknown text is truncated and passed through verbatim so
    novel errors stay diagnostic for admins.
    """
    if not raw:
        return None
    last = next((ln.strip() for ln in reversed(raw.splitlines()) if ln.strip()), "")
    if not last:
        return to_status_code(raw[:200])

    # Already a code (plain `errorWorkerDied` or parametrized
    # `lowExtractionYield:1234:567:42`) — return as-is. Without this
    # short-circuit the `partition(":")` below mangles parametrized
    # codes by inserting a space after the first colon
    # (`lowExtractionYield: 1234:567:42`), which then falls out of the
    # parametrized regex and ships raw to the UI.
    if _STATUS_CODE_RE.match(last):
        return last

    # Drop module path prefix: `src.main.…DocumentProcessingError: …` → `DocumentProcessingError: …`
    if ":" in last:
        lhs, _, rhs = last.partition(":")
        rhs_stripped = rhs.strip()
        # If the RHS itself is a status code (our own pipeline raises
        # `DocumentProcessingError("lowExtractionYield:N:M:P")`), unwrap
        # and return it — the exception class name is just noise.
        if _STATUS_CODE_RE.match(rhs_stripped):
            return rhs_stripped
        short_lhs = lhs.rsplit(".", 1)[-1].strip()
        last = f"{short_lhs}: {rhs_stripped}" if short_lhs else rhs_stripped

    # Strip `Failed to process document 'scrapalot_…':` wrapper.
    if "Failed to process document" in last:
        last = last.rsplit(":", 1)[-1].strip()

    if last.lower().startswith("exception:"):
        last = last.split(":", 1)[-1].strip()

    return to_status_code(last)


def _generate_thumbnails_from_temp(temp_path: str, logical_path: str, document_id: str, db=None):
    """
    Generate thumbnails from a temp file and store them at the logical path location.

    The logical_path is where the document WOULD be stored (e.g.,
    /app/data/upload/{user_id}/{workspace_id}/{collection_id}/file.pdf).
    Thumbnails go alongside: file_thumb_small.png, file_thumb_medium.png, etc.

    Args:
        temp_path: Path to the temp file (source for thumbnail generation)
        logical_path: The document's logical file path (target for thumbnail storage)
        document_id: Document UUID (for logging)
        db: Optional DB session for updating file_metadata
    """
    from src.main.service.document.thumbnail_service import ThumbnailService

    if not ThumbnailService.can_generate_thumbnail(temp_path):
        return

    # Ensure the target directory exists
    target_dir = os.path.dirname(logical_path)
    os.makedirs(target_dir, exist_ok=True)

    results = {}
    ext = os.path.splitext(temp_path.lower())[1]
    for size in ThumbnailService.THUMBNAIL_SIZES:
        output_path = ThumbnailService.get_thumbnail_path(logical_path, size)
        if ext in ThumbnailService.SUPPORTED_EPUB_EXTENSIONS:
            results[size] = ThumbnailService.generate_epub_thumbnail(
                temp_path,
                output_path=output_path,
                size=size,
            )
        else:
            results[size] = ThumbnailService.generate_pdf_thumbnail(
                temp_path,
                output_path=output_path,
                size=size,
            )

    generated = sum(1 for v in results.values() if v)
    logger.info("Generated %d thumbnails for document %s at %s", generated, document_id, target_dir)

    # Update file_metadata in DB if a session is provided
    if db and any(results.values()):
        try:
            import json as _json

            from sqlalchemy import text

            row = db.execute(
                text("SELECT file_metadata FROM documents WHERE id = :id"),
                {"id": document_id},
            ).fetchone()
            metadata = {}
            if row and row.file_metadata:
                if isinstance(row.file_metadata, dict):
                    metadata = row.file_metadata
                elif isinstance(row.file_metadata, str):
                    try:
                        metadata = _json.loads(row.file_metadata)
                    except (ValueError, _json.JSONDecodeError):
                        metadata = {}
            metadata["thumbnail"] = {
                "has_thumbnail": True,
                "has_custom": False,
                "sizes": [s for s, p in results.items() if p],
            }
            db.execute(
                text("UPDATE documents SET file_metadata = CAST(:meta AS jsonb) WHERE id = :id"),
                {"meta": _json.dumps(metadata), "id": document_id},
            )
            db.commit()
            logger.info("Updated thumbnail metadata for document %s", document_id)
        except Exception as e:
            logger.warning("Failed to update thumbnail metadata for %s: %s", document_id, str(e))
            db.rollback()


async def _build_document_hierarchy(db, document_id: str, collection_id: str, _user_id: str, graph_service):
    """Build Neo4j hierarchy (Collection→Book→Chapter→Section→Chunk) for a single document."""
    from types import SimpleNamespace

    from sqlalchemy import text

    chunk_rows = db.execute(
        text("""
            SELECT id, document, cmetadata
            FROM langchain_pg_embedding
            WHERE cmetadata->>'document_id' = :document_id
            ORDER BY (cmetadata->>'chunk_index')::int NULLS LAST
        """),
        {"document_id": document_id},
    ).fetchall()

    if not chunk_rows:
        logger.warning("No chunks for hierarchy creation: doc %s", document_id[:8])
        return

    enriched_documents = []
    for row in chunk_rows:
        chunk_metadata = row[2]
        if isinstance(chunk_metadata, str):
            chunk_metadata = json.loads(chunk_metadata)
        metadata = chunk_metadata or {}
        metadata["chunk_id"] = str(row[0])
        enriched_documents.append(SimpleNamespace(page_content=row[1], metadata=metadata))

    # Resolve workspace_id
    workspace_id = ""
    cwm_row = db.execute(
        text("SELECT workspace_id FROM collection_workspace_map WHERE collection_id = :cid LIMIT 1"),
        {"cid": collection_id},
    ).fetchone()
    if cwm_row:
        workspace_id = str(cwm_row[0])

    # Get document metadata for title/filename
    doc_row = db.execute(
        text("SELECT filename, file_metadata FROM documents WHERE id = :did"),
        {"did": document_id},
    ).fetchone()

    document_data = {
        "original_filename": doc_row[0] if doc_row else "",
        "title": doc_row[0] if doc_row else "",
    }

    graph_service.create_document_hierarchy(
        document_id=document_id,
        collection_id=collection_id,
        workspace_id=workspace_id,
        document_data=document_data,
        enriched_documents=enriched_documents,
        db=db,
    )
    logger.info("Created hierarchy for doc %s: %d chunks", document_id[:8], len(enriched_documents))


# noinspection PyUnresolvedReferences
class DocumentExtrasServiceServicer(document_extras_pb2_grpc.DocumentExtrasServiceServicer):
    """DocumentExtrasService gRPC implementation."""

    async def UploadDocument(self, request, context):
        logger.info(
            "DocumentExtras.UploadDocument - collection=%s, filename=%s, user=%s, auto_process=%s, store_file=%s, build_graph=%s, generate_summary=%s",
            request.collection_id,
            request.filename,
            request.user_id,
            request.auto_process,
            request.store_file,
            getattr(request, "build_graph", "N/A"),
            getattr(request, "generate_summary", "N/A"),
        )
        try:
            import asyncio
            import uuid

            from src.main.config.database import SessionLocal
            from src.main.service.document.documents import DocumentService
            from src.main.utils.documents.utils import is_valid_document_type, sanitize_filename
            from src.main.utils.files.paths import extract_relative_upload_path, normalize_path_for_db

            if not is_valid_document_type(request.filename):
                return document_extras_pb2.UploadDocumentResponse(
                    success=False,
                    error="Invalid file type",
                )

            db = SessionLocal()
            try:
                service = DocumentService(db=db)
                sanitized_filename = sanitize_filename(request.filename)

                # HARD storage-quota gate — this gRPC handler is THE entry
                # point for both Kotlin upload endpoints (multipart and
                # streaming), so enforcing here covers them all BEFORE any
                # bytes are written. The billable size is the original upload
                # size, attributed to the workspace owner (shared-workspace
                # uploads count against the owner, not the uploader); physical
                # dedup does not discount it.
                from src.main.utils.workspaces.access import get_workspace_owner_for_collection
                from src.main.utils.workspaces.quota import check_storage_quota

                owner_info = get_workspace_owner_for_collection(db, request.collection_id)
                if owner_info and request.file_data:
                    quota_check = check_storage_quota(db, owner_info[0], len(request.file_data))
                    if not quota_check.get("allowed", True):
                        logger.warning(
                            "Upload rejected — storage quota exceeded for owner %s (%s)",
                            owner_info[0],
                            quota_check.get("message"),
                        )
                        return document_extras_pb2.UploadDocumentResponse(
                            success=False,
                            error=quota_check.get("message") or "Storage quota exceeded",
                        )

                # Check for duplicate: same filename in the same collection (exclude soft-deleted)
                from sqlalchemy import text as sql_text

                existing = db.execute(
                    sql_text("SELECT id FROM documents WHERE filename = :fn AND collection_id = :cid AND deleted_at IS NULL"),
                    {"fn": sanitized_filename, "cid": request.collection_id},
                ).fetchone()
                if existing:
                    existing_doc_id = str(existing.id)
                    should_store_file = request.store_file

                    # Pull the full state of the existing row up front so we can
                    # decide whether re-upload should silently skip, recover
                    # the failed run, or kick processing again.
                    existing_row = db.execute(
                        sql_text("SELECT file_path, file_stored, processing_status, processing_error FROM documents WHERE id = :id"),
                        {"id": existing_doc_id},
                    ).fetchone()
                    existing_file_path = existing_row.file_path if existing_row else ""
                    existing_file_stored = existing_row.file_stored if existing_row else False
                    existing_status = existing_row.processing_status if existing_row else None
                    existing_error = (existing_row.processing_error or "") if existing_row else ""

                    # Recovery flow: re-upload of a previously FAILED doc is
                    # treated as the user's intent to retry. Overwrite the
                    # stored file (or attach one if it was memory-only and now
                    # we have bytes), reset the doc to 'pending', clear the
                    # error, and enqueue a fresh Celery task. The single
                    # exception is OCR-deferred failures: those are
                    # intentional fail-fast and require explicit user action
                    # (enable OCR + click Retry), not a silent re-run.
                    if existing_status == "failed" and not existing_error.startswith("Scanned PDF") and request.file_data:
                        try:
                            import tempfile as _tempfile

                            if should_store_file:
                                # Stored mode: persist into the collection
                                # upload path so the file lives across runs.
                                recovery_path_info = service.get_collection_upload_path(request.collection_id)
                                if not recovery_path_info["success"]:
                                    raise RuntimeError(recovery_path_info.get("error", "no upload path"))
                                recovery_upload_path = recovery_path_info["upload_path"]
                                os.makedirs(recovery_upload_path, exist_ok=True)
                                recovery_full_path = os.path.join(recovery_upload_path, sanitized_filename)
                                with open(recovery_full_path, "wb") as f:
                                    f.write(request.file_data)
                                # noinspection PyTypeChecker
                                recovery_db_path = normalize_path_for_db(extract_relative_upload_path(recovery_full_path)) or ""
                                recovery_db_size = len(request.file_data)
                            else:
                                # Memory-only (e.g. anthropology) — never
                                # persist bytes on disk. Stage them in the
                                # shared /app/data/tmp dir so the worker can
                                # read; cleanup_file_after=true on the task
                                # deletes the tmpfile post-processing.
                                shared_tmp_dir = "/app/data/tmp"
                                os.makedirs(shared_tmp_dir, exist_ok=True)
                                # Cap filename to stay under the 255-byte path
                                # limit (long titles → [Errno 36]); keep extension.
                                _rcv_root, _rcv_ext = os.path.splitext(sanitized_filename)
                                _rcv_safe = (_rcv_root[:150] + _rcv_ext) if len(sanitized_filename) > 150 else sanitized_filename
                                tmp = _tempfile.NamedTemporaryFile(  # noqa: SIM115 — delete=False, closed in finally, path outlives block
                                    prefix=f"scrapalot_{existing_doc_id}_",
                                    suffix=f"_{_rcv_safe}",
                                    delete=False,
                                    dir=shared_tmp_dir,
                                )
                                try:
                                    tmp.write(request.file_data)
                                finally:
                                    tmp.close()
                                recovery_full_path = tmp.name
                                # Keep the existing logical file_path on the
                                # row — we are not changing the on-disk
                                # storage contract for this collection.
                                recovery_db_path = (existing_file_path or "").lstrip("/")
                                recovery_db_size = 0

                            db.execute(
                                sql_text(
                                    "UPDATE documents SET "
                                    "  file_stored = :stored, "
                                    "  file_path = :file_path, "
                                    "  file_size = :file_size, "
                                    "  processing_status = 'pending', "
                                    "  processing_error = NULL, "
                                    "  updated_at = NOW() "
                                    "WHERE id = :doc_id"
                                ),
                                {
                                    "stored": bool(should_store_file),
                                    "file_path": recovery_db_path,
                                    "file_size": recovery_db_size,
                                    "doc_id": existing_doc_id,
                                },
                            )
                            db.commit()
                            logger.info(
                                "Recovering failed doc %s '%s' — wrote bytes to %s (stored=%s), marked pending, enqueueing Celery task",
                                existing_doc_id,
                                sanitized_filename,
                                recovery_full_path,
                                should_store_file,
                            )
                            from src.main.workers.tasks.document_tasks import process_document_task

                            recovery_job_id = str(uuid.uuid4())
                            process_document_task.delay(
                                recovery_job_id,
                                existing_doc_id,
                                request.collection_id,
                                request.user_id,
                                recovery_full_path,
                                False,  # build_graph
                                True,  # generate_summary
                                not should_store_file,  # cleanup_file_after — true for memory-only tmpfile
                            )
                            return document_extras_pb2.UploadDocumentResponse(
                                success=True,
                                document_id=existing_doc_id,
                                message="Recovered failed document — reprocessing",
                            )
                        except Exception as recovery_err:
                            logger.warning(
                                "Recovery flow for failed doc %s raised %s; falling through to default skip",
                                existing_doc_id,
                                recovery_err,
                            )

                    logger.info(
                        "Duplicate check for '%s': existing_file_stored=%s, should_store_file=%s, has_file_data=%s",
                        sanitized_filename,
                        existing_file_stored,
                        should_store_file,
                        bool(request.file_data),
                    )

                    if not existing_file_stored and should_store_file and request.file_data:
                        logger.info(
                            "Upgrading memory-only document '%s' (id=%s) to full document with physical file",
                            sanitized_filename,
                            existing_doc_id,
                        )
                        # Resolve upload path and save file
                        path_info = service.get_collection_upload_path(request.collection_id)
                        if path_info["success"]:
                            upload_path = path_info["upload_path"]
                            os.makedirs(upload_path, exist_ok=True)
                            file_path_absolute = os.path.join(upload_path, sanitized_filename)
                            with open(file_path_absolute, "wb") as f:
                                f.write(request.file_data)

                            # noinspection PyTypeChecker
                            file_path_relative = normalize_path_for_db(extract_relative_upload_path(file_path_absolute)) or ""

                            db.execute(
                                sql_text("""
                                    UPDATE documents
                                    SET file_stored = true, file_path = :file_path, file_size = :file_size
                                    WHERE id = :doc_id
                                """),
                                {
                                    "file_path": file_path_relative,
                                    "file_size": len(request.file_data),
                                    "doc_id": existing_doc_id,
                                },
                            )
                            db.commit()
                            logger.info(
                                "Upgraded doc %s: file_stored=true, path=%s (%d bytes)",
                                existing_doc_id,
                                file_path_relative,
                                len(request.file_data),
                            )

                            # Generate thumbnails for the newly stored file
                            try:
                                from src.main.service.document.thumbnail_service import ThumbnailService

                                if ThumbnailService.can_generate_thumbnail(file_path_absolute):
                                    _generate_thumbnails_from_temp(
                                        file_path_absolute,
                                        file_path_relative,
                                        existing_doc_id,
                                        db,
                                    )
                            except Exception as thumb_err:
                                logger.warning("Thumbnail generation failed during upgrade: %s", str(thumb_err))

                            return document_extras_pb2.UploadDocumentResponse(
                                success=True,
                                document_id=existing_doc_id,
                                message="Memory-only document upgraded to full document with physical file",
                            )

                    # For memory-only mode: generate thumbnails from the uploaded bytes
                    # if this document is missing them.
                    if not should_store_file and request.file_data:
                        from src.main.service.document.thumbnail_service import ThumbnailService

                        if existing_file_path and ThumbnailService.can_generate_thumbnail(existing_file_path):
                            thumb_path = ThumbnailService.get_thumbnail_path(existing_file_path, "medium")
                            if not os.path.exists(thumb_path):
                                import tempfile

                                logger.info(
                                    "Duplicate '%s' — generating missing thumbnails for doc %s",
                                    sanitized_filename,
                                    existing_doc_id,
                                )
                                tmp = tempfile.NamedTemporaryFile(  # noqa: SIM115 — delete=False, closed in finally, path outlives block
                                    prefix=f"scrapalot_thumb_{existing_doc_id}_",
                                    suffix=f"_{sanitized_filename}",
                                    delete=False,
                                    dir="/tmp",
                                )
                                try:
                                    tmp.write(request.file_data)
                                    tmp.close()
                                    _generate_thumbnails_from_temp(
                                        tmp.name,
                                        existing_file_path,
                                        existing_doc_id,
                                        db,
                                    )
                                finally:
                                    if os.path.exists(tmp.name):
                                        os.remove(tmp.name)
                            else:
                                logger.info(
                                    "Duplicate '%s' — thumbnails already exist for doc %s",
                                    sanitized_filename,
                                    existing_doc_id,
                                )

                    return document_extras_pb2.UploadDocumentResponse(
                        success=True,
                        document_id=existing_doc_id,
                        message="Skipped (already exists)",
                    )

                should_store_file = getattr(request, "store_file", True)

                file_size = len(request.file_data)
                content_type = "application/pdf" if sanitized_filename.endswith(".pdf") else "application/octet-stream"
                document_id = str(uuid.uuid4())

                if should_store_file:
                    # Permanent storage path
                    path_info = service.get_collection_upload_path(request.collection_id)
                    if not path_info["success"]:
                        return document_extras_pb2.UploadDocumentResponse(
                            success=False,
                            error=path_info.get("message", "Failed to get upload path"),
                        )
                    upload_path = path_info["upload_path"]
                    os.makedirs(upload_path, exist_ok=True)
                    file_path = os.path.join(upload_path, sanitized_filename)

                    # Writing a 100 MB PDF to disk via the synchronous
                    # builtin takes 200-400 ms and blocks every other
                    # gRPC handler (ListCollectionDocuments, GetProcessingStatus)
                    # on the chat event loop. Run it on the default thread
                    # pool so the loop stays responsive while the disk
                    # write happens.
                    def _sync_write(fp: str, data: bytes) -> None:
                        with open(fp, "wb") as f:
                            f.write(data)

                    await asyncio.to_thread(_sync_write, file_path, request.file_data)
                    logger.info("Saved %d bytes to %s", file_size, file_path)
                    relative_path = extract_relative_upload_path(file_path)
                    if not relative_path:
                        relative_path = normalize_path_for_db(file_path)
                    db_file_size = file_size
                    db_file_path = relative_path
                else:
                    # Memory-only: write to shared-volume temp dir so
                    # scrapalot-workers can read the file too. Historically
                    # this used /tmp in the chat container, which blocked
                    # every memory-only upload from being routed through
                    # Celery (workers can't read chat's private /tmp).
                    # Writing under /app/data/tmp/ lets us use the same
                    # Celery pipeline as stored-file uploads — parse/chunk/
                    # embed happens off the chat event loop, chat stays
                    # responsive to list/stats. The worker deletes the
                    # tmpfile on task completion (cleanup_file_after=True
                    # in the Celery dispatch below), preserving the
                    # ephemeral semantic.
                    import tempfile

                    shared_tmp_dir = "/app/data/tmp"
                    os.makedirs(shared_tmp_dir, exist_ok=True)

                    def _sync_write_tmp(doc_id: str, fname: str, data: bytes) -> str:
                        # Cap the filename component so the temp path stays under
                        # the 255-byte filesystem limit. prefix (scrapalot_<uuid>_)
                        # + tempfile's random token already use ~55 chars; very long
                        # book titles (200+ char PDFs) otherwise fail with
                        # [Errno 36] File name too long. Preserve the extension —
                        # the pipeline selects the parser by suffix.
                        _root, _ext = os.path.splitext(fname)
                        _safe_fname = (_root[:150] + _ext) if len(fname) > 150 else fname
                        tmp = tempfile.NamedTemporaryFile(  # noqa: SIM115 — delete=False, closed in finally, path outlives block
                            prefix=f"scrapalot_{doc_id}_",
                            suffix=f"_{_safe_fname}",
                            delete=False,
                            dir=shared_tmp_dir,
                        )
                        try:
                            tmp.write(data)
                        finally:
                            tmp.close()
                        return tmp.name

                    file_path = await asyncio.to_thread(
                        _sync_write_tmp,
                        document_id,
                        sanitized_filename,
                        request.file_data,
                    )
                    logger.info("Memory-only: wrote %d bytes to shared-volume temp %s", file_size, file_path)

                    # Compute the logical path (same as stored files)
                    path_info = service.get_collection_upload_path(request.collection_id)
                    if path_info["success"]:
                        logical_path = os.path.join(path_info["upload_path"], sanitized_filename)
                        logical_relative = extract_relative_upload_path(logical_path)
                        if not logical_relative:
                            logical_relative = normalize_path_for_db(logical_path)
                        db_file_path = logical_relative
                    else:
                        db_file_path = normalize_path_for_db(f"data/upload/{request.user_id}/{request.collection_id}/{sanitized_filename}")
                    db_file_size = 0

                # Create document record
                doc_result = service.create_document(
                    document_id=document_id,
                    title=sanitized_filename,
                    filename=sanitized_filename,
                    file_path=db_file_path,
                    collection_id=request.collection_id,
                    original_filename=request.filename,
                    content_type=content_type,
                    file_size=db_file_size,
                    user_id=request.user_id,
                    file_stored=should_store_file,
                )

                if not doc_result["success"]:
                    if not should_store_file and os.path.exists(file_path):
                        os.remove(file_path)
                    return document_extras_pb2.UploadDocumentResponse(
                        success=False,
                        error=doc_result.get("message", "Failed to create document"),
                    )

                # Historically the memory-only branch called
                # extract_document_content + pymupdf4llm.to_markdown
                # inline here to seed documents.content before the
                # tmpfile was deleted. That was a 30-60 s synchronous
                # blocker per upload — even wrapped in to_thread it
                # forced each UploadDocument call to wait on its own
                # extraction before it could reach the Celery dispatch
                # below, so a four-file upload batch serialised on the
                # thread pool and Celery stayed idle for minutes.
                # The worker now owns the parsing pipeline (it reads
                # the shared-volume tmpfile, chunks, embeds, writes
                # documents.content via process_uploaded_document). No
                # work to do here — just dispatch and return.

                job_id = doc_result.get("job_id", "")

                # Thumbnail generation used to happen here inline
                # (200-800 ms × 3 sizes per upload on the thread pool —
                # still blocked the specific UploadDocument call from
                # reaching the Celery dispatch below). Thumbnails are
                # non-critical for the upload response and the
                # /thumbnail endpoint regenerates on demand, so they
                # moved out of the hot path. Workers handle bulk
                # thumbnail generation as part of post-processing.

                # Capture post-processing options before returning response
                should_build_graph = getattr(request, "build_graph", False)
                should_generate_summary = getattr(request, "generate_summary", False)

                # Heavy-document deferral gate — only applies when the
                # file was actually saved to disk (`should_store_file`)
                # and the caller asked us to auto-process. Memory-only
                # uploads skip the classifier entirely — their tmpfile
                # is deleted after processing, so leaving them in a
                # 'deferred' state would orphan the bytes.
                #
                # Classifier opens the PDF via pymupdf to probe the
                # text layer — 100-500 ms depending on size. Running
                # it on the thread pool keeps the event loop free, but
                # each UploadDocument call still awaits its own probe
                # before returning; guarding with should_store_file
                # lets memory-only uploads skip straight to dispatch.
                is_heavy, heaviness_reason = False, "skipped_memory_only"
                if should_store_file and request.auto_process:
                    from src.main.utils.documents.utils import classify_upload_heaviness

                    is_heavy, heaviness_reason = await asyncio.to_thread(
                        classify_upload_heaviness,
                        file_path,
                        file_size,
                    )
                deferral_applies = bool(is_heavy and should_store_file and request.auto_process)
                if deferral_applies:
                    from sqlalchemy import text as sa_text_defer

                    db.execute(
                        sa_text_defer(
                            "UPDATE documents SET processing_status = 'deferred',     processing_stats = CAST(:stats AS json) WHERE id = :did"
                        ),
                        {
                            "did": document_id,
                            "stats": json.dumps(
                                {
                                    "deferral_reason": heaviness_reason,
                                    "file_size_bytes": file_size,
                                    "deferred_at": datetime.now(UTC).isoformat(),
                                }
                            ),
                        },
                    )
                    db.commit()
                    logger.info(
                        "Deferred heavy upload doc=%s reason=%s size=%d",
                        document_id,
                        heaviness_reason,
                        file_size,
                    )
                    return document_extras_pb2.UploadDocumentResponse(
                        success=True,
                        document_id=document_id,
                        message=f"deferred:{heaviness_reason}",
                    )

                # Start background processing
                if request.auto_process or not should_store_file:
                    from src.main.service.document_processing.documents import background_process_document

                    async def _process_and_post_tasks(doc_id, fp, cid, uid, svc, memory_only, doc_logical_path, build_graph, gen_summary):
                        try:
                            await background_process_document(
                                document_id=doc_id,
                                file_path=fp,
                                collection_id=cid,
                                user_id=uid,
                                doc_service=svc,
                            )
                        except Exception as proc_err:
                            logger.error("Background processing failed for doc %s: %s", doc_id, str(proc_err))
                            # Mark job as failed so it doesn't stay stuck in 'processing'
                            try:
                                from sqlalchemy import text as sa_text

                                from src.main.config.database import SessionLocal

                                fail_db = SessionLocal()
                                try:
                                    from src.main.utils.core.error_codes import to_status_code as _err_code

                                    err_code = _err_code(proc_err)
                                    fail_db.execute(
                                        sa_text(
                                            "UPDATE jobs SET status = 'failed', "
                                            "description = :msg, completed_at = NOW() "
                                            "WHERE document_id = :did AND status = 'processing'"
                                        ),
                                        # Status code per CLAUDE.md rule #3.
                                        {"did": doc_id, "msg": err_code},
                                    )
                                    fail_db.execute(
                                        sa_text("UPDATE documents SET processing_status = 'failed', processing_error = :err WHERE id = :did"),
                                        {"did": doc_id, "err": err_code},
                                    )
                                    fail_db.commit()
                                finally:
                                    fail_db.close()
                            except Exception as fail_err:
                                logger.error("Failed to mark job as failed for doc %s: %s", doc_id, fail_err)
                            return
                        finally:
                            if memory_only and os.path.exists(fp):
                                if doc_logical_path:
                                    try:
                                        _generate_thumbnails_from_temp(fp, doc_logical_path, doc_id)
                                    except Exception as thumb_gen_err:
                                        logger.warning(
                                            "Thumbnail generation failed for %s (non-critical): %s",
                                            doc_id,
                                            str(thumb_gen_err),
                                        )
                                os.remove(fp)
                                logger.info("Memory-only: deleted temp file %s after processing", fp)

                        # Community Edition: knowledge-graph hierarchy + entity
                        # extraction are not bundled, so graph build is skipped.
                        if build_graph:
                            logger.info("Knowledge graph not available in this edition - skipping graph build for doc %s", doc_id)

                        if gen_summary:
                            try:
                                from uuid import UUID

                                from src.main.config.database import SessionLocal
                                from src.main.service.document.document_summary_service import DocumentSummaryService

                                bg_db = SessionLocal()
                                try:
                                    summary_service = DocumentSummaryService(bg_db)
                                    await summary_service.generate_document_summaries(
                                        document_id=UUID(doc_id),
                                        user_id=UUID(uid),
                                    )
                                    logger.info("Summary generation completed for doc %s", doc_id)
                                finally:
                                    bg_db.close()
                            except Exception as summary_err:
                                logger.warning("Summary generation failed for doc %s: %s", doc_id, str(summary_err))

                    # (Former logical_abs computation removed — no downstream consumer.)

                    # Both stored-file and memory-only uploads dispatch
                    # to the workers container via Celery. Previously the
                    # memory-only branch ran in-process because its
                    # tmpfile was on the chat container's private /tmp;
                    # we now write the tmpfile to /app/data/tmp/ (shared
                    # volume) so workers can read it, and pass
                    # `cleanup_file_after=True` so the task removes the
                    # file on successful completion.
                    # Keeping chat's gRPC event loop free is critical —
                    # a single concurrent upload on the old in-process
                    # path blocked ListCollectionDocuments and
                    # GetProcessingStatus long enough to trip Kotlin's
                    # 15 s client deadline.
                    from src.main.workers.celery_app import celery_app as _celery

                    _celery.send_task(
                        "scrapalot.process_document",
                        kwargs={
                            "job_id": job_id,
                            "document_id": document_id,
                            "collection_id": request.collection_id,
                            "user_id": request.user_id,
                            "file_path": file_path,
                            "build_graph": should_build_graph,
                            "generate_summary": should_generate_summary,
                            "cleanup_file_after": not should_store_file,
                        },
                        queue="documents",
                    )
                    logger.info(
                        "Dispatched scrapalot.process_document to workers for doc=%s "
                        "(store_file=%s, build_graph=%s, generate_summary=%s, cleanup=%s)",
                        document_id,
                        should_store_file,
                        should_build_graph,
                        should_generate_summary,
                        not should_store_file,
                    )

                return document_extras_pb2.UploadDocumentResponse(
                    success=True,
                    document_id=document_id,
                    job_id=job_id,
                    message="Upload successful",
                )
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error in UploadDocument: %s", str(e))
            return document_extras_pb2.UploadDocumentResponse(
                success=False,
                error=str(e),
            )

    async def RegisterDocumentFromMarkdown(self, request, context):
        logger.info(
            "DocumentExtras.RegisterDocumentFromMarkdown - collection=%s, filename=%s, user=%s",
            request.collection_id,
            request.filename,
            request.user_id,
        )
        try:
            from datetime import datetime
            import uuid

            from sqlalchemy import text

            from src.main.config.database import SessionLocal
            from src.main.utils.documents.utils import sanitize_filename
            from src.main.utils.files.paths import normalize_path_for_db

            # Parse optional metadata from the JSON string field
            metadata = {}
            if request.metadata_json:
                try:
                    metadata = json.loads(request.metadata_json)
                except (json.JSONDecodeError, ValueError):
                    logger.warning(
                        "RegisterDocumentFromMarkdown - invalid metadata_json for filename=%s, ignoring",
                        request.filename,
                    )

            # Map source_format to a file_type string
            source_format = metadata.get("source_format", "")
            file_type_map = {
                "pdf": "application/pdf",
                "epub": "application/epub+zip",
                "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "txt": "text/plain",
                "md": "text/markdown",
            }
            file_type = file_type_map.get(str(source_format).lower(), "application/octet-stream")

            file_size = int(metadata.get("file_size", 0))
            page_count = int(metadata.get("pages", 0)) or None

            safe_filename = sanitize_filename(request.filename)
            document_id = str(uuid.uuid4())
            file_path = normalize_path_for_db(f"data/upload/{request.user_id}/{request.collection_id}/{safe_filename}")
            now = datetime.now(UTC)

            file_metadata = json.dumps(
                {
                    "original_filename": request.filename,
                    "content_type": file_type,
                    "file_size": file_size,
                    "source": "batch_ingest",
                }
            )

            db = SessionLocal()
            try:
                # Check for duplicate filename in same collection
                existing = db.execute(
                    text("SELECT id FROM documents WHERE collection_id = :cid AND filename = :fn LIMIT 1"),
                    {"cid": request.collection_id, "fn": safe_filename},
                ).fetchone()
                if existing:
                    logger.info(
                        "RegisterDocumentFromMarkdown - document '%s' already exists in collection %s (id=%s), skipping",
                        safe_filename,
                        request.collection_id,
                        existing.id,
                    )
                    return document_extras_pb2.RegisterMarkdownResponse(
                        success=True,
                        document_id=str(existing.id),
                    )

                db.execute(
                    text("""
                        INSERT INTO documents (
                            id, filename, title, file_path, collection_id,
                            file_size, page_count, file_type,
                            processing_status, content, file_metadata,
                            created_at, updated_at
                        ) VALUES (
                            :id, :filename, :title, :file_path, :collection_id,
                            :file_size, :page_count, :file_type,
                            :processing_status, :content, CAST(:file_metadata AS jsonb),
                            :created_at, :updated_at
                        )
                        """),
                    {
                        "id": document_id,
                        "filename": safe_filename,
                        "title": request.title or safe_filename,
                        "file_path": file_path,
                        "collection_id": request.collection_id,
                        "file_size": file_size,
                        "page_count": page_count,
                        "file_type": file_type,
                        "processing_status": "completed" if request.markdown_content else "pending",
                        "content": request.markdown_content,
                        "file_metadata": file_metadata,
                        "created_at": now,
                        "updated_at": now,
                    },
                )
                db.commit()
                status = "completed" if request.markdown_content else "pending"
                logger.info(
                    "RegisterDocumentFromMarkdown - inserted document %s (%s, no embeddings)",
                    document_id,
                    status,
                )
                return document_extras_pb2.RegisterMarkdownResponse(
                    success=True,
                    document_id=document_id,
                )
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error in RegisterDocumentFromMarkdown: %s", str(e))
            return document_extras_pb2.RegisterMarkdownResponse(
                success=False,
                error=str(e),
            )

    async def GetThumbnail(self, request, context):
        logger.info("DocumentExtras.GetThumbnail - doc=%s, size=%s", request.document_id, request.size)
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal
            from src.main.service.document.thumbnail_service import ThumbnailService

            db = SessionLocal()
            try:
                doc = db.execute(
                    text("""
                        SELECT d.file_path AS doc_path, cs.file_path AS content_path
                        FROM documents d
                        LEFT JOIN content_store cs ON d.content_store_id = cs.id
                        WHERE d.id = :id
                    """),
                    {"id": request.document_id},
                ).fetchone()

                if not doc:
                    return document_extras_pb2.ThumbnailResponse(found=False)

                file_path = doc.content_path or doc.doc_path
                if not file_path:
                    return document_extras_pb2.ThumbnailResponse(found=False)

                size = request.size or "medium"
                thumb_path = ThumbnailService.get_thumbnail_path(file_path, size)

                # Existing thumb on disk: serve unless it is a legacy
                # placeholder copy (byte-identical to the PDF-icon asset).
                # Placeholders translate to "not found" so the FE can render
                # its title-card fallback instead of the generic icon.
                if thumb_path and os.path.exists(thumb_path):
                    if ThumbnailService.is_placeholder_thumbnail(thumb_path):
                        logger.info(
                            "GetThumbnail: placeholder detected for %s, returning not_found",
                            request.document_id,
                        )
                    else:
                        return document_extras_pb2.ThumbnailResponse(
                            found=True,
                            file_path=os.path.abspath(thumb_path),
                            content_type="image/png",
                        )

                # Try to generate on-demand from the original file. Pick PDF
                # vs EPUB by extension — the previous PDF-only path silently
                # returned not_found for every EPUB whose thumb hadn't been
                # pre-rendered by the upload pipeline. Markdown / image /
                # other unsupported source files short-circuit to not_found
                # instead of being handed to PyMuPDF, which spams
                # "Failed to open file" logs for every .md doc.
                if os.path.exists(file_path) and ThumbnailService.can_generate_thumbnail(file_path):
                    ext = os.path.splitext(file_path.lower())[1]
                    if ext in ThumbnailService.SUPPORTED_EPUB_EXTENSIONS:
                        generated = ThumbnailService.generate_epub_thumbnail(file_path, size=size)
                    else:
                        generated = ThumbnailService.generate_pdf_thumbnail(file_path, size=size)
                    if generated and os.path.exists(generated):
                        return document_extras_pb2.ThumbnailResponse(
                            found=True,
                            file_path=os.path.abspath(generated),
                            content_type="image/png",
                        )

                return document_extras_pb2.ThumbnailResponse(found=False)
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error in GetThumbnail: %s", str(e))
            return document_extras_pb2.ThumbnailResponse(found=False)

    async def UploadCustomThumbnail(self, request, context):
        logger.info("DocumentExtras.UploadCustomThumbnail - doc=%s", request.document_id)
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal
            from src.main.service.document.thumbnail_service import ThumbnailService

            db = SessionLocal()
            try:
                row = db.execute(
                    text("SELECT file_path, file_metadata FROM documents WHERE id = :id"),
                    {"id": request.document_id},
                ).fetchone()
            finally:
                db.close()

            if not row:
                return common_pb2.StatusResponse(success=False, message="Document not found")

            import os

            full_path = os.path.join(os.getcwd(), row[0])
            ThumbnailService.save_custom_thumbnail_all_sizes(full_path, request.image_data)

            # Mark this thumbnail as "user upload" so the list endpoint
            # doesn't flip the context-menu label to "Try a different
            # cover" for an image the user explicitly chose. Wipe any
            # leftover cover_tried_ids from a prior download attempt.
            try:
                db_meta = SessionLocal()
                try:
                    raw = row[1]
                    parsed = raw if isinstance(raw, dict) else (json.loads(raw) if raw else {})
                    if isinstance(parsed, str):
                        try:
                            parsed = json.loads(parsed)
                        except json.JSONDecodeError:
                            parsed = {}
                    file_meta = parsed if isinstance(parsed, dict) else {}
                    existing_thumb = file_meta.get("thumbnail") or {}
                    file_meta["thumbnail"] = {
                        **existing_thumb,
                        "has_thumbnail": True,
                        "has_custom": True,
                        "cover_source": "user",
                        "cover_downloaded": False,
                        "cover_tried_ids": [],
                        "cover_tried_isbn": False,
                    }
                    db_meta.execute(
                        text("UPDATE documents SET file_metadata = CAST(:meta AS jsonb) WHERE id = :id"),
                        {"meta": json.dumps(file_meta), "id": request.document_id},
                    )
                    db_meta.commit()
                finally:
                    db_meta.close()
            except Exception as e:
                logger.debug("Failed to mark uploaded thumbnail as user-source: %s", e)

            return common_pb2.StatusResponse(success=True, message="Thumbnail uploaded")
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def DeleteThumbnail(self, request, context):
        logger.info("DocumentExtras.DeleteThumbnail - doc=%s", request.document_id)
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal
            from src.main.service.document.thumbnail_service import ThumbnailService

            db = SessionLocal()
            try:
                row = db.execute(
                    text("SELECT file_path FROM documents WHERE id = :id"),
                    {"id": request.document_id},
                ).fetchone()
            finally:
                db.close()

            if not row:
                return common_pb2.StatusResponse(success=False, message="Document not found")

            import os

            full_path = os.path.join(os.getcwd(), row[0])
            ThumbnailService.delete_thumbnails(full_path)
            return common_pb2.StatusResponse(success=True, message="Thumbnail deleted")
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def GetDocxPreview(self, request, context):
        logger.info("DocumentExtras.GetDocxPreview - doc=%s", request.document_id)
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal
            from src.main.service.document.document_processor_docx import DOCXProcessor

            db = SessionLocal()
            try:
                doc = db.execute(
                    text("""
                        SELECT d.file_path AS doc_path, cs.file_path AS content_path
                        FROM documents d
                        LEFT JOIN content_store cs ON d.content_store_id = cs.id
                        WHERE d.id = :id
                    """),
                    {"id": request.document_id},
                ).fetchone()

                if not doc:
                    return document_extras_pb2.DocxPreviewResponse(
                        success=False,
                        error="Document not found",
                    )

                file_path = doc.content_path or doc.doc_path
                if not file_path:
                    return document_extras_pb2.DocxPreviewResponse(
                        success=False,
                        error="Document file path not found",
                    )

                processor = DOCXProcessor()
                result = processor.process_docx(file_path)

                return document_extras_pb2.DocxPreviewResponse(
                    success=True,
                    html=result.get("html", ""),
                    metadata_json=json.dumps(result.get("metadata", {})),
                )
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return document_extras_pb2.DocxPreviewResponse(success=False, error=str(e))

    async def GetDocxMammothPreview(self, request, context):
        logger.info("DocumentExtras.GetDocxMammothPreview - doc=%s", request.document_id)
        try:
            import mammoth
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                doc = db.execute(
                    text("""
                        SELECT d.file_path AS doc_path, cs.file_path AS content_path
                        FROM documents d
                        LEFT JOIN content_store cs ON d.content_store_id = cs.id
                        WHERE d.id = :id
                    """),
                    {"id": request.document_id},
                ).fetchone()

                if not doc:
                    return document_extras_pb2.DocxPreviewResponse(
                        success=False,
                        error="Document not found",
                    )

                file_path = doc.content_path or doc.doc_path
                if not file_path:
                    return document_extras_pb2.DocxPreviewResponse(
                        success=False,
                        error="Document file path not found",
                    )

                with open(file_path, "rb") as f:
                    result = mammoth.convert_to_html(f)

                return document_extras_pb2.DocxPreviewResponse(
                    success=True,
                    html=result.value,
                    warnings_json=json.dumps([str(w) for w in result.messages]),
                )
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return document_extras_pb2.DocxPreviewResponse(success=False, error=str(e))

    async def GetDocumentFile(self, request, context):
        logger.info("DocumentExtras.GetDocumentFile - doc=%s", request.document_id)
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                doc = db.execute(
                    text("""
                        SELECT d.file_path AS doc_path, d.filename,
                               cs.file_path AS content_path
                        FROM documents d
                        LEFT JOIN content_store cs ON d.content_store_id = cs.id
                        WHERE d.id = :id
                    """),
                    {"id": request.document_id},
                ).fetchone()

                if not doc:
                    return document_extras_pb2.DocumentFileResponse(found=False)

                # Prefer content store path, fall back to document's own path
                file_path = doc.content_path or doc.doc_path
                if not file_path or not os.path.exists(file_path):
                    return document_extras_pb2.DocumentFileResponse(found=False)

                import mimetypes

                file_path_str = str(file_path)
                content_type = mimetypes.guess_type(file_path_str)[0] or "application/octet-stream"

                return document_extras_pb2.DocumentFileResponse(
                    found=True,
                    file_path=file_path_str,
                    filename=doc.filename or os.path.basename(file_path_str),
                    content_type=content_type,
                )
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return document_extras_pb2.DocumentFileResponse(found=False)

    async def ListCollectionDocuments(self, request, context):
        page = max(1, request.page) if request.page else 1
        page_size = min(max(1, request.page_size), 100) if request.page_size else 20
        search = request.search if request.HasField("search") else None
        logger.info(
            "DocumentExtras.ListCollectionDocuments - collection=%s page=%d size=%d search=%s",
            request.collection_id,
            page,
            page_size,
            search,
        )

        # All blocking DB work runs in a worker thread: a synchronous
        # db.execute here would stall the single grpc.aio event loop and time
        # out every concurrent RPC alongside it (the same failure GetCollectionStats
        # had). No awaits inside, so a plain sync closure is safe.
        def _sync():
            from sqlalchemy import text

            from src.main.config.database import SessionLocal
            from src.main.service.document.thumbnail_service import ThumbnailService

            db = SessionLocal()
            try:
                # Build WHERE clause — include documents via primary collection_id
                # OR via multi-collection membership (document_collections junction table)
                search_conditions = []
                params: dict = {"collection_id": request.collection_id}

                if search and search.strip():
                    search_conditions.append("(d.filename ILIKE :search OR d.title ILIKE :search)")
                    params["search"] = f"%{search.strip()}%"

                search_where = (" AND " + " AND ".join(search_conditions)) if search_conditions else ""

                # Count total matching documents (primary + multi-collection membership)
                total = (
                    db.execute(
                        text(f"""
                        SELECT count(DISTINCT d.id) FROM documents d
                        LEFT JOIN document_collections dc ON dc.document_id = d.id
                        WHERE (d.collection_id = CAST(:collection_id AS uuid)
                               OR dc.collection_id = CAST(:collection_id AS uuid))
                        AND d.deleted_at IS NULL
                        {search_where}
                    """),
                        params,
                    ).scalar()
                    or 0
                )

                # Fetch paginated results (primary + multi-collection membership).
                # Also pull the latest jobs-table row for each document so the
                # UI can render per-file live progress (SVG % circle) instead
                # of a static "Pending processing" dot. Without these fields
                # the uploader's isActuallyProcessing gate never fires and a
                # doc that's 70 % through parse+chunk still looks pending.
                offset = (page - 1) * page_size
                # Wrapped in a subquery so we can sort by status bucket
                # (CASE on job_status) AFTER the DISTINCT ON dedupe. PostgreSQL
                # requires DISTINCT ON's leading sort to start with d.id, so
                # we keep that on the inner query and re-sort the dedupe
                # output by status priority on the outer.
                docs = db.execute(
                    text(f"""
                        SELECT * FROM (
                        SELECT DISTINCT ON (d.id)
                               d.id, d.filename, d.file_path, d.file_size, d.processing_status,
                               d.created_at, d.updated_at, d.collection_id,
                               cs.file_path AS content_path, d.file_stored, d.title,
                               gs.status AS graph_status,
                               CASE WHEN ds_count.cnt > 0 THEN true ELSE false END AS has_summary,
                               COALESCE(rel_count.cnt, 0) AS relation_count,
                               d.extracted_metadata,
                               d.pagerank_score,
                               d.pagerank_computed_at,
                               latest_job.job_id AS job_id,
                               latest_job.status AS job_status,
                               latest_job.progress AS job_progress,
                               latest_job.description AS job_message,
                               latest_job.error_message AS job_errors,
                               d.file_metadata
                        FROM documents d
                        LEFT JOIN document_collections dc ON dc.document_id = d.id
                        LEFT JOIN content_store cs ON d.content_store_id = cs.id
                        LEFT JOIN graph_sync_status gs ON gs.document_id = CAST(d.id AS text)
                            AND gs.collection_id = CAST(d.collection_id AS text)
                        LEFT JOIN (
                            SELECT document_id, COUNT(*) AS cnt
                            FROM document_summaries
                            GROUP BY document_id
                        ) ds_count ON ds_count.document_id = d.id
                        LEFT JOIN (
                            SELECT source_document_id AS doc_id, COUNT(*) AS cnt
                            FROM document_relations
                            GROUP BY source_document_id
                        ) rel_count ON rel_count.doc_id = d.id
                        LEFT JOIN LATERAL (
                            SELECT
                                j.job_id,
                                -- Reinterpret stale 'processing' rows as 'failed' AND
                                -- null out the progress + message so the UI doesn't
                                -- treat a 65 % stuck arc as a live worker. Without
                                -- the progress null-out, the frontend's
                                -- `isLive = progress > 0` check still flagged the
                                -- ghost row as in-flight even when status was
                                -- coerced. Beat reconciler still does the durable
                                -- DB rewrite every 5 min; this guard keeps the
                                -- view honest between beats.
                                CASE
                                  WHEN j.status = 'processing'
                                    AND j.updated_at < NOW() - INTERVAL '5 minutes'
                                  THEN 'failed'
                                  ELSE j.status
                                END AS status,
                                CASE
                                  WHEN j.status = 'processing'
                                    AND j.updated_at < NOW() - INTERVAL '5 minutes'
                                  THEN NULL
                                  ELSE j.progress
                                END AS progress,
                                CASE
                                  WHEN j.status = 'processing'
                                    AND j.updated_at < NOW() - INTERVAL '5 minutes'
                                  THEN 'errorWorkerStalled'
                                  ELSE j.description
                                END AS description,
                                j.error_message
                            FROM jobs j
                            WHERE j.document_id = d.id
                            ORDER BY j.updated_at DESC NULLS LAST, j.created_at DESC
                            LIMIT 1
                        ) latest_job ON TRUE
                        WHERE (d.collection_id = CAST(:collection_id AS uuid)
                               OR dc.collection_id = CAST(:collection_id AS uuid))
                        AND d.deleted_at IS NULL
                        {search_where}
                        ORDER BY d.id, d.created_at DESC
                        ) inner_dedup
                        ORDER BY
                          -- Live-processing rows first so the user always
                          -- sees what the worker is currently chewing on,
                          -- regardless of pagination. Pagination otherwise
                          -- shoved the active doc onto page 4 and the
                          -- banner thought nothing was happening.
                          CASE
                            WHEN job_status = 'processing' THEN 0
                            WHEN processing_status = 'pending' THEN 1
                            WHEN processing_status = 'failed' THEN 3
                            ELSE 2
                          END,
                          -- Within each status bucket, alphabetical by
                          -- filename so users can locate a doc by name
                          -- across paginated requests. id is a stable
                          -- tiebreaker for filename collisions.
                          LOWER(filename), id
                        LIMIT :limit OFFSET :offset
                    """),
                    {**params, "limit": page_size, "offset": offset},
                ).fetchall()

                # Collect all document IDs to batch-fetch tags and collection memberships
                doc_ids = [str(d[0]) for d in docs]

                # Batch-fetch tags for all documents
                tags_map: dict = {}
                if doc_ids:
                    doc_tags = db.execute(
                        text("""
                            SELECT dt.document_id, t.name, t.color
                            FROM document_tags dt
                            JOIN tags t ON dt.tag_id = t.id
                            WHERE dt.document_id = ANY(CAST(:doc_ids AS uuid[]))
                            ORDER BY t.position NULLS LAST, t.name
                        """),
                        {"doc_ids": doc_ids},
                    ).fetchall()
                    for dt in doc_tags:
                        did = str(dt[0])
                        if did not in tags_map:
                            tags_map[did] = []
                        tags_map[did].append({"name": dt[1], "color": dt[2]})

                memberships_map: dict = {}
                if doc_ids:
                    memberships = db.execute(
                        text("""
                            SELECT dc.document_id, dc.collection_id, dc.added_at
                            FROM document_collections dc
                            WHERE dc.document_id = ANY(CAST(:doc_ids AS uuid[]))
                        """),
                        {"doc_ids": doc_ids},
                    ).fetchall()
                    for m in memberships:
                        did = str(m[0])
                        if did not in memberships_map:
                            memberships_map[did] = []
                        memberships_map[did].append(
                            {
                                "collection_id": str(m[1]),
                                "added_at": m[2].isoformat() if m[2] else None,
                            }
                        )

                result = []
                for d in docs:
                    resolved_path = d[8] or d[2]  # content_path or file_path
                    file_stored = d[9] if d[9] is not None else True
                    raw_title = d[10] or ""
                    graph_status = d[11]  # nullable string from graph_sync_status
                    has_summary = bool(d[12])
                    relation_count = int(d[13])
                    doc_id = str(d[0])
                    doc_entry = {
                        "id": doc_id,
                        "filename": d[1],
                        "file_path": d[2],
                        "file_size": d[3],
                        "processing_status": d[4],
                        "created_at": d[5].isoformat() if d[5] else None,
                        "updated_at": d[6].isoformat() if d[6] else None,
                        "collection_id": str(d[7]),
                        "file_stored": file_stored,
                        "title": raw_title,
                        "graph_status": graph_status,
                        "has_summary": has_summary,
                        "relation_count": relation_count,
                        "extracted_metadata": d[14] if d[14] else None,
                        "pagerank_score": float(d[15]) if d[15] is not None else None,
                        "pagerank_computed_at": d[16].isoformat() if d[16] else None,
                        "collection_memberships": memberships_map.get(doc_id, []),
                        "tags": tags_map.get(doc_id, []),
                        # Latest jobs-row snapshot so the UI can render a
                        # live progress % circle instead of a static pending
                        # dot while the worker is parse/chunk/embedding.
                        "job_id": d[17],
                        "job_status": d[18],
                        "job_progress": float(d[19]) if d[19] is not None else None,
                        "job_message": d[20],
                        # error_message is the raw Python traceback when a
                        # Celery task fails — the UI pastes it verbatim as
                        # the doc subtitle, so we translate the most common
                        # terminal-frame exceptions into short user-facing
                        # strings here. Full trace stays in Postgres for ops
                        # debugging; list responses only carry the summary.
                        "job_errors": _format_job_error(d[21]) if d[21] else None,
                    }

                    # Check if thumbnail exists on disk
                    has_thumb = False
                    if resolved_path:
                        thumb_path = ThumbnailService.get_thumbnail_path(resolved_path, "large")
                        has_thumb = bool(thumb_path and os.path.exists(thumb_path))

                    # `cover_downloaded` lets the UI swap the context-menu
                    # label from "Preuzmi naslovnicu" → "Probaj drugu
                    # naslovnicu". Read from file_metadata.thumbnail so the
                    # signal survives across logins / cache clears (the
                    # on-disk thumbnail alone can't distinguish a user
                    # upload from an Open Library download).
                    raw_file_meta = d[22]
                    cover_downloaded = False
                    has_custom = False
                    if raw_file_meta:
                        parsed = raw_file_meta if isinstance(raw_file_meta, dict) else None
                        if parsed is None:
                            try:
                                parsed = json.loads(raw_file_meta)
                            except (TypeError, ValueError):
                                parsed = {}
                        if isinstance(parsed, str):
                            try:
                                parsed = json.loads(parsed)
                            except (TypeError, ValueError):
                                parsed = {}
                        thumb_meta = (parsed or {}).get("thumbnail") or {}
                        has_custom = bool(thumb_meta.get("has_custom"))
                        cover_source = thumb_meta.get("cover_source")
                        # Legacy `DownloadBookCover` calls (pre-retry-rotate)
                        # only set `has_custom: true` without any source
                        # marker, so any `has_custom` row missing the
                        # explicit `cover_source: "user"` is assumed to be
                        # a downloaded cover. New uploads pin `"user"`.
                        cover_downloaded = bool(
                            thumb_meta.get("cover_downloaded")
                            or thumb_meta.get("cover_tried_ids")
                            or (cover_source and cover_source != "user")
                            or (has_custom and cover_source != "user")
                        )
                    doc_entry["thumbnail"] = {
                        "has_thumbnail": has_thumb,
                        "has_custom": has_custom,
                        "cover_downloaded": cover_downloaded,
                    }

                    result.append(doc_entry)

                has_more = (page * page_size) < total
                return document_extras_pb2.ListCollectionDocsResponse(
                    documents_json=json.dumps(result),
                    has_more=has_more,
                    total=total,
                )
            finally:
                db.close()

        try:
            return await asyncio.to_thread(_sync)
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return document_extras_pb2.ListCollectionDocsResponse(documents_json="[]")

    async def GetReadingPosition(self, request, context):
        logger.info("DocumentExtras.GetReadingPosition - doc=%s", request.document_id)
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                result = db.execute(
                    text("""
                        SELECT document_id, page_number, scroll_position, epub_cfi,
                               last_tts_char_index, total_pages
                        FROM reading_positions
                        WHERE document_id = :doc_id AND user_id = :user_id
                    """),
                    {"doc_id": request.document_id, "user_id": request.user_id},
                ).fetchone()

                if not result:
                    return document_extras_pb2.ReadingPositionResponse(found=False)

                position_data = {
                    "scroll_position": result[2],
                    "epub_cfi": result[3],
                    "last_tts_char_index": result[4],
                    "total_pages": result[5],
                }

                return document_extras_pb2.ReadingPositionResponse(
                    found=True,
                    document_id=str(result[0]),
                    page=result[1] or 0,
                    position_json=json.dumps(position_data, default=str),
                )
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return document_extras_pb2.ReadingPositionResponse(found=False)

    async def SetReadingPosition(self, request, context):
        logger.info("DocumentExtras.SetReadingPosition - doc=%s, page=%d", request.document_id, request.page)
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                # Parse position_json to extract individual fields
                position_data = json.loads(request.position_json) if request.position_json else {}

                db.execute(
                    text("""
                        INSERT INTO reading_positions (id, document_id, user_id, page_number,
                            scroll_position, epub_cfi, last_tts_char_index, total_pages, updated_at)
                        VALUES (gen_random_uuid(), :doc_id, :user_id, :page_number,
                            :scroll_position, :epub_cfi, :last_tts_char_index, :total_pages, NOW())
                        ON CONFLICT (user_id, document_id) DO UPDATE
                        SET page_number = :page_number, scroll_position = :scroll_position,
                            epub_cfi = :epub_cfi, last_tts_char_index = :last_tts_char_index,
                            total_pages = :total_pages, updated_at = NOW()
                    """),
                    {
                        "doc_id": request.document_id,
                        "user_id": request.user_id,
                        "page_number": request.page,
                        "scroll_position": position_data.get("scroll_position"),
                        "epub_cfi": position_data.get("epub_cfi"),
                        "last_tts_char_index": position_data.get("last_tts_char_index"),
                        "total_pages": position_data.get("total_pages"),
                    },
                )
                db.commit()
                return common_pb2.StatusResponse(success=True, message="Reading position saved")
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def GetBookSummary(self, request, context):
        logger.info("DocumentExtras.GetBookSummary - doc=%s", request.document_id)
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                result = db.execute(
                    text("""
                        SELECT summary_text FROM document_summaries
                        WHERE document_id = :doc_id AND summary_type = 'book'
                        LIMIT 1
                    """),
                    {"doc_id": request.document_id},
                ).fetchone()

                if not result or not result[0]:
                    return document_extras_pb2.BookSummaryResponse(found=False)

                return document_extras_pb2.BookSummaryResponse(
                    found=True,
                    summary_text=result[0],
                )
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error in GetBookSummary: %s", str(e))
            return document_extras_pb2.BookSummaryResponse(found=False)

    async def GenerateBookSummary(self, request, context):
        """Generate chapter + book summaries for a document, streaming progress."""
        logger.info("DocumentExtras.GenerateBookSummary - doc=%s, user=%s", request.document_id, request.user_id)
        try:
            from uuid import UUID

            from src.main.config.database import SessionLocal
            from src.main.service.document.document_summary_service import DocumentSummaryService

            db = SessionLocal()
            try:
                # Check if summary already exists
                from sqlalchemy import text as sql_text

                existing = db.execute(
                    sql_text("SELECT 1 FROM document_summaries WHERE document_id = :doc_id AND summary_type = 'book' LIMIT 1"),
                    {"doc_id": request.document_id},
                ).fetchone()

                if existing:
                    # Already has a book summary, fetch and return it
                    result = db.execute(
                        sql_text("SELECT summary_text FROM document_summaries WHERE document_id = :doc_id AND summary_type = 'book' LIMIT 1"),
                        {"doc_id": request.document_id},
                    ).fetchone()
                    yield document_extras_pb2.SummaryProgressPacket(
                        type="complete",
                        message="Summary already exists",
                        progress=1.0,
                        summary_text=result[0] if result else "",
                    )
                    return

                yield document_extras_pb2.SummaryProgressPacket(
                    type="progress",
                    message="Initializing summary generation...",
                    progress=0.05,
                )

                service = DocumentSummaryService(db)
                doc_id = UUID(request.document_id)
                user_id = UUID(request.user_id)

                # Fetch document to get hierarchy
                from src.main.models.sqlmodel_models import Document

                document = db.get(Document, doc_id)
                if not document:
                    yield document_extras_pb2.SummaryProgressPacket(
                        type="error",
                        message="Document not found",
                        progress=0.0,
                    )
                    return

                # Try to extract chapters from hierarchy
                chapters = []
                if document.document_hierarchy:
                    # noinspection PyProtectedMember
                    chapters = service._extract_chapters_from_hierarchy(document.document_hierarchy)

                if not chapters:
                    # Fallback: generate summary from all chunks directly
                    yield document_extras_pb2.SummaryProgressPacket(
                        type="progress",
                        message="No chapter structure found, summarizing full document...",
                        progress=0.1,
                    )
                    async for packet in self._generate_flat_summary(db, service, doc_id, user_id, document):
                        yield packet
                    return

                total_chapters = len(chapters)
                yield document_extras_pb2.SummaryProgressPacket(
                    type="progress",
                    message=f"Found {total_chapters} chapters to summarize",
                    progress=0.1,
                )

                # Generate chapter summaries
                chapter_summaries = []
                for idx, chapter in enumerate(chapters):
                    progress = 0.1 + (0.8 * idx / total_chapters)
                    yield document_extras_pb2.SummaryProgressPacket(
                        type="progress",
                        message=f"Summarizing chapter {idx + 1}/{total_chapters}: {chapter['title']}",
                        progress=progress,
                    )

                    summary = await service.generate_chapter_summary(
                        document_id=doc_id,
                        user_id=user_id,
                        chapter_title=chapter["title"],
                        chapter_index=idx,
                        chunk_start=chapter["chunk_start"],
                        chunk_end=chapter["chunk_end"],
                    )

                    if summary:
                        chapter_summaries.append(summary)
                        yield document_extras_pb2.SummaryProgressPacket(
                            type="chapter_done",
                            message=f"Chapter {idx + 1} summarized",
                            progress=0.1 + (0.8 * (idx + 1) / total_chapters),
                        )

                if not chapter_summaries:
                    yield document_extras_pb2.SummaryProgressPacket(
                        type="error",
                        message="Failed to generate any chapter summaries",
                        progress=0.0,
                    )
                    return

                # Generate book summary from chapter summaries
                yield document_extras_pb2.SummaryProgressPacket(
                    type="progress",
                    message="Generating overall book summary...",
                    progress=0.9,
                )

                book_summary = await service.generate_book_summary(
                    document_id=doc_id,
                    user_id=user_id,
                    document_name=document.filename,
                    chapter_summaries=chapter_summaries,
                )

                if book_summary:
                    yield document_extras_pb2.SummaryProgressPacket(
                        type="complete",
                        message=f"Summary generated ({len(chapter_summaries)} chapters)",
                        progress=1.0,
                        summary_text=book_summary.summary_text,
                    )
                else:
                    yield document_extras_pb2.SummaryProgressPacket(
                        type="error",
                        message="Failed to generate book summary from chapters",
                        progress=0.0,
                    )

            finally:
                db.close()

        except Exception as e:
            logger.exception("Error in GenerateBookSummary: %s", str(e))
            yield document_extras_pb2.SummaryProgressPacket(
                type="error",
                message=str(e),
                progress=0.0,
            )

    async def _generate_flat_summary(self, db, service, doc_id, user_id, document):
        """Generate summary for a document without chapter hierarchy by using all chunks."""
        from sqlalchemy import text as sql_text

        # Fetch all chunks for this document
        chunks_query = sql_text("""
            SELECT document, (cmetadata->>'chunk_index')::int as chunk_index
            FROM langchain_pg_embedding
            WHERE cmetadata->>'document_id' = :document_id
            ORDER BY (cmetadata->>'chunk_index')::int
        """)
        result = db.execute(chunks_query, {"document_id": str(doc_id)}).fetchall()

        if not result:
            # Fallback 1: use the document's content column directly
            logger.info("No embedding chunks found for doc %s, falling back to documents.content", str(doc_id))
            doc_content = document.content
            if not doc_content or not doc_content.strip():
                # Fallback 2: extract text on-the-fly from the source file
                logger.info("Document content empty for doc %s, extracting from source file", str(doc_id))
                yield document_extras_pb2.SummaryProgressPacket(
                    type="progress",
                    message="Extracting text from document file...",
                    progress=0.15,
                )
                doc_content = self._extract_text_from_file(document, db)

            if not doc_content or not doc_content.strip():
                yield document_extras_pb2.SummaryProgressPacket(
                    type="error",
                    message="No text chunks or document content found for this document.",
                    progress=0.0,
                )
                return

            yield document_extras_pb2.SummaryProgressPacket(
                type="progress",
                message="Using document content for summary (no embeddings available)...",
                progress=0.2,
            )
            all_text = doc_content
        else:
            yield document_extras_pb2.SummaryProgressPacket(
                type="progress",
                message=f"Found {len(result)} text chunks, preparing summary...",
                progress=0.2,
            )

            # Combine chunks
            all_text = "\n\n".join(row[0] for row in result)
        max_chars = 100_000
        if len(all_text) > max_chars:
            all_text = all_text[:max_chars]
            logger.info("Truncated document text from %d to %d chars for summary", len(all_text), max_chars)

        yield document_extras_pb2.SummaryProgressPacket(
            type="progress",
            message="Generating summary from document text...",
            progress=0.5,
        )

        # Use the book agent to generate a summary directly from the text
        from datetime import datetime

        from src.main.models.sqlmodel_models import DocumentSummary as DocumentSummaryModel

        try:
            agent_result = await service.book_agent.run(f"Summarize this document titled '{document.filename}':\n\n{all_text}")
            from src.main.utils.llm.usage_tracker import track_agent_usage

            track_agent_usage(agent_result, agent_type="book_summary_flat", model="openai:gpt-4o-mini")
            summary_text = agent_result.output
        except Exception as e:
            logger.error("LLM summary generation failed: %s", str(e))
            yield document_extras_pb2.SummaryProgressPacket(
                type="error",
                message=f"LLM generation failed: {e!s}",
                progress=0.0,
            )
            return

        yield document_extras_pb2.SummaryProgressPacket(
            type="progress",
            message="Saving summary...",
            progress=0.9,
        )

        # Store the summary
        from uuid import uuid4

        summary_record = DocumentSummaryModel(
            id=uuid4(),
            document_id=doc_id,
            user_id=user_id,
            summary_type="book",
            summary_text=summary_text,
            chapter_title=None,
            chapter_index=None,
            chunk_start_index=0,
            chunk_end_index=max(len(result) - 1, 0),
            model_used="gpt-4o-mini",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        db.add(summary_record)
        db.commit()

        yield document_extras_pb2.SummaryProgressPacket(
            type="complete",
            message="Summary generated from full document",
            progress=1.0,
            summary_text=summary_text,
        )

    @staticmethod
    def _extract_text_from_file(document, db) -> str | None:
        """Extract text from document source file and persist to document.content."""
        import os

        from src.main.utils.documents.utils import (
            extract_epub_to_markdown,
            extract_pdf_to_markdown,
            extract_text_file_content,
        )

        file_path = document.file_path
        if not file_path or not os.path.exists(file_path):
            logger.warning("Source file not found: %s", file_path)
            return None

        file_ext = os.path.splitext(file_path)[1].lower()
        content: str | None

        try:
            if file_ext == ".pdf":
                content, page_count = extract_pdf_to_markdown(file_path)
                if page_count and not document.page_count:
                    document.page_count = page_count
            elif file_ext == ".epub":
                content, _ = extract_epub_to_markdown(file_path)
            elif file_ext in {".txt", ".md"}:
                content = extract_text_file_content(file_path)
            else:
                logger.warning("Unsupported file type for text extraction: %s", file_ext)
                return None
        except Exception as e:
            logger.exception("Error extracting text from %s: %s", file_path, str(e))
            return None

        if content and content.strip():
            document.content = content
            db.commit()
            logger.info("Extracted and stored content from %s (%d chars)", file_ext, len(content))

        return content

    async def TranslateBookSummary(self, request, context):
        """Stream a cached or LLM-translated book summary."""
        logger.info(
            "DocumentExtras.TranslateBookSummary - doc=%s, lang=%s",
            request.document_id,
            request.target_language,
        )
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal
            from src.main.utils.config.loader import get_resolved_prompts
            from src.main.utils.llm.agent_model_utils import get_system_agent_model

            target_lang = request.target_language
            lang_name = LANGUAGE_NAMES.get(target_lang, target_lang)

            db = SessionLocal()
            try:
                # 1. Check translation cache
                cached = db.execute(
                    text("""
                        SELECT translated_text FROM document_summary_translations
                        WHERE document_id = :doc_id
                          AND summary_type = 'book'
                          AND language = :lang
                        LIMIT 1
                    """),
                    {"doc_id": request.document_id, "lang": target_lang},
                ).fetchone()

                if cached and cached[0]:
                    logger.info("Translation cache hit for doc=%s lang=%s", request.document_id, target_lang)
                    yield document_extras_pb2.TranslationPacket(
                        type="cached",
                        content=cached[0],
                    )
                    return

                # 2. Fetch original summary
                original = db.execute(
                    text("""
                        SELECT summary_text FROM document_summaries
                        WHERE document_id = :doc_id AND summary_type = 'book'
                        LIMIT 1
                    """),
                    {"doc_id": request.document_id},
                ).fetchone()

                if not original or not original[0]:
                    yield document_extras_pb2.TranslationPacket(
                        type="error",
                        content="No summary found for this document",
                    )
                    return

                summary_text = original[0]

                # 3. Get LLM model and translate with streaming
                agent_config = get_system_agent_model(agent_type="translation")
                model = agent_config.get_pydantic_ai_model()
                model_string = agent_config.get_pydantic_ai_model_string()

                prompts_config = get_resolved_prompts()
                translation_prompt = prompts_config.get("translation", {}).get(
                    "book_summary",
                    "Translate the following text to {target_language}. Preserve markdown formatting. Output only the translated text.",
                )
                system_prompt = translation_prompt.format(target_language=lang_name)

                from pydantic_ai import Agent

                agent = Agent(model, system_prompt=system_prompt)

                full_translation = []
                async with agent.run_stream(summary_text) as result:
                    async for chunk in result.stream_text(delta=True):
                        full_translation.append(chunk)
                        yield document_extras_pb2.TranslationPacket(
                            type="delta",
                            content=chunk,
                        )

                from src.main.utils.llm.usage_tracker import track_stream_usage

                track_stream_usage(result, agent_type="book_summary_translation", model=model_string)

                translated_text = "".join(full_translation)

                # 4. Cache translation in DB
                db.execute(
                    text("""
                        INSERT INTO document_summary_translations
                            (document_id, summary_type, language, translated_text, model_used, created_at, updated_at)
                        VALUES
                            (:doc_id, 'book', :lang, :translated_text, :model_used, NOW(), NOW())
                        ON CONFLICT (document_id, summary_type, language)
                        DO UPDATE SET translated_text = :translated_text, model_used = :model_used, updated_at = NOW()
                    """),
                    {
                        "doc_id": request.document_id,
                        "lang": target_lang,
                        "translated_text": translated_text,
                        "model_used": model_string,
                    },
                )
                db.commit()
                logger.info(
                    "Translation cached for doc=%s lang=%s (%d chars)",
                    request.document_id,
                    target_lang,
                    len(translated_text),
                )

                yield document_extras_pb2.TranslationPacket(
                    type="complete",
                    content="",
                )

            finally:
                db.close()

        except Exception as e:
            logger.exception("Error in TranslateBookSummary: %s", str(e))
            yield document_extras_pb2.TranslationPacket(
                type="error",
                content=str(e),
            )

    async def GetDocument(self, request, context):
        logger.info("DocumentExtras.GetDocument - doc=%s", request.document_id)
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal
            from src.main.service.document.thumbnail_service import ThumbnailService

            db = SessionLocal()
            try:
                row = db.execute(
                    text("""
                        SELECT d.id, d.title, d.filename, d.file_path, d.file_size, d.file_type,
                               d.page_count, d.word_count, d.processing_status, d.processing_error,
                               d.processing_progress, d.collection_id, d.created_at, d.updated_at,
                               cs.file_path AS content_path
                        FROM documents d
                        LEFT JOIN content_store cs ON d.content_store_id = cs.id
                        WHERE d.id = :id
                    """),
                    {"id": request.document_id},
                ).fetchone()

                if not row:
                    return document_extras_pb2.DocumentDetailResponse(found=False)

                resolved_path = row[14] or row[3]  # content_path or file_path
                has_thumb = False
                if resolved_path:
                    thumb_path = ThumbnailService.get_thumbnail_path(resolved_path, "large")
                    has_thumb = bool(thumb_path and os.path.exists(thumb_path))

                return document_extras_pb2.DocumentDetailResponse(
                    found=True,
                    id=str(row[0]),
                    title=row[1] or "",
                    filename=row[2] or "",
                    file_path=row[3] or "",
                    file_size=row[4] or 0,
                    file_type=row[5] or "",
                    page_count=row[6] or 0,
                    word_count=row[7] or 0,
                    processing_status=row[8] or "pending",
                    processing_error=row[9] or "",
                    processing_progress=row[10] or 0.0,
                    collection_id=str(row[11]),
                    created_at=row[12].isoformat() if row[12] else "",
                    updated_at=row[13].isoformat() if row[13] else "",
                    has_thumbnail=has_thumb,
                )
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error in GetDocument: %s", str(e))
            return document_extras_pb2.DocumentDetailResponse(found=False)

    async def DeleteDocument(self, request, context):
        logger.info(
            "DocumentExtras.DeleteDocument - doc=%s, collection=%s, user=%s",
            request.document_id,
            request.collection_id,
            request.user_id,
        )
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal
            from src.main.service.document.thumbnail_service import ThumbnailService

            # noinspection PyProtectedMember
            from src.main.service.document_processing.documents import (
                _delete_document_graph_nodes,
                delete_document_embeddings,
            )

            db = SessionLocal()
            try:
                # Verify document exists and belongs to the collection
                doc = db.execute(
                    text("""
                        SELECT d.id, d.file_path, d.collection_id, d.processing_status,
                               d.content_store_id, cs.file_path AS content_path
                        FROM documents d
                        LEFT JOIN content_store cs ON d.content_store_id = cs.id
                        WHERE d.id = :id
                    """),
                    {"id": request.document_id},
                ).fetchone()

                if not doc:
                    return document_extras_pb2.DeleteDocumentByIdResponse(
                        success=False,
                        message="Document not found",
                    )

                file_path = doc.content_path or doc.file_path
                processing_status = doc.processing_status
                content_store_id = doc.content_store_id
                deleted_embeddings = 0

                # Cancel any running processing job
                try:
                    from src.main.service.document.document_job_manager import document_job_manager

                    job_info = document_job_manager.get_job_info_by_document_id(request.document_id)
                    if job_info:
                        await document_job_manager.cancel_processing(
                            job_info["job_id"],
                            db,
                            request.user_id,
                        )
                except Exception as e:
                    logger.warning("Failed to cancel processing job: %s", str(e))

                # Delete embeddings if document was processed or dedup-cloned
                if processing_status in ("completed", "processing", "failed", "pending_dedup"):
                    try:
                        await delete_document_embeddings(
                            request.document_id,
                            request.collection_id,
                            request.user_id,
                        )
                        deleted_embeddings = 1
                    except Exception as e:
                        logger.warning("Failed to delete embeddings: %s", str(e))

                # Delete graph nodes
                try:
                    await _delete_document_graph_nodes(request.document_id)
                except Exception as e:
                    logger.warning("Failed to delete graph nodes: %s", str(e))

                # Handle file deletion with content store ref counting
                if content_store_id:
                    from src.main.service.document.dedup_service import decrement_ref_count

                    new_ref_count = decrement_ref_count(db, content_store_id)
                    if new_ref_count == 0 and file_path and os.path.exists(file_path):
                        try:
                            ThumbnailService.delete_thumbnails(file_path)
                        except Exception as e:
                            logger.warning("Failed to delete thumbnails: %s", str(e))
                        file_path_str = str(file_path)
                        os.remove(file_path_str)
                        # Clean up empty parent directories
                        parent_dir = os.path.dirname(file_path_str)
                        for _ in range(3):
                            if os.path.exists(parent_dir) and not os.listdir(parent_dir):
                                os.rmdir(parent_dir)
                                parent_dir = os.path.dirname(parent_dir)
                            else:
                                break
                elif file_path and os.path.exists(file_path):
                    # Legacy path: no content store
                    try:
                        ThumbnailService.delete_thumbnails(file_path)
                    except Exception as e:
                        logger.warning("Failed to delete thumbnails: %s", str(e))
                    file_path_str = str(file_path)
                    os.remove(file_path_str)
                    parent_dir = os.path.dirname(file_path_str)
                    if os.path.exists(parent_dir) and not os.listdir(parent_dir):
                        os.rmdir(parent_dir)

                # Delete document summaries
                db.execute(
                    text("DELETE FROM document_summaries WHERE document_id = :id"),
                    {"id": request.document_id},
                )

                # Delete reading positions
                db.execute(
                    text("DELETE FROM reading_positions WHERE document_id = :id"),
                    {"id": request.document_id},
                )

                # Soft-delete document record (Trash).
                # Also flip file_stored=false + clear file_size: the os.remove
                # blocks above physically deleted the file from disk. Without
                # this flip the row carries a stale file_stored=true forever,
                # blocking Cat-I G1 eligibility on any future re-audit (G1
                # gates on file_stored=false) and tripping the "alchemy
                # file_stored=true lies" systemic blocker that surfaced
                # 2026-05-29 with 81 corpus-wide cases (verified via
                # `os.path.exists` against `/app/data/upload/...` paths).
                # `deleted_at` is the trash signal; `file_stored` must
                # independently track disk reality.
                db.execute(
                    text("UPDATE documents SET deleted_at = NOW(), file_stored = FALSE, file_size = NULL WHERE id = :id"),
                    {"id": request.document_id},
                )
                db.commit()

                logger.info("Soft-deleted document %s (moved to trash)", request.document_id)
                return document_extras_pb2.DeleteDocumentByIdResponse(
                    success=True,
                    message="Document moved to trash",
                    deleted_embeddings_count=deleted_embeddings,
                )
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error in DeleteDocument: %s", str(e))
            return document_extras_pb2.DeleteDocumentByIdResponse(
                success=False,
                message=str(e),
            )

    async def PartialDeleteDocument(self, request, context):
        """Selectively delete embeddings, graph, or file for a document."""
        scope = request.delete_scope
        logger.info(
            "DocumentExtras.PartialDeleteDocument - doc=%s scope=%s",
            request.document_id,
            scope,
        )
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                # Verify document exists
                doc = db.execute(
                    text("SELECT id, collection_id, processing_status, file_path FROM documents WHERE id = :id"),
                    {"id": request.document_id},
                ).fetchone()
                if not doc:
                    return document_extras_pb2.PartialDeleteResponse(
                        success=False,
                        message="Document not found",
                    )

                collection_id = str(doc.collection_id)

                if scope == "embeddings":
                    from src.main.service.document_processing.documents import delete_document_embeddings

                    await delete_document_embeddings(request.document_id, collection_id, request.user_id)
                    # Reset processing status to pending so it shows in upload tab for reprocessing
                    db.execute(
                        text("UPDATE documents SET processing_status = 'pending' WHERE id = :id"),
                        {"id": request.document_id},
                    )
                    db.commit()
                    return document_extras_pb2.PartialDeleteResponse(
                        success=True,
                        message="Embeddings deleted, document ready for reprocessing",
                    )

                elif scope == "graph":
                    # noinspection PyProtectedMember
                    from src.main.service.document_processing.documents import _delete_document_graph_nodes

                    await _delete_document_graph_nodes(request.document_id)
                    # Reset graph_sync_status
                    db.execute(
                        text("DELETE FROM graph_sync_status WHERE document_id = :id"),
                        {"id": request.document_id},
                    )
                    db.commit()
                    return document_extras_pb2.PartialDeleteResponse(
                        success=True,
                        message="Graph data deleted",
                    )

                elif scope == "file":
                    import os

                    file_path = doc.file_path
                    if file_path:
                        # Handle both relative and absolute paths
                        abs_path = file_path if os.path.isabs(file_path) else os.path.join("/app", file_path)
                        if os.path.exists(abs_path):
                            os.remove(abs_path)
                            logger.info("Deleted physical file: %s", abs_path)
                    # Mark as not stored
                    db.execute(
                        text("UPDATE documents SET file_stored = false WHERE id = :id"),
                        {"id": request.document_id},
                    )
                    db.commit()
                    return document_extras_pb2.PartialDeleteResponse(
                        success=True,
                        message="Physical file deleted",
                    )

                else:
                    return document_extras_pb2.PartialDeleteResponse(
                        success=False,
                        message="Invalid scope: must be 'embeddings', 'graph', or 'file'",
                    )
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error in PartialDeleteDocument: %s", str(e))
            return document_extras_pb2.PartialDeleteResponse(
                success=False,
                message=str(e),
            )

    async def GetStorageUsage(self, request, context):
        # Do not dump the full collection_ids list — 100+ UUIDs per request
        # spamming every log line turns into hundreds of MB of container log
        # file over a few hours (disk pressure incident 2026-04-17).
        collection_ids_list = list(request.collection_ids)
        logger.info(
            "DocumentExtras.GetStorageUsage - count=%d, sample=%s",
            len(collection_ids_list),
            collection_ids_list[:3] + (["…"] if len(collection_ids_list) > 3 else []),
        )
        if not collection_ids_list:
            return document_extras_pb2.StorageUsageResponse(
                document_count=0,
                total_size_bytes=0,
            )

        # Sync DB queries + os.walk() across the upload tree blocks the
        # asyncio event loop and starves every other gRPC call (the 15 s
        # default deadline expires on unrelated RPCs while this scan runs).
        # Run the blocking work in a worker thread.
        def _scan(collection_ids: list[str]) -> document_extras_pb2.StorageUsageResponse:
            import os

            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                # db_content_bytes uses pg_column_size(content), NOT LENGTH(content).
                # LENGTH() counts CHARACTERS, which forces Postgres to fully
                # detoast (read the ~700MB+ TOAST table) AND UTF-8-decode every
                # row to count code points — ~15s for an admin with 3k+ docs, and
                # it was the entire cost of /storage/quota + /storage/workspace.
                # pg_column_size() reads the stored datum size from the TOAST
                # pointer in the main heap tuple WITHOUT detoasting (~0.04s, ~380x
                # faster) and returns the real compressed on-disk byte size, which
                # is a more accurate "DB content bytes" than an uncompressed char
                # count anyway.
                agg = db.execute(
                    text("""
                        SELECT COUNT(*),
                               COALESCE(SUM(file_size), 0),
                               COALESCE(SUM(pg_column_size(content)), 0)
                        FROM documents
                        WHERE collection_id = ANY(CAST(:ids AS uuid[]))
                    """),
                    {"ids": collection_ids},
                ).fetchone()

                doc_count = int(agg[0] or 0)
                billable_bytes = int(agg[1] or 0)
                db_content_bytes = int(agg[2] or 0)

                disk_bytes = 0
                thumbnail_bytes = 0
                upload_base = "/app/data/upload"
                thumbnail_base = "/app/data/thumbnails"
                upload_user_dirs = os.listdir(upload_base) if os.path.isdir(upload_base) else []
                for cid in collection_ids:
                    for user_dir in upload_user_dirs:
                        coll_path = os.path.join(upload_base, user_dir, cid)
                        if os.path.isdir(coll_path):
                            for dp, _dn, fn in os.walk(coll_path):
                                for f in fn:
                                    fsize = os.path.getsize(os.path.join(dp, f))
                                    if "_thumb_" in f:
                                        thumbnail_bytes += fsize
                                    else:
                                        disk_bytes += fsize
                    coll_thumb = os.path.join(thumbnail_base, cid)
                    if os.path.isdir(coll_thumb):
                        for dp, _dn, fn in os.walk(coll_thumb):
                            thumbnail_bytes += sum(os.path.getsize(os.path.join(dp, f)) for f in fn)

                # The BILLABLE measure is SUM(documents.file_size) — the original
                # upload size of every document, attributed per row regardless
                # of physical dedup or memory-only storage. The Kotlin quota
                # check (UsageType.STORAGE_BYTES) consumes total_size_bytes, so
                # this keeps both enforcement points on one measure; the
                # disk/db/thumbnail breakdown stays for the UI as operational
                # detail (it can legitimately differ — dedup, TOAST, thumbs).
                total_bytes = billable_bytes

                docs = db.execute(
                    text("""
                        SELECT id, filename, file_size
                        FROM documents
                        WHERE collection_id = ANY(CAST(:ids AS uuid[]))
                        ORDER BY file_size DESC NULLS LAST
                    """),
                    {"ids": collection_ids},
                ).fetchall()

                doc_items = [
                    document_extras_pb2.DocumentStorageItem(
                        id=str(d[0]),
                        filename=d[1] or "",
                        file_size=int(d[2] or 0),
                    )
                    for d in docs
                ]

                return document_extras_pb2.StorageUsageResponse(
                    document_count=doc_count,
                    total_size_bytes=total_bytes,
                    documents=doc_items,
                    disk_bytes=disk_bytes,
                    db_content_bytes=db_content_bytes,
                    thumbnail_bytes=thumbnail_bytes,
                )
            finally:
                db.close()

        try:
            return await asyncio.to_thread(_scan, collection_ids_list)
        except Exception as e:
            logger.exception("Error in GetStorageUsage: %s", str(e))
            return document_extras_pb2.StorageUsageResponse(
                document_count=0,
                total_size_bytes=0,
            )

    async def MoveDocuments(self, request, context):
        """Move documents to a different collection, updating embeddings linkage."""
        doc_ids = list(request.document_ids)
        target_cid = request.target_collection_id
        logger.info(
            "DocumentExtras.MoveDocuments - %d docs → collection=%s, user=%s",
            len(doc_ids),
            target_cid,
            request.user_id,
        )
        moved = 0
        failed_ids = []
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                # Look up the langchain_pg_collection UUID for the target collection
                lc_row = db.execute(
                    text("SELECT uuid FROM langchain_pg_collection WHERE name = :name"),
                    {"name": target_cid},
                ).fetchone()
                lc_target_uuid = lc_row[0] if lc_row else None

                for doc_id in doc_ids:
                    try:
                        # Update documents.collection_id
                        result = db.execute(
                            text("""
                                UPDATE documents
                                SET collection_id = :target, updated_at = NOW()
                                WHERE id = :did
                            """),
                            {"target": target_cid, "did": doc_id},
                        )
                        if result.rowcount == 0:
                            failed_ids.append(doc_id)
                            continue

                        # Update langchain_pg_embedding.collection_id if target exists
                        if lc_target_uuid:
                            db.execute(
                                text("""
                                    UPDATE langchain_pg_embedding
                                    SET collection_id = :lc_uuid
                                    WHERE cmetadata->>'document_id' = :did
                                """),
                                {"lc_uuid": str(lc_target_uuid), "did": doc_id},
                            )

                        moved += 1
                    except Exception as e:
                        logger.warning("Failed to move document %s: %s", doc_id, str(e))
                        failed_ids.append(doc_id)

                db.commit()
                logger.info("Moved %d/%d documents to collection %s", moved, len(doc_ids), target_cid)
            finally:
                db.close()

            return document_extras_pb2.MoveDocumentsResponse(
                success=len(failed_ids) == 0,
                moved_count=moved,
                failed_count=len(failed_ids),
                failed_document_ids=failed_ids,
                message=f"Moved {moved} documents" if not failed_ids else f"Moved {moved}, failed {len(failed_ids)}",
            )
        except Exception as e:
            logger.exception("Error in MoveDocuments: %s", str(e))
            return document_extras_pb2.MoveDocumentsResponse(
                success=False,
                moved_count=0,
                failed_count=len(doc_ids),
                failed_document_ids=doc_ids,
                message=str(e),
            )

    async def BatchDeleteDocuments(self, request, context):
        """Delete multiple documents in one call, reusing single-delete logic."""
        doc_ids = list(request.document_ids)
        logger.info(
            "DocumentExtras.BatchDeleteDocuments - %d docs, user=%s",
            len(doc_ids),
            request.user_id,
        )
        deleted = 0
        failed_ids = []
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                # Get collection_id for each document
                rows = db.execute(
                    text("""
                        SELECT id::text, collection_id::text
                        FROM documents
                        WHERE id = ANY(CAST(:ids AS uuid[]))
                    """),
                    {"ids": doc_ids},
                ).fetchall()
                doc_collection_map = {r[0]: r[1] for r in rows}
            finally:
                db.close()

            # Delete each document using the existing DeleteDocument method
            for doc_id in doc_ids:
                collection_id = doc_collection_map.get(doc_id, "")
                try:
                    sub_request = document_extras_pb2.DeleteDocumentByIdRequest(
                        document_id=doc_id,
                        collection_id=collection_id,
                        user_id=request.user_id,
                    )
                    result = await self.DeleteDocument(sub_request, context)
                    if result.success:
                        deleted += 1
                    else:
                        failed_ids.append(doc_id)
                except Exception as e:
                    logger.warning("Failed to delete document %s: %s", doc_id, str(e))
                    failed_ids.append(doc_id)

            return document_extras_pb2.BatchDeleteDocumentsResponse(
                success=len(failed_ids) == 0,
                deleted_count=deleted,
                failed_count=len(failed_ids),
                failed_document_ids=failed_ids,
            )
        except Exception as e:
            logger.exception("Error in BatchDeleteDocuments: %s", str(e))
            return document_extras_pb2.BatchDeleteDocumentsResponse(
                success=False,
                deleted_count=0,
                failed_count=len(doc_ids),
                failed_document_ids=doc_ids,
            )

    async def GetCollectionStats(self, request, context):
        """Return aggregated statistics for a collection.

        The aggregates scan ``langchain_pg_embedding`` and walk thumbnails on
        disk. During bulk uploads that table is hammered by slow embedding
        row inserts, so this can take many seconds. It MUST run off the asyncio
        event loop — a blocking ``db.execute`` here stalls the single grpc.aio
        loop and every other concurrent RPC (providers, jobs, voices) times out
        with it. Mirror the ``GetStorageUsage`` pattern: do all blocking work in
        a worker thread via ``asyncio.to_thread``.
        """
        logger.info("DocumentExtras.GetCollectionStats - collection=%s", request.collection_id)

        cid = request.collection_id

        def _stats():
            from sqlalchemy import text as sql_text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                # Documents: total, stored on disk, memory-only (exclude soft-deleted)
                doc_row = db.execute(
                    sql_text("""
                    SELECT COUNT(*) as total,
                           COUNT(CASE WHEN file_stored = true THEN 1 END) as stored,
                           COUNT(CASE WHEN file_stored = false THEN 1 END) as memory_only
                    FROM documents WHERE collection_id = :cid AND deleted_at IS NULL
                """),
                    {"cid": cid},
                ).fetchone()

                # Total embedding chunks: plain COUNT over the collection_id btree
                # (ix_lpe_collection_id) is an index-only scan — ~40 ms even for a
                # 560k-chunk collection. Resolve the langchain uuid from the name once.
                chunks_row = db.execute(
                    sql_text("""
                    SELECT COUNT(*) as total_chunks
                    FROM langchain_pg_embedding
                    WHERE collection_id = (
                        SELECT uuid FROM langchain_pg_collection WHERE name = :cid
                    )
                """),
                    {"cid": cid},
                ).fetchone()

                # Docs with embeddings: counting DISTINCT cmetadata->>'document_id'
                # over every chunk detoasts + sorts the whole collection (~7 s on a
                # megacollection). Instead probe each live document for the existence
                # of any chunk via ix_lpe_doc_chunk — bounded by the collection's doc
                # count, not its chunk count.
                docs_emb_row = db.execute(
                    sql_text("""
                    SELECT COUNT(*) as docs_with
                    FROM documents d
                    WHERE d.collection_id = CAST(:cid AS uuid)
                      AND d.deleted_at IS NULL
                      AND EXISTS (
                          SELECT 1 FROM langchain_pg_embedding e
                          WHERE e.cmetadata->>'document_id' = d.id::text
                      )
                """),
                    {"cid": cid},
                ).fetchone()

                # Graph sync status breakdown
                graph_rows = db.execute(
                    sql_text("""
                    SELECT status, COUNT(*) as cnt
                    FROM graph_sync_status
                    WHERE collection_id = :cid
                    GROUP BY status
                """),
                    {"cid": cid},
                ).fetchall()
                graph = {}
                for row in graph_rows:
                    graph[row.status] = row.cnt

                # Summaries (exclude soft-deleted documents)
                summary_row = db.execute(
                    sql_text("""
                    SELECT COUNT(DISTINCT ds.document_id) as docs_with,
                           COUNT(*) as total_records
                    FROM document_summaries ds
                    JOIN documents d ON ds.document_id = d.id
                    WHERE d.collection_id = :cid AND d.deleted_at IS NULL
                """),
                    {"cid": cid},
                ).fetchone()

                return document_extras_pb2.CollectionStatsResponse(
                    total_documents=doc_row.total or 0,
                    docs_stored_on_disk=doc_row.stored or 0,
                    docs_memory_only=doc_row.memory_only or 0,
                    docs_with_embeddings=int(docs_emb_row.docs_with or 0),
                    total_embedding_chunks=int(chunks_row.total_chunks or 0),
                    graph_completed=graph.get("completed", 0),
                    graph_entity_running=graph.get("entity_running", 0),
                    graph_hierarchy_done=graph.get("hierarchy_done", 0),
                    graph_failed=graph.get("failed", 0),
                    graph_pending=graph.get("pending", 0),
                    docs_with_summaries=int(summary_row.docs_with or 0),
                    total_summary_records=int(summary_row.total_records or 0),
                    docs_with_thumbnails=self._count_thumbnails(cid, db),
                )
            finally:
                db.close()

        try:
            return await asyncio.to_thread(_stats)
        except Exception as e:
            logger.exception("Error in GetCollectionStats: %s", str(e))
            return document_extras_pb2.CollectionStatsResponse()

    @staticmethod
    def _count_thumbnails(collection_id, db):
        """Count documents that have at least one thumbnail on disk."""
        try:
            from sqlalchemy import text as sql_text

            from src.main.service.document.thumbnail_service import ThumbnailService

            docs = db.execute(
                sql_text("SELECT file_path FROM documents WHERE collection_id = :cid AND file_path IS NOT NULL"),
                {"cid": collection_id},
            ).fetchall()
            count = 0
            for doc in docs:
                if doc.file_path:
                    thumb = ThumbnailService.get_thumbnail_path(doc.file_path, "medium")
                    if thumb and os.path.exists(thumb):
                        count += 1
            return count
        except Exception as e:
            logger.warning("Failed to count thumbnails: %s", e)
            return 0

    async def BuildDocumentGraph(self, request, context):
        """Trigger entity extraction for a single document via Celery."""
        logger.info("DocumentExtras.BuildDocumentGraph - doc=%s, collection=%s", request.document_id, request.collection_id)
        try:
            from sqlalchemy import text as sql_text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                # Upsert graph_sync_status to pending
                db.execute(
                    sql_text("""
                    INSERT INTO graph_sync_status (document_id, collection_id, status, updated_at)
                    VALUES (:doc_id, :cid, 'pending', NOW())
                    ON CONFLICT (document_id) DO UPDATE SET status = 'pending', updated_at = NOW()
                """),
                    {"doc_id": request.document_id, "cid": request.collection_id},
                )
                db.commit()

                # Dispatch Celery task
                from src.main.workers.celery_app import celery_app

                celery_app.send_task(
                    "scrapalot.extract_entities",
                    args=[request.document_id, request.user_id, request.collection_id],
                )
                logger.info("Dispatched entity extraction for doc %s", request.document_id)
                return common_pb2.StatusResponse(success=True, message="Entity extraction dispatched")
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error in BuildDocumentGraph: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def RebuildDocumentEmbeddings(self, request, context):
        """Dispatch document reprocessing to Celery worker (non-blocking)."""
        logger.info("DocumentExtras.RebuildDocumentEmbeddings - doc=%s", request.document_id)
        try:
            from sqlalchemy import text as sql_text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                doc_row = db.execute(
                    sql_text("SELECT collection_id FROM documents WHERE id = :doc_id"),
                    {"doc_id": request.document_id},
                ).fetchone()

                if not doc_row:
                    return common_pb2.StatusResponse(success=False, message="Document not found")

                collection_id = str(doc_row.collection_id)
            finally:
                db.close()

            from src.main.workers.celery_app import celery_app

            celery_app.send_task(
                "scrapalot.reprocess_document",
                args=[request.document_id, collection_id, request.user_id],
                queue="documents",
            )
            return common_pb2.StatusResponse(success=True, message="Embedding rebuild started (entities preserved)")

        except Exception as e:
            logger.exception("Error in RebuildDocumentEmbeddings: %s", str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))

    async def DownloadBookCover(self, request, context):
        """Download book cover from Open Library using ISBN from document metadata.

        On the second (and later) call for the same document, picks a
        *different* cover by reading `file_metadata.thumbnail.cover_tried_ids`
        and excluding those Open Library cover IDs from the title search.
        ISBN-direct lookup is skipped on retry too (Open Library returns a
        single cover per ISBN, so re-asking would give the same image).
        When retries exhaust the alternatives, the current thumbnail is
        deleted and the response carries `source="no_more_covers"` so the
        UI can show a "no more options" toast.
        """
        logger.info("DocumentExtras.DownloadBookCover - doc=%s", request.document_id)
        try:
            import json
            import os
            import re

            from sqlalchemy import text

            from src.main.config.database import SessionLocal
            from src.main.service.document.thumbnail_service import ThumbnailService

            db = SessionLocal()
            try:
                row = db.execute(
                    text("SELECT file_path, extracted_metadata, filename, title, file_metadata FROM documents WHERE id = :id"),
                    {"id": request.document_id},
                ).fetchone()
            finally:
                db.close()

            if not row:
                return document_extras_pb2.DownloadBookCoverResponse(success=False, message="Document not found")

            file_path = row[0]
            metadata = row[1] if row[1] else {}
            doc_filename = row[2] or ""
            doc_title = row[3] or ""
            file_meta_raw = row[4]
            if isinstance(metadata, str):
                metadata = json.loads(metadata)

            # Retrieve the historical attempt log so a retry can skip the
            # cover IDs we already showed the user. `file_metadata` is JSONB
            # but some legacy rows are double-encoded strings — unwrap until
            # we land on a dict.
            existing_file_meta: dict = {}
            if file_meta_raw:
                parsed = file_meta_raw if isinstance(file_meta_raw, dict) else json.loads(file_meta_raw)
                if isinstance(parsed, str):
                    try:
                        parsed = json.loads(parsed)
                    except json.JSONDecodeError:
                        parsed = {}
                existing_file_meta = parsed if isinstance(parsed, dict) else {}

            thumb_meta = existing_file_meta.get("thumbnail") or {}
            tried_ids_raw = thumb_meta.get("cover_tried_ids") or []
            tried_cover_ids: set[int] = {int(x) for x in tried_ids_raw if isinstance(x, (int, str)) and str(x).isdigit()}
            isbn_already_tried = bool(thumb_meta.get("cover_tried_isbn"))
            is_retry = bool(tried_cover_ids) or isbn_already_tried

            # Author lives in `extracted_metadata.author` (a "; "-separated
            # string when the document has multiple authors). Passing it to
            # the title-based search prevents picking covers of unrelated
            # same-titled books.
            doc_author = metadata.get("author") or ""

            # Extract ISBN from metadata
            isbn = metadata.get("isbn", "")

            # If no ISBN in metadata, try to find it in document content
            if not isbn:
                # Try extracting from first few pages of text content
                try:
                    db2 = SessionLocal()
                    try:
                        content_row = db2.execute(
                            text("SELECT LEFT(content, 5000) FROM documents WHERE id = :id AND content IS NOT NULL"),
                            {"id": request.document_id},
                        ).fetchone()
                    finally:
                        db2.close()

                    if content_row and content_row[0]:
                        # ISBN-13: 978 or 979 prefix
                        isbn_13 = re.search(
                            r"(?:ISBN[-\s]?13[:\s]?\s*)?(?:97[89][-\s]?\d[-\s]?\d{2}[-\s]?\d{6}[-\s]?\d)",
                            content_row[0],
                        )
                        # ISBN-10
                        isbn_10 = re.search(r"(?:ISBN[-\s]?10[:\s]?\s*)?\d[-\s]?\d{2}[-\s]?\d{5}[-\s]?[\dXx]", content_row[0])

                        if isbn_13:
                            isbn = re.sub(r"[^0-9]", "", isbn_13.group())
                        elif isbn_10:
                            isbn = re.sub(r"[^0-9Xx]", "", isbn_10.group()).upper()
                except Exception as e:
                    logger.debug("ISBN content scan failed: %s", e)

            # Thumbnail location is derived from `file_path` even when the
            # physical document file is absent on disk — `file_stored=False`
            # docs (markdown-only, content stored in `documents.content`) and
            # docs whose binary was pruned still have a canonical path.
            # `save_custom_thumbnail` calls `os.makedirs(..., exist_ok=True)`
            # so the parent directory is recreated if it was cleaned up.
            if not file_path:
                return document_extras_pb2.DownloadBookCoverResponse(
                    success=False,
                    message="Document has no file_path; cannot derive thumbnail location",
                )

            full_path = os.path.join(os.getcwd(), file_path)

            # Negative cache: if a prior NON-retry lookup already exhausted Open
            # Library for this doc and found nothing, skip the slow OL search on
            # every auto-fetch (page load) — re-running it repeatedly blows the
            # gRPC deadline and makes the backend retry, producing
            # DEADLINE_EXCEEDED storms for cover-less books. A user-initiated
            # retry (is_retry) bypasses this so "try another cover" still probes
            # OL. The marker expires after 30 days so a book that gains a cover
            # on Open Library later is eventually re-probed.
            from datetime import UTC, datetime, timedelta

            cover_failed_at = thumb_meta.get("cover_lookup_failed_at")
            if not is_retry and cover_failed_at:
                try:
                    failed_dt = datetime.fromisoformat(cover_failed_at)
                    fresh = datetime.now(UTC) - failed_dt < timedelta(days=30)
                except (ValueError, TypeError):
                    fresh = False
                if fresh:
                    logger.info("DownloadBookCover - doc=%s short-circuited (cached no-cover)", request.document_id)
                    return document_extras_pb2.DownloadBookCoverResponse(
                        success=False,
                        message="No cover available for this document (cached)",
                        isbn=isbn or "",
                        source="no_more_covers",
                    )

            # Try ISBN first when we have one (more precise — picks the exact
            # edition the user uploaded). If the ISBN search returns no usable
            # cover, fall through to title-based search instead of failing —
            # Open Library covers many books by ID but not by every ISBN they
            # carry, so an "ISBN miss" doesn't mean the book has no cover.
            # Skip ISBN-direct on retry — OL returns one cover per ISBN, so
            # asking again would give the same image we already rejected.
            source: str | None = None
            new_cover_id: int | None = None
            isbn_succeeded = False
            if isbn and not isbn_already_tried:
                source = ThumbnailService.download_cover_from_internet(full_path, isbn)
                isbn_succeeded = bool(source)

            if not source:
                title_result = ThumbnailService.download_cover_by_title(
                    full_path,
                    doc_filename,
                    author=doc_author or None,
                    title=doc_title or None,
                    skip_cover_ids=tried_cover_ids,
                )
                if title_result:
                    source, new_cover_id = title_result

            if not source:
                # Retry exhausted the alternatives — wipe the current
                # thumbnail so the UI falls back to the stylised fake cover
                # and signal `no_more_covers` so the frontend toasts the
                # right message instead of generic "download failed".
                if is_retry:
                    try:
                        ThumbnailService.delete_thumbnails(full_path)
                    except Exception as e:
                        logger.debug("Failed to delete stale thumbnail on retry exhaustion: %s", e)
                    try:
                        db_meta = SessionLocal()
                        try:
                            file_meta = dict(existing_file_meta)
                            thumb = dict(file_meta.get("thumbnail") or {})
                            thumb["has_thumbnail"] = False
                            thumb["has_custom"] = False
                            file_meta["thumbnail"] = thumb
                            db_meta.execute(
                                text("UPDATE documents SET file_metadata = CAST(:meta AS jsonb) WHERE id = :id"),
                                {"meta": json.dumps(file_meta), "id": request.document_id},
                            )
                            db_meta.commit()
                        finally:
                            db_meta.close()
                    except Exception as e:
                        logger.debug("Failed to clear thumbnail flags on retry exhaustion: %s", e)
                    return document_extras_pb2.DownloadBookCoverResponse(
                        success=False,
                        message="No more alternative covers available",
                        isbn=isbn or "",
                        source="no_more_covers",
                    )
                # First (non-retry) lookup found nothing: stamp a negative-cache
                # marker so subsequent auto-fetches short-circuit instead of
                # re-running the slow OL search and blowing the gRPC deadline.
                try:
                    db_meta = SessionLocal()
                    try:
                        file_meta = dict(existing_file_meta)
                        thumb = dict(file_meta.get("thumbnail") or {})
                        thumb["has_thumbnail"] = False
                        thumb["has_custom"] = False
                        thumb["cover_lookup_failed_at"] = datetime.now(UTC).isoformat()
                        file_meta["thumbnail"] = thumb
                        db_meta.execute(
                            text("UPDATE documents SET file_metadata = CAST(:meta AS jsonb) WHERE id = :id"),
                            {"meta": json.dumps(file_meta), "id": request.document_id},
                        )
                        db_meta.commit()
                    finally:
                        db_meta.close()
                except Exception as e:
                    logger.debug("Failed to stamp cover negative-cache marker: %s", e)

                if isbn:
                    fail_msg = f"No cover found for ISBN {isbn} and no usable match by title"
                else:
                    fail_msg = "No ISBN found and no cover found by title on Open Library"
                return document_extras_pb2.DownloadBookCoverResponse(success=False, message=fail_msg, isbn=isbn or "")

            # Cover downloaded — update document metadata so the frontend
            # picks up the thumbnail immediately and the ISBN we recovered
            # (if any) sticks for the next render.
            try:
                db_meta = SessionLocal()
                try:
                    if isbn_succeeded and not metadata.get("isbn"):
                        metadata["isbn"] = isbn
                        db_meta.execute(
                            text("UPDATE documents SET extracted_metadata = :meta WHERE id = :id"),
                            {"id": request.document_id, "meta": json.dumps(metadata)},
                        )

                    file_meta_row = db_meta.execute(
                        text("SELECT file_metadata FROM documents WHERE id = :id"),
                        {"id": request.document_id},
                    ).fetchone()
                    file_meta = {}
                    if file_meta_row and file_meta_row[0]:
                        raw = file_meta_row[0]
                        parsed = raw if isinstance(raw, dict) else json.loads(raw)
                        # Some historic rows are double-encoded JSON ("{...}") — unwrap once more.
                        if isinstance(parsed, str):
                            try:
                                parsed = json.loads(parsed)
                            except json.JSONDecodeError:
                                parsed = {}
                        file_meta = parsed if isinstance(parsed, dict) else {}
                    existing_thumb = file_meta.get("thumbnail") or {}
                    updated_tried = sorted(tried_cover_ids | ({new_cover_id} if new_cover_id else set()))
                    file_meta["thumbnail"] = {
                        **existing_thumb,
                        "has_thumbnail": True,
                        "has_custom": True,
                        "sizes": ["large"],
                        "cover_downloaded": True,
                        "cover_source": source,
                        "cover_tried_ids": updated_tried,
                        "cover_tried_isbn": isbn_already_tried or isbn_succeeded,
                    }
                    # A cover was found — clear any stale negative-cache marker.
                    file_meta["thumbnail"].pop("cover_lookup_failed_at", None)
                    db_meta.execute(
                        text("UPDATE documents SET file_metadata = CAST(:meta AS jsonb) WHERE id = :id"),
                        {"meta": json.dumps(file_meta), "id": request.document_id},
                    )
                    db_meta.commit()
                finally:
                    db_meta.close()
            except Exception as e:
                logger.debug("Failed to update metadata after cover download: %s", e)

            if isbn_succeeded:
                message = f"Cover downloaded from {source}"
            elif isbn:
                message = f"No cover for ISBN {isbn}; cover downloaded from {source} via title fallback"
            else:
                message = "Cover downloaded from Open Library (title search)"
            return document_extras_pb2.DownloadBookCoverResponse(
                success=True,
                message=message,
                isbn=isbn if isbn_succeeded else "",
                source=source,
            )

        except Exception as e:
            logger.exception("Error in DownloadBookCover: %s", str(e))
            return document_extras_pb2.DownloadBookCoverResponse(success=False, message=str(e))

    # ── Multimodal element listing ────────────────────────────────────

    async def ListDocumentMultimodalElements(self, request, context):
        """List image / table / equation elements extracted from a document."""
        import json

        logger.info(
            "DocumentExtras.ListDocumentMultimodalElements - document=%s user=%s",
            request.document_id,
            request.user_id,
        )
        try:
            from src.main.models.sqlmodel_multimodal import MultimodalElement

            with grpc_db_session() as db:
                rows = (
                    db.query(MultimodalElement)
                    # noinspection PyTypeChecker
                    .filter(MultimodalElement.document_id == request.document_id)
                    .order_by(MultimodalElement.page_idx, MultimodalElement.element_index)
                    .all()
                )

                def _json_or_empty(v):
                    if v is None:
                        return ""
                    if isinstance(v, (dict, list)):
                        try:
                            return json.dumps(v)
                        except (TypeError, ValueError):
                            return ""
                    return str(v)

                infos = [
                    document_extras_pb2.MultimodalElementInfo(
                        id=str(r.id),
                        element_type=r.element_type or "",
                        entity_subtype=r.entity_subtype or "",
                        page_idx=r.page_idx if r.page_idx is not None else 0,
                        entity_name=r.entity_name or "",
                        caption=r.caption or "",
                        description=r.description or "",
                        content_text=r.content_text or "",
                        storage_path=r.storage_path or "",
                        bbox_json=_json_or_empty(r.bbox_json),
                        symbol_map_json=_json_or_empty(r.symbol_map),
                        structured_data_json=_json_or_empty(r.structured_data),
                        derived_stats_json=_json_or_empty(r.derived_stats),
                        processing_status=r.processing_status or "",
                        described_at=r.described_at.isoformat() if r.described_at else "",
                    )
                    for r in rows
                ]
                return document_extras_pb2.ListDocumentMultimodalElementsResponse(
                    elements=infos,
                    total_count=len(infos),
                )
        except Exception as e:
            logger.exception("Error in ListDocumentMultimodalElements: %s", str(e))
            return document_extras_pb2.ListDocumentMultimodalElementsResponse(
                elements=[],
                total_count=0,
            )

    # ── Tags ──────────────────────────────────────────────────────────

    async def ListTags(self, request, context):
        """List all tags for a user in a workspace."""
        logger.info("DocumentExtras.ListTags - user=%s, workspace=%s", request.user_id, request.workspace_id)
        try:
            from src.main.service.document.tag_service import list_tags

            with grpc_db_session() as db:
                tags = list_tags(db, request.user_id, request.workspace_id)
                return document_extras_pb2.ListTagsResponse(
                    tags=[
                        document_extras_pb2.TagInfo(
                            id=t["id"],
                            name=t["name"],
                            color=t["color"],
                            position=t.get("position", 0) or 0,
                            doc_count=t.get("doc_count", 0) or 0,
                            tag_type=t.get("tag_type", 0) or 0,
                        )
                        for t in tags
                    ]
                )
        except Exception as e:
            logger.exception("Error in ListTags: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.ListTagsResponse()

    async def TagDocument(self, request, context):
        """Add a tag to a document."""
        logger.info("DocumentExtras.TagDocument - doc=%s, tag=%s, user=%s", request.document_id, request.tag_id, request.user_id)
        try:
            from src.main.service.document.tag_service import tag_document

            with grpc_db_session() as db:
                success = tag_document(db, request.document_id, request.tag_id, request.user_id)
                if not success:
                    context.set_code(grpc.StatusCode.PERMISSION_DENIED)
                    context.set_details("Failed to tag document or tag does not belong to user")
                return google.protobuf.empty_pb2.Empty()
        except Exception as e:
            logger.exception("Error in TagDocument: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return google.protobuf.empty_pb2.Empty()

    async def UntagDocument(self, request, context):
        """Remove a tag from a document."""
        logger.info(
            "DocumentExtras.UntagDocument - doc=%s, tag=%s, user=%s",
            request.document_id,
            request.tag_id,
            request.user_id,
        )
        try:
            from src.main.service.document.tag_service import untag_document

            with grpc_db_session() as db:
                success = untag_document(db, request.document_id, request.tag_id, request.user_id)
                if not success:
                    context.set_code(grpc.StatusCode.NOT_FOUND)
                    context.set_details("Tag not found on document or tag does not belong to user")
                return google.protobuf.empty_pb2.Empty()
        except Exception as e:
            logger.exception("Error in UntagDocument: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return google.protobuf.empty_pb2.Empty()

    async def GetDocumentTags(self, request, context):
        """Get all tags for a document."""
        logger.info("DocumentExtras.GetDocumentTags - doc=%s", request.document_id)
        try:
            from src.main.service.document.tag_service import get_document_tags

            with grpc_db_session() as db:
                tags = get_document_tags(db, request.document_id)
                return document_extras_pb2.ListTagsResponse(
                    tags=[
                        document_extras_pb2.TagInfo(
                            id=t["id"],
                            name=t["name"],
                            color=t["color"],
                            position=t.get("position", 0) or 0,
                            doc_count=0,
                        )
                        for t in tags
                    ]
                )
        except Exception as e:
            logger.exception("Error in GetDocumentTags: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.ListTagsResponse()

    # ── Document Relations ────────────────────────────────────────────

    async def CreateDocumentRelation(self, request, context):
        """Create a bidirectional relation between two documents."""
        logger.info(
            "DocumentExtras.CreateDocumentRelation - src=%s, tgt=%s, type=%s",
            request.source_document_id,
            request.target_document_id,
            request.relationship_type,
        )
        # Community Edition: document relations are not bundled.
        context.set_code(grpc.StatusCode.UNIMPLEMENTED)
        context.set_details("Document relations are not available in this edition")
        return document_extras_pb2.DocumentRelationResponse(success=False)

    async def ListDocumentRelations(self, request, context):
        """List all relations for a document."""
        logger.info("DocumentExtras.ListDocumentRelations - doc=%s", request.document_id)
        # Community Edition: document relations are not bundled.
        return document_extras_pb2.ListRelationsResponse(outgoing=[], incoming=[])

    async def DeleteDocumentRelation(self, request, context):
        """Delete a relation and its inverse (by relation_id or by src/tgt/type)."""
        use_id = request.HasField("relation_id") and request.relation_id
        logger.info(
            "DocumentExtras.DeleteDocumentRelation - %s",
            (
                f"relation_id={request.relation_id}"
                if use_id
                else f"src={request.source_document_id}, tgt={request.target_document_id}, type={request.relationship_type}"
            ),
        )
        # Community Edition: document relations are not bundled.
        context.set_code(grpc.StatusCode.UNIMPLEMENTED)
        context.set_details("Document relations are not available in this edition")
        return google.protobuf.empty_pb2.Empty()

    # ── Saved Searches ────────────────────────────────────────────────

    async def CreateSavedSearch(self, request, context):
        """Create a new saved search."""
        logger.info("DocumentExtras.CreateSavedSearch - user=%s, name=%s", request.user_id, request.name)
        try:
            from src.main.service.search.saved_search_service import create_saved_search

            criteria = json.loads(request.criteria_json) if request.criteria_json else {}
            color = request.color if request.HasField("color") else None

            with grpc_db_session() as db:
                result = create_saved_search(
                    db,
                    user_id=request.user_id,
                    workspace_id=request.workspace_id,
                    name=request.name,
                    criteria=criteria,
                    color=color,
                )
                criteria_json = (
                    json.dumps(result.get("criteria", {})) if isinstance(result.get("criteria"), dict) else str(result.get("criteria", ""))
                )
                return document_extras_pb2.SavedSearchResponse(
                    success=True,
                    search=document_extras_pb2.SavedSearchInfo(
                        id=result["id"],
                        name=result["name"],
                        criteria_json=criteria_json,
                        color=result.get("color", "") or "",
                        created_at=result.get("created_at", ""),
                    ),
                )
        except Exception as e:
            logger.exception("Error in CreateSavedSearch: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.SavedSearchResponse(success=False)

    async def UpdateSavedSearch(self, request, context):
        """Update an existing saved search."""
        logger.info("DocumentExtras.UpdateSavedSearch - search=%s, user=%s", request.search_id, request.user_id)
        try:
            from src.main.service.search.saved_search_service import update_saved_search

            criteria = json.loads(request.criteria_json) if request.HasField("criteria_json") else None
            color = request.color if request.HasField("color") else None
            name = request.name if request.HasField("name") else None
            is_pinned = request.is_pinned if request.HasField("is_pinned") else None

            with grpc_db_session() as db:
                result = update_saved_search(
                    db,
                    search_id=request.search_id,
                    user_id=request.user_id,
                    name=name,
                    criteria=criteria,
                    color=color,
                    is_pinned=is_pinned,
                )
                if not result:
                    context.set_code(grpc.StatusCode.NOT_FOUND)
                    context.set_details("Saved search not found")
                    return document_extras_pb2.SavedSearchResponse(success=False)

                criteria_json = (
                    json.dumps(result.get("criteria", {})) if isinstance(result.get("criteria"), dict) else str(result.get("criteria", ""))
                )
                return document_extras_pb2.SavedSearchResponse(
                    success=True,
                    search=document_extras_pb2.SavedSearchInfo(
                        id=result["id"],
                        name=result["name"],
                        criteria_json=criteria_json,
                        icon=result.get("icon", "") or "",
                        color=result.get("color", "") or "",
                        sort_order=result.get("sort_order", 0) or 0,
                        is_pinned=result.get("is_pinned", False),
                        result_count=result.get("result_count", 0) or 0,
                        last_evaluated_at=result.get("last_evaluated_at", "") or "",
                        created_at=result.get("created_at", ""),
                        updated_at=result.get("updated_at", ""),
                    ),
                )
        except Exception as e:
            logger.exception("Error in UpdateSavedSearch: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.SavedSearchResponse(success=False)

    async def ListSavedSearches(self, request, context):
        """List all saved searches for a user in a workspace."""
        logger.info("DocumentExtras.ListSavedSearches - user=%s, workspace=%s", request.user_id, request.workspace_id)
        try:
            from src.main.service.search.saved_search_service import list_saved_searches

            with grpc_db_session() as db:
                searches = list_saved_searches(db, request.user_id, request.workspace_id)
                return document_extras_pb2.ListSavedSearchesResponse(
                    searches=[
                        document_extras_pb2.SavedSearchInfo(
                            id=s["id"],
                            name=s["name"],
                            criteria_json=(json.dumps(s.get("criteria", {})) if isinstance(s.get("criteria"), dict) else str(s.get("criteria", ""))),
                            icon=s.get("icon", "") or "",
                            color=s.get("color", "") or "",
                            sort_order=s.get("sort_order", 0) or 0,
                            is_pinned=s.get("is_pinned", False),
                            result_count=s.get("result_count", 0) or 0,
                            last_evaluated_at=s.get("last_evaluated_at", "") or "",
                            created_at=s.get("created_at", ""),
                            updated_at=s.get("updated_at", ""),
                        )
                        for s in searches
                    ]
                )
        except Exception as e:
            logger.exception("Error in ListSavedSearches: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.ListSavedSearchesResponse()

    async def ExecuteSavedSearch(self, request, context):
        """Execute a saved search and return matching document IDs."""
        logger.info("DocumentExtras.ExecuteSavedSearch - search=%s, user=%s", request.search_id, request.user_id)
        try:
            from src.main.service.search.saved_search_service import evaluate_saved_search

            limit = request.limit if request.limit > 0 else 200

            with grpc_db_session() as db:
                document_ids = evaluate_saved_search(db, request.search_id, request.user_id, limit=limit)
                return document_extras_pb2.ExecuteSavedSearchResponse(document_ids=document_ids)
        except Exception as e:
            logger.exception("Error in ExecuteSavedSearch: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.ExecuteSavedSearchResponse()

    async def PreviewSavedSearch(self, request, context):
        """Preview search — returns count of matching documents without saving."""
        logger.info("DocumentExtras.PreviewSavedSearch - user=%s, workspace=%s", request.user_id, request.workspace_id)
        try:
            from src.main.service.search.saved_search_service import preview_search

            criteria = json.loads(request.criteria_json) if request.criteria_json else {}

            with grpc_db_session() as db:
                count = preview_search(db, criteria, request.workspace_id)
                return document_extras_pb2.PreviewSavedSearchResponse(count=count)
        except Exception as e:
            logger.exception("Error in PreviewSavedSearch: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.PreviewSavedSearchResponse(count=0)

    async def DeleteSavedSearch(self, request, context):
        """Delete a saved search."""
        logger.info("DocumentExtras.DeleteSavedSearch - search=%s, user=%s", request.search_id, request.user_id)
        try:
            from src.main.service.search.saved_search_service import delete_saved_search

            with grpc_db_session() as db:
                success = delete_saved_search(db, request.search_id, request.user_id)
                if not success:
                    context.set_code(grpc.StatusCode.NOT_FOUND)
                    context.set_details("Saved search not found")
                return google.protobuf.empty_pb2.Empty()
        except Exception as e:
            logger.exception("Error in DeleteSavedSearch: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return google.protobuf.empty_pb2.Empty()

    # ── Duplicate Detection ───────────────────────────────────────────

    async def FindDuplicates(self, request, context):
        """Find potential duplicate documents."""
        logger.info("DocumentExtras.FindDuplicates - doc=%s", request.document_id)
        try:
            from src.main.service.document.duplicate_detector import find_duplicates

            with grpc_db_session() as db:
                matches = find_duplicates(db, request.document_id)
                return document_extras_pb2.FindDuplicatesResponse(
                    matches=[
                        document_extras_pb2.DuplicateMatchEntry(
                            document_id=m.document_id,
                            title=m.title or "",
                            filename=m.filename or "",
                            match_type=m.match_type,
                            confidence=m.confidence,
                            doi=m.doi or "",
                            isbn=m.isbn or "",
                        )
                        for m in matches
                    ]
                )
        except Exception as e:
            logger.exception("Error in FindDuplicates: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.FindDuplicatesResponse()

    async def MergeDuplicates(self, request, context):
        """Merge a duplicate document into the canonical document."""
        logger.info(
            "DocumentExtras.MergeDuplicates - canonical=%s, duplicate=%s, user=%s",
            request.canonical_id,
            request.duplicate_id,
            request.user_id,
        )
        try:
            from src.main.service.document.duplicate_merger import merge_documents

            with grpc_db_session() as db:
                success, message = merge_documents(db, request.canonical_id, request.duplicate_id)
                return document_extras_pb2.MergeDuplicatesResponse(
                    success=success,
                    message=message,
                )
        except Exception as e:
            logger.exception("Error in MergeDuplicates: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.MergeDuplicatesResponse(
                success=False,
                message=str(e),
            )

    # ── Metadata Enrichment ───────────────────────────────────────────

    async def EnrichDocumentMetadata(self, request, context):
        """Extract identifiers from document text and resolve metadata via external APIs."""
        logger.info(
            "DocumentExtras.EnrichDocumentMetadata - doc=%s, user=%s, force=%s",
            request.document_id,
            request.user_id,
            request.force_refresh,
        )
        try:
            from sqlalchemy import text

            from src.main.service.metadata.identifier_extractor import extract_identifiers

            # noinspection PyProtectedMember
            from src.main.service.metadata.metadata_enrichment_service import (
                _already_enriched,
                _resolve_with_cache,
                _update_document_record,
            )

            with grpc_db_session() as db:
                # Fetch the first 5 pages of document content for identifier extraction
                row = db.execute(
                    text("SELECT content, extracted_metadata FROM documents WHERE id = :id"),
                    {"id": request.document_id},
                ).fetchone()

                if row is None:
                    context.set_code(grpc.StatusCode.NOT_FOUND)
                    context.set_details("Document not found")
                    return document_extras_pb2.EnrichMetadataResponse(
                        success=False,
                        enrichment_status="not_found",
                    )

                content = row.content or ""
                extracted_metadata = row.extracted_metadata

                # Check if already enriched (unless forced)
                if not request.force_refresh and _already_enriched(extracted_metadata):
                    logger.debug("Document %s already enriched, returning existing metadata", request.document_id)
                    # extracted_metadata uses nested format: {resolved: {title, authors, ...}}
                    resolved = extracted_metadata.get("resolved", {}) if extracted_metadata else {}
                    return document_extras_pb2.EnrichMetadataResponse(
                        success=True,
                        enrichment_status="resolved",
                        resolved_title=resolved.get("title", ""),
                        resolved_authors=resolved.get("authors", []),
                        resolved_year=resolved.get("year", 0) or 0,
                        resolved_journal=resolved.get("journal", ""),
                        resolved_doi=resolved.get("doi", ""),
                    )

            # Extract identifiers from text (first 5 pages)
            identifiers = extract_identifiers(content, max_pages=5)
            if not identifiers.has_any:
                logger.info("No identifiers found in document %s", request.document_id)
                return document_extras_pb2.EnrichMetadataResponse(
                    success=True,
                    enrichment_status="no_identifiers",
                )

            # Resolve via cache or live API calls
            metadata = await _resolve_with_cache(identifiers)
            if metadata is None:
                logger.info("Resolution failed for identifiers in document %s", request.document_id)
                return document_extras_pb2.EnrichMetadataResponse(
                    success=True,
                    enrichment_status="resolution_failed",
                )

            # Persist to DB
            _update_document_record(request.document_id, metadata)

            return document_extras_pb2.EnrichMetadataResponse(
                success=True,
                enrichment_status="resolved",
                resolved_title=metadata.title or "",
                resolved_authors=metadata.authors or [],
                resolved_year=metadata.year or 0,
                resolved_journal=metadata.journal or "",
                resolved_doi=metadata.doi or "",
            )

        except Exception as e:
            logger.exception("Error in EnrichDocumentMetadata: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.EnrichMetadataResponse(
                success=False,
                enrichment_status="error",
            )

    async def LookupIdentifier(self, request, context):
        """Resolve a specific identifier (DOI, ISBN, PMID, arXiv) to metadata and update the document."""
        logger.info(
            "DocumentExtras.LookupIdentifier - doc=%s, type=%s, value=%s",
            request.document_id,
            request.identifier_type,
            request.identifier_value,
        )
        try:
            from sqlalchemy import text

            from src.main.service.metadata.metadata_resolver import resolve_identifier

            # Validate identifier type
            valid_types = {"doi", "isbn", "pmid", "arxiv"}
            if request.identifier_type not in valid_types:
                context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
                context.set_details("Invalid identifier_type. Must be one of: doi, isbn, pmid, arxiv")
                return document_extras_pb2.LookupIdentifierResponse(
                    success=False,
                    message="Invalid identifier type",
                )

            # Verify the document exists
            with grpc_db_session() as db:
                row = db.execute(
                    text("SELECT id FROM documents WHERE id = :id"),
                    {"id": request.document_id},
                ).fetchone()
                if row is None:
                    context.set_code(grpc.StatusCode.NOT_FOUND)
                    context.set_details("Document not found")
                    return document_extras_pb2.LookupIdentifierResponse(
                        success=False,
                        message="Document not found",
                    )

            # Resolve the identifier via external API
            metadata = await resolve_identifier(request.identifier_type, request.identifier_value)
            if metadata is None:
                return document_extras_pb2.LookupIdentifierResponse(
                    success=False,
                    message=f"Could not resolve {request.identifier_type}: {request.identifier_value}",
                )

            # Update extracted_metadata in DB
            # noinspection PyProtectedMember
            from src.main.service.metadata.metadata_enrichment_service import _update_document_record

            _update_document_record(request.document_id, metadata)

            enrichment_resp = document_extras_pb2.EnrichMetadataResponse(
                success=True,
                enrichment_status="resolved",
                resolved_title=metadata.title or "",
                resolved_authors=metadata.authors or [],
                resolved_year=metadata.year or 0,
                resolved_journal=metadata.journal or "",
                resolved_doi=metadata.doi or "",
            )

            return document_extras_pb2.LookupIdentifierResponse(
                success=True,
                message="Resolved via %s" % metadata.source,
                metadata=enrichment_resp,
            )

        except Exception as e:
            logger.exception("Error in LookupIdentifier: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.LookupIdentifierResponse(
                success=False,
                message=str(e),
            )

    async def UpdateDocumentType(self, request, context):
        """Manually update the document_type field in extracted_metadata.resolved."""
        logger.info("DocumentExtras.UpdateDocumentType - doc=%s, type=%s", request.document_id, request.document_type)
        try:
            from sqlalchemy import text

            valid_types = {
                "journal_article",
                "book",
                "book_section",
                "conference_paper",
                "preprint",
                "thesis",
                "report",
                "patent",
            }
            if request.document_type and request.document_type not in valid_types:
                context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
                context.set_details("Invalid document_type")
                return document_extras_pb2.UpdateDocumentTypeResponse(
                    success=False,
                    message="Invalid document_type. Must be one of: %s" % ", ".join(sorted(valid_types)),
                )

            with grpc_db_session() as db:
                row = db.execute(
                    text("SELECT id, extracted_metadata FROM documents WHERE id = :id"),
                    {"id": request.document_id},
                ).fetchone()
                if row is None:
                    context.set_code(grpc.StatusCode.NOT_FOUND)
                    context.set_details("Document not found")
                    return document_extras_pb2.UpdateDocumentTypeResponse(success=False, message="Document not found")

                # Merge document_type into extracted_metadata.resolved
                import json

                existing = row[1] if row[1] else {}
                if isinstance(existing, str):
                    existing = json.loads(existing)
                resolved = existing.get("resolved", {})
                if request.document_type:
                    resolved["document_type"] = request.document_type
                else:
                    resolved.pop("document_type", None)
                existing["resolved"] = resolved

                db.execute(
                    text("UPDATE documents SET extracted_metadata = :meta WHERE id = :id"),
                    {"meta": json.dumps(existing), "id": request.document_id},
                )
                db.commit()

            return document_extras_pb2.UpdateDocumentTypeResponse(
                success=True,
                document_type=request.document_type,
                message="Document type updated",
            )

        except Exception as e:
            logger.exception("Error in UpdateDocumentType: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.UpdateDocumentTypeResponse(success=False, message=str(e))

    async def UpdateDocumentPriority(self, request, context):
        """Update document priority for retrieval weighting."""
        logger.info("DocumentExtras.UpdateDocumentPriority - doc=%s, priority=%s", request.document_id, request.priority)
        try:
            from sqlalchemy import text

            priority = max(0.1, min(5.0, request.priority))  # Clamp to 0.1-5.0
            with grpc_db_session() as db:
                result = db.execute(
                    text("UPDATE documents SET priority = :priority WHERE id = :id"),
                    {"id": request.document_id, "priority": priority},
                )
                if result.rowcount == 0:
                    context.set_code(grpc.StatusCode.NOT_FOUND)
                    return document_extras_pb2.UpdateDocumentPriorityResponse(
                        success=False,
                        priority=1.0,
                        message="Document not found",
                    )
                db.commit()
            return document_extras_pb2.UpdateDocumentPriorityResponse(
                success=True,
                priority=priority,
                message="Priority updated",
            )
        except Exception as e:
            logger.exception("Error in UpdateDocumentPriority: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            return document_extras_pb2.UpdateDocumentPriorityResponse(
                success=False,
                priority=1.0,
                message=str(e),
            )

    async def RestoreDocument(self, request, context):
        """Restore a soft-deleted document from trash."""
        logger.info("DocumentExtras.RestoreDocument - doc=%s", request.document_id)
        try:
            from sqlalchemy import text

            with grpc_db_session() as db:
                result = db.execute(
                    text("UPDATE documents SET deleted_at = NULL WHERE id = :id AND deleted_at IS NOT NULL"),
                    {"id": request.document_id},
                )
                if result.rowcount == 0:
                    context.set_code(grpc.StatusCode.NOT_FOUND)
                    context.set_details("Document not found in trash")
                    return document_extras_pb2.UpdateDocumentTypeResponse(success=False, message="Not found in trash")
                db.commit()
            return document_extras_pb2.UpdateDocumentTypeResponse(success=True, message="Document restored")
        except Exception as e:
            logger.exception("Error in RestoreDocument: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.UpdateDocumentTypeResponse(success=False, message=str(e))

    async def PurgeTrash(self, request, context):
        """Permanently delete all documents in trash older than 30 days."""
        logger.info("DocumentExtras.PurgeTrash - workspace=%s", request.user_id)
        try:
            from sqlalchemy import text

            with grpc_db_session() as db:
                result = db.execute(
                    text("DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days'"),
                )
                count = result.rowcount
                db.commit()
            logger.info("Purged %d documents from trash", count)
            return document_extras_pb2.UpdateDocumentTypeResponse(success=True, message="Purged %d documents" % count)
        except Exception as e:
            logger.exception("Error in PurgeTrash: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.UpdateDocumentTypeResponse(success=False, message=str(e))

    async def FindOpenAccessPdf(self, request, context):
        """Find open-access PDF via Unpaywall for a document with a DOI."""
        logger.info("DocumentExtras.FindOpenAccessPdf - document=%s", request.document_id)
        try:
            from sqlalchemy import text

            with grpc_db_session() as db:
                doc = db.execute(
                    text("SELECT extracted_metadata FROM documents WHERE id = CAST(:did AS uuid)"),
                    {"did": request.document_id},
                ).fetchone()
                if not doc or not doc[0]:
                    return document_extras_pb2.FindOpenAccessPdfResponse(success=False, message="Document not found or no metadata")

                meta = doc[0] if isinstance(doc[0], dict) else {}
                doi = meta.get("identifiers", {}).get("doi")
                if not doi:
                    return document_extras_pb2.FindOpenAccessPdfResponse(success=False, message="No DOI found for this document")

            from src.main.service.metadata.unpaywall_client import find_open_access_pdf

            result = await find_open_access_pdf(doi)

            return document_extras_pb2.FindOpenAccessPdfResponse(
                success=result.is_oa and bool(result.pdf_url),
                is_oa=result.is_oa,
                pdf_url=result.pdf_url or "",
                oa_status=result.oa_status or "",
                message="Open access PDF found" if result.pdf_url else "No open access version available",
            )
        except Exception as e:
            logger.exception("Error in FindOpenAccessPdf: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.FindOpenAccessPdfResponse(success=False, message=str(e))

    async def ExtractPdfAnnotations(self, request, context):
        """Extract annotations from an uploaded PDF file."""
        logger.info("DocumentExtras.ExtractPdfAnnotations - document=%s", request.document_id)
        try:
            from sqlalchemy import text

            with grpc_db_session() as db:
                doc = db.execute(
                    text("SELECT filename, collection_id FROM documents WHERE id = CAST(:did AS uuid)"),
                    {"did": request.document_id},
                ).fetchone()
                if not doc:
                    return document_extras_pb2.ExtractPdfAnnotationsResponse(success=False, message="Document not found")

                filename = doc[0]
                collection_id = str(doc[1])

            # Build file path
            import os

            data_dir = os.environ.get("DATA_DIR", "data")
            file_path = os.path.join(data_dir, "upload", collection_id, filename)
            if not os.path.exists(file_path):
                return document_extras_pb2.ExtractPdfAnnotationsResponse(success=False, message="PDF file not found on disk")

            from src.main.service.document.pdf_annotation_extractor import extract_pdf_annotations

            result = extract_pdf_annotations(file_path)

            entries = []
            for a in result.annotations:
                entries.append(
                    document_extras_pb2.ExtractedAnnotationEntry(
                        page_index=a.page_index,
                        annotation_type=a.annotation_type,
                        selected_text=a.selected_text,
                        comment=a.comment,
                        color_index=a.color_index,
                        position_json=a.position_json,
                    )
                )

            return document_extras_pb2.ExtractPdfAnnotationsResponse(
                success=True,
                annotations=entries,
                page_count=result.page_count,
                message="Extracted %d annotations" % len(entries),
            )
        except Exception as e:
            logger.exception("Error in ExtractPdfAnnotations: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return document_extras_pb2.ExtractPdfAnnotationsResponse(success=False, message=str(e))
