"""Make llm_traces columns nullable for background tasks.

Entity extraction runs as Celery background task without a user session,
user_id, or query. The NOT NULL constraints caused every LLM usage tracking
call to fail with NotNullViolation during entity extraction.

Revision ID: 038
Revises: 037
Create Date: 2026-03-16
"""

from alembic import op

# revision identifiers
revision = '038'
down_revision = '037'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column('llm_traces', 'session_id', nullable=True)
    op.alter_column('llm_traces', 'user_id', nullable=True)
    op.alter_column('llm_traces', 'query', nullable=True)
    op.alter_column('llm_traces', 'collection_ids', nullable=True)


def downgrade() -> None:
    op.alter_column('llm_traces', 'session_id', nullable=False)
    op.alter_column('llm_traces', 'user_id', nullable=False)
    op.alter_column('llm_traces', 'query', nullable=False)
    op.alter_column('llm_traces', 'collection_ids', nullable=False)
