"""
Job lifecycle helpers: status enum, cleanup, statistics, health report.

Merged from the historical ``job_cleanup_utils.py`` (cleanup, statistics)
and ``job_status_utils.py`` (status enum with import-safe fallback).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from src.main.utils.core.datetime_utils import parse_iso_datetime
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Status enum (with safe fallback for early-import scenarios)
# ---------------------------------------------------------------------------

try:
    from src.main.models.enums import JobStatus
except ImportError:  # pragma: no cover — only triggered if models package fails to import

    class JobStatus:  # type: ignore[no-redef]
        PENDING = "pending"
        PROCESSING = "processing"
        COMPLETED = "completed"
        FAILED = "failed"
        CANCELLED = "cancelled"
        QUEUED = "queued"


def get_job_status():
    """Return the ``JobStatus`` class (or the local fallback)."""
    return JobStatus


# ---------------------------------------------------------------------------
# Cleanup operations
# ---------------------------------------------------------------------------


def cleanup_old_jobs(db: Session, job_model, max_age_days: int = 7) -> dict[str, Any]:
    """Delete completed/failed jobs older than ``max_age_days``."""
    try:
        cutoff_date = datetime.now(UTC) - timedelta(days=max_age_days)
        # noinspection PyTypeChecker
        deleted_count = db.query(job_model).filter(job_model.status.in_(["completed", "failed"]), job_model.completed_at < cutoff_date).delete()
        db.commit()
        logger.info("Cleaned up %d old jobs older than %d days", deleted_count, max_age_days)
        return {"success": True, "deleted_count": deleted_count, "max_age_days": max_age_days}
    except Exception as e:
        logger.error("Error during job cleanup: %s", str(e))
        db.rollback()
        return {"success": False, "error": str(e), "deleted_count": 0, "max_age_days": max_age_days}


def cleanup_orphaned_jobs(db: Session, job_model, user_model) -> dict[str, Any]:
    """Delete jobs whose ``user_id`` no longer exists in the users table."""
    try:
        orphaned_jobs = db.query(job_model).filter(~job_model.user_id.in_(db.query(user_model.id).subquery()))
        deleted_count = orphaned_jobs.count()
        orphaned_jobs.delete(synchronize_session=False)
        db.commit()
        logger.info("Cleaned up %d orphaned jobs", deleted_count)
        return {"success": True, "deleted_count": deleted_count, "cleanup_type": "orphaned"}
    except Exception as e:
        logger.error("Error during orphaned job cleanup: %s", str(e))
        db.rollback()
        return {"success": False, "error": str(e), "deleted_count": 0, "cleanup_type": "orphaned"}


def cleanup_stuck_jobs(db: Session, job_model, max_runtime_hours: int = 24) -> dict[str, Any]:
    """Mark jobs running for more than ``max_runtime_hours`` as failed (timeout)."""
    try:
        cutoff_date = datetime.now(UTC) - timedelta(hours=max_runtime_hours)
        stuck_jobs = db.query(job_model).filter(
            job_model.status.in_(["pending", "running", "processing"]),
            job_model.created_at < cutoff_date,
        )
        updated_count = stuck_jobs.update(
            {
                "status": "failed",
                "completed_at": datetime.now(UTC),
                "error_message": f"Job timed out after {max_runtime_hours} hours",
            }
        )
        db.commit()
        logger.info("Marked %d stuck jobs as failed", updated_count)
        return {
            "success": True,
            "updated_count": updated_count,
            "max_runtime_hours": max_runtime_hours,
            "cleanup_type": "stuck",
        }
    except Exception as e:
        logger.error("Error during stuck job cleanup: %s", str(e))
        db.rollback()
        return {
            "success": False,
            "error": str(e),
            "updated_count": 0,
            "max_runtime_hours": max_runtime_hours,
            "cleanup_type": "stuck",
        }


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------


_STATUS_KEYS = ("pending", "running", "processing", "completed", "failed", "cancelled")


def get_job_statistics(db: Session, job_model) -> dict[str, Any]:
    """Return total count, per-status counts, and oldest/newest job timestamps."""
    try:
        total_jobs = db.query(job_model).count()
        # noinspection PyTypeChecker
        status_counts = {status: db.query(job_model).filter(job_model.status == status).count() for status in _STATUS_KEYS}
        oldest_job = db.query(job_model).order_by(job_model.created_at.asc()).first()
        newest_job = db.query(job_model).order_by(job_model.created_at.desc()).first()
        return {
            "total_jobs": total_jobs,
            "status_counts": status_counts,
            "oldest_job_date": getattr(oldest_job, "created_at", None) if oldest_job else None,
            "newest_job_date": getattr(newest_job, "created_at", None) if newest_job else None,
        }
    except Exception as e:
        logger.error("Error getting job statistics: %s", str(e))
        return {"error": str(e), "total_jobs": 0, "status_counts": {}}


# ---------------------------------------------------------------------------
# Comprehensive workflows
# ---------------------------------------------------------------------------


def perform_comprehensive_job_cleanup(
    db: Session,
    job_model,
    user_model=None,
    max_age_days: int = 7,
    max_runtime_hours: int = 24,
) -> dict[str, Any]:
    """Run all cleanup operations and return an aggregated report."""
    results: dict[str, Any] = {
        "success": True,
        "cleanup_operations": [],
        "total_deleted": 0,
        "total_updated": 0,
        "errors": [],
    }

    old_jobs_result = cleanup_old_jobs(db, job_model, max_age_days)
    results["cleanup_operations"].append({"type": "old_jobs", "result": old_jobs_result})
    if old_jobs_result["success"]:
        results["total_deleted"] += old_jobs_result["deleted_count"]
    else:
        results["success"] = False
        results["errors"].append(f"Old jobs cleanup failed: {old_jobs_result.get('error', 'Unknown error')}")

    if user_model:
        orphaned_jobs_result = cleanup_orphaned_jobs(db, job_model, user_model)
        results["cleanup_operations"].append({"type": "orphaned_jobs", "result": orphaned_jobs_result})
        if orphaned_jobs_result["success"]:
            results["total_deleted"] += orphaned_jobs_result["deleted_count"]
        else:
            results["success"] = False
            results["errors"].append(f"Orphaned jobs cleanup failed: {orphaned_jobs_result.get('error', 'Unknown error')}")

    stuck_jobs_result = cleanup_stuck_jobs(db, job_model, max_runtime_hours)
    results["cleanup_operations"].append({"type": "stuck_jobs", "result": stuck_jobs_result})
    if stuck_jobs_result["success"]:
        results["total_updated"] += stuck_jobs_result["updated_count"]
    else:
        results["success"] = False
        results["errors"].append(f"Stuck jobs cleanup failed: {stuck_jobs_result.get('error', 'Unknown error')}")

    results["final_statistics"] = get_job_statistics(db, job_model)

    logger.info(
        "Comprehensive job cleanup completed: %d deleted, %d updated, %s",
        results["total_deleted"],
        results["total_updated"],
        "success" if results["success"] else f"with {len(results['errors'])} errors",
    )
    return results


def get_job_health_report(db: Session, job_model, user_model=None) -> dict[str, Any]:
    """Generate a health report — overall + issues + recommendations."""
    try:
        report: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "overall_health": "healthy",
            "issues": [],
            "recommendations": [],
        }

        stats = get_job_statistics(db, job_model)
        report["statistics"] = stats

        total_jobs = stats.get("total_jobs", 0)
        status_counts = stats.get("status_counts", {})

        active_jobs = status_counts.get("pending", 0) + status_counts.get("running", 0) + status_counts.get("processing", 0)
        if active_jobs > 100:
            report["issues"].append(f"High number of active jobs: {active_jobs}")
            report["recommendations"].append("Consider increasing worker capacity or investigating stuck jobs")

        failed_jobs = status_counts.get("failed", 0)
        if total_jobs > 0 and (failed_jobs / total_jobs) > 0.1:
            report["issues"].append(f"High failure rate: {failed_jobs}/{total_jobs} ({(failed_jobs / total_jobs) * 100:.1f}%)")
            report["recommendations"].append("Investigate common failure causes and improve error handling")

        oldest_date = stats.get("oldest_job_date")
        if oldest_date:
            if isinstance(oldest_date, str):
                oldest_date = parse_iso_datetime(oldest_date)
            age_days = (datetime.now(UTC) - oldest_date).days
            if age_days > 30:
                report["issues"].append(f"Very old jobs present: oldest job is {age_days} days old")
                report["recommendations"].append("Consider running job cleanup to remove old completed/failed jobs")

        if user_model:
            try:
                orphaned_count = db.query(job_model).filter(~job_model.user_id.in_(db.query(user_model.id).subquery())).count()
                if orphaned_count > 0:
                    report["issues"].append(f"Orphaned jobs detected: {orphaned_count}")
                    report["recommendations"].append("Run orphaned job cleanup to remove jobs with invalid user references")
            except Exception as e:
                logger.warning("Could not check for orphaned jobs: %s", str(e))

        issue_count = len(report["issues"])
        if issue_count == 0:
            report["overall_health"] = "healthy"
        elif issue_count <= 2:
            report["overall_health"] = "warning"
        else:
            report["overall_health"] = "critical"
        return report

    except Exception as e:
        logger.error("Error generating job health report: %s", str(e))
        return {
            "timestamp": datetime.now(UTC).isoformat(),
            "overall_health": "error",
            "error": str(e),
            "issues": ["Failed to generate health report"],
            "recommendations": ["Check database connectivity and job model configuration"],
        }
