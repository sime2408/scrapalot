"""Pure tests for the hypothesis prove/disprove ledger (Move 2, increment 2).

The ledger tracks each hypothesis with a terminal verdict so the loop can stop
once everything is proven/refuted. Deterministic — no DB, no LLM.
"""

from src.main.service.deep_research.models.iteration_state import (
    HypothesisStatus,
    ResearchIterationState,
)


def _state() -> ResearchIterationState:
    return ResearchIterationState(objective="q", evolving_objective="q", current_objective="q")


class TestRecordHypothesis:
    def test_new_hypothesis_recorded_pending(self):
        s = _state()
        e = s.record_hypothesis("Fasting raises autophagy markers.")
        assert e is not None
        assert e.status == HypothesisStatus.PENDING
        assert len(s.hypotheses) == 1

    def test_duplicate_deduped_case_insensitive(self):
        s = _state()
        s.record_hypothesis("Fasting raises autophagy.")
        again = s.record_hypothesis("  fasting RAISES autophagy.  ")
        assert len(s.hypotheses) == 1
        assert again is s.hypotheses[0]

    def test_empty_is_noop(self):
        s = _state()
        assert s.record_hypothesis("") is None
        assert s.record_hypothesis(None) is None
        assert s.hypotheses == []


class TestSetStatus:
    def test_sets_verdict_confidence_evidence(self):
        s = _state()
        s.record_hypothesis("H1")
        e = s.set_hypothesis_status("H1", HypothesisStatus.SUPPORTED, confidence=0.9, evidence=["src1", "src2"])
        assert e.status == HypothesisStatus.SUPPORTED
        assert e.confidence == 0.9
        assert e.evidence == ["src1", "src2"]

    def test_records_if_absent(self):
        s = _state()
        e = s.set_hypothesis_status("H-new", HypothesisStatus.REFUTED)
        assert e is not None and e.status == HypothesisStatus.REFUTED
        assert len(s.hypotheses) == 1

    def test_confidence_clamped(self):
        s = _state()
        e = s.set_hypothesis_status("H1", HypothesisStatus.INCONCLUSIVE, confidence=1.7)
        assert e.confidence == 1.0


class TestAllResolved:
    def test_empty_not_resolved(self):
        assert _state().all_hypotheses_resolved() is False

    def test_all_terminal_resolved(self):
        s = _state()
        s.set_hypothesis_status("A", HypothesisStatus.SUPPORTED)
        s.set_hypothesis_status("B", HypothesisStatus.REFUTED)
        assert s.all_hypotheses_resolved() is True

    def test_any_pending_not_resolved(self):
        s = _state()
        s.set_hypothesis_status("A", HypothesisStatus.SUPPORTED)
        s.record_hypothesis("B")  # pending
        assert s.all_hypotheses_resolved() is False

    def test_inconclusive_not_resolved(self):
        s = _state()
        s.set_hypothesis_status("A", HypothesisStatus.INCONCLUSIVE)
        assert s.all_hypotheses_resolved() is False

    def test_survives_model_dump_roundtrip(self):
        """The ledger persists via research_state JSON (model_dump/validate)."""
        s = _state()
        s.set_hypothesis_status("A", HypothesisStatus.SUPPORTED, confidence=0.8)
        restored = ResearchIterationState.model_validate(s.model_dump())
        assert restored.all_hypotheses_resolved() is True
        assert restored.hypotheses[0].confidence == 0.8
