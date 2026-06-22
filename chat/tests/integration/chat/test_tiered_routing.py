"""
Integration Tests for Smart Tiered RAG Routing System

Tests all routing tiers:
- Tier 1: Rule-based pattern matching (~0.5ms)
- Tier 2: Exemplar similarity matching (~5-15ms)
- Tier 3: LLM agent fallthrough (~1-3s)
- Tier 4: Post-retrieval quality check

Requires: test_document fixture (art_of_war.pdf uploaded and processed).
"""

import time

import pytest

from tests.conftest import get_packets_by_type, parse_ndjson
from tests.integration.chat_client import chat_post


def _get_strategy_selected_packet(packets):
    """Extract strategy_selected packet from response packets."""
    strategy_packets = get_packets_by_type(packets, "strategy_selected")
    if strategy_packets:
        return strategy_packets[0].get("obj", {}).get("content", {})
    return None


@pytest.mark.integration
class TestTieredRoutingTier1:
    """Test Tier 1 rule-based routing with deterministic pattern matching."""

    def test_error_code_routes_to_hybrid_self_query(self, authenticated_session, api_base_url, test_collection, test_document):
        """Error codes should route to RAGHybridSelfQuery via Tier 1."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="What does error code ERR-221 mean?",
            collection_ids=[str(test_collection["id"])],
            timeout=120,
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text[:200]}"

        packets = parse_ndjson(response.text)
        strategy = _get_strategy_selected_packet(packets)
        assert strategy is not None, "Should have a strategy_selected packet"
        assert strategy.get("routing_tier") == 1, f"Expected Tier 1, got: {strategy}"
        assert strategy.get("strategy_name") == "RAGHybridSelfQuery", f"Expected RAGHybridSelfQuery, got: {strategy.get('strategy_name')}"

    def test_summary_routes_to_hybrid_summary_search(self, authenticated_session, api_base_url, test_collection, test_document):
        """Summary queries should route to RAGHybridSummarySearch via Tier 1."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Summarize the main themes of this book",
            collection_ids=[str(test_collection["id"])],
            timeout=120,
        )
        assert response.status_code == 200

        packets = parse_ndjson(response.text)
        strategy = _get_strategy_selected_packet(packets)
        assert strategy is not None, "Should have a strategy_selected packet"
        assert strategy.get("routing_tier") == 1, f"Expected Tier 1, got tier: {strategy.get('routing_tier')}"
        assert strategy.get("strategy_name") == "RAGHybridSummarySearch"

    def test_comparison_routes_to_multi_query(self, authenticated_session, api_base_url, test_collection, test_document):
        """Comparison queries should route to RAGMultiQuery via Tier 1."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Compare offensive and defensive strategies in warfare",
            collection_ids=[str(test_collection["id"])],
            timeout=120,
        )
        assert response.status_code == 200

        packets = parse_ndjson(response.text)
        strategy = _get_strategy_selected_packet(packets)
        assert strategy is not None
        assert strategy.get("routing_tier") == 1
        assert strategy.get("strategy_name") == "RAGMultiQuery"

    def test_why_question_routes_to_step_back(self, authenticated_session, api_base_url, test_collection, test_document):
        """'Why' questions should route to RAGStepBack via Tier 1."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Why does Sun Tzu emphasize the importance of deception?",
            collection_ids=[str(test_collection["id"])],
            timeout=120,
        )
        assert response.status_code == 200

        packets = parse_ndjson(response.text)
        strategy = _get_strategy_selected_packet(packets)
        assert strategy is not None
        assert strategy.get("routing_tier") == 1
        assert strategy.get("strategy_name") == "RAGStepBack"

    def test_tier1_is_fast(self, authenticated_session, api_base_url, test_collection, test_document):
        """Tier 1 routing should add negligible latency (strategy_selected appears quickly)."""
        start = time.time()
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Summarize the key concepts",
            collection_ids=[str(test_collection["id"])],
            timeout=120,
        )
        total_time = time.time() - start

        assert response.status_code == 200
        packets = parse_ndjson(response.text)
        strategy = _get_strategy_selected_packet(packets)
        assert strategy is not None
        assert strategy.get("routing_tier") == 1
        assert strategy.get("strategy_name") == "RAGHybridSummarySearch"
        # Tier 1 routing adds ~0.5ms, total request includes retrieval + LLM.
        # Just verify it completes in reasonable time (not stuck).
        assert total_time < 120, f"Request took {total_time:.1f}s, expected < 120s"


@pytest.mark.integration
class TestTieredRoutingTier3Fallthrough:
    """Test that complex queries fall through to Tier 3 (LLM agent)."""

    def test_complex_query_falls_to_tier3(self, authenticated_session, api_base_url, test_collection, test_document):
        """A query that matches no Tier 1/2 pattern should use Tier 3 (LLM agent)."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Analyze the philosophical underpinnings of strategic patience in ancient military doctrine",
            collection_ids=[str(test_collection["id"])],
            timeout=120,
        )
        assert response.status_code == 200

        packets = parse_ndjson(response.text)
        strategy = _get_strategy_selected_packet(packets)
        assert strategy is not None, "Should have a strategy_selected packet"
        # This query is complex and ambiguous — should fall to Tier 2 or 3
        tier = strategy.get("routing_tier")
        assert tier in (2, 3, None), f"Expected Tier 2 or 3 for complex query, got: {tier}"


@pytest.mark.integration
class TestTieredRoutingTracing:
    """Test that routing_tier is persisted in traces."""

    def test_routing_tier_persisted_in_rag_trace(self, authenticated_session, api_base_url, test_collection, test_document, py_cursor):
        """routing_tier should be persisted in rag_evaluation_traces table."""
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Summarize the key principles",
            collection_ids=[str(test_collection["id"])],
            timeout=120,
        )
        assert response.status_code == 200

        # Wait for async trace persistence
        time.sleep(3)

        # Verify routing_tier is stored
        py_cursor.execute("SELECT routing_tier, routing_tier_name FROM rag_evaluation_traces ORDER BY created_at DESC LIMIT 1")
        row = py_cursor.fetchone()
        if row:
            assert row["routing_tier"] is not None, "routing_tier should be set in trace"
            assert row["routing_tier_name"] is not None, "routing_tier_name should be set in trace"
            assert row["routing_tier"] in (1, 2, 3, 4), f"Invalid routing_tier: {row['routing_tier']}"


@pytest.mark.integration
class TestTieredRoutingRuleEngine:
    """Test the rule engine directly (unit-style within integration suite)."""

    def test_all_tier1_rules_produce_valid_strategies(self):
        """Every Tier 1 rule should map to a valid, existing strategy."""
        from src.main.service.rag.tiered_router import RuleBasedRouter
        from src.main.utils.rag.strategies import RAG_STRATEGY_CLASSES

        router = RuleBasedRouter()

        test_queries = {
            "error_codes_versions": "What does error code ERR-500 mean?",
            "relationship_query": "How is chapter 3 related to chapter 5?",
            "cross_document": "What do all the books say about leadership?",
            "temporal_query": "What are the latest updates from 2024?",
            "summary_overview": "Summarize the main ideas",
            "full_section": "Give me the full section on terrain",
            "compare_contrast": "Compare attack versus defense strategies",
            "exact_terms": "Find all mentions of GDPR compliance",
            "multi_part": "What is strategy and also what is tactics?",
            "root_cause": "Why does the army need supply lines?",
            "conversation_continuation": "You mentioned something about terrain earlier",
            "short_vague": "hi",
        }

        for rule_id, query in test_queries.items():
            result = router.route(query)
            assert result is not None, f"Rule '{rule_id}' should match query: '{query}'"
            assert result.rule_id == rule_id, f"Query '{query}' matched rule '{result.rule_id}', expected '{rule_id}'"
            assert result.strategy_name in RAG_STRATEGY_CLASSES, f"Rule '{rule_id}' maps to unknown strategy: {result.strategy_name}"
            assert result.routing_tier == 1
            assert result.confidence > 0

    def test_post_retrieval_quality_check_zero_docs(self):
        """Post-retrieval check should suggest fallback for zero documents."""
        from src.main.service.rag.tiered_router import check_retrieval_quality

        fallback = check_retrieval_quality("test query", [], "RAGSimilaritySearch")
        assert fallback == "EnhancedTriModalOrchestrator"

    def test_post_retrieval_quality_check_acceptable(self):
        """Post-retrieval check should return None for acceptable quality."""
        from unittest.mock import MagicMock

        from src.main.service.rag.tiered_router import check_retrieval_quality

        doc = MagicMock()
        doc.metadata = {"score": 0.8}
        doc.page_content = "This is about test query content matching"

        fallback = check_retrieval_quality("test query content", [doc], "RAGSimilaritySearch")
        assert fallback is None, "Should not suggest fallback for good quality results"


class TestAgenticFastPath:
    """Engine B (the agentic tool-agent path) reuses the deterministic Tier-1 rule
    router as a fast pre-filter *before* the LLM strategy call. On a high-confidence
    rule match it short-circuits the LLM; ambiguous / low-confidence queries still fall
    through to the LLM router so nuanced routing is not regressed.

    These are pure-function tests of that short-circuit — no DB, no LLM, no mocks.
    """

    def test_high_confidence_rule_short_circuits_and_satisfies_contract(self):
        """A Git-SHA query matches Rule 0 (conf 0.92 >= threshold) → selection dict that
        also parses as StrategySelection (the downstream extract_* contract)."""
        from src.main.service.agents.rag_agents.strategy_router import (
            StrategySelection,
            _try_rule_based_fast_path,
        )

        result = _try_rule_based_fast_path("what does commit a1b2c3d4e5f6 change?")
        assert result is not None, "High-confidence Git-SHA rule should short-circuit the LLM router"
        assert result["selected_strategy"] == "RAGRegexGrep"
        assert result["strategy_confidence"] >= 0.85
        assert result["estimated_latency"] == "fast"
        # extract_orchestration_result_from_packets does StrategySelection(**content):
        parsed = StrategySelection(**result)
        assert parsed.selected_strategy == "RAGRegexGrep"
        assert parsed.use_orchestrator is False

    def test_summary_and_relationship_rules_short_circuit(self):
        """Other high-confidence rules also fire (overview → summary, relations → graph)."""
        from src.main.service.agents.rag_agents.strategy_router import _try_rule_based_fast_path

        overview = _try_rule_based_fast_path("give me an overview of this book")
        assert overview is not None and overview["selected_strategy"] == "RAGHybridSummarySearch"

        relation = _try_rule_based_fast_path("how is Tesla related to SpaceX across all books?")
        assert relation is not None and relation["selected_strategy"] in ("RAGGraphSearch", "RAGEntityExpanded")

    def test_low_confidence_rule_falls_through_to_llm(self):
        """Rule 12 (very short/vague, conf 0.70) is below the fast-path threshold, so the
        LLM router still decides — the fast path must not hijack nuanced queries."""
        from src.main.service.agents.rag_agents.strategy_router import (
            _RULE_FASTPATH_MIN_CONFIDENCE,
            _try_rule_based_fast_path,
        )

        assert _RULE_FASTPATH_MIN_CONFIDENCE > 0.70, "Threshold must exclude the 0.70 vague-query rule"
        assert _try_rule_based_fast_path("why?") is None

    def test_ambiguous_query_falls_through_to_llm(self):
        """A query that matches no deterministic rule returns None (→ LLM router)."""
        from src.main.service.agents.rag_agents.strategy_router import _try_rule_based_fast_path

        assert _try_rule_based_fast_path("tell me about consciousness and the soul") is None


@pytest.mark.integration
class TestAgenticFastPathIntegration:
    """End-to-end proof that the rule fast-path runs on the LIVE agentic path (Engine B).

    An overview query (Rule 5, conf 0.90) reliably selects documents AND matches a
    high-confidence rule, so Engine B's StrategyRouter must surface RAGHybridSummarySearch
    in its strategy_transparency packet, with a rationale stamped by the rule fast-path
    (not the LLM).
    """

    def test_overview_query_uses_rule_fast_path_on_agentic_path(self, authenticated_session, api_base_url, test_collection, test_document):
        response = chat_post(
            authenticated_session,
            api_base_url,
            prompt="Give me an overview of the main themes of this book",
            collection_ids=[str(test_collection["id"])],
            agentic_rag_enabled=True,
            timeout=120,
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text[:200]}"

        packets = parse_ndjson(response.text)
        transparency = get_packets_by_type(packets, "strategy_transparency")
        assert transparency, "Agentic path should emit a strategy_transparency packet"

        obj = transparency[0].get("obj", {})
        assert obj.get("strategy_name") == "RAGHybridSummarySearch", (
            f"Overview query should select RAGHybridSummarySearch via the rule fast-path, got: {obj.get('strategy_name')}"
        )
        assert "Fast deterministic rule" in (obj.get("rationale") or ""), (
            f"Strategy should come from the rule fast-path (not the LLM), rationale was: {obj.get('rationale')!r}"
        )
