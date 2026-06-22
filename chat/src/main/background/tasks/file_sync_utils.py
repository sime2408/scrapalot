"""
Shared utilities for connector file sync status management.

Centralizes the file sync status update pattern duplicated
across connector_sync.py and document_processing.py.
"""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.orm import Session

from src.main.models.sqlmodel_connectors import ConnectorFileSync as DBConnectorFileSync
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Valid sync status values
SYNC_STATUS_PENDING = "pending"
SYNC_STATUS_SYNCING = "syncing"
SYNC_STATUS_SYNCED = "synced"
SYNC_STATUS_FAILED = "failed"


def update_file_sync_status(
    db: Session,
    file_sync_id: str,
    status: str,
    error: str | None = None,
    document_id: str | None = None,
) -> None:
    """
    Update the sync status of a ConnectorFileSync record.

    Args:
        db: Database session
        file_sync_id: UUID of the ConnectorFileSync record
        status: New status ("pending", "syncing", "synced", "failed")
        error: Error message to store (clears existing error when None)
        document_id: Optional UUID of the linked Document record
    """
    # noinspection PyTypeChecker
    file_sync = db.query(DBConnectorFileSync).filter(DBConnectorFileSync.id == UUID(file_sync_id)).first()

    if not file_sync:
        logger.warning("File sync record not found: %s", file_sync_id)
        return

    file_sync.sync_status = status
    file_sync.error_message = error
    file_sync.last_synced_at = datetime.now(UTC).isoformat()

    if document_id:
        file_sync.document_id = UUID(document_id)

    db.commit()
    logger.debug("File sync %s status → %s", file_sync_id, status)
