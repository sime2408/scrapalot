"""Fix unique filename constraint to exclude soft-deleted documents.

Old constraint blocked re-upload of files that were soft-deleted (deleted_at IS NOT NULL).
New partial unique index only enforces uniqueness for non-deleted documents.

Revision ID: 048
Revises: 047
Create Date: 2026-03-28
"""

from alembic import op

revision = "048"
down_revision = "047"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop old absolute unique constraint if it exists (may already be dropped manually)
    # Use raw SQL because op.drop_constraint doesn't support IF EXISTS
    op.execute("ALTER TABLE documents DROP CONSTRAINT IF EXISTS uq_documents_collection_filename")
    op.execute("DROP INDEX IF EXISTS uq_documents_collection_filename")

    # Create partial unique index — only non-deleted documents must have unique filenames
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_collection_filename "
        "ON documents (collection_id, filename) "
        "WHERE deleted_at IS NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_documents_collection_filename")
    op.create_unique_constraint(
        "uq_documents_collection_filename", "documents", ["collection_id", "filename"]
    )
