"""
JobsService gRPC Implementation

Implements the JobsService defined in jobs.proto.
Handles job tracking queries (active jobs, job status, cancellation).
"""

import grpc

from src.main.grpc import jobs_pb2, jobs_pb2_grpc
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# noinspection PyUnresolvedReferences
class JobsServiceServicer(jobs_pb2_grpc.JobsServiceServicer):
    """JobsService gRPC implementation."""

    async def GetActiveJobs(
        self,
        request: jobs_pb2.GetActiveJobsRequest,
        context: grpc.aio.ServicerContext,
    ) -> jobs_pb2.GetActiveJobsResponse:
        """Get active jobs for a user."""
        logger.info("JobsService.GetActiveJobs called - user_id=%s", request.user_id)

        try:
            from src.main.background.job_service import JobService
            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                job_service = JobService(db)
                result = job_service.get_all_active_jobs(
                    user_id=request.user_id,
                    include_details=request.include_details,
                )

                jobs = []
                for job_id, job_data in result.get("active_jobs", {}).items():
                    if isinstance(job_data, dict):
                        # `str(None) or None` returns the literal "None" string
                        # (truthy) — guard each optional field by checking
                        # truthiness BEFORE stringifying, so an absent or
                        # explicit-None value passes through as proto3 unset.
                        _doc = job_data.get("document_id") or None
                        _coll = job_data.get("collection_id") or None
                        _fn = job_data.get("filename") or None
                        _cn = job_data.get("collection_name") or None
                        jobs.append(
                            jobs_pb2.JobInfo(
                                job_id=str(job_id),
                                document_id=str(_doc) if _doc else None,
                                collection_id=str(_coll) if _coll else None,
                                status=str(job_data.get("status", "unknown")),
                                progress=float(job_data.get("progress", 0)),
                                message=str(job_data.get("message", "")),
                                filename=str(_fn) if _fn else None,
                                collection_name=str(_cn) if _cn else None,
                            )
                        )

                return jobs_pb2.GetActiveJobsResponse(
                    total_active_count=result.get("active_jobs_count", 0),
                    active_jobs=jobs,
                    total_document_count=result.get("document_jobs_count", 0),
                    total_connector_count=result.get("connector_jobs_count", 0),
                )
            finally:
                db.close()

        except Exception as e:
            logger.exception("Error in GetActiveJobs: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return jobs_pb2.GetActiveJobsResponse()

    async def GetJobStatus(
        self,
        request: jobs_pb2.GetJobStatusRequest,
        context: grpc.aio.ServicerContext,
    ) -> jobs_pb2.JobStatusResponse:
        """Get status of a specific job."""
        logger.info("JobsService.GetJobStatus called - job_id=%s, user_id=%s", request.job_id, request.user_id)

        try:
            from src.main.background.job_service import JobService
            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                job_service = JobService(db)
                result = job_service.get_job_status(
                    job_id=request.job_id,
                    user_id=request.user_id,
                )

                return jobs_pb2.JobStatusResponse(
                    job_id=str(result.get("job_id", request.job_id)),
                    document_id=str(result.get("document_id", "")) or None,
                    filename=str(result.get("filename", "")) or None,
                    collection_id=str(result.get("collection_id", "")) or None,
                    collection_name=str(result.get("collection_name", "")) or None,
                    status=str(result.get("status", "unknown")),
                    progress=float(result.get("progress", 0)),
                    message=str(result.get("message", "")),
                    last_update_time=str(result.get("last_update_time", "")) or None,
                    estimated_completion_time=str(result.get("estimated_completion_time", "")) or None,
                )
            finally:
                db.close()

        except Exception as e:
            logger.exception("Error in GetJobStatus: %s", str(e))
            if "404" in str(e) or "not found" in str(e).lower():
                context.set_code(grpc.StatusCode.NOT_FOUND)
            elif "403" in str(e) or "permission" in str(e).lower():
                context.set_code(grpc.StatusCode.PERMISSION_DENIED)
            else:
                context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return jobs_pb2.JobStatusResponse()

    async def CancelJob(
        self,
        request: jobs_pb2.CancelJobRequest,
        context: grpc.aio.ServicerContext,
    ):
        """Cancel an active job."""
        logger.info("JobsService.CancelJob called - job_id=%s, user_id=%s", request.job_id, request.user_id)

        try:
            from src.main.background.job_service import JobService
            from src.main.config.database import SessionLocal
            from src.main.grpc import common_pb2

            db = SessionLocal()
            try:
                job_service = JobService(db)
                result = await job_service.cancel_job(
                    job_id=request.job_id,
                    user_id=request.user_id,
                )

                return common_pb2.StatusResponse(
                    success=result.get("success", False),
                    message=result.get("message", ""),
                )
            finally:
                db.close()

        except Exception as e:
            logger.exception("Error in CancelJob: %s", str(e))
            from src.main.grpc import common_pb2

            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return common_pb2.StatusResponse(success=False, message=str(e))
