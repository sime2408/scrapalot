"""
Job Service - Job Tracking and Status Management

PRODUCTION MODULE - Background Workers
This is the new home for JobService, migrated from src.main.worker.jobs

CURRENT STATUS: ACTIVE
- Used by: src/main/controllers/jobs.py
- Provides: /jobs/active, /jobs/status/{job_id}, /jobs/cancel/{job_id} endpoints
- WebSocket updates for job progress

MIGRATION STATUS:
- COMPLETED - Moved from worker/jobs.py
- Maintains 100% API compatibility with legacy module
- See docs/WORKER_MIGRATION_PLAN.md for details

COMPATIBILITY:
- This module is a drop-in replacement for src.main.worker.jobs.JobService
- All method signatures and return types are identical
- Legacy module will be deprecated after migration is complete
"""

import json
import time
from typing import Any

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from src.main.config.database import DB_TYPE
from src.main.dto.jobs import JobProgressUpdateDTO
from src.main.models.enums import JobStatus
from src.main.utils.core.logger import get_logger
from src.main.utils.websocket.manager import websocket_manager

logger = get_logger(__name__)


def get_json_extract_clause(column_name: str, json_path: str) -> str:
    """
    Get the appropriate JSON extraction clause for the current database type.

    Args:
        column_name: Name of the JSON column
        json_path: JSON path (e.g., '$.status', '$.job_id')

    Returns:
        str: Database-specific JSON extraction clause
    """
    if DB_TYPE == "postgresql":
        # PostgreSQL uses ->> operator for text extraction
        # Convert $.status to status, $.job_id to job_id
        key = json_path.replace("$.", "")
        # Cast to JSONB to ensure proper JSON operator support
        return f"({column_name}::jsonb)->>'{key}'"
    else:
        # SQLite uses json_extract function
        return f"json_extract({column_name}, '{json_path}')"


# Merge processing_status with DocumentJobManager.jobs (single source of truth)
try:
    from src.main.service.document.document_job_manager import DocumentJobManager

    # Make processing_status reference the same dictionary as DocumentJobManager.jobs
    _processing_status = DocumentJobManager.jobs
    logger.info("JobService.processing_status merged with DocumentJobManager.jobs")
except ImportError as import_err:
    # Fallback: use separate dictionary if DocumentJobManager not available
    DocumentJobManager = None
    _processing_status = {}
    logger.warning("Could not merge with DocumentJobManager, using separate dict: %s", import_err)


# noinspection SqlResolve
class JobService:
    """Service for managing and tracking document processing jobs"""

    # Use the merged processing_status
    processing_status = _processing_status

    def __init__(self, db: Session):
        """
        Initialize the JobService with a database session.

        Args:
            db: Database session
        """
        self.db = db

    def get_active_document_ids(self, user_id: str) -> set[str]:
        """
        Get a set of document IDs that are currently processing and accessible by the user.
        Optimized a query to reduce nested subqueries and improve performance.

        Args:
            user_id: ID of the user to check access for

        Returns:
            Set of document IDs that are actively processing
        """
        # Status comes from the dedicated `processing_status` column — the
        # `file_metadata.status` JSON key is no longer authoritative (and is
        # being removed). The column is indexed and never drifts.
        active_docs_query = text("""
            SELECT DISTINCT d.id
            FROM documents d
            JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id
            WHERE d.processing_status IN ('pending', 'processing')
              AND cwm.owner_user_id = :user_id
            LIMIT 100
        """)

        try:
            # Add timeout for database query to prevent hanging
            result = self.db.execute(active_docs_query, {"user_id": user_id})
            return {row["id"] for row in result.mappings().fetchall()}
        except Exception as e:
            logger.error("Error fetching active document IDs for user %s: %s", user_id, str(e))
            # Return empty set on error to prevent complete failure
            return set()

    def get_active_jobs(self, user_id: str, include_details: bool = False) -> dict[str, Any]:
        """
        Get a list of active jobs for the given user.
        Optimized for performance during heavy processing periods.

        Args:
            user_id: ID of the user to get jobs for
            include_details: Whether to include full job details

        Returns:
            Dict containing active jobs count and details
        """
        try:
            # Create a dictionary of active jobs
            active_jobs = {}

            # Only log when there are jobs to track
            if JobService.processing_status:
                logger.debug(
                    "Checking processing_status for user %s, total jobs in memory: %s",
                    user_id,
                    len(JobService.processing_status),
                )

            # Check processing_status (now merged with DocumentJobManager.jobs)
            # FIRST: Check in-memory jobs and verify ownership via database
            for job_id, value in JobService.processing_status.items():
                # Skip non-dict entries and entries without document_id
                if not isinstance(value, dict) or "document_id" not in value:
                    continue

                # Filter out completed, failed, and canceled jobs (only show active jobs)
                job_status = value.get("status", JobStatus.PROCESSING.value)
                if job_status in [JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED]:
                    continue  # Skip completed/failed/canceled jobs

                document_id: str = value["document_id"]
                collection_id = value.get("collection_id")

                # Verify user has access to this collection (document might not be committed yet)
                try:
                    ownership_query = text("""
                        SELECT 1 FROM collection_workspace_map cwm
                        WHERE cwm.collection_id = :collection_id
                          AND cwm.owner_user_id = :user_id
                    """)
                    has_access = self.db.execute(ownership_query, {"collection_id": collection_id, "user_id": user_id}).fetchone()

                    if not has_access:
                        continue  # User doesn't have access to this collection

                except Exception as access_error:
                    logger.warning("Error checking collection access for job %s: %s", job_id, access_error)
                    continue

                # User has access - include this job
                # Create JobProgressUpdateDTO for this job
                collection_id = value.get("collection_id")
                job_dto = JobProgressUpdateDTO(
                    job_id=job_id,
                    document_id=document_id,
                    collection_id=str(collection_id) if collection_id else None,
                    status=value.get("status", JobStatus.PROCESSING.value),
                    progress=value.get("progress", 2),
                    message=value.get("message", "Processing document..."),
                )

                # Convert to dict and store in active_jobs
                job_dict = job_dto.model_dump()

                # If we need to get document and collection names,
                # This makes the endpoint more useful for UI display
                if include_details:
                    try:
                        # Use a timeout for this query to prevent blocking during heavy processing
                        # NOTE: Document might not be committed yet (upload_stream doesn't commit until processing succeeds)
                        doc_result = (
                            self.db.execute(
                                text(
                                    "SELECT d.filename, cwm.collection_name as collection_name "
                                    "FROM documents d "
                                    "JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id "
                                    "WHERE d.id = :document_id"
                                ),
                                {"document_id": document_id},
                            )
                            .mappings()
                            .fetchone()
                        )

                        if doc_result:
                            job_dict["filename"] = doc_result["filename"]
                            job_dict["collection_name"] = doc_result["collection_name"]
                        else:
                            # Document isn't committed yet - use fallback
                            logger.debug("Document %s not found in DB (likely not committed yet)", document_id)
                            job_dict["filename"] = f"Document {document_id[:8]}..."
                            job_dict["collection_name"] = "Processing..."
                    except Exception as detail_error:
                        logger.warning("Error fetching job details (non-critical): %s", str(detail_error))
                        # Continue even if details fetch fails - provide basic info
                        job_dict["filename"] = f"Document {document_id[:8]}..."
                        job_dict["collection_name"] = "Unknown Collection"
                else:
                    # If details not requested, provide minimal info
                    job_dict["filename"] = f"Document {document_id[:8]}..."
                    job_dict["collection_name"] = None

                active_jobs[job_id] = job_dict

        except Exception as e:
            logger.error("Error getting active jobs for user %s: %s", user_id, str(e))
            # Return empty result instead of failing completely
            active_jobs = {}

        # Check database for pending documents not in memory
        # This ensures we show jobs from server restarts
        try:
            # Only query database if we have few in-memory jobs to reduce load
            if len(active_jobs) < 10:  # Limit database queries when system is busy
                # Filter on the dedicated `processing_status` column. job_id
                # still lives in file_metadata until a future migration moves
                # it onto the `jobs` table fully.
                json_job_id_clause = get_json_extract_clause("d.file_metadata", "$.job_id")

                pending_docs_query = text(f"""
                    SELECT d.id as document_id, d.filename, d.collection_id, cwm.collection_name as collection_name,
                           d.file_metadata, d.processing_status, {json_job_id_clause} as job_id
                    FROM documents d
                    JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id
                    WHERE d.processing_status IN ('pending', 'processing')
                      AND cwm.owner_user_id = :user_id
                    LIMIT 20
                """)

                pending_docs = self.db.execute(pending_docs_query, {"user_id": user_id}).mappings().fetchall()
            else:
                # Skip database query when system is busy with many active jobs
                pending_docs = []

            for doc in pending_docs:
                try:
                    metadata: dict | None = None
                    if doc["file_metadata"]:
                        if isinstance(doc["file_metadata"], str):
                            metadata = json.loads(doc["file_metadata"])
                        elif isinstance(doc["file_metadata"], dict):
                            metadata = doc["file_metadata"]

                    if metadata and ("job_id" in metadata) and metadata["job_id"] not in active_jobs:
                        job_id = metadata["job_id"]

                        # Create a new entry for jobs not in memory
                        active_jobs[job_id] = {
                            "job_id": job_id,
                            "document_id": doc["document_id"],
                            "filename": doc["filename"] if include_details else None,
                            "collection_id": doc["collection_id"],
                            "collection_name": doc["collection_name"] if include_details else None,
                            # Source of truth is the column, not metadata.
                            "status": doc["processing_status"] or JobStatus.PROCESSING.value,
                            "progress": metadata.get("progress", 2),
                            "message": metadata.get("message", "Processing document..."),
                            "last_update_time": metadata.get("last_update_time", time.time()),
                        }

                        # Filter out None values if not including details
                        if not include_details:
                            active_jobs[job_id] = {k: v for k, v in active_jobs[job_id].items() if v is not None}

                except Exception as e:
                    logger.error("Error processing document metadata: %s", str(e))
                    # Continue to next document on error

        except Exception as db_error:
            logger.error("Database error fetching pending documents: %s", str(db_error))
            # Continue with what we have from the in-memory status

        # Third source: cross-process background-job registry (Redis hash).
        # Populated by Celery workers running `extract_entities` and
        # `sync_document_hierarchy_to_neo4j` — neither of which writes to the
        # in-memory `processing_status` dict (different container) nor flips
        # `documents.processing_status` (the doc is already `completed`, only
        # its graph layer is being rebuilt). Without this merge the UI's
        # `/jobs/active` returned `{}` for a 30-minute multi-doc graph
        # rebuild — user complaint "Nema aktivnog workera" on UFO library
        # while extract_entities was actively running for 6 docs.
        try:
            from src.main.utils.jobs.active import get_active_bg_jobs

            bg = get_active_bg_jobs(user_id)
            for job_id, payload in bg.items():
                if job_id in active_jobs:
                    # Entry already present via in-memory dict (publish_job_progress
                    # chain) or DB. The bg registry is authoritative for the
                    # display fields (filename, collection_name, task_name) which
                    # the older paths don't populate for background tasks like
                    # extract_entities / sync_document_hierarchy. Merge those in
                    # without disturbing the existing entry's progress / message /
                    # status (which may be more recent than the registry snapshot).
                    existing = active_jobs[job_id]
                    if include_details:
                        if not existing.get("filename") and payload.get("filename"):
                            existing["filename"] = payload["filename"]
                        if not existing.get("collection_name") and payload.get("collection_name"):
                            existing["collection_name"] = payload["collection_name"]
                    if not existing.get("task_name") and payload.get("task_name"):
                        existing["task_name"] = payload["task_name"]
                    continue
                active_jobs[job_id] = {
                    "job_id": job_id,
                    "document_id": payload.get("document_id"),
                    "collection_id": payload.get("collection_id"),
                    "status": payload.get("status", "processing"),
                    "progress": payload.get("progress", 0),
                    "message": payload.get("message", "Background task running"),
                    "filename": payload.get("filename") if include_details else None,
                    "collection_name": payload.get("collection_name") if include_details else None,
                    "task_name": payload.get("task_name"),
                }
                if not include_details:
                    active_jobs[job_id] = {k: v for k, v in active_jobs[job_id].items() if v is not None}
        except Exception as bg_err:
            logger.warning("active_bg_jobs merge failed (non-critical): %s", bg_err)

        # Fourth source: durable background research jobs in the `jobs` table.
        # Autonomous deep research runs as a Celery job that ONLY writes to
        # `jobs` (job_type='deep_research') — it never touches `documents` or
        # the in-memory registry above, so without this query the header job
        # indicator never surfaced a running research job (it sat invisible the
        # whole multi-minute run). Bound to fresh rows (updated within 5 min) so
        # a worker-killed zombie stuck at 'running' doesn't show forever — the
        # task refreshes `updated_at` on every progress publish.
        try:
            from datetime import UTC, datetime, timedelta

            from src.main.models.sqlmodel_jobs import Job

            fresh_cutoff = datetime.now(UTC) - timedelta(minutes=4)
            research_jobs = (
                self.db.query(Job)
                .filter(
                    Job.user_id == user_id,
                    Job.job_type == "deep_research",
                    Job.status.in_(["queued", "pending", "running"]),
                    Job.updated_at >= fresh_cutoff,
                )
                .all()
            )
            for job in research_jobs:
                jid = str(job.job_id)
                if jid in active_jobs:
                    continue
                active_jobs[jid] = {
                    "job_id": jid,
                    "document_id": None,
                    "collection_id": None,
                    "status": job.status or "running",
                    "progress": float(job.progress or 0),  # 0-100 scale
                    "message": "Deep research in progress",
                    "filename": (job.job_name or "Deep research") if include_details else None,
                    "collection_name": None,
                    "job_type": "deep_research",
                }
                if not include_details:
                    active_jobs[jid] = {k: v for k, v in active_jobs[jid].items() if v is not None}
        except Exception as research_err:
            logger.warning("deep_research jobs merge failed (non-critical): %s", research_err)

        # Only log when there are active jobs to report
        if active_jobs:
            logger.info("Returning %s active jobs for user %s", len(active_jobs), user_id)
            logger.debug("Active job IDs: %s", list(active_jobs.keys()))

        return {"active_jobs_count": len(active_jobs), "active_jobs": active_jobs}

    def get_job_status(self, job_id: str, user_id: str) -> dict[str, Any]:
        """
        Get a detailed status for a specific job.

        Args:
            job_id: ID of the job to get status for
            user_id: ID of the user requesting the job status

        Returns:
            Dict containing job status details

        Raises:
            HTTPException: If the job doesn't exist or the user doesn't have access
        """
        # Check if job exists in memory
        if job_id not in JobService.processing_status:
            # Try to find job in the database by job ID
            try:
                # Build database-agnostic query for job lookup
                json_job_id_clause = get_json_extract_clause("d.file_metadata", "$.job_id")

                job_query = text(f"""
                    SELECT d.id as document_id, d.filename, d.collection_id,
                           d.file_metadata, d.processing_status,
                           cwm.collection_name as collection_name,
                           cwm.owner_user_id = :user_id as is_owner
                    FROM documents d
                    JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id
                    WHERE {json_job_id_clause} = :job_id
                """)

                job_result = self.db.execute(job_query, {"job_id": job_id, "user_id": user_id}).mappings().fetchone()

                if not job_result:
                    # Background jobs (entity extraction `entity_*`, hierarchy
                    # sync `sync_hier_*`) run in scrapalot-workers and live ONLY
                    # in the per-user Redis registry — they have no in-memory
                    # entry and no `documents.file_metadata.job_id`. `/jobs/active`
                    # already surfaces them (it merges the registry), so the UI
                    # legitimately polls their status here; without this lookup
                    # every refresh 404s. The hash is keyed by user_id, so a hit
                    # is implicitly owned by the caller.
                    from src.main.utils.jobs.active import get_bg_job

                    bg_job = get_bg_job(user_id, job_id)
                    if bg_job:
                        return {
                            "job_id": job_id,
                            "document_id": bg_job.get("document_id"),
                            "filename": bg_job.get("filename", ""),
                            "collection_id": bg_job.get("collection_id"),
                            "collection_name": bg_job.get("collection_name"),
                            "status": bg_job.get("status", JobStatus.PROCESSING.value),
                            "progress": bg_job.get("progress", 0),
                            "message": bg_job.get("message", "Processing..."),
                            "last_update_time": bg_job.get("started_at", time.time()),
                            "estimated_completion_time": None,
                        }

                    raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

                # Check if user has access
                if not job_result["is_owner"]:
                    raise HTTPException(status_code=403, detail="You don't have permission to view this job")

                # Parse metadata (progress/message/timing only — status comes
                # from the dedicated column).
                metadata = {}
                if job_result["file_metadata"]:
                    if isinstance(job_result["file_metadata"], str):
                        metadata = json.loads(job_result["file_metadata"])
                    elif isinstance(job_result["file_metadata"], dict):
                        metadata = job_result["file_metadata"]

                # Create job status object
                job_status = {
                    "job_id": job_id,
                    "document_id": job_result["document_id"],
                    "filename": job_result["filename"],
                    "collection_id": job_result["collection_id"],
                    "collection_name": job_result["collection_name"],
                    "status": job_result["processing_status"] or JobStatus.PENDING.value,
                    "progress": metadata.get("progress", 0),
                    "message": metadata.get("message", "Unknown status"),
                    "last_update_time": metadata.get("last_update_time", time.time()),
                    "estimated_completion_time": metadata.get("estimated_completion_time"),
                }

                return job_status

            except HTTPException:
                raise
            except Exception as e:
                logger.error("Error retrieving job status from database: %s", str(e))
                # If we fail to get from DB, return a 404
                raise HTTPException(status_code=404, detail=f"Job {job_id} not found") from e

        # Job exists in memory, get its status
        job_info = JobService.processing_status[job_id]

        if not isinstance(job_info, dict) or "document_id" not in job_info:
            raise HTTPException(status_code=400, detail="Invalid job data in processing status")

        document_id = job_info["document_id"]

        # Check if user has access to this document
        try:
            access_check = (
                self.db.execute(
                    text("""
                SELECT d.filename, cwm.collection_name as collection_name,
                       d.collection_id, d.file_metadata,
                       cwm.owner_user_id = :user_id as is_owner
                FROM documents d
                JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id
                WHERE d.id = :document_id
                """),
                    {"document_id": document_id, "user_id": user_id},
                )
                .mappings()
                .fetchone()
            )

            if not access_check:
                raise HTTPException(status_code=404, detail=f"Document {document_id} not found")

            if not access_check["is_owner"]:
                raise HTTPException(status_code=403, detail="You don't have permission to view this job")

            # Create response with document and collection details
            job_status = {
                "job_id": job_id,
                "document_id": document_id,
                "filename": access_check["filename"],
                "collection_id": access_check["collection_id"],
                "collection_name": access_check["collection_name"],
            }

            # Add processing status details
            job_status.update(
                {
                    "status": job_info.get("status", JobStatus.PROCESSING.value),
                    "progress": job_info.get("progress", 0),
                    "message": job_info.get("message", "Processing..."),
                    "last_update_time": job_info.get("last_update_time", time.time()),
                    "estimated_completion_time": job_info.get("estimated_completion_time"),
                }
            )

            return job_status

        except HTTPException:
            raise
        except Exception as e:
            logger.error("Error checking document access: %s", str(e))
            raise HTTPException(status_code=500, detail=f"Failed to get job status: {e!s}") from e

    async def cancel_job(self, job_id: str, user_id: str) -> dict[str, Any]:
        """
        Cancel an active job.

        Args:
            job_id: ID of the job to cancel
            user_id: ID of the user requesting cancellation

        Returns:
            Dict containing success status

        Raises:
            HTTPException: If the job doesn't exist or the user doesn't have access
        """
        # Check if a job exists
        if job_id not in JobService.processing_status:
            raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

        job_info = JobService.processing_status[job_id]
        if not isinstance(job_info, dict) or "document_id" not in job_info:
            raise HTTPException(status_code=400, detail="Invalid job data")

        document_id = job_info["document_id"]

        # Check if a user has access to cancel this job
        document_check = self.db.execute(
            text(
                "SELECT 1 FROM documents d "
                "JOIN collection_workspace_map cwm ON d.collection_id = cwm.collection_id "
                "WHERE d.id = :document_id AND cwm.owner_user_id = :user_id"
            ),
            {"document_id": document_id, "user_id": user_id},
        ).fetchone()

        if not document_check:
            raise HTTPException(status_code=403, detail="You don't have permission to cancel this job")

        # Create a DTO for the canceled job
        collection_id = job_info.get("collection_id")
        job_dto = JobProgressUpdateDTO(
            job_id=job_id,
            document_id=document_id,
            collection_id=str(collection_id) if collection_id else None,
            status=JobStatus.FAILED,
            progress=0,
            message="jobCancelledByUser",
            last_update_time=time.time(),
        )

        # Update job info in memory
        job_info.update(job_dto.model_dump())

        # Update status in database (if document exists). Status is written
        # to the dedicated `processing_status` column; the rest of the DTO
        # (progress, message, timing) is merged into file_metadata. The
        # `status` key is explicitly NOT written to file_metadata anymore —
        # column is the single source of truth.
        try:
            db_result = self.db.execute(text("SELECT file_metadata FROM documents WHERE id = :document_id"), {"document_id": document_id}).fetchone()

            if db_result and db_result[0]:
                metadata = {}
                if isinstance(db_result[0], str):
                    try:
                        metadata = json.loads(db_result[0])
                    except json.JSONDecodeError:
                        metadata = {}
                elif isinstance(db_result[0], dict):
                    metadata = db_result[0]

                # Merge DTO fields into metadata, but strip status (column-only).
                dto_dict = job_dto.model_dump()
                dto_dict.pop("status", None)
                metadata.update(dto_dict)
                metadata.pop("status", None)

                # Write metadata + processing_status column atomically.
                self.db.execute(
                    text("UPDATE documents SET file_metadata = CAST(:metadata AS jsonb), processing_status = :status WHERE id = :document_id"),
                    {
                        "metadata": json.dumps(metadata),
                        "status": JobStatus.FAILED.value,
                        "document_id": document_id,
                    },
                )
                self.db.commit()
        except Exception as db_error:
            logger.error("Error updating document metadata for cancellation: %s", str(db_error))
            # Continue even if the database update fails

        # Send WebSocket notification
        await websocket_manager.send_job_update(job_id, job_dto.model_dump())

        return {"success": True, "message": "Job cancelled successfully"}

    @staticmethod
    def update_job_status(job_id: str, update_data: dict | JobProgressUpdateDTO) -> None:
        """
        Update the status of a job in the in - memory processing status.

        Args:
            job_id: ID of the job to update
            update_data: Dictionary or DTO with job status updates
        """
        if job_id not in JobService.processing_status:
            JobService.processing_status[job_id] = {}

        if isinstance(update_data, JobProgressUpdateDTO):
            update_dict = update_data.model_dump()
        else:
            update_dict = update_data

        JobService.processing_status[job_id].update(update_dict)

    @staticmethod
    async def send_job_update(job_id: str, update_data: dict | JobProgressUpdateDTO) -> None:
        """
        Send a WebSocket notification for a job update.

        Args:
            job_id: ID of the job to update
            update_data: Dictionary or DTO with job status updates
        """
        if isinstance(update_data, JobProgressUpdateDTO):
            update_dict = update_data.model_dump()
        else:
            update_dict = update_data

        await websocket_manager.send_job_update(job_id, update_dict)

    # noinspection PyMethodMayBeStatic,PyUnusedLocal
    def get_connector_jobs(self, user_id: str, workspace_id: str = None) -> dict[str, Any]:
        """
        Get active connector sync jobs for a user.

        Connector sync runs in-process via asyncio. Returns empty when no jobs are active.
        """
        return {}

    def get_all_active_jobs(self, user_id: str, workspace_id: str = None, include_details: bool = False) -> dict[str, Any]:
        """
        Get all active jobs (documents and connectors) for a user.

        Args:
            user_id: ID of the user
            workspace_id: Optional workspace ID to filter by
            include_details: Whether to include full details

        Returns:
            Dict containing all active jobs
        """
        # Get document processing jobs
        document_jobs = self.get_active_jobs(user_id, include_details)

        # Get connector sync jobs
        connector_jobs = self.get_connector_jobs(user_id, workspace_id)

        # Merge both job types
        all_jobs = document_jobs.get("active_jobs", {})
        all_jobs.update(connector_jobs)

        return {
            "active_jobs": all_jobs,
            "active_jobs_count": len(all_jobs),
            "document_jobs_count": document_jobs.get("active_jobs_count", 0),
            "connector_jobs_count": len(connector_jobs),
        }
