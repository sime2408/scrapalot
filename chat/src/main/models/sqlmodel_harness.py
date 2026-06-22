"""
SQLModel tables for the harness-comparison framework.

Two additive tables:

- ``harness_comparison_runs``    — one row per grid invocation (config snapshot,
                                   status, summary).
- ``harness_comparison_results`` — one row per (question × retriever ×
                                   delivery_mode × prompt_variant) cell, with
                                   judge scores and latency / cost.

Schema is non-destructive — rollback drops the tables, no existing rows touched.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import Column, ForeignKey, Index, Integer, Numeric, Text
from sqlmodel import Field

from src.main.models.sqlite_compat import ScrapalotJSON
from src.main.models.sqlmodel_base import BaseModel, ScrapalotUUID


class HarnessComparisonRun(BaseModel, table=True):
    """One harness-comparison grid run."""

    __tablename__ = "harness_comparison_runs"
    __table_args__ = (
        Index("ix_harness_runs_created_at", "created_at"),
        Index("ix_harness_runs_status", "status"),
        {"extend_existing": True},
    )

    created_by: UUID = Field(
        sa_column=Column(ScrapalotUUID(), nullable=False, index=True),
    )
    eval_set_id: str = Field(max_length=255, index=True)
    config: dict[str, Any] = Field(
        sa_column=Column(ScrapalotJSON, nullable=False),
    )
    # queued | running | done | failed | blocked_deploy_window
    status: str = Field(max_length=32, default="queued")
    summary: dict[str, Any] | None = Field(
        default=None,
        sa_column=Column(ScrapalotJSON, nullable=True),
    )
    started_at: datetime | None = Field(default=None)
    completed_at: datetime | None = Field(default=None)
    error_message: str | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
    )


class HarnessComparisonResult(BaseModel, table=True):
    """One cell of the (question × retriever × delivery × variant) grid."""

    __tablename__ = "harness_comparison_results"
    __table_args__ = (
        Index("ix_harness_results_run_id", "run_id"),
        Index("ix_harness_results_retriever", "retriever"),
        {"extend_existing": True},
    )

    run_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            ForeignKey("harness_comparison_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
    )
    question_id: str = Field(max_length=255)
    retriever: str = Field(max_length=64)
    delivery_mode: str = Field(max_length=16)  # inline | file
    prompt_variant: str = Field(max_length=64)

    answer_text: str | None = Field(default=None, sa_column=Column(Text, nullable=True))

    judge_relevance: float | None = Field(default=None, sa_column=Column(Numeric(3, 2), nullable=True))
    judge_groundedness: float | None = Field(default=None, sa_column=Column(Numeric(3, 2), nullable=True))
    judge_citation_accuracy: float | None = Field(default=None, sa_column=Column(Numeric(3, 2), nullable=True))

    latency_ms: int | None = Field(default=None, sa_column=Column(Integer, nullable=True))
    cost_usd: float | None = Field(default=None, sa_column=Column(Numeric(8, 4), nullable=True))
