"""
Utility functions for working with model providers and models.
This module provides helper functions to interact with the model_providers
and model_provider_models tables.
"""

from datetime import UTC, datetime
from typing import Any
import uuid

from sqlalchemy import text
from sqlalchemy.orm import Session

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def get_specific_provider_and_model(db: Session, user_id: str, provider_type: str, model_id: str) -> dict[str, Any] | None:
    """
    Get a specific provider and validate that it has the requested model.
    This is more efficient than fetching all active providers.

    Args:
        db: Database session
        user_id: User ID
        provider_type: Provider type (e.g., 'openai', 'anthropic', 'local', 'system')
        model_id: Specific model ID to validate

    Returns:
        Dictionary with provider data if found and model exists, None otherwise
    """
    try:
        # Special handling for "system" provider_type
        # Match on BOTH user_id IS NULL AND provider_type = 'system'
        # This ensures we get the correct system provider, not just any global provider
        if provider_type.lower() == "system":
            provider_result = db.execute(
                text("""
                SELECT DISTINCT p.id, p.name, p.provider_type, p.description, p.show_models, p.status, p.user_id, p.created_at, p.updated_at, p.api_key
                FROM model_providers p
                WHERE p.user_id IS NULL
                    AND p.provider_type = :provider_type
                    AND p.status = 'active'
                LIMIT 1
            """),
                {"provider_type": "system"},
            )
        # Query for the specific provider type that is active
        # For local providers (local, ollama, vllm, lmstudio), allow access for all users
        # For remote providers, restrict by user_id
        elif provider_type.lower() in ["local", "ollama", "vllm", "lmstudio"]:
            provider_result = db.execute(
                text("""
                SELECT DISTINCT p.id, p.name, p.provider_type, p.description, p.show_models, p.status, p.user_id, p.created_at, p.updated_at, p.api_key
                FROM model_providers p
                WHERE p.provider_type = :provider_type
                    AND p.status = 'active'
                LIMIT 1
            """),
                {"provider_type": provider_type},
            )
        else:
            provider_result = db.execute(
                text("""
                SELECT DISTINCT p.id, p.name, p.provider_type, p.description, p.show_models, p.status, p.user_id, p.created_at, p.updated_at, p.api_key
                FROM model_providers p
                WHERE p.provider_type = :provider_type
                    AND p.status = 'active'
                    AND p.user_id = :user_id
                LIMIT 1
            """),
                {"user_id": user_id, "provider_type": provider_type},
            )

        provider_row = provider_result.fetchone()
        if not provider_row:
            logger.error("No active provider found for user %s with type %s", user_id, provider_type)
            return None

        provider_data = _convert_provider_row_to_dict(provider_row)

        # Validate that the provider has the requested model
        # Accept both UUID and model name for flexibility
        # noinspection PyUnusedLocal
        model_result = None
        model_uuid: uuid.UUID | None = None

        # First try as UUID
        try:
            model_uuid = uuid.UUID(model_id)
            model_result = db.execute(
                text("""
                SELECT id, model_name, display_name, model_type
                FROM model_provider_models
                WHERE provider_id = :provider_id AND id = :model_id
                LIMIT 1
            """),
                {"provider_id": provider_data["id"], "model_id": str(model_uuid)},
            )
        except ValueError:
            # If not a UUID, try as model name
            logger.debug("model_id %s is not a UUID, trying as model name", model_id)
            model_result = db.execute(
                text("""
                SELECT id, model_name, display_name, model_type
                FROM model_provider_models
                WHERE provider_id = :provider_id AND model_name = :model_name
                LIMIT 1
            """),
                {"provider_id": provider_data["id"], "model_name": model_id},
            )

        model_row = model_result.fetchone()
        if not model_row:
            logger.warning("Model %s not found in requested provider %s", model_id, provider_data["id"])

            # Fallback: Try to find the model in ANY provider the user has access to
            # This handles cases where frontend sends wrong provider_type with correct model UUID
            try:
                model_uuid = uuid.UUID(model_id)
                fallback_result = db.execute(
                    text("""
                    SELECT m.id, m.model_name, m.display_name, m.model_type,
                           p.id as provider_id, p.name, p.provider_type, p.description,
                           p.show_models, p.status, p.user_id, p.created_at, p.updated_at
                    FROM model_provider_models m
                    JOIN model_providers p ON m.provider_id = p.id
                    WHERE m.id = :model_id
                        AND p.status = 'active'
                        AND (p.user_id = :user_id OR p.user_id IS NULL)
                    LIMIT 1
                    """),
                    {"model_id": str(model_uuid), "user_id": user_id},
                )
                fallback_row = fallback_result.fetchone()

                if fallback_row:
                    # Found the model in a different provider
                    logger.info(
                        "Found model %s in different provider: %s (type: %s) instead of requested %s",
                        model_id,
                        fallback_row[5],
                        fallback_row[6],
                        provider_type,
                    )

                    # Return the actual provider that has this model
                    provider_data = {
                        "id": fallback_row[4],
                        "name": fallback_row[5],
                        "provider_type": fallback_row[6],
                        "description": fallback_row[7],
                        "show_models": fallback_row[8],
                        "status": fallback_row[9],
                        "user_id": fallback_row[10],
                        "created_at": fallback_row[11],
                        "updated_at": fallback_row[12],
                        "selected_model": {
                            "id": fallback_row[0],
                            "model_name": fallback_row[1],
                            "display_name": fallback_row[2],
                            "model_type": fallback_row[3],
                        },
                    }

                    return provider_data
            except (ValueError, Exception) as fallback_error:
                logger.debug("Fallback lookup failed: %s", str(fallback_error))

            # No fallback found - log available providers for debugging
            logger.error("Model %s not found in any accessible provider for user %s", model_id, user_id)

            # Check if the model exists anywhere in the database (even inactive providers)
            try:
                model_exists_check = db.execute(
                    text("""
                    SELECT m.id, m.model_name, p.name as provider_name, p.status, p.user_id
                    FROM model_provider_models m
                    JOIN model_providers p ON m.provider_id = p.id
                    WHERE m.id = :model_id
                    """),
                    {"model_id": str(model_uuid) if model_uuid is not None else model_id},
                ).fetchone()

                if model_exists_check:
                    logger.warning(
                        "Model %s exists in provider '%s' (status: %s, user_id: %s) but is not accessible to user %s",
                        model_id,
                        model_exists_check[2],
                        model_exists_check[3],
                        model_exists_check[4],
                        user_id,
                    )
                else:
                    logger.warning("Model %s does not exist in database at all - frontend may have stale/invalid UUID", model_id)
            except Exception as exists_check_error:
                logger.debug("Could not check if model exists elsewhere: %s", str(exists_check_error))

            # Log which providers the user has access to for debugging
            try:
                available_providers = db.execute(
                    text("""
                    SELECT p.id, p.name, p.provider_type, p.user_id, COUNT(m.id) as model_count
                    FROM model_providers p
                    LEFT JOIN model_provider_models m ON p.id = m.provider_id
                    WHERE p.status = 'active'
                        AND (p.user_id = :user_id OR p.user_id IS NULL)
                    GROUP BY p.id, p.name, p.provider_type, p.user_id
                    """),
                    {"user_id": user_id},
                ).fetchall()

                logger.info(
                    "User %s has access to %d provider(s): %s",
                    user_id,
                    len(available_providers),
                    ", ".join([f"{p[1]} ({p[2]}, {p[4]} models)" for p in available_providers]),
                )

                # Specifically check system provider
                system_providers = [p for p in available_providers if p[3] is None]
                if system_providers:
                    for sp in system_providers:
                        logger.info("System provider found: %s (ID: %s, type: %s, models: %d)", sp[1], sp[0], sp[2], sp[4])
                        if sp[4] == 0:
                            logger.warning("⚠️ System provider '%s' has NO MODELS! Please sync models via UI or API.", sp[1])
                else:
                    logger.warning("⚠️ No system provider found (user_id IS NULL)! System should have at least one.")
            except Exception as debug_error:
                logger.debug("Could not fetch available providers for debugging: %s", str(debug_error))

            return None

        # Add model information to provider data
        provider_data["selected_model"] = {
            "id": model_row[0],
            "model_name": model_row[1],
            "display_name": model_row[2],
            "model_type": model_row[3],
        }

        logger.info("Found provider %s (%s) with model %s for user %s", provider_data["name"], provider_type, model_id, user_id)
        return provider_data

    except Exception as e:
        logger.error("Error getting specific provider and model: %s", str(e))
        return None


def get_system_provider(db: Session) -> tuple[dict[str, Any], bool]:
    """
    Get the system-wide model provider for local models.
    If it doesn't exist, create it.

    Args:
        db: Database session

    Returns:
        Tuple containing:
        - Dictionary with provider data
        - Boolean indicating if it was newly created
    """
    # Use a direct SQL query to avoid ORM circular import issues
    from sqlalchemy import text

    # Check if a system provider already exists
    result = db.execute(
        text(
            "SELECT id, name, provider_type, description, show_models, status, user_id, created_at, updated_at FROM model_providers "
            "WHERE user_id IS NULL AND provider_type = 'local' LIMIT 1"
        )
    )
    system_provider_row = result.fetchone()

    if system_provider_row:
        # Convert row to dictionary
        provider_data = _convert_provider_row_to_dict(system_provider_row)
        logger.info("Found existing system provider: %s", provider_data["id"])

        return provider_data, False

    # Create a new system provider
    provider_id = str(uuid.uuid4())
    created_at = datetime.now(UTC)
    updated_at = datetime.now(UTC)

    db.execute(
        text(
            "INSERT INTO model_providers ("
            "id, user_id, name, provider_type, description, show_models, status, validation_status, created_at, updated_at) "
            "VALUES (:id, NULL, :name, :provider_type, :description, :show_models, :status, :validation_status, :created_at, :updated_at)"
        ),
        {
            "id": provider_id,
            "name": "Local AI",
            "provider_type": "local",
            "description": "Local AI models running on this server",
            "show_models": True,
            "status": "active",
            "validation_status": "valid",
            "created_at": created_at,
            "updated_at": updated_at,
        },
    )

    db.commit()

    provider_data = {
        "id": provider_id,
        "name": "Local AI",
        "provider_type": "local",
        "description": "Local AI models running on this server",
        "show_models": True,
        "status": "active",
        "user_id": None,
        "created_at": created_at,
        "updated_at": updated_at,
    }

    logger.info("Created new system provider: %s", provider_id)
    return provider_data, True


def ensure_system_ai_provider(db: Session) -> tuple[dict[str, Any], bool]:
    """
    Get the system AI provider from the database.
    The system provider should be created via database migrations or manual insertion.

    Args:
        db: Database session

    Returns:
        Tuple containing:
        - Dictionary with provider data
        - Boolean indicating if it was newly created (always False now)

    Raises:
        RuntimeError: If system provider is not found in database
    """
    # Get the system provider from database (user_id IS NULL)
    result = db.execute(
        text(
            "SELECT id, name, provider_type, description, show_models, status, user_id, created_at, updated_at FROM model_providers "
            "WHERE user_id IS NULL LIMIT 1"
        )
    )
    system_provider_row = result.fetchone()

    if not system_provider_row:
        error_msg = (
            "System AI provider not found in database. "
            "Please ensure the system provider is created via database migration or manual insertion. "
            "Expected: A provider record with user_id=NULL in model_providers table."
        )
        logger.error(error_msg)
        raise RuntimeError(error_msg)

    provider_data = _convert_provider_row_to_dict(system_provider_row)
    logger.info("Found system AI provider: %s (type: %s)", provider_data["id"], provider_data.get("provider_type"))

    return provider_data, False


def get_user_active_providers(db: Session, user_id: str) -> list[dict[str, Any]]:
    """
    Get all active providers for a user, including both user-specific and system-wide providers.

    Args:
        db: Session: Database session
        user_id: str: User ID

    Returns:
        List of dictionaries with provider data
    """
    from sqlmodel import or_, select

    from src.main.models.sqlmodel_providers import ModelProvider

    try:
        # Now we can use proper ORM queries since ModelProvider has provider_type and status columns
        # noinspection PyUnresolvedReferences
        providers = (
            db.execute(
                select(ModelProvider).where(
                    or_(ModelProvider.user_id == user_id, ModelProvider.user_id.is_(None)),
                    ModelProvider.status == "active",
                )
            )
            .scalars()
            .all()
        )

        # Convert to a list of dictionaries with all required fields
        provider_list = [
            {
                "id": str(provider.id),
                "name": provider.name,
                "provider_type": provider.provider_type,
                "description": provider.description,
                "show_models": provider.show_models,
                "api_key": provider.api_key,
                "status": provider.status,
                "user_id": str(provider.user_id) if provider.user_id is not None else None,
                "created_at": provider.created_at,
                "updated_at": provider.updated_at,
                "validation_status": provider.validation_status,
                "validation_error": provider.validation_error,
                "last_validation_at": provider.last_validation_at,
                "last_successful_validation_at": provider.last_successful_validation_at,
            }
            for provider in providers
        ]

        logger.info("Found %s active providers for user %s", len(provider_list), user_id)
        return provider_list

    except Exception as e:
        logger.exception("Error getting active providers for user %s: %s", user_id, str(e))
        return []


def get_user_providers_with_api_keys(db: Session, user_id: str) -> list[dict[str, Any]]:
    """
    Get all providers for a user that have API keys, regardless of status.
    This allows users to use any provider they have configured with an API key.

    Args:
        db: Session: Database session
        user_id: str: User ID

    Returns:
        List of dictionaries with provider data
    """
    from sqlalchemy import and_, or_

    from src.main.models.sqlmodel_providers import ModelProvider

    try:
        # Get all providers for this user AND system-wide providers (user_id is NULL)
        # that have API keys, regardless of status
        # noinspection PyTypeChecker,PyUnresolvedReferences
        providers = (
            db.query(ModelProvider)
            .filter(
                or_(ModelProvider.user_id == user_id, ModelProvider.user_id.is_(None)),
                and_(ModelProvider.api_key.isnot(None), ModelProvider.api_key != ""),
            )
            .all()
        )

        # Convert to a list of dictionaries with all required fields
        provider_list = [
            {
                "id": str(provider.id),
                "name": provider.name,
                "provider_type": provider.provider_type,
                "description": provider.description,
                "show_models": provider.show_models,
                "api_key": provider.api_key,
                "status": provider.status,
                "user_id": str(provider.user_id) if provider.user_id is not None else None,
                "created_at": provider.created_at,
                "updated_at": provider.updated_at,
                "validation_status": provider.validation_status,
                "validation_error": provider.validation_error,
                "last_validation_at": provider.last_validation_at,
                "last_successful_validation_at": provider.last_successful_validation_at,
            }
            for provider in providers
        ]

        logger.info("Found %s providers with API keys for user %s", len(provider_list), user_id)
        return provider_list

    except Exception as e:
        logger.error("Error getting providers with API keys for user %s: %s", user_id, str(e))
        return []


def _convert_provider_row_to_dict(provider_row) -> dict[str, Any]:
    """
    Convert a database row result to a provider dictionary.

    Args:
        provider_row: Database row with provider fields in expected order

    Returns:
        Dictionary with provider data
    """
    if not provider_row:
        return {}

    result = {
        "id": provider_row[0],
        "name": provider_row[1],
        "provider_type": provider_row[2],
        "description": provider_row[3],
        "show_models": provider_row[4],
        "status": provider_row[5],
        "user_id": provider_row[6],
        "created_at": provider_row[7],
        "updated_at": provider_row[8],
    }

    # Include api_key if present in row (index 9)
    if len(provider_row) > 9:
        result["api_key"] = provider_row[9]

    return result


def migrate_server_settings_to_model_providers(db: Session) -> dict[str, Any]:
    """
    Migrate data from server_settings to model_providers and model_provider_models.
    This is a one - time migration function to help transition from the old system to the new one.

    Args:
        db: Database session

    Returns:
        Dictionary with migration results
    """
    from sqlalchemy import text

    results = {"system_provider_created": False, "models_migrated": 0, "active_model_found": False}

    try:
        # Get the system provider (create if needed)
        system_provider, created = get_system_provider(db)
        results["system_provider_created"] = created

        # Get the old system_models setting
        system_models_result = db.execute(text("SELECT setting_value FROM server_settings WHERE setting_key = 'system_models'"))
        system_models_row = system_models_result.fetchone()

        # Get the old local_model_settings
        local_model_settings_result = db.execute(text("SELECT setting_value FROM server_settings WHERE setting_key = 'local_model_settings'"))
        local_model_settings_row = local_model_settings_result.fetchone()

        if local_model_settings_row and local_model_settings_row[0]:
            active_model = local_model_settings_row[0].get("active_model")
            if active_model:
                results["active_model_found"] = True
                results["active_model"] = active_model
                logger.info("Found active model from server settings: %s", active_model)

        # Migrate models from system_models to model_provider_models
        if system_models_row and system_models_row[0]:
            models_list = system_models_row[0].get("models", [])

            # Delete any existing models for the system provider
            db.execute(
                text("DELETE FROM model_provider_models WHERE provider_id = :provider_id"),
                {"provider_id": system_provider["id"]},
            )

            # Add each model to the system provider
            for model in models_list:
                model_name = model.get("id")
                display_name = model.get("name", model_name)

                # Determine a model type
                model_type = "NORMAL"
                if model.get("is_embedding", False):
                    model_type = "EMBEDDING"

                # Check if the model already exists
                existing_model = db.execute(
                    text("SELECT id FROM model_provider_models WHERE provider_id = :provider_id AND model_name = :model_name"),
                    {"provider_id": system_provider["id"], "model_name": model_name},
                ).fetchone()

                if existing_model:
                    logger.info("Model %s already exists for provider %s, skipping", model_name, system_provider["id"])
                    continue

                # Insert the new model with database-agnostic UUID generation
                import uuid as uuid_lib

                # noinspection PyUnresolvedReferences
                from src.main.utils import db_utils

                if db_utils.is_postgresql():
                    # Use PostgreSQL/Supabase gen_random_uuid() function
                    db.execute(
                        text(
                            "INSERT INTO model_provider_models "
                            "(id, provider_id, model_name, display_name, model_type, created_at) "
                            "VALUES (gen_random_uuid(), :provider_id, :model_name, :display_name, :model_type, :created_at)"
                        ),
                        {
                            "provider_id": system_provider["id"],
                            "model_name": model_name,
                            "display_name": display_name,
                            "model_type": model_type,
                            "created_at": datetime.now(UTC),
                        },
                    )
                else:
                    # Use Python UUID for SQLite and other databases
                    db.execute(
                        text(
                            "INSERT INTO model_provider_models "
                            "(id, provider_id, model_name, display_name, model_type, created_at) "
                            "VALUES (:id, :provider_id, :model_name, :display_name, :model_type, :created_at)"
                        ),
                        {
                            "id": str(uuid_lib.uuid4()),
                            "provider_id": system_provider["id"],
                            "model_name": model_name,
                            "display_name": display_name,
                            "model_type": model_type,
                            "created_at": datetime.now(UTC),
                        },
                    )

                results["models_migrated"] += 1

            db.commit()
            logger.info("Migrated %s models to the system provider", results["models_migrated"])

        return results
    except Exception as e:
        logger.error("Error migrating server settings to model providers: %s", str(e))
        db.rollback()
        raise
