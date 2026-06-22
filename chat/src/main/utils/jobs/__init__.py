"""
Job utilities sub-package.

Groups background-job concerns into a cohesive unit:
dispatching tasks, tracking the active set in Redis,
publishing progress over pub/sub, and lifecycle cleanup.

Modules:
    dispatcher - asyncio-based background task dispatch
                 (dispatch_background_task, run_background_task_async, get_worker_health)
    active     - cross-process Redis registry of active background jobs
                 (register_bg_job, update_bg_job_progress, unregister_bg_job, get_active_bg_jobs)
    progress   - progress callbacks (in-process queues) and Redis pub/sub publisher
                 (create_streaming_progress_callback, create_database_progress_callback,
                  process_streaming_updates, drain_remaining_updates, publish_job_progress)
    lifecycle  - cleanup + health-report helpers for the jobs table
                 (cleanup_old_jobs, cleanup_orphaned_jobs, cleanup_stuck_jobs,
                  get_job_statistics, perform_comprehensive_job_cleanup, get_job_health_report,
                  get_job_status, JobStatus)
"""
