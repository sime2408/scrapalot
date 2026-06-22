"""add_tutor_curriculum_tables

Revision ID: 063
Revises: 062
Create Date: 2026-04-27

CATEGORY_07 §7.8 v3 — full AI Tutor mode. Adds four tables that drive
the curriculum-based tutor:

  * tutor_curricula        — one curriculum per collection. Built once
                              by curriculum_extractor; rebuilt only
                              when the collection's Leiden communities
                              get re-detected.
  * tutor_lessons          — lessons in a curriculum, ordered top-down
                              through the Leiden hierarchy. Each lesson
                              maps 1:1 to a Neo4j Community node.
  * tutor_sessions         — per-user state machine for an in-progress
                              curriculum walk. Tracks current lesson +
                              state (lesson_intro / check_understanding /
                              drill_in / quiz / next_lesson).
  * tutor_quiz_attempts    — per-question quiz history feeding into
                              "revisit struggling concepts" at v4.

Postgres-only ownership (Python AI). Kotlin reads progress through gRPC.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "063"
down_revision: str | None = "062"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ─── tutor_curricula ────────────────────────────────────────────
    op.create_table(
        "tutor_curricula",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "collection_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
            unique=True,
            comment="One curriculum per collection. Re-extract when Leiden runs again.",
        ),
        sa.Column(
            "status",
            sa.String(length=24),
            nullable=False,
            server_default=sa.text("'building'"),
            comment="building | ready | failed",
        ),
        sa.Column("lesson_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint("status IN ('building', 'ready', 'failed')", name="ck_tutor_curricula_status"),
    )
    op.create_index("ix_tutor_curricula_collection", "tutor_curricula", ["collection_id"], unique=True)

    # ─── tutor_lessons ──────────────────────────────────────────────
    op.create_table(
        "tutor_lessons",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "curriculum_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tutor_curricula.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "lesson_ord",
            sa.Integer(),
            nullable=False,
            comment="Order within the curriculum, 0-indexed. Top-of-hierarchy first.",
        ),
        sa.Column(
            "community_id",
            sa.String(length=64),
            nullable=False,
            comment="Neo4j Community.id this lesson maps to. Source of title/summary.",
        ),
        sa.Column("level", sa.Integer(), nullable=False, comment="Leiden hierarchy level (0=broadest)."),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column(
            "entity_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
            comment="How many entities this community contains. Larger = denser concept.",
        ),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("curriculum_id", "lesson_ord", name="uq_tutor_lessons_curriculum_ord"),
    )
    op.create_index("ix_tutor_lessons_curriculum", "tutor_lessons", ["curriculum_id", "lesson_ord"])

    # ─── tutor_sessions ─────────────────────────────────────────────
    op.create_table(
        "tutor_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "curriculum_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tutor_curricula.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "current_lesson_ord",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "current_state",
            sa.String(length=24),
            nullable=False,
            server_default=sa.text("'lesson_intro'"),
            comment="lesson_intro | check_understanding | drill_in | quiz | lesson_recap",
        ),
        sa.Column(
            "messages_in_lesson",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
            comment="Turns spent in current lesson. Used to detect when to advance to quiz.",
        ),
        sa.Column(
            "lessons_completed",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
            comment="JSON array of completed lesson_ord ints — drives the progress tree.",
        ),
        sa.Column(
            "status",
            sa.String(length=24),
            nullable=False,
            server_default=sa.text("'active'"),
            comment="active | paused | completed",
        ),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("last_active_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint(
            "current_state IN ('lesson_intro', 'check_understanding', 'drill_in', 'quiz', 'lesson_recap')",
            name="ck_tutor_sessions_state",
        ),
        sa.CheckConstraint("status IN ('active', 'paused', 'completed')", name="ck_tutor_sessions_status"),
    )
    op.create_index("ix_tutor_sessions_user_active", "tutor_sessions", ["user_id", "status"])
    op.create_index(
        "ix_tutor_sessions_user_curriculum",
        "tutor_sessions",
        ["user_id", "curriculum_id"],
        unique=False,
    )

    # ─── tutor_quiz_attempts ────────────────────────────────────────
    op.create_table(
        "tutor_quiz_attempts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tutor_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("lesson_ord", sa.Integer(), nullable=False),
        sa.Column("question_text", sa.Text(), nullable=False),
        sa.Column("user_answer", sa.Text(), nullable=True),
        sa.Column(
            "correct",
            sa.Boolean(),
            nullable=True,
            comment="NULL until graded by the LLM; bool after.",
        ),
        sa.Column("feedback", sa.Text(), nullable=True),
        sa.Column("attempted_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("ix_tutor_quiz_attempts_session", "tutor_quiz_attempts", ["session_id", "lesson_ord"])


def downgrade() -> None:
    op.drop_index("ix_tutor_quiz_attempts_session", table_name="tutor_quiz_attempts")
    op.drop_table("tutor_quiz_attempts")
    op.drop_index("ix_tutor_sessions_user_curriculum", table_name="tutor_sessions")
    op.drop_index("ix_tutor_sessions_user_active", table_name="tutor_sessions")
    op.drop_table("tutor_sessions")
    op.drop_index("ix_tutor_lessons_curriculum", table_name="tutor_lessons")
    op.drop_table("tutor_lessons")
    op.drop_index("ix_tutor_curricula_collection", table_name="tutor_curricula")
    op.drop_table("tutor_curricula")
