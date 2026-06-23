"""
RAG Strategy Selection Service.

This module provides a centralized service for selecting RAG strategies,
extracting the complex routing logic from controllers to keep them lean and focused.

Key responsibilities:
- Stream RAG strategy routing decisions with thinking tokens
- Extract strategy information from routing packets
- Handle both agentic and manual strategy selection
- Provide a clean interface for controllers
"""

from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


@dataclass
class RoutingResult:
    """Result of basic RAG strategy selection (Community Edition).

    The hosted edition fills this from the agentic router (query analysis,
    source analysis, routing tiers). CE has no agentic routing or strategy
    presets, so every request resolves to plain pgvector similarity search.
    The optional/agentic fields are kept (defaulted to neutral values) so
    downstream consumers that read them don't hit AttributeError.
    """

    strategy_name: str
    strategy_type: str
    strategy_class: type
    source_analysis: Any | None = None
    routing_tier: int | None = None
    routing_tier_name: str | None = None
    confidence: float | None = None
    reasoning: str | None = None
    query_characteristics: dict[str, Any] = field(default_factory=dict)


def _basic_routing_result() -> RoutingResult:
    """Build the default similarity-search routing result for CE."""
    from src.main.service.rag.rag_similarity_search import RAGSimilaritySearch

    return RoutingResult(
        strategy_name="RAGSimilaritySearch",
        strategy_type="similarity",
        strategy_class=RAGSimilaritySearch,
        reasoning="Basic similarity search (Community Edition).",
    )


class RAGStrategyService:
    """Service for RAG strategy selection and routing.

    IMPORTANT: Strategy routing uses the SYSTEM-configured LLM model,
    NOT the user's selected chat model. This ensures consistent routing
    behavior regardless of user's model selection.
    """

    @staticmethod
    async def select_strategy_with_streaming(
        query: str,
        collection_ids: list[UUID] | None,
        user_id: str,
        db: Session,
    ) -> AsyncGenerator[str, None]:
        """
        Select the optimal RAG strategy with streaming thinking tokens.

        This method handles both agentic routing (AI-powered) and manual selection
        based on the user's use_agentic_routing setting. It streams thinking tokens
        during the decision process for better UX.

        IMPORTANT: Agentic routing uses the SYSTEM agent model, not the user's
        selected chat model. This ensures consistent routing behavior.

        Args:
            query: User's query to analyze
            collection_ids: Collections being searched
            user_id: Current user ID
            db: Database session

        Yields:
            Packet strings including
            - status packets with thinking tokens (agentic mode)
            - routing_decision packet with analysis (agentic mode)
            - strategy_selected packet with final strategy info

        Example:
            async for packet in RAGStrategyService.select_strategy_with_streaming(
                query="What is machine learning?",
                collection_ids=[uuid1, uuid2],
                user_id="user123",
                db=db_session,
            ):
                yield packet  # Forward to a client
        """
        # Community Edition has no agentic routing / strategy presets. Always
        # resolve to plain pgvector similarity search and emit a single
        # strategy_selected packet so the caller can collect it.
        from src.main.service.streaming.packet_emitter import PacketEmitter

        routing = _basic_routing_result()
        _emitter = PacketEmitter(buffer_mode=False)
        yield _emitter.emit_custom(
            packet_type="strategy_selected",
            content={
                "strategy_name": routing.strategy_name,
                "strategy_type": routing.strategy_type,
            },
        )

    @staticmethod
    def extract_strategy_info(packets: list[str]):
        """
        Extract strategy and source analysis from routing packets.

        Parses the collected packets to find the strategy_selected packet
        and extracts strategy info with optional source analysis.

        Args:
            packets: List of packet strings from select_strategy_with_streaming

        Returns:
            RoutingResult with strategy_name, strategy_type, strategy_class,
            and optional source_analysis for hybrid routing decisions.

        Example:
            packets = []
            async for packet in RAGStrategyService.select_strategy_with_streaming(...):
                packets.append(packet)

            routing = RAGStrategyService.extract_strategy_info(packets)
            strategy = routing.strategy_class(retriever, llm, packet_emitter)
        """
        # Community Edition always uses basic similarity search; the streamed
        # packets are informational only.
        return _basic_routing_result()

    @staticmethod
    async def select_strategy_sync(
        query: str,
        collection_ids: list[UUID] | None,
        user_id: str,
        db: Session,
    ):
        """
        Select optimal RAG strategy without streaming (synchronous version).

        This is a convenience method that collects all packets internally
        and returns strategy information with optional source analysis.

        Args:
            query: User's query to analyze
            collection_ids: Collections being searched
            user_id: Current user ID
            db: Database session

        Returns:
            RoutingResult with strategy_name, strategy_type, strategy_class,
            and optional source_analysis for hybrid routing decisions.

        Example:
            routing = await RAGStrategyService.select_strategy_sync(
                query="What is machine learning?",
                collection_ids=[uuid1, uuid2],
                user_id="user123",
                db=db_session,
            )
            strategy = routing.strategy_class(retriever, llm, ...)
        """
        packets = []

        async for packet in RAGStrategyService.select_strategy_with_streaming(
            query=query,
            collection_ids=collection_ids,
            user_id=user_id,
            db=db,
        ):
            packets.append(packet)

        return RAGStrategyService.extract_strategy_info(packets)
