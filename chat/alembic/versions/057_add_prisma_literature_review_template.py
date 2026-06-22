"""Add PRISMA Literature Review template

Revision ID: 057
Revises: 056
Create Date: 2026-04-13

Adds a PRISMA-compliant systematic literature review template to the
research_templates table. Uses PICO framework and formal screening
methodology per PRISMA 2020 guidelines.
"""

import json
from uuid import uuid4
from alembic import op
import sqlalchemy as sa

revision = "057"
down_revision = "056"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # Check if template already exists
    result = conn.execute(
        sa.text("SELECT id FROM research_templates WHERE template_type = 'prisma_literature_review' LIMIT 1")
    )
    if result.fetchone():
        return

    conn.execute(
        sa.text("""
            INSERT INTO research_templates (
                id, user_id, name, description, template_type,
                methodology, depth, breadth, source_types, output_format,
                clarification_categories, tone, max_iterations, is_default,
                is_system, citation_style, quality_standards
            ) VALUES (
                :id, :user_id, :name, :description, :template_type,
                :methodology, :depth, :breadth, :source_types, :output_format,
                :clarification_categories, :tone, :max_iterations, :is_default,
                :is_system, :citation_style, :quality_standards
            )
        """),
        {
            'id': str(uuid4()),
            'user_id': '00000000-0000-0000-0000-000000000000',
            'name': 'PRISMA Systematic Review',
            'description': 'PRISMA 2020-compliant systematic literature review with PICO framework, formal screening pipeline, study quality assessment, and evidence grading.',
            'template_type': 'prisma_literature_review',
            'methodology': 'prisma_systematic_review',
            'depth': 5,
            'breadth': 6,
            'source_types': json.dumps(['peer_reviewed', 'academic_papers', 'clinical_trials', 'meta_analyses']),
            'output_format': 'structured_report',
            'clarification_categories': json.dumps(['methodology', 'scope_constraints', 'data_requirements', 'inclusion_exclusion']),
            'tone': 'systematic',
            'max_iterations': 5,
            'is_default': False,
            'is_system': True,
            'citation_style': 'apa',
            'quality_standards': json.dumps({
                'min_sources': 10,
                'require_methodology': True,
                'evidence_grading': True,
                'bias_assessment': True,
            }),
        }
    )


def downgrade() -> None:
    op.execute("DELETE FROM research_templates WHERE template_type = 'prisma_literature_review'")
