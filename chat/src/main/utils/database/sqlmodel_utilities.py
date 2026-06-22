"""
SQLModel-based utility functions.

This module provides utility functions that use SQLModel repositories
instead of manual SQL queries, demonstrating the migration from the old
DAO pattern to the new type-safe SQLModel approach.
"""

from typing import Any

from sqlmodel import Session, select

from src.main.config.database import get_sqlmodel_db_session
from src.main.models.sqlmodel_providers import ModelProviderModel
from src.main.repository.sqlmodel_repositories import ModelProviderModelRepository, ModelProviderRepository
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class SQLModelLLMUtils:
    """LLM utilities using SQLModel repositories"""

    def __init__(self, session: Session | None = None):
        """Initialize with optional session"""
        if session:
            self.session = session
            self._external_session = True
        else:
            self.session = get_sqlmodel_db_session()
            self._external_session = False

        self.model_repo = ModelProviderModelRepository(self.session)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if not self._external_session and self.session:
            self.session.close()

    def map_display_name_to_model_name(self, display_name: str) -> str:
        """
        Map display_name to model_name using SQLModel repository.

        This replaces the manual SQL query in llm_model_utils.py with a
        type-safe SQLModel operation.
        """
        try:
            # Clean the display name (reusing logic from original function)
            cleaned_name = display_name.strip().lower()

            # Use SQLModel repository to find the model
            statement = select(ModelProviderModel).where(ModelProviderModel.display_name == cleaned_name).limit(1)

            result = self.session.exec(statement).first()

            if result:
                logger.info("Mapped display name '%s' to model name '%s' via SQLModel", cleaned_name, result.model_name)
                return result.model_name

            # If no mapping found, return the original name
            logger.debug("No mapping found for display name '%s', returning as-is", cleaned_name)
            return cleaned_name

        except Exception as e:
            logger.error("Error mapping model name via SQLModel: %s", str(e))
            return display_name

    def get_available_models(self, provider_name: str | None = None) -> list[dict[str, Any]]:
        """
        Get available models, optionally filtered by provider.

        Returns a list of model dictionaries with provider information.
        """
        try:
            if provider_name:
                # Find provider first, then get models
                provider_repo = ModelProviderRepository(self.session)
                # noinspection PyUnresolvedReferences
                statement = (
                    select(ModelProviderModel)
                    .join(provider_repo.model_class)
                    .where(provider_repo.model_class.name == provider_name, ModelProviderModel.is_available is True)
                )
            else:
                # Get all available models
                # noinspection PyUnresolvedReferences
                statement = select(ModelProviderModel).where(ModelProviderModel.is_available is True)

            models = self.session.exec(statement).all()

            # Convert to dictionaries for compatibility
            model_dicts = []
            for model in models:
                model_dicts.append(
                    {
                        "id": str(model.id),
                        "model_name": model.model_name,
                        "display_name": model.display_name,
                        "provider_id": str(model.provider_id),
                        "model_type": model.model_type,
                        "context_length": model.context_length,
                        "is_available": model.is_available,
                        "cost_per_input_token": (float(model.cost_per_input_token) if model.cost_per_input_token else None),
                        "cost_per_output_token": (float(model.cost_per_output_token) if model.cost_per_output_token else None),
                        "created_at": model.created_at,
                        "updated_at": model.updated_at,
                    }
                )

            logger.info(
                "Retrieved %d available models via SQLModel%s",
                len(model_dicts),
                f" for provider {provider_name}" if provider_name else "",
            )
            return model_dicts

        except Exception as e:
            logger.error("Error getting available models via SQLModel: %s", str(e))
            return []

    def get_model_by_name(self, model_name: str) -> dict[str, Any] | None:
        """Get a specific model by name"""
        try:
            statement = select(ModelProviderModel).where(ModelProviderModel.model_name == model_name).limit(1)

            model = self.session.exec(statement).first()

            if model:
                return {
                    "id": str(model.id),
                    "model_name": model.model_name,
                    "display_name": model.display_name,
                    "provider_id": str(model.provider_id),
                    "model_type": model.model_type,
                    "context_length": model.context_length,
                    "is_available": model.is_available,
                    "cost_per_input_token": float(model.cost_per_input_token) if model.cost_per_input_token else None,
                    "cost_per_output_token": (float(model.cost_per_output_token) if model.cost_per_output_token else None),
                    "created_at": model.created_at,
                    "updated_at": model.updated_at,
                }

            return None

        except Exception as e:
            logger.error("Error getting model by name via SQLModel: %s", str(e))
            return None


def get_sqlmodel_llm_utils(session: Session | None = None) -> SQLModelLLMUtils:
    """Factory function to get SQLModel LLM utilities"""
    return SQLModelLLMUtils(session)


# =============================================================================
# MIGRATION EXAMPLE FUNCTIONS
# =============================================================================


def compare_query_approaches(display_name: str) -> dict[str, Any]:
    """
    Compare old SQL approach vs new SQLModel approach for model name mapping.

    This function demonstrates the difference between manual SQL and SQLModel
    for the same operation.
    """
    import time

    from sqlalchemy import text

    from src.main.config.database import SessionLocal

    results = {"input": display_name, "old_approach": {}, "new_approach": {}, "comparison": {}}

    # OLD APPROACH - Manual SQL
    try:
        start_time = time.time()
        with SessionLocal() as db_session:
            query = """
                SELECT model_name
                FROM model_provider_models
                WHERE display_name = :display_name
                LIMIT 1
            """
            result = db_session.execute(text(query), {"display_name": display_name.strip().lower()}).first()
            old_result = result[0] if result else display_name

        old_duration = time.time() - start_time
        results["old_approach"] = {
            "result": old_result,
            "duration_seconds": old_duration,
            "method": "Manual SQL with text() and SessionLocal",
            "type_safety": "None",
            "error_handling": "Basic try/catch",
        }
    except Exception as e:
        results["old_approach"] = {"error": str(e), "method": "Manual SQL", "type_safety": "None"}

    # NEW APPROACH - SQLModel
    try:
        start_time = time.time()
        with get_sqlmodel_llm_utils() as llm_utils:
            new_result = llm_utils.map_display_name_to_model_name(display_name)

        new_duration = time.time() - start_time
        results["new_approach"] = {
            "result": new_result,
            "duration_seconds": new_duration,
            "method": "SQLModel repository with type-safe operations",
            "type_safety": "Full type checking with mypy support",
            "error_handling": "Structured exception handling with logging",
        }
    except Exception as e:
        results["new_approach"] = {"error": str(e), "method": "SQLModel repository", "type_safety": "Full"}

    # COMPARISON
    try:
        # noinspection PyUnresolvedReferences
        old_result = results["old_approach"].get("result")
        # noinspection PyUnresolvedReferences
        new_result = results["new_approach"].get("result")
        # noinspection PyUnresolvedReferences
        old_duration = results["old_approach"].get("duration_seconds", 0)
        # noinspection PyUnresolvedReferences
        new_duration = results["new_approach"].get("duration_seconds", 0)

        results["comparison"] = {
            "results_match": old_result == new_result,
            "performance_improvement": (f"{((old_duration - new_duration) / old_duration * 100):.1f}%" if old_duration > 0 else "N/A"),
            "benefits": [
                "Type safety with full IDE support",
                "Automatic input validation",
                "No SQL injection risk",
                "Easy to test and mock",
                "Better error messages",
                "Consistent logging patterns",
            ],
            "migration_effort": "Low - mostly replacing queries with repository calls",
        }
    except Exception as e:
        results["comparison"] = {"error": str(e)}

    return results
