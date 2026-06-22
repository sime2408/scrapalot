"""Tests for the multi-model hypothesis generation panel (Move 3.2).

Pure: roster/default-lens selection + the per-member model fallback. Real-LLM
(system provider): the panel returns ≥1 distinct candidate hypothesis.

Run inside Docker: docker exec scrapalot-chat python -m pytest tests/integration/deep_research/test_hypothesis_panel.py -v
"""

import asyncio

import pytest

from src.main.dto.agent_definition import AgentDefinition
from src.main.service.deep_research.agents.hypothesis_panel import (
    _DEFAULT_LENSES,
    _MAX_PANEL_MEMBERS,
    _panel_members,
    _resolve_model_spec,
    propose_panel_hypotheses,
)


class TestPanelMembers:
    def test_no_roster_uses_default_lenses(self):
        members = _panel_members(None)
        assert len(members) == len(_DEFAULT_LENSES)
        assert [m[0] for m in members] == [lens[0] for lens in _DEFAULT_LENSES]
        assert all(m[2] is None for m in members)  # default lenses → base model

    def test_roster_used_and_capped(self):
        roster = [AgentDefinition(name=f"C{i}", role="r", model=f"openai:m{i}") for i in range(_MAX_PANEL_MEMBERS + 3)]
        members = _panel_members(roster)
        assert len(members) == _MAX_PANEL_MEMBERS
        assert members[0] == ("C0", "r", "openai:m0")

    def test_roster_persona_falls_back_to_stance_then_name(self):
        roster = [AgentDefinition(name="Skeptic", stance="Doubt everything")]
        members = _panel_members(roster)
        assert members[0][1] == "Doubt everything"


class TestResolveModelSpec:
    def test_empty_or_malformed_returns_base_identity(self):
        base = object()
        assert _resolve_model_spec(None, base) is base
        assert _resolve_model_spec("", base) is base
        assert _resolve_model_spec("noseparator", base) is base

    def test_wellformed_never_raises(self):
        base = object()
        assert _resolve_model_spec("anthropic:claude-x", base) is not None


def _system_args():
    from src.main.config.database import SessionLocal
    from src.main.utils.llm.agent_model_utils import get_system_agent_model
    from src.main.workers.tasks.research_tasks import _build_system_llm

    config = get_system_agent_model(agent_type="synthesis")
    with SessionLocal() as db:
        llm = _build_system_llm(db)
    return llm, config.api_key, config.provider_type


@pytest.mark.integration
@pytest.mark.slow
class TestPanelRealLLM:
    def test_default_panel_proposes_candidates(self):
        llm, api_key, provider_type = _system_args()
        candidates = asyncio.get_event_loop().run_until_complete(
            propose_panel_hypotheses(
                question="What lifestyle factors most affect resting heart rate in healthy adults?",
                evidence="Aerobic fitness, sleep, caffeine, and stress are commonly cited in the literature.",
                roster=None,
                llm=llm,
                api_key=api_key,
                provider_type=provider_type,
            )
        )
        assert len(candidates) >= 1
        assert all(isinstance(c, str) and c.strip() for c in candidates)
        # de-duplicated
        assert len(candidates) == len({c.lower() for c in candidates})
