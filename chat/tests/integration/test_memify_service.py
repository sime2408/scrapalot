"""
Integration tests for the Memify service (CATEGORY_01 §1.2).

Closes the loop: Redis Stream payload → parser → EMA Cypher → Neo4j Entity
feedback_weight. No mocks (CLAUDE.md test rule).

Each test seeds a temporary Entity node, applies a feedback event, then reads
back the resulting weight from Neo4j and verifies the EMA formula held.
"""

from __future__ import annotations

import math
from uuid import uuid4

import pytest

from src.main.service.graph.memify_service import (
    DEFAULT_ALPHA,
    DEFAULT_WEIGHT,
    FeedbackEvent,
    apply_feedback_weights,
    parse_feedback_event,
    stream_update_weight,
)


@pytest.fixture
def seeded_entity(neo4j_driver):
    """Create a temporary :Entity node for a single test, then delete it."""
    entity_id = f"memify-test-{uuid4()}"
    with neo4j_driver.session() as session:
        session.run(
            """
            CREATE (e:Entity {
                id: $id,
                canonical_name: $name,
                entity_type: 'concept',
                feedback_weight: 0.5
            })
            """,
            id=entity_id,
            name=entity_id,
        )
    yield entity_id
    with neo4j_driver.session() as session:
        session.run("MATCH (e:Entity {id: $id}) DETACH DELETE e", id=entity_id)


def _read_weight(neo4j_driver, entity_id: str) -> float:
    with neo4j_driver.session() as session:
        row = session.run("MATCH (e:Entity {id: $id}) RETURN e.feedback_weight AS fw", id=entity_id).single()
        assert row is not None, f"Entity {entity_id} disappeared"
        return float(row["fw"])


@pytest.mark.integration
@pytest.mark.neo4j
class TestMemifyEMA:
    def test_thumbs_up_lifts_neutral_seed(self, neo4j_driver, seeded_entity):
        """+1 with no detail moves a 0.5 entity toward 1.0 by alpha=0.1."""
        event = FeedbackEvent(
            message_id=uuid4(),
            session_id=uuid4(),
            user_id=uuid4(),
            feedback=1,
            feedback_detail=None,
            node_ids=[seeded_entity],
            edge_ids=[],
        )
        result = apply_feedback_weights(event)
        assert result.skipped is False
        assert result.nodes_updated == 1

        expected = stream_update_weight(DEFAULT_WEIGHT, 1.0, alpha=DEFAULT_ALPHA)
        actual = _read_weight(neo4j_driver, seeded_entity)
        assert math.isclose(actual, expected, abs_tol=1e-4), f"expected {expected}, got {actual}"

    def test_thumbs_down_lowers_neutral_seed(self, neo4j_driver, seeded_entity):
        """-1 with no detail pulls 0.5 toward 0.0."""
        event = FeedbackEvent(
            message_id=uuid4(),
            session_id=uuid4(),
            user_id=uuid4(),
            feedback=-1,
            feedback_detail=None,
            node_ids=[seeded_entity],
            edge_ids=[],
        )
        apply_feedback_weights(event)
        actual = _read_weight(neo4j_driver, seeded_entity)
        expected = stream_update_weight(DEFAULT_WEIGHT, 0.0, alpha=DEFAULT_ALPHA)
        assert math.isclose(actual, expected, abs_tol=1e-4)

    def test_feedback_detail_dominates_binary(self, neo4j_driver, seeded_entity):
        """detail=3 (rating 0.5) is a no-op against a 0.5 seed."""
        event = FeedbackEvent(
            message_id=uuid4(),
            session_id=uuid4(),
            user_id=uuid4(),
            feedback=-1,  # would push toward 0 if detail were absent
            feedback_detail=3,  # but rating=0.5 wins; pull-to-neutral
            node_ids=[seeded_entity],
            edge_ids=[],
        )
        apply_feedback_weights(event)
        # 0.5 + 0.1 * (0.5 - 0.5) == 0.5
        assert math.isclose(_read_weight(neo4j_driver, seeded_entity), 0.5, abs_tol=1e-4)

    def test_repeated_thumbs_up_converges_toward_one(self, neo4j_driver, seeded_entity):
        """Twenty thumbs-up moves the EMA close to 1.0 but not above it."""
        event_template = dict(
            message_id=uuid4(),
            session_id=uuid4(),
            user_id=uuid4(),
            feedback=1,
            feedback_detail=None,
            edge_ids=[],
        )
        for _ in range(20):
            apply_feedback_weights(FeedbackEvent(node_ids=[seeded_entity], **event_template))
        final = _read_weight(neo4j_driver, seeded_entity)
        # After 20 EMA steps with alpha=0.1 toward 1.0 from 0.5, the value is
        # 1 - 0.5 * (1-0.1)^20 ≈ 0.939. Bounded above by 1.0.
        assert 0.85 < final <= 1.0

    def test_skip_when_no_graph_elements(self, neo4j_driver):
        event = FeedbackEvent(
            message_id=uuid4(),
            session_id=uuid4(),
            user_id=uuid4(),
            feedback=1,
            feedback_detail=None,
            node_ids=[],
            edge_ids=[],
        )
        result = apply_feedback_weights(event)
        assert result.skipped is True
        assert result.skip_reason == "no_graph_elements"

    def test_missing_entity_silently_skipped(self, neo4j_driver):
        """Stale node_id in the message payload must not crash the consumer."""
        event = FeedbackEvent(
            message_id=uuid4(),
            session_id=uuid4(),
            user_id=uuid4(),
            feedback=1,
            feedback_detail=None,
            node_ids=[f"does-not-exist-{uuid4()}"],
            edge_ids=[],
        )
        result = apply_feedback_weights(event)
        assert result.skipped is False
        assert result.nodes_updated == 0


@pytest.mark.integration
class TestMemifyParser:
    def test_parse_redis_fields(self):
        message_id = uuid4()
        session_id = uuid4()
        user_id = uuid4()
        fields = {
            "message_id": str(message_id),
            "session_id": str(session_id),
            "user_id": str(user_id),
            "feedback": "1",
            "feedback_detail": "5",
            "used_graph_element_ids_json": '{"node_ids":["a","b"],"edge_ids":["e1"]}',
        }
        event = parse_feedback_event(fields)
        assert event is not None
        assert event.message_id == message_id
        assert event.session_id == session_id
        assert event.user_id == user_id
        assert event.feedback == 1
        assert event.feedback_detail == 5
        assert event.node_ids == ["a", "b"]
        assert event.edge_ids == ["e1"]

    def test_parse_skips_zero_feedback(self):
        fields = {
            "message_id": str(uuid4()),
            "session_id": str(uuid4()),
            "user_id": str(uuid4()),
            "feedback": "0",
        }
        assert parse_feedback_event(fields) is None

    def test_parse_skips_null_feedback_string(self):
        fields = {
            "message_id": str(uuid4()),
            "session_id": str(uuid4()),
            "user_id": str(uuid4()),
            "feedback": "null",
        }
        assert parse_feedback_event(fields) is None

    def test_parse_skips_bad_uuid(self):
        fields = {
            "message_id": "not-a-uuid",
            "session_id": str(uuid4()),
            "user_id": str(uuid4()),
            "feedback": "1",
        }
        assert parse_feedback_event(fields) is None

    def test_parse_handles_missing_payload(self):
        fields = {
            "message_id": str(uuid4()),
            "session_id": str(uuid4()),
            "user_id": str(uuid4()),
            "feedback": "-1",
        }
        event = parse_feedback_event(fields)
        assert event is not None
        assert event.node_ids == []
        assert event.edge_ids == []
