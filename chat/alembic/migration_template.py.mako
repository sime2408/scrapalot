"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import Column, String, Text, DateTime, Integer, Boolean, Float, ForeignKey
import sys
import os

# Add the project root to the Python path to import our custom db_utils
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from alembic import db_utils

# revision identifiers, used by Alembic.
revision = ${repr(up_revision)}
down_revision = ${repr(down_revision)}
branch_labels = ${repr(branch_labels)}
depends_on = ${repr(depends_on)}


def upgrade() -> None:
    # Get dialect information
    dialect_info = db_utils.get_dialect_info()

    # Example of cross-database compatible operations:
    #
    # 1. Creating a table with UUID and JSON columns
    # if not db_utils.table_exists('my_table'):
    #     op.create_table(
    #         db_utils.get_table_name('my_table'),
    #         Column('id', db_utils.get_uuid_column_type(), primary_key=True),
    #         Column('name', String(255), nullable=False),
    #         Column('metadata', db_utils.get_json_column_type(), nullable=True),
    #         Column('created_at', DateTime, nullable=False),
    #     )
    #
    # 2. Adding a column if it doesn't exist
    # if not db_utils.column_exists('my_table', 'new_column'):
    #     op.add_column(
    #         db_utils.get_table_name('my_table'),
    #         Column('new_column', String(50), nullable=True)
    #     )
    #
    # 3. Safely dropping a constraint
    # db_utils.safe_drop_constraint('my_table', 'fk_my_constraint', type_='foreignkey')

    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    # Get dialect information
    dialect_info = db_utils.get_dialect_info()

    ${downgrades if downgrades else "pass"}
