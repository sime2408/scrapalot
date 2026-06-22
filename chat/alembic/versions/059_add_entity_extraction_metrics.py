"""add_entity_extraction_metrics

Revision ID: 059
Revises: 058
Create Date: 2026-04-17

Phase 05 (Computational Costs) — per-phase timing and LLM-cost accounting
for every run of `extract_entities_task`. Populated by
`src/main/service/graph/extraction_metrics_service.py::phase_timer`; read by
the admin dashboard (gRPC `GetEntityExtractionMetrics`).

One row per (document_id, phase) invocation. A single extraction writes 6–8
rows: preprocess, extract, dedup, enrich, store, cooccurrence, cleanup,
shared_entity.
"""
from typing import Union
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "059"
down_revision: str | None = "058"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "entity_extraction_metrics",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("document_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "collection_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
            comment="Optional — filled if the caller knows which collection owns the doc",
        ),
        sa.Column(
            "phase",
            sa.String(64),
            nullable=False,
            comment=(
                "preprocess | extract | dedup | enrich | store | "
                "cooccurrence | cleanup | shared_entity | total"
            ),
        ),
        sa.Column("duration_ms", sa.BigInteger, nullable=False),
        sa.Column("chunks_processed", sa.Integer, nullable=False, server_default="0"),
        sa.Column(
            "llm_calls",
            sa.Integer,
            nullable=False,
            server_default="0",
            comment="Actual LLM invocations during this phase",
        ),
        sa.Column(
            "llm_skipped",
            sa.Integer,
            nullable=False,
            server_default="0",
            comment="Chunks that bypassed the LLM pass via selective triggering (Phase 05 Work item B)",
        ),
        sa.Column("tokens_in", sa.Integer, nullable=False, server_default="0"),
        sa.Column("tokens_out", sa.Integer, nullable=False, server_default="0"),
        sa.Column(
            "cost_cents",
            sa.Numeric(12, 4),
            nullable=False,
            server_default="0",
            comment="Estimated LLM spend in USD cents",
        ),
        sa.Column(
            "provider",
            sa.String(64),
            nullable=True,
            comment="LLM provider name (e.g. 'openai') when applicable",
        ),
        sa.Column(
            "model_name",
            sa.String(128),
            nullable=True,
            comment="Model identifier (e.g. 'gpt-4o-mini') when applicable",
        ),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
    )
    op.create_index(
        "idx_eem_document",
        "entity_extraction_metrics",
        ["document_id", "started_at"],
    )
    op.create_index(
        "idx_eem_phase_time",
        "entity_extraction_metrics",
        ["phase", "started_at"],
    )
    op.create_index(
        "idx_eem_collection",
        "entity_extraction_metrics",
        ["collection_id", "started_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_eem_collection", table_name="entity_extraction_metrics")
    op.drop_index("idx_eem_phase_time", table_name="entity_extraction_metrics")
    op.drop_index("idx_eem_document", table_name="entity_extraction_metrics")
    op.drop_table("entity_extraction_metrics")
