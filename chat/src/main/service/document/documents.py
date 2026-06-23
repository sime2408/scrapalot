"""
Document Service - Core CRUD operations for document management.

This service provides core document management capabilities including:
- Document CRUD operations
- Collection permissions management
- Document search and listing
- Integration with a document processing pipeline
"""

# noinspection PyUnresolvedReferences
import asyncio
from collections.abc import AsyncGenerator
from datetime import UTC
import hashlib
import json
import os
import time
from typing import Any

from fastapi import HTTPException
from sqlalchemy import and_, text
from sqlalchemy.orm import Session

from src.main.config.database import DB_TYPE
from src.main.service.document.document_job_manager import document_job_manager
from src.main.service.document.document_processor import document_processor
from src.main.service.retriever.retriever_manager import retriever_manager
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.decorators import async_service
from src.main.utils.core.logger import get_logger, timing_decorator
from src.main.utils.documents.utils import create_document_metadata, extract_document_content
from src.main.utils.files.paths import normalize_path_for_db
from src.main.utils.jobs.lifecycle import JobStatus
from src.main.utils.jobs.progress import create_streaming_progress_callback

logger = get_logger(__name__)

# Import JobStatus with fallback handling

try:
    from src.main.models.sqlmodel_models import Document
except ImportError as e:
    logger.error("Failed to import Document model: %s", str(e))

    class Document:
        def __init__(self, *args, **kwargs):
            pass


class DocumentProcessingError(Exception):
    """Error during document processing"""


_MIN_BODY_CHARS = 3000


def _is_metadata_stub_chunks(parse_result: list[Any] | None) -> bool:
    """True when the chunked output is so small it cannot represent a real
    book body — i.e. it's almost certainly the front-matter table the
    extractor returned when the body never decoded.

    A doc that produced ≤1 chunk AND <3000 total chars is overwhelmingly a
    metadata stub (markdown table of title/author/ISBN/publisher) and must
    not be marked `completed`. This guard prevents the production-observed
    bug where ~200 EPUB rows ended up `completed` with 700 chars of
    metadata-only content and a single chunk, blocking later
    `document_hierarchy` rebuilds (which require ≥2 distinct chunks) and
    poisoning downstream search.

    Path-aware bypass: `doi_import_service._format_markdown` produces
    intentional 500-3000 char title+author+abstract markdown stubs as
    the indexable knowledge unit for journal-paper imports (the abstract
    IS the body — there's no real book chapter to extract). Without the
    bypass, every DOI-import doc gets rejected as `errorEmptyDocument`,
    losing the entire feature class. Detector matches the shape produced
    by `_format_markdown`: `# <title>` prefix, `**DOI:**` in the meta
    header (within the first 500 chars), `## Abstract` heading somewhere.
    """
    if not parse_result:
        return True
    total_chars = sum(len(getattr(d, "page_content", "") or "") for d in parse_result)
    if not (len(parse_result) <= 1 and total_chars < _MIN_BODY_CHARS):
        return False
    joined = "\n".join(getattr(d, "page_content", "") or "" for d in parse_result)
    return not (joined.startswith("# ") and "**DOI:**" in joined[:500] and "## Abstract" in joined)


# noinspection SqlResolve


@async_service
class DocumentService:
    """
    Service for handling document operations including CRUD, processing, and integration
    with the knowledge graph system as specified in the relational-graph boundary.
    """

    @timing_decorator("DocumentService Initialization")
    def __init__(self, db: Session = None):
        """
        Initialize the DocumentService with a database session.

        Args:
            db: Database session
        """
        logger.debug("DocumentService.__init__ called")
        self._db = db  # Use _db to match async_service decorator expectations
        # Lazy initialization for retriever
        self._retriever = None
        # Lazy initialization for graph integration service to avoid blocking startup
        self._graph_integration_service = None
        # Processing state flags (set per-request in process_document_async)
        self._skip_llm_steps: bool = False
        self._new_content_hash: str | None = None
        logger.debug("DocumentService initialization completed - all heavy operations deferred")

    @property
    def db(self):
        """Property to access the database session for backward compatibility."""
        return self._db

    @property
    def graph_integration_service(self):
        """Lazy initialization of the graph integration service.

        Community Edition: the knowledge-graph integration service is not
        bundled, so this always returns None and callers degrade gracefully.
        """
        return None

    def check_collection_permissions(self, collection_id: str, user_id: str, db=None) -> bool:
        """
        Check if a user has permissions to access a collection.

        Args:
            collection_id: Collection ID
            user_id: User ID
            db: Database session (optional, defaults to self.db)

        Returns:
            bool: True if the user has permissions, False otherwise
        """
        try:
            # Use the provided db session or fell back to self.db
            db_session = db if db is not None else self._db

            if db_session is None:
                logger.error("No database session available for collection permission check")
                return False

            # Check user permissions via collection_workspace_map cache
            query = text(
                """
                SELECT 1 FROM collection_workspace_map
                WHERE collection_id::text = :collection_id
                AND owner_user_id::text = :user_id
            """
            )

            # Convert UUIDs to strings for SQL comparison
            result = db_session.execute(query, {"collection_id": str(collection_id), "user_id": str(user_id)}).fetchone()

            return result is not None

        except Exception as ex:
            logger.error("Error checking collection permissions: %s", str(ex))
            return False

    def cleanup_low_quality_embeddings(self, collection_id: str, user_id: str) -> dict:
        """
        Clean up low - quality embeddings like dividers and empty chunks from the specified collection.

        Args:
            collection_id: The ID of the collection to clean up
            user_id: The ID of the user requesting the cleanup

        Returns:
            dict: A dictionary with cleanup results

        Raises:
            HTTPException: If an error occurs during cleanup
        """
        try:
            # First, check if the user has permission to access this collection
            self.check_collection_permissions(collection_id, user_id, self._db)

            # Execute the cleanup query to find problematic embeddings
            query = text(
                """
                SELECT d.id, d.filename as filename, d.file_metadata
                FROM documents d
                WHERE d.collection_id = :collection_id AND (
                    d.filename LIKE '%----%' OR
                    LENGTH(TRIM(d.filename)) < 50 OR
                    d.filename LIKE '%Table of Contents%' OR
                    d.filename LIKE '%page intentionally left blank%'
                )
            """
            )

            # noinspection PyUnresolvedReferences
            results = self._db.execute(query, {"collection_id": collection_id}).fetchall()

            if not results:
                return {
                    "status": "success",
                    "message": "noLowQualityEmbeddings",
                    "count": 0,
                }

            # Delete the problematic documents from the vector store
            document_ids = [str(row[0]) for row in results]
            logger.info("Found %s low - quality embeddings to clean up", len(document_ids))

            # Delete from database
            delete_query = text(
                """
                DELETE FROM documents
                WHERE id IN :document_ids AND collection_id = :collection_id
            """
            )

            # noinspection PyUnresolvedReferences
            self._db.execute(
                delete_query,
                {"document_ids": tuple(document_ids), "collection_id": collection_id},
            )
            # noinspection PyUnresolvedReferences
            self._db.commit()

            return {
                "status": "success",
                "message": f"Successfully cleaned up {len(document_ids)} low - quality embeddings",
                "count": len(document_ids),
            }

        except Exception as ex:
            if isinstance(ex, HTTPException):
                raise ex from ex
            logger.error("Error cleaning up embeddings: %s", str(ex))
            # noinspection PyUnresolvedReferences
            self._db.rollback()
            raise HTTPException(status_code=500, detail=f"Error cleaning up embeddings: {ex!s}") from ex

    def get_job_status(self, job_id: str) -> dict:
        """
        Get the current status of a document processing job.

        Args:
            job_id: The ID of the job to check

        Returns:
            dict: A dictionary with the job status information

        Raises:
            HTTPException: If the job is not found
        """
        try:
            job_status = document_job_manager.get_job_status(job_id, self._db)
            if job_status is None:
                logger.warning("Job %s not found in memory or database", job_id)
                raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
            return job_status
        except Exception as ex:
            if isinstance(ex, HTTPException):
                raise ex from ex
            logger.error("Error getting job status: %s", str(ex))
            raise HTTPException(status_code=500, detail=f"Error getting job status: {ex!s}") from ex

    async def cancel_processing(self, job_id: str) -> dict[str, Any]:
        """
        Cancel document processing and clean up resources.

        Args:
            job_id: The job ID to cancel

        Returns:
            Dict with status information
        """
        try:
            return await document_job_manager.cancel_processing(job_id, self._db)
        except ValueError as ve:
            raise HTTPException(status_code=404, detail=str(ve)) from ve
        except Exception as ex:
            logger.error("Error cancelling job: %s", str(ex))
            raise HTTPException(status_code=500, detail=f"Error cancelling job: {ex!s}") from ex

    def list_active_jobs(self, user_id: str) -> list[dict[str, Any]]:
        """
        List active document processing jobs for a user.

        Args:
            user_id: User ID to filter jobs by

        Returns:
            List of active jobs with their details
        """
        try:
            return document_job_manager.list_active_jobs(user_id, self._db)
        except Exception as ex:
            logger.error("Error listing active jobs: %s", str(ex))
            return []

    def list_documents_by_collection(
        self, collection_id: str, user_id: str, page: int = 1, page_size: int = 20, search: str = None
    ) -> dict[str, Any]:
        """
        List documents by collection with pagination and optional search filtering.

        Args:
            collection_id: Collection ID to filter documents by
            user_id: User ID for permission filtering
            page: Page number (1-indexed)
            page_size: Number of documents per page
            search: Optional search query to filter documents by filename

        Returns:
            Dict containing document list, pagination info, and total count
        """
        try:
            # First check if the user has permission to access this collection
            if not self.check_collection_permissions(collection_id, user_id, self._db):
                logger.warning("User %s attempted to access collection %s without permission", user_id, collection_id)
                return {
                    "documents": [],
                    "total": 0,
                    "page": page,
                    "page_size": page_size,
                    "hasMore": False,
                }

            # Query for documents with pagination, including processing status from jobs' table
            # Use database-specific syntax for type casting
            if DB_TYPE == "postgresql":
                join_condition = "d.id::text = j.document_id::text"
            else:  # SQLite and other databases
                join_condition = "CAST(d.id AS TEXT) = CAST(j.document_id AS TEXT)"

            # Build WHERE clause with optional search filter
            where_clause = "WHERE cwm.collection_id = :collection_id AND cwm.owner_user_id = :user_id"
            if search and search.strip():
                # Use ILIKE for PostgreSQL (case-insensitive), LIKE for SQLite
                if DB_TYPE == "postgresql":
                    where_clause += " AND d.filename ILIKE :search"
                else:
                    where_clause += " AND d.filename LIKE :search"

            query = text(
                f"""
               SELECT d.*,
                      j.status as job_status,
                      j.progress as job_progress,
                      j.description as job_message,
                      j.error_message as job_errors,
                      j.id as job_id
               FROM documents d
               JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id
               LEFT JOIN jobs j ON {join_condition}
               {where_clause}
               ORDER BY d.created_at DESC LIMIT :limit OFFSET :offset
           """
            )

            params = {
                "collection_id": collection_id,
                "user_id": user_id,
                "limit": page_size,
                "offset": (page - 1) * page_size,
            }

            # Add search param if provided
            if search and search.strip():
                params["search"] = f"%{search.strip()}%"

            # noinspection PyUnresolvedReferences
            documents = self._db.execute(query, params).fetchall()

            # Get total count for pagination with search filter
            count_query = text(
                f"""
                SELECT COUNT(*) FROM documents d
                JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id
                {where_clause}
            """
            )

            count_params = {"collection_id": collection_id, "user_id": user_id}
            if search and search.strip():
                count_params["search"] = f"%{search.strip()}%"

            # noinspection PyTypeChecker,PyUnresolvedReferences
            total_count: int = int(self._db.execute(count_query, count_params).scalar() or 0)

            # Format the response with processing status information
            return {
                "documents": [
                    {
                        "id": str(doc.id),
                        "filename": getattr(doc, "filename", None) or "Unknown Document",
                        "file_metadata": (
                            json.loads(doc.file_metadata)
                            if isinstance(getattr(doc, "file_metadata", None), str)
                            else (getattr(doc, "file_metadata", None) if getattr(doc, "file_metadata", None) is not None else {})
                        ),
                        "collection_id": str(doc.collection_id),
                        "created_at": getattr(doc, "created_at", None),
                        "updated_at": getattr(doc, "updated_at", None),
                        "file_path": getattr(doc, "file_path", None),
                        "processing_status": getattr(doc, "processing_status", "pending"),
                        "job_status": getattr(doc, "job_status", None),
                        "job_progress": getattr(doc, "job_progress", 0),
                        "job_message": getattr(doc, "job_message", None),
                        "job_errors": getattr(doc, "job_errors", None),
                        "job_id": str(doc.job_id) if getattr(doc, "job_id", None) is not None else None,
                    }
                    for doc in documents
                ],
                "total": total_count,
                "page": page,
                "page_size": page_size,
                "hasMore": (page * page_size) < total_count,
            }

        except Exception as ex:
            logger.error("Error listing documents by collection: %s", str(ex))
            return {
                "documents": [],
                "total": 0,
                "page": page,
                "page_size": page_size,
                "hasMore": False,
            }

    def create_document(
        self,
        document_id: str,
        title: str,
        filename: str,
        file_path: str,
        collection_id: str,
        original_filename: str,
        content_type: str,
        file_size: int,
        user_id: str | None = None,
        content_store_id: str | None = None,
        processing_status: str | None = None,
        file_stored: bool = True,
    ):
        """
        Create a new document record in the database and initialize job tracking.

        Args:
            document_id: Unique ID for the document
            title: Display title for the document
            filename: Filesystem-safe filename
            file_path: Path to the saved file
            collection_id: Collection ID the document belongs to
            original_filename: Original filename before sanitization
            content_type: MIME type of the file
            file_size: Size of the file in bytes
            user_id: The ID of the user uploading the document (for job notifications)
            content_store_id: Optional content store ID for deduplication
            processing_status: Optional initial processing status (defaults to 'pending')
            file_stored: Whether the file was physically stored on disk (default True)

        Returns:
            dict: Result with success status, job_id, and message
        """
        try:
            # Check if a collection exists in the cache table
            # noinspection PyUnresolvedReferences
            collection_exists = self._db.execute(
                text("SELECT 1 FROM collection_workspace_map WHERE collection_id = :cid"),
                {"cid": str(collection_id)},
            ).fetchone()
            if not collection_exists:
                return {
                    "success": False,
                    "message": f"Collection with ID {collection_id} not found",
                }

            normalized_file_path = normalize_path_for_db(file_path)
            if normalized_file_path != file_path:
                logger.warning(
                    "create_document received non-normalized file_path; storing normalized form. raw=%s normalized=%s",
                    file_path,
                    normalized_file_path,
                )

            # Create a document record
            document = Document(
                id=document_id,
                filename=filename,
                title=title,
                file_path=normalized_file_path,
                collection_id=collection_id,
                file_type=content_type,
                file_size=file_size,
                # Pass the dict directly: the SQLAlchemy JSON column serialises
                # it once. Wrapping in json.dumps() here double-encoded the value
                # (a JSON string stored inside a JSON string).
                file_metadata=create_document_metadata(original_filename, content_type, file_size),
                content_store_id=content_store_id,
                file_stored=file_stored,
            )
            if processing_status:
                document.processing_status = processing_status

            # noinspection PyUnresolvedReferences
            self._db.add(document)
            # noinspection PyUnresolvedReferences
            self._db.commit()

            # Extract and populate content field for pending documents in a background thread
            # This enables Document QA agent to answer questions before full processing
            # CRITICAL: Must NOT block gRPC thread — pymupdf extraction on large PDFs takes 5-30s
            # and blocks all other gRPC calls (GetJobStatus, GetActiveJobs) → DEADLINE_EXCEEDED
            import threading

            def _bg_extract_content(doc_id, fp):
                try:
                    full_path = os.path.join(os.getcwd(), fp)
                    if not os.path.exists(full_path):
                        return
                    content, pg_count = extract_document_content(full_path)
                    if content:
                        from src.main.config.database import SessionLocal

                        bg_db = SessionLocal()
                        try:
                            from sqlalchemy import text as sql_text

                            bg_db.execute(
                                sql_text("UPDATE documents SET content = :content, page_count = :pc WHERE id = :id"),
                                {"content": content, "pc": pg_count, "id": doc_id},
                            )
                            bg_db.commit()
                            logger.info("Background content extraction for %s: %d chars", doc_id, len(content))
                        finally:
                            bg_db.close()
                except Exception as extract_ex:
                    logger.warning("Background content extraction failed for %s: %s", doc_id, str(extract_ex))

            threading.Thread(target=_bg_extract_content, args=(document_id, normalized_file_path), daemon=True).start()

            # Initialize job tracking with user_id for WebSocket notifications
            job_id = document_job_manager.initialize_job_tracking(document_id, collection_id, user_id=user_id)

            return {
                "success": True,
                "job_id": job_id,
                "message": "documentCreated",
            }

        except Exception as ex:
            logger.error("Error creating document: %s", str(ex))
            # noinspection PyUnresolvedReferences
            self._db.rollback()
            return {
                "success": False,
                "message": f"Failed to create document: {ex!s}",
            }

    async def create_document_record(
        self,
        file_path: str,
        collection_id: str,
        _user_id: str,
        original_filename: str,
    ) -> Document:
        """
        Create a document record from a file path (simplified interface for external books).

        Args:
            file_path: Relative path to the saved file (e.g., data/upload/user_id/collection_id/file.pdf)
            collection_id: Collection ID the document belongs to
            _user_id: User ID who uploaded the document
            original_filename: Original filename

        Returns:
            Document: The created document object

        Raises:
            HTTPException: If collection not found or creation fails
        """
        from datetime import datetime
        import os
        import uuid

        try:
            # Check if collection exists in the cache table
            # noinspection PyUnresolvedReferences
            collection_exists = self._db.execute(
                text("SELECT 1 FROM collection_workspace_map WHERE collection_id = :cid"),
                {"cid": str(collection_id)},
            ).fetchone()
            if not collection_exists:
                raise HTTPException(status_code=404, detail=f"Collection {collection_id} not found")

            normalized_file_path = normalize_path_for_db(file_path)
            if normalized_file_path != file_path:
                logger.warning(
                    "create_document_record received non-normalized file_path; storing normalized form. raw=%s normalized=%s",
                    file_path,
                    normalized_file_path,
                )

            # Get file info from the path
            # Construct full path for file stat operations
            full_path = os.path.join(os.getcwd(), normalized_file_path)
            file_size = os.path.getsize(full_path) if os.path.exists(full_path) else 0

            # Determine content type from extension
            file_ext = os.path.splitext(original_filename)[1].lower()
            content_type_map = {
                ".pdf": "application/pdf",
                ".epub": "application/epub+zip",
                ".txt": "text/plain",
                ".md": "text/markdown",
                ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                ".csv": "text/csv",
                ".tsv": "text/tab-separated-values",
                ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                ".xls": "application/vnd.ms-excel",
                ".rtf": "application/rtf",
            }
            content_type = content_type_map.get(file_ext, "application/octet-stream")

            # Create document ID and title
            document_id = str(uuid.uuid4())
            title = os.path.splitext(original_filename)[0]

            # Create document record
            document = Document(
                id=document_id,
                filename=original_filename,
                title=title,
                file_path=normalized_file_path,
                collection_id=collection_id,
                file_size=file_size,
                file_type=content_type,
                processing_status="pending",
                # Pass the dict directly: the SQLAlchemy JSON column serialises
                # it once. Wrapping in json.dumps() here double-encoded the value
                # (a JSON string stored inside a JSON string).
                file_metadata=create_document_metadata(original_filename, content_type, file_size),
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            )

            # noinspection PyUnresolvedReferences
            self._db.add(document)
            # noinspection PyUnresolvedReferences
            self._db.commit()
            # noinspection PyUnresolvedReferences
            self._db.refresh(document)

            # Extract and populate content field for pending documents
            # This enables Document QA agent to answer questions before full processing
            try:
                if os.path.exists(full_path):
                    content, page_count = extract_document_content(full_path)
                    if content:
                        document.content = content
                        if page_count:
                            document.page_count = page_count
                        # noinspection PyUnresolvedReferences
                        self._db.commit()
                        # noinspection PyUnresolvedReferences
                        self._db.refresh(document)
                        logger.info(
                            "Extracted content for document %s: %d chars, %s pages",
                            document_id,
                            len(content),
                            page_count or "unknown",
                        )
            except Exception as extract_error:
                # Content extraction failure is non-fatal - document processing will still work
                logger.warning("Failed to extract content for document %s during upload: %s", document_id, str(extract_error))

            logger.info("Created document record: %s for file: %s", document_id, original_filename)
            return document

        except HTTPException:
            raise
        except Exception as ex:
            logger.exception("Error creating document record: %s", str(ex))
            # noinspection PyUnresolvedReferences
            self._db.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to create document: {ex!s}") from ex

    def get_collection_upload_path(self, collection_id: str, db=None):
        """
        Get the upload path for a collection.

        Args:
            collection_id: Collection ID
            db: Database session (injected by @service decorator)

        Returns:
            dict: Result with success status, upload_path, and message
        """
        try:
            # Use injected db parameter or fallback to self.db
            database = db if db is not None else self._db

            # Check if a collection exists and get workspace info from the cache table
            # noinspection PyUnresolvedReferences
            result = database.execute(
                text("SELECT collection_id, workspace_id, owner_user_id FROM collection_workspace_map WHERE collection_id = :collection_id"),
                {"collection_id": collection_id},
            ).fetchone()

            if not result:
                return {
                    "success": False,
                    "message": f"Collection with ID {collection_id} not found",
                }

            # Create an upload path with workspace structure
            from src.main.utils.documents.utils import get_upload_path

            # noinspection PyUnresolvedReferences
            upload_dir = get_upload_path(str(result.owner_user_id), collection_id, str(result.workspace_id))

            return {
                "success": True,
                "upload_path": upload_dir,
                "message": "uploadPathCreated",
            }

        except Exception as ex:
            logger.error("Error creating upload path: %s", str(ex))
            return {
                "success": False,
                "message": f"Failed to create upload path: {ex!s}",
            }

    def check_document_exists(self, collection_id: str, filename: str):
        """
        Check if a document with the same filename exists in the collection.

        Args:
            collection_id: Collection ID
            filename: Filename to check

        Returns:
            Document object if exists, None otherwise
        """
        try:
            # Use self.db since this method is called from controllers where DocumentService is instantiated with db
            # noinspection PyTypeChecker,PyUnresolvedReferences
            existing_doc = (
                # noinspection PyTypeChecker,PyUnresolvedReferences
                self._db.query(Document)
                # noinspection PyTypeChecker,PyUnresolvedReferences
                .filter(
                    and_(
                        Document.collection_id == collection_id,
                        Document.filename == filename,
                    )
                )
                .first()
            )

            return existing_doc

        except Exception as ex:
            logger.error("Error checking document existence: %s", str(ex))
            return None

    @staticmethod
    def check_user_job_limit(user_id: str, max_jobs: int = 3, _db=None):
        """
        Check if the user has reached the maximum concurrent jobs limit.

        Args:
            user_id: User ID
            max_jobs: Maximum allowed concurrent jobs
            _db: Database session (injected by @service decorator)

        Returns:
            dict: Result with success status and message
        """
        return document_job_manager.check_user_job_limit(user_id, max_jobs)

    @staticmethod
    async def send_document_notification(notification_data, _db=None):
        """
        Send a WebSocket notification about a document event.

        Args:
            notification_data: The notification data to send
            _db: Database session (injected by @service decorator)

        Returns:
            bool: True if the notification was sent successfully, False otherwise
        """
        return await document_job_manager.send_document_notification(notification_data)

    @staticmethod
    def get_job_info_by_document_id(document_id):
        """Get job info by document ID"""
        return document_job_manager.get_job_info_by_document_id(document_id)

    # Static methods for backward compatibility with existing code
    @staticmethod
    def process_pdf(
        file_path: str,
        ocr_enabled: bool = False,
        job_id: str = None,
        progress_callback=None,
        db=None,
        user_id=None,
    ):
        """Process PDF - delegates to document processor"""
        return document_processor.process_pdf(file_path, ocr_enabled, job_id, progress_callback, db, user_id)

    @staticmethod
    def process_epub(
        file_path: str,
        job_id: str = None,
        progress_callback=None,
        db=None,
        user_id=None,
    ):
        """Process EPUB - delegates to document processor"""
        return document_processor.process_epub(file_path, job_id, progress_callback, db, user_id)

    @staticmethod
    def process_docx(
        file_path: str,
        job_id: str = None,
        progress_callback=None,
        db=None,
        user_id=None,
    ):
        """Process DOCX - delegates to document processor"""
        return document_processor.process_docx(file_path, job_id, progress_callback, db, user_id)

    @staticmethod
    def process_tabular(
        file_path: str,
        job_id: str = None,
        progress_callback=None,
        db=None,
        user_id=None,
    ):
        """Process tabular file (CSV/TSV/XLSX/XLS) - delegates to document processor"""
        return document_processor.process_tabular(file_path, job_id, progress_callback, db, user_id)

    @staticmethod
    def process_text_file(
        file_path: str,
        job_id: str = None,
        progress_callback=None,
        user_id=None,
    ):
        """Process text/markdown file - creates temporary instance for processing"""
        from src.main.config.database import SessionLocal

        db = SessionLocal()
        try:
            service = DocumentService(db)
            # noinspection PyTypeChecker,PyUnresolvedReferences
            return service._process_text_file(file_path, job_id, progress_callback, user_id)
        finally:
            db.close()

    @staticmethod
    def extract_pdf_metadata(file_path: str) -> dict[str, Any]:
        """Extract PDF metadata - delegates to document processor"""
        return document_processor.extract_pdf_metadata(file_path)

    @staticmethod
    def enrich_documents_with_metadata(documents, collection_id: str, user_id: str, document_id: str | None = None):
        """Enrich documents with a metadata-simplified version for backward compatibility"""
        try:
            from langchain_core.documents import Document as LangchainDocument

            enriched_documents = []
            for i, doc in enumerate(documents):
                # Ensure it's a LangchainDocument
                if isinstance(doc, str):
                    doc = LangchainDocument(page_content=doc, metadata={})

                # Add metadata
                doc.metadata.update(
                    {
                        "collection_id": collection_id,
                        "user_id": user_id,
                        "enriched_at": time.time(),
                    }
                )

                if document_id:
                    doc.metadata["document_id"] = document_id
                if "chunk_index" not in doc.metadata:
                    doc.metadata["chunk_index"] = i

                enriched_documents.append(doc)

            # Log summary of page number preservation
            pages_with_numbers = [doc.metadata.get("page") for doc in enriched_documents if doc.metadata.get("page") is not None]
            if pages_with_numbers:
                logger.info(
                    "Enriched %d documents with preserved page numbers: pages %s-%s",
                    len(enriched_documents),
                    min(pages_with_numbers),
                    max(pages_with_numbers),
                )
            else:
                logger.info(
                    "Enriched %d documents (no page numbers available)",
                    len(enriched_documents),
                )

            return enriched_documents
        except Exception as ex:
            logger.error("Error enriching documents: %s", ex)
            return documents

    @staticmethod
    def initialize_job_tracking(document_id: str, collection_id: str) -> str:
        """Initialize job tracking - delegates to job manager"""
        return document_job_manager.initialize_job_tracking(document_id, collection_id)

    @staticmethod
    async def update_document_progress(
        job_id: str,
        document_id: str,
        progress: int,
        message: str,
        status=JobStatus.PROCESSING,
    ):
        """Update document progress - delegates to job manager"""
        return await document_job_manager.update_document_progress(job_id, document_id, progress, message, status)

    @staticmethod
    def process_progress_callback(job_id: str, progress_data: dict[str, Any]):
        """Process progress callback - delegates to job manager"""
        return document_job_manager.process_progress_callback(job_id, progress_data)

    @staticmethod
    async def cleanup_job_status(job_id: str, delay_seconds: int = 300):
        """Cleanup job status - delegates to job manager"""
        return await DocumentService.cleanup_job_status(job_id, delay_seconds)

    async def process_document_background(
        self,
        document_id: str,
        file_path: str,
        collection_id: str,
        user_id: str,
        initial_progress: int = 0,
        skip_llm_steps: bool = False,
        markdown_content: str | None = None,
    ) -> AsyncGenerator[str, None]:
        """
        Process a document in the background with knowledge graph integration.

        This method implements the complete upload workflow as specified in the
        relational-graph boundary documentation:
        1. Validate workspace ACL (SQL)
        2. Extract text → chunk → embed
        3. MERGE workspace/collection/book/paragraph nodes in Neo4j
        4. Insert scrapalot_embedding rows
        5. Mark jobs completed

        Args:
            document_id: Document identifier
            file_path: Path to the document file
            collection_id: Collection identifier
            user_id: User identifier
            initial_progress: Initial progress percentage
            skip_llm_steps: If True, skip LLM-expensive steps (embeddings, graph, summarization)
                when content hash matches (content unchanged)
            markdown_content: Optional pre-extracted markdown content (skips file parsing)

        Yields:
            JSON strings with processing updates
        """
        self._skip_llm_steps = skip_llm_steps
        job_id = None

        try:
            # Check if job already exists (e.g., from retry or previous attempt)
            job_info = document_job_manager.get_job_info_by_document_id(document_id)
            if job_info:
                job_id = job_info.get("job_id")
                logger.info("Reusing existing job %s for document %s", job_id, document_id)
            else:
                # Initialize new job tracking with user_id for WebSocket notifications
                job_id = document_job_manager.initialize_job_tracking(document_id, collection_id, user_id)
                logger.info("Created new job %s for document %s with user_id %s", job_id, document_id, user_id)

            logger.info("Starting background document processing for document %s", document_id)

            # Setup document processing with workspace ACL validation and progress updates
            workspace_id = None
            parse_progress = None
            async for update in self._setup_document_processing(
                collection_id,
                user_id,
                job_id,
                initial_progress,
                complete_job_on_error=False,
            ):
                if '"type": "error"' in update:
                    yield update
                    return
                elif '"type": "setup_complete"' in update:
                    # Extract setup results
                    setup_data = json.loads(update.strip())
                    # noinspection PyUnresolvedReferences
                    workspace_id = setup_data["content"]["workspace_id"]
                    # noinspection PyUnresolvedReferences
                    parse_progress = setup_data["content"]["parse_progress"]
                else:
                    yield update

            # Verify we got the setup results
            if workspace_id is None:
                workspace_info = await self._get_workspace_for_collection(collection_id, user_id)
                # noinspection PyUnresolvedReferences
                workspace_id = workspace_info["workspace_id"]
                parse_progress = max(initial_progress + 2, 12)

            # Either parse the file or use pre-existing markdown content from the database
            if markdown_content:
                # Skip file parsing — use markdown content directly from the documents table
                from langchain_core.documents import Document as LCDocument

                from src.main.service.document.document_processor import DocumentProcessor
                from src.main.utils.text.markdown import strip_publisher_boilerplate

                logger.info(
                    "Using markdown content from database for document %s (%d chars)",
                    document_id,
                    len(markdown_content),
                )
                _parse_start = time.time()
                # Strip publisher running headers / open-access boilerplate so
                # legacy markdown_imported docs benefit from the same cleanup
                # the PDF parse path applies.
                markdown_content = strip_publisher_boilerplate(markdown_content)
                raw_documents = [LCDocument(page_content=markdown_content, metadata={"source": "database", "page": 0})]
                _parse_duration = time.time() - _parse_start

                if job_id:
                    document_job_manager.record_phase_timing(
                        job_id, "parse", _parse_duration, {"processor_used": "markdown_content", "source": "database"}
                    )

                # Apply chunking in a thread to avoid blocking the async event loop
                # (large documents with enhanced_markdown strategy can take 30s+ of CPU time)
                parse_result = await asyncio.to_thread(
                    DocumentProcessor.apply_chunking_and_return_documents_with_pages,
                    raw_documents,
                    file_path or f"database_{document_id}.md",
                    db=self._db,
                    user_id=user_id,
                    job_id=job_id,
                )
                logger.info("Chunked markdown content into %d segments for document %s", len(parse_result), document_id)

                self._new_content_hash = hashlib.sha256(markdown_content.encode("utf-8")).hexdigest()
                # noinspection PyUnresolvedReferences
                logger.info("Computed content hash for document %s: %s", document_id, self._new_content_hash[:16])
            else:
                # Parse the document file (timed for processing stats)
                _parse_start = time.time()
                parse_result = await self._parse_document_with_validation(file_path, job_id, user_id, "background")
                _parse_duration = time.time() - _parse_start

                # Check if document parsing returned an error
                if isinstance(parse_result, str) and '"type": "error"' in parse_result:
                    yield parse_result
                    return  # Exit early, error already handled by _parse_document_with_validation

                # Record parse phase timing (background, no latency impact)
                if job_id:
                    _parse_meta = {"page_count": len(parse_result) if isinstance(parse_result, list) else 0}
                    if hasattr(self, "_processor_used"):
                        _parse_meta["processor_used"] = self._processor_used
                    if hasattr(self, "_ocr_detected"):
                        _parse_meta["ocr_detected"] = self._ocr_detected
                    document_job_manager.record_phase_timing(job_id, "parse", _parse_duration, _parse_meta)

                # Compute content hash (SHA-256) from parsed content for cache-aware reprocessing
                if isinstance(parse_result, list) and parse_result:
                    content_for_hash = "\n".join(doc.page_content for doc in parse_result if doc.page_content)
                    self._new_content_hash = hashlib.sha256(content_for_hash.encode("utf-8")).hexdigest()
                    # noinspection PyUnresolvedReferences
                    logger.info("Computed content hash for document %s: %s", document_id, self._new_content_hash[:16])
                else:
                    self._new_content_hash = None

            # Reject metadata-stub ingests before they can be marked `completed`.
            # See _is_metadata_stub_chunks docstring for the production incident
            # that motivates this guard.
            if _is_metadata_stub_chunks(parse_result):
                _stub_chunks = len(parse_result) if isinstance(parse_result, list) else 0
                _stub_chars = sum(len(getattr(d, "page_content", "") or "") for d in parse_result) if isinstance(parse_result, list) else 0
                logger.warning(
                    "Rejecting metadata-stub ingest for document %s: chunks=%d total_chars=%d",
                    document_id,
                    _stub_chunks,
                    _stub_chars,
                )
                raise DocumentProcessingError("errorEmptyDocument")

            # Fire-and-forget: enrich document with academic metadata (DOI/ISBN/arXiv/PMID)
            # Runs in background so it never blocks chunking/embedding
            if isinstance(parse_result, list) and parse_result:
                try:
                    from src.main.service.metadata.metadata_enrichment_service import enrich_document_metadata

                    enrichment_text = "\n".join(doc.page_content for doc in parse_result if doc.page_content)
                    asyncio.create_task(enrich_document_metadata(document_id, enrichment_text))
                    logger.debug("Dispatched metadata enrichment task for document %s", document_id)
                except Exception as enrichment_err:
                    logger.warning("Failed to dispatch metadata enrichment for document %s: %s", document_id, enrichment_err)

            # Process post-parse workflow (sets self._entity_extraction_dispatched if background task dispatched)
            # noinspection PyTypeChecker
            async for update in self._process_post_parse_workflow(
                parse_result,
                collection_id,
                user_id,
                document_id,
                job_id,
                parse_progress,
                file_path,
                workspace_id,
            ):
                yield update

            # Check if entity extraction was dispatched (stored in instance variable)
            entity_extraction_dispatched = getattr(self, "_entity_extraction_dispatched", False)

            # Only send completion if entity extraction was NOT dispatched
            # If entity extraction was dispatched, it will handle completion notification
            if not entity_extraction_dispatched:
                # Complete the job and log success
                yield (
                    json.dumps(
                        {
                            "type": "status",
                            "content": {
                                "progress": 100,
                                "message": "documentProcessingCompleted",
                                "status": "completed",
                            },
                        }
                    )
                    + "\n"
                )
            else:
                logger.info(
                    "Skipping job completion notification - entity extraction background task will complete job %s",
                    job_id,
                )

            # Update document status to completed
            try:
                from uuid import UUID

                from src.main.models.sqlmodel_models import Document

                # noinspection PyTypeChecker,PyUnresolvedReferences
                doc = self._db.query(Document).filter(Document.id == UUID(document_id)).first()
                if doc:
                    doc.processing_status = "completed"
                    doc.processing_progress = 100.0
                    doc.processing_error = None

                    # Populate content field if empty (e.g., memory-only uploads where
                    # create_document() couldn't extract content from an empty file_path)
                    # noinspection PyUnresolvedReferences
                    if not doc.content and isinstance(parse_result, list) and parse_result:
                        extracted_content = "\n\n".join(d.page_content for d in parse_result if d.page_content)
                        if extracted_content:
                            doc.content = extracted_content
                            doc.page_count = len(parse_result)
                            logger.info(
                                "Populated content for document %s: %d chars, %d pages",
                                document_id,
                                len(extracted_content),
                                len(parse_result),
                            )

                    # Store content hash for cache-aware reprocessing
                    if getattr(self, "_new_content_hash", None):
                        doc.content_hash = self._new_content_hash
                        logger.info("Stored content hash for document %s", document_id)

                    # Update title from extracted PDF metadata with fallback to filename
                    # noinspection PyUnresolvedReferences
                    if doc.file_metadata:
                        try:
                            # Handle both dict (PostgreSQL JSONB), string, and double-encoded JSON
                            # noinspection PyUnresolvedReferences
                            if isinstance(doc.file_metadata, dict):
                                # noinspection PyUnresolvedReferences
                                metadata = doc.file_metadata
                            else:
                                # noinspection PyUnresolvedReferences
                                metadata = json.loads(doc.file_metadata)
                                # Handle double-encoded JSON (string inside string)
                                if isinstance(metadata, str):
                                    metadata = json.loads(metadata)
                            extracted_title = metadata.get("title")

                            # Use fallback title logic (validates extracted title or parses from filename)
                            from src.main.utils.documents.utils import get_fallback_title

                            # Get the best title (validates LLM extraction, parses filename, or uses sanitized filename)
                            # noinspection PyUnresolvedReferences
                            best_title = get_fallback_title(doc.filename, extracted_title)

                            # Only update if different from current title
                            # noinspection PyUnresolvedReferences
                            if best_title and best_title != doc.title:
                                doc.title = best_title
                                logger.info(
                                    "Updated document %s title to: %s (source: %s)",
                                    document_id,
                                    best_title,
                                    "extracted" if extracted_title == best_title else "filename",
                                )
                        except (json.JSONDecodeError, AttributeError) as meta_err:
                            logger.warning("Could not extract title from file_metadata: %s", str(meta_err))

                    # noinspection PyUnresolvedReferences
                    self._db.commit()
                    logger.info("Updated document %s status to completed", document_id)

                    # Regenerate collection description with new document context
                    try:
                        from src.main.service.collection_description_service import generate_and_store_description

                        await generate_and_store_description(UUID(collection_id), force=True)
                    except Exception as desc_err:
                        logger.warning("Failed to regenerate collection description: %s", desc_err)

                    # Update content store and notify dedup waiters
                    # noinspection PyUnresolvedReferences
                    if doc.content_store_id:
                        try:
                            from src.main.models.sqlmodel_models import ContentStore
                            from src.main.service.document.dedup_service import notify_dedup_waiters

                            # noinspection PyTypeChecker,PyUnresolvedReferences
                            cs = self._db.query(ContentStore).filter(ContentStore.id == doc.content_store_id).first()
                            if cs:
                                cs.processing_status = "completed"
                                if getattr(self, "_new_content_hash", None):
                                    cs.content_hash = self._new_content_hash
                                # noinspection PyUnresolvedReferences
                                cs.page_count = doc.page_count
                                # noinspection PyUnresolvedReferences
                                cs.word_count = doc.word_count
                                # noinspection PyUnresolvedReferences
                                self._db.commit()
                                # noinspection PyUnresolvedReferences
                                logger.info("Updated content store %s status to completed", doc.content_store_id)

                                # Clone artifacts to any documents waiting for this content
                                # noinspection PyTypeChecker,PyUnresolvedReferences
                                waiters_processed = await notify_dedup_waiters(self._db, doc.content_store_id, document_id)
                                if waiters_processed > 0:
                                    # noinspection PyUnresolvedReferences
                                    _cs_id = doc.content_store_id
                                    logger.info(
                                        "Notified %d dedup waiters for content store %s",
                                        waiters_processed,
                                        _cs_id,
                                    )
                        except Exception as dedup_error:
                            logger.warning("Error updating content store or notifying dedup waiters: %s", str(dedup_error))

                    # Generate document summaries (chapters + book) if hierarchy exists
                    try:
                        # noinspection PyUnresolvedReferences
                        if doc.document_hierarchy:
                            if getattr(self, "_skip_llm_steps", False):
                                # skip_llm_steps = reprocess mode — skip ALL LLM operations including summarization
                                logger.info("Skipping summarization (skip_llm_steps=True) for document %s", document_id)
                            else:
                                logger.info("Generating document summaries for %s", document_id)
                                from src.main.service.document.document_summary_service import DocumentSummaryService

                                # noinspection PyTypeChecker
                                summary_service = DocumentSummaryService(self._db)
                                summary_result = await summary_service.generate_document_summaries(
                                    document_id=UUID(document_id), user_id=UUID(user_id)
                                )

                                if "error" not in summary_result:
                                    logger.info(
                                        "Document summarization complete: %d chapters, book summary: %s",
                                        summary_result.get("chapter_summaries_generated", 0),
                                        summary_result.get("book_summary_generated", False),
                                    )
                                else:
                                    logger.warning(
                                        "Document summarization failed for %s: %s",
                                        document_id,
                                        summary_result.get("error"),
                                    )
                    except Exception as summary_error:
                        logger.warning("Non-fatal error generating document summaries: %s", str(summary_error), exc_info=True)

                    # Thumbnails are pre-generated during upload (document_processing/documents.py)
                    # No need to regenerate here — the file has already been processed for thumbnails
            except Exception as update_err:
                logger.error("Failed to update document status: %s", str(update_err))
                # noinspection PyUnresolvedReferences
                self._db.rollback()

            # Mark job as completed (only if entity extraction was NOT dispatched)
            # If entity extraction was dispatched, the background task will complete the job
            if not entity_extraction_dispatched:
                document_job_manager.complete_job(
                    job_id,
                    success=True,
                    message="Processing completed successfully",
                    db=self._db,
                )
                logger.info(
                    "Background processing completed successfully for document %s (job marked as complete)",
                    document_id,
                )
            else:
                logger.info(
                    "Background processing completed for document %s - entity extraction will complete job %s",
                    document_id,
                    job_id,
                )

        except Exception as ex:
            # Update document status to failed
            try:
                from uuid import UUID

                from src.main.models.sqlmodel_models import Document

                # noinspection PyTypeChecker,PyUnresolvedReferences
                doc = self._db.query(Document).filter(Document.id == UUID(document_id)).first()
                if doc:
                    from src.main.utils.core.error_codes import to_status_code

                    doc.processing_status = "failed"
                    # Status code per CLAUDE.md rule #3 — never raw English.
                    doc.processing_error = to_status_code(ex)
                    # noinspection PyUnresolvedReferences
                    self._db.commit()
                    logger.info("Updated document %s status to failed", document_id)

                    # Propagate failure to dedup waiters
                    # noinspection PyUnresolvedReferences
                    if doc.content_store_id:
                        try:
                            from src.main.models.sqlmodel_models import ContentStore
                            from src.main.service.document.dedup_service import handle_source_failed

                            # noinspection PyTypeChecker,PyUnresolvedReferences
                            cs = self._db.query(ContentStore).filter(ContentStore.id == doc.content_store_id).first()
                            if cs:
                                cs.processing_status = "failed"
                                # noinspection PyUnresolvedReferences
                                self._db.commit()
                            # noinspection PyTypeChecker,PyUnresolvedReferences
                            await handle_source_failed(self._db, doc.content_store_id, str(ex))
                        except Exception as dedup_err:
                            logger.warning("Error propagating failure to dedup waiters: %s", str(dedup_err))
            except Exception as status_err:
                logger.error("Failed to update document status to failed: %s", str(status_err))
                # noinspection PyUnresolvedReferences
                self._db.rollback()

            yield self._handle_document_processing_error(ex, job_id, "background")

    async def process_document_stream(
        self,
        file_path: str,
        collection_id: str,
        document_id: str,
        user_id: str,
        job_id: str,
        initial_progress: int = 0,
    ) -> AsyncGenerator[str, None]:
        """
        Process a document with streaming progress updates.

        This method provides the same functionality as process_document_background
        but uses an existing job_id for tracking instead of creating a new one.

        Args:
            file_path: Path to the document file
            collection_id: Collection identifier
            document_id: Document identifier
            user_id: User identifier
            job_id: Job identifier for tracking (use an existing job instead of creating new one)
            initial_progress: Starting progress percentage

        Yields:
            JSON strings with processing updates
        """
        try:
            logger.info("Starting stream document processing for document %s", document_id)

            # Setup document processing with workspace ACL validation and progress updates
            workspace_id = None
            parse_progress = None
            async for update in self._setup_document_processing(
                collection_id,
                user_id,
                job_id,
                initial_progress,
                complete_job_on_error=True,
            ):
                if '"type": "error"' in update:
                    yield update
                    return
                elif '"type": "setup_complete"' in update:
                    # Extract setup results
                    setup_data = json.loads(update.strip())
                    # noinspection PyUnresolvedReferences
                    workspace_id = setup_data["content"]["workspace_id"]
                    # noinspection PyUnresolvedReferences
                    parse_progress = setup_data["content"]["parse_progress"]
                else:
                    yield update

            # Verify we got the setup results
            if workspace_id is None:
                workspace_info = await self._get_workspace_for_collection(collection_id, user_id)
                # noinspection PyUnresolvedReferences
                workspace_id = workspace_info["workspace_id"]
                parse_progress = max(initial_progress + 2, 12)

            # Step 1: Document parsing (continuing from setup progress)
            # Don't reset to 0 - continue from where setup left off (upload completes at 10%)
            current_progress = parse_progress if parse_progress is not None else 12
            await self._update_job_progress(job_id, current_progress, "parsingDocument")
            yield (
                json.dumps(
                    {
                        "type": "status",
                        "content": {
                            "progress": current_progress,
                            "message": "parsingDocument",
                            "status": "processing",
                        },
                    }
                )
                + "\n"
            )

            # Start document parsing in a separate task (timed for processing stats)
            _parse_start = time.time()
            parse_task = asyncio.create_task(self._parse_document_with_validation(file_path, job_id, user_id, "stream"))

            # Stream progress updates while document parsing runs
            while not parse_task.done():
                try:
                    # Check if a job has been canceled
                    job_status = document_job_manager.get_job_status(job_id, self._db)
                    if job_status and job_status.get("status") == JobStatus.CANCELLED:
                        logger.info("Job %s was cancelled, stopping document parsing", job_id)
                        parse_task.cancel()
                        yield (
                            json.dumps(
                                {
                                    "type": "status",
                                    "content": {
                                        "progress": 0,
                                        "message": "cancelledByUser",
                                        "status": "cancelled",
                                    },
                                }
                            )
                            + "\n"
                        )
                        return

                    # Check for progress updates with a short timeout
                    if hasattr(self, "_progress_queue"):
                        try:
                            progress_update = await asyncio.wait_for(self._progress_queue.get(), timeout=0.1)
                            yield json.dumps(progress_update) + "\n"
                        except TimeoutError:
                            # Expected: no progress update within the poll window.
                            pass

                    # Small delay to prevent busy waiting
                    await asyncio.sleep(0.1)
                except Exception as progress_err:
                    logger.warning("Error processing progress updates: %s", str(progress_err))
                    break

            # Get the document parsing result
            parse_result = await parse_task
            _parse_duration = time.time() - _parse_start

            # Process any remaining progress updates
            if hasattr(self, "_progress_queue"):
                try:
                    while True:
                        progress_update = self._progress_queue.get_nowait()
                        yield json.dumps(progress_update) + "\n"
                except asyncio.QueueEmpty:
                    # Expected: queue drained, loop is finished.
                    pass

            # Check if document parsing returned an error
            if isinstance(parse_result, str) and '"type": "error"' in parse_result:
                yield parse_result
                return  # Exit early, error already handled by _parse_document_with_validation

            # Record parse phase timing (streaming path)
            if job_id:
                _parse_meta = {"page_count": len(parse_result) if isinstance(parse_result, list) else 0}
                if hasattr(self, "_processor_used"):
                    _parse_meta["processor_used"] = self._processor_used
                if hasattr(self, "_ocr_detected"):
                    _parse_meta["ocr_detected"] = self._ocr_detected
                document_job_manager.record_phase_timing(job_id, "parse", _parse_duration, _parse_meta)

            # Fire-and-forget: enrich document with academic metadata (DOI/ISBN/arXiv/PMID)
            # Runs in background so it never blocks chunking/embedding
            if isinstance(parse_result, list) and parse_result:
                try:
                    from src.main.service.metadata.metadata_enrichment_service import enrich_document_metadata

                    enrichment_text = "\n".join(doc.page_content for doc in parse_result if doc.page_content)
                    asyncio.create_task(enrich_document_metadata(document_id, enrichment_text))
                    logger.debug("Dispatched metadata enrichment task for document %s", document_id)
                except Exception as enrichment_err:
                    logger.warning("Failed to dispatch metadata enrichment for document %s: %s", document_id, enrichment_err)

            # Process the post-parse workflow with error protection
            try:
                # Process a post-parse workflow with proper error handling
                start_time = time.time()
                # noinspection PyTypeChecker
                async for update in self._process_post_parse_workflow(
                    parse_result,
                    collection_id,
                    user_id,
                    document_id,
                    job_id,
                    parse_progress,
                    file_path,
                    workspace_id,
                ):
                    yield update
                    # Check for timeout during processing (10 minutes max)
                    if time.time() - start_time > 600:
                        logger.warning("Post-parse workflow taking too long for document %s - breaking", document_id)
                        break

                logger.info("Post-parse workflow completed successfully for document %s", document_id)
            except Exception as workflow_err:
                logger.exception("Error in post-parse workflow for document %s: %s", document_id, str(workflow_err))
                # CRITICAL: Re-raise exception - post-processing failures should stop document processing
                # Don't continue to "completion" if critical steps like hierarchy creation failed
                raise

            # Don't mark as 100% completed yet - entity extraction still needs to run
            # Keep at 75% and status "processing" until entity extraction completes
            await self._update_job_progress(job_id, 75, "chunksProcessedStartingExtraction")
            # Note: Job will be marked as completed (100%) by entity extraction callback

            yield (
                json.dumps(
                    {
                        "type": "status",
                        "content": {
                            "progress": 75,
                            "message": "chunksProcessedStartingExtraction",
                            "status": "processing",  # Still processing - not completed yet
                            "job_id": job_id,
                            "document_id": document_id,
                        },
                    }
                )
                + "\n"
            )

            logger.info(
                "Document processing completed successfully for document %s (post-processing: completed)",
                document_id,
            )

        except Exception as ex:
            yield self._handle_document_processing_error(ex, job_id, "stream")

    async def _process_post_parse_workflow(
        self,
        parse_result,
        collection_id: str,
        user_id: str,
        document_id: str,
        job_id: str,
        parse_progress: int,
        file_path: str,
        workspace_id: str,
    ):
        """
        Helper function to process the post-parse workflow including result validation,
        metadata/embeddings processing, and graph integration.

        Args:
            parse_result: Result from document parsing (None, str error, or documents)
            collection_id: Collection identifier
            user_id: User identifier
            document_id: Document identifier
            job_id: Job identifier for progress tracking
            parse_progress: Current document parsing progress
            file_path: Path to the document file
            workspace_id: Workspace identifier

        Yields:
            JSON strings with progress updates during graph processing

        Side Effects:
            Sets self._entity_extraction_dispatched to track dispatch status
        """
        # Initialize instance variable
        self._entity_extraction_dispatched = False

        # Handle document parsing result
        if parse_result is None:
            return
        elif isinstance(parse_result, str):  # Error message
            yield parse_result
            return
        else:
            documents = parse_result

        # Process metadata and embeddings (includes graph entity creation if enabled)
        # This sets self._entity_extraction_dispatched if background task is dispatched
        async for update in self._process_metadata_and_embeddings(
            documents,
            collection_id,
            user_id,
            document_id,
            job_id,
            parse_progress,
            workspace_id=workspace_id,
            file_path=file_path,
        ):
            yield update

    async def _parse_document_with_validation(self, file_path: str, job_id: str, user_id: str, context: str = "processing"):
        """
        Parse a document file with validation and error handling.
        Handles all file types (PDF, EPUB, DOCX, Markdown, etc.)

        Args:
            file_path: Path to the document file
            job_id: Job identifier for progress tracking
            user_id: User identifier
            context: Context string for error messages (e.g., "background", "stream")

        Returns:
            list: Processed documents if successful
            str: Error JSON message if no content extracted
            None: If exception occurred (error already handled)
        """
        try:
            # Create a streaming progress callback using a centralized utility
            progress_queue = asyncio.Queue()

            streaming_progress_callback = create_streaming_progress_callback(
                progress_queue=progress_queue,
                job_manager_callback=document_job_manager.process_progress_callback,
            )

            # Store the queue for the streaming generator to access
            self._progress_queue = progress_queue

            # Check file extension to determine the processing method
            file_extension = os.path.splitext(file_path)[1].lower()

            # Run processing in a thread pool to avoid blocking the async loop
            import concurrent.futures

            loop = asyncio.get_event_loop()

            with concurrent.futures.ThreadPoolExecutor() as executor:
                if file_extension in [".md", ".markdown", ".txt", ".rtf"]:
                    # Process markdown/text/RTF files directly
                    # noinspection PyTypeChecker
                    documents = await loop.run_in_executor(
                        executor,
                        lambda: self._process_text_file(
                            file_path=file_path,
                            job_id=job_id,
                            progress_callback=streaming_progress_callback,
                            _user_id=user_id,
                        ),
                    )
                elif file_extension in [".csv", ".tsv", ".xlsx", ".xls"]:
                    # Parse tabular files into structured Markdown tables
                    # noinspection PyTypeChecker
                    documents = await loop.run_in_executor(
                        executor,
                        lambda: self.process_tabular(
                            file_path=file_path,
                            job_id=job_id,
                            progress_callback=streaming_progress_callback,
                            db=self._db,
                            user_id=user_id,
                        ),
                    )
                elif file_extension == ".epub":
                    # Process EPUB files
                    # noinspection PyTypeChecker
                    documents = await loop.run_in_executor(
                        executor,
                        lambda: self.process_epub(
                            file_path=file_path,
                            job_id=job_id,
                            progress_callback=streaming_progress_callback,
                            db=self._db,
                            user_id=user_id,
                        ),
                    )
                elif file_extension == ".docx":
                    # Process DOCX files
                    # noinspection PyTypeChecker
                    documents = await loop.run_in_executor(
                        executor,
                        lambda: self.process_docx(
                            file_path=file_path,
                            job_id=job_id,
                            progress_callback=streaming_progress_callback,
                            db=self._db,
                            user_id=user_id,
                        ),
                    )
                else:
                    # Get OCR setting from document_processing settings
                    from src.main.service.settings import get_user_settings

                    # noinspection PyTypeChecker
                    user_settings = await get_user_settings(user_id, self._db)
                    doc_processing = user_settings.get("document_processing", {})
                    ocr_enabled = doc_processing.get("ocr_enabled", False)

                    # Process PDF documents (default handler for non-text/epub/docx files)
                    # noinspection PyTypeChecker
                    documents = await loop.run_in_executor(
                        executor,
                        lambda: self.process_pdf(
                            file_path=file_path,
                            ocr_enabled=ocr_enabled,
                            job_id=job_id,
                            progress_callback=streaming_progress_callback,
                            db=self._db,
                            user_id=user_id,
                        ),
                    )

            if not documents:
                error_msg = "No content extracted from document"
                logger.error(error_msg)
                # Mark job as failed so UI stops spinning
                if job_id:
                    document_job_manager.complete_job(
                        job_id=job_id,
                        success=False,
                        message=error_msg,
                        error_details="Document processing completed but no text content could be extracted. The file may be image-only, corrupted, or password-protected.",
                        db=self._db,
                    )
                return json.dumps({"type": "error", "content": {"detail": error_msg}}) + "\n"

            return documents

        except Exception as ex:
            # Handle the error using the existing error handler
            error_response = self._handle_document_processing_error(ex, job_id, context)
            return error_response

    @staticmethod
    def _process_text_file(file_path: str, job_id: str, progress_callback, _user_id: str):
        """
        Process text/markdown files directly without document parsing pipeline.

        Args:
            file_path: Path to the text/markdown file
            job_id: Job identifier for progress tracking
            progress_callback: Callback for progress updates
            _user_id: User identifier

        Returns:
            list: List of LangchainDocument objects
        """
        try:
            from langchain_core.documents import Document as LangchainDocument

            # Update progress
            if job_id and progress_callback:
                progress_callback(
                    job_id,
                    {
                        "progress": 10,
                        "message": "readingTextFile",
                        "status": "processing",
                    },
                )

            # Read the file content
            with open(file_path, encoding="utf-8") as f:
                content = f.read()

            # Update progress
            if job_id and progress_callback:
                progress_callback(
                    job_id,
                    {
                        "progress": 50,
                        "message": "processingTextContent",
                        "status": "processing",
                    },
                )

            # Create a single document with the content
            # The chunking will be handled later by the chunking service
            document = LangchainDocument(
                page_content=content,
                metadata={
                    "source": file_path,
                    "file_type": os.path.splitext(file_path)[1].lower(),
                    "file_name": os.path.basename(file_path),
                },
            )

            # Update progress to completion
            if job_id and progress_callback:
                progress_callback(
                    job_id,
                    {
                        "progress": 70,
                        "message": "textProcessingComplete",
                        "status": "processing",
                    },
                )

            logger.info("Successfully processed text file: %s", os.path.basename(file_path))
            return [document]

        except Exception as text_err:
            logger.error("Error processing text file %s: %s", file_path, str(text_err))
            raise DocumentProcessingError(f"Failed to process text file: {text_err!s}") from text_err

    @staticmethod
    async def _update_job_progress(job_id: str, progress: int, message: str):
        """Update job progress"""
        document_job_manager.update_job_progress(job_id, progress, message, JobStatus.PROCESSING)

    async def _create_graph_entities(
        self,
        document_id: str,
        collection_id: str,
        workspace_id: str,
        file_path: str,
        enriched_documents: list,
        job_id: str = None,
        user_id: str = None,
    ):
        """
        Create Neo4j graph entities with async entity extraction.

        This implements a two-step approach:
        - Step 1: Create book→chapter→section→paragraph hierarchy (SYNCHRONOUS, fast)
        - Step 2: Extract entities from chunks (BACKGROUND TASK, non-blocking)

        Step 1 happens during upload for immediate hierarchy availability.
        Step 2 is dispatched to a background asyncio task.

        Args:
            document_id: Document identifier
            collection_id: Collection identifier
            workspace_id: Workspace identifier
            file_path: Path to the document file
            enriched_documents: List of enriched document chunks
            job_id: Optional job ID for progress tracking
            user_id: User ID for LLM provider authentication during entity extraction

        Yields:
            JSON strings with progress updates during hierarchy creation

        Side Effects:
            Sets self._entity_extraction_dispatched to True if entity extraction background task was dispatched.
            If True, caller should NOT mark job as complete (background task will handle it).
        """
        # Initialize instance variable to track entity extraction dispatch status
        self._entity_extraction_dispatched = False

        try:
            # Check if the graph integration service is available
            # noinspection PyUnresolvedReferences
            if not self.graph_integration_service or not self.graph_integration_service.is_graph_enabled():
                logger.debug("Graph integration not available or disabled")
                return

            # Skip graph creation when content is unchanged and Book node already exists
            if getattr(self, "_skip_llm_steps", False):
                try:
                    if hasattr(self.graph_integration_service, "driver") and self.graph_integration_service.driver:
                        with self.graph_integration_service.driver.session() as neo4j_session:
                            result = neo4j_session.run(
                                "MATCH (b:Book {document_id: $document_id}) RETURN count(b) AS cnt",
                                document_id=document_id,
                            )
                            book_count = result.single()["cnt"]
                            if book_count > 0:
                                logger.info(
                                    "Skipping graph entity creation — content unchanged, Book node exists for document %s",
                                    document_id,
                                )
                                if job_id:
                                    await self._update_job_progress(job_id, 90, "reusingGraphUnchanged")
                                    yield (
                                        json.dumps(
                                            {
                                                "type": "status",
                                                "content": {
                                                    "progress": 90,
                                                    "message": "reusingGraphUnchanged",
                                                    "status": "processing",
                                                },
                                            }
                                        )
                                        + "\n"
                                    )
                                return
                except Exception as graph_check_error:
                    logger.warning("Error checking existing graph nodes, proceeding with full creation: %s", str(graph_check_error))

            # Get graph config
            from src.main.utils.config.loader import resolved_config

            graph_config = resolved_config.get("graph", {})
            _ee_raw = graph_config.get("enable_entity_extraction", False)
            enable_entity_extraction = _ee_raw if isinstance(_ee_raw, bool) else str(_ee_raw).lower() not in ("false", "0", "no", "")

            # Get document metadata for graph processing
            document_data = await self._get_document_metadata(document_id, file_path)

            # STEP 1: Create hierarchy (synchronous, fast)
            logger.info(
                "Creating Neo4j hierarchy for document %s (Step 1: book→chapter→section→paragraph)",
                document_id,
            )

            # Update progress before starting hierarchy creation
            if job_id:
                await self._update_job_progress(job_id, 65, "creatingHierarchy")
                yield (
                    json.dumps(
                        {
                            "type": "status",
                            "content": {
                                "progress": 65,
                                "message": "creatingHierarchy",
                                "status": "processing",
                            },
                        }
                    )
                    + "\n"
                )

            # Create a task to periodically update progress during hierarchy creation
            # This provides user feedback during the long-running sync operation
            total_chunks = len(enriched_documents)
            hierarchy_task = asyncio.create_task(
                asyncio.to_thread(
                    self._create_document_hierarchy,
                    document_id,
                    collection_id,
                    workspace_id,
                    document_data,
                    enriched_documents,
                )
            )

            # Poll progress while hierarchy is being created (65% to 90%)
            progress_interval = 5  # Update every 5 seconds
            start_time = asyncio.get_event_loop().time()
            last_update = start_time
            current_progress = 65

            while not hierarchy_task.done():
                await asyncio.sleep(1)
                current_time = asyncio.get_event_loop().time()

                # Update progress every 5 seconds, incrementing by 5% each time up to 85%
                if current_time - last_update >= progress_interval and current_progress < 85:
                    current_progress = min(current_progress + 5, 85)
                    chunks_msg = f"({total_chunks} chunks)" if total_chunks > 100 else ""
                    if job_id:
                        await self._update_job_progress(job_id, current_progress, f"Creating knowledge graph nodes {chunks_msg}...")
                        # Yield progress update to stream
                        yield (
                            json.dumps(
                                {
                                    "type": "status",
                                    "content": {
                                        "progress": current_progress,
                                        "message": f"Creating knowledge graph nodes {chunks_msg}...",
                                        "status": "processing",
                                    },
                                }
                            )
                            + "\n"
                        )
                    last_update = current_time

            # Wait for hierarchy creation to complete
            await hierarchy_task

            if job_id:
                await self._update_job_progress(job_id, 90, "hierarchyCreated")
                yield (
                    json.dumps(
                        {
                            "type": "status",
                            "content": {
                                "progress": 90,
                                "message": "hierarchyCreated",
                                "status": "processing",
                            },
                        }
                    )
                    + "\n"
                )

            logger.info("Successfully created Neo4j hierarchy for document %s", document_id)

            # STEP 2: Dispatch entity extraction to Celery worker (non-blocking, durable)
            # Skip when reprocessing (skip_llm_steps=True) — entities are preserved and re-linked
            if enable_entity_extraction and user_id and not getattr(self, "_skip_llm_steps", False):
                try:
                    from src.main.workers.celery_app import celery_app

                    result = celery_app.send_task(
                        "scrapalot.extract_entities",
                        args=[document_id, user_id, collection_id],
                    )
                    logger.info(
                        "Entity extraction dispatched to Celery worker for document %s, task_id=%s",
                        document_id,
                        result.id,
                    )
                    self._entity_extraction_dispatched = True
                except Exception as celery_err:
                    logger.warning(
                        "Failed to dispatch entity extraction to Celery for document %s: %s",
                        document_id,
                        str(celery_err),
                    )

        except Exception as ex:
            logger.error("Error creating graph entities for document %s: %s", document_id, str(ex))
            # CRITICAL: Re-raise exception to stop document processing - hierarchy creation is mandatory
            raise

    def _create_document_hierarchy(
        self,
        document_id: str,
        collection_id: str,
        workspace_id: str,
        document_data: dict,
        enriched_documents: list,
    ):
        """
        Create a document hierarchy in Neo4j (Step 1 only).

        This creates the hierarchy without entity extraction:
        - Book node (document)
        - Chapter nodes (top-level sections)
        - Section nodes (subsections)
        - Paragraph nodes (chunks)

        Args:
            document_id: Document identifier
            collection_id: Collection identifier
            workspace_id: Workspace identifier
            document_data: Document metadata
            enriched_documents: List of enriched document chunks
        """
        try:
            # Create hierarchy using graph integration service
            # This does NOT extract entities - only creates structural nodes
            # noinspection PyTypeChecker,PyUnresolvedReferences
            hierarchy_result = self.graph_integration_service.create_document_hierarchy(
                document_id=document_id,
                collection_id=collection_id,
                workspace_id=workspace_id,
                document_data=document_data,
                enriched_documents=enriched_documents,
                _db=self.db,  # Pass database session for querying actual workspace/collection names
            )

            # Update the PostgreSQL document_hierarchy field with the actual hierarchy structure
            # This enables document summarization and other hierarchy-dependent features
            if hierarchy_result and hierarchy_result.get("status") == "success":
                from src.main.models.sqlmodel_models import Document

                # noinspection PyTypeChecker,PyUnresolvedReferences
                doc = self.db.query(Document).filter(Document.id == document_id).first()
                if doc:
                    # Extract the hierarchy structure from nodes (built by node_factory)
                    nodes = hierarchy_result.get("nodes", {})
                    hierarchy_structure: dict | None = nodes.pop("_hierarchy_structure", None) if isinstance(nodes, dict) else None

                    if hierarchy_structure:
                        # Store the actual hierarchy structure for summarization
                        doc.document_hierarchy = hierarchy_structure
                        logger.info(
                            "Updated document_hierarchy field for %s with %d chapters",
                            document_id,
                            len(hierarchy_structure),
                        )
                    else:
                        # Fallback to metadata if no structure available
                        nodes_count = len(nodes) if nodes else 0
                        doc.document_hierarchy = {
                            "status": "created",
                            "nodes_created": nodes_count,
                            "workspace_id": workspace_id,
                            "collection_id": collection_id,
                        }
                        logger.info(
                            "Updated document_hierarchy field for %s (metadata only, %d nodes)",
                            document_id,
                            nodes_count,
                        )
                    # noinspection PyUnresolvedReferences
                    self.db.commit()

            logger.debug("Document hierarchy created for %s", document_id)

        except Exception as hierarchy_err:
            logger.error("Error creating document hierarchy: %s", str(hierarchy_err))
            raise

    async def _store_embeddings_with_progress(
        self,
        enriched_documents: list,
        collection_id: str,
        user_id: str,
        job_id: str = None,
        document_id: str = None,
        workspace_id: str = None,
        file_path: str = None,
    ):
        """
        Store embeddings in PgVector following the relational-graph boundary specification:
        "Insert scrapalot_embedding rows (uuid, collection_id, embedding, chunk_id)"

        Additionally, if the graph is enabled, create Neo4j entities (book→chapter→section→paragraph)
        in parallel with vector storage. This separates user's vector DB choice from graph database.

        This version yields progress updates for streaming to the UI.

        Args:
            enriched_documents: List of enriched documents to store
            collection_id: Collection identifier
            user_id: User identifier
            job_id: Optional job ID for progress tracking
            document_id: Optional document ID for graph integration
            workspace_id: Optional workspace ID for graph integration
            file_path: Optional file path for graph metadata

        Side Effects:
            Sets self._entity_extraction_dispatched if background task is dispatched
        """
        try:
            # Skip embedding generation when content is unchanged and embeddings already exist
            if getattr(self, "_skip_llm_steps", False) and document_id:
                # noinspection PyTypeChecker,PyUnresolvedReferences
                existing_count: int = int(
                    self._db.execute(
                        text("SELECT COUNT(*) FROM langchain_pg_embedding WHERE cmetadata->>'document_id' = :id"),
                        {"id": document_id},
                    ).scalar()
                    or 0
                )
                if existing_count > 0:
                    logger.info(
                        "Skipping embedding generation — content unchanged, %d existing embeddings for document %s",
                        existing_count,
                        document_id,
                    )
                    yield (
                        json.dumps(
                            {
                                "type": "status",
                                "content": {
                                    "progress": 60,
                                    "message": f"Reusing {existing_count} existing embeddings (content unchanged)",
                                    "status": "processing",
                                },
                            }
                        )
                        + "\n"
                    )
                    return

            # Get retriever inline so we can process batches and yield progress
            from uuid import UUID

            from src.main.utils.config.loader import resolved_config, resolved_secrets
            from src.main.utils.documents.utils import get_user_retriever_with_fallback

            # Ensure retriever_manager is initialized
            # noinspection PyProtectedMember
            if retriever_manager._config is None:
                logger.info("Initializing retriever_manager for embedding storage")
                await retriever_manager.initialize(resolved_config, resolved_secrets)

            user_retriever_type = get_user_retriever_with_fallback(self._db, user_id)
            retriever = await retriever_manager.get_retriever(user_id, user_retriever_type)

            if not retriever:
                logger.warning("No retriever available for storing embeddings")
                return

            collection_uuids = [collection_id if isinstance(collection_id, UUID) else UUID(collection_id)]

            # Process documents in smaller batches with streaming progress
            total_docs = len(enriched_documents)
            batch_size = max(1, min(50, total_docs // 5))
            total_batches = (total_docs + batch_size - 1) // batch_size

            logger.info(
                "Storing %d document chunks in %d batches of %d",
                total_docs,
                total_batches,
                batch_size,
            )

            # Check if graph integration is enabled and we have necessary info
            graph_enabled = False
            if document_id and workspace_id and file_path:
                graph_config = resolved_config.get("graph", {})
                graph_enabled = graph_config.get("enabled", False)
                if graph_enabled:
                    logger.info("Graph integration enabled - will create Neo4j entities in parallel")

            _embed_start = time.time()
            for i in range(0, total_docs, batch_size):
                # Check if a job has been canceled before processing each batch
                if job_id:
                    job_status = document_job_manager.get_job_status(job_id, self._db)
                    if job_status and job_status.get("status") == JobStatus.CANCELLED:
                        logger.info("Job %s was cancelled, stopping embedding storage", job_id)
                        yield (
                            json.dumps(
                                {
                                    "type": "status",
                                    "content": {
                                        "progress": 0,
                                        "message": "cancelledByUser",
                                        "status": "cancelled",
                                    },
                                }
                            )
                            + "\n"
                        )
                        return

                batch = enriched_documents[i : i + batch_size]
                batch_num = (i // batch_size) + 1

                # Calculate progress (30% to 60%) - use batch_num for consistent 1% increments
                progress = min(30 + int((batch_num / total_batches) * 30), 59)
                message = f"Storing embeddings: batch {batch_num}/{total_batches} ({len(batch)} chunks)"

                # Update job manager
                if job_id:
                    await self._update_job_progress(job_id, progress, message)

                # Yield progress update to stream
                yield (
                    json.dumps(
                        {
                            "type": "status",
                            "content": {
                                "progress": progress,
                                "message": message,
                                "status": "processing",
                            },
                        }
                    )
                    + "\n"
                )

                # Store this batch in vector database (user's choice: pgvector/Qdrant/Pinecone)
                await retriever.add_documents(batch, collection_ids=collection_uuids)
                logger.debug(
                    "Stored batch %d/%d (%d chunks) in vector database",
                    batch_num,
                    total_batches,
                    len(batch),
                )

            # Record embed phase timing (background, no latency impact)
            _embed_duration = time.time() - _embed_start
            if job_id:
                _embed_meta = {"embedding_count": total_docs}
                if hasattr(self, "_embedding_model"):
                    _embed_meta["embedding_model"] = self._embedding_model
                document_job_manager.record_phase_timing(job_id, "embed", _embed_duration, _embed_meta)

            # Enrich documents with embedding UUIDs so Neo4j Chunk nodes use the same IDs
            # This ensures entity extraction can create Chunk→Entity relationships correctly
            if document_id and enriched_documents:
                try:
                    from sqlalchemy import text as sa_text

                    # noinspection PyUnresolvedReferences
                    emb_rows = self._db.execute(
                        sa_text(
                            """
                            SELECT id, (cmetadata->>'chunk_index')::int as chunk_index
                            FROM langchain_pg_embedding
                            WHERE cmetadata->>'document_id' = :doc_id
                            ORDER BY chunk_index
                        """
                        ),
                        {"doc_id": document_id},
                    ).fetchall()
                    # noinspection PyUnresolvedReferences
                    emb_id_map = {row.chunk_index: str(row.id) for row in emb_rows}
                    mapped_count = 0
                    for doc in enriched_documents:
                        ci = doc.metadata.get("chunk_index")
                        if ci is not None and ci in emb_id_map:
                            doc.metadata["chunk_id"] = emb_id_map[ci]
                            mapped_count += 1
                    total = len(enriched_documents)
                    if mapped_count > 0:
                        logger.info(
                            "Mapped %d/%d chunks to embedding UUIDs for Neo4j",
                            mapped_count,
                            total,
                        )
                    if mapped_count < total:
                        # Loud warning — un-mapped chunks would land in Neo4j with
                        # random UUIDs (or be skipped), creating orphan nodes that
                        # entity_pipeline can never link to.
                        unmapped = total - mapped_count
                        logger.warning(
                            "Failed to map %d/%d chunks to embedding UUIDs for document %s — "
                            "these chunks will be SKIPPED in Neo4j hierarchy. "
                            "Likely cause: chunk_index mismatch between enriched_documents and langchain_pg_embedding.",
                            unmapped,
                            total,
                            document_id,
                        )
                except Exception as uuid_map_err:
                    logger.warning("Failed to map embedding UUIDs to chunks: %s", str(uuid_map_err))

            # After all embeddings are stored, create Neo4j graph entities if enabled
            if graph_enabled:
                logger.info("Creating Neo4j graph entities (Step 1: book→chapter→section→paragraph)")
                # noinspection PyTypeChecker
                await self._update_job_progress(job_id, 60, "creatingGraphStructure")
                yield (
                    json.dumps(
                        {
                            "type": "status",
                            "content": {
                                "progress": 60,
                                "message": "creatingGraphStructure",
                                "status": "processing",
                            },
                        }
                    )
                    + "\n"
                )

                # Create graph entities with streaming progress updates
                # Pass user_id for LLM authentication during entity extraction
                # The function sets self._entity_extraction_dispatched to indicate if background task was started
                _graph_start = time.time()
                # noinspection PyTypeChecker
                async for graph_update in self._create_graph_entities(
                    document_id=document_id,
                    collection_id=collection_id,
                    workspace_id=workspace_id,
                    file_path=file_path,
                    enriched_documents=enriched_documents,
                    job_id=job_id,
                    user_id=user_id,
                ):
                    yield graph_update
                # Record graph phase timing (background, no latency impact)
                _graph_duration = time.time() - _graph_start
                if job_id:
                    document_job_manager.record_phase_timing(job_id, "graph", _graph_duration)
                # Note: Graph processing already set progress to 90%, don't reset it!
            else:
                # Only update to 60% if graph processing didn't run (which would set it to 90%)
                if job_id:
                    await self._update_job_progress(job_id, 60, "embeddingsStored")
                    yield (
                        json.dumps(
                            {
                                "type": "status",
                                "content": {
                                    "progress": 60,
                                    "message": "embeddingsStored",
                                    "status": "processing",
                                },
                            }
                        )
                        + "\n"
                    )

            logger.info("Successfully stored %d document chunks in vector database", total_docs)

        except Exception as ex:
            logger.error("Error storing embeddings: %s", str(ex))
            raise

    async def _get_document_metadata(self, document_id: str, file_path: str) -> dict[str, Any]:
        """Get document metadata for graph processing"""
        return await self._extract_document_metadata_core(document_id, file_path)

    async def _extract_document_metadata_core(self, document_id: str, file_path: str) -> dict[str, Any]:
        """
        Core logic for extracting document metadata - shared between async and sync methods.

        Args:
            document_id: Document identifier
            file_path: Path to the document file

        Returns:
            Dict containing document metadata
        """
        try:
            # Get document from a database
            # noinspection PyTypeChecker,PyUnresolvedReferences
            document = (
                # noinspection PyTypeChecker,PyUnresolvedReferences
                self._db.query(Document)
                # noinspection PyTypeChecker,PyUnresolvedReferences
                .filter(Document.id == document_id)
                .first()
            )

            metadata = {
                "id": document_id,
                "name": (getattr(document, "filename", None) if document else os.path.basename(file_path)),
                "file_path": file_path,
            }

            # Parse existing metadata if available
            if document and getattr(document, "file_metadata", None):
                try:
                    # Handle dict (PostgreSQL JSONB), string, and double-encoded JSON
                    doc_file_metadata = document.file_metadata
                    if isinstance(doc_file_metadata, dict):
                        existing_metadata = doc_file_metadata
                    else:
                        existing_metadata = json.loads(doc_file_metadata)
                        # Handle double-encoded JSON (string inside string)
                        if isinstance(existing_metadata, str):
                            existing_metadata = json.loads(existing_metadata)
                    metadata.update(existing_metadata)
                except (json.JSONDecodeError, TypeError):
                    logger.warning("Could not parse existing document metadata for %s", document_id)

            # CRITICAL FIX: Retrieve document_hierarchy for Neo4j chapter/section creation
            if document and hasattr(document, "document_hierarchy") and document.document_hierarchy:
                try:
                    # Handle both dict (PostgreSQL JSONB) and string (SQLite JSON)
                    if isinstance(document.document_hierarchy, dict):
                        metadata["document_hierarchy"] = document.document_hierarchy
                    else:
                        metadata["document_hierarchy"] = json.loads(document.document_hierarchy)
                    # noinspection PyTypeChecker
                    logger.debug(
                        "Retrieved document hierarchy for %s with %d top-level sections",
                        document_id,
                        len(metadata["document_hierarchy"]),
                    )
                except (json.JSONDecodeError, TypeError) as hierarchy_parse_err:
                    logger.warning("Could not parse document hierarchy for %s: %s", document_id, str(hierarchy_parse_err))

            # Extract PDF metadata if not present (with LLM enrichment for better title extraction)
            if file_path.lower().endswith(".pdf"):
                try:
                    # Get user_id from document for LLM enrichment
                    user_id = str(document.user_id) if document and hasattr(document, "user_id") else None

                    # Use extract_and_enrich_metadata for LLM-based title extraction
                    from src.main.service.metadata_extractor import metadata_extractor

                    # BUG FIX: await the async function to avoid asyncio.run() event loop conflict
                    pdf_metadata = await metadata_extractor.extract_and_enrich_metadata(
                        file_path=file_path,
                        content_sample=None,
                        db=self._db,
                        user_id=user_id,  # Will use extracted content from PDF
                    )
                    metadata.update(pdf_metadata)
                except Exception as pdf_meta_err:
                    logger.warning("Could not extract PDF metadata: %s", str(pdf_meta_err))

            return metadata

        except Exception as ex:
            logger.error("Error getting document metadata for %s: %s", document_id, str(ex))
            return {
                "id": document_id,
                "name": os.path.basename(file_path),
                "file_path": file_path,
            }

    def get_document_metadata_sync(self, document_id: str, file_path: str) -> dict[str, Any]:
        """
        Synchronous version of _get_document_metadata for use in worker tasks.

        Extracts metadata from DB without async LLM enrichment (which requires await).
        """
        try:
            # noinspection PyUnresolvedReferences
            document = (
                # noinspection PyUnresolvedReferences
                self._db.query(Document)
                # noinspection PyUnresolvedReferences
                # noinspection PyTypeChecker
                .filter(Document.id == document_id)
                .first()
            )

            metadata = {
                "id": document_id,
                "name": (getattr(document, "filename", None) if document else os.path.basename(file_path)),
                "file_path": file_path,
            }

            # Parse existing metadata if available
            if document and getattr(document, "file_metadata", None):
                try:
                    doc_file_metadata = document.file_metadata
                    if isinstance(doc_file_metadata, dict):
                        existing_metadata = doc_file_metadata
                    else:
                        existing_metadata = json.loads(doc_file_metadata)
                        if isinstance(existing_metadata, str):
                            existing_metadata = json.loads(existing_metadata)
                    metadata.update(existing_metadata)
                except (json.JSONDecodeError, TypeError):
                    logger.warning("Could not parse existing document metadata for %s", document_id)

            # Retrieve document_hierarchy for Neo4j chapter/section creation
            if document and hasattr(document, "document_hierarchy") and document.document_hierarchy:
                try:
                    if isinstance(document.document_hierarchy, dict):
                        metadata["document_hierarchy"] = document.document_hierarchy
                    else:
                        metadata["document_hierarchy"] = json.loads(document.document_hierarchy)
                    # noinspection PyTypeChecker
                    logger.debug(
                        "Retrieved document hierarchy for %s with %d top-level sections",
                        document_id,
                        len(metadata["document_hierarchy"]),
                    )
                except (json.JSONDecodeError, TypeError) as hierarchy_parse_err2:
                    logger.warning("Could not parse document hierarchy for %s: %s", document_id, str(hierarchy_parse_err2))

            return metadata

        except Exception as ex:
            logger.error("Error getting document metadata for %s: %s", document_id, str(ex))
            return {
                "id": document_id,
                "name": os.path.basename(file_path),
                "file_path": file_path,
            }

    def store_embeddings_sync(
        self, enriched_documents: list, collection_id: str, user_id: str, retriever_manager_instance=None, progress_callback=None
    ):
        """
        Synchronous version of _store_embeddings for use in worker tasks.

        Store embeddings in PgVector following the relational-graph boundary specification:
        "Insert scrapalot_embedding rows (uuid, collection_id, embedding, chunk_id)"

        This method runs in a synchronous context and uses asyncio.run() to execute
        the async retriever operations safely.

        Args:
            enriched_documents: List of enriched documents to store
            collection_id: Collection ID
            user_id: User ID
            retriever_manager_instance: RetrieverManager instance (required for worker context)
        """
        try:
            # Use centralized embedding storage utility
            from src.main.utils.documents.utils import store_embeddings_sync

            # If retriever_manager not provided, try to get a global instance (FastAPI context)
            effective_retriever_manager = retriever_manager_instance
            if effective_retriever_manager is None:
                from src.main.service.retriever.retriever_manager import retriever_manager as global_retriever_manager

                effective_retriever_manager = global_retriever_manager

            store_embeddings_sync(
                enriched_documents=enriched_documents,
                collection_id=collection_id,
                _user_id=user_id,
                db=self._db,
                _retriever_manager=effective_retriever_manager,
                progress_callback=progress_callback,
            )

        except Exception as ex:
            logger.error("Error storing embeddings: %s", str(ex))
            raise

    def _handle_document_processing_error(self, exc: Exception, job_id: str = None, context: str = "processing") -> str:
        """
        Handle document processing errors with consistent logging and job completion.

        Args:
            exc: The exception that occurred
            job_id: Optional job ID to complete with failure status
            context: Context string for an error message (e.g., "background", "stream")

        Returns:
            str: JSON formatted error response
        """
        error_msg = f"Error in document {context} processing: {exc!s}"
        logger.exception(error_msg)

        if job_id:
            document_job_manager.complete_job(
                job_id,
                success=False,
                message=error_msg,
                error_details=str(exc),
                db=self._db,
            )

        return json.dumps({"type": "error", "content": {"detail": error_msg}}) + "\n"

    async def _get_workspace_for_collection(self, collection_id: str, user_id: str) -> dict[str, Any] | None:
        """
        Get workspace information for a collection with ACL validation.
        This implements the ACL enforcement as specified in the relational-graph boundary:
        "Validate user's workspace ACL (SQL)"

        Args:
            collection_id: Collection ID
            user_id: User ID

        Returns:
            Dictionary with workspace info or None if found/no access
        """
        return self._get_workspace_for_collection_core(collection_id, user_id)

    def _get_workspace_for_collection_core(self, collection_id: str, user_id: str) -> dict[str, Any] | None:
        """
        Core logic for getting workspace information for a collection with ACL validation.
        This implements the ACL enforcement as specified in the relational-graph boundary:
        "Validate user's workspace ACL (SQL)"

        Args:
            collection_id: Collection ID
            user_id: User ID

        Returns:
            Dictionary with workspace info or None if found/no access
        """
        try:
            query = text(
                """
                SELECT workspace_id, workspace_name
                FROM collection_workspace_map
                WHERE collection_id = :collection_id
                AND owner_user_id = :user_id
            """
            )

            # noinspection PyUnresolvedReferences
            result = self._db.execute(query, {"collection_id": collection_id, "user_id": user_id}).fetchone()

            if result:
                # noinspection PyUnresolvedReferences
                return {
                    "workspace_id": str(result.workspace_id),
                    "workspace_name": result.workspace_name,
                    "user_role": "owner",
                }

            return None

        except Exception as ex:
            logger.error("Error getting workspace for collection %s: %s", collection_id, str(ex))
            return None

    def get_workspace_for_collection_sync(self, collection_id: str, user_id: str) -> dict[str, Any] | None:
        """
        Synchronous version of _get_workspace_for_collection for use in worker tasks.

        Get workspace information for a collection with ACL validation.
        This implements the ACL enforcement as specified in the relational-graph boundary:
        "Validate user's workspace ACL (SQL)"
        """
        return self._get_workspace_for_collection_core(collection_id, user_id)

    async def _setup_document_processing(
        self,
        collection_id: str,
        user_id: str,
        job_id: str,
        initial_progress: int = 0,
        complete_job_on_error: bool = False,
    ):
        """
        Setup document processing with workspace ACL validation and initial progress updates.

        Args:
            collection_id: Collection identifier
            user_id: User identifier
            job_id: Job identifier for progress tracking
            initial_progress: Starting progress percentage
            complete_job_on_error: Whether to complete a job on ACL validation error

        Yields:
            JSON strings with progress updates or error messages
        """
        # Get workspace information for ACL validation
        workspace_info = await self._get_workspace_for_collection(collection_id, user_id)
        if not workspace_info:
            error_msg = "errorWorkspacePermission"
            logger.error("Workspace ACL denied for collection %s user %s", collection_id, user_id)
            if complete_job_on_error and job_id:
                document_job_manager.complete_job(job_id, success=False, message=error_msg, db=self._db)
            yield json.dumps({"type": "error", "content": {"detail": error_msg}}) + "\n"
            return

        workspace_id = workspace_info["workspace_id"]

        # Update progress: Starting processing (continue from where file upload left off at 10%)
        start_progress = max(initial_progress, 10)
        await self._update_job_progress(job_id, start_progress, "startingProcessing")
        yield (
            json.dumps(
                {
                    "type": "status",
                    "content": {
                        "progress": start_progress,
                        "message": "startingProcessing",
                        "status": "processing",
                    },
                }
            )
            + "\n"
        )

        # Step 1: Extract text and parse document (progress should increase, not decrease)
        parse_progress = max(start_progress + 2, 12)  # Ensure it's higher than start_progress (10% + 2% = 12%)
        await self._update_job_progress(job_id, parse_progress, "extractingText")
        yield (
            json.dumps(
                {
                    "type": "status",
                    "content": {
                        "progress": parse_progress,
                        "message": "extractingText",
                        "status": "processing",
                    },
                }
            )
            + "\n"
        )

        # Yield the setup results as a special message
        yield (
            json.dumps(
                {
                    "type": "setup_complete",
                    "content": {
                        "workspace_id": str(workspace_id),
                        "parse_progress": parse_progress,
                    },
                }
            )
            + "\n"
        )

    async def _process_metadata_and_embeddings(
        self,
        documents: list,
        collection_id: str,
        user_id: str,
        document_id: str,
        job_id: str,
        initial_progress: int = 0,
        workspace_id: str = None,
        file_path: str = None,
    ):
        """
        Process document metadata enrichment and embedding storage with progress updates.

        If workspace_id and file_path are provided and graph is enabled, Neo4j entities
        (book→chapter→section→paragraph) will be created during embedding storage.

        Args:
            documents: List of processed documents
            collection_id: Collection identifier
            user_id: User identifier
            document_id: Document identifier
            job_id: Job identifier for progress tracking
            initial_progress: Starting progress percentage
            workspace_id: Optional workspace ID for graph integration
            file_path: Optional file path for graph metadata

        Yields:
            JSON strings with progress updates during metadata and embedding processing

        Side Effects:
            Sets self._entity_extraction_dispatched if background task is dispatched
        """
        # Step 2: Enrich documents with metadata (skip progress update if already at 30%)
        metadata_progress = max(initial_progress, 30)
        if metadata_progress <= 30:
            await self._update_job_progress(job_id, 30, "enrichingMetadata")
            yield (
                json.dumps(
                    {
                        "type": "status",
                        "content": {
                            "progress": 30,
                            "message": "enrichingMetadata",
                            "status": "processing",
                        },
                    }
                )
                + "\n"
            )

        _chunk_start = time.time()
        enriched_documents = self.enrich_documents_with_metadata(documents, collection_id, user_id, document_id)
        _chunk_duration = time.time() - _chunk_start
        self._enriched_documents = enriched_documents

        # Record chunk phase timing (background, no latency impact)
        if job_id:
            _chunk_meta = {"chunk_count": len(enriched_documents)}
            if hasattr(self, "_chunking_strategy"):
                _chunk_meta["chunking_strategy"] = self._chunking_strategy
            document_job_manager.record_phase_timing(job_id, "chunk", _chunk_duration, _chunk_meta)

        # Update total chunks count in job status (after enrichment completes)
        if job_id:
            document_job_manager.jobs[job_id]["total_chunks"] = len(enriched_documents)
            logger.debug("Updated job %s with total_chunks=%d", job_id, len(enriched_documents))

        # Step 3: Store embeddings in vector database (30-60% range)
        # If graph is enabled, Neo4j entities are created in parallel
        await self._update_job_progress(job_id, 30, "storingEmbeddings")
        yield (
            json.dumps(
                {
                    "type": "status",
                    "content": {
                        "progress": 30,
                        "message": "storingEmbeddings",
                        "status": "processing",
                    },
                }
            )
            + "\n"
        )

        # Store embeddings with streaming progress updates
        # Pass workspace_id and file_path for graph integration if available
        # This sets self._entity_extraction_dispatched if background task is dispatched
        async for update in self._store_embeddings_with_progress(
            enriched_documents,
            collection_id,
            user_id,
            job_id,
            document_id=document_id,
            workspace_id=workspace_id,
            file_path=file_path,
        ):
            yield update

        # Signal completion
        yield (
            json.dumps(
                {
                    "type": "enriched_documents_complete",
                    "content": {"enriched_documents": "processed"},
                }
            )
            + "\n"
        )
