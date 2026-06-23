"""
Uploaded a document processing pipeline.

Handles the full indexing pipeline for documents uploaded via the UI or API:
text extraction → chunking → embedding → pgvector → Neo4j.
"""

from datetime import UTC, datetime
import os
import re
import traceback
from typing import Any

from src.main.background.db_utils import db_session
from src.main.models.enums import JobStatus
from src.main.models.sqlmodel_jobs import Job
from src.main.service.document.document_processor import document_processor
from src.main.service.document.documents import DocumentService
from src.main.utils.core.logger import get_logger
from src.main.utils.jobs.progress import publish_job_progress

logger = get_logger(__name__)


def _resolve_file_path(file_path: str) -> str:
    """
    Resolve a file path for cross-platform compatibility.

    When the API server runs on Windows and the worker runs in Docker (Linux),
    absolute paths need to be converted to the equivalent relative path.

    Args:
        file_path: File path (possibly a Windows absolute path or a relative path)

    Returns:
        Resolved absolute path for the current platform
    """
    if os.path.exists(file_path):
        return file_path

    pattern = r"[/\\]?data[/\\]upload[/\\](.+)$"
    match = re.search(pattern, file_path)

    if match:
        relative_portion = match.group(1).replace("\\", os.sep).replace("/", os.sep)
        resolved_path = os.path.join(os.getcwd(), "data", "upload", relative_portion)

        if os.path.exists(resolved_path):
            logger.info("Resolved cross-platform path: %s -> %s", file_path, resolved_path)
            return resolved_path

        logger.warning("Resolved path does not exist: %s", resolved_path)

    return file_path


def process_uploaded_document(
    job_id: str,
    document_id: str,
    collection_id: str,
    user_id: str,
    file_path: str,
    force_graph_build: bool = False,
    markdown_content: str | None = None,
) -> dict[str, Any]:
    """
    Process an uploaded document (from UI/API upload).

    Workflow:
    1. Extract text → chunk → embed
    2. Store embeddings in PgVector
    3. MERGE workspace/collection/book/paragraph nodes in Neo4j
    4. Mark the job as completed

    Args:
        job_id: Job ID for tracking
        document_id: Document ID being processed
        collection_id: Collection the document belongs to
        user_id: User who uploaded the document
        file_path: Path to the document file
        force_graph_build: Override SKIP_GRAPH_IN_BATCH env var and always
            build the Neo4j hierarchy. Used by reprocessed flows where the
            caller just deleted the old hierarchy and MUST rebuild it now,
            not wait for a future RebuildGraph admin call.
        markdown_content: Optional fallback Markdown for content-only documents
            (file_stored=false). When provided and the file is not on disk, the
            pipeline skips PDF/EPUB extraction and wraps the content directly as
            a LangChain Document. Used by the "agriculture" collection flow where
            pre-extracted Markdown lives in documents.content.

    Returns:
        Dict with processing results
    """
    file_path = _resolve_file_path(file_path)
    # If the caller explicitly handed us markdown_content, use it — don't
    # second-guess based on whether the source file happens to still live
    # on disk. The reprocess watchdog (workers/tasks/document_tasks.py)
    # passes pre-extracted content when force_parse_from_file=False and
    # documents.content already holds a non-trivial body; in that case
    # re-extracting from disk would mean a redundant Docling / pymupdf
    # parse that on large scanned PDFs can deadlock or take hours. The
    # pre-2026-05-28 form (`bool(markdown_content) and not os.path.exists`)
    # silently dropped the markdown_content arg whenever the disk file
    # existed, sending Cat-F replays back through the full extract path.
    content_only = bool(markdown_content)
    job: Job | None = None

    with db_session() as db:
        try:
            from src.main.service.retriever.retriever_manager import retriever_manager

            # Initialize RetrieverManager if not yet initialized (worker process has no startup sequence)
            # noinspection PyProtectedMember
            if not retriever_manager._config:
                import asyncio

                from src.main.utils.config.loader import resolved_config, resolved_secrets

                loop = asyncio.new_event_loop()
                loop.run_until_complete(retriever_manager.initialize(resolved_config, resolved_secrets))
                asyncio.set_event_loop(loop)

            # Step 1: Mark the job as processing. Upsert the Postgres
            # `jobs` row if missing — upstream callers (the new
            # UploadDocument gRPC handler) only initialise Redis-side
            # tracking via document_job_manager and hand the task the
            # Redis job_id string. Requiring a pre-existing Postgres
            # row there made every new-path upload fail with
            # "Job {id} not found in database".
            # noinspection PyTypeChecker
            job = db.query(Job).filter(Job.job_id == job_id).first()
            if not job:
                logger.info("Job row missing for %s — creating lazily", job_id)
                job = Job(
                    job_id=job_id,
                    job_type="document_processing",
                    status=JobStatus.PENDING.value,
                    document_id=document_id,
                    collection_id=collection_id,
                    user_id=user_id,
                    created_at=datetime.now(UTC),
                    updated_at=datetime.now(UTC),
                )
                db.add(job)
                db.flush()

            job.status = JobStatus.PROCESSING.value
            job.started_at = datetime.now(UTC).isoformat()
            job.progress = 5.0
            job.description = "startingProcessing"
            db.commit()

            _filename = _fetch_document_filename(db, document_id)

            publish_job_progress(
                job_id,
                document_id,
                user_id,
                collection_id,
                5.0,
                "startingProcessing",
                "processing",
                _filename,
            )
            logger.info("Started processing job %s for document %s", job_id, document_id)

            def progress_callback(job_id_inner: str, progress_data: dict[str, Any]):
                if job is None:
                    return
                try:
                    job.progress = progress_data.get("progress", job.progress)
                    job.description = progress_data.get("message", job.description)
                    db.commit()
                    publish_job_progress(
                        job_id_inner,
                        document_id,
                        user_id,
                        collection_id,
                        progress_data.get("progress", 0),
                        progress_data.get("message", "Processing..."),
                        "processing",
                        _filename,
                    )
                except Exception as ex:
                    logger.warning("Error updating progress: %s", ex)

            # Step 2: Validate workspace ACL
            document_service = DocumentService(db)
            workspace_info = document_service.get_workspace_for_collection_sync(collection_id, user_id)  # type: ignore[attr-defined]
            if not workspace_info:
                raise ValueError("errorWorkspacePermission")

            workspace_id = workspace_info["workspace_id"]

            # Step 3: Extract text, chunk, and build document objects
            job.progress = 15.0
            job.description = "extractingText"
            db.commit()
            publish_job_progress(
                job_id,
                document_id,
                user_id,
                collection_id,
                15.0,
                "extractingText",
                "processing",
                _filename,
            )

            import asyncio

            from src.main.service.settings import get_user_settings

            user_settings = asyncio.run(get_user_settings(user_id, db))
            ocr_enabled = user_settings.get("document_processing", {}).get("ocr_enabled", False)
            file_extension = os.path.splitext(file_path)[1].lower()

            # Audio/video transcription (Whisper) is a hosted-only feature and is
            # not available in the Community Edition. Media files are not processed.
            logger.debug("Media transcription skipped (hosted-only) in CE")

            if content_only:
                assert markdown_content is not None
                # Content-only flow: pre-extracted Markdown lives in documents.content
                # (file_stored=false). Wrap as LangChain page-document and run the
                # same chunking pipeline PDF/EPUB use. Without this step the whole
                # book becomes ONE giant embedding (strategy_used=None, 50k-2M chars),
                # which breaks RAG retrieval: an embedding model truncates at ~8k tokens
                # so ~99% of content is invisible to vector search, and you can't
                # target specific passages because top-k always returns "whole book".
                # Observed on 141 agriculture docs after today's bulk-content-only
                # reprocessing — all had NULL strategy_used and max chunk 2,105,594 chars.
                from langchain_core.documents import Document as LCDocument

                from src.main.utils.text.markdown import strip_publisher_boilerplate

                # Strip publisher running headers / open-access boilerplate so
                # legacy markdown_imported docs benefit from the same cleanup
                # the PDF parse path applies. Mirror of the strip in
                # documents.py::process_document_background.
                markdown_content = strip_publisher_boilerplate(markdown_content)

                page_documents = [
                    LCDocument(
                        page_content=markdown_content,
                        metadata={
                            "source": file_path or document_id,
                            # `page=0` is the sentinel for "no page boundaries
                            # available". Pre-extracted markdown ingested through
                            # this content-only path has no PDF page structure
                            # to pin a chunk to. Setting `page=1` made every
                            # chunk render as `p.1` in the Document Inspector
                            # (verified across 22k agriculture chunks),
                            # producing misleading per-chunk badges. With
                            # `page=0` the UI hides the badge (`page_number > 0`
                            # check) and citation generator falls back to its
                            # own default for display.
                            "page": 0,
                            "type": "content_only",
                        },
                    )
                ]
                logger.info("Content-only processing for doc %s: %d chars from DB — chunking", document_id[:8], len(markdown_content))
                documents = document_processor.apply_chunking_and_return_documents_with_pages(
                    page_documents=page_documents,
                    file_path=file_path or document_id,
                    db=db,
                    user_id=user_id,
                    metadata_file_path=file_path or document_id,
                    job_id=job_id,
                    progress_callback=progress_callback,
                )
                logger.info("Content-only chunking produced %d chunks for doc %s", len(documents), document_id[:8])
            elif file_extension == ".epub":
                documents = document_processor.process_epub(
                    file_path=file_path,
                    job_id=job_id,
                    progress_callback=progress_callback,
                    db=db,
                    user_id=user_id,
                )
            elif file_extension in [".md", ".markdown", ".txt"]:
                documents = DocumentService.process_text_file(
                    file_path=file_path,
                    job_id=job_id,
                    progress_callback=progress_callback,
                    user_id=user_id,
                )
            else:
                from src.main.service.document_processing.multimodal_pipeline import is_multimodal_enabled

                multimodal_collector: list = [] if is_multimodal_enabled() else None  # type: ignore[assignment]
                documents = document_processor.process_pdf(
                    file_path=file_path,
                    ocr_enabled=ocr_enabled,
                    job_id=job_id,
                    progress_callback=progress_callback,
                    db=db,
                    user_id=user_id,
                    multimodal_collector=multimodal_collector,
                )

                if multimodal_collector:
                    from src.main.service.document_processing.multimodal_persister import persist_drafts
                    from src.main.service.document_processing.multimodal_pipeline import describe_pending

                    persist_drafts(db, document_id, multimodal_collector)
                    describe_pending(db, document_id)

                # Shadow parser comparison (gated, best-effort): score every backend
                # on this PDF and record the winner in parser_comparisons. Production
                # output above is unchanged — this only observes so a statistical
                # query can later decide whether to flip the production parser.
                try:
                    from uuid import UUID

                    from src.main.service.document.parser_comparison_service import run_comparison, should_compare

                    _pages: int | None = None
                    try:
                        import fitz

                        _pages = fitz.open(file_path).page_count
                    except Exception:
                        _pages = None
                    if should_compare(file_path, _pages):
                        run_comparison(UUID(document_id), file_path, db)
                except Exception as _cmp_err:
                    logger.warning("Parser comparison failed for doc %s: %s", document_id[:8], _cmp_err)

            # Step 2b: Extract and store document metadata (title, author)
            _extract_and_store_document_metadata(db, document_id, file_path, file_extension, documents)

            if not documents:
                ext = os.path.splitext(file_path)[1].lower() if file_path else ""
                if ext == ".epub":
                    raise ValueError("Failed to extract text from EPUB. The file may be DRM-protected, corrupted, or use an unsupported encoding.")
                raise ValueError(
                    "No text could be extracted from this document. "
                    "It may be a scanned/image-only PDF with text in a non-Latin script (e.g., old German Fraktur, Arabic, Chinese) "
                    "that the OCR engine cannot read, or the file may be corrupted/password-protected."
                )

            # Step 3.5: Auto-enrich metadata from identifiers (DOI, ISBN, PMID, arXiv)
            _try_enrich_metadata(db, asyncio, document_id, documents, job, job_id, user_id, collection_id, _filename)

            # Step 4: Enrich documents with collection/user metadata
            job.progress = 50.0
            job.description = "enrichingMetadata"
            db.commit()
            publish_job_progress(
                job_id,
                document_id,
                user_id,
                collection_id,
                50.0,
                "enrichingMetadata",
                "processing",
                _filename,
            )

            from src.main.utils.documents.utils import enrich_documents_with_metadata_core

            enriched_documents = enrich_documents_with_metadata_core(documents, collection_id, user_id, document_id, job_id=job_id)

            # Step 5: Store embeddings in pgvector
            job.progress = 65.0
            job.description = "storingEmbeddings"
            db.commit()
            publish_job_progress(
                job_id,
                document_id,
                user_id,
                collection_id,
                65.0,
                "storingEmbeddings",
                "processing",
                _filename,
            )

            # Adapter: store_embeddings_sync emits (pct, message), but our
            # canonical progress_callback above expects (job_id, dict).
            def _embed_progress(pct: int, msg: str) -> None:
                progress_callback(job_id, {"progress": pct, "message": msg, "status": "processing"})

            document_service.store_embeddings_sync(  # type: ignore[attr-defined]
                enriched_documents,
                collection_id,
                user_id,
                retriever_manager,
                progress_callback=_embed_progress,
            )

            # Inject pgvector chunk UUIDs into enriched_documents so Neo4j uses the same IDs
            _inject_chunk_ids(db, document_id, enriched_documents)

            # Populate documents.document_hierarchy from the just-written chunk
            # cmetadata. This is a Postgres-only JSONB write — no Neo4j —
            # so it belongs in the document-processing pipeline, NOT in the
            # graph layer. Without this every content-only / skip-graph
            # ingest would land with document_hierarchy=NULL and the
            # downstream summary service would silently bail because it
            # walks the tree to find chapter chunk_range. The standalone
            # rebuild_document_hierarchy Celery task remains as a recovery
            # path for legacy rows; new ingests must not need it.
            try:
                from uuid import UUID as _UUID

                from src.main.utils.documents.hierarchy import (
                    rebuild_hierarchy_from_chunk_metadata,
                    store_document_hierarchy,
                )

                _hier = rebuild_hierarchy_from_chunk_metadata(db, _UUID(document_id))
                if _hier:
                    store_document_hierarchy(db, _UUID(document_id), _hier)
                    logger.info(
                        "Populated document_hierarchy for %s: %d top-level sections",
                        document_id[:8],
                        len(_hier),
                    )
                else:
                    logger.info(
                        "Skipping hierarchy populate for %s: <2 distinct chunks (placeholder/degenerate)",
                        document_id[:8],
                    )
            except Exception as _hier_err:
                logger.warning(
                    "Hierarchy populate failed for %s (non-fatal): %s",
                    document_id[:8],
                    _hier_err,
                )

            # Step 6: Neo4j graph integration is a hosted-only feature and is not
            # available in the Community Edition. Documents still parse/chunk/embed;
            # the knowledge-graph build step is skipped.
            logger.debug("Graph integration skipped (hosted-only) in CE")

            # Step 6b: Generate the thumbnail. Runs HERE — strictly between
            # graph build and the caller's `cleanup_file_after` block — so
            # the source file is guaranteed to exist on disk regardless of
            # `file_stored=False` (memory-only) mode. If we ever move this
            # below the cleanup, file_stored=False docs lose every chance
            # of getting a thumbnail (159 production docs landed in that
            # state before this guarantee).
            #
            # When real cover render fails (corrupted PDF, unusual encryption,
            # unsupported format), we DO NOT fall back to a generic PDF-icon
            # placeholder. has_thumbnail stays false and the frontend renders
            # its styled title-card fallback (`FakeBookCover`) using the doc's
            # title/author/year — far more useful than a generic icon.
            try:
                from sqlalchemy.orm.attributes import flag_modified

                from src.main.models.sqlmodel_models import Document as _Doc
                from src.main.service.document.thumbnail_service import ThumbnailService

                # noinspection PyTypeChecker
                _doc_row = db.query(_Doc).filter(_Doc.id == document_id).first()

                # Store thumbnails at the LOGICAL collection path (documents.file_path),
                # NOT next to `file_path` — which for memory-only (file_stored=False)
                # docs is a throwaway temp file under /app/data/tmp. GetThumbnail
                # derives the thumbnail location from documents.file_path, so a cover
                # rendered next to the temp file is orphaned and never served (the doc
                # shows has_thumbnail=True while the PNG sits stranded in /app/data/tmp).
                # For file_stored=True docs the logical path resolves to the same file,
                # so this is a no-op change for them.
                _logical = getattr(_doc_row, "file_path", None) if _doc_row is not None else None
                _thumb_target = _resolve_file_path(_logical) if _logical else file_path

                _thumb_ok = False
                if ThumbnailService.can_generate_thumbnail(file_path):
                    _ext = os.path.splitext(file_path.lower())[1]
                    for _size in ThumbnailService.THUMBNAIL_SIZES:
                        _out = ThumbnailService.get_thumbnail_path(_thumb_target, _size)
                        if _ext == ".epub":
                            _r = ThumbnailService.generate_epub_thumbnail(file_path, output_path=_out, size=_size)
                        else:
                            _r = ThumbnailService.generate_pdf_thumbnail(file_path, output_path=_out, size=_size)
                        _thumb_ok = _thumb_ok or (_r is not None)

                if _thumb_ok:
                    tm = ThumbnailService.get_thumbnail_metadata(_thumb_target)
                    if _doc_row is not None:
                        existing = _doc_row.file_metadata if isinstance(_doc_row.file_metadata, dict) else {}
                        existing["thumbnail"] = {
                            "has_thumbnail": True,
                            "has_custom": False,
                            "sizes": tm.get("available_sizes", []) or [ThumbnailService.DEFAULT_SIZE],
                        }
                        _doc_row.file_metadata = existing
                        flag_modified(_doc_row, "file_metadata")
                        db.commit()
                        logger.info("Pre-generated thumbnail for document %s", document_id)
            except Exception as _thumb_err:
                logger.warning("Thumbnail pre-generation failed for %s: %s", document_id, _thumb_err)

            # Step 6c: Populate documents.content with the canonical markdown.
            # Invariant: every successfully-processed doc has documents.content
            # populated regardless of file_stored. The Document QA agent, the
            # content-only retriever, and Cat-I (Annas restore) all depend on
            # this. Before this step the reprocess flow could leave
            # documents.content NULL forever (initial upload sets it via
            # extract_document_content; reprocess never wrote it).
            try:
                from src.main.models.sqlmodel_models import Document as _Doc
                from src.main.utils.documents.utils import extract_document_content

                if content_only:
                    new_markdown = markdown_content
                elif file_path and os.path.exists(file_path):
                    new_markdown, _ = extract_document_content(file_path, page_chunks=False)
                else:
                    new_markdown = None

                if new_markdown:
                    # noinspection PyTypeChecker
                    _doc_for_content = db.query(_Doc).filter(_Doc.id == document_id).first()
                    if _doc_for_content is not None:
                        _doc_for_content.content = new_markdown
                        db.commit()
                        logger.info(
                            "Populated documents.content for %s: %d chars (post-reprocess invariant)",
                            document_id[:8],
                            len(new_markdown),
                        )
            except Exception as _content_err:
                logger.warning("Post-reprocess content populate failed for %s (non-fatal): %s", document_id[:8], _content_err)

            # Step 7: Mark job + document as completed
            job.status = JobStatus.COMPLETED.value
            job.progress = 100.0
            job.description = "documentProcessingCompleted"
            job.completed_at = datetime.now(UTC).isoformat()
            from sqlalchemy import text as sa_text

            db.execute(
                sa_text("UPDATE documents SET processing_status = 'completed', processing_error = NULL, process_retry_count = 0 WHERE id = :doc_id"),
                {"doc_id": document_id},
            )
            db.commit()
            publish_job_progress(
                job_id,
                document_id,
                user_id,
                collection_id,
                100.0,
                "documentProcessingCompleted",
                "completed",
                _filename,
            )

            logger.info("Successfully completed processing job %s for document %s", job_id, document_id)
            return {
                "success": True,
                "job_id": job_id,
                "document_id": document_id,
                "message": "documentProcessingCompleted",
                "chunks_processed": len(enriched_documents) if enriched_documents else 0,
            }

        except Exception as e:
            logger.exception("Error processing document %s: %s", document_id, e)

            if job:
                from sqlalchemy import text as sa_text

                try:
                    # Roll back any dirty session state before attempting failure update
                    db.rollback()
                    from src.main.utils.core.error_codes import to_status_code as _to_code

                    error_msg = _to_code(e)
                    job.status = JobStatus.FAILED.value
                    job.description = error_msg
                    job.error_message = traceback.format_exc()
                    job.completed_at = datetime.now(UTC).isoformat()
                    from src.main.utils.core.error_codes import to_status_code

                    db.execute(
                        sa_text("UPDATE documents SET processing_status = 'failed', processing_error = :err WHERE id = :doc_id"),
                        # Status code per CLAUDE.md rule #3.
                        {"doc_id": document_id, "err": to_status_code(e)},
                    )
                    db.commit()
                    publish_job_progress(
                        job_id,
                        document_id,
                        user_id,
                        collection_id,
                        job.progress or 0,
                        error_msg,
                        "failed",
                    )
                except Exception as db_error:
                    logger.error("Error updating job status to failed: %s", db_error)
                    # Last resort: try raw SQL in a fresh connection to mark job failed
                    # noinspection PyBroadException
                    try:
                        from src.main.config.database import SessionLocal

                        fresh_db = SessionLocal()
                        fresh_db.execute(
                            sa_text("UPDATE jobs SET status = 'failed', description = :msg, completed_at = NOW() WHERE job_id = :jid"),
                            {"jid": job_id, "msg": error_msg[:500]},
                        )
                        fresh_db.commit()
                        fresh_db.close()
                    except Exception:
                        logger.error("Last-resort job failure update also failed for job %s", job_id)

            return {"success": False, "job_id": job_id, "document_id": document_id, "error": error_msg}


def _extract_and_store_document_metadata(db, document_id: str, file_path: str, file_extension: str, documents: list) -> None:
    """Extract title and author from EPUB/PDF metadata and store in the document table."""
    import json

    from sqlalchemy import text

    title: str | None = None
    author = None
    extracted_meta = {}

    try:
        if file_extension == ".epub":
            try:
                from ebooklib import epub

                book = epub.read_epub(file_path)
                title_meta = book.get_metadata("DC", "title")
                if title_meta:
                    title = title_meta[0][0]
                creator_meta = book.get_metadata("DC", "creator")
                if creator_meta:
                    author = "; ".join(c[0] for c in creator_meta)
                desc_meta = book.get_metadata("DC", "description")
                if desc_meta:
                    extracted_meta["description"] = desc_meta[0][0][:500]
                lang_meta = book.get_metadata("DC", "language")
                if lang_meta:
                    extracted_meta["language"] = lang_meta[0][0]
            except Exception as epub_err:
                logger.debug("EPUB metadata extraction failed: %s", epub_err)

        elif file_extension == ".pdf":
            try:
                import fitz

                doc = fitz.open(file_path)
                pdf_meta = doc.metadata
                if pdf_meta:
                    title = pdf_meta.get("title") or None
                    author = pdf_meta.get("author") or None
                    if pdf_meta.get("subject"):
                        extracted_meta["subject"] = pdf_meta["subject"]
                doc.close()
            except Exception as pdf_err:
                logger.debug("PDF metadata extraction failed: %s", pdf_err)

        # Also try to extract book_title from first chunk metadata (PyMuPDF/Docling sets this)
        if not title and documents:
            first_meta = getattr(documents[0], "metadata", {})
            _raw = first_meta.get("book_title") or first_meta.get("title")
            title = str(_raw) if _raw else None

        # Skip empty / garbage titles. The "untitled" / "untitled-N" /
        # "untitled (N)" family are Adobe Acrobat / Word default placeholders
        # the original author never overwrote; they appear verbatim in the
        # PDF Title metadata and surface in the UI as garbage.
        if title:
            tl = title.strip().lower()
            if len(title.strip()) < 3 or tl == "unknown" or tl == "untitled" or re.match(r"^untitled[\s\-_]*\(?\d+\)?$", tl):
                title = None

        # Reject tmpfile-leaked titles. Memory-only uploads write files to
        # /app/data/tmp/ as ``scrapalot_{doc_uuid}_{random}_{originalname}``
        # and PyMuPDF falls back to the basename-without-extension when a PDF
        # lacks proper Title metadata — which surfaced in the UI as
        # ``scrapalot_a627c993-..._rndqzpxi_1977...``. Let the frontend fall
        # through to doc.filename instead.
        if title and title.startswith("scrapalot_"):
            title = None

        # Detect chunker-fallback titles that are just the filename basename.
        # `document_processor.apply_chunking_and_return_documents_with_pages`
        # (document_processor.py:~232) seeds chunk metadata with
        #   title = os.path.splitext(os.path.basename(file_path))[0]
        # so when no real PDF / EPUB Title metadata exists (the common case
        # for content-only / markdown_imported docs whose source PDF isn't
        # on disk), the chunk-metadata fallback above returns this raw slug.
        # The slug then bypasses the `if not title` fallback and lands in
        # documents.title verbatim. Detect verbatim equality with the
        # filename basename and discard so `parse_title_from_filename` runs.
        if title:
            try:
                from sqlalchemy import text as sa_text

                fn_row = db.execute(
                    sa_text("SELECT filename FROM documents WHERE id = :id"),
                    {"id": document_id},
                ).fetchone()
                if fn_row and fn_row[0]:
                    fn_basename = os.path.splitext(os.path.basename(fn_row[0]))[0]
                    if title.strip().lower() == fn_basename.strip().lower():
                        logger.info(
                            "Title regression detected for doc %s: chunk-metadata title equals filename basename '%s' — discarding to trigger parse_title_from_filename fallback",
                            str(document_id)[:8],
                            fn_basename[:60],
                        )
                        title = None
            except Exception as slug_check_err:
                logger.debug("Slug-vs-filename check failed (non-fatal): %s", slug_check_err)

        # Last-resort fallback: when PDF / chunk metadata produced no usable
        # title, derive one from the filename. The filename parser already
        # strips year prefixes, archival markers, Anna's Archive bloat, and
        # multi-author bylines, so even worst-case sources still get a
        # human-readable display title instead of NULL.
        if not title:
            try:
                from sqlalchemy import text as sa_text

                from src.main.utils.documents.utils import parse_title_from_filename

                doc_filename_row = db.execute(
                    sa_text("SELECT filename FROM documents WHERE id = :id"),
                    {"id": document_id},
                ).fetchone()
                if doc_filename_row and doc_filename_row[0]:
                    parsed = parse_title_from_filename(doc_filename_row[0])
                    if parsed:
                        title = parsed
                        logger.info(
                            "Title fallback: derived '%s' from filename for doc %s",
                            title,
                            str(document_id)[:8],
                        )

                    # OpenLibrary bibliographic enrichment is a hosted-only
                    # feature and is not available in the Community Edition.
                    # The heuristic filename-derived title is kept as-is.
                    logger.debug("OpenLibrary enrichment skipped (hosted-only) in CE")
            except Exception as fallback_err:
                logger.warning("parse_title_from_filename fallback failed: %s", fallback_err)

        # Update documents table
        if title or author or extracted_meta:
            update_parts = []
            params = {"doc_id": document_id}
            if title:
                update_parts.append("title = :title")
                params["title"] = title
            if author:
                extracted_meta["author"] = author
            if extracted_meta:
                update_parts.append("extracted_metadata = :meta")
                params["meta"] = json.dumps(extracted_meta)

            if update_parts:
                db.execute(text(f"UPDATE documents SET {', '.join(update_parts)} WHERE id = :doc_id"), params)
                db.commit()
                logger.info("Stored metadata for %s: title=%s, author=%s", document_id[:8], title, author)

    except Exception as e:
        logger.warning("Metadata extraction failed for %s: %s", document_id[:8], e)


def _fetch_document_filename(db, document_id: str) -> str | None:
    """Fetch the filename of a document for progress notifications."""
    from sqlalchemy import text

    try:
        row = db.execute(
            text("SELECT filename FROM documents WHERE id = :doc_id"),
            {"doc_id": document_id},
        ).fetchone()
        return row[0] if row else None
    except Exception as e:
        logger.debug("Suppressed exception fetching filename: %s", e)
        return None


def _inject_chunk_ids(db, document_id: str, enriched_documents: list) -> None:
    """
    Inject pgvector embedding UUIDs into enriched document metadata.

    Ensures Neo4j hierarchy and entity extraction use the same chunk IDs
    as the pgvector embeddings.
    """
    from sqlalchemy import text

    try:
        rows = db.execute(
            text("""
                SELECT id, (cmetadata->>'chunk_index')::int AS ci
                FROM langchain_pg_embedding
                WHERE cmetadata->>'document_id' = :doc_id
                ORDER BY ci NULLS LAST
            """),
            {"doc_id": document_id},
        ).fetchall()

        if rows and len(rows) == len(enriched_documents):
            for row, doc in zip(rows, enriched_documents, strict=False):
                if hasattr(doc, "metadata"):
                    doc.metadata["chunk_id"] = str(row[0])
            logger.info("Injected %d embedding UUIDs into enriched_documents metadata", len(rows))
        elif rows:
            logger.warning(
                "Embedding count (%d) != enriched_documents count (%d), skipping chunk_id injection",
                len(rows),
                len(enriched_documents),
            )
    except Exception as e:
        logger.warning("Failed to inject embedding UUIDs: %s", str(e))


def _try_enrich_metadata(db, asyncio, document_id, documents, job, job_id, user_id, collection_id, filename) -> None:
    """
    Attempt to auto-enrich document metadata from academic identifiers.

    Scans the first few pages for DOI, ISBN, PMID, or arXiv IDs and resolves
    them via external APIs. Failures are silently swallowed — enrichment is
    best-effort and must never block the main pipeline.
    """
    try:
        from src.main.service.metadata.identifier_extractor import extract_identifiers
        from src.main.service.metadata.metadata_resolver import resolve_from_identifiers

        scan_text = "\n".join(doc.page_content for doc in documents[:5])
        identifiers = extract_identifiers(scan_text, max_pages=2)

        if not identifiers.has_any:
            return

        job.progress = 45.0
        job.description = "Resolving academic metadata"
        db.commit()
        publish_job_progress(
            job_id,
            document_id,
            user_id,
            collection_id,
            45.0,
            "Resolving academic metadata",
            "processing",
            filename,
        )

        resolved = asyncio.run(
            resolve_from_identifiers(
                dois=identifiers.dois,
                isbns=identifiers.isbns,
                pmids=identifiers.pmids,
                arxiv_ids=identifiers.arxiv_ids,
            )
        )

        if not resolved:
            return

        import json as _json

        from sqlalchemy import text

        existing = db.execute(
            text("SELECT extracted_metadata FROM documents WHERE id = :doc_id"),
            {"doc_id": document_id},
        ).fetchone()

        current_meta = {}
        if existing and existing[0]:
            current_meta = existing[0] if isinstance(existing[0], dict) else _json.loads(existing[0])

        current_meta["identifiers"] = {
            "doi": identifiers.primary_doi,
            "isbn": identifiers.primary_isbn,
            "pmid": identifiers.pmids[0] if identifiers.pmids else None,
            "arxiv_id": identifiers.arxiv_ids[0] if identifiers.arxiv_ids else None,
        }
        current_meta["resolved"] = resolved.to_dict()
        current_meta["enrichment_status"] = "resolved"

        db.execute(
            text(
                "UPDATE documents"
                " SET extracted_metadata = :meta,"
                "     title = CASE WHEN LENGTH(:title) > LENGTH(COALESCE(title, '')) THEN :title ELSE title END"
                " WHERE id = :doc_id"
            ),
            {"meta": _json.dumps(current_meta), "title": resolved.title or "", "doc_id": document_id},
        )
        db.commit()
        logger.info("Auto-enriched metadata for document %s: %s (%s)", document_id, resolved.title, resolved.source)

    except Exception as e:
        logger.debug("Metadata auto-enrichment skipped for %s: %s", document_id, str(e))
