"""add_template_columns_and_clarification_sessions

Revision ID: 052
Revises: 051
Create Date: 2026-04-04

"""
from typing import Union
from collections.abc import Sequence
from uuid import uuid4

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '052'
down_revision: str | None = '051'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# ── helpers ─────────────────────────────────────────────────────────────────

def _is_pg() -> bool:
    bind = op.get_bind()
    return bind.dialect.name == 'postgresql'


def _jsonb_or_text():
    return sa.Text() if not _is_pg() else postgresql.JSONB()


def _uuid_type():
    return postgresql.UUID(as_uuid=False) if _is_pg() else sa.String(36)


# ── upgrade ──────────────────────────────────────────────────────────────────

def upgrade() -> None:
    # 1. Add new columns to research_templates
    with op.batch_alter_table('research_templates') as batch_op:
        batch_op.add_column(sa.Column('template_type', sa.String(50), nullable=True))
        batch_op.add_column(sa.Column('depth', sa.Integer(), nullable=False, server_default='3'))
        batch_op.add_column(sa.Column('breadth', sa.Integer(), nullable=False, server_default='3'))
        batch_op.add_column(sa.Column('source_types', _jsonb_or_text(), nullable=False, server_default='[]'))
        batch_op.add_column(sa.Column('output_format', sa.String(50), nullable=False, server_default='report'))
        batch_op.add_column(sa.Column('clarification_categories', _jsonb_or_text(), nullable=False, server_default='[]'))
        batch_op.add_column(sa.Column('tone', sa.String(50), nullable=False, server_default='objective'))
        batch_op.add_column(sa.Column('max_iterations', sa.Integer(), nullable=False, server_default='1'))
        batch_op.add_column(sa.Column('is_system', sa.Boolean(), nullable=False, server_default='false'))

    # 2. Add clarification context to research_plans
    with op.batch_alter_table('research_plans') as batch_op:
        batch_op.add_column(sa.Column('clarification_session_id', _uuid_type(), nullable=True))
        batch_op.add_column(sa.Column('clarification_context', _jsonb_or_text(), nullable=True))

    # 3. Create clarification_sessions table
    op.create_table(
        'clarification_sessions',
        sa.Column('id', _uuid_type(), primary_key=True, nullable=False),
        sa.Column('user_id', _uuid_type(), nullable=False, index=True),
        sa.Column('session_id', _uuid_type(), nullable=True),
        sa.Column('initial_query', sa.Text(), nullable=False),
        sa.Column('template_type', sa.String(50), nullable=True),
        sa.Column('questions', _jsonb_or_text(), nullable=False, server_default='[]'),
        sa.Column('answers', _jsonb_or_text(), nullable=False, server_default='[]'),
        sa.Column('plan_preview', _jsonb_or_text(), nullable=True),
        sa.Column('plan_feedback', _jsonb_or_text(), nullable=False, server_default='[]'),
        sa.Column('status', sa.String(30), nullable=False, server_default='created'),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.func.now(), onupdate=sa.func.now()),
    )
    op.create_index('ix_clarification_sessions_user', 'clarification_sessions', ['user_id'])
    op.create_index('ix_clarification_sessions_status', 'clarification_sessions', ['status'])

    # 4. Seed 5 system templates (user_id = NULL placeholder, is_system = true)
    _seed_system_templates()


def _seed_system_templates():
    import json
    from datetime import datetime

    now = datetime.utcnow()

    templates = [
        {
            'id': str(uuid4()),
            'user_id': '00000000-0000-0000-0000-000000000000',
            'name': 'Scientific Paper Research',
            'description': 'Deep literature review for academic writing. Prioritizes peer-reviewed sources, high citation standards.',
            'template_type': 'scientific_paper',
            'methodology': 'systematic_literature_review',
            'depth': 5,
            'breadth': 3,
            'source_types': json.dumps(['academic_papers', 'books_publications', 'statistical_data']),
            'output_format': 'academic_paper',
            'clarification_categories': json.dumps(['methodology', 'scope_constraints', 'data_requirements']),
            'quality_standards': json.dumps({'accuracy': 0.95, 'completeness': 0.90, 'citation': 0.95}),
            'citation_style': 'APA',
            'tone': 'objective',
            'max_iterations': 1,
            'is_system': True,
            'is_default': False,
            'use_count': 0,
            'agent_config': '{}',
            'created_at': now,
            'updated_at': now,
        },
        {
            'id': str(uuid4()),
            'user_id': '00000000-0000-0000-0000-000000000000',
            'name': 'Literature Review',
            'description': 'Broad survey of a field. High breadth, systematic organization by theme or chronology.',
            'template_type': 'literature_review',
            'methodology': 'systematic_literature_review',
            'depth': 4,
            'breadth': 5,
            'source_types': json.dumps(['academic_papers', 'books_publications', 'industry_reports', 'expert_blogs']),
            'output_format': 'annotated_bibliography',
            'clarification_categories': json.dumps(['scope_constraints', 'methodology', 'output']),
            'quality_standards': json.dumps({'accuracy': 0.90, 'completeness': 0.95, 'citation': 0.90}),
            'citation_style': 'APA',
            'tone': 'analytical',
            'max_iterations': 1,
            'is_system': True,
            'is_default': False,
            'use_count': 0,
            'agent_config': '{}',
            'created_at': now,
            'updated_at': now,
        },
        {
            'id': str(uuid4()),
            'user_id': '00000000-0000-0000-0000-000000000000',
            'name': 'Concept Exploration',
            'description': 'Broad exploration of a new topic. Diverse sources, narrative style.',
            'template_type': 'concept_exploration',
            'methodology': 'mixed_methods',
            'depth': 3,
            'breadth': 5,
            'source_types': json.dumps(['academic_papers', 'news_articles', 'expert_blogs', 'official_websites', 'books_publications']),
            'output_format': 'report',
            'clarification_categories': json.dumps(['ambiguity', 'scope_constraints']),
            'quality_standards': json.dumps({'accuracy': 0.80, 'completeness': 0.85, 'citation': 0.75}),
            'citation_style': 'APA',
            'tone': 'narrative',
            'max_iterations': 1,
            'is_system': True,
            'is_default': True,
            'use_count': 0,
            'agent_config': '{}',
            'created_at': now,
            'updated_at': now,
        },
        {
            'id': str(uuid4()),
            'user_id': '00000000-0000-0000-0000-000000000000',
            'name': 'Fact Verification',
            'description': 'Deep but narrow fact-checking. Authoritative sources only, high accuracy standard.',
            'template_type': 'fact_verification',
            'methodology': 'investigative_journalism',
            'depth': 5,
            'breadth': 2,
            'source_types': json.dumps(['academic_papers', 'government_reports', 'official_websites', 'statistical_data']),
            'output_format': 'bullet_points',
            'clarification_categories': json.dumps(['ambiguity', 'data_requirements']),
            'quality_standards': json.dumps({'accuracy': 0.98, 'completeness': 0.70, 'citation': 0.95}),
            'citation_style': 'Chicago',
            'tone': 'objective',
            'max_iterations': 1,
            'is_system': True,
            'is_default': False,
            'use_count': 0,
            'agent_config': '{}',
            'created_at': now,
            'updated_at': now,
        },
        {
            'id': str(uuid4()),
            'user_id': '00000000-0000-0000-0000-000000000000',
            'name': 'Comparative Analysis',
            'description': 'Balanced comparison of technologies, approaches, or theories. Analytical style.',
            'template_type': 'comparative_analysis',
            'methodology': 'comparative_study',
            'depth': 4,
            'breadth': 4,
            'source_types': json.dumps(['academic_papers', 'industry_reports', 'news_articles', 'official_websites']),
            'output_format': 'report',
            'clarification_categories': json.dumps(['scope_constraints', 'methodology', 'output']),
            'quality_standards': json.dumps({'accuracy': 0.90, 'completeness': 0.85, 'citation': 0.85}),
            'citation_style': 'APA',
            'tone': 'analytical',
            'max_iterations': 1,
            'is_system': True,
            'is_default': False,
            'use_count': 0,
            'agent_config': '{}',
            'created_at': now,
            'updated_at': now,
        },
    ]

    conn = op.get_bind()
    conn.execute(
        sa.text("""
            INSERT INTO research_templates
                (id, user_id, name, description, template_type, methodology,
                 depth, breadth, source_types, output_format, clarification_categories,
                 quality_standards, citation_style, tone, max_iterations,
                 is_system, is_default, use_count, agent_config, created_at, updated_at)
            VALUES
                (:id, :user_id, :name, :description, :template_type, :methodology,
                 :depth, :breadth, :source_types, :output_format, :clarification_categories,
                 :quality_standards, :citation_style, :tone, :max_iterations,
                 :is_system, :is_default, :use_count, :agent_config, :created_at, :updated_at)
            ON CONFLICT DO NOTHING
        """),
        templates,
    )


# ── downgrade ────────────────────────────────────────────────────────────────

def downgrade() -> None:
    op.drop_index('ix_clarification_sessions_status', table_name='clarification_sessions')
    op.drop_index('ix_clarification_sessions_user', table_name='clarification_sessions')
    op.drop_table('clarification_sessions')

    with op.batch_alter_table('research_plans') as batch_op:
        batch_op.drop_column('clarification_context')
        batch_op.drop_column('clarification_session_id')

    with op.batch_alter_table('research_templates') as batch_op:
        batch_op.drop_column('is_system')
        batch_op.drop_column('max_iterations')
        batch_op.drop_column('tone')
        batch_op.drop_column('clarification_categories')
        batch_op.drop_column('output_format')
        batch_op.drop_column('source_types')
        batch_op.drop_column('breadth')
        batch_op.drop_column('depth')
        batch_op.drop_column('template_type')
