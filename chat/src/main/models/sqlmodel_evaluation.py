"""
RAG Evaluation Trace model for the Data Inspector.

Stores routing decisions made by the agentic strategy router for
analytics, debugging, and quality monitoring.
"""

from typing import Any
from uuid import UUID

from sqlalchemy import Column, Float, Index, Integer, Text
from sqlmodel import Field

from src.main.models.sqlite_compat import ScrapalotJSON
from src.main.models.sqlmodel_base import BaseModel, ScrapalotUUID


class RAGEvaluationTrace(BaseModel, table=True):
    """
    Persistent record of RAG strategy routing decisions.

    Captured after each agentic routing decision for analytics
    and quality monitoring in the Data Inspector dashboard.
    """

    __tablename__ = "rag_evaluation_traces"
    __table_args__ = (
        Index("ix_rag_evaluation_traces_strategy", "selected_strategy"),
        Index("ix_rag_evaluation_traces_created_at", "created_at"),
        Index("ix_rag_evaluation_traces_session_id", "session_id"),
        {"extend_existing": True},
    )

    # Session and user context (plain UUIDs, no FK — owned by Kotlin)
    session_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            nullable=False,
        )
    )
    user_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            nullable=False,
        )
    )

    # Query and routing decision
    query: str = Field(sa_column=Column(Text, nullable=False))
    selected_strategy: str = Field(max_length=100)
    selected_orchestrator: str | None = Field(default=None, max_length=100)
    strategy_type: str = Field(max_length=20)
    mode: str = Field(max_length=50)

    # Confidence and reasoning
    confidence: float = Field(
        default=0.0,
        sa_column=Column(Float, nullable=False, server_default="0.0"),
    )
    reasoning: str | None = Field(default=None, sa_column=Column(Text, nullable=True))

    # Structured data
    alternative_strategies: list[dict[str, Any]] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"),
    )
    query_characteristics: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="{}"),
    )

    # Performance metrics
    latency_ms: int | None = Field(
        default=None,
        sa_column=Column(Integer, nullable=True),
    )
    token_count: int | None = Field(
        default=None,
        sa_column=Column(Integer, nullable=True),
    )

    # Graph traversal statistics (populated by tri-modal fusion orchestrator)
    graph_traversal_stats: dict[str, Any] | None = Field(
        default=None,
        sa_column=Column(ScrapalotJSON(), nullable=True),
    )

    # Tiered routing metadata
    routing_tier: int | None = Field(
        default=None,
        sa_column=Column(Integer, nullable=True),
    )  # 1=rule_based, 2=exemplar, 3=llm_agent, 4=post_retrieval_fallback
    routing_tier_name: str | None = Field(default=None, max_length=30)

    # Prompt-variant tracking. The
    # category-conditioned variant resolved from QueryCharacteristics and
    # prepended to the synthesis system prompt. One of:
    # default | temporal_reasoning | preference_recall | multi_session |
    # knowledge_update | summary. Persisted so the admin Data Inspector can
    # filter / aggregate by variant alongside strategy choice.
    prompt_variant: str | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
    )
