"""Background tasks for connector synchronization.

Handles:
- Triggering connector syncs (manual or automatic)
- Listing and syncing files from external sources
- Tracking sync progress and status
- Error handling and retry logic
"""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from src.main.background.db_utils import db_session
from src.main.background.progress_tracker import ProgressTracker
from src.main.background.tasks.file_sync_utils import (
    SYNC_STATUS_FAILED,
    SYNC_STATUS_PENDING,
    SYNC_STATUS_SYNCED,
    SYNC_STATUS_SYNCING,
    update_file_sync_status,
)
from src.main.connectors.exceptions import ConnectorError
from src.main.connectors.factory import get_connector_instance
from src.main.connectors.interfaces import FileListingConnector
from src.main.models.sqlmodel_connectors import ConnectorFileSync as DBConnectorFileSync
from src.main.models.sqlmodel_connectors import ConnectorSyncJob
from src.main.utils.connectors.utils import validate_connector_and_destination
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def sync_connector_destination(connector_id: str, destination_id: str, user_id: str, force: bool = False) -> dict:
    """
    Sync a specific connector destination.

    Args:
        connector_id: UUID of the connector
        destination_id: UUID of the sync destination
        user_id: UUID of the user triggering the sync
        force: Force sync even if already synced

    Returns:
        Dict with sync results
    """
    logger.info("Starting connector sync: connector=%s, destination=%s", connector_id, destination_id)

    task_id = str(uuid4())

    with db_session() as db:
        connector, destination = validate_connector_and_destination(db, connector_id, destination_id)

        if not connector.sync_enabled and not force:
            logger.warning("Sync disabled for connector: %s", connector_id)
            return {"success": False, "files_synced": 0, "files_failed": 0, "error": "Connector sync is disabled"}

        sync_job = ConnectorSyncJob(
            connector_id=UUID(connector_id),
            status="in_progress",
            started_at=datetime.now(UTC).isoformat(),
            celery_task_id=task_id,
        )
        db.add(sync_job)
        db.commit()

        progress_tracker = ProgressTracker(
            task_id=task_id,
            task_type="connector_sync",
            entity_id=UUID(connector_id),
            user_id=UUID(user_id),
            workspace_id=connector.workspace_id,
            db=db,
        )
        progress_tracker.start(current_step="Connecting to %s" % connector.source)

        try:
            connector_instance = get_connector_instance(
                source=connector.source,
                connector_id=connector_id,
                workspace_id=str(connector.workspace_id),
                credentials=connector.credential.credential_json if connector.credential else None,
            )

            if not isinstance(connector_instance, FileListingConnector):
                raise ConnectorError("Connector %s does not support file listing" % connector.source)

            all_files = list(connector_instance.list_files())
            total_files = len(all_files)
            progress_tracker.update(
                total_items=total_files,
                current_step="Found %d files to sync" % total_files,
            )

            files_synced = 0
            files_failed = 0

            for file_metadata in all_files:
                existing_sync: DBConnectorFileSync | None = None
                try:
                    # noinspection PyTypeChecker
                    existing_sync = (
                        db.query(DBConnectorFileSync)
                        .filter(
                            DBConnectorFileSync.connector_id == UUID(connector_id),
                            DBConnectorFileSync.external_file_id == file_metadata["file_id"],
                        )
                        .first()
                    )

                    if existing_sync and existing_sync.sync_status == SYNC_STATUS_SYNCED and not force:
                        logger.debug("Skipping already synced file: %s", file_metadata["file_name"])
                        continue

                    if not existing_sync:
                        file_sync = DBConnectorFileSync(
                            connector_id=UUID(connector_id),
                            external_file_id=file_metadata["file_id"],
                            external_file_path=file_metadata.get("file_path") or file_metadata["file_name"],
                            file_name=file_metadata["file_name"],
                            file_type=file_metadata.get("file_type"),
                            file_size=file_metadata.get("file_size"),
                            sync_status=SYNC_STATUS_PENDING,
                        )
                        db.add(file_sync)
                        db.commit()
                    else:
                        file_sync = existing_sync
                        file_sync.sync_status = SYNC_STATUS_SYNCING
                        db.commit()

                    from src.main.background.tasks.connector_document_processing import process_connector_document

                    process_connector_document(
                        connector_id=connector_id,
                        file_sync_id=str(file_sync.id),
                        destination_id=destination_id,
                        user_id=user_id,
                    )

                    files_synced += 1
                    progress_tracker.update(
                        processed_items=files_synced + files_failed,
                        current_step="Syncing files (%d/%d)" % (files_synced, total_files),
                    )

                except Exception as e:
                    logger.error("Failed to sync file %s: %s", file_metadata.get("file_name", "unknown"), str(e))
                    files_failed += 1
                    if existing_sync:
                        update_file_sync_status(db, str(existing_sync.id), SYNC_STATUS_FAILED, error=str(e))

            sync_job.status = "success"
            sync_job.finished_at = datetime.now(UTC).isoformat()
            sync_job.documents_processed = files_synced
            sync_job.documents_failed = files_failed
            db.commit()

            destination.last_synced_at = datetime.now(UTC).isoformat()
            if destination.auto_sync and destination.sync_frequency_minutes:
                destination.next_sync_at = (datetime.now(UTC) + timedelta(minutes=destination.sync_frequency_minutes)).isoformat()
            db.commit()

            logger.info("Connector sync completed: synced=%s, failed=%s", files_synced, files_failed)
            progress_tracker.complete(result_data={"files_synced": files_synced, "files_failed": files_failed})

            return {"success": True, "files_synced": files_synced, "files_failed": files_failed, "error": None}

        except ConnectorError as e:
            sync_job.status = "failed"
            sync_job.finished_at = datetime.now(UTC).isoformat()
            sync_job.error_message = str(e)
            db.commit()

            logger.error("Connector sync failed: %s", str(e))
            progress_tracker.fail(error_message=str(e))

            return {"success": False, "files_synced": 0, "files_failed": 0, "error": str(e)}
