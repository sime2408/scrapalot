"""Fix jobs.id column type from VARCHAR to UUID.

The jobs table was created with id as character varying, but the SQLAlchemy model
uses ScrapalotUUID which maps to PostgreSQL UUID. This mismatch caused
'operator does not exist: character varying = uuid' errors during ORM updates.

Revision ID: 037
Revises: 036
Create Date: 2026-03-12
"""

from alembic import op

# revision identifiers
revision = "037"
down_revision = "036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE jobs ALTER COLUMN id TYPE uuid USING id::uuid")


def downgrade() -> None:
    op.execute("ALTER TABLE jobs ALTER COLUMN id TYPE character varying USING id::text")
