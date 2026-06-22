"""Integration tests for the durable autonomous deep-research Celery job.

Poteza 1 (increment 1): the background research job runner. These tests cover
the plumbing deterministically (job-row upsert, system-LLM build, task
registration). A full end-to-end run (orchestrator to completion) is a heavy
real-LLM run verified manually / once dispatch is wired — not a fast test.

Run inside Docker: docker exec scrapalot-chat python -m pytest tests/integration/deep_research/test_research_job.py -v
"""

import uuid


class TestResearchJobPlumbing:
    def test_set_job_upserts_and_updates(self):
        """_set_job creates the jobs row on first call, then updates it."""
        from src.main.config.database import SessionLocal
        from src.main.models.sqlmodel_jobs import Job
        from src.main.workers.tasks.research_tasks import JOB_TYPE, _set_job

        job_id = f"test-research-{uuid.uuid4()}"
        try:
            _set_job(job_id, status="running", progress=0.05, job_name="unit test job")
            with SessionLocal() as db:
                # noinspection PyTypeChecker
                row = db.query(Job).filter(Job.job_id == job_id).first()
                assert row is not None
                assert row.job_type == JOB_TYPE
                assert row.status == "running"
                assert abs(row.progress - 0.05) < 1e-6

            _set_job(job_id, status="completed", progress=1.0, result={"research_plan_id": "abc"})
            with SessionLocal() as db:
                # noinspection PyTypeChecker
                row = db.query(Job).filter(Job.job_id == job_id).first()
                assert row.status == "completed"
                assert abs(row.progress - 1.0) < 1e-6
                assert row.result == {"research_plan_id": "abc"}
        finally:
            with SessionLocal() as db:
                # noinspection PyTypeChecker
                db.query(Job).filter(Job.job_id == job_id).delete()
                db.commit()

    def test_build_system_llm_returns_model(self):
        """_build_system_llm resolves the system provider into a usable LLM."""
        from src.main.config.database import SessionLocal
        from src.main.workers.tasks.research_tasks import _build_system_llm

        with SessionLocal() as db:
            llm = _build_system_llm(db)
        assert llm is not None
        # LangChain ChatOpenAI exposes the model name on `.model_name` or `.model`.
        model_name = getattr(llm, "model_name", None) or getattr(llm, "model", None)
        assert model_name, "system LLM has no model name"

    def test_task_is_registered(self):
        """The Celery app must know the research job task (discovered via include)."""
        from src.main.workers.celery_app import celery_app

        assert "scrapalot.run_deep_research" in celery_app.tasks
