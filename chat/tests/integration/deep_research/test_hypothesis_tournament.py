"""Tests for the hypothesis Elo tournament (Move 3, increment 1).

Pure: the Elo math + the <2-entry no-op. Real-LLM (system provider): the
pairwise judge returns a valid choice and a 2-hypothesis tournament moves Elo.

Run inside Docker: docker exec scrapalot-chat python -m pytest tests/integration/deep_research/test_hypothesis_tournament.py -v
"""

import asyncio

import pytest

from src.main.service.deep_research.agents.hypothesis_tournament import (
    HypothesisJudgeAgent,
    _elo_update,
    run_tournament,
)
from src.main.service.deep_research.models.iteration_state import HypothesisEntry


class TestEloMath:
    def test_default_rating(self):
        assert HypothesisEntry(text="h").elo == 1200.0

    def test_equal_ratings_win(self):
        a, b = _elo_update(1200.0, 1200.0, score_a=1.0)
        assert a == 1216.0 and b == 1184.0  # ±K/2 at equal ratings

    def test_equal_ratings_tie_no_change(self):
        a, b = _elo_update(1200.0, 1200.0, score_a=0.5)
        assert abs(a - 1200.0) < 1e-9 and abs(b - 1200.0) < 1e-9

    def test_underdog_win_gains_more_than_favorite(self):
        underdog_gain = _elo_update(1000.0, 1400.0, score_a=1.0)[0] - 1000.0
        favorite_gain = _elo_update(1400.0, 1000.0, score_a=1.0)[0] - 1400.0
        assert underdog_gain > favorite_gain

    def test_total_rating_conserved(self):
        a, b = _elo_update(1300.0, 1100.0, score_a=0.0)
        assert abs((a + b) - 2400.0) < 1e-6


class TestTournamentNoop:
    def test_fewer_than_two_returns_without_judge(self):
        # judge=None would crash if called — proves <2 short-circuits before any match.
        one = [HypothesisEntry(text="only")]
        top = asyncio.get_event_loop().run_until_complete(run_tournament(one, "ev", judge=None))  # type: ignore[arg-type]
        assert top is one[0]
        empty: list[HypothesisEntry] = []
        assert asyncio.get_event_loop().run_until_complete(run_tournament(empty, "ev", judge=None)) is None  # type: ignore[arg-type]


def _judge() -> HypothesisJudgeAgent:
    from src.main.config.database import SessionLocal
    from src.main.utils.llm.agent_model_utils import get_system_agent_model
    from src.main.workers.tasks.research_tasks import _build_system_llm

    config = get_system_agent_model(agent_type="synthesis")
    with SessionLocal() as db:
        llm = _build_system_llm(db)
    return HypothesisJudgeAgent(llm, api_key=config.api_key, provider_type=config.provider_type)


@pytest.mark.integration
@pytest.mark.slow
class TestTournamentRealLLM:
    EVIDENCE = (
        "Multiple RCTs link aerobic exercise to lower resting heart rate via increased vagal tone. "
        "There is no credible evidence linking shoe color to cardiovascular outcomes."
    )

    def test_judge_returns_valid_choice(self):
        judge = _judge()
        winner = asyncio.get_event_loop().run_until_complete(
            judge.compare(
                "Aerobic exercise lowers resting heart rate via increased vagal tone.",
                "Wearing red shoes lowers resting heart rate.",
                self.EVIDENCE,
            )
        )
        assert winner in ("a", "b", "tie")

    def test_tournament_moves_elo_and_returns_leader(self):
        entries = [
            HypothesisEntry(text="Aerobic exercise lowers resting heart rate via increased vagal tone."),
            HypothesisEntry(text="Wearing red shoes lowers resting heart rate."),
        ]
        leader = asyncio.get_event_loop().run_until_complete(run_tournament(entries, self.EVIDENCE, _judge()))
        assert leader is not None
        # Total rating is conserved; at least one rating moved off the 1200 default.
        assert abs((entries[0].elo + entries[1].elo) - 2400.0) < 1e-6
        assert entries[0].elo != 1200.0 or entries[1].elo != 1200.0
        assert leader.elo == max(e.elo for e in entries)
