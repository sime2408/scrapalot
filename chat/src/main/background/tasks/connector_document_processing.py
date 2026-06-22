"""
Connector document processing background tasks.

Handles fetching documents from external connectors (Google Drive, Notion, etc.)
and running them through the standard indexing pipeline.
"""

import os
import re
from uuid import UUID, uuid4

from sqlalchemy import text

from src.main.background.db_utils import db_session
from src.main.background.tasks.file_sync_utils import (
    SYNC_STATUS_FAILED,
    SYNC_STATUS_SYNCED,
    SYNC_STATUS_SYNCING,
    update_file_sync_status,
)
from src.main.connectors.exceptions import ConnectorError
from src.main.connectors.factory import get_connector_instance
from src.main.connectors.interfaces import FileListingConnector
from src.main.models.sqlmodel_connectors import ConnectorFileSync as DBConnectorFileSync
from src.main.models.sqlmodel_models import Document as DBDocument
from src.main.utils.connectors.utils import validate_connector_and_destination
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def process_connector_document(
    connector_id: str,
    file_sync_id: str,
    destination_id: str,
    user_id: str | None = None,
) -> dict:
    """
    Process a document from a connector through the full indexing pipeline.

    Fetches the document from the external source, saves content to disk,
    creates a Document + Job record, and runs the standard processing pipeline
    (text extraction, chunking, embedding, pgvector, Neo4j).

    Args:
        connector_id: UUID of the connector
        file_sync_id: UUID of the ConnectorFileSync record
        destination_id: UUID of the sync destination
        user_id: UUID of the user triggering the sync (for job tracking)

    Returns:
        Dict with processing results
    """
    logger.info("Processing connector document: file_sync=%s", file_sync_id)

    try:
        # Step 1: Load sync record and resolve target collection from DB
        with db_session() as db:
            # noinspection PyTypeChecker
            file_sync = db.query(DBConnectorFileSync).filter(DBConnectorFileSync.id == UUID(file_sync_id)).first()
            if not file_sync:
                raise ValueError("File sync record not found: %s" % file_sync_id)

            update_file_sync_status(db, file_sync_id, SYNC_STATUS_SYNCING)

            connector, destination = validate_connector_and_destination(db, connector_id, destination_id)

            if destination.destination_type == "collection" and destination.collection_id:
                collection_id = str(destination.collection_id)
            else:
                collection_id = _get_or_create_workspace_collection(
                    db=db,
                    workspace_id=str(connector.workspace_id),
                    connector_name=connector.name,
                )

            effective_user_id = user_id or str(getattr(connector, "user_id", "system"))

            # Snapshot fields needed outside this session
            file_name = file_sync.file_name
            external_file_id = file_sync.external_file_id
            connector_source = connector.source
            connector_workspace_id = str(connector.workspace_id)
            connector_credentials = connector.credential.credential_json if connector.credential else None

        # Step 2: Fetch document content from the external source (no DB needed)
        connector_instance = get_connector_instance(
            source=connector_source,
            connector_id=connector_id,
            workspace_id=connector_workspace_id,
            credentials=connector_credentials,
        )

        if not isinstance(connector_instance, FileListingConnector):
            raise ConnectorError("Connector %s does not support file fetching" % connector_source)

        logger.info("Fetching document from connector: %s", file_name)
        document = connector_instance.fetch_file(external_file_id)

        text_content = document.get_text_content()
        if not text_content or len(text_content.strip()) < 10:
            logger.warning("No usable text content for file: %s", file_name)
            with db_session() as db:
                update_file_sync_status(db, file_sync_id, SYNC_STATUS_FAILED, error="No text content extracted from source")
            return {"success": False, "document_id": None, "error": "No text content extracted"}

        # Step 3: Check for an existing document, write file to disk
        safe_filename = re.sub(r"[^\w\s\-.]", "_", document.metadata.file_name or file_name)

        with db_session() as db:
            existing_doc = (
                db.query(DBDocument)
                # noinspection PyTypeChecker
                .filter(
                    DBDocument.collection_id == UUID(collection_id),
                    DBDocument.filename == safe_filename,
                )
                .first()
            )
            if existing_doc:
                logger.info("Document already exists, skipping: %s (id=%s)", safe_filename, existing_doc.id)
                update_file_sync_status(db, file_sync_id, SYNC_STATUS_SYNCED, document_id=str(existing_doc.id))
                return {"success": True, "document_id": str(existing_doc.id), "error": None}

        # HARD storage-quota gate — connector syncs bypass the upload
        # endpoints, so enforce here before any bytes land on disk. The cost
        # is attributed to the workspace owner of the destination collection,
        # same as every other ingest path; the created document row carries
        # file_size, so the synced file also counts toward the billable sum.
        from src.main.utils.workspaces.access import get_workspace_owner_for_collection
        from src.main.utils.workspaces.quota import check_storage_quota

        incoming_bytes = len(text_content.encode("utf-8"))
        with db_session() as db:
            owner_info = get_workspace_owner_for_collection(db, collection_id)
            if owner_info:
                quota_check = check_storage_quota(db, owner_info[0], incoming_bytes)
                if not quota_check.get("allowed", True):
                    logger.warning(
                        "Connector sync rejected — storage quota exceeded for owner %s (%s)",
                        owner_info[0],
                        quota_check.get("message"),
                    )
                    update_file_sync_status(
                        db,
                        file_sync_id,
                        SYNC_STATUS_FAILED,
                        error=quota_check.get("message") or "Storage quota exceeded",
                    )
                    return {"success": False, "document_id": None, "error": quota_check.get("message") or "Storage quota exceeded"}

        upload_dir = os.path.join(os.getcwd(), "data", "upload", "connectors", collection_id)
        os.makedirs(upload_dir, exist_ok=True)

        if not safe_filename.endswith(".txt"):
            safe_filename = os.path.splitext(safe_filename)[0] + ".txt"

        file_path_abs = os.path.join(upload_dir, safe_filename)
        file_path_rel = os.path.relpath(file_path_abs, os.getcwd())

        with open(file_path_abs, "w", encoding="utf-8") as f:
            f.write(text_content)

        file_size = os.path.getsize(file_path_abs)

        # Step 4: Create the Document record and run the processing pipeline
        from src.main.background.tasks.document_pipeline import process_uploaded_document
        from src.main.service.document.documents import DocumentService

        document_id = str(uuid4())
        title = document.title or document.semantic_identifier or safe_filename

        with db_session() as db:
            document_service = DocumentService(db)
            result = document_service.create_document(
                document_id=document_id,
                title=title,
                filename=safe_filename,
                file_path=file_path_rel,
                collection_id=collection_id,
                original_filename=safe_filename,
                content_type="text/plain",
                file_size=file_size,
                user_id=effective_user_id,
                processing_status="pending",
            )

        if not result.get("success"):
            raise ValueError("Failed to create document record: %s" % result.get("message"))

        job_id = result["job_id"]
        logger.info("Created document %s with job %s for connector file %s", document_id, job_id, file_name)

        processing_result = process_uploaded_document(
            job_id=job_id,
            document_id=document_id,
            collection_id=collection_id,
            user_id=effective_user_id,
            file_path=file_path_rel,
        )

        # Step 5: Record the final sync status
        with db_session() as db:
            if processing_result.get("success"):
                update_file_sync_status(db, file_sync_id, SYNC_STATUS_SYNCED, document_id=document_id)
            else:
                update_file_sync_status(
                    db,
                    file_sync_id,
                    SYNC_STATUS_FAILED,
                    error=processing_result.get("error", "Processing failed"),
                    document_id=document_id,
                )

        logger.info("Connector document processed: %s (success=%s)", document_id, processing_result.get("success"))
        return {
            "success": processing_result.get("success", False),
            "document_id": document_id,
            "error": processing_result.get("error"),
        }

    except Exception as e:
        logger.exception("Failed to process connector document: %s", str(e))
        try:
            with db_session() as db:
                update_file_sync_status(db, file_sync_id, SYNC_STATUS_FAILED, error=str(e))
        except Exception as inner:
            logger.debug("Suppressed exception while recording failure: %s", inner)
        return {"success": False, "document_id": None, "error": str(e)}


def _get_or_create_workspace_collection(db, workspace_id: str, connector_name: str) -> str:
    """
    Look up the default collection for workspace-level connector syncs.

    Collections are managed by the Kotlin backend. If the target collection
    has not yet been synced into the collection_workspace_map cache, the sync
    cannot proceed.

    Args:
        db: Database session
        workspace_id: UUID of the workspace
        connector_name: Name of the connector

    Returns:
        Collection ID as string

    Raises:
        ValueError: If no matching collection exists in the cache
    """
    collection_name = "%s - Workspace Files" % connector_name

    result = db.execute(
        text("SELECT collection_id FROM collection_workspace_map WHERE workspace_id = :workspace_id AND collection_name = :name LIMIT 1"),
        {"workspace_id": workspace_id, "name": collection_name},
    ).fetchone()

    if result:
        return str(result[0])

    raise ValueError(
        "No collection found for workspace %s with name '%s'. "
        "The connector destination must reference an existing collection managed by the Kotlin backend." % (workspace_id, collection_name)
    )
