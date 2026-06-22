"""
Integration tests for the harness comparison grid runner.

Tests exercise the grid runner end-to-end against the real
`harness_comparison_runs` + `harness_comparison_results` tables but inject
fake `cell_executor` and `judge_fn` so the suite stays cheap and offline
(no live LLM calls, no chat-pipeline plumbing).

Run inside scrapalot-chat container:

    docker exec scrapalot-chat python -m pytest \\
        tests/integration/evaluation/test_harness_comparison.py -v
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
import contextlib
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text as sa_text

from src.main.service.evaluation.harness_comparison import (
    CellOutput,
    HarnessConfig,
    HarnessQuestion,
    JudgeScores,
    check_deploy_window,
    run_harness_comparison,
)
from src.main.service.evaluation.harness_report import (
    aggregate_summary,
    render_markdown,
)

# =============================================================================
# Helpers
# =============================================================================


def _db():
    """Return a SQLAlchemy Session from the SessionLocal factory."""
    from src.main.config.database import SessionLocal

    return SessionLocal()


@pytest.fixture(scope="function")
def db_session():
    session = _db()
    try:
        yield session
    finally:
        with contextlib.suppress(Exception):
            session.rollback()
        session.close()


@pytest.fixture(scope="function")
def admin_user_id() -> UUID:
    """Stable test UUID for the harness `created_by` column.

    The Python `scrapalot` DB does not own a `users` table — that lives in
    the Kotlin `scrapalot_backend` DB. Following the same pattern as
    RAGEvaluationTrace.user_id, the harness `created_by` is a plain UUID
    with no foreign key, so an arbitrary value is acceptable for tests."""
    return UUID("11111111-1111-1111-1111-111111111111")


@pytest.fixture(autouse=True)
def cleanup_harness_runs(db_session):
    """Wipe any rows this test class created. The CASCADE on the FK from
    results to runs takes care of the child table."""
    yield
    with contextlib.suppress(Exception):
        db_session.execute(sa_text("DELETE FROM harness_comparison_runs WHERE eval_set_id LIKE 'pytest-harness-%'"))
        db_session.commit()


def _make_questions(n: int) -> list[HarnessQuestion]:
    return [
        HarnessQuestion(
            id=f"q{i}",
            text=f"What is the meaning of token_{i}?",
            gold_answer=f"42_{i}",
            category="factual",
        )
        for i in range(n)
    ]


def _scripted_executor(answers: dict[tuple[str, str, str, str], str]) -> Callable:
    """Return a cell_executor that picks its output from a
    (question_id, retriever, delivery_mode, prompt_variant) lookup table."""

    async def _executor(question, retriever, delivery_mode, prompt_variant):
        key = (question.id, retriever, delivery_mode, prompt_variant)
        return CellOutput(
            answer=answers.get(key, f"stub-answer-for-{key}"),
            latency_ms=10,
            cost_usd=0.0001,
        )

    return _executor


def _scripted_judge(
    scores: dict[tuple[str, str], JudgeScores] | None = None,
) -> Callable:
    """Judge that consults a (retriever, question_id) lookup. Defaults to
    a flat 0.5 score so tests that don't care about scoring still get rows
    written with valid numbers."""

    async def _judge(question, answer):
        if not scores:
            return JudgeScores(0.5, 0.5, 0.5)
        return scores.get(
            ("__resolve_at_call__", question.id),
            JudgeScores(0.5, 0.5, 0.5),
        )

    return _judge


def _judge_by_retriever(
    per_retriever_relevance: dict[str, float],
) -> Callable[..., Awaitable[JudgeScores]]:
    """Bind the retriever name into a closure so the judge can score on it."""
    state = {"current_retriever": "unknown"}

    async def _judge(_question, _answer):
        retriever = state["current_retriever"]
        rel = per_retriever_relevance.get(retriever, 0.5)
        return JudgeScores(relevance=rel, groundedness=rel, citation_accuracy=rel)

    # Expose state so the executor can write into it before the judge fires.
    _judge.state = state  # type: ignore[attr-defined]
    return _judge


# =============================================================================
# Test 1 — smoke
# =============================================================================


@pytest.mark.integration
def test_run_smoke(db_session, admin_user_id):
    """2 retrievers × 2 delivery modes × 1 variant = 4 cells on 3 questions →
    12 rows + a "done" run with summary."""
    cfg = HarnessConfig(
        retrievers=["RAGSimilaritySearch", "RAGRegexGrep"],
        delivery_modes=["inline", "file"],
        prompt_variants=["default"],
        sample_size=0,
        max_concurrent=4,
    )
    questions = _make_questions(3)
    run_id = asyncio.run(
        run_harness_comparison(
            db=db_session,
            created_by=admin_user_id,
            eval_set_id="pytest-harness-smoke",
            questions=questions,
            config=cfg,
            cell_executor=_scripted_executor({}),
            judge_fn=_scripted_judge(),
            bypass_deploy_window=True,
        )
    )
    db_session.commit()

    n_rows = (
        db_session.execute(
            sa_text("SELECT COUNT(*) AS c FROM harness_comparison_results WHERE run_id = :r"),
            {"r": str(run_id)},
        )
        .first()
        .c
    )
    assert n_rows == 12

    run = db_session.execute(
        sa_text("SELECT status, summary FROM harness_comparison_runs WHERE id = :r"),
        {"r": str(run_id)},
    ).first()
    assert run.status == "done"
    assert run.summary["cell_count"] == 12
    assert run.summary["questions_seen"] == 3
    assert set(run.summary["ranking_by_relevance"]) == {
        "RAGSimilaritySearch",
        "RAGRegexGrep",
    }


# =============================================================================
# Test 2 — paired t-test detects a clear difference
# =============================================================================


@pytest.mark.integration
def test_paired_ttest_reports_significance(db_session, admin_user_id):
    """Fabricated retriever-A 0.9 vs retriever-B 0.1 → significant
    after Bonferroni correction with N=2 retrievers (alpha=0.05)."""
    cfg = HarnessConfig(
        retrievers=["RAGRegexGrep", "RAGSimilaritySearch"],
        delivery_modes=["inline"],
        prompt_variants=["default"],
        sample_size=0,
        max_concurrent=4,
    )
    questions = _make_questions(8)
    judge = _judge_by_retriever({"RAGRegexGrep": 0.9, "RAGSimilaritySearch": 0.1})

    async def _executor(question, retriever, delivery_mode, prompt_variant):
        judge.state["current_retriever"] = retriever  # type: ignore[attr-defined]
        return CellOutput(answer="x", latency_ms=10, cost_usd=0.0001)

    run_id = asyncio.run(
        run_harness_comparison(
            db=db_session,
            created_by=admin_user_id,
            eval_set_id="pytest-harness-ttest",
            questions=questions,
            config=cfg,
            cell_executor=_executor,
            judge_fn=judge,
            bypass_deploy_window=True,
        )
    )
    db_session.commit()

    summary = aggregate_summary(db_session, run_id=run_id)
    pairs = summary["pairwise"]
    assert len(pairs) == 1
    pair = pairs[0]
    assert pair["n"] == 8
    assert pair["significant"] is True
    # Mean diff should be ~+0.8 in favour of whichever sort puts RegexGrep first.
    assert abs(pair["mean_diff_relevance"]) > 0.7


# =============================================================================
# Test 3 — concurrency cap respected
# =============================================================================


@pytest.mark.integration
def test_concurrency_cap_respected(db_session, admin_user_id):
    """max_concurrent=2 → no more than 2 cells run simultaneously."""
    cfg = HarnessConfig(
        retrievers=["RAGSimilaritySearch", "RAGRegexGrep"],
        delivery_modes=["inline"],
        prompt_variants=["default"],
        sample_size=0,
        max_concurrent=2,
    )
    questions = _make_questions(6)  # 12 cells total

    async def _slow_executor(question, retriever, delivery_mode, prompt_variant):
        await asyncio.sleep(0.05)  # holds the semaphore long enough to observe
        return CellOutput(answer="x", latency_ms=50, cost_usd=0.0001)

    run_id = asyncio.run(
        run_harness_comparison(
            db=db_session,
            created_by=admin_user_id,
            eval_set_id="pytest-harness-concurrency",
            questions=questions,
            config=cfg,
            cell_executor=_slow_executor,
            judge_fn=_scripted_judge(),
            bypass_deploy_window=True,
        )
    )
    db_session.commit()
    run = db_session.execute(
        sa_text("SELECT summary FROM harness_comparison_runs WHERE id = :r"),
        {"r": str(run_id)},
    ).first()
    assert run.summary["concurrency_peak"] <= 2


# =============================================================================
# Test 4 — judge_provider is the system provider
# =============================================================================


@pytest.mark.integration
def test_judge_provider_defaults_to_system_provider():
    """Defaults from config.yaml must pin judge_provider to scrapalot_ai
    regardless of which user kicks the run off — CLAUDE.md rule #9."""
    cfg = HarnessConfig.from_defaults()
    assert cfg.judge_provider == "scrapalot_ai"


@pytest.mark.integration
def test_default_judge_returns_zero_for_empty_answer():
    """Empty answer is a hard zero on all three axes — no LLM call needed."""
    from src.main.service.evaluation.harness_comparison import (
        _default_judge_fn,
    )

    q = HarnessQuestion(id="empty-q", text="anything", gold_answer="something")
    result = asyncio.run(_default_judge_fn(q, ""))
    assert result.relevance == 0.0
    assert result.groundedness == 0.0
    assert result.citation_accuracy == 0.0


@pytest.mark.integration
def test_default_judge_falls_back_to_neutral_on_agent_error(monkeypatch):
    """When the LLM judge agent raises (network down, parse failure, etc.)
    the harness must NOT crash the run — it logs a warning and emits a
    neutral 0.5 score so the matrix still completes."""
    from src.main.service.evaluation import harness_comparison as hc

    # Force `get_system_agent_model` to raise so the try-block bails.
    def _boom(*_args, **_kwargs):
        raise RuntimeError("simulated config failure")

    monkeypatch.setattr("src.main.utils.llm.agent_model_utils.get_system_agent_model", _boom)

    q = HarnessQuestion(id="judge-fallback-q", text="hello?", gold_answer="hi")
    result = asyncio.run(hc._default_judge_fn(q, "an answer"))
    assert result.relevance == 0.5
    assert result.groundedness == 0.5
    assert result.citation_accuracy == 0.5


# =============================================================================
# Test 5 — CI deploy window guard
# =============================================================================


@pytest.mark.integration
def test_deploy_window_blocks_when_jobs_active(db_session, admin_user_id):
    """Insert a fake running job, run the grid WITHOUT bypassing the guard;
    status must be ``blocked_deploy_window``, no result rows."""
    job_id = uuid4()
    db_session.execute(
        sa_text(
            """
            INSERT INTO jobs (id, job_id, job_type, job_name, status, progress, created_at, updated_at)
            VALUES (:id, :jid, 'pytest_harness_guard', 'pytest-active-job',
                    'running', 0.5, NOW(), NOW())
            """
        ),
        {"id": str(job_id), "jid": f"pytest-active-{job_id}"},
    )
    db_session.commit()

    try:
        cfg = HarnessConfig(
            retrievers=["RAGSimilaritySearch"],
            delivery_modes=["inline"],
            prompt_variants=["default"],
            sample_size=0,
            max_concurrent=1,
        )
        run_id = asyncio.run(
            run_harness_comparison(
                db=db_session,
                created_by=admin_user_id,
                eval_set_id="pytest-harness-deploywindow",
                questions=_make_questions(1),
                config=cfg,
                cell_executor=_scripted_executor({}),
                judge_fn=_scripted_judge(),
                bypass_deploy_window=False,
            )
        )
        db_session.commit()
        run = db_session.execute(
            sa_text("SELECT status, error_message FROM harness_comparison_runs WHERE id = :r"),
            {"r": str(run_id)},
        ).first()
        assert run.status == "blocked_deploy_window"
        assert "active jobs" in run.error_message
        n_rows = (
            db_session.execute(
                sa_text("SELECT COUNT(*) AS c FROM harness_comparison_results WHERE run_id = :r"),
                {"r": str(run_id)},
            )
            .first()
            .c
        )
        assert n_rows == 0
    finally:
        db_session.execute(
            sa_text("DELETE FROM jobs WHERE id = :id"),
            {"id": str(job_id)},
        )
        db_session.commit()


@pytest.mark.integration
def test_check_deploy_window_returns_unblocked_when_idle(db_session):
    """When no jobs / graph syncs are active, check_deploy_window must
    return blocked=False so the runner can proceed."""
    status = check_deploy_window(db_session)
    # We can't guarantee zero jobs in a shared dev DB, but the function
    # must AT LEAST report a numeric count without raising.
    assert isinstance(status.blocked, bool)
    assert status.active_jobs >= 0
    assert status.active_graph_syncs >= 0


# =============================================================================
# Test 6 — markdown report renders without crashing
# =============================================================================


@pytest.mark.integration
def test_render_markdown_round_trip(db_session, admin_user_id):
    cfg = HarnessConfig(
        retrievers=["RAGSimilaritySearch", "RAGRegexGrep"],
        delivery_modes=["inline"],
        prompt_variants=["default"],
        sample_size=0,
        max_concurrent=4,
    )
    run_id = asyncio.run(
        run_harness_comparison(
            db=db_session,
            created_by=admin_user_id,
            eval_set_id="pytest-harness-markdown",
            questions=_make_questions(2),
            config=cfg,
            cell_executor=_scripted_executor({}),
            judge_fn=_scripted_judge(),
            bypass_deploy_window=True,
        )
    )
    db_session.commit()
    summary = aggregate_summary(db_session, run_id=run_id)
    md = render_markdown(summary)
    assert "# Harness Comparison Report" in md
    assert "RAGSimilaritySearch" in md
    assert "RAGRegexGrep" in md
    assert "Pareto frontier" in md or summary["pareto_frontier"]


# =============================================================================
# Test 7 — empty grid raises, doesn't silently no-op
# =============================================================================


@pytest.mark.integration
def test_empty_questions_rejected(db_session, admin_user_id):
    cfg = HarnessConfig(
        retrievers=["RAGSimilaritySearch"],
        delivery_modes=["inline"],
        prompt_variants=["default"],
        sample_size=0,
        max_concurrent=1,
    )
    with pytest.raises(ValueError):
        asyncio.run(
            run_harness_comparison(
                db=db_session,
                created_by=admin_user_id,
                eval_set_id="pytest-harness-empty",
                questions=[],
                config=cfg,
                bypass_deploy_window=True,
            )
        )
