"""Convert server_settings.id varchar to uuid

Revision ID: 077
Revises: 076
Create Date: 2026-06-04 11:18:21.033576

server_settings.id drifted to ``character varying`` while every BaseModel table
uses a real ``uuid`` primary key (ScrapalotUUID). INSERT worked, but any UPDATE
bound ``WHERE id = %(id)s::UUID`` and Postgres rejected ``varchar = uuid`` with
``operator does not exist`` — so re-saving an existing server_settings row
(e.g. system_agent_config via the admin "System AI Agent Provider" form) always
failed. Two legacy seed rows (consent_*_text) used their setting_key as the id,
so they are reassigned fresh uuids before the column type is tightened. No FK
references server_settings.id, so the reassignment is safe.
"""
from typing import Union
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "077"
down_revision: str | None = "076"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. Give any non-uuid id (legacy consent_* seed rows keyed by setting_key)
    #    a fresh uuid so the ::uuid cast below cannot fail.
    op.execute(
        r"""
        UPDATE server_settings
        SET id = gen_random_uuid()::text
        WHERE id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        """
    )
    # 2. Tighten the column to uuid to match BaseModel (fixes varchar = uuid UPDATE).
    op.execute("ALTER TABLE server_settings ALTER COLUMN id TYPE uuid USING id::uuid")


def downgrade() -> None:
    op.execute("ALTER TABLE server_settings ALTER COLUMN id TYPE varchar USING id::text")
