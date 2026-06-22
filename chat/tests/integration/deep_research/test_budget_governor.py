"""Pure tests for the research-loop budget governor (Move 2, increment 1).

The governor bounds the autonomous iteration loop by wall-clock and USD so a
background run can't iterate unboundedly (the smoke ran ~18 min uncapped).
These are deterministic — no DB, no LLM.
"""

from src.main.service.deep_research.deep_research_orchestrator import (
    _AUTONOMOUS_DEFAULT_MAX_RUNTIME_S,
    _budget_exceeded,
    _resolve_budget_caps,
)


class TestBudgetExceeded:
    def test_unbounded_never_exceeds(self):
        assert _budget_exceeded(elapsed_s=99999, spent_usd=99999, max_runtime_s=0, budget_usd=0) is False

    def test_runtime_cap_hit(self):
        assert _budget_exceeded(elapsed_s=1801, spent_usd=0, max_runtime_s=1800, budget_usd=0) is True

    def test_runtime_cap_not_hit(self):
        assert _budget_exceeded(elapsed_s=600, spent_usd=0, max_runtime_s=1800, budget_usd=0) is False

    def test_usd_cap_hit(self):
        assert _budget_exceeded(elapsed_s=10, spent_usd=8.01, max_runtime_s=0, budget_usd=8.0) is True

    def test_usd_cap_not_hit(self):
        assert _budget_exceeded(elapsed_s=10, spent_usd=2.0, max_runtime_s=0, budget_usd=8.0) is False


class TestResolveBudgetCaps:
    def test_autonomous_no_caps_gets_default_runtime(self):
        runtime, usd = _resolve_budget_caps(metadata=None, config={}, autonomous=True)
        assert runtime == _AUTONOMOUS_DEFAULT_MAX_RUNTIME_S
        assert usd == 0.0

    def test_interactive_no_caps_stays_unbounded(self):
        runtime, usd = _resolve_budget_caps(metadata=None, config={}, autonomous=False)
        assert runtime == 0.0
        assert usd == 0.0

    def test_metadata_overrides_default(self):
        runtime, usd = _resolve_budget_caps(
            metadata={"max_runtime_seconds": "120", "budget_usd": "2.5"},
            config={"autonomous": {"max_runtime_seconds": 9999, "budget_usd": 99}},
            autonomous=True,
        )
        assert runtime == 120.0  # metadata wins over config
        assert usd == 2.5

    def test_config_used_when_no_metadata(self):
        runtime, usd = _resolve_budget_caps(
            metadata={},
            config={"autonomous": {"max_runtime_seconds": 300, "budget_usd": 1.0}},
            autonomous=True,
        )
        assert runtime == 300.0
        assert usd == 1.0

    def test_garbage_values_ignored(self):
        runtime, usd = _resolve_budget_caps(
            metadata={"max_runtime_seconds": "not-a-number", "budget_usd": -5},
            config={},
            autonomous=False,
        )
        assert runtime == 0.0  # garbage + negative ignored, interactive → unbounded
        assert usd == 0.0
