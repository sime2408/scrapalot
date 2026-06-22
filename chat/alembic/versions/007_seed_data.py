"""Seed Initial Data

Revision ID: 00007
Revises: 00006
Create Date: 2025-12-05

Seeds initial data:
- Default admin user (username: admin, password: admin123)
- Admin workspace and default collection
- Default subscription plans (Researcher, Professional, Enterprise)
- Default server settings
- Default user settings template
"""
from pathlib import Path
import sys

parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

import os
from datetime import datetime
import json
from typing import Union
from collections.abc import Sequence
import uuid as uuid_lib

# noinspection PyUnresolvedReferences
import db_utils
from sqlalchemy import text

from alembic import op

revision = '007'
down_revision = '006'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# noinspection PyUnresolvedReferences, PyAttributeAccess, PyTypeChecker
def upgrade() -> None:
    """Seed initial data."""
    from passlib.context import CryptContext

    pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
    dialect_info = db_utils.get_dialect_info()
    connection = op.get_bind()

    # 1. Create subscription plans
    seed_subscription_plans(connection, dialect_info)

    # 2. Create admin user and workspace
    create_admin_user(connection, pwd_context, dialect_info)

    # 3. Create default server settings
    create_server_settings(connection)

    # 4. Create default user settings template
    create_default_user_settings(connection)


# noinspection PyUnresolvedReferences, PyAttributeAccess, PyTypeChecker
def seed_subscription_plans(connection, _dialect_info):
    """Create default subscription plans."""
    # Check if plans already exist
    check = connection.execute(
        text(f"SELECT COUNT(*) FROM {db_utils.get_table_name('subscription_plans')}")
    ).scalar()

    if check > 0:
        return

    plans = [
        {
            'id': str(uuid_lib.uuid4()),
            'name': 'researcher',
            'display_name': 'Researcher',
            'description': 'Perfect for individual researchers and students. Free forever.',
            'price_monthly': 0,
            'price_yearly': 0,
            'storage_limit_bytes': 1 * 1024 * 1024 * 1024,  # 1 GB
            'max_workspaces': 1,
            'max_collections_per_workspace': 5,
            'max_documents_per_collection': 10,
            'features': json.dumps({
                "shared_workspaces": False,
                "priority_support": False,
                "api_access": False
            }),
            'is_active': True,
            'trial_days': 0,
        },
        {
            'id': str(uuid_lib.uuid4()),
            'name': 'professional',
            'display_name': 'Professional',
            'description': 'For professionals and small teams who need more power and collaboration features.',
            'price_monthly': 19,
            'price_yearly': 190,
            'storage_limit_bytes': 10 * 1024 * 1024 * 1024,  # 10 GB
            'max_workspaces': 10,
            'max_collections_per_workspace': 50,
            'max_documents_per_collection': 500,
            'features': json.dumps({
                "shared_workspaces": True,
                "priority_support": True,
                "api_access": True,
                "advanced_analytics": True
            }),
            'is_active': True,
            'trial_days': 14,
        },
        {
            'id': str(uuid_lib.uuid4()),
            'name': 'enterprise',
            'display_name': 'Enterprise',
            'description': 'Custom solutions for large organizations with advanced needs.',
            'price_monthly': 99,
            'price_yearly': None,
            'storage_limit_bytes': None,  # Unlimited
            'max_workspaces': None,
            'max_collections_per_workspace': None,
            'max_documents_per_collection': None,
            'features': json.dumps({
                "shared_workspaces": True,
                "priority_support": True,
                "api_access": True,
                "advanced_analytics": True,
                "custom_integrations": True,
                "dedicated_support": True,
                "sla": True,
                "on_premise": True
            }),
            'is_active': True,
            'trial_days': 30,
        },
    ]

    now = datetime.now()
    for plan in plans:
        connection.execute(
            text(f"""
                INSERT INTO {db_utils.get_table_name('subscription_plans')}
                (id, name, description, price_monthly, price_yearly, storage_limit_bytes,
                 max_workspaces, max_collections_per_workspace, max_documents_per_collection,
                 features, is_active, trial_days, created_at, updated_at)
                VALUES (:id, :name, :description, :price_monthly, :price_yearly, :storage_limit_bytes,
                        :max_workspaces, :max_collections_per_workspace, :max_documents_per_collection,
                        :features, :is_active, :trial_days, :created_at, :updated_at)
            """),
            {**plan, 'created_at': now, 'updated_at': now}
        )


# noinspection PyUnresolvedReferences, PyAttributeAccess, PyTypeChecker
def create_admin_user(connection, pwd_context, _dialect_info):
    """Create default admin user with workspace and subscription."""
    # Check if admin exists
    check = connection.execute(
        text(f"SELECT COUNT(*) FROM {db_utils.get_table_name('users')} WHERE username = 'admin'")
    ).scalar()

    if check > 0:
        return

    admin_id = str(uuid_lib.uuid4())
    workspace_id = str(uuid_lib.uuid4())
    collection_id = str(uuid_lib.uuid4())
    now = datetime.now()

    # Create admin user
    hashed_password = pwd_context.hash(os.getenv("DEFAULT_ADMIN_PASSWORD", "admin123"))
    connection.execute(
        text(f"""
            INSERT INTO {db_utils.get_table_name('users')}
            (id, username, email, password, role, is_active, is_external,
             license_agreement_consent, content_sharing_consent, created_at, updated_at)
            VALUES (:id, :username, :email, :password, :role, :is_active, :is_external,
                    :license_agreement_consent, :content_sharing_consent, :created_at, :updated_at)
        """),
        {
            'id': admin_id,
            'username': 'admin',
            'email': 'admin@scrapalot.local',
            'password': hashed_password,
            'role': 'ADMIN',
            'is_active': True,
            'is_external': False,
            'license_agreement_consent': True,
            'content_sharing_consent': True,
            'created_at': now,
            'updated_at': now,
        }
    )

    # Create admin workspace
    connection.execute(
        text(f"""
            INSERT INTO {db_utils.get_table_name('workspaces')}
            (id, user_id, name, description, is_public, is_shared, created_at, updated_at)
            VALUES (:id, :user_id, :name, :description, :is_public, :is_shared, :created_at, :updated_at)
        """),
        {
            'id': workspace_id,
            'user_id': admin_id,
            'name': 'Admin Workspace',
            'description': 'Default workspace for administrator',
            'is_public': False,
            'is_shared': False,
            'created_at': now,
            'updated_at': now,
        }
    )

    # Create default collection
    connection.execute(
        text(f"""
            INSERT INTO {db_utils.get_table_name('collections')}
            (id, workspace_id, name, description, created_at, updated_at)
            VALUES (:id, :workspace_id, :name, :description, :created_at, :updated_at)
        """),
        {
            'id': collection_id,
            'workspace_id': workspace_id,
            'name': 'Default Collection',
            'description': 'Default collection for new documents',
            'created_at': now,
            'updated_at': now,
        }
    )

    # Assign professional subscription to admin
    researcher_plan = connection.execute(
        text(f"SELECT id FROM {db_utils.get_table_name('subscription_plans')} WHERE name = 'professional'")
    ).fetchone()

    if researcher_plan:
        connection.execute(
            text(f"""
                INSERT INTO {db_utils.get_table_name('user_subscriptions')}
                (id, user_id, subscription_plan_id, status, billing_cycle, subscribed_at, created_at, updated_at)
                VALUES (:id, :user_id, :subscription_plan_id, :status, :billing_cycle, :subscribed_at, :created_at, :updated_at)
            """),
            {
                'id': str(uuid_lib.uuid4()),
                'user_id': admin_id,
                'subscription_plan_id': researcher_plan[0],
                'status': 'active',
                'billing_cycle': 'monthly',
                'subscribed_at': now,
                'created_at': now,
                'updated_at': now,
            }
        )


# noinspection PyUnresolvedReferences, PyAttributeAccess, PyTypeChecker
def create_server_settings(connection):
    """Create default server settings."""
    # Check if settings exist
    check = connection.execute(
        text(f"SELECT COUNT(*) FROM {db_utils.get_table_name('server_settings')}")
    ).scalar()

    if check > 0:
        return

    now = datetime.now()
    settings = [
        {
            'id': str(uuid_lib.uuid4()),
            'setting_key': 'app_name',
            'setting_value': json.dumps('Scrapalot Chat'),
            'created_at': now,
            'updated_at': now,
        },
        {
            'id': str(uuid_lib.uuid4()),
            'setting_key': 'app_version',
            'setting_value': json.dumps('1.0.0'),
            'created_at': now,
            'updated_at': now,
        },
        {
            'id': str(uuid_lib.uuid4()),
            'setting_key': 'default_language',
            'setting_value': json.dumps('en'),
            'created_at': now,
            'updated_at': now,
        },
        {
            'id': str(uuid_lib.uuid4()),
            'setting_key': 'max_upload_size_mb',
            'setting_value': json.dumps(50),
            'created_at': now,
            'updated_at': now,
        },
        {
            'id': str(uuid_lib.uuid4()),
            'setting_key': 'system_models',
            'setting_value': json.dumps({
                "models": [{
                    "id": "sentence-transformers/all-MiniLM-L6-v2",
                    "name": "sentence-transformers/all-MiniLM-L6-v2",
                    "provider": "huggingface",
                    "parameters": None,
                    "metadata": {"description": "CPU Fallback Embedding Model"}
                }]
            }),
            'created_at': now,
            'updated_at': now,
        },
        {
            'id': str(uuid_lib.uuid4()),
            'setting_key': 'default_general_settings',
            'setting_value': json.dumps({
                "auto_title_generate": True,
                "rendering_engine": "new",
                "thinking_tokens": True,
                "rendering_modules": ["MARKDOWN", "GITHUB_MARKDOWN", "CODE_HIGHLIGHTING", "COLLAPSE_TAGS"],
                "links_in_chat": True,
                "proxy": "",
                "theme": "system",
                "theme_accent": "blue",
                "font_style": "sans",
                "theme_code": "github-dark",
                "font_size": "14",
                "rag_strategy": "RAGBalancedOrchestrator",
                "language": "en",
                "use_agentic_routing": True,
            }),
            'created_at': now,
            'updated_at': now,
        },
    ]

    for setting in settings:
        connection.execute(
            text(f"""
                INSERT INTO {db_utils.get_table_name('server_settings')}
                (id, setting_key, setting_value, created_at, updated_at)
                VALUES (:id, :setting_key, :setting_value, :created_at, :updated_at)
            """),
            setting
        )


# noinspection PyUnresolvedReferences, PyAttributeAccess, PyTypeChecker
def create_default_user_settings(connection):
    """Apply default settings to existing users (if any)."""
    # Get default settings template
    default_settings = {
        "auto_title_generate": True,
        "rendering_engine": "new",
        "thinking_tokens": True,
        "rendering_modules": ["MARKDOWN", "GITHUB_MARKDOWN", "CODE_HIGHLIGHTING", "COLLAPSE_TAGS"],
        "links_in_chat": True,
        "proxy": "",
        "theme": "system",
        "theme_accent": "blue",
        "font_style": "sans",
        "theme_code": "github-dark",
        "font_size": "14",
        "rag_strategy": "RAGBalancedOrchestrator",
        "language": "en",
        "use_agentic_routing": True,
    }

    # Get users without general settings
    users = connection.execute(
        text(f"""
            SELECT u.id
            FROM {db_utils.get_table_name('users')} u
            LEFT JOIN {db_utils.get_table_name('user_settings')} us
                ON u.id = us.user_id AND us.setting_key = 'settings_general'
            WHERE us.id IS NULL
        """)
    ).fetchall()

    now = datetime.now()
    for (user_id,) in users:
        connection.execute(
            text(f"""
                INSERT INTO {db_utils.get_table_name('user_settings')}
                (id, user_id, setting_key, setting_value, created_at, updated_at)
                VALUES (:id, :user_id, :setting_key, :setting_value, :created_at, :updated_at)
            """),
            {
                'id': str(uuid_lib.uuid4()),
                'user_id': user_id,
                'setting_key': 'settings_general',
                'setting_value': json.dumps(default_settings),
                'created_at': now,
                'updated_at': now,
            }
        )


# noinspection PyTypeChecker
# noinspection PyUnresolvedReferences, PyAttributeAccess, PyTypeChecker, SqlNoWhereClause
def downgrade() -> None:
    """Remove seed data."""
    connection = op.get_bind()

    # Remove admin user (cascade will handle workspace, collection, subscription)
    connection.execute(
        text(f"DELETE FROM {db_utils.get_table_name('users')} WHERE username = 'admin'")
    )

    # Remove subscription plans seeded by this migration
    connection.execute(
        text(f"DELETE FROM {db_utils.get_table_name('subscription_plans')} WHERE name IN ('researcher', 'professional', 'enterprise')")
    )

    # Remove server settings seeded by this migration
    connection.execute(
        text(f"DELETE FROM {db_utils.get_table_name('server_settings')} WHERE setting_key IN ('app_name', 'app_version', 'default_language', 'max_upload_size_mb', 'system_models', 'default_general_settings')")
    )
