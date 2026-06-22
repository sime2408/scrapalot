"""Add parser_comparisons table (shadow PDF-parser comparison)

One row per (document, parser): the deterministic quality score that backend
earned on that document plus an is_winner flag. Lets pymupdf4llm run in
production while LiteParse (and future backends) parse in shadow, so a
statistical query can later decide whether to flip the production parser.

Revision ID: 087
Revises: 086
Create Date: 2026-06-21

"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "087"
down_revision = "086"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS parser_comparisons (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            parser_name VARCHAR(32) NOT NULL,
            is_winner BOOLEAN NOT NULL DEFAULT FALSE,
            expected_chapters INTEGER,
            total_score DOUBLE PRECISION NOT NULL DEFAULT 0,
            structure_score DOUBLE PRECISION,
            completeness_score DOUBLE PRECISION,
            cleanliness_score DOUBLE PRECISION,
            page_count INTEGER,
            char_count INTEGER,
            header_count INTEGER,
            br_count INTEGER,
            parse_ms DOUBLE PRECISION,
            metrics_json JSONB,
            error TEXT
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_parser_comparisons_document_id ON parser_comparisons (document_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_parser_comparisons_parser_name ON parser_comparisons (parser_name)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_parser_comparisons_winner ON parser_comparisons (parser_name, is_winner)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS parser_comparisons")
