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
from uuid import UUID

from sqlalchemy.orm import Session

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


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
        from src.main.service.rag.agentic_routing import (
            get_agentic_rag_strategy_with_streaming,
        )

        # Stream routing decision - agentic_routing.py handles the branching logic
        # internally based on use_agentic_routing setting
        # NOTE: System agent model is used for routing, not user's chat model
        async for packet in get_agentic_rag_strategy_with_streaming(
            query=query,
            collection_ids=collection_ids,
            user_id=user_id,
            db=db,
        ):
            yield packet

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
        from src.main.service.rag.agentic_routing import extract_strategy_from_packets

        return extract_strategy_from_packets(packets)

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
