import asyncio
from datetime import UTC, datetime
import gc
import hashlib
import json
import os
import time
import uuid
from uuid import UUID

# noinspection PyPep8Naming
from xml.etree import ElementTree as ET
import zipfile

from fastapi import File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from sqlalchemy import text
from sqlmodel import Session as SQLModelSession
from sqlmodel import select

from src.main.config.database import SessionLocal
from src.main.dto.documents import DocumentDTO, ThumbnailInfo
from src.main.models.encoders import enhanced_json_encoder
from src.main.models.sqlmodel_models import Document, ReadingPosition

# DocumentService imported lazily in functions to avoid startup delays
from src.main.utils.auth.jwt import User
from src.main.utils.core.logger import get_logger
from src.main.utils.database.db_utils import execute_db_operation
from src.main.utils.documents.utils import cleanup_file, get_upload_path, is_valid_document_type, sanitize_filename
from src.main.utils.websocket.manager import websocket_manager
from src.main.utils.workspaces.access import can_user_modify_collection, get_workspace_owner_for_collection
from src.main.utils.workspaces.quota import check_memory_only_quota, check_storage_quota

# Pre-initialize the WebSocketManager by accessing the singleton
# This forces initialization at module import time
# noinspection PyUnusedName
_ = websocket_manager

logger = get_logger(__name__)


def get_document_service(db: SQLModelSession = None):
    """Get DocumentService instance lazily to avoid startup delays from heavy ML library imports."""
    # noinspection PyUnresolvedReferences
    from src.main.service.document.documents import DocumentService

    # noinspection PyUnresolvedReferences
    return DocumentService.get_instance(db)


# Lazy initialization to avoid startup delays from pydot/Neo4j imports
# graph_integration_service = GraphIntegrationService.get_instance()


def get_graph_integration_service():
    """(CE) Knowledge graph is a hosted-only feature — no graph integration here."""
    raise RuntimeError("Knowledge graph integration is available in the hosted edition only.")


def validate_docx_structure(file_path: str) -> tuple[bool, str | None]:
    """
    Validate DOCX ZIP structure and critical XML files.

    This validation prevents docx-preview library crashes caused by malformed
    DOCX files with missing or empty _rels/.rels files.

    Args:
        file_path: Absolute path to the DOCX file

    Returns:
        A tuple of (is_valid, error_message)
        - is_valid: True if the DOCX structure is valid, False otherwise
        - error_message: None if valid, otherwise describes the validation error
    """
    try:
        with zipfile.ZipFile(file_path, "r") as z:
            # Check for required files
            required_files = ["_rels/.rels", "[Content_Types].xml"]

            for req_file in required_files:
                if req_file not in z.namelist():
                    return False, f"Missing required file: {req_file}"

            # Validate _rels/.rels XML structure
            try:
                rels_content = z.read("_rels/.rels")
                if not rels_content or len(rels_content.strip()) == 0:
                    return False, "_rels/.rels is empty"

                # Parse XML
                root = ET.fromstring(rels_content)

                # Check for root element
                if root is None or root.tag is None:
                    return False, "_rels/.rels has no root element"

                # Check for Relationships tag
                if not root.tag.endswith("Relationships"):
                    return False, f"_rels/.rels has invalid root tag: {root.tag}"

                # Check for at least one Relationship child
                relationships = root.findall(".//{*}Relationship")
                if len(relationships) == 0:
                    return False, "_rels/.rels has no Relationship entries"

            except ET.ParseError as e:
                return False, f"_rels/.rels XML parse error: {e!s}"

            # Validate [Content_Types].xml
            try:
                content_types = z.read("[Content_Types].xml")
                if not content_types or len(content_types.strip()) == 0:
                    return False, "[Content_Types].xml is empty"

                ct_root = ET.fromstring(content_types)
                if ct_root is None:
                    return False, "[Content_Types].xml has no root element"

            except ET.ParseError as e:
                return False, f"[Content_Types].xml XML parse error: {e!s}"

        return True, None

    except zipfile.BadZipFile:
        return False, "File is not a valid ZIP archive"
    except Exception as e:
        return False, f"Unexpected validation error: {e!s}"


# noinspection PyDeprecation
def _cleanup_failed_document_upload(
    file_path: str,
    document_id: str,
    db: SQLModelSession,
    error_message: str,
    use_rollback: bool = False,
) -> str:
    """
    Clean up uploaded file, embeddings, graph nodes, and database record when document processing fails.

    Args:
        file_path: Path to the uploaded file to delete
        document_id: ID of the document record to remove from database
        db: Database session
        error_message: Base error message to include in response
        use_rollback: If True, use rollback (for uncommitted records).
        If False, use DELETE (for committed records)

    Returns:
        JSON string with error response including cleanup status

    Cleanup Steps:
        1. Delete an uploaded file from the filesystem
        2. Remove embeddings from the vector store (pgvector)
        3. Delete graph nodes from Neo4j (if enabled)
        4. Remove database record (rollback or delete)
    """
    cleanup_performed = False

    # Clean up the uploaded file
    if file_path and os.path.exists(file_path):
        try:
            # Force garbage collection to release file handles
            gc.collect()

            # Try immediate deletion first
            try:
                os.unlink(file_path)
                logger.info("Cleaned up uploaded file: %s", file_path)
                cleanup_performed = True
            except (OSError, PermissionError) as e:
                # File might be locked, try with a short delay
                logger.warning("File deletion failed, retrying after delay: %s", e)
                time.sleep(0.5)
                try:
                    os.unlink(file_path)
                    logger.info("Cleaned up uploaded file after retry: %s", file_path)
                    cleanup_performed = True
                except (OSError, PermissionError) as retry_error:
                    # If still failing, try to mark for deletion on reboot (Windows)
                    logger.error("Failed to clean up uploaded file %s: %s", file_path, retry_error)
                    if os.name == "nt":  # Windows
                        try:
                            import win32api
                            import win32con

                            win32api.MoveFileEx(file_path, "", win32con.MOVEFILE_DELAY_UNTIL_REBOOT)
                            logger.info("Marked file for deletion on reboot: %s", file_path)
                        except ImportError:
                            win32api = None
                            win32con = None
                            logger.warning("Could not mark file for delayed deletion (win32api not available): %s", file_path)
                        except Exception as win_error:
                            logger.warning("Could not mark file for delayed deletion: %s", win_error)
        except Exception as cleanup_error:
            logger.error("Unexpected error during file cleanup %s: %s", file_path, cleanup_error)

    # Handle database cleanup based on the transaction state
    if document_id:
        try:
            # First, ALWAYS clean up any embeddings that might have been stored
            # Embeddings can be committed even if the document record is not yet committed
            try:
                # Import DB_TYPE to check the database type
                from src.main.config.database import DB_TYPE

                if DB_TYPE == "postgresql":
                    # PostgreSQL: Use JSONB operator to query metadata
                    embedding_delete_query = text(
                        """
                        DELETE FROM langchain_pg_embedding
                        WHERE cmetadata->>'document_id' = :document_id
                    """
                    )
                    # Raw SQL requires execute(), not exec() - exec() is only for SQLModel select()
                    # noinspection PyTypeChecker
                    result = db.execute(embedding_delete_query, {"document_id": document_id})
                    deleted_embeddings = result.rowcount if hasattr(result, "rowcount") else 0
                    if deleted_embeddings > 0:
                        logger.info("Cleaned up %s embeddings for document: %s", deleted_embeddings, document_id)
                    # Note: Don't commit here if we're going to roll back - it would commit the document too!
                elif DB_TYPE == "sqlite":
                    # SQLite: Use JSON_EXTRACT function to query metadata
                    embedding_delete_query = text(
                        """-- noinspection SqlResolveForFile @ routine/"JSON_EXTRACT"

                    DELETE
                    FROM langchain_pg_embedding
                    WHERE JSON_EXTRACT(cmetadata, '$.document_id') = :document_id
                                                  """
                    )
                    # Raw SQL requires execute(), not exec() - exec() is only for SQLModel select()
                    # noinspection PyTypeChecker
                    result = db.execute(embedding_delete_query, {"document_id": document_id})
                    deleted_embeddings = result.rowcount if hasattr(result, "rowcount") else 0
                    if deleted_embeddings > 0:
                        logger.info("Cleaned up %s embeddings for document: %s", deleted_embeddings, document_id)
                    # Note: Don't commit here if we're going to roll back - it would commit the document too!
                else:
                    logger.debug("Unknown database type '%s' - skipping embedding cleanup", DB_TYPE)

            except Exception as embedding_error:
                logger.warning("Failed to clean up embeddings for document %s: %s", document_id, embedding_error)
                # Continue with document cleanup even if embedding cleanup fails

            # Clean up graph nodes (Neo4j) if they exist
            try:
                import asyncio

                # Try to run async graph cleanup
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    # If we're in an async context, schedule the task
                    asyncio.create_task(_delete_document_graph_nodes(document_id))
                    logger.info("Scheduled graph node cleanup for document: %s", document_id)
                else:
                    # If no event loop is running, run synchronously
                    loop.run_until_complete(_delete_document_graph_nodes(document_id))
                    logger.info("Cleaned up graph nodes for document: %s", document_id)
            except Exception as graph_error:
                logger.warning("Failed to clean up graph nodes for document %s: %s", document_id, graph_error)
                # Continue with document cleanup even if graph cleanup fails

            # Then handle document record cleanup based on the transaction state
            if use_rollback:
                # For uncommitted records, use rollback
                db.rollback()
                logger.info("Rolled back database transaction: %s", document_id)
                cleanup_performed = True
            else:
                # For committed records, use DELETE
                # Raw SQL requires execute(), not exec()
                # noinspection PyTypeChecker
                db.execute(
                    text("DELETE FROM documents WHERE id = :document_id"),
                    {"document_id": document_id},
                )
                db.commit()
                logger.info("Removed document record from database: %s", document_id)
                cleanup_performed = True
        except Exception as db_error:
            logger.error("Failed to clean up document record %s: %s", document_id, db_error)
            # Roll back any partial transaction
            db.rollback()

    # Prepare error response with cleanup information
    cleanup_method = "Transaction rolled back" if use_rollback else "Database record deleted"
    cleanup_msg = f" {cleanup_method} and uploaded file cleaned up." if cleanup_performed else ""

    return (
        json.dumps(
            {
                "type": "error",
                "content": {
                    "detail": error_message + cleanup_msg,
                    "cleanup_performed": cleanup_performed,
                    "document_id": document_id if document_id else None,
                },
            }
        )
        + "\n"
    )


# =============================================================================
# DOCX PREVIEW ENDPOINT
# =============================================================================
# IMPORTANT: This must be BEFORE /{document_id}/file route for proper matching


async def get_docx_preview(
    document_id: str,
    current_user: User,
    db: SQLModelSession,
):
    """
    Get a DOCX document as an HTML preview using Docling.

    Args:
        document_id: The document UUID
        current_user: Current authenticated user
        db: Database session

    Returns:
        JSON response with HTML content
    """
    try:
        # Verify access and get document
        document, full_path = _verify_document_access(document_id, current_user, db)

        # Verify it's a DOCX file
        if not document.file_path.lower().endswith(".docx"):
            raise HTTPException(status_code=400, detail="Document is not a DOCX file")

        # Check if file exists
        if not os.path.exists(full_path):
            raise HTTPException(status_code=404, detail="File not found")

        # Process DOCX with Docling
        from src.main.service.document.document_processor_docx import DOCXProcessor

        logger.info("Processing DOCX for preview: %s", document_id)
        langchain_docs = DOCXProcessor.process_docx(
            file_path=full_path,
            relative_file_path=document.file_path,
        )

        if not langchain_docs or not langchain_docs[0].page_content:
            raise HTTPException(status_code=500, detail="Failed to extract content from DOCX")

        # Convert markdown to HTML
        try:
            # noinspection PyUnresolvedReferences
            import markdown

            markdown_content = langchain_docs[0].page_content
            html_content = markdown.markdown(markdown_content, extensions=["tables", "fenced_code", "toc"])
        except ImportError:
            # Fallback: wrap markdown in <pre> tags
            logger.warning("markdown library not available, using fallback HTML rendering")
            markdown_content = langchain_docs[0].page_content
            html_content = f"<pre>{markdown_content}</pre>"

        return JSONResponse(
            content={
                "html": html_content,
                "metadata": langchain_docs[0].metadata,
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error generating DOCX preview %s: %s", document_id, str(e))
        raise HTTPException(status_code=500, detail=f"Error generating preview: {e!s}") from e


async def get_docx_preview_mammoth(
    document_id: str,
    current_user: User,
    db: SQLModelSession,
):
    """
    Get a DOCX document as an HTML preview using the Python Mammoth library.

    Mammoth preserves better formatting than Docling (fonts, colors, tables).
    This is the preferred method for DOCX rendering.

    Args:
        document_id: The document UUID
        current_user: Current authenticated user
        db: Database session

    Returns:
        JSON response with HTML content
    """
    try:
        # Verify access and get document
        document, full_path = _verify_document_access(document_id, current_user, db)

        # Verify it's a DOCX file
        if not document.file_path.lower().endswith(".docx"):
            raise HTTPException(status_code=400, detail="Document is not a DOCX file")

        # Check if file exists
        if not os.path.exists(full_path):
            raise HTTPException(status_code=404, detail="File not found")

        # Convert DOCX to HTML with Python Mammoth
        try:
            # noinspection PyUnresolvedReferences
            import mammoth

            logger.info("Processing DOCX with Mammoth: %s", document_id)

            # Read DOCX file and convert to HTML
            with open(full_path, "rb") as docx_file:
                result = mammoth.convert_to_html(docx_file)
                html_content = result.value  # The generated HTML
                messages = result.messages  # Any conversion warnings

            # Log warnings if any
            if messages:
                logger.warning("Mammoth conversion warnings for %s: %s", document_id, messages)

            if not html_content or not html_content.strip():
                raise HTTPException(status_code=500, detail="Failed to extract content from DOCX")

            logger.info("DOCX converted successfully with Mammoth. HTML length: %d", len(html_content))

            return JSONResponse(
                content={
                    "html": html_content,
                    "warnings": [str(msg) for msg in messages],
                    "metadata": {
                        "source": document.file_path,
                        "file_type": "docx",
                        "processing_method": "mammoth",
                    },
                }
            )

        except ImportError:
            logger.error("Mammoth library not installed")
            raise HTTPException(status_code=500, detail="Mammoth library not available. Please install: pip install mammoth") from None

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to generate DOCX preview with Mammoth: %s", str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


# noinspection PyUnusedFunction,PyShadowingNames,PyUnusedLocal
async def serve_document_file(
    document_id: str,
    current_user: User,
    db: SQLModelSession,
):
    """
    Serve a document file for viewing/download by document ID.

    Args:
        document_id: The document UUID to serve
        current_user: Current authenticated user
        db: Database session

    Returns:
        FileResponse: The requested file
    """
    try:
        # Validate UUID format
        try:
            UUID(document_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid document ID format") from None

        # Fetch document from database by ID
        document = db.exec(select(Document).where(Document.id == document_id)).first()

        if not document:
            raise HTTPException(status_code=404, detail="Document not found")

        # Verify the user has access to this document's collection via cache table
        # noinspection PyTypeChecker, PyDeprecationWarning, PyDeprecationInspection
        cwm_row = db.execute(
            text("SELECT workspace_id, owner_user_id FROM collection_workspace_map WHERE collection_id = :cid"),
            {"cid": str(document.collection_id)},
        ).fetchone()
        if not cwm_row:
            raise HTTPException(status_code=404, detail="Collection not found")

        # Check workspace ownership (shared access is managed by Kotlin backend)
        is_workspace_owner = str(cwm_row.owner_user_id) == str(current_user.id)

        # Debug logging
        logger.debug(
            "Document access check - Document ID: %s, User ID: %s, Workspace ID: %s, Workspace Owner ID: %s, Is Owner: %s",
            document_id,
            current_user.id,
            cwm_row.workspace_id,
            cwm_row.owner_user_id,
            is_workspace_owner,
        )

        if not is_workspace_owner:
            logger.warning(
                "Access denied - User %s is neither member nor owner of workspace %s",
                current_user.id,
                cwm_row.workspace_id,
            )
            raise HTTPException(status_code=403, detail="Access denied to this document")

        # Get the file path from the document and ensure it's a string
        file_path = str(document.file_path)

        # Normalize path separators for cross-platform compatibility
        normalized_path = file_path.replace("\\", "/")

        # Security check - ensure the file path is within allowed directories
        # For absolute paths, extract the relative portion first
        from src.main.utils.files.paths import extract_relative_upload_path

        # Try to extract a relative path from an absolute path
        relative_path = extract_relative_upload_path(file_path)
        if relative_path:
            # Use the extracted relative path for a security check
            check_path = relative_path
        else:
            # Use the original path for a security check
            check_path = normalized_path

        # Include absolute paths for Docker container environment (/app/data/upload/)
        allowed_prefixes = ("data/upload/", "uploads/", "/app/data/upload/", "/data/upload/")
        is_allowed = check_path.startswith(allowed_prefixes)

        if not is_allowed:
            logger.warning(
                "Access denied - File path '%s' (normalized: '%s', extracted: '%s') is not in allowed directories",
                file_path,
                normalized_path,
                relative_path if relative_path else "none",
            )
            raise HTTPException(status_code=403, detail="Access denied to file path")

        # Construct the full file path
        # Use relative_path if extracted, otherwise use file_path
        path_to_use = relative_path if relative_path else file_path
        full_path = os.path.join(os.getcwd(), path_to_use)

        # Ensure full_path is a string for FileResponse
        full_path_str = str(full_path)

        # Check if the file exists
        if not os.path.exists(full_path_str):
            raise HTTPException(status_code=404, detail="File not found")

        # Validate DOCX structure before serving
        file_extension = os.path.splitext(full_path_str)[1].lower()
        if file_extension == ".docx":
            is_valid, error_msg = validate_docx_structure(full_path_str)

            if not is_valid:
                logger.warning("Invalid DOCX structure for document %s: %s", document_id, error_msg)

                # Return HTTP 400 with detailed error message
                raise HTTPException(status_code=400, detail=f"Invalid DOCX file structure: {error_msg}")

        # Determine media type based on file extension
        media_type_map = {
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
        media_type = media_type_map.get(file_extension, "application/octet-stream")

        # Return the file with the correct media type
        return FileResponse(
            path=full_path_str,
            media_type=media_type,
            headers={"Content-Disposition": f"inline; filename={os.path.basename(full_path_str)}"},
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error serving document %s: %s", document_id, str(e))
        raise HTTPException(status_code=500, detail="Error serving file") from e


# =============================================================================
# THUMBNAIL ENDPOINTS
# =============================================================================


def _verify_document_access(
    document_id: str,
    current_user: User,
    db: SQLModelSession,
) -> tuple[Document, str]:
    """
    Verify the user has access to a document and return a document with a full file path.

    Args:
        document_id: The document UUID
        current_user: Current authenticated user
        db: Database session

    Returns:
        Tuple of (Document, full_file_path)

    Raises:
        HTTPException: If validation fails or access is denied
    """
    # Validate UUID format
    try:
        UUID(document_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid document ID format") from None

    # Fetch document from database
    document = db.exec(select(Document).where(Document.id == document_id)).first()
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")

    # Verify access to collection and workspace via cache table
    # noinspection PyTypeChecker, PyDeprecationWarning, PyDeprecationInspection
    cwm_row = db.execute(
        text("SELECT workspace_id, owner_user_id FROM collection_workspace_map WHERE collection_id = :cid"),
        {"cid": str(document.collection_id)},
    ).fetchone()
    if not cwm_row:
        raise HTTPException(status_code=404, detail="Collection not found")

    # Check workspace ownership (shared access is managed by Kotlin backend)
    is_workspace_owner = str(cwm_row.owner_user_id) == str(current_user.id)

    if not is_workspace_owner:
        raise HTTPException(status_code=403, detail="Access denied to this document")

    # Construct a full file path
    file_path = str(document.file_path)
    full_path = os.path.join(os.getcwd(), file_path)

    return document, full_path


# noinspection PyUnusedFunction
async def serve_document_thumbnail(
    document_id: str,
    db: SQLModelSession,
    size: str = "medium",
):
    """
    Serve a document's thumbnail image (public endpoint).

    If the thumbnail doesn't exist, it will be generated on-demand for PDF files.
    This endpoint is public to allow thumbnails to work in <img> tags without auth.

    Args:
        document_id: The document UUID
        size: Thumbnail size (small, medium, large). Default: medium
        db: Database session

    Returns:
        FileResponse: The thumbnail image
    """
    from uuid import UUID

    from src.main.models.sqlmodel_models import Document
    from src.main.service.document.thumbnail_service import ThumbnailService

    # Validate size parameter
    if size not in ThumbnailService.THUMBNAIL_SIZES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid size. Must be one of: {', '.join(ThumbnailService.THUMBNAIL_SIZES.keys())}",
        )

    try:
        # Get document (public access - just verify it exists)
        document = db.exec(select(Document).where(Document.id == UUID(document_id))).first()
        if not document:
            raise HTTPException(status_code=404, detail="Document not found")

        # Construct a full file path
        file_path = str(document.file_path)
        full_path = os.path.join(os.getcwd(), file_path)

        # Get a thumbnail path
        thumb_path = ThumbnailService.get_thumbnail_path(full_path, size)

        # Legacy placeholder cleanup: pre-fix uploads copied the PDF-icon
        # asset onto disk as a "thumbnail" so the UI never showed an empty
        # box. We now want the FE to render its title-card fallback in that
        # case, so any byte-identical placeholder PNG translates to 404.
        if os.path.exists(thumb_path) and ThumbnailService.is_placeholder_thumbnail(thumb_path):
            raise HTTPException(status_code=404, detail="Thumbnail not available")

        # If a thumbnail doesn't exist, try to generate it on-demand
        if not os.path.exists(thumb_path):
            if ThumbnailService.can_generate_thumbnail(full_path):
                ext = os.path.splitext(full_path.lower())[1]
                if ext in ThumbnailService.SUPPORTED_EPUB_EXTENSIONS:
                    generated_path = ThumbnailService.generate_epub_thumbnail(full_path, size=size)
                else:
                    generated_path = ThumbnailService.generate_pdf_thumbnail(full_path, size=size)
                if not generated_path:
                    # Real render failed (encryption, corruption, unsupported
                    # format). Return 404 — the FE renders its title-card
                    # fallback rather than a generic PDF icon.
                    raise HTTPException(status_code=404, detail="Could not generate thumbnail (file may be encrypted or corrupted)")
                thumb_path = generated_path

                # Update document metadata to reflect thumbnail generation (only if successful)
                try:
                    metadata = ThumbnailService.get_thumbnail_metadata(full_path)
                    if metadata.get("has_thumbnail"):
                        doc_metadata = document.file_metadata if isinstance(document.file_metadata, dict) else {}
                        if document.file_metadata and isinstance(document.file_metadata, str):
                            try:
                                doc_metadata = json.loads(document.file_metadata)
                            except (json.JSONDecodeError, ValueError):
                                doc_metadata = {}
                        doc_metadata["thumbnail"] = {
                            "has_thumbnail": True,
                            "has_custom": False,
                            "sizes": metadata["available_sizes"],
                        }
                        # Force SQLAlchemy to track the mutation by reassigning
                        from sqlalchemy.orm.attributes import flag_modified

                        document.file_metadata = doc_metadata
                        flag_modified(document, "file_metadata")
                        db.commit()
                        db.refresh(document)  # Refresh to ensure latest state
                        logger.info("Updated thumbnail metadata for document %s", document_id)
                except Exception as e:
                    logger.warning("Failed to update thumbnail metadata: %s", str(e), exc_info=True)
                    # Continue serving the thumbnail even if the metadata update fails
            elif ThumbnailService.is_image_file(full_path):
                # For image files, serve the original file as a thumbnail
                return FileResponse(
                    path=full_path,
                    media_type="image/png",
                    headers={"Cache-Control": "max-age=86400"},
                )
            else:
                raise HTTPException(status_code=404, detail="Thumbnail not available for this file type")

        return FileResponse(
            path=thumb_path,
            media_type="image/png",
            headers={"Cache-Control": "max-age=86400"},  # Cache for 24 hours
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error serving thumbnail for %s: %s", document_id, str(e))
        raise HTTPException(status_code=500, detail="Error serving thumbnail") from e


# noinspection PyUnusedFunction
async def upload_custom_thumbnail(
    document_id: str,
    current_user: User,
    db: SQLModelSession,
    file: UploadFile = File(...),
):
    """
    Upload a custom thumbnail for a document.

    This allows users to provide their own cover image instead of the auto-generated one.

    Args:
        document_id: The document UUID
        file: The uploaded image file (PNG, JPEG, or WebP)
        current_user: Current authenticated user
        db: Database session

    Returns:
        JSON with success status and thumbnail info
    """
    from src.main.service.document.thumbnail_service import ThumbnailService

    try:
        # Verify document access
        document, full_path = _verify_document_access(document_id, current_user, db)

        # Validate a file type
        content_type = file.content_type
        if content_type not in ["image/png", "image/jpeg", "image/webp"]:
            raise HTTPException(
                status_code=400,
                detail="Invalid image type. Use PNG, JPEG, or WebP.",
            )

        # Read the uploaded file
        image_data = await file.read()

        # Validate file size (max 5MB)
        if len(image_data) > 5 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="Image too large. Maximum size is 5MB.")

        # Save custom thumbnails for all sizes
        results = ThumbnailService.save_custom_thumbnail_all_sizes(full_path, image_data)

        # Check if at least one size was saved
        if not any(results.values()):
            raise HTTPException(status_code=500, detail="Failed to save thumbnail")

        # Update the document file_metadata with thumbnail info
        # Handle case where file_metadata might be a JSON string
        existing_metadata = document.file_metadata
        if isinstance(existing_metadata, str):
            try:
                metadata = json.loads(existing_metadata)
            except (json.JSONDecodeError, TypeError):
                metadata = {}
        else:
            metadata = existing_metadata or {}

        metadata["thumbnail"] = {
            "has_custom": True,
            "updated_at": datetime.now(UTC).isoformat(),
            "sizes": list(results.keys()),
        }
        document.file_metadata = metadata
        db.commit()

        return {
            "success": True,
            "message": "Custom thumbnail uploaded successfully",
            "thumbnail": metadata["thumbnail"],
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error uploading thumbnail for %s: %s", document_id, str(e))
        raise HTTPException(status_code=500, detail="Error uploading thumbnail") from e


# noinspection PyUnusedFunction
async def delete_custom_thumbnail(
    document_id: str,
    current_user: User,
    db: SQLModelSession,
):
    """
    Delete a custom thumbnail and regenerate from the PDF cover.

    This removes the custom thumbnail and allows the auto-generated one to be used.

    Args:
        document_id: The document UUID
        current_user: Current authenticated user
        db: Database session

    Returns:
        JSON with success status
    """
    from src.main.service.document.thumbnail_service import ThumbnailService

    try:
        # Verify document access
        document, full_path = _verify_document_access(document_id, current_user, db)

        # Delete all thumbnail files
        deleted = ThumbnailService.delete_thumbnails(full_path)

        # Update document metadata
        metadata = document.file_metadata or {}
        if "thumbnail" in metadata:
            metadata["thumbnail"]["has_custom"] = False
            metadata["thumbnail"]["deleted_at"] = datetime.now(UTC).isoformat()
            document.file_metadata = metadata
            db.commit()

        # Regenerate from PDF if applicable
        regenerated = False
        if ThumbnailService.can_generate_thumbnail(full_path):
            results = ThumbnailService.generate_all_thumbnails(full_path)
            regenerated = any(results.values())

        return {
            "success": True,
            "message": "Custom thumbnail deleted" + (" and regenerated from PDF" if regenerated else ""),
            "deleted": deleted,
            "regenerated": regenerated,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error deleting thumbnail for %s: %s", document_id, str(e))
        raise HTTPException(status_code=500, detail="Error deleting thumbnail") from e


async def list_documents_by_collection(
    collection_id: str,
    current_user: User,
    db: SQLModelSession,
    page: int = 1,
    page_size: int = 20,
    search: str = None,
):
    """
    List documents by collection with optional search filtering.

    Args:
        collection_id: The ID of the collection
        current_user: The authenticated user
        page: Page number for pagination (default: 1)
        page_size: Number of documents per page (default: 20)
        search: Optional search query to filter documents by filename
        db: Database session
    """
    # Use the autowired document service
    if not get_document_service(db):
        raise HTTPException(status_code=500, detail="Document service unavailable") from None

    # Call the service method with proper parameters
    result = get_document_service(db).list_documents_by_collection(
        collection_id=collection_id,
        user_id=current_user.id,
        page=page,
        page_size=page_size,
        search=search,
    )

    # Convert to DTO format for consistency with API response
    if result["documents"]:
        documents = []
        for doc in result["documents"]:
            # Build thumbnail info from file_metadata if available
            thumbnail = None
            file_metadata = doc.get("file_metadata") or {}

            # Handle both dict and string (from different DB backends)
            if isinstance(file_metadata, str):
                try:
                    file_metadata = json.loads(file_metadata)
                except json.JSONDecodeError:
                    file_metadata = {}

            thumb_data = file_metadata.get("thumbnail")
            if thumb_data:
                # noinspection PyUnresolvedReferences
                thumbnail = ThumbnailInfo(
                    has_thumbnail=thumb_data.get("has_thumbnail", False),
                    has_custom=thumb_data.get("has_custom", False),
                    sizes=thumb_data.get("sizes"),
                    url_large=(f"/api/v1/documents/thumbnail/{doc['id']}/large" if thumb_data.get("has_thumbnail") else None),
                )

            # noinspection PyTypeChecker
            documents.append(
                DocumentDTO(
                    id=doc["id"],
                    title=doc.get("title") or doc.get("filename", "Untitled"),
                    filename=doc.get("filename", "unknown"),
                    file_metadata=file_metadata,
                    collection_id=doc["collection_id"],
                    created_at=doc["created_at"],
                    updated_at=doc.get("updated_at"),
                    file_path=doc["file_path"],
                    file_size=doc.get("file_size"),
                    file_type=doc.get("file_type"),
                    thumbnail=thumbnail,
                    # Processing status fields for the frontend display
                    processing_status=doc.get("processing_status"),
                    job_status=doc.get("job_status"),
                    job_progress=doc.get("job_progress"),
                    job_message=doc.get("job_message"),
                    job_errors=doc.get("job_errors"),
                    job_id=doc.get("job_id"),
                ).model_dump()
            )
        result["documents"] = documents

    return result


# noinspection PyUnusedFunction,PyShadowingNames,SqlResolve
async def delete_document(document_id: UUID, current_user: User):
    """
    Delete a document by ID, removing it from both the database and vector store
    """
    logger.info("Deleting document with ID: %s", document_id)

    # Define the database operations as an async function that takes a db session

    async def do_delete_document(db_session):
        # Check if the document exists and the user has permission
        document = db_session.exec(select(Document).where(Document.id == document_id)).first()
        if not document:
            logger.warning("Document not found: %s", document_id)
            raise HTTPException(status_code=404, detail="Document not found")

        # Check if the user has access to the collection via cache table
        # noinspection PyTypeChecker
        cwm_row = db_session.execute(
            text("SELECT workspace_id, owner_user_id FROM collection_workspace_map WHERE collection_id = :cid"),
            {"cid": str(document.collection_id)},
        ).fetchone()
        if not cwm_row:
            logger.warning("Collection not found for document: %s", document_id)
            raise HTTPException(status_code=404, detail="Collection not found")

        # Check if the user has permission to delete the document (shared access is managed by Kotlin backend)
        if str(cwm_row.owner_user_id) != str(current_user.id):
            logger.warning(
                "User %s does not have permission to delete document %s",
                current_user.id,
                document_id,
            )
            raise HTTPException(
                status_code=403,
                detail="You don't have permission to delete this document",
            )

        # Cancel any running job for this document
        try:
            from src.main.service.document.document_job_manager import document_job_manager

            job_info = document_job_manager.get_job_info_by_document_id(str(document_id))
            if job_info:
                job_id = job_info.get("job_id")
                if job_id:
                    await document_job_manager.cancel_processing(job_id, db_session, str(current_user.id))
                    logger.info("Cancelled job %s for deleted document %s", job_id, document_id)
        except Exception as job_cancel_error:
            logger.warning("Error cancelling job for document %s: %s", document_id, str(job_cancel_error))

        # Delete embeddings and graph data for processed/dedup documents
        if document.processing_status in ("completed", "processing", "failed", "pending_dedup"):
            logger.info(
                "Deleting embeddings and graph data for document %s (status: %s)",
                document_id,
                document.processing_status,
            )

            # First, try to delete it from the vector store
            await delete_document_embeddings(str(document_id), str(document.collection_id), str(cwm_row.owner_user_id))

            # Delete graph nodes for the document
            # CRITICAL: If Neo4j deletion fails, stop the entire operation
            # Don't delete the document from PostgreSQL if Neo4j cleanup fails
            await _delete_document_graph_nodes(str(document_id))
            logger.info("Successfully deleted graph nodes for document: %s", document_id)
        else:
            logger.info(
                "Skipping embeddings and graph deletion for document %s (status: %s - not yet processed)",
                document_id,
                document.processing_status,
            )

        # Handle file deletion with content store ref counting
        if document.content_store_id:
            # Content-addressable storage: decrement ref_count
            from src.main.service.document.dedup_service import decrement_ref_count

            new_ref_count = decrement_ref_count(db_session, document.content_store_id)
            logger.info(
                "Decremented content store ref_count for document %s: new_ref_count=%d",
                document_id,
                new_ref_count,
            )

            if new_ref_count == 0:
                # Last reference — delete the physical file and thumbnails
                file_path = document.file_path
                if file_path and os.path.exists(file_path):
                    try:
                        try:
                            from src.main.service.document.thumbnail_service import ThumbnailService

                            if ThumbnailService.delete_thumbnails(file_path):
                                logger.info("Deleted thumbnails for document: %s", document_id)
                        except Exception as thumb_error:
                            logger.warning("Error deleting thumbnails (continuing anyway): %s", str(thumb_error))

                        # noinspection PyTypeChecker
                        os.remove(file_path)
                        logger.info("Deleted content store file (ref_count=0): %s", file_path)

                        # Clean up empty parent directories up to the content store root
                        # noinspection PyTypeChecker
                        parent_dir = os.path.dirname(file_path)
                        for _ in range(3):  # hash dir, bucket2, bucket1
                            # noinspection PyTypeChecker
                            if os.path.exists(parent_dir) and not os.listdir(parent_dir):
                                os.rmdir(parent_dir)
                                # noinspection PyTypeChecker
                                parent_dir = os.path.dirname(parent_dir)
                            else:
                                break
                    except OSError as e:
                        logger.warning("Error deleting content store file (continuing anyway): %s", str(e))
            else:
                logger.info("Content store file retained (ref_count=%d) for document: %s", new_ref_count, document_id)
        elif document.file_path and os.path.exists(document.file_path):
            # Legacy path: no content store reference, delete file directly
            try:
                # Delete thumbnails first (before deleting the main file)
                try:
                    from src.main.service.document.thumbnail_service import ThumbnailService

                    if ThumbnailService.delete_thumbnails(document.file_path):
                        logger.info("Deleted thumbnails for document: %s", document_id)
                except Exception as thumb_error:
                    logger.warning("Error deleting thumbnails (continuing anyway): %s", str(thumb_error))

                # Delete the main document file
                # noinspection PyTypeChecker
                os.remove(document.file_path)
                logger.info("Deleted document file: %s", document.file_path)

                # Try to delete the parent directory if it's empty
                # noinspection PyTypeChecker
                parent_dir = os.path.dirname(document.file_path)
                # noinspection PyTypeChecker
                if os.path.exists(parent_dir) and not os.listdir(parent_dir):
                    os.rmdir(parent_dir)
                    logger.info("Removed empty directory: %s", parent_dir)
            except OSError as e:
                logger.warning("Error deleting document file (continuing anyway): %s", str(e))

        # Delete the document record from the database
        db_session.delete(document)
        logger.info("Document deleted from database: %s", document_id)

        # Invalidate saved search caches for this workspace
        try:
            from src.main.service.search.saved_search_service import invalidate_workspace_caches

            invalidate_workspace_caches(db_session, str(cwm_row.workspace_id))
        except Exception as cache_err:
            logger.debug("Saved search cache invalidation skipped: %s", cache_err)

        # Return success
        return {"status": "success", "message": "Document deleted successfully"}

    # Execute the database operations
    return await execute_db_operation(do_delete_document, error_message=f"Error deleting document {document_id}")


async def _delete_document_graph_nodes(document_id: str):
    """
    Delete knowledge graph nodes for a document using the GraphIntegrationService.

    This implements the relational-graph boundary cleanup workflow.

    Args:
        document_id: The ID of the document to delete graph nodes for
    """
    try:
        # Use GraphIntegrationService for proper cleanup
        graph_service = get_graph_integration_service()
        if not graph_service.is_graph_enabled():
            logger.info("Graph features disabled, skipping graph node deletion")
            return

        # Clean up document graph nodes
        success = await graph_service.cleanup_document_graph(document_id)

        if success:
            logger.info("Successfully deleted graph hierarchy for document %s", document_id)
        else:
            logger.warning("No graph hierarchy found for document %s", document_id)

    except ImportError:
        logger.warning("Graph services not available for deletion")
    except Exception as e:
        logger.error("Error deleting graph nodes for document %s: %s", document_id, e)
        raise Exception(f"Error deleting graph nodes for document {document_id}: {e!s}") from e


async def delete_document_embeddings(document_id: str, collection_id: str, user_id: str):
    """
    Delete document embeddings from the vector store using user-specific retriever.

    Args:
        document_id: The ID of the document to delete embeddings for
        collection_id: The ID of the collection the document belongs to
        user_id: The ID of the user who owns the document

    Returns:
        bool: True if successful, False otherwise
    """
    try:
        from src.main.config.database import SessionLocal
        from src.main.service.retriever.retriever_manager import retriever_manager

        logger.info("Deleting embeddings for document %s in collection %s for user %s", document_id, collection_id, user_id)

        # Get user's preferred retriever type
        db = SessionLocal()
        try:
            # Use the autowired document service
            if not get_document_service(db):
                logger.error("Document service unavailable")
                return False

            from src.main.utils.documents.utils import get_user_retriever_type

            user_retriever_type = get_user_retriever_type(db, user_id)
            logger.info("User %s prefers retriever type: %s", user_id, user_retriever_type)

            # Get user-specific retriever from RetrieverManager
            retriever = await retriever_manager.get_retriever(user_id, user_retriever_type)
            if not retriever:
                logger.error("Failed to get retriever for user %s", user_id)
                return False

            # Delete the document embeddings from the vector store
            success = await retriever.delete_documents(document_ids=[document_id], collection_ids=[collection_id])

            if success:
                logger.info("Successfully deleted embeddings for document %s", document_id)
                return True
            else:
                logger.warning("No embeddings found for document %s (document may not have been processed)", document_id)
                return True  # Return True since this is not an error - a document can be deleted even without embeddings

        finally:
            db.close()

    except Exception as e:
        logger.error("Error in delete_document_embeddings: %s", str(e))
        return False


async def background_process_document(
    document_id: str,
    file_path: str,
    collection_id: str,
    user_id: str,
    doc_service,
    skip_llm_steps: bool = False,
    markdown_content: str | None = None,
):
    """
    Process a document in the background by delegating to the DocumentService.

    Args:
        document_id: The ID of the document to process
        file_path: The path to the document file
        collection_id: The ID of the collection the document belongs to
        user_id: The ID of the user who uploaded the document
        doc_service: The DocumentService instance
        skip_llm_steps: If True, skip LLM-expensive steps when content is unchanged
        markdown_content: Optional pre-extracted markdown content (skips file parsing)
    """
    job_id = None
    try:
        logger.info("Starting background processing for document %s (skip_llm_steps=%s)", document_id, skip_llm_steps)

        # Get job ID for this document
        from src.main.service.document.document_job_manager import document_job_manager

        job_info = document_job_manager.get_job_info_by_document_id(document_id)
        if job_info:
            job_id = job_info.get("job_id")

        # Note: Background document processing uses user-specific retrievers via DocumentService
        # The DocumentService.background_process_document method handles retriever creation
        logger.info("Using DocumentService for background processing with user-specific retriever")

        # Process the document using the service layer
        async for _ in doc_service.process_document_background(
            document_id=document_id,
            file_path=file_path,
            collection_id=collection_id,
            user_id=user_id,
            skip_llm_steps=skip_llm_steps,
            markdown_content=markdown_content,
        ):
            # Updates are streamed directly from the service
            pass

        logger.info("Background processing completed for document %s", document_id)
    except Exception as e:
        logger.exception("Error in background_process_document for %s: %s", document_id, str(e))

        # Update job status to failed
        if job_id:
            try:
                from src.main.service.document.document_job_manager import document_job_manager

                document_job_manager.update_job_status(job_id=job_id, status="failed", progress=0, message=f"Processing failed: {e!s}", error=str(e))
                logger.info("Updated job %s status to 'failed' due to exception", job_id)
            except Exception as update_error:
                logger.error("Failed to update job status: %s", update_error)

        # Re-raise to trigger the task done callback
        raise


async def _handle_document_upload(file: UploadFile, collection_id: str, current_user: User, doc_service, db: SQLModelSession) -> dict:
    """
    Common helper function for document upload validation and processing.

    Args:
        file: The uploaded file
        collection_id: The ID of the collection to upload to
        current_user: The current user
        doc_service: The DocumentService instance

    Returns:
        dict: A dictionary with the result of the upload operation
    """
    logger.info("Starting document upload: filename=%s, collection=%s", file.filename, collection_id)

    # Check if the file is acceptable
    original_filename = file.filename
    if not original_filename:
        return {
            "success": False,
            "status_code": 400,
            "content": {"detail": "No filename provided"},
        }

    # Check if the file type is valid
    if not is_valid_document_type(original_filename):
        return {
            "success": False,
            "status_code": 400,
            "content": {"detail": "Invalid file type. Supported formats: PDF, EPUB, DOCX, Markdown, TXT, CSV, RTF"},
        }

    # Get and sanitize the filename
    sanitized_filename = sanitize_filename(original_filename)
    logger.info("Sanitized filename: %s", sanitized_filename)

    # Check user permissions for this collection (basic access check)
    has_permission = doc_service.check_collection_permissions(collection_id=collection_id, user_id=current_user.id, db=db)

    if not has_permission:
        logger.error("Collection %s not found or user %s does not have access.", collection_id, current_user.id)
        return {
            "success": False,
            "status_code": 403,
            "content": {"detail": "Collection not found or user does not have permission to upload to this collection"},
        }

    # Check if the user has edit permissions (viewers are read-only)
    can_modify = can_user_modify_collection(db, current_user.id, collection_id)
    if not can_modify:
        logger.warning("User %s does not have edit permissions for collection %s", current_user.id, collection_id)
        return {
            "success": False,
            "status_code": 403,
            "content": {"detail": "You need editor or owner role to upload files to this collection. Viewers have read-only access."},
        }

    # Get the workspace owner (who pays for storage)
    owner_info = get_workspace_owner_for_collection(db, collection_id)
    if not owner_info:
        logger.error("Failed to resolve workspace owner for collection %s", collection_id)
        return {
            "success": False,
            "status_code": 500,
            "content": {"detail": "Failed to resolve workspace owner for storage quota check"},
        }

    owner_user_id, workspace_id, _ = owner_info
    logger.info("Resolved workspace owner: %s for collection %s", owner_user_id, collection_id)

    # Check storage quota before uploading
    # First, read file size to check quota
    try:
        # Read the file to get size
        content = await file.read()
        file_size = len(content)
        # Reset file pointer for later saving
        await file.seek(0)
    except Exception as e:
        logger.error("Failed to read file for quota check: %s", e)
        return {
            "success": False,
            "status_code": 500,
            "content": {"detail": "Failed to read file for quota validation"},
        }

    # Check if upload would exceed quota
    quota_check = check_storage_quota(db, owner_user_id, file_size)
    if not quota_check["allowed"]:
        logger.warning("Storage quota exceeded for user %s: %s", owner_user_id, quota_check["message"])
        return {
            "success": False,
            "status_code": 413,  # Payload Too Large
            "content": {
                "detail": quota_check["message"],
                "quota_info": {
                    "current_usage_gb": quota_check.get("current_usage_gb", 0),
                    "limit_gb": quota_check.get("limit_gb", 0),
                    "percentage_used": quota_check.get("percentage_used", 0),
                },
            },
        }

    logger.info(
        "Storage quota check passed for user %s. Current usage: %sGB",
        owner_user_id,
        quota_check.get("current_usage_gb", 0),
    )

    # --- Content-addressable deduplication check ---
    from src.main.service.document.dedup_service import (
        clone_all_artifacts,
        compute_file_hash,
        create_or_increment_content_store,
        find_processed_source_document,
    )
    from src.main.utils.documents.utils import get_content_store_path

    file_hash = compute_file_hash(content)
    logger.info("Computed file hash for upload: %s", file_hash[:16])

    # Check if a document with the same name exists in THIS collection
    existing_doc = doc_service.check_document_exists(collection_id, sanitized_filename)
    if existing_doc:
        logger.warning("Document with name '%s' already exists in collection %s", sanitized_filename, collection_id)
        return {
            "success": False,
            "status_code": 409,
            "content": {
                "detail": "A document with this name already exists in the collection",
                "filename": sanitized_filename,
            },
        }

    # Check if the user has reached the maximum concurrent jobs limit
    jobs_check = doc_service.check_user_job_limit(current_user.id)
    if not jobs_check["success"]:
        logger.warning("User %s has reached the maximum concurrent jobs limit (%s)", current_user.id, jobs_check["max_jobs"])
        return {
            "success": False,
            "status_code": 429,
            "content": {"detail": jobs_check["message"]},
        }

    # Generate a unique ID for the document
    document_id = str(uuid.uuid4())

    # Content-addressable path for new files
    content_relative_path, content_absolute_path = get_content_store_path(file_hash, sanitized_filename)

    # Atomically create or increment content store entry
    content_store, is_new_content = create_or_increment_content_store(
        db=db,
        file_hash=file_hash,
        file_path=content_relative_path,
        file_size=file_size,
        file_type=file.content_type,
        original_filename=original_filename,
    )

    if is_new_content:
        # --- NEW CONTENT: save file to content-addressable path ---
        logger.info("New content detected (hash=%s), saving to content store", file_hash[:16])

        os.makedirs(os.path.dirname(content_absolute_path), exist_ok=True)
        try:
            with open(content_absolute_path, "wb") as f:
                f.write(content)
            logger.info("File saved to content store: %s (%d bytes)", content_absolute_path, file_size)
        except Exception as e:
            logger.error("Failed to save file to content store: %s", e)
            return {
                "success": False,
                "status_code": 500,
                "content": {"detail": f"Failed to save file: {e!s}"},
            }

        normalized_file_path = content_relative_path

        # Create the document record with content_store reference
        document_result = doc_service.create_document(
            document_id=document_id,
            title=sanitized_filename,
            filename=sanitized_filename,
            file_path=normalized_file_path,
            collection_id=collection_id,
            original_filename=original_filename,
            content_type=file.content_type,
            file_size=file_size,
            user_id=current_user.id,
            content_store_id=str(content_store.id),
        )

        if not document_result["success"]:
            cleanup_file(content_absolute_path)
            return {
                "success": False,
                "status_code": 500,
                "content": {"detail": document_result["message"]},
            }

        job_id = document_result["job_id"]
        file_path = content_absolute_path
        logger.info("Created new document %s with content store %s", document_id, content_store.id)

    else:
        # --- DUPLICATE CONTENT: skip file save, clone processing artifacts ---
        logger.info(
            "Duplicate content detected (hash=%s, ref_count=%d), cloning artifacts",
            file_hash[:16],
            content_store.ref_count,
        )

        # Use the existing content store file path
        normalized_file_path = content_store.file_path
        file_path = os.path.abspath(normalized_file_path)

        # Check if the source is already fully processed
        if content_store.id is None:
            raise RuntimeError("ContentStore ID is None — cannot look up source document")
        # noinspection PyTypeChecker
        source_doc_id = find_processed_source_document(db, content_store.id)

        if source_doc_id:
            # Source is processed — create document and clone artifacts
            document_result = doc_service.create_document(
                document_id=document_id,
                title=sanitized_filename,
                filename=sanitized_filename,
                file_path=normalized_file_path,
                collection_id=collection_id,
                original_filename=original_filename,
                content_type=file.content_type,
                file_size=file_size,
                user_id=current_user.id,
                content_store_id=str(content_store.id),
            )

            if not document_result["success"]:
                return {
                    "success": False,
                    "status_code": 500,
                    "content": {"detail": document_result["message"]},
                }

            job_id = document_result["job_id"]

            # Clone all processing artifacts from the source document
            clone_result = await clone_all_artifacts(
                db=db,
                source_doc_id=source_doc_id,
                target_doc_id=document_id,
                target_collection_id=collection_id,
                target_user_id=str(current_user.id),
                target_workspace_id=str(workspace_id),
            )
            logger.info(
                "Dedup clone completed for document %s: embeddings=%d, summaries=%d, graph=%s",
                document_id,
                clone_result["embeddings_cloned"],
                clone_result["summaries_cloned"],
                clone_result["graph_cloned"],
            )

            # Send WebSocket notification
            try:
                notification_method = getattr(doc_service, "send_document_notification", None)
                if notification_method and callable(notification_method):
                    notification_result = notification_method(
                        {
                            "type": "document_added",
                            "document_id": document_id,
                            "collection_id": collection_id,
                            "filename": sanitized_filename,
                        }
                    )
                    if notification_result is not None and hasattr(notification_result, "__await__"):
                        # noinspection PyUnresolvedReferences
                        await notification_result
            except Exception as notify_err:
                logger.warning("Failed to send document notification: %s", str(notify_err))

            return {
                "success": True,
                "document_id": document_id,
                "job_id": job_id,
                "file_path": file_path,
                "sanitized_filename": sanitized_filename,
                "dedup": True,
            }

        else:
            # Source is still processing — create document as pending_dedup
            logger.info("Source document still processing, creating pending_dedup document %s", document_id)

            document_result = doc_service.create_document(
                document_id=document_id,
                title=sanitized_filename,
                filename=sanitized_filename,
                file_path=normalized_file_path,
                collection_id=collection_id,
                original_filename=original_filename,
                content_type=file.content_type,
                file_size=file_size,
                user_id=current_user.id,
                content_store_id=str(content_store.id),
                processing_status="pending_dedup",
            )

            if not document_result["success"]:
                return {
                    "success": False,
                    "status_code": 500,
                    "content": {"detail": document_result["message"]},
                }

            job_id = document_result["job_id"]

            # Send WebSocket notification
            try:
                notification_method = getattr(doc_service, "send_document_notification", None)
                if notification_method and callable(notification_method):
                    notification_result = notification_method(
                        {
                            "type": "document_added",
                            "document_id": document_id,
                            "collection_id": collection_id,
                            "filename": sanitized_filename,
                        }
                    )
                    if notification_result is not None and hasattr(notification_result, "__await__"):
                        # noinspection PyUnresolvedReferences
                        await notification_result
            except Exception as notify_err:
                logger.warning("Failed to send document notification: %s", str(notify_err))

            return {
                "success": True,
                "document_id": document_id,
                "job_id": job_id,
                "file_path": file_path,
                "sanitized_filename": sanitized_filename,
                "dedup": True,
            }

    # Send WebSocket notification about the new document (non-critical, for new content path only)
    try:
        notification_method = getattr(doc_service, "send_document_notification", None)
        if notification_method and callable(notification_method):
            notification_result = notification_method(
                {
                    "type": "document_added",
                    "document_id": document_id,
                    "collection_id": collection_id,
                    "filename": sanitized_filename,
                }
            )
            # Only await if it's a coroutine
            if notification_result is not None and hasattr(notification_result, "__await__"):
                # noinspection PyUnresolvedReferences
                await notification_result
    except Exception as notify_err:
        logger.warning("Failed to send document notification: %s", str(notify_err))

    return {
        "success": True,
        "document_id": document_id,
        "job_id": job_id,
        "file_path": file_path,
        "sanitized_filename": sanitized_filename,
    }


def _process_upload_result(result):
    """
    Process the result from _handle_document_upload and either return an error response
    or extract the document_id, job_id, and file_path.

    Args:
        result: The result dictionary from _handle_document_upload

    Returns:
        Either a JSONResponse for errors or a tuple of (document_id, job_id, file_path)
    """
    if not result["success"]:
        return JSONResponse(status_code=result["status_code"], content=result["content"])

    # Extract values for successful uploads
    return result["document_id"], result["job_id"], result["file_path"]


# noinspection PyUnusedFunction
async def cancel_document_processing(job_id: str, current_user: User, db: SQLModelSession):
    """
    Cancel a document processing job.

    Args:
        job_id: The job ID to cancel
        current_user: Authenticated user
        db: Database session

    Returns:
        JSON response with cancellation status
    """
    try:
        from src.main.service.document.document_job_manager import document_job_manager

        # Cancel the job
        result = await document_job_manager.cancel_processing(job_id, db, str(current_user.id))

        logger.info("User %s cancelled job %s: %s", current_user.id, job_id, result)

        return JSONResponse(status_code=200, content={"success": True, "message": "Job cancelled successfully", "job_id": job_id})

    except ValueError as e:
        logger.warning("Job not found for cancellation: %s", str(e))
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.exception("Error cancelling job %s: %s", job_id, str(e))
        raise HTTPException(status_code=500, detail=f"Failed to cancel job: {e!s}") from e


# noinspection PyUnusedFunction
async def upload_document_async(
    current_user: User,
    db: SQLModelSession,
    file: UploadFile = File(...),
    collection_id: str = Form(...),
    auto_process: str = Form("false"),  # Accept as a string to avoid bool coercion issues with FormData
):
    """
    Asynchronous document upload endpoint.
    By default, documents are uploaded with status='pending' and require manual processing via the "Compose" button.
    Set auto_process=true to the process immediately after upload (legacy behavior).

    Args:
        file: The uploaded file
        collection_id: The ID of the collection to upload to
        auto_process: Whether to automatically process after upload (default: "false", accepts "true"/"1"/"yes")
        current_user: The current user
        db: Database session

    Returns:
        dict: A dictionary with the document ID and job ID
    """
    # Parse auto_process string to boolean (FormData sends strings, not booleans)
    should_auto_process = auto_process.lower() in ("true", "1", "yes", "on")
    logger.info("Upload auto_process=%s (parsed to should_auto_process=%s)", auto_process, should_auto_process)

    # Get document service with the current db session
    doc_service = get_document_service(db)
    if not doc_service:
        raise HTTPException(status_code=500, detail="Document service unavailable")

    try:
        # Use the common helper function for document upload
        result = await _handle_document_upload(file, collection_id, current_user, doc_service, db)

        # Process the upload result
        upload_result = _process_upload_result(result)
        if isinstance(upload_result, JSONResponse):
            return upload_result

        document_id, job_id, file_path = upload_result

        # Only start background processing if should_auto_process is True
        processing_task = None
        if should_auto_process:
            processing_task = asyncio.create_task(
                background_process_document(
                    document_id=document_id,
                    file_path=file_path,
                    collection_id=collection_id,
                    user_id=current_user.id,
                    doc_service=doc_service,
                )
            )

        # Add error handling for the background task (only if auto_process is True)
        if processing_task:

            async def on_task_done(task):
                if task.exception():
                    error = task.exception()
                    logger.error("Background processing task failed for job %s: %s", job_id, error, exc_info=error)

                    # Update job status to fail to prevent it from staying "processing" forever
                    try:
                        from src.main.service.document.document_job_manager import document_job_manager

                        document_job_manager.update_job_status(
                            job_id=job_id,
                            status="failed",
                            progress=0,
                            message=f"Processing failed: {error!s}",
                            error=str(error),
                        )
                        logger.info("Updated job %s status to 'failed'", job_id)
                    except Exception as update_error:
                        logger.error("Failed to update job status for %s: %s", job_id, update_error)

            processing_task.add_done_callback(lambda t: asyncio.create_task(on_task_done(t)))
            logger.info("Successfully started document processing task with job_id: %s", job_id)
            message = "Document uploaded and processing started"
        else:
            logger.info("Document uploaded with status='pending', awaiting manual processing via Compose button")
            message = "Document uploaded successfully. Status: Pending. Click 'Compose' to process."

        # Return the document ID and job ID to the client
        return {
            "document_id": document_id,
            "job_id": job_id,
            "message": message,
        }

    except HTTPException as ex:
        # Re-raise HTTP exceptions
        raise ex from ex
    except Exception as e:
        logger.exception("Error in upload_document_async: %s", str(e))
        raise HTTPException(
            status_code=500,
            detail=f"An error occurred during document upload: {e!s}",
        ) from e


# noinspection PyUnusedFunction,PyDeprecation
async def process_pending_documents(
    collection_id: str,
    current_user: User,
    db: SQLModelSession,
):
    """
    Process all pending documents in a collection.
    This endpoint is called when the user clicks the "Compose" button.

    Args:
        collection_id: The ID of the collection
        current_user: The current user
        db: Database session

    Returns:
        dict: A dictionary with the number of documents being processed and job IDs
    """
    # Get document service with the current db session
    doc_service = get_document_service(db)
    if not doc_service:
        raise HTTPException(status_code=500, detail="Document service unavailable")

    try:
        # Get pending document IDs and file paths only (NOT content — avoids loading 80MB+ of text)
        # noinspection PyTypeChecker
        pending_docs = db.execute(
            text(
                """
                SELECT d.id, d.file_path, d.file_stored,
                       CASE WHEN d.content IS NOT NULL AND LENGTH(d.content) > 100 THEN true ELSE false END AS has_content
                FROM documents d
                JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id
                WHERE d.collection_id = :collection_id
                  AND d.processing_status = 'pending'
                  AND cwm.owner_user_id = :user_id
                """
            ),
            {"collection_id": collection_id, "user_id": current_user.id},
        ).fetchall()

        if not pending_docs:
            return {
                "message": "No pending documents to process",
                "documents_processed": 0,
                "job_ids": [],
            }

        # Build the list of documents to process (content loaded lazily per-document in background)
        docs_to_process = []
        for doc in pending_docs:
            document_id = str(doc.id)
            file_path = doc.file_path

            # Construct an absolute path
            absolute_file_path = os.path.join(os.getcwd(), file_path) if file_path else ""

            # Check if file exists on disk or if content is available in DB
            if not os.path.exists(absolute_file_path):
                if doc.has_content:
                    logger.info("Document %s has no file on disk, will load content from DB during processing", document_id)
                else:
                    logger.warning(
                        "Marking document %s as failed: no file on disk and no stored content — re-upload required",
                        document_id,
                    )
                    # noinspection PyTypeChecker
                    db.execute(
                        text("UPDATE documents SET processing_status = 'failed' WHERE id = :doc_id"),
                        {"doc_id": document_id},
                    )
                    db.commit()
                    continue

            docs_to_process.append(
                {
                    "document_id": document_id,
                    "file_path": absolute_file_path,
                    "has_content": doc.has_content,
                }
            )

        job_ids = [d["document_id"] for d in docs_to_process]
        user_id = current_user.id

        # Acquire collection-level lock to prevent duplicate batch dispatch
        # (e.g., user double-clicks "Compose" or UI retries on timeout)
        from src.main.utils.redis.client import get_redis_client

        _redis = get_redis_client()
        _batch_lock_key = f"scrapalot:lock:batch:{collection_id}"
        _lock_acquired = _redis.set(_batch_lock_key, "dispatching", nx=True, ex=3600)  # 1h TTL
        if not _lock_acquired:
            logger.warning("Batch already dispatched for collection %s — skipping duplicate", collection_id)
            return {
                "message": "Document processing is already in progress for this collection",
                "documents_processed": 0,
                "job_ids": [],
            }

        # Dispatch per-document tasks to Celery workers (scrapalot-workers container)
        # Each document = 1 Celery task → workers process them in parallel (concurrency=2)
        from src.main.models.sqlmodel_jobs import Job
        from src.main.workers.celery_app import celery_app

        for doc in docs_to_process:
            doc_id = doc["document_id"]
            job_id = f"batch-{doc_id}"

            # Create or reset Job record so process_document_task can find it
            # noinspection PyTypeChecker
            existing_job = db.query(Job).filter(Job.job_id == job_id).first()
            if existing_job:
                existing_job.status = "pending"
                existing_job.progress = 0.0
                existing_job.error_message = None
                existing_job.started_at = None
                existing_job.completed_at = None
            else:
                # noinspection PyPep8Naming
                from uuid import UUID as PyUUID

                db.add(
                    Job(
                        job_id=job_id,
                        job_type="document_processing",
                        document_id=PyUUID(doc_id),
                        user_id=str(user_id),
                        status="pending",
                        progress=0.0,
                        description="Queued for processing",
                    )
                )
            db.commit()

            celery_app.send_task(
                "scrapalot.process_document",
                args=[job_id, doc_id, collection_id, str(user_id), doc["file_path"]],
                queue="documents",
            )
        logger.info("Dispatched %d per-document tasks for collection %s", len(job_ids), collection_id)

        # Release dispatching lock
        # noinspection PyAsyncCall
        _redis.delete(_batch_lock_key)

        return {
            "message": f"Started processing {len(job_ids)} pending documents",
            "documents_processed": len(job_ids),
            "job_ids": job_ids,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error processing pending documents: %s", str(e))
        raise HTTPException(
            status_code=500,
            detail=f"An error occurred while processing pending documents: {e!s}",
        ) from e


# noinspection PyUnusedFunction,PyDeprecation
async def process_single_document(
    document_id: str,
    current_user: User,
    db: SQLModelSession,
):
    """
    Process a single pending document in the background.
    Returns immediately with job info; progress is tracked via WebSocket.

    This follows the same pattern as process_pending_documents but for a single document.
    """
    doc_service = get_document_service(db)
    if not doc_service:
        raise HTTPException(status_code=500, detail="Document service unavailable")

    try:
        # Get the document and verify ownership/access
        # Raw SQL requires execute(), not exec()
        # noinspection PyTypeChecker
        doc = db.execute(
            text(
                """
                SELECT d.id, d.file_path, d.collection_id, d.processing_status, d.content
                FROM documents d
                JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id
                WHERE d.id = :document_id
                  AND cwm.owner_user_id = :user_id
                """
            ),
            {"document_id": document_id, "user_id": current_user.id},
        ).fetchone()

        if not doc:
            raise HTTPException(status_code=404, detail="Document not found or access denied")

        if doc.processing_status != "pending":
            raise HTTPException(
                status_code=400,
                detail=f"Document is not pending (status: {doc.processing_status})",
            )

        absolute_file_path = os.path.join(os.getcwd(), doc.file_path) if doc.file_path else None
        has_file_on_disk = absolute_file_path and os.path.exists(absolute_file_path)
        has_db_content = bool(doc.content and doc.content.strip())

        if not has_file_on_disk and not has_db_content:
            # Mark as failed so the UI shows the correct state instead of a stuck "pending"
            # noinspection PyTypeChecker
            db.execute(
                text("UPDATE documents SET processing_status = 'failed' WHERE id = :doc_id"),
                {"doc_id": document_id},
            )
            db.commit()
            raise HTTPException(
                status_code=400,
                detail="Document was uploaded without file storage and has no content. Please re-upload the file with storage enabled.",
            )

        # Start background processing (same pattern as process_pending_documents)
        # Use absolute path if file exists, otherwise use DB path for graph metadata
        effective_file_path = absolute_file_path if has_file_on_disk else (doc.file_path or "")
        # noinspection PyTypeChecker
        processing_task = asyncio.create_task(
            background_process_document(
                document_id=document_id,
                file_path=effective_file_path,
                collection_id=str(doc.collection_id),
                user_id=current_user.id,
                doc_service=doc_service,
                markdown_content=doc.content if not has_file_on_disk and has_db_content else None,
            )
        )

        async def on_task_done(task, doc_id=document_id):
            if task.exception():
                error = task.exception()
                logger.error("Background processing failed for %s: %s", doc_id, error, exc_info=error)
                try:
                    from src.main.service.document.document_job_manager import document_job_manager

                    job_info = document_job_manager.get_job_info_by_document_id(doc_id)
                    if job_info:
                        document_job_manager.update_job_status(
                            job_id=job_info.get("job_id"),
                            status="failed",
                            progress=0,
                            message=f"Processing failed: {error!s}",
                            error=str(error),
                        )
                except Exception as update_error:
                    logger.error("Failed to update job status: %s", update_error)

        processing_task.add_done_callback(lambda t, d=document_id: asyncio.create_task(on_task_done(t, d)))

        logger.info("Started background processing for document %s", document_id)

        return {
            "message": "Started processing document",
            "document_id": document_id,
            "job_id": document_id,
            "status": "processing",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error processing document %s: %s", document_id, str(e))
        raise HTTPException(status_code=500, detail=f"Failed to process document: {e!s}") from e


# noinspection PyUnusedFunction
def get_processing_status(
    job_id: str,
    current_user: User,
    db: SQLModelSession,
):
    """
    Get the current processing status for a specific job.
    This endpoint is used for polling fallback when WebSocket is not working.
    Requires authentication to prevent unauthorized access to job status.
    """
    # Get document service with the current db session
    doc_service = get_document_service(db)
    if not doc_service:
        raise HTTPException(status_code=500, detail="Document service unavailable")

    try:
        # Use the DocumentService to get the processing status
        status = doc_service.get_job_status(job_id)

        # Verify the user owns this job (security check)
        if status and status.get("user_id") and status.get("user_id") != current_user.id:
            logger.warning(
                "User %s attempted to access job %s owned by %s",
                current_user.id,
                job_id,
                status.get("user_id"),
            )
            raise HTTPException(status_code=403, detail="Access denied to this job")

        return status
    except HTTPException as ex:
        # Re-raise HTTP exceptions
        raise ex from ex
    except Exception as e:
        logger.error("Error getting processing status: %s", str(e))
        logger.exception(e)
        return {"error": str(e), "job_id": job_id}


# noinspection PyUnusedFunction,PyDeprecation
async def reprocess_failed_document(
    document_id: str,
    current_user: User,
    db: SQLModelSession,
):
    """
    Reprocess a failed document by cleaning up orphan data and restarting processing.
    This endpoint:
    1. Verifies the document exists and belongs to the user
    2. Cleans up orphan embeddings and Neo4j data
    3. Resets document status to 'pending'
    4. Starts background processing

    Returns the new job_id for tracking progress.
    """
    doc_service = get_document_service(db)
    if not doc_service:
        raise HTTPException(status_code=500, detail="Document service unavailable")

    try:
        # Check if the document exists and belongs to the user
        # noinspection PyTypeChecker
        document = db.execute(
            text(
                """
                SELECT d.*, cwm.collection_id, cwm.workspace_id
                FROM documents d
                JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id
                WHERE d.id = :id AND cwm.owner_user_id = :user_id
                """
            ),
            {"id": document_id, "user_id": current_user.id},
        ).fetchone()

        if not document:
            raise HTTPException(
                status_code=404,
                detail="Document not found or does not belong to the user",
            )

        # Verify file exists
        absolute_file_path = os.path.join(os.getcwd(), document.file_path)
        if not os.path.exists(absolute_file_path):
            raise HTTPException(
                status_code=404,
                detail="Document file not found on disk. Cannot reprocess.",
            )

        logger.info("Reprocessing document: %s (ID: %s)", document.filename, document_id)

        # Compute content hash to check if file content has changed
        from src.main.utils.documents.utils import extract_document_content

        content, _ = extract_document_content(absolute_file_path)
        new_hash = hashlib.sha256(content.encode("utf-8")).hexdigest() if content else None
        old_hash = document.content_hash if hasattr(document, "content_hash") else None

        content_changed = old_hash is None or new_hash is None or new_hash != old_hash
        skip_llm_steps = not content_changed

        if skip_llm_steps:
            logger.info(
                "Content unchanged for document %s (hash: %s) — will skip LLM-expensive steps",
                document_id,
                (old_hash or "")[:16],
            )
        else:
            logger.info(
                "Content changed for document %s (old: %s, new: %s) — full reprocessing",
                document_id,
                (old_hash or "none")[:16],
                (new_hash or "none")[:16],
            )

        # Steps 1-2: Clean up orphan data only when content has changed
        if content_changed:
            # Step 1: Clean up orphan embeddings from pgvector
            try:
                # noinspection PyTypeChecker
                cleanup_result = db.execute(
                    text(
                        """
                        DELETE FROM langchain_pg_embedding
                        WHERE cmetadata->>'document_id' = :document_id
                        """
                    ),
                    {"document_id": document_id},
                )
                deleted_embeddings = cleanup_result.rowcount
                logger.info("Deleted %d orphan embeddings for document: %s", deleted_embeddings, document_id)
            except Exception as e:
                logger.warning("Error cleaning up embeddings: %s", str(e), exc_info=True)

            # Step 2: Clean up the Neo4j graph (Book → Chapter → Section → Chunk)
            # for this document. The structural nodes carry chunk IDs that the
            # reparse invalidates; shared Entity nodes are preserved (other books
            # may reference them — nightly orphan housekeeping sweeps any that
            # become unreferenced). Targets the real topology: a previous version
            # MATCHHed (:Document)-[:CONTAINS]->(:Paragraph), node labels that do
            # not exist in this schema, so the cleanup silently did nothing and
            # left stale Book/Chunk nodes behind on every content-changing reparse.
            try:
                graph_service = get_graph_integration_service()
                if graph_service and hasattr(graph_service, "driver") and graph_service.driver:
                    with graph_service.driver.session() as session:
                        session.run(
                            """
                            MATCH (b:Book {document_id: $document_id})
                            OPTIONAL MATCH (b)-[:HAS_CHAPTER]->(ch:Chapter)
                            OPTIONAL MATCH (ch)-[:HAS_SECTION]->(s:Section)
                            OPTIONAL MATCH (s)-[:CONTAINS]->(ck:Chunk)
                            DETACH DELETE ck, s, ch, b
                            """,
                            document_id=str(document_id),
                        )
                    logger.info("Deleted Neo4j Book/Chapter/Section/Chunk nodes for document: %s", document_id)
            except Exception as e:
                logger.warning("Error cleaning up Neo4j data: %s", str(e), exc_info=True)

            # Step 2b: Reset the graph-sync checkpoint so the backfill rebuilds
            # the graph. Without this the row keeps its prior 'completed' status
            # while its Neo4j hierarchy is gone — a drift where the flag claims a
            # graph that no longer exists, so the backfill never re-picks it.
            try:
                # noinspection PyTypeChecker
                db.execute(
                    text(
                        """
                        UPDATE graph_sync_status
                        SET status = 'pending',
                            chunks_created = 0,
                            entities_extracted = 0,
                            error_message = NULL,
                            updated_at = NOW()
                        WHERE document_id = :document_id
                        """
                    ),
                    {"document_id": str(document_id)},
                )
            except Exception as e:
                logger.warning("Error resetting graph_sync_status: %s", str(e), exc_info=True)
        else:
            logger.info("Skipping cleanup steps 1-2 — content unchanged, preserving existing embeddings and graph data")

        # Step 3: Cancel/delete any existing jobs for this document
        try:
            # noinspection PyTypeChecker
            result = db.execute(
                text(
                    """
                    DELETE FROM jobs
                    WHERE document_id = :document_id
                    AND job_type = 'document_processing'
                    """
                ),
                {"document_id": document_id},
            )
            deleted_jobs = result.rowcount
            if deleted_jobs > 0:
                logger.info("Deleted %d existing job(s) for document: %s", deleted_jobs, document_id)
        except Exception as e:
            logger.warning("Error deleting jobs: %s", str(e), exc_info=True)
            db.rollback()  # Roll back transaction to allow later operations
            # Continue even if job deletion fails

        # Step 4: Reset document status to 'pending' and clear error information.
        # ``process_retry_count`` is reset to 0 so the JobRecoveryService
        # auto-retry budget refreshes — a manual reprocess is the user
        # explicitly asking "try again", and any prior auto-retries shouldn't
        # leak into this attempt.
        # noinspection PyTypeChecker
        db.execute(
            text(
                """
                UPDATE documents
                SET processing_status = 'pending',
                    processing_error = NULL,
                    processing_progress = 0.0,
                    process_retry_count = 0,
                    celery_task_id = NULL,
                    updated_at = NOW()
                WHERE id = :document_id
                """
            ),
            {"document_id": document_id},
        )
        db.commit()

        logger.info("Reset document status to pending: %s", document_id)

        # Step 5: Start background processing
        new_job_id = str(uuid.uuid4())

        logger.info("Processing document via asyncio background task: %s (skip_llm_steps=%s)", document_id, skip_llm_steps)
        asyncio.create_task(
            background_process_document(
                document_id=document_id,
                file_path=absolute_file_path,
                collection_id=document.collection_id,
                user_id=current_user.id,
                doc_service=doc_service,
                skip_llm_steps=skip_llm_steps,
            )
        )

        return JSONResponse(
            content={
                "message": "Document queued for reprocessing",
                "document_id": document_id,
                "job_id": new_job_id,
                "status": "pending",
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error reprocessing document: %s", str(e))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to reprocess document: {e!s}",
        ) from e
    finally:
        db.close()


# noinspection PyUnusedFunction
async def upload_document_stream(
    file: UploadFile,
    current_user: User,
    db: SQLModelSession,
    collection_id: str = Form(...),
    auto_process: str = Form("false"),  # Accept as a string to avoid bool coercion issues with FormData
    store_file: str = Form("true"),  # false = process without saving physical file to permanent storage
):
    """
    Stream document upload with optional real-time processing progress updates.
    By default, documents are uploaded with status='pending' and require manual processing via the "Compose" button.
    Set auto_process=true to the process immediately after upload (legacy behavior).
    Set store_file=false to process without saving the physical file (embeddings-only, memory-only doc).
    :param file:
    :param collection_id:
    :param current_user:
    :param auto_process:
    :param store_file:
    :type db: SQLModelSession
    """
    # Parse auto_process string to boolean (FormData sends strings, not booleans)
    should_auto_process = auto_process.lower() in ("true", "1", "yes", "on")
    should_store_file = store_file.lower() not in ("false", "0", "no", "off")

    # Memory-only uploads must be auto-processed while bytes are available
    if not should_store_file:
        should_auto_process = True

    logger.info(
        "Upload stream auto_process=%s store_file=%s (parsed: should_auto_process=%s, should_store_file=%s)",
        auto_process,
        store_file,
        should_auto_process,
        should_store_file,
    )

    # Get document service with the current db session
    doc_service = get_document_service(db)
    if not doc_service:
        raise HTTPException(status_code=500, detail="Document service unavailable")

    # *** IMPORTANT: SAVE FILE CONTENT FIRST BEFORE ANY ASYNC OPERATIONS ***
    # This is the critical fix-we need to read the file content immediately
    # before FastAPI has a chance to close the temporary file
    file_content = None
    original_filename = None
    try:
        # Handle file content immediately to prevent "read of closed file" errors
        logger.info("Reading file content immediately")
        if file and file.filename:
            original_filename = file.filename
            # Read file content immediately - BEFORE any async operations
            file_content = file.file.read()
            # noinspection PyTypeChecker
            file_size = len(file_content)
            logger.info("Successfully read %s bytes from %s", file_size, original_filename)
        else:
            logger.error("Invalid file upload: missing file or filename")
    except Exception as e:
        logger.error("Error reading file content: %s", str(e))

    # If we can't read the file, we'll handle it in the streaming function

    # noinspection SqlResolve,PyDeprecation

    async def progress_stream():
        # Initialize variables to prevent "might be referenced before assignment" warnings
        document_id = None
        file_path = None
        file_path_absolute = None

        try:
            logger.info("Starting streaming upload process")
            # Start with the initial status
            yield (
                json.dumps(
                    {
                        "type": "status",
                        "content": {
                            "status": "processing",
                            "progress": 1,
                            "message": "Starting file upload...",
                        },
                    }
                )
                + "\n"
            )

            # Make sure file content was read successfully
            if not file_content:
                logger.error("File content couldn't be read")
                yield (
                    json.dumps(
                        {
                            "type": "error",
                            "content": {"detail": "Could not read file content. Please try a smaller file or use the standard upload."},
                        }
                    )
                    + "\n"
                )
                return

            # Use the filename we got before async operations
            if not original_filename:
                logger.error("No filename provided in upload")
                yield json.dumps({"type": "error", "content": {"detail": "No filename provided"}}) + "\n"
                return

            # Get and sanitize filename
            sanitized_filename = sanitize_filename(original_filename)
            logger.info("Processing upload request: %s", sanitized_filename)

            # --- Start Permission Check ---
            # noinspection PyTypeChecker
            access_check = db.execute(
                text(
                    """
                SELECT 1
                FROM collection_workspace_map
                WHERE collection_id = :collection_id AND owner_user_id = :user_id
                """
                ),
                {"collection_id": collection_id, "user_id": current_user.id},
            ).fetchone()

            if not access_check:
                logger.error("User %s does not have access to collection %s", current_user.id, collection_id)
                yield (
                    json.dumps(
                        {
                            "type": "error",
                            "content": {"detail": "Collection not found or user does not have access"},
                        }
                    )
                    + "\n"
                )
                return
            # --- End Permission Check ---

            # Get the workspace info from the cache table
            # noinspection PyTypeChecker
            workspace_info = db.execute(
                text("SELECT workspace_id, owner_user_id FROM collection_workspace_map WHERE collection_id = :collection_id"),
                {"collection_id": collection_id},
            ).fetchone()
            if not workspace_info:
                logger.error("Couldn't find workspace for collection %s", collection_id)
                yield (
                    json.dumps(
                        {
                            "type": "error",
                            "content": {"detail": "Internal error: Could not find workspace for collection"},
                        }
                    )
                    + "\n"
                )
                return

            # Use the owner's ID and workspace_id for the base path
            owner_id = workspace_info.owner_user_id
            workspace_id = workspace_info.workspace_id

            # Memory-only quota check (before doing any file I/O)
            if not should_store_file:
                quota_result = check_memory_only_quota(db, str(owner_id))
                if not quota_result["allowed"]:
                    yield json.dumps({"type": "error", "content": {"detail": quota_result["message"]}}) + "\n"
                    return

            # Check for a duplicate document (check both new and legacy columns)
            # noinspection PyTypeChecker
            existing_doc = db.execute(
                text(
                    """
                SELECT * FROM documents
                WHERE collection_id = :collection_id
                AND (filename = :filename OR filename = :filename OR title = :filename)
                """
                ),
                {"collection_id": collection_id, "filename": sanitized_filename},
            ).fetchone()

            if existing_doc:
                # Upgrade flow: if existing doc is memory-only and new upload IS a physical file, upgrade in-place
                if existing_doc.file_stored is False and should_store_file:
                    logger.info(
                        "Upgrading memory-only document '%s' (id=%s) to full document with physical file",
                        sanitized_filename,
                        existing_doc.id,
                    )
                    file_path_relative, file_path_absolute = get_upload_path(str(owner_id), collection_id, str(workspace_id), sanitized_filename)
                    os.makedirs(os.path.dirname(file_path_absolute), exist_ok=True)
                    with open(file_path_absolute, "wb") as out_file:
                        # noinspection PyTypeChecker
                        out_file.write(file_content)
                    # noinspection PyTypeChecker
                    db.execute(
                        text(
                            """
                            UPDATE documents
                            SET file_stored = true, file_path = :file_path, file_size = :file_size
                            WHERE id = :doc_id
                        """
                        ),
                        {
                            "file_path": file_path_relative,
                            # noinspection PyTypeChecker
                            "file_size": len(file_content),
                            "doc_id": str(existing_doc.id),
                        },
                    )
                    db.commit()
                    yield (
                        json.dumps(
                            {
                                "type": "status",
                                "content": {
                                    "status": "completed",
                                    "progress": 100,
                                    "message": "Memory-only document upgraded to full document with physical file",
                                    "document_id": str(existing_doc.id),
                                    "file_stored": True,
                                },
                            }
                        )
                        + "\n"
                    )
                    return

                logger.warning("Document with name '%s' already exists in collection %s", sanitized_filename, collection_id)
                yield (
                    json.dumps(
                        {
                            "type": "error",
                            "content": {
                                "detail": "A document with this name already exists in the collection",
                                "filename": sanitized_filename,
                            },
                        }
                    )
                    + "\n"
                )
                return

            # Resolve destination path — temp for memory-only, permanent for stored docs
            if should_store_file:
                file_path_relative, file_path_absolute = get_upload_path(str(owner_id), collection_id, str(workspace_id), sanitized_filename)
            else:
                import uuid as _uuid_mod

                temp_filename = f"scrapalot_{_uuid_mod.uuid4()}_{sanitized_filename}"
                file_path_absolute = f"/tmp/{temp_filename}"
                file_path_relative = ""  # not stored in permanent location

            # Upload Progress Flow (coordinated with PyMuPDF4LLM):
            # 2% - Preparing file upload
            # 3% - Starting file transfer
            # 4-8% - Uploading a file with incremental progress based on bytes written
            # 9% - Verifying file integrity
            # 10% - File upload completes
            # 10-85% - Document processing (handled by PyMuPDF4LLM in _stream_document_processing_internal)
            # 85-100% - Final processing steps

            # Send upload start status
            yield (
                json.dumps(
                    {
                        "type": "status",
                        "content": {
                            "status": "processing",
                            "progress": 2,
                            "message": "Preparing file upload...",
                        },
                    }
                )
                + "\n"
            )

            # Write the file content we read earlier with progress updates
            logger.info("Writing file to destination")
            try:
                # Create the file path first
                os.makedirs(os.path.dirname(file_path_absolute), exist_ok=True)

                # Get file size for progress calculation
                # noinspection PyTypeChecker
                total_size = len(file_content)
                logger.info("File size to write: %s bytes", total_size)

                if total_size == 0:
                    logger.error("Empty file uploaded")
                    yield json.dumps({"type": "error", "content": {"detail": "Empty file uploaded"}}) + "\n"
                    return

                # Start writing file status
                yield (
                    json.dumps(
                        {
                            "type": "status",
                            "content": {
                                "status": "processing",
                                "progress": 3,
                                "message": "Starting file transfer...",
                            },
                        }
                    )
                    + "\n"
                )

                # Write the file in chunks with progress updates
                chunk_size = max(1024 * 1024, total_size // 20)  # At least 1MB chunks, or divide into 20 parts
                written_bytes = 0

                with open(file_path_absolute, "wb") as out_file:
                    # Write the content in chunks to simulate progress
                    while written_bytes < total_size:
                        chunk_end = min(written_bytes + chunk_size, total_size)
                        # noinspection PyUnresolvedReferences
                        chunk = file_content[written_bytes:chunk_end]
                        out_file.write(chunk)
                        written_bytes += len(chunk)

                        # Calculate progress between 3% and 8%
                        progress_percent = 3 + int((written_bytes / total_size) * 5)

                        # Send progress update at completion or every chunk to ensure UI responsiveness
                        if written_bytes == total_size or (written_bytes // chunk_size) % 1 == 0:
                            yield (
                                json.dumps(
                                    {
                                        "type": "status",
                                        "content": {
                                            "status": "processing",
                                            "progress": progress_percent,
                                            "message": f"Uploading file... {int((written_bytes / total_size) * 100)}%",
                                        },
                                    }
                                )
                                + "\n"
                            )

                logger.info("Wrote file contents to %s", file_path_absolute)

                # Verify the file was written correctly
                actual_size = os.path.getsize(file_path_absolute)
                if actual_size != total_size:
                    logger.error("File size mismatch: expected %s, got %s", total_size, actual_size)
                    yield (
                        json.dumps(
                            {
                                "type": "error",
                                "content": {"detail": "File upload verification failed"},
                            }
                        )
                        + "\n"
                    )
                    # Clean up the file if it exists
                    if os.path.exists(file_path_absolute):
                        try:
                            os.unlink(file_path_absolute)
                        except OSError as cleanup_error:
                            logger.warning("Could not clean up file %s: %s", file_path_absolute, cleanup_error)
                    return

                logger.info("File saved successfully to %s", file_path_absolute)

                # Final upload progress
                yield (
                    json.dumps(
                        {
                            "type": "status",
                            "content": {
                                "status": "processing",
                                "progress": 9,
                                "message": "Verifying file integrity...",
                            },
                        }
                    )
                    + "\n"
                )

                # Small delay to show the verification step
                import asyncio

                await asyncio.sleep(0.1)

            except Exception as read_error:
                logger.error("Error handling file upload: %s", str(read_error))
                yield (
                    json.dumps(
                        {
                            "type": "error",
                            "content": {"detail": f"Error processing uploaded file: {read_error!s}"},
                        }
                    )
                    + "\n"
                )
                # Clean up the file if it exists
                if os.path.exists(file_path_absolute):
                    try:
                        os.unlink(file_path_absolute)
                    except OSError as cleanup_error:
                        logger.warning("Could not clean up file %s: %s", file_path_absolute, cleanup_error)
                return

            # Send progress updates after the file has been saved
            yield (
                json.dumps(
                    {
                        "type": "status",
                        "content": {
                            "status": "processing",
                            "progress": 10,
                            "message": f"File upload complete ({total_size} bytes)",
                        },
                    }
                )
                + "\n"
            )

            # Pre-generate thumbnail for PDFs and EPUBs (before document record is inserted)
            # Skip thumbnail generation for memory-only docs (temp file will be deleted after processing)
            thumbnail_metadata = None
            if should_store_file and file_path_absolute.lower().endswith((".pdf", ".epub")):
                try:
                    from src.main.service.document.thumbnail_service import ThumbnailService

                    if ThumbnailService.can_generate_thumbnail(file_path_absolute):
                        yield (
                            json.dumps(
                                {
                                    "type": "status",
                                    "content": {
                                        "status": "processing",
                                        "progress": 11,
                                        "message": "generatingThumbnail",  # Status code - frontend translates
                                    },
                                }
                            )
                            + "\n"
                        )

                        # Generate all thumbnail sizes
                        thumb_results = ThumbnailService.generate_all_thumbnails(file_path_absolute)
                        has_thumbnail = any(path is not None for path in thumb_results.values())

                        if has_thumbnail:
                            thumbnail_metadata = {
                                "has_thumbnail": True,
                                "has_custom": False,
                                "generated_at": time.time(),
                            }
                            logger.info("Pre-generated thumbnails for: %s", file_path_absolute)
                        else:
                            logger.warning("Failed to generate thumbnails for: %s", file_path_absolute)
                except Exception as thumb_error:
                    # Thumbnail generation failure is non-fatal
                    logger.warning("Thumbnail pre-generation failed for %s: %s", file_path_absolute, str(thumb_error))

            # File upload complete, generate document ID
            document_id = str(uuid.uuid4())
            logger.info("File uploaded successfully. Size: %s bytes, Document ID: %s", total_size, document_id)

            # Send status for file upload completion
            yield (
                json.dumps(
                    {
                        "type": "status",
                        "content": {
                            "status": "processing",
                            "progress": 10,
                            "message": "File upload complete, beginning processing",
                            "document_id": document_id,
                        },
                    }
                )
                + "\n"
            )

            # HARD quota gate — the billable size is the original upload size,
            # regardless of store_file/dedup. The frontend /storage/check call
            # is advisory only; this is the enforcement point for the
            # streaming path (the multipart path enforces in
            # _handle_document_upload).
            owner_info = get_workspace_owner_for_collection(db, collection_id)
            if owner_info:
                quota_owner_id = owner_info[0]
                quota_check = check_storage_quota(db, quota_owner_id, total_size)
                if not quota_check.get("allowed", True):
                    logger.warning("Storage quota exceeded for owner %s: %s", quota_owner_id, quota_check.get("message"))
                    if file_path_absolute and os.path.exists(file_path_absolute):
                        os.unlink(file_path_absolute)
                    yield (
                        json.dumps(
                            {
                                "type": "error",
                                "content": {
                                    "status": "error",
                                    "message": quota_check.get("message") or "Storage quota exceeded",
                                    "code": "storageQuotaExceeded",
                                },
                            }
                        )
                        + "\n"
                    )
                    return

            # Insert document record
            # Status depends on a should_auto_process flag: "pending" if the user processes later, "processing" if auto-processing
            initial_status = "processing" if should_auto_process else "pending"
            # CLAUDE.md rule #3: emit camelCase status code, never English.
            # Frontend translates via `knowledge.uploader.<code>`.
            initial_message = "uploadCompleteProcessing" if should_auto_process else "uploadCompleteClickCompose"

            # noinspection PyTypeChecker
            db.execute(
                text(
                    """
                INSERT INTO documents (id, title, filename, file_path, file_type, file_size, file_metadata, collection_id, processing_status, file_stored)
                VALUES (:document_id, :title, :filename, :file_path, :file_type, :file_size, CAST(:file_metadata AS jsonb), :collection_id, :processing_status, :file_stored)
            """
                ),
                {
                    "document_id": document_id,
                    "title": original_filename,
                    "filename": sanitized_filename,
                    "file_path": file_path_relative,
                    "file_type": file.content_type,
                    # Billable size of the original upload — recorded even for
                    # memory-only and deduplicated documents. Dedup saves OUR
                    # disk; the owner's quota still pays for the upload.
                    "file_size": total_size,
                    "file_metadata": json.dumps(
                        {
                            "size": total_size,
                            "filename": original_filename,
                            "content_type": file.content_type,
                            "progress": 0 if should_auto_process else 100,  # 100% upload complete for pending
                            "message": initial_message,
                            "status": initial_status,
                            "created_at": time.time(),
                            "file_stored": should_store_file,
                            **({"thumbnail": thumbnail_metadata} if thumbnail_metadata and should_store_file else {}),
                        },
                        default=enhanced_json_encoder,
                    ),
                    "collection_id": collection_id,
                    "processing_status": initial_status,
                    "file_stored": should_store_file,
                },
            )
            logger.info(
                "Document record prepared in database with ID: %s (status: %s, file_stored: %s)",
                document_id,
                initial_status,
                should_store_file,
            )

            # If should_auto_process is False, extract content for preview but don't process embeddings
            if not should_auto_process:
                # Extract content from the uploaded file for Document QA and preview
                try:
                    from src.main.utils.documents.utils import extract_document_content

                    # Send status update for content extraction (this is the slow part)
                    yield (
                        json.dumps(
                            {
                                "type": "status",
                                "content": {
                                    "status": "processing",
                                    "progress": 15,
                                    "message": "extractingDocumentContent",  # Status code - frontend translates
                                },
                            }
                        )
                        + "\n"
                    )

                    logger.info("Extracting content from document for preview: %s", file_path_absolute)
                    content, page_count = extract_document_content(file_path_absolute)

                    if content:
                        # Update document with extracted content
                        # noinspection PyTypeChecker
                        db.execute(
                            text("UPDATE documents SET content = :content, page_count = :page_count WHERE id = :document_id"),
                            {"content": content, "page_count": page_count, "document_id": document_id},
                        )
                        logger.info(
                            "Extracted content for document %s: %d chars, %s pages/chapters",
                            document_id,
                            len(content),
                            page_count or "unknown",
                        )
                    else:
                        logger.warning("No content extracted from document %s", document_id)
                except Exception as extract_error:
                    # Content extraction failure is non-fatal - document can still be processed later
                    logger.warning("Failed to extract content for document %s during upload: %s", document_id, str(extract_error))

                db.commit()
                logger.info(
                    "Document %s uploaded with status='pending', awaiting manual processing via Compose button",
                    document_id,
                )

                # Send completion status for upload (not processing)
                yield (
                    json.dumps(
                        {
                            "type": "status",
                            "content": {
                                "status": "pending",
                                "progress": 100,
                                "message": "Document uploaded successfully. Status: Pending. Click 'Compose' to process.",
                                "document_id": document_id,
                            },
                        }
                    )
                    + "\n"
                )
                return  # Exit - no processing needed

            # should_auto_process=True: Initialize job tracking BEFORE starting processing so jobs API can find it
            from src.main.service.document.document_job_manager import document_job_manager

            job_id = document_job_manager.initialize_job_tracking(document_id, collection_id, str(current_user.id))
            logger.info(
                "Initialized job tracking with job_id: %s for document %s, user_id: %s",
                job_id,
                document_id,
                current_user.id,
            )

            # Create Job database record for background processing
            from src.main.models.enums import JobStatus
            from src.main.models.sqlmodel_jobs import Job

            db_job = Job(
                id=job_id,  # Use the same UUID for both id and job_id
                job_id=job_id,
                job_type="document_processing",
                job_name=f"Process document: {file.filename}",
                status=JobStatus.PENDING.value,
                progress=0.0,
                description="Document uploaded, queued for processing",
                document_id=document_id,
                collection_id=collection_id,
                user_id=current_user.id,
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            )
            db.add(db_job)
            logger.info("Created Job database record with ID: %s", job_id)

            # Commit both document and job records before dispatching to a worker
            db.commit()
            logger.info("Document and Job records committed for %s", document_id)

            # Stream document processing inline via asyncio
            logger.info("Starting document processing for %s", document_id)
            processing_successful = False

            try:
                last_update = None
                async for update in _stream_document_processing_internal(
                    job_id=job_id,
                    file_path=file_path_absolute,
                    collection_id=collection_id,
                    user_id=current_user.id,
                    document_id=document_id,
                    initial_progress=10,
                ):
                    # Yield the update to the client first
                    yield update
                    last_update = update

                    # Check if this is a completion or error update
                    if '"type": "status"' in update and '"status": "completed"' in update:
                        processing_successful = True
                        logger.info("Document %s: Detected completion status in stream", document_id)
                    elif '"type": "error"' in update:
                        processing_successful = False
                        logger.warning("Document %s: Detected error status in stream", document_id)
                        break

                # Check if the stream ended successfully at the entity extraction phase (75% progress)
                # Entity extraction runs asynchronously, so the stream ends with "processing" status
                if not processing_successful and last_update:
                    if '"status": "processing"' in last_update and '"progress": 75' in last_update and "entity extraction" in last_update.lower():
                        processing_successful = True
                        logger.info("Document %s: Stream ended at entity extraction phase - successful handoff", document_id)

            except Exception as inline_error:
                logger.error("Inline processing failed: %s", inline_error)
                processing_successful = False

            # Rollback is not needed because we already committed
            logger.info("Document %s: Inline processing ended. processing_successful=%s", document_id, processing_successful)

            # For memory-only docs: clean up temp file and clear file_path in DB after processing
            if not should_store_file:
                if os.path.exists(file_path_absolute):
                    try:
                        os.remove(file_path_absolute)
                        logger.info("Deleted temp file for memory-only document %s: %s", document_id, file_path_absolute)
                    except OSError as temp_cleanup_err:
                        logger.warning("Could not delete temp file %s: %s", file_path_absolute, temp_cleanup_err)
                try:
                    with SessionLocal() as cleanup_db:
                        # noinspection PyTypeChecker
                        cleanup_db.execute(
                            text("UPDATE documents SET file_path = '' WHERE id = :doc_id"),
                            {"doc_id": document_id},
                        )
                        cleanup_db.commit()
                except Exception as db_cleanup_err:
                    # noinspection PyTypeChecker
                    logger.warning("Could not clear file_path for memory-only document %s: %s", document_id, db_cleanup_err)

            if not processing_successful:
                # Processing failed - document record already committed, mark as failed
                logger.error("Inline processing failed for document %s", document_id)
                yield json.dumps({"type": "error", "content": {"detail": "Document processing failed"}}) + "\n"
                return

        except Exception as ex:
            logger.exception("Error in document upload stream: %s", str(ex))

            # Check if this is a file-closed error
            if "read of closed file" in str(ex) or "seek of closed file" in str(ex):
                # noinspection PyTypeChecker
                error_msg = (
                    "The connection was interrupted during file upload. Please try again with a smaller file or use the standard upload button."
                )
            else:
                error_msg = f"Error processing document: {ex!s}"

            # Use the helper function for cleanup if file_path_absolute and document_id are available
            # noinspection PyTypeChecker
            file_path_for_cleanup = str(file_path_absolute) if "file_path_absolute" in locals() else ""
            # noinspection PyTypeChecker
            document_id_for_cleanup = str(document_id) if "document_id" in locals() else ""

            # Determine if we should use rollback (if document_id exists, it means a record was inserted but not committed)
            use_rollback = "document_id" in locals()

            error_response = _cleanup_failed_document_upload(
                file_path=file_path_for_cleanup,
                document_id=document_id_for_cleanup,
                db=db,
                error_message=error_msg,
                use_rollback=use_rollback,
            )
            yield error_response

    # Return a streaming response with proper headers to prevent buffering
    return StreamingResponse(
        progress_stream(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        },
    )


# noinspection PyUnusedFunction,PyShadowingNames
async def _process_document_background_internal(
    job_id: str,
    file_path: str,
    collection_id: str,
    user_id: str,
    document_id: str,
    initial_progress: int = 0,
):
    """
    Internal helper function to process a document in the background.
    Used by endpoints that need to trigger document processing without streaming.
    """
    # Create a database session for this operation
    db = SessionLocal()

    # Use the autowired document_service
    if not get_document_service(db):
        logger.error("Document service unavailable for background processing")
        return

    # Set the database session for this operation
    get_document_service(db)._db = db

    try:
        # Process the document using the service layer (consume the generator)
        async for update in get_document_service(db).process_document_stream(
            file_path=file_path,
            collection_id=collection_id,
            document_id=document_id,
            user_id=user_id,
            job_id=job_id,
            initial_progress=initial_progress,
        ):
            # Log progress updates but don't yield them (background processing)
            logger.debug("Background processing update: %s", update)

    except Exception as e:
        logger.exception("Error in background document processing: %s", str(e))
    finally:
        # Always close the database session
        db.close()


async def _stream_document_processing_internal(
    job_id: str,
    file_path: str,
    collection_id: str,
    user_id: str,
    document_id: str,
    initial_progress: int = 0,
):
    """
    Internal helper function to process a document and stream progress updates.
    Used by various endpoints that need to stream document processing.
    Updates follow the format: {"type": "status|error", "content": {...}}
    """
    # Create a database session for this operation
    db = SessionLocal()

    # Use the autowired document_service
    if not get_document_service(db):
        raise HTTPException(status_code=500, detail="Document service unavailable") from None

    # Set the database session for this operation
    get_document_service(db)._db = db

    try:
        # Process the document using the service layer and stream updates
        async for update in get_document_service(db).process_document_stream(
            file_path=file_path,
            collection_id=collection_id,
            document_id=document_id,
            user_id=user_id,
            job_id=job_id,
            initial_progress=initial_progress,
        ):
            # Forward the update as-is (already in {"type": "...", "content": {...}} format)
            yield update

    except Exception as e:
        logger.exception("Error in document processing stream: %s", str(e))
        # Return error status with explicit exception chaining
        error_detail = f"Error processing document: {e!s}"
        yield json.dumps({"type": "error", "content": {"detail": error_detail}}) + "\n"
    finally:
        # Always close the database session
        db.close()


# =============================================================================
# READING POSITION ENDPOINTS
# =============================================================================


# noinspection PyUnusedFunction
async def get_reading_position(
    document_id: str,
    current_user: User,
    db: SQLModelSession,
):
    """
    Get the user's reading position for a document.

    Args:
        document_id: The document UUID
        current_user: Current authenticated user
        db: Database session

    Returns:
        Reading position data or null if no position is saved
    """
    try:
        doc_uuid = UUID(document_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid document ID format") from None

    # Find a reading position for this user and document
    statement = select(ReadingPosition).where(
        ReadingPosition.user_id == current_user.id,
        ReadingPosition.document_id == doc_uuid,
    )
    reading_position = db.exec(statement).first()

    if not reading_position:
        return JSONResponse(content={"data": None})

    return JSONResponse(
        content={
            "data": {
                "id": str(reading_position.id),
                "document_id": str(reading_position.document_id),
                "page_number": reading_position.page_number,
                "scroll_position": reading_position.scroll_position,
                "epub_cfi": reading_position.epub_cfi,
                "last_tts_char_index": reading_position.last_tts_char_index,
                "total_pages": reading_position.total_pages,
                "updated_at": reading_position.updated_at.isoformat() if reading_position.updated_at else None,
            }
        }
    )


# noinspection PyUnusedFunction
async def save_reading_position(
    document_id: str,
    current_user: User,
    db: SQLModelSession,
    page_number: int = 1,
    scroll_position: float = 0.0,
    epub_cfi: str = None,
    last_tts_char_index: int = None,
    total_pages: int = None,
):
    """
    Save or update the user's reading position for a document.

    Args:
        document_id: The document UUID
        page_number: Current page number (1-indexed) for PDFs
        scroll_position: Scroll offset within the page for PDFs
        epub_cfi: EPUB Canonical Fragment Identifier for EPUBs
        last_tts_char_index: Character index for TTS resume
        total_pages: Total pages in the document
        current_user: Current authenticated user
        db: Database session

    Returns:
        Updated reading position data
    """
    try:
        doc_uuid = UUID(document_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid document ID format") from None

    # Verify document exists
    doc_statement = select(Document).where(Document.id == doc_uuid)
    document = db.exec(doc_statement).first()
    if not document:
        raise HTTPException(status_code=404, detail="Document not found") from None

    # Find existing reading position or create new
    statement = select(ReadingPosition).where(
        ReadingPosition.user_id == current_user.id,
        ReadingPosition.document_id == doc_uuid,
    )
    reading_position = db.exec(statement).first()

    if reading_position:
        # Update existing
        reading_position.page_number = page_number
        reading_position.scroll_position = scroll_position
        reading_position.epub_cfi = epub_cfi
        reading_position.last_tts_char_index = last_tts_char_index
        reading_position.total_pages = total_pages
    else:
        # Create new
        reading_position = ReadingPosition(
            user_id=current_user.id,
            document_id=doc_uuid,
            page_number=page_number,
            scroll_position=scroll_position,
            epub_cfi=epub_cfi,
            last_tts_char_index=last_tts_char_index,
            total_pages=total_pages,
        )
        db.add(reading_position)

    db.commit()
    db.refresh(reading_position)

    logger.info(
        "Saved reading position for user %s, document %s: page %d",
        current_user.id,
        document_id,
        page_number,
    )

    return JSONResponse(
        content={
            "success": True,
            "data": {
                "id": str(reading_position.id),
                "document_id": str(reading_position.document_id),
                "page_number": reading_position.page_number,
                "scroll_position": reading_position.scroll_position,
                "epub_cfi": reading_position.epub_cfi,
                "last_tts_char_index": reading_position.last_tts_char_index,
                "total_pages": reading_position.total_pages,
                "updated_at": reading_position.updated_at.isoformat() if reading_position.updated_at else None,
            },
        }
    )
