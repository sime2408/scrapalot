"""Integration tests for the agentic, user-definable, multi-model Research Council.

Covers PR #1 of the shared Agent Harness (docs/prd-competitive/
competitive_analysis_hermes_agent.md §4b):
  * parse_roster — untrusted-input parsing (pure, no LLM)
  * CouncilAgent._resolve_member_model — per-member model fallback (pure)
  * custom roster → real multi-member deliberation (REAL LLM, system provider)
  * no roster → original archetype path still works (REAL LLM, system provider)

Real-LLM tests use the "Scrapalot AI" system provider. Run inside Docker:
  docker exec scrapalot-chat python -m pytest tests/integration/deep_research/test_council_roster.py -v
"""

import asyncio

import pytest

from src.main.dto.agent_definition import AgentDefinition, parse_roster

# ---------------------------------------------------------------------------
# parse_roster — pure, no LLM
# ---------------------------------------------------------------------------


class TestParseRoster:
    def test_list_of_dicts(self):
        roster = parse_roster(
            [
                {"name": "Bayesian skeptic", "role": "Demand priors and error bars.", "model": "openai:gpt-4o-mini"},
                {"name": "Domain ethicist", "role": "Weigh harms.", "stance": "Who is affected?"},
            ]
        )
        assert len(roster) == 2
        assert roster[0].name == "Bayesian skeptic"
        assert roster[0].model == "openai:gpt-4o-mini"
        assert roster[1].stance == "Who is affected?"

    def test_json_string(self):
        roster = parse_roster('[{"name": "A", "role": "ra"}, {"name": "B"}]')
        assert [m.name for m in roster] == ["A", "B"]

    def test_dict_with_members_key(self):
        roster = parse_roster({"members": [{"name": "X"}, {"name": "Y"}]})
        assert len(roster) == 2

    def test_malformed_members_dropped_never_raises(self):
        roster = parse_roster(
            [
                {"name": "Valid"},
                {"role": ""},  # no name, no role → dropped
                "not-a-dict",  # dropped
                {"name": "   "},  # blank name → dropped
                42,  # dropped
            ]
        )
        assert [m.name for m in roster] == ["Valid"]

    def test_garbage_inputs_return_empty(self):
        assert parse_roster(None) == []
        assert parse_roster("") == []
        assert parse_roster("not json") == []
        assert parse_roster(123) == []
        assert parse_roster({}) == []

    def test_role_only_member_gets_name_from_role(self):
        roster = parse_roster([{"role": "A pragmatic systems architect who cares about structure"}])
        assert len(roster) == 1
        assert roster[0].name  # derived from role


# ---------------------------------------------------------------------------
# _resolve_member_model — pure (no network); proves safe fallback
# ---------------------------------------------------------------------------


class TestResolveMemberModel:
    def _agent(self):
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider

        from src.main.service.deep_research.agents.council_agent import CouncilAgent

        # A real model OBJECT (fake key, no network) so __init__ can build its
        # archetype agents; the base model is this object and fallbacks return it.
        base = OpenAIChatModel("gpt-4o-mini", provider=OpenAIProvider(api_key="sk-test"))  # pragma: allowlist secret
        return CouncilAgent(None, model=base, api_key="sk-test", provider_type="openai"), base  # pragma: allowlist secret

    def test_empty_or_malformed_spec_returns_base_identity(self):
        agent, base = self._agent()
        assert agent._resolve_member_model(None) is base
        assert agent._resolve_member_model("") is base
        assert agent._resolve_member_model("noseparator") is base  # no ':' → base

    def test_wellformed_spec_never_raises_and_returns_something(self):
        agent, _base = self._agent()
        # Either falls back to base (no key for provider) or builds a model
        # object — must never raise, and must never be None.
        resolved = agent._resolve_member_model("anthropic:claude-opus-4-8")
        assert resolved is not None


# ---------------------------------------------------------------------------
# Roster size cap — pure, no LLM (cost guard)
# ---------------------------------------------------------------------------


class TestRosterCap:
    def test_oversized_roster_truncated_to_cap(self):
        from src.main.service.deep_research.agents.council_agent import _MAX_COUNCIL_MEMBERS, _cap_roster

        roster = [AgentDefinition(name=f"M{i}") for i in range(_MAX_COUNCIL_MEMBERS + 5)]
        capped = _cap_roster(roster)
        assert len(capped) == _MAX_COUNCIL_MEMBERS
        assert [m.name for m in capped] == [f"M{i}" for i in range(_MAX_COUNCIL_MEMBERS)]

    def test_small_roster_passes_through_unchanged(self):
        from src.main.service.deep_research.agents.council_agent import _cap_roster

        roster = [AgentDefinition(name="A"), AgentDefinition(name="B"), AgentDefinition(name="C")]
        assert _cap_roster(roster) is roster


# ---------------------------------------------------------------------------
# Real-LLM deliberation — system provider
# ---------------------------------------------------------------------------


def _system_council():
    from src.main.service.deep_research.agents.council_agent import CouncilAgent
    from src.main.utils.llm.agent_model_utils import get_system_agent_model

    config = get_system_agent_model(agent_type="synthesis")
    model = config.get_pydantic_ai_model()
    return CouncilAgent(None, model=model, api_key=config.api_key, provider_type=config.provider_type)


@pytest.mark.integration
@pytest.mark.slow
class TestCustomCouncilRealLLM:
    QUESTION = "Should a small research team adopt an autonomous multi-agent research loop?"
    REPORT = (
        "Autonomous research loops can run for hours and surface findings while the user is away, "
        "but they cost tokens, can drift, and need verification gates before a hypothesis is trusted. "
        "Small teams have limited budget and oversight capacity."
    )

    def test_custom_roster_produces_multi_member_deliberation(self):
        """A 3-member user-defined roster (all on the system model) must yield a
        real deliberation with one entry per member + a synthesis."""
        agent = _system_council()
        roster = [
            AgentDefinition(name="Pragmatist", role="Care about cost, effort and what ships this quarter."),
            AgentDefinition(name="Skeptic", role="Attack weak evidence; demand verification before trusting any claim."),
            AgentDefinition(name="Futurist", role="Weigh second-order and long-term effects of autonomy."),
        ]

        selection, deliberation = asyncio.get_event_loop().run_until_complete(
            agent.deliberate(research_question=self.QUESTION, final_report=self.REPORT, roster=roster)
        )

        names = {m.archetype for m in deliberation.members}
        assert len(deliberation.members) >= 2  # ≥2 survivors required
        assert names.issubset({"Pragmatist", "Skeptic", "Futurist"})
        for m in deliberation.members:
            assert m.position.strip()
            assert m.reasoning.strip()
            assert m.label  # custom members carry their own label
        assert deliberation.synthesis is not None
        assert deliberation.synthesis.core_tension.strip()
        assert selection.selection_reason  # "User-defined council roster."

    def test_single_member_roster_falls_back_to_archetypes(self):
        """A <2-member roster is not a council → must fall back to the built-in
        archetype path (proves the default path is reachable + intact)."""
        agent = _system_council()
        selection, _deliberation = asyncio.get_event_loop().run_until_complete(
            agent.deliberate(
                research_question=self.QUESTION,
                final_report=self.REPORT,
                roster=[AgentDefinition(name="Solo")],
            )
        )
        # Archetype path selects 4–6 known archetypes (not "Solo").
        assert len(selection.members) >= 4
        assert "Solo" not in selection.members

    def test_no_roster_uses_archetype_path_unchanged(self):
        """No roster → original behavior: 4–6 archetype members + synthesis."""
        agent = _system_council()
        selection, deliberation = asyncio.get_event_loop().run_until_complete(
            agent.deliberate(research_question=self.QUESTION, final_report=self.REPORT)
        )
        assert 4 <= len(selection.members) <= 6
        assert 4 <= len(deliberation.members) <= 6
        assert deliberation.synthesis.confidence in ("high", "medium", "low")
