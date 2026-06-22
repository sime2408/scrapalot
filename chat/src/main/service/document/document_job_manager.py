"""
Document Job Manager - Job tracking and progress management for document processing.

This module handles job lifecycle, progress updates, WebSocket streaming,
and resource cleanup for document processing operations.
"""

import asyncio
from datetime import UTC
import json
import time
from typing import Any
import uuid

from src.main.utils.core.logger import get_logger
from src.main.utils.documents.utils import enhanced_json_encoder
from src.main.utils.jobs.lifecycle import JobStatus

logger = get_logger(__name__)

# Import JobStatus with fallback handling

try:
    from src.main.models.sqlmodel_jobs import Job
except ImportError as e:
    logger.error("Failed to import Job model: %s", str(e))
    Job = None

try:
    from src.main.utils.websocket.manager import websocket_manager
except ImportError as e:
    logger.error("Failed to import websocket_manager: %s", str(e))
    websocket_manager = None


class DocumentJobManager:
    """Manages document processing jobs and progress tracking"""

    # Shared job storage with JobService (single source of truth)
    jobs: dict[str, dict[str, Any]] = {}

    def __init__(self, db=None):
        """Initialize the DocumentJobManager

        Args:
            db: Optional database session for updating document metadata
        """
        # Use class-level jobs dictionary (shared with JobService)
        # Track the last notification sent to prevent duplicates
        self._last_notifications: dict[str, dict[str, Any]] = {}
        self._db = db  # Database session for updating document metadata
        self._main_loop = None  # Store reference to main event loop for thread-safe coroutine scheduling
        logger.debug("DocumentJobManager initialized")
        self.user_jobs: dict[str, list[str]] = {}

    def initialize_job_tracking(self, document_id: str, collection_id: str, user_id: str = None) -> str:
        """
        Initialize job tracking for a new document processing job.

        Args:
            document_id: The document ID being processed
            collection_id: The collection ID the document belongs to
            user_id: The user ID who owns the document (optional but recommended for notifications)

        Returns:
            str: The generated job ID
        """
        # Capture event loop reference if called from async context
        # This enables WebSocket notifications from background threads
        if self._main_loop is None:
            try:
                self._main_loop = asyncio.get_running_loop()
                logger.debug("Captured main event loop reference for thread-safe WebSocket notifications")
            except RuntimeError:
                # Not in async context, loop will be captured later
                pass

        job_id = str(uuid.uuid4())
        time_of_job = time.time()
        job_data = {
            "job_id": job_id,
            "document_id": document_id,
            "collection_id": collection_id,
            "user_id": user_id,  # Include user_id for WebSocket notifications
            "status": JobStatus.PENDING,
            "progress": 0,
            "message": "jobInitialized",
            "created_at": time_of_job,
            "updated_at": time_of_job,
            "total_chunks": 0,
            "processed_chunks": 0,
            "errors": [],
            "phase_timings": {},
            "processing_metadata": {},
        }

        DocumentJobManager.jobs[job_id] = job_data
        logger.info("Initialized job tracking for job_id: %s, document_id: %s, user_id: %s", job_id, document_id, user_id)

        return job_id

    @staticmethod
    def record_phase_timing(job_id: str, phase: str, duration_s: float, metadata: dict = None) -> None:
        """Record timing for a processing phase (parse, chunk, embed, graph)."""
        if job_id in DocumentJobManager.jobs:
            DocumentJobManager.jobs[job_id].setdefault("phase_timings", {})[phase] = round(duration_s, 3)
            if metadata:
                DocumentJobManager.jobs[job_id].setdefault("processing_metadata", {}).update(metadata)

    @staticmethod
    def get_job_status(job_id: str, db=None) -> dict[str, Any] | None:
        """
        Get the current status of a job.

        Args:
            job_id: The job ID to check
            db: Database session (optional)

        Returns:
            Dict with job status information or None if not found
        """
        # First check in-memory jobs
        if job_id in DocumentJobManager.jobs:
            return DocumentJobManager.jobs[job_id]

        # If not found in memory, check the database if available
        if db and Job is not None:
            try:
                # noinspection PyTypeChecker
                # Filter by job_id (string), not id (UUID primary key)
                # noinspection PyTypeChecker
                job = db.query(Job).filter(Job.job_id == job_id).first()
                if job:
                    # Get collection_id from metadata if available
                    collection_id = job.job_metadata.get("collection_id") if job.job_metadata else None
                    return {
                        "job_id": job.job_id,
                        "status": job.status,
                        "progress": job.progress or 0,
                        "message": job.description or "Processing...",
                        "document_id": job.document_id,
                        "collection_id": collection_id,
                        "user_id": job.user_id,
                        "job_type": job.job_type,
                        "metadata": job.job_metadata,
                        "created_at": job.created_at.timestamp() if job.created_at else time.time(),
                        "updated_at": job.updated_at.timestamp() if job.updated_at else time.time(),
                        "started_at": job.started_at.timestamp() if job.started_at else None,
                        "completed_at": job.completed_at.timestamp() if job.completed_at else None,
                        "errors": job.error_message,
                    }
            except Exception as ex:
                logger.error("Error retrieving job from database: %s", str(ex))

        return None

    # noinspection PyTypeChecker
    def update_job_progress(self, job_id: str, progress: int, message: str, status: str = JobStatus.PROCESSING.value, db=None) -> None:
        """
        Update job progress and status.

        Args:
            job_id: The job ID to update
            progress: Progress percentage (0-100)
            message: Status message
            status: Job status
            db: Database session (optional, for user notifications)
        """
        if job_id in DocumentJobManager.jobs:
            # Detect job state transition from PENDING to PROCESSING (job started)
            old_status = DocumentJobManager.jobs[job_id].get("status")
            is_job_starting = old_status == JobStatus.PENDING and status == JobStatus.PROCESSING

            # Update job data
            DocumentJobManager.jobs[job_id].update({"progress": progress, "message": message, "status": status, "updated_at": time.time()})
            logger.debug("Updated job %s: %s%% - %s", job_id, progress, message)

            # Send WebSocket notification about job progress
            asyncio.create_task(self.send_document_notification(DocumentJobManager.jobs[job_id]))

            # Send user-level "job_started" notification on first transition to PROCESSING
            # Note: db is no longer required - user_id is stored in job_data
            if is_job_starting:
                asyncio.create_task(self._send_job_started_notification(job_id, db))

    def complete_job(
        self,
        job_id: str,
        success: bool = True,
        message: str = "Completed",
        error_details: str | None = None,
        db=None,
    ) -> None:
        """
        Mark a job as completed or failed.

        Args:
            job_id: The job ID to complete
            success: Whether the job completed successfully
            message: Completion message
            error_details: Error details if failed
            db: Optional database session for updating document metadata
        """
        if job_id in DocumentJobManager.jobs:
            status = JobStatus.COMPLETED if success else JobStatus.FAILED
            DocumentJobManager.jobs[job_id].update(
                {
                    "status": status,
                    "progress": 100 if success else DocumentJobManager.jobs[job_id].get("progress", 0),
                    "message": message,
                    "updated_at": time.time(),
                }
            )

            if error_details:
                DocumentJobManager.jobs[job_id]["errors"].append(error_details)

            # Update document metadata in database to mark as completed
            # Use provided db parameter or fall back to instance db
            db_session = db or self._db
            document_id = DocumentJobManager.jobs[job_id].get("document_id")
            if document_id and db_session:
                try:
                    import json

                    from sqlalchemy import text

                    # Get current document metadata
                    doc_result = db_session.execute(
                        text("SELECT file_metadata FROM documents WHERE id = :document_id"),
                        {"document_id": document_id},
                    ).fetchone()

                    new_processing_status = "completed" if success else "failed"

                    # Build processing_stats from phase timings (collected during processing)
                    phase_timings = DocumentJobManager.jobs[job_id].get("phase_timings", {})
                    proc_meta = DocumentJobManager.jobs[job_id].get("processing_metadata", {})
                    processing_stats_json = None
                    if phase_timings:
                        processing_stats = {
                            "total_duration_seconds": round(sum(phase_timings.values()), 3),
                            **{f"{k}_duration_seconds": v for k, v in phase_timings.items()},
                            "chunk_count": DocumentJobManager.jobs[job_id].get("total_chunks", 0),
                            **proc_meta,
                        }
                        # chunk_count / embedding_count above are captured BEFORE
                        # store_embeddings_sync's per-row SAVEPOINT filter drops
                        # chunks that fail to insert (NUL-byte trap, etc.). Re-
                        # query the actual pgvector count so the stored stats
                        # match reality. Reference: embedding_store_nul_byte_trap.
                        try:
                            real_chunks_row = db_session.execute(
                                text("SELECT COUNT(*) FROM langchain_pg_embedding WHERE cmetadata->>'document_id' = :did"),
                                {"did": str(document_id)},
                            ).fetchone()
                            if real_chunks_row is not None:
                                real_chunks = int(real_chunks_row[0])
                                processing_stats["chunk_count"] = real_chunks
                                processing_stats["embedding_count"] = real_chunks
                        except Exception as exc:
                            logger.warning(
                                "post-storage chunk_count refresh failed for %s: %s",
                                document_id,
                                exc,
                            )
                        processing_stats_json = json.dumps(processing_stats)

                    if doc_result and doc_result.file_metadata:
                        # Parse existing metadata (handle double-encoded JSON)
                        if isinstance(doc_result.file_metadata, str):
                            metadata = json.loads(doc_result.file_metadata)
                            if isinstance(metadata, str):
                                metadata = json.loads(metadata)
                        else:
                            metadata = doc_result.file_metadata

                        # Single source of truth: `processing_status` column. We
                        # used to mirror `metadata["status"] = ...` here too, but
                        # that dual-write drifted in production (15+ docs had
                        # column='failed'/'deferred' while metadata.status still
                        # said 'completed'). The status key is dropped from
                        # file_metadata; only timing stays here.
                        metadata.pop("status", None)
                        metadata["completed_at"] = time.time()

                        # Update document in database - file_metadata, processing_status, and processing_stats
                        update_sql = "UPDATE documents SET file_metadata = CAST(:metadata AS jsonb), processing_status = :processing_status"
                        params = {
                            "metadata": json.dumps(metadata),
                            "processing_status": new_processing_status,
                            "document_id": document_id,
                        }
                        if processing_stats_json:
                            update_sql += ", processing_stats = :stats"
                            params["stats"] = processing_stats_json
                        update_sql += " WHERE id = :document_id"
                        db_session.execute(text(update_sql), params)
                        db_session.commit()
                        logger.debug(
                            "Updated document %s processing_status to %s (file_metadata.status removed)",
                            document_id,
                            new_processing_status,
                        )

                        # Trigger document summarization for completed documents
                        if success and new_processing_status == "completed" and document_id:
                            # noinspection PyTypeChecker
                            asyncio.create_task(self._generate_document_summaries(str(document_id), db_session))
                    else:
                        # No file_metadata, but still update processing_status and processing_stats
                        update_sql = "UPDATE documents SET processing_status = :processing_status"
                        params = {"processing_status": new_processing_status, "document_id": document_id}
                        if processing_stats_json:
                            update_sql += ", processing_stats = :stats"
                            params["stats"] = processing_stats_json
                        update_sql += " WHERE id = :document_id"
                        # noinspection PyTypeChecker
                        db_session.execute(text(update_sql), params)
                        db_session.commit()
                        logger.debug(
                            "Updated document %s processing_status to %s (no file_metadata)",
                            document_id,
                            new_processing_status,
                        )

                        # Trigger document summarization for completed documents
                        if success and new_processing_status == "completed" and document_id:
                            # noinspection PyTypeChecker
                            asyncio.create_task(self._generate_document_summaries(str(document_id), db_session))
                except Exception as update_ex:
                    logger.warning("Failed to update document metadata for job %s: %s", job_id, str(update_ex))
                    if db_session:
                        db_session.rollback()

            logger.info("Job %s completed with status: %s", job_id, status)
            # Send WebSocket notification about job completion
            asyncio.create_task(self.send_document_notification(DocumentJobManager.jobs[job_id]))

            # Send user-level job lifecycle notification
            asyncio.create_task(self._send_user_job_lifecycle_notification(job_id, success, db_session))

    async def cancel_processing(self, job_id: str, db=None, _user_id: str = None) -> dict[str, Any]:
        """
        Cancel a document processing job.

        Args:
            job_id: The job ID to cancel
            db: Database session
            _user_id: User ID for permission check

        Returns:
            Dict with cancellation status
        """
        try:
            # Check if a job exists
            job_status = self.get_job_status(job_id, db)
            if not job_status:
                raise ValueError(f"Job {job_id} not found")

            # Update job status to cancelled
            if job_id in DocumentJobManager.jobs:
                DocumentJobManager.jobs[job_id].update({"status": JobStatus.CANCELLED, "message": "jobCancelledByUser", "updated_at": time.time()})

            # Update database if available
            if db and Job is not None:
                try:
                    # noinspection PyTypeChecker
                    # Filter by job_id (string), not id (UUID primary key)
                    # noinspection PyTypeChecker
                    job = db.query(Job).filter(Job.job_id == job_id).first()
                    if job:
                        from datetime import datetime

                        job.status = JobStatus.CANCELLED.value  # Use .value to get string from enum
                        job.description = "jobCancelledByUser"
                        job.updated_at = datetime.now(UTC)
                        if not job.completed_at:
                            job.completed_at = datetime.now(UTC)
                        db.commit()
                except Exception as cancel_ex:
                    db.rollback()
                    logger.warning("Failed to update job in database: %s", str(cancel_ex))

            logger.info("Job %s cancelled successfully", job_id)
            # Send WebSocket notification about job cancellation
            if job_id in DocumentJobManager.jobs:
                await asyncio.create_task(self.send_document_notification(DocumentJobManager.jobs[job_id]))

            return {"success": True, "message": f"Job {job_id} cancelled successfully", "job_id": job_id}

        except Exception as ex:
            logger.error("Error cancelling job %s: %s", job_id, str(ex))
            raise ex from ex

    def list_active_jobs(self, user_id: str = None, db=None) -> list[dict[str, Any]]:
        """
        List active jobs for a user.

        Args:
            user_id: User ID to filter by (optional)
            db: Database session (optional)

        Returns:
            List of active job information
        """
        active_jobs = []

        # Get jobs from memory
        for job_id, job_data in DocumentJobManager.jobs.items():
            # noinspection PyUnresolvedReferences
            if job_data["status"] in [JobStatus.PENDING, JobStatus.PROCESSING, JobStatus.QUEUED]:
                if user_id is None or job_id in self.user_jobs.get(user_id, []):
                    active_jobs.append(job_data.copy())

        # Get additional jobs from the database
        if db and Job is not None:
            try:
                active_statuses = ["pending", "processing", "queued"]
                # noinspection PyUnresolvedReferences
                query = db.query(Job).filter(Job.status.in_(active_statuses))

                # Filter by user if specified
                if user_id:
                    # noinspection PyTypeChecker
                    query = query.filter(Job.user_id == user_id)

                # noinspection PyUnresolvedReferences
                db_jobs = query.order_by(Job.created_at.desc()).all()

                for job in db_jobs:
                    # Skip jobs already in memory to avoid duplicates
                    if job.id not in DocumentJobManager.jobs:
                        # Get collection_id from metadata if available
                        collection_id = job.job_metadata.get("collection_id") if job.job_metadata else None
                        active_jobs.append(
                            {
                                "job_id": job.id,
                                "status": job.status,
                                "progress": job.progress or 0,
                                "message": job.description or "Processing...",
                                "document_id": job.document_id,
                                "collection_id": collection_id,
                                "user_id": job.user_id,
                                "job_type": job.job_type,
                                "created_at": job.created_at.timestamp() if job.created_at else time.time(),
                                "updated_at": job.updated_at.timestamp() if job.updated_at else time.time(),
                            }
                        )
            except Exception as ex:
                logger.warning("Failed to get jobs from database: %s", str(ex))

        return active_jobs

    def cleanup_completed_jobs(self, max_age_hours: int = 24) -> None:
        """
        Clean up old completed jobs from memory and auto-complete stuck jobs.

        Args:
            max_age_hours: Maximum age in hours for completed jobs
        """
        current_time = time.time()
        cutoff_time = current_time - (max_age_hours * 3600)
        stuck_job_timeout = current_time - (30 * 60)  # 30 minutes

        jobs_to_remove = []
        jobs_to_complete = []

        for job_id, job_data in DocumentJobManager.jobs.items():
            status_condition = job_data["status"] in [JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED]
            time_condition = job_data.get("updated_at", 0) < cutoff_time

            # Check for stuck jobs (processing for more than 30 minutes without updates)
            stuck_condition = job_data["status"] in [JobStatus.PROCESSING, JobStatus.PENDING] and job_data.get("updated_at", 0) < stuck_job_timeout

            if status_condition and time_condition:
                jobs_to_remove.append(job_id)
            elif stuck_condition:
                jobs_to_complete.append(job_id)

        # Auto-complete stuck jobs
        for job_id in jobs_to_complete:
            logger.warning(
                "Auto-completing stuck job %s (last updated: %s)",
                job_id,
                time.ctime(DocumentJobManager.jobs[job_id].get("updated_at", 0)),
            )
            self.complete_job(job_id, success=True, message="Processing completed (auto-completion due to timeout)", db=None)

        # Remove old completed jobs
        for job_id in jobs_to_remove:
            del DocumentJobManager.jobs[job_id]
            logger.debug("Cleaned up old job: %s", job_id)

        if jobs_to_remove:
            logger.info("Cleaned up %s old jobs", len(jobs_to_remove))
        if jobs_to_complete:
            logger.info("Auto-completed %s stuck jobs", len(jobs_to_complete))

    def add_user_job(self, user_id: str, job_id: str) -> None:
        """
        Associate a job with a user.

        Args:
            user_id: User ID
            job_id: Job ID
        """
        if user_id not in self.user_jobs:
            self.user_jobs[user_id] = []
        self.user_jobs[user_id].append(job_id)

    def remove_user_job(self, user_id: str, job_id: str) -> None:
        """
        Remove job association from a user.

        Args:
            user_id: User ID
            job_id: Job ID
        """
        if user_id in self.user_jobs and job_id in self.user_jobs[user_id]:
            self.user_jobs[user_id].remove(job_id)

    def check_user_job_limit(self, user_id: str, max_jobs: int = 3) -> dict[str, Any]:
        """
        Check if user has reached a maximum concurrent job limit.

        Args:
            user_id: User ID
            max_jobs: Maximum allowed concurrent jobs

        Returns:
            Dict with a check result
        """
        user_job_ids = self.user_jobs.get(user_id, [])
        active_statuses = ["pending", "processing", "queued"]
        active_jobs = [
            job_id for job_id in user_job_ids if job_id in DocumentJobManager.jobs and DocumentJobManager.jobs[job_id]["status"] in active_statuses
        ]

        if len(active_jobs) >= max_jobs:
            return {
                "success": False,
                "message": f"Maximum concurrent jobs limit ({max_jobs}) reached. Please wait for existing jobs to complete.",
                "active_jobs": len(active_jobs),
            }

        return {"success": True, "message": "jobLimitCheckPassed", "active_jobs": len(active_jobs)}

    @staticmethod
    async def _send_job_started_notification(job_id: str, db=None):
        """
        Send user-level job started notification.

        This eliminates the need for HTTP polling by notifying the frontend when new jobs start.

        Args:
            job_id: The job ID
            db: Database session (optional, for filename lookup)
        """
        try:
            if job_id not in DocumentJobManager.jobs:
                logger.warning("Job %s not found in jobs dict, cannot send user notification", job_id)
                return

            job_data = DocumentJobManager.jobs[job_id]
            collection_id = job_data.get("collection_id")
            document_id = job_data.get("document_id")
            user_id = job_data.get("user_id")  # user_id is already stored in job_data

            if not user_id:
                logger.warning("Missing user_id for job %s, cannot send user notification", job_id)
                return

            # Try to get filename from db if available, otherwise use fallback
            # noinspection PyUnresolvedReferences
            filename = f"Document {document_id[:8]}..." if document_id else "Unknown Document"
            if db and document_id:
                # noinspection PyBroadException
                try:
                    from sqlalchemy import text

                    result = db.execute(
                        text("SELECT filename FROM documents WHERE id = :document_id"),
                        {"document_id": document_id},
                    ).fetchone()
                    if result and result.filename:
                        filename = result.filename
                except Exception as e:
                    logger.debug("Could not fetch document filename for notification: %s", e)

            logger.info("🚀 Sending job_started notification for job %s to user %s", job_id, user_id)

            # Prepare job data for notification
            notification_job_data = {
                "job_id": job_id,
                "document_id": document_id,
                "collection_id": collection_id,
                "filename": filename,
                "status": job_data.get("status"),
                "progress": job_data.get("progress", 0),
                "message": job_data.get("message", "Processing started"),
            }

            # Send user-level notification
            # noinspection PyUnresolvedReferences
            await websocket_manager.send_user_job_notification(user_id, "job_started", notification_job_data)

        except Exception as ex:
            logger.error("Failed to send job started notification for job %s: %s", job_id, str(ex))

    @staticmethod
    async def _send_user_job_lifecycle_notification(job_id: str, success: bool, db=None):
        """
        Send user-level job lifecycle notification (job_completed/job_failed).

        This eliminates the need for HTTP polling by notifying the frontend when jobs complete.

        Args:
            job_id: The job ID
            success: Whether the job completed successfully
            db: Database session to query user_id
        """
        try:
            if job_id not in DocumentJobManager.jobs:
                logger.warning("Job %s not found in jobs dict, cannot send user notification", job_id)
                return

            job_data = DocumentJobManager.jobs[job_id]
            collection_id = job_data.get("collection_id")
            document_id = job_data.get("document_id")

            if not collection_id or not db:
                logger.warning("Missing collection_id or db session for job %s, cannot send user notification", job_id)
                return

            # Get user_id from collection
            from sqlalchemy import text

            result = db.execute(
                text("""
                    SELECT cwm.owner_user_id AS user_id, d.filename
                    FROM collection_workspace_map cwm
                    LEFT JOIN documents d ON d.id = :document_id
                    WHERE cwm.collection_id = :collection_id
                """),
                {"collection_id": collection_id, "document_id": document_id},
            ).fetchone()

            if not result:
                logger.warning("Could not find user for collection %s (job %s)", collection_id, job_id)
                return

            user_id = str(result.user_id)
            # noinspection PyUnresolvedReferences
            filename = result.filename if hasattr(result, "filename") else f"Document {document_id[:8]}..."

            # Determine event type
            event_type = "job_completed" if success else "job_failed"

            # Prepare job data for notification
            notification_job_data = {
                "job_id": job_id,
                "document_id": document_id,
                "collection_id": collection_id,
                "filename": filename,
                "status": job_data.get("status"),
                "progress": job_data.get("progress", 100 if success else 0),
                "message": job_data.get("message", "Completed" if success else "Failed"),
            }

            # Send user-level notification
            # noinspection PyUnresolvedReferences
            await websocket_manager.send_user_job_notification(user_id, event_type, notification_job_data)

        except Exception as ex:
            logger.error("Failed to send user job lifecycle notification for job %s: %s", job_id, str(ex))

    async def send_document_notification(self, notification_data: dict[str, Any]) -> bool:
        """
        Send a WebSocket notification about document processing.

        Args:
            notification_data: The notification data to send

        Returns:
            bool: True if sent successfully, False otherwise
        """
        try:
            logger.debug("send_document_notification() called with data keys: %s", notification_data.keys())
            # Extract job_id from notification data
            job_id = notification_data.get("job_id")
            if not job_id:
                logger.warning("No job_id in notification data, cannot send WebSocket update")
                return False
            job_id = str(job_id)
            logger.debug(
                "Sending WebSocket notification for job_id: %s, progress: %s%%",
                job_id,
                notification_data.get("progress"),
            )

            # Check for duplicate notifications to prevent spam
            notification_key = f"{job_id}_{notification_data.get('progress', 0)}_{notification_data.get('message', '')}"
            # noinspection PyTypeChecker
            last_notification = self._last_notifications.get(job_id)

            if last_notification:
                last_key = f"{job_id}_{last_notification.get('progress', 0)}_{last_notification.get('message', '')}"
                if notification_key == last_key:
                    logger.debug(
                        "Skipping duplicate notification for job %s: %s%% - %s",
                        job_id,
                        notification_data.get("progress", 0),
                        notification_data.get("message", ""),
                    )
                    return True

            # Store this notification as the last one sent
            # noinspection PyTypeChecker
            self._last_notifications[job_id] = notification_data.copy()

            # Log the notification for debugging purposes
            logger.info("Document notification: %s", json.dumps(notification_data, default=enhanced_json_encoder))

            # Send the notification via WebSocket manager
            if websocket_manager is None:
                logger.error("❌ websocket_manager is None! Cannot send WebSocket notification")
                return False

            logger.debug("🔵 Calling websocket_manager.send_job_update() for job %s", job_id)
            # noinspection PyUnresolvedReferences
            await websocket_manager.send_job_update(job_id, notification_data)
            logger.debug("websocket_manager.send_job_update() completed for job %s", job_id)
            return True
        except Exception as ex:
            logger.error("Failed to send document notification: %s", str(ex))
            return False

    @staticmethod
    def get_job_info_by_document_id(document_id: str) -> dict[str, Any] | None:
        """
        Get job information by document ID.

        Args:
            document_id: Document ID to search for

        Returns:
            Job information if found, None otherwise
        """
        for _job_id, job_data in DocumentJobManager.jobs.items():
            if job_data.get("document_id") == document_id:
                return job_data
        return None

    def process_progress_callback(self, job_id: str, progress_data: dict[str, Any]) -> None:
        """
        Process a progress callback from document processing.

        Args:
            job_id: Job ID
            progress_data: Progress information
        """
        if job_id in DocumentJobManager.jobs:
            # Update a job with progress data
            DocumentJobManager.jobs[job_id].update(
                {
                    "progress": progress_data.get("progress", 0),
                    "message": progress_data.get("message", "Processing..."),
                    "status": progress_data.get("status", JobStatus.PROCESSING),
                    "updated_at": time.time(),
                }
            )

            # Update chunk tracking if provided
            if "total_chunks" in progress_data:
                DocumentJobManager.jobs[job_id]["total_chunks"] = progress_data["total_chunks"]
            if "processed_chunks" in progress_data:
                DocumentJobManager.jobs[job_id]["processed_chunks"] = progress_data["processed_chunks"]

            # Send WebSocket notification to update UI progress in real-time
            # Handle both async context and executor thread context
            try:
                # Try to get running loop (works in async context)
                loop = asyncio.get_running_loop()
                # Store for future use from threads
                if self._main_loop is None:
                    self._main_loop = loop
                asyncio.create_task(self.send_document_notification(DocumentJobManager.jobs[job_id]))
            except RuntimeError:
                # No running loop (called from executor thread)
                # Use stored main loop reference
                if self._main_loop is not None:
                    asyncio.run_coroutine_threadsafe(self.send_document_notification(DocumentJobManager.jobs[job_id]), self._main_loop)
                else:
                    logger.warning("Cannot send WebSocket notification: no event loop reference available (call from async context first)")

    @staticmethod
    async def cleanup_job_status(job_id: str, delay_seconds: int = 300) -> None:
        """
        Clean up job status after a delay.

        Args:
            job_id: Job ID to clean up
            delay_seconds: Delay before cleanup
        """
        await asyncio.sleep(delay_seconds)
        if job_id in DocumentJobManager.jobs:
            del DocumentJobManager.jobs[job_id]
            logger.debug("Cleaned up job status for job: %s", job_id)

    @staticmethod
    async def _generate_document_summaries(document_id: str, db_session) -> None:
        """
        Generate chapter and book summaries for a completed document.

        This is called as a background task after document processing completes.

        Args:
            document_id: Document UUID string
            db_session: Database session
        """
        try:
            from uuid import UUID

            from src.main.models.sqlmodel_models import Document
            from src.main.service.document.document_summary_service import DocumentSummaryService

            # Convert document_id to UUID
            doc_uuid = UUID(document_id)

            # Get document to check if it has hierarchy
            document = db_session.get(Document, doc_uuid)

            if not document:
                logger.warning("Document %s not found for summarization", document_id)
                return

            # BUG FIX: Validate hierarchy has meaningful content, not just existence
            # Empty dict {} or {"sections": []} should be considered invalid
            if not document.document_hierarchy:
                logger.debug("Document %s has no hierarchy (null/empty), skipping summarization", document.filename)
                return

            # Check if hierarchy has actual sections/chapters
            hierarchy = document.document_hierarchy
            sections = hierarchy.get("sections", []) if isinstance(hierarchy, dict) else []
            if not sections or len(sections) == 0:
                logger.debug("Document %s has empty hierarchy (no sections), skipping summarization", document.filename)
                return

            # Check if sections have meaningful content (at least one with children or text)
            has_content = any(section.get("children") or section.get("text") or section.get("content") for section in sections)
            if not has_content:
                # BUG FIX #8: Fallback - check if embeddings have chapter metadata
                # The hierarchy dict may use different keys (e.g., chunk_range instead of children/text/content)
                # Also check embedding metadata as a secondary signal
                has_content = any(section.get("chunk_range") or section.get("heading_level") for section in sections)
                if not has_content:
                    try:
                        from sqlalchemy import text as sql_text

                        result = db_session.execute(
                            sql_text("""
                            SELECT DISTINCT cmetadata->>'chapter_title' as chapter_title
                            FROM langchain_pg_embedding e
                            JOIN langchain_pg_collection c ON e.collection_id = c.uuid
                            WHERE c.name = (SELECT collection_id::text FROM documents WHERE id = :doc_id)
                            AND cmetadata->>'chapter_title' IS NOT NULL
                        """),
                            {"doc_id": str(document.id)},
                        )
                        chapters = [r[0] for r in result.fetchall()]
                        if chapters:
                            logger.info(
                                "Document %s has %d chapters in embedding metadata, proceeding with summarization",
                                document.filename,
                                len(chapters),
                            )
                            has_content = True
                    except Exception as fallback_err:
                        logger.debug("Embedding metadata fallback check failed: %s", str(fallback_err))

                if not has_content:
                    logger.debug(
                        "Document %s has hierarchy but no content in sections, skipping summarization",
                        document.filename,
                    )
                    return

            logger.info("Starting background document summarization for: %s", document.filename)

            # Create summary service
            summary_service = DocumentSummaryService(db_session)

            # Generate summaries (chapters + book)
            result = await summary_service.generate_document_summaries(document_id=doc_uuid, user_id=document.user_id)

            if "error" in result:
                logger.warning("Document summarization failed for %s: %s", document.filename, result.get("error"))
            else:
                logger.info(
                    "Document summarization complete for %s: %d chapters, book summary: %s",
                    document.filename,
                    result.get("chapter_summaries_generated", 0),
                    result.get("book_summary_generated", False),
                )

        except Exception as summary_err:
            logger.warning(
                "Non-fatal error in background document summarization for %s: %s",
                document_id,
                str(summary_err),
                exc_info=True,
            )


# Global instance
document_job_manager = DocumentJobManager()
