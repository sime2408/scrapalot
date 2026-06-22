"""Regression tests for the CO_OCCURS_WITH weight watchdog circuit breaker.

`ensure_cooccurrence_weights_task` once wedged permanently in
``failed_persistent``: when it tripped it refreshed only the strike key, so
``last_null`` expired (6h TTL) while the strike key stayed alive forever. With
``last_null`` gone the strike count froze and the breaker could never detect the
NULL-count change that should re-arm it — it logged ERROR every 15 min and never
dispatched another recompute, leaving 120k+ edges unweighted.

These tests pin the pure transition (`next_cooccur_strike_state`) so the wedge
cannot return. No Neo4j / Redis / Celery — just the decision logic.
"""

from src.main.workers.tasks.graph_housekeeping_tasks import next_cooccur_strike_state

MAX = 3


def test_first_observation_does_not_strike():
    # No prior observation (fresh or expired last_null) → re-arm, never a strike.
    strikes, tripped = next_cooccur_strike_state(cur_null=1000, last_null=None, strikes=0, max_strikes=MAX)
    assert strikes == 0
    assert tripped is False


def test_unchanged_count_accumulates_strikes_then_trips():
    strikes, tripped = next_cooccur_strike_state(1000, 1000, 0, MAX)
    assert (strikes, tripped) == (1, False)
    strikes, tripped = next_cooccur_strike_state(1000, 1000, 1, MAX)
    assert (strikes, tripped) == (2, False)
    strikes, tripped = next_cooccur_strike_state(1000, 1000, 2, MAX)
    assert (strikes, tripped) == (3, True)


def test_progress_resets_strikes():
    # A drop in NULL edges means the recompute committed work → re-arm.
    strikes, tripped = next_cooccur_strike_state(cur_null=900, last_null=1000, strikes=2, max_strikes=MAX)
    assert strikes == 0
    assert tripped is False


def test_ingested_edges_reset_strikes_not_strike():
    # A RISE (ingestion added fresh NULL edges) is new work, NOT a no-progress
    # strike — the old `cur_null < last_null` logic wrongly struck here, which
    # is how the breaker first tripped under steady ingestion.
    strikes, tripped = next_cooccur_strike_state(cur_null=1200, last_null=1000, strikes=2, max_strikes=MAX)
    assert strikes == 0
    assert tripped is False


def test_tripped_breaker_rearms_when_count_moves():
    # THE wedge regression: already tripped (strikes=26), then the NULL count
    # changes (123600 → 123526). The breaker MUST re-arm, not stay frozen.
    strikes, tripped = next_cooccur_strike_state(cur_null=123526, last_null=123600, strikes=26, max_strikes=MAX)
    assert strikes == 0
    assert tripped is False


def test_tripped_breaker_rearms_when_last_null_expired():
    # The concrete production wedge: last_null key expired (None) while strikes
    # stayed at 26. Must re-arm rather than freeze on the stale strike count.
    strikes, tripped = next_cooccur_strike_state(cur_null=123526, last_null=None, strikes=26, max_strikes=MAX)
    assert strikes == 0
    assert tripped is False


def test_tripped_breaker_stays_tripped_while_genuinely_stuck():
    # If nothing moves, it stays tripped (pauses dispatch) — that part is correct.
    strikes, tripped = next_cooccur_strike_state(cur_null=123526, last_null=123526, strikes=3, max_strikes=MAX)
    assert tripped is True
    assert strikes == 4
