"""Add provider_version column to model_providers

Revision ID: 069
Revises: 068
Create Date: 2026-05-10 09:44:53.899103

Stores the backend semantic version reported by self-hosted providers (Ollama,
vLLM, llamacpp). Populated at provider sync time so the structured-output
router can gate features behind a minimum version — e.g. Ollama gained native
``format=<schema>`` enforcement in 0.5.0; older Ollama instances must fall back
to the broad ``format: "json"`` mode.

Nullable string column (no backfill needed). Hosted providers without a public
version endpoint (OpenAI, Anthropic, Google) leave it NULL and the router
treats them as "natively handled".
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "069"
down_revision: str | None = "068"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "model_providers",
        sa.Column(
            "provider_version",
            sa.String(length=64),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("model_providers", "provider_version")
