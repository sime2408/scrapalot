"""
LLM Trace model for persistent RAG tracing.

Stores detailed trace data for each LLM request including input parameters,
retrieved chunks, token usage, cost, and latency for analytics, audit,
and dataset generation.
"""

from typing import Any
from uuid import UUID

from sqlalchemy import Boolean, Column, Float, Index, Integer, String, Text
from sqlmodel import Field

from src.main.models.sqlite_compat import ScrapalotJSON, ScrapalotJSONB
from src.main.models.sqlmodel_base import BaseModel, ScrapalotUUID


class LLMTrace(BaseModel, table=True):
    """
    Persistent record of an LLM request with full RAG context.

    Captured after each chat response for analytics, audit,
    and dataset generation in the tracing dashboard.
    """

    __tablename__ = "llm_traces"
    __table_args__ = (
        Index("ix_llm_traces_session_id", "session_id"),
        Index("ix_llm_traces_user_id", "user_id"),
        Index("ix_llm_traces_created_at", "created_at"),
        Index("ix_llm_traces_chat_mode", "chat_mode"),
        {"extend_existing": True},
    )

    # --- Identity & cross-references (plain UUIDs, no FK — owned by Kotlin) ---
    session_id: UUID = Field(sa_column=Column(ScrapalotUUID(), nullable=False))
    user_id: UUID = Field(sa_column=Column(ScrapalotUUID(), nullable=False))
    workspace_id: UUID | None = Field(default=None, sa_column=Column(ScrapalotUUID(), nullable=True))
    assistant_message_id: UUID | None = Field(default=None, sa_column=Column(ScrapalotUUID(), nullable=True))

    # --- Input ---
    query: str = Field(sa_column=Column(Text, nullable=False))
    chat_mode: str = Field(max_length=50)  # rag | agentic_rag | direct_llm | web_search | document_qa | agent types
    collection_ids: list[str] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"),
    )
    document_ids: list[str] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"),
    )

    # --- RAG parameters ---
    top_k: int | None = Field(default=None, sa_column=Column(Integer, nullable=True))
    similarity_threshold: float | None = Field(default=None, sa_column=Column(Float, nullable=True))
    strategy_name: str | None = Field(default=None, max_length=100)
    strategy_type: str | None = Field(default=None, max_length=30)  # orchestrator | individual
    agentic_routing: bool = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False, server_default="false"),
    )

    # --- Retrieved chunks (JSONB array, ~5-15KB per trace) ---
    # Each: {document_id, collection_id, score, content_preview(200ch), source, page, chunk_index}
    retrieved_chunks: list[dict[str, Any]] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSONB(), nullable=False, server_default="[]"),
    )
    retrieved_chunk_count: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )

    # --- System prompt composition ---
    system_prompt_length: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )
    context_token_estimate: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )
    history_message_count: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )
    has_conversation_summary: bool = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False, server_default="false"),
    )

    # --- LLM execution ---
    provider: str | None = Field(default=None, max_length=50)
    model: str | None = Field(default=None, max_length=100)
    input_tokens: int | None = Field(default=None, sa_column=Column(Integer, nullable=True))
    output_tokens: int | None = Field(default=None, sa_column=Column(Integer, nullable=True))
    total_tokens: int | None = Field(default=None, sa_column=Column(Integer, nullable=True))
    cost_usd: float | None = Field(default=None, sa_column=Column(Float, nullable=True))
    latency_ms: int | None = Field(default=None, sa_column=Column(Integer, nullable=True))
    duration_ms: int | None = Field(default=None, sa_column=Column(Integer, nullable=True))

    # --- Response preview (500 chars for dataset browsing, full text in Kotlin messages) ---
    response_preview: str | None = Field(default=None, sa_column=Column(String(500), nullable=True))

    # --- Agentic-specific ---
    source_analysis: dict[str, Any] | None = Field(
        default=None,
        sa_column=Column(ScrapalotJSON(), nullable=True),
    )

    # --- Tiered routing ---
    routing_tier: int | None = Field(
        default=None,
        sa_column=Column(Integer, nullable=True),
    )  # 1=rule_based, 2=exemplar, 3=llm_agent, 4=post_retrieval_fallback
    routing_tier_name: str | None = Field(default=None, max_length=30)
