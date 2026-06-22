"""settings_updates

Revision ID: 012
Revises: 011
Create Date: 2025-12-31 10:30:00

Squashed migrations:
- 015_clean_up_document_embedding_settings.py
- 018_add_ocr_enabled_to_document_processing.py
- 019_upgrade_document_embedding_settings_to_comprehensive_format.py
"""
import json
from typing import Union
from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = '012'
down_revision: str | None = '011'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# noinspection PyTypeChecker
def upgrade() -> None:
    conn = op.get_bind()

    # ### From 015_clean_up_document_embedding_settings.py ###
    # Clean up document_embedding_settings by removing chunking-related fields
    result = conn.execute(text("""
        SELECT id, setting_value
        FROM user_settings
        WHERE setting_key = 'document_embedding_settings'
        AND setting_value IS NOT NULL
    """))

    for row in result:
        setting_id = row[0]
        setting_value = row[1]

        # Parse JSON if it's a string
        if isinstance(setting_value, str):
            # noinspection PyBroadException
            try:
                setting_value = json.loads(setting_value)
            except:
                continue

        # Remove chunking fields if they exist
        if isinstance(setting_value, dict):
            fields_to_remove = [
                'chunk_size', 'chunk_overlap', 'chunking_strategy',
                'chunk_delimiter', 'separators'
            ]

            changed = False
            for field in fields_to_remove:
                if field in setting_value:
                    del setting_value[field]
                    changed = True

            if changed:
                conn.execute(text("""
                    UPDATE user_settings
                    SET setting_value = :new_value,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = :setting_id
                """), {
                    "new_value": json.dumps(setting_value),
                    "setting_id": setting_id
                })

    # ### From 018_add_ocr_enabled_to_document_processing.py ###
    # Add ocr_enabled to document_processing settings
    result = conn.execute(text("""
        SELECT id, setting_value
        FROM user_settings
        WHERE setting_key = 'document_processing'
        AND setting_value IS NOT NULL
    """))

    for row in result:
        setting_id = row[0]
        setting_value = row[1]

        # Parse JSON if it's a string
        if isinstance(setting_value, str):
            # noinspection PyBroadException
            try:
                setting_value = json.loads(setting_value)
            except:
                continue

        # Handle both flat and nested structures
        if isinstance(setting_value, dict):
            # Check if settings are nested under "value" key
            if 'value' in setting_value and isinstance(setting_value['value'], dict):
                # Nested structure: {"value": {...}}
                if 'ocr_enabled' not in setting_value['value']:
                    setting_value['value']['ocr_enabled'] = True
                    conn.execute(text("""
                        UPDATE user_settings
                        SET setting_value = :new_value,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = :setting_id
                    """), {
                        "new_value": json.dumps(setting_value),
                        "setting_id": setting_id
                    })
            elif 'ocr_enabled' not in setting_value:
                # Flat structure: {...}
                setting_value['ocr_enabled'] = True
                conn.execute(text("""
                    UPDATE user_settings
                    SET setting_value = :new_value,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = :setting_id
                """), {
                    "new_value": json.dumps(setting_value),
                    "setting_id": setting_id
                })

    # ### From 019_upgrade_document_embedding_settings_to_comprehensive_format.py ###
    # Upgrade document_embedding_settings to comprehensive format
    result = conn.execute(text("""
        SELECT id, setting_value
        FROM user_settings
        WHERE setting_key = 'document_embedding_settings'
        AND setting_value IS NOT NULL
    """))

    settings_to_upgrade = []
    for row in result:
        setting_id = row[0]
        setting_value = row[1]

        # Parse JSON if it's a string
        if isinstance(setting_value, str):
            # noinspection PyBroadException
            try:
                setting_value = json.loads(setting_value)
            except:
                continue

        # Check if this setting needs upgrading (missing 'dimensions' field)
        if isinstance(setting_value, dict) and 'dimensions' not in setting_value:
            embedding_model = setting_value.get('embedding_model')
            if embedding_model:
                settings_to_upgrade.append((setting_id, embedding_model))

    # Upgrade each setting by fetching comprehensive model info
    for setting_id, embedding_model in settings_to_upgrade:
        # Query model info from database
        model_info = conn.execute(text("""
            SELECT
                m.model_name,
                m.display_name,
                m.model_type,
                m.dimensions,
                m.context_window,
                m.max_tokens,
                p.provider_type,
                p.name as provider_name
            FROM model_provider_models m
            JOIN model_providers p ON m.provider_id = p.id
            WHERE m.model_name = :model_name
            AND m.model_type = 'EMBEDDING'
            AND p.status IN ('active', 'enabled')
            LIMIT 1
        """), {"model_name": embedding_model}).fetchone()

        if model_info:
            # Build comprehensive settings
            comprehensive_settings = {
                "embedding_model": embedding_model,
                "display_name": model_info[1] or embedding_model,
                "model_type": model_info[2] or "EMBEDDING",
                "dimensions": model_info[3],
                "context_window": model_info[4],
                "max_tokens": model_info[5],
                "provider_type": model_info[6] or "local",
                "provider_name": model_info[7] or "Unknown",
            }
        else:
            # Fallback if model not found in database
            comprehensive_settings = {
                "embedding_model": embedding_model,
                "display_name": embedding_model,
                "model_type": "EMBEDDING",
                "dimensions": None,
                "context_window": None,
                "max_tokens": None,
                "provider_type": "local",
                "provider_name": "Unknown",
            }

        # Update the setting
        conn.execute(text("""
            UPDATE user_settings
            SET setting_value = :new_value,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = :setting_id
        """), {
            "new_value": json.dumps(comprehensive_settings),
            "setting_id": setting_id
        })

    print(f"Migration 012 completed:")
    print(f"   - Cleaned up document_embedding_settings (removed chunking fields)")
    print(f"   - Added ocr_enabled to document_processing settings")
    print(f"   - Upgraded {len(settings_to_upgrade)} document_embedding_settings to comprehensive format")


# noinspection PyTypeChecker
def downgrade() -> None:
    conn = op.get_bind()

    # ### Reverse 019_upgrade_document_embedding_settings_to_comprehensive_format.py ###
    # Downgrade comprehensive format back to simple format
    result = conn.execute(text("""
        SELECT id, setting_value
        FROM user_settings
        WHERE setting_key = 'document_embedding_settings'
        AND setting_value IS NOT NULL
    """))

    downgraded_count = 0
    for row in result:
        setting_id = row[0]
        setting_value = row[1]

        # Parse JSON if it's a string
        if isinstance(setting_value, str):
            # noinspection PyBroadException
            try:
                setting_value = json.loads(setting_value)
            except:
                continue

        # Check if this is a comprehensive setting
        if isinstance(setting_value, dict) and 'dimensions' in setting_value:
            # Simplify to just embedding_model
            simple_settings = {
                "embedding_model": setting_value.get("embedding_model", "")
            }

            conn.execute(text("""
                UPDATE user_settings
                SET setting_value = :new_value,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = :setting_id
            """), {
                "new_value": json.dumps(simple_settings),
                "setting_id": setting_id
            })
            downgraded_count += 1

    # ### Reverse 018_add_ocr_enabled_to_document_processing.py ###
    # Remove ocr_enabled from document_processing settings
    result = conn.execute(text("""
        SELECT id, setting_value
        FROM user_settings
        WHERE setting_key = 'document_processing'
        AND setting_value IS NOT NULL
    """))

    for row in result:
        setting_id = row[0]
        setting_value = row[1]

        # Parse JSON if it's a string
        if isinstance(setting_value, str):
            # noinspection PyBroadException
            try:
                setting_value = json.loads(setting_value)
            except:
                continue

        # Remove ocr_enabled if present
        if isinstance(setting_value, dict) and 'ocr_enabled' in setting_value:
            del setting_value['ocr_enabled']

            conn.execute(text("""
                UPDATE user_settings
                SET setting_value = :new_value,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = :setting_id
            """), {
                "new_value": json.dumps(setting_value),
                "setting_id": setting_id
            })

    # ### Note: No downgrade needed for 015 - we don't restore removed chunking fields ###

    print(f"Migration 012 downgrade completed:")
    print(f"   - Downgraded {downgraded_count} document_embedding_settings to simple format")
    print(f"   - Removed ocr_enabled from document_processing settings")
