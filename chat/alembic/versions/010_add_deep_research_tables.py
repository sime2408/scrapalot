"""Add deep research tables for Phase 5 research feature

Revision ID: 010
Revises: 009
Create Date: 2025-12-13

This migration adds the database schema for the deep research feature:
- research_templates: User-level permanent research templates
- research_plans: Research plans linked to sessions/messages
- research_tasks: Task decomposition for research plans
- research_sources: Web sources collected during research
- research_synthesis: Final synthesis and QA results

Supports both PostgreSQL and SQLite databases.
"""

from pathlib import Path
import sys

# Add parent directory to path for importing db_utils
parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from typing import Union
from collections.abc import Sequence
# noinspection PyUnresolvedReferences
import db_utils
import sqlalchemy as sa
from alembic import op

# Revision identifiers
revision = "010"
down_revision = "009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade():
    """Add deep research tables."""

    # 1. Create research_templates table (user-level permanent data)
    if not db_utils.table_exists("research_templates"):
        print("Creating research_templates table...")
        op.create_table(
            "research_templates",
            # id column with primary key (no separate index needed)
            db_utils.create_uuid_column("id", primary_key=True),
            # user_id with index=True creates the index automatically
            db_utils.create_uuid_column("user_id", nullable=False, index=True, foreign_key="users.id", on_delete="CASCADE"),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("description", sa.Text, nullable=True),
            sa.Column("is_default", sa.Boolean, nullable=False, server_default="false"),
            sa.Column("methodology", sa.String(50), nullable=True, server_default="analytical"),
            sa.Column("agent_config", db_utils.get_json_column_type(), nullable=False, server_default="{}"),
            sa.Column("quality_standards", db_utils.get_json_column_type(), nullable=False, server_default="{}"),
            sa.Column("citation_style", sa.String(20), nullable=False, server_default="APA"),
            sa.Column("use_count", sa.Integer, nullable=False, server_default="0"),
            sa.Column("last_used_at", db_utils.get_datetime_column_type(), nullable=True),
            db_utils.create_datetime_column("created_at", nullable=False, default_now=True),
            db_utils.create_datetime_column("updated_at", nullable=False, default_now=True, update_now=True),
        )
        # Only create index on name (user_id index is created by create_uuid_column)
        op.create_index("ix_research_templates_name", "research_templates", ["name"])
    else:
        print("research_templates table already exists, skipping...")

    # 2. Create research_plans table (session-level research data)
    if not db_utils.table_exists("research_plans"):
        print("Creating research_plans table...")
        op.create_table(
            "research_plans",
            db_utils.create_uuid_column("id", primary_key=True),
            # These create their own indices via index=True
            db_utils.create_uuid_column("session_id", nullable=False, index=True, foreign_key="sessions.id", on_delete="CASCADE"),
            db_utils.create_uuid_column("message_id", nullable=False, index=True, foreign_key="messages.id", on_delete="CASCADE"),
            db_utils.create_uuid_column("template_id", nullable=True, foreign_key="research_templates.id", on_delete="SET NULL"),
            sa.Column("query", sa.Text, nullable=False),
            sa.Column("methodology", sa.String(50), nullable=False, server_default="analytical"),
            sa.Column("sections", db_utils.get_json_column_type(), nullable=False, server_default="{}"),
            sa.Column("complexity_score", sa.Float, nullable=False, server_default="0.5"),
            sa.Column("estimated_sources", sa.Integer, nullable=False, server_default="10"),
            sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
            sa.Column("progress", sa.Float, nullable=False, server_default="0.0"),
            sa.Column("started_at", db_utils.get_datetime_column_type(), nullable=True),
            sa.Column("completed_at", db_utils.get_datetime_column_type(), nullable=True),
            sa.Column("error_message", sa.Text, nullable=True),
            db_utils.create_datetime_column("created_at", nullable=False, default_now=True),
            db_utils.create_datetime_column("updated_at", nullable=False, default_now=True, update_now=True),
        )
        # Only create index on status (FK indices created automatically)
        op.create_index("ix_research_plans_status", "research_plans", ["status"])
    else:
        print("research_plans table already exists, skipping...")

    # 3. Create research_tasks table (task decomposition)
    if not db_utils.table_exists("research_tasks"):
        print("Creating research_tasks table...")
        op.create_table(
            "research_tasks",
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_uuid_column("plan_id", nullable=False, index=True, foreign_key="research_plans.id", on_delete="CASCADE"),
            sa.Column("task_index", sa.Integer, nullable=False),
            sa.Column("title", sa.String(500), nullable=False),
            sa.Column("description", sa.Text, nullable=True),
            sa.Column("agent_type", sa.String(50), nullable=False),
            sa.Column("parallel_group", sa.Integer, nullable=False, server_default="0"),
            sa.Column("dependencies", db_utils.get_json_column_type(), nullable=False, server_default="[]"),
            sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
            sa.Column("progress", sa.Float, nullable=False, server_default="0.0"),
            sa.Column("findings", db_utils.get_json_column_type(), nullable=False, server_default="{}"),
            sa.Column("quality_score", sa.Float, nullable=True),
            sa.Column("started_at", db_utils.get_datetime_column_type(), nullable=True),
            sa.Column("completed_at", db_utils.get_datetime_column_type(), nullable=True),
            sa.Column("error_message", sa.Text, nullable=True),
            sa.Column("retry_count", sa.Integer, nullable=False, server_default="0"),
            db_utils.create_datetime_column("created_at", nullable=False, default_now=True),
            db_utils.create_datetime_column("updated_at", nullable=False, default_now=True, update_now=True),
        )
        # Create indices on status and agent_type (plan_id index created automatically)
        op.create_index("ix_research_tasks_status", "research_tasks", ["status"])
        op.create_index("ix_research_tasks_agent_type", "research_tasks", ["agent_type"])
    else:
        print("research_tasks table already exists, skipping...")

    # 4. Create research_sources table (web sources)
    if not db_utils.table_exists("research_sources"):
        print("Creating research_sources table...")
        op.create_table(
            "research_sources",
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_uuid_column("plan_id", nullable=False, index=True, foreign_key="research_plans.id", on_delete="CASCADE"),
            sa.Column("url", sa.Text, nullable=False),
            sa.Column("title", sa.String(500), nullable=True),
            sa.Column("domain", sa.String(255), nullable=True),
            sa.Column("source_type", sa.String(50), nullable=True),
            sa.Column("content_snippet", sa.Text, nullable=True),
            sa.Column("extracted_data", db_utils.get_json_column_type(), nullable=False, server_default="{}"),
            sa.Column("credibility_score", sa.Float, nullable=False, server_default="0.5"),
            sa.Column("bias_score", sa.Float, nullable=False, server_default="0.0"),
            sa.Column("quality_indicators", db_utils.get_json_column_type(), nullable=False, server_default="{}"),
            sa.Column("used_in_synthesis", sa.Boolean, nullable=False, server_default="false"),
            sa.Column("citation_count", sa.Integer, nullable=False, server_default="0"),
            sa.Column("fetched_at", db_utils.get_datetime_column_type(), nullable=True),
            sa.Column("evaluation_completed", sa.Boolean, nullable=False, server_default="false"),
            db_utils.create_datetime_column("created_at", nullable=False, default_now=True),
            db_utils.create_datetime_column("updated_at", nullable=False, default_now=True, update_now=True),
        )
        # Create index on credibility_score (plan_id index created automatically)
        op.create_index("ix_research_sources_credibility_score", "research_sources", ["credibility_score"])
    else:
        print("research_sources table already exists, skipping...")

    # 5. Create research_synthesis table (final synthesis and QA)
    if not db_utils.table_exists("research_synthesis"):
        print("Creating research_synthesis table...")
        op.create_table(
            "research_synthesis",
            db_utils.create_uuid_column("id", primary_key=True),
            db_utils.create_uuid_column("plan_id", nullable=False, index=True, unique=True, foreign_key="research_plans.id", on_delete="CASCADE"),
            sa.Column("title", sa.String(500), nullable=False),
            sa.Column("executive_summary", sa.Text, nullable=True),
            sa.Column("main_content", sa.Text, nullable=True),
            sa.Column("sections", db_utils.get_json_column_type(), nullable=False, server_default="{}"),
            sa.Column("conclusions", db_utils.get_json_column_type(), nullable=False, server_default="[]"),
            sa.Column("limitations", db_utils.get_json_column_type(), nullable=False, server_default="[]"),
            sa.Column("recommendations", db_utils.get_json_column_type(), nullable=False, server_default="[]"),
            sa.Column("citations", db_utils.get_json_column_type(), nullable=False, server_default="[]"),
            sa.Column("bibliography", db_utils.get_json_column_type(), nullable=False, server_default="[]"),
            sa.Column("citation_style", sa.String(20), nullable=False, server_default="APA"),
            sa.Column("quality_score", sa.Float, nullable=False, server_default="0.0"),
            sa.Column("quality_dimensions", db_utils.get_json_column_type(), nullable=False, server_default="{}"),
            sa.Column("validation_results", db_utils.get_json_column_type(), nullable=False, server_default="{}"),
            sa.Column("claims_validated", sa.Integer, nullable=False, server_default="0"),
            sa.Column("contradictions_found", sa.Integer, nullable=False, server_default="0"),
            sa.Column("contradiction_resolutions", db_utils.get_json_column_type(), nullable=False, server_default="[]"),
            sa.Column("total_sources_used", sa.Integer, nullable=False, server_default="0"),
            sa.Column("word_count", sa.Integer, nullable=False, server_default="0"),
            sa.Column("synthesis_completed_at", db_utils.get_datetime_column_type(), nullable=True),
            sa.Column("qa_completed_at", db_utils.get_datetime_column_type(), nullable=True),
            db_utils.create_datetime_column("created_at", nullable=False, default_now=True),
            db_utils.create_datetime_column("updated_at", nullable=False, default_now=True, update_now=True),
        )
        # Create index on quality_score (plan_id index created automatically)
        op.create_index("ix_research_synthesis_quality_score", "research_synthesis", ["quality_score"])
    else:
        print("research_synthesis table already exists, skipping...")

    print("Deep research tables created successfully!")


def downgrade():
    """Remove deep research tables."""
    # Drop tables in reverse order (respecting foreign key dependencies)
    tables_to_drop = [
        "research_synthesis",
        "research_sources",
        "research_tasks",
        "research_plans",
        "research_templates",
    ]

    for table_name in tables_to_drop:
        if db_utils.table_exists(table_name):
            print(f"Dropping {table_name} table...")
            try:
                op.drop_table(table_name)
            except Exception as e:
                print(f"Error dropping {table_name}: {e}")
        else:
            print(f"{table_name} table does not exist, skipping...")

    print("Deep research tables dropped successfully!")
