"""Tests for the adversarial hypothesis verifier (Move 2, increment 3).

Pure: verdict-string → ledger-status mapping. Real-LLM (system provider): the
verifier returns a valid structured verdict, and an evidence-free strong claim
is NOT called 'supported' (adversarial strictness).

Run inside Docker: docker exec scrapalot-chat python -m pytest tests/integration/deep_research/test_hypothesis_verifier.py -v
"""

import asyncio

import pytest

from src.main.service.deep_research.agents.hypothesis_verifier_agent import (
    HypothesisVerifierAgent,
    _verdict_to_status,
)
from src.main.service.deep_research.models.iteration_state import HypothesisStatus


class TestVerdictToStatus:
    def test_known_verdicts_map(self):
        assert _verdict_to_status("supported") == HypothesisStatus.SUPPORTED
        assert _verdict_to_status("refuted") == HypothesisStatus.REFUTED
        assert _verdict_to_status("inconclusive") == HypothesisStatus.INCONCLUSIVE

    def test_unknown_maps_to_inconclusive(self):
        assert _verdict_to_status("garbage") == HypothesisStatus.INCONCLUSIVE
        assert _verdict_to_status("") == HypothesisStatus.INCONCLUSIVE


def _verifier() -> HypothesisVerifierAgent:
    from src.main.config.database import SessionLocal
    from src.main.utils.llm.agent_model_utils import get_system_agent_model
    from src.main.workers.tasks.research_tasks import _build_system_llm

    config = get_system_agent_model(agent_type="synthesis")
    with SessionLocal() as db:
        llm = _build_system_llm(db)
    return HypothesisVerifierAgent(llm, api_key=config.api_key, provider_type=config.provider_type)


@pytest.mark.integration
@pytest.mark.slow
class TestVerifierRealLLM:
    def test_returns_valid_structured_verdict(self):
        verifier = _verifier()
        verdict = asyncio.get_event_loop().run_until_complete(
            verifier.verify(
                hypothesis="Regular aerobic exercise lowers resting heart rate in healthy adults.",
                evidence=(
                    "Meta-analysis of 28 RCTs: 8-12 weeks of aerobic training reduced resting HR by 4-6 bpm "
                    "(Smith 2024). Cohort study (n=2400) found trained adults had ~7 bpm lower resting HR than "
                    "sedentary peers (Lee 2023). Mechanism: increased vagal tone + stroke volume."
                ),
            )
        )
        assert verdict.status in ("supported", "refuted", "inconclusive")
        assert 0.0 <= verdict.confidence <= 1.0
        assert verdict.reasoning.strip()

    def test_evidence_free_strong_claim_not_supported(self):
        """Adversarial strictness: a sweeping claim with no real evidence must
        NOT come back 'supported' (inconclusive or refuted are acceptable)."""
        verifier = _verifier()
        verdict = asyncio.get_event_loop().run_until_complete(
            verifier.verify(
                hypothesis="Drinking green tea cures all forms of cancer in humans.",
                evidence="No studies were retrieved on this topic.",
            )
        )
        assert verdict.status != "supported"
