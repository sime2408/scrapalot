"""Add user_id to research_plans for cross-device active research

Lets us find a user's active research across all their sessions/devices (so the
panel shows on a second device) and enforce one active deep-research run per user.

Revision ID: 086
Revises: 085
Create Date: 2026-06-20

"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "086"
down_revision = "085"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Idempotent: column + index may already exist on some environments.
    op.execute("ALTER TABLE research_plans ADD COLUMN IF NOT EXISTS user_id UUID")
    # Plain CREATE INDEX (chat Alembic env runs inside an explicit transaction,
    # so CONCURRENTLY is not available here — see reference_alembic_concurrently_gotcha).
    op.execute("CREATE INDEX IF NOT EXISTS ix_research_plans_user_id ON research_plans (user_id)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_research_plans_user_id")
    op.execute("ALTER TABLE research_plans DROP COLUMN IF EXISTS user_id")
