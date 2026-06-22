"""
LLM Inference Service

This service handles the business logic for LLM model management, inference, and operations.
It provides methods for listing models, managing downloads, system capabilities, and model operations.
"""

import asyncio
from datetime import UTC, datetime
import functools
import hashlib
import os
import time
from typing import Any
import uuid

import aiofiles
import aiohttp
import httpx
from sqlalchemy import and_, text
from sqlalchemy.orm import Session

from src.main.config.database import DB_TYPE, SessionLocal
from src.main.dto.settings import GroupedProviderDTO, ProviderModelDTO
from src.main.models.sqlmodel_providers import ModelProvider, ModelProviderModel
from src.main.models.sqlmodel_settings import ServerSetting
from src.main.service.llm.llm_manager import LLMManager

# Import constants and utility functions from the new local_models directory
from src.main.service.local_models.local_llm_utils import (
    VALID_MODEL_EXTENSIONS,
    ensure_models_directory_exists,
    find_gguf_files,
)
from src.main.service.remote_model_sync import RemoteModelSyncService
from src.main.utils.config.loader import resolved_config, resolved_secrets
from src.main.utils.core.logger import get_logger
from src.main.utils.database.db_utils import get_or_create_server_setting
from src.main.utils.llm.model_name_utils import normalize_model_display_name
from src.main.utils.llm.model_utils import (
    clean_tags,
    determine_provider,
    extract_parameter_size,
    find_model_in_directory,
    get_gguf_models_directory,
    get_model_icon,
    normalize_model_name,
)

logger = get_logger(__name__)

# Initialize models directory
MODELS_DIRECTORY = ensure_models_directory_exists()
logger.info("Using models directory: %s", MODELS_DIRECTORY)

# Create a global LLM manager instance
llm_manager = LLMManager()

# Create a dictionary to track download progress
download_progress = {}


# noinspection SqlResolve


class LLMInferenceService:
    """Service class for handling LLM inference operations"""

    def __init__(self):
        self.models_directory = MODELS_DIRECTORY
        self.llm_manager = llm_manager
        self.remote_sync_service = RemoteModelSyncService()
        # Cache for filesystem scan results to avoid repeated scanning
        self._filesystem_cache = {}
        self._cache_timestamp = 0
        self._cache_ttl = 300  # 5-minute cache TTL

    @staticmethod
    def _get_model_uuid_from_db(model_name: str) -> str:
        """Get the existing UUID for a local model from the model_provider_models table."""
        with SessionLocal() as db:
            try:
                # Query for existing model UUID by model_name
                result = db.execute(
                    text("""
                        SELECT mpm.id
                        FROM model_provider_models mpm
                        JOIN model_providers mp ON mpm.provider_id = mp.id
                        WHERE mp.provider_type = 'local' AND mpm.model_name = :model_name
                        LIMIT 1
                    """),
                    {"model_name": model_name},
                ).fetchone()

                if result:
                    return str(result[0])
                else:
                    # If not found in a database, generate a stable UUID as fallback
                    unique_string = f"local_model:{model_name}"
                    hash_digest = hashlib.sha256(unique_string.encode()).hexdigest()
                    uuid_str = f"{hash_digest[:8]}-{hash_digest[8:12]}-{hash_digest[12:16]}-{hash_digest[16:20]}-{hash_digest[20:32]}"
                    return uuid_str
            except Exception as e:
                logger.warning("Error querying model UUID for %s: %s", model_name, e)
                # Fallback to stable UUID generation
                unique_string = f"local_model:{model_name}"
                hash_digest = hashlib.sha256(unique_string.encode()).hexdigest()
                uuid_str = f"{hash_digest[:8]}-{hash_digest[8:12]}-{hash_digest[12:16]}-{hash_digest[16:20]}-{hash_digest[20:32]}"
                return uuid_str

    @staticmethod
    async def list_database_models(provider_id: str, page: int = 1, limit: int = 50, _user_id: str = None) -> dict[str, Any]:
        """
        List models from a database for a specific provider with pagination support.
        Returns models with their selection status and types.
        """
        try:
            with SessionLocal() as db:
                # Calculate offset for pagination
                offset = (page - 1) * limit

                # Query to get models for the provider with pagination
                query = text("""
                    SELECT mpm.model_name, mpm.model_type
                    FROM model_provider_models mpm
                    JOIN model_providers mp ON mpm.provider_id = mp.id
                    WHERE mp.id = :provider_id
                    ORDER BY mpm.model_name
                    LIMIT :limit OFFSET :offset
                """)

                result = db.execute(
                    query,
                    {"provider_id": provider_id, "limit": limit, "offset": offset},
                )

                models = []
                for row in result:
                    models.append(
                        {
                            "model_name": row.model_name,
                            "selected": True,  # True because the model exists in the database for this provider
                            "model_type": row.model_type,
                        }
                    )

                # Get total count for pagination
                count_query = text("""
                    SELECT COUNT(*) as total
                    FROM model_provider_models mpm
                    JOIN model_providers mp ON mpm.provider_id = mp.id
                    WHERE mp.id = :provider_id
                """)

                count_result = db.execute(count_query, {"provider_id": provider_id})
                total = count_result.fetchone().total

                has_more = (offset + limit) < total

                return {
                    "models": models,
                    "total": total,
                    "page": page,
                    "limit": limit,
                    "has_more": has_more,
                }

        except Exception as e:
            logger.error("Error listing database models for provider %s: %s", provider_id, str(e))
            raise e from e

    # Timed LRU cache decorator
    @staticmethod
    def timed_lru_cache(seconds: int):
        """Create a time-based LRU cache decorator."""

        def wrapper_cache(func):
            @functools.wraps(func)
            async def wrapped_func(*args, **kwargs):
                cache_key = str(args) + str(kwargs)
                cache_dict = wrapped_func.cache_dict

                if cache_key in cache_dict and time.time() - cache_dict[cache_key][1] < seconds:
                    return cache_dict[cache_key][0]

                result = await func(*args, **kwargs)
                cache_dict[cache_key] = (result, time.time())
                return result

            wrapped_func.cache_dict = {}
            return wrapped_func

        return wrapper_cache

    async def initialize_local_models(self, db: Session, user_id=None, force_reinit=False) -> None:
        """Initialize local models in the database from a filesystem scan.

        Args:
            db: Database session
            user_id: Optional user ID filter
            force_reinit: If True, clears existing models and reinitializes
        """
        try:
            # Check if local models are already initialized
            # noinspection PyTypeChecker
            provider_query = db.query(ModelProvider).filter(and_(ModelProvider.provider_type == "local"))

            # Filter by user ID if provided
            if user_id:
                # noinspection PyTypeChecker,PyUnresolvedReferences
                provider_query = provider_query.filter((ModelProvider.user_id == user_id) | (ModelProvider.user_id.is_(None)))
            else:
                # noinspection PyUnresolvedReferences
                provider_query = provider_query.filter(ModelProvider.user_id.is_(None))

            # Check if the provider exists with models
            existing_provider = provider_query.first()
            if existing_provider and len(existing_provider.models) > 0 and not force_reinit:
                logger.info(
                    "Local models already initialized with %s models",
                    len(existing_provider.models),
                )
                return
            elif existing_provider and force_reinit:
                logger.info(
                    "Force reinitializing local models - clearing existing %s models",
                    len(existing_provider.models),
                )
                # Clear existing models
                for model in existing_provider.models:
                    db.delete(model)
                db.commit()

            # Scan filesystem for available models instead of relying on config.yaml
            # This ensures we discover models that are actually present
            models_to_add = []

            # Scan for GGUF models in the models directory
            try:
                installed_models = await self.get_installed_models()
                for model in installed_models:
                    # Determine a model type based on name patterns
                    model_name = model.get("name", model.get("id", ""))

                    # Skip docling models - they are internal document processing tools, not user-selectable models
                    # noinspection PyUnresolvedReferences
                    if "docling" in model_name.lower():
                        logger.debug("Skipping docling model (internal processing tool): %s", model_name)
                        continue

                    model_type = "NORMAL"  # Default

                    # noinspection PyUnresolvedReferences
                    if any(keyword in model_name.lower() for keyword in ["embed", "embedding"]):
                        model_type = "EMBEDDING"
                    # noinspection PyUnresolvedReferences
                    if any(keyword in model_name.lower() for keyword in ["reason", "r1", "distill"]):
                        model_type = "NORMAL"  # All models use dynamic reasoning detection

                    models_to_add.append(
                        {
                            "model_name": model_name,
                            "display_name": model.get("display_name", model_name),
                            "model_type": model_type,
                            "min_gpu_memory_mb": 0,
                            "min_cpu_memory_mb": 8192,  # 8GB default
                            "min_disk_space_mb": 0,
                        }
                    )

                logger.info("Found %s models in filesystem", len(models_to_add))
            except Exception as scan_error:
                logger.warning("Error scanning filesystem for models: %s", str(scan_error))

            # Return if no models to add
            if not models_to_add:
                logger.warning("No local models found in filesystem or fallback")
                return

            # Update existing provider or create new one
            if existing_provider:
                logger.info("Updating local model provider with %s models", len(models_to_add))

                # Remove existing models
                # noinspection PyTypeChecker
                db.query(ModelProviderModel).filter(ModelProviderModel.provider_id == existing_provider.id).delete()

                # Flush the deletion to the database before adding new models
                db.flush()

                # Add new models (no duplicates possible since we just deleted all)
                for model_data in models_to_add:
                    new_model = ModelProviderModel(
                        provider_id=existing_provider.id,
                        model_name=model_data["model_name"],
                        display_name=model_data["display_name"],
                        model_type=model_data["model_type"],
                        min_gpu_memory_mb=model_data["min_gpu_memory_mb"],
                        min_cpu_memory_mb=model_data["min_cpu_memory_mb"],
                        min_disk_space_mb=model_data["min_disk_space_mb"],
                    )
                    db.add(new_model)
            else:
                # Create a new provider
                logger.info(
                    "Creating new local model provider with %s models",
                    len(models_to_add),
                )

                new_provider = ModelProvider(
                    user_id=user_id,  # Can be None for system-wide provider
                    name="Local AI",
                    provider_type="local",
                    description="Local AI models running on this server",
                    show_models=True,
                    status="active",
                    validation_status="valid",  # Local provider is always valid
                )
                db.add(new_provider)
                db.flush()  # Get the ID for relationships

                # Add models (no duplicates possible for the new provider)
                for model_data in models_to_add:
                    new_model = ModelProviderModel(
                        provider_id=new_provider.id,
                        model_name=model_data["model_name"],
                        display_name=model_data["display_name"],
                        model_type=model_data["model_type"],
                        min_gpu_memory_mb=model_data["min_gpu_memory_mb"],
                        min_cpu_memory_mb=model_data["min_cpu_memory_mb"],
                        min_disk_space_mb=model_data["min_disk_space_mb"],
                    )
                    db.add(new_model)

            db.commit()
            logger.info(
                "Successfully initialized %s local models in database",
                len(models_to_add),
            )
        except Exception as e:
            logger.error("Error initializing local models: %s", e)
            db.rollback()
        # Don't raise the exception, just log it

    async def get_system_capabilities(self) -> dict[str, Any]:
        """Get system GPU capabilities and memory availability for model compatibility"""
        # Use the cached system capabilities from LLM manager
        return self.llm_manager.system_capabilities

    async def refresh_models_database(self):
        """Force refresh the system_models database entry from the filesystem"""
        # Find all model files
        all_gguf_files = find_gguf_files(self.models_directory)
        logger.info("Refresh found %s GGUF model files", len(all_gguf_files))

        # Process models and update the database
        models = []
        for file_path in all_gguf_files:
            # Extract model info
            filename = os.path.basename(file_path)
            model_name = filename.replace(".gguf", "")

            # Get model_name from the parent directory if applicable
            rel_path = os.path.relpath(file_path, self.models_directory)
            parent_dir = os.path.dirname(rel_path)

            # Use parent directory as model_name if exists
            if parent_dir and parent_dir != "." and parent_dir != "gguf":
                model_name = os.path.basename(parent_dir)

            # Get basic model info
            provider = determine_provider(model_name)
            parameters = extract_parameter_size(model_name)
            parameters_str = f"{parameters}B" if parameters else "Unknown"

            models.append(
                {
                    "id": self._get_model_uuid_from_db(model_name),
                    "name": model_name,
                    "provider": provider,
                    "parameters": parameters_str,
                    "format": str(os.path.splitext(file_path)[1]).lstrip("."),
                    "size_mb": round(os.path.getsize(file_path) / (1024 * 1024), 2),
                    "metadata": {
                        "description": f"Local GGUF model: {model_name}",
                        "path": file_path,
                    },
                }
            )

        # Update the database with the current models
        with SessionLocal() as db:
            try:
                # Initialize local models provider if needed
                await self.initialize_local_models(db)

                server_settings = get_or_create_server_setting(
                    db,
                    "system_models",
                    {"models": []},
                    "List of system models and their status",
                )

                # Update the server setting with models data
                # Use raw connection to completely bypass SQLAlchemy
                models_data = {"models": models}

                import json

                # Get the raw connection
                connection = db.connection()

                # Convert to JSON string manually
                models_json_str = json.dumps(models_data)

                if DB_TYPE == "postgresql":
                    # Use raw psycopg2 connection for PostgreSQL
                    raw_connection = connection.connection
                    with raw_connection.cursor() as cursor:
                        cursor.execute(
                            "UPDATE server_settings SET setting_value = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                            (models_json_str, str(server_settings.id)),
                        )
                else:
                    # For SQLite, use SQLAlchemy text but with simple parameters
                    from sqlalchemy import text

                    db.execute(
                        text("UPDATE server_settings SET setting_value = :json_data, updated_at = CURRENT_TIMESTAMP WHERE id = :setting_id"),
                        {
                            "json_data": models_json_str,
                            "setting_id": str(server_settings.id),
                        },
                    )

                db.commit()
                logger.info("Successfully refreshed models database with %s models", len(models))
            except Exception as e:
                logger.error("Error updating models database: %s", e)
                db.rollback()
                raise e from e

        return {
            "success": True,
            "message": f"Refreshed models database with {len(models)} models",
            "models": models,
        }

    @staticmethod
    async def check_repository_and_get_url(repo_id: str) -> str | None:
        """
        Check if a repository exists on Hugging Face and get the download URL.
        Tries multiple variations of repository names to find a match.

        Args:
            repo_id: Repository ID or path

        Returns:
            Download URL if found, None otherwise
        """
        try:
            # Import huggingface_hub here to avoid making it a global dependency
            from huggingface_hub import HfApi, hf_hub_url

            # Get token from settings
            hf_token = resolved_secrets.get("huggingface_token")

            # Create an API client with token if available
            api = HfApi(token=hf_token)

            # List of potential variations to try
            # to Get popular model publisher namespaces from config
            publisher_namespaces = resolved_config.get("llm", {}).get("model_publishers", [])
            if not publisher_namespaces:  # Default to an empty list if not configured
                publisher_namespaces = []

            # Create base variations without hardcoded namespaces
            variations = [
                repo_id,
                f"{repo_id}-GGUF",
            ]  # Original ID; try with GGUF suffix

            # Add namespace variations dynamically
            for namespace in publisher_namespaces:
                variations.append(f"{namespace}/{repo_id}")
                variations.append(f"{namespace}/{repo_id}-GGUF")

            # Add format variations without hardcoded namespaces
            if "-instruct" not in repo_id.lower() and "-chat" not in repo_id.lower():
                # For larger models (GPU) - add format variations
                base_variations = [f"{repo_id}-chat", f"{repo_id}-instruct"]
                variations.extend(base_variations)

                # Add namespace variations with formats
                for namespace in publisher_namespaces:
                    for variant in base_variations:
                        variations.append(f"{namespace}/{variant}")

            # Remove duplicates while preserving order
            variations = list(dict.fromkeys(variations))

            # Try each variation
            for variation in variations:
                try:
                    # Check if the repository exists
                    model_info = api.model_info(variation)
                    if not model_info:
                        continue

                    # Repository exists, now find a GGUF file
                    try:
                        # List files in the repository and look for GGUF files
                        files = api.list_repo_files(variation)
                        gguf_files = [f for f in files if f.lower().endswith(".gguf")]

                        if not gguf_files:
                            logger.info("No GGUF files found in %s", variation)
                            continue

                        # Log all found GGUF files for debugging
                        logger.info(
                            "Found %s GGUF files in repo %s: %s",
                            len(gguf_files),
                            variation,
                            ", ".join(gguf_files[:5]),
                        )

                        # Prefer certain quantizations
                        preferred = [f for f in gguf_files if any(q in f for q in ["Q4_K_M", "Q5_K_M", "Q8_0"])]
                        if preferred:
                            file_path = preferred[0]
                            logger.info("Selected preferred quantization file: %s", file_path)
                        else:
                            # Sort files by name (often smaller files come first in name ordering)
                            gguf_files.sort()
                            file_path = gguf_files[0]
                            logger.info("Selected first available GGUF file: %s", file_path)

                        # Get the URL for the file
                        url = hf_hub_url(repo_id=variation, filename=file_path, repo_type="model")
                        logger.info("Generated download URL: %s", url)
                        return url
                    except Exception as file_error:
                        logger.error(
                            "Error listing files in repository '%s': %s",
                            variation,
                            str(file_error),
                        )
                        continue
                except Exception as e:
                    logger.debug("Repository variation '%s' not found: %s", variation, str(e))
                    continue

            # If we get here, we couldn't find a suitable repository
            logger.warning("Could not find a suitable repository for %s", repo_id)
            return None
        except ImportError:
            logger.error("Failed to import HfApi. Please install huggingface_hub.")
            return None
        except Exception as e:
            logger.error("Error checking repository: %s", str(e))
            return None

    async def download_model(self, model_data: dict[str, Any]) -> dict[str, Any]:
        """
        Prepare to download a model and set up server configurations.

        Args:
            model_data: Dictionary containing model information

        Returns:
            Dictionary with status and message
        """
        try:
            # Extract model information
            model_id = model_data.get("id")
            model_name = model_data.get("name")
            download_url = model_data.get("download_url")

            if not model_name or not download_url:
                return {
                    "status": "error",
                    "message": "Invalid model data. Missing name or download URL.",
                }

            model_name = str(model_name)
            download_url = str(download_url)

            # Normalize model name to create a consistent internal name for file paths
            normalized_name = normalize_model_name(model_name, purpose="file_path")

            # If the URL is a repository path and not a direct download URL,
            # try to get the actual download URL
            if not download_url.startswith("http"):
                url_result = await self.check_repository_and_get_url(download_url)
                if not url_result:
                    return {
                        "status": "error",
                        "message": f"Could not resolve download URL for {model_name}",
                    }
                download_url = url_result

            # Perform some basic validation to ensure it's a recognized model format
            if not (
                download_url.endswith(".gguf") or download_url.endswith(".bin") or "/resolve/" in download_url or "huggingface.co" in download_url
            ):
                return {
                    "status": "error",
                    "message": f"Invalid download URL format: {download_url}",
                }

            # The download task will be added in the controller using background_tasks
            #  return the validated data here
            return {
                "status": "ready",
                "model_id": model_id or normalized_name,
                "model_name": model_name,
                "normalized_name": normalized_name,
                "download_url": download_url,
            }

        except Exception as e:
            logger.error("Error preparing model download: %s", str(e))
            return {
                "status": "error",
                "message": f"Error preparing model download: {e!s}",
            }

    async def download_model_task(self, model_id: str, model_name: str, download_url: str):
        """
        Download a model file and add it to the system settings.
        This is intended to be run as a background task.

        Args:
            model_id: Unique identifier for the model
            model_name: Display name for the model
            download_url: URL to download the model from
        """
        # Detect model type to determine the correct directory structure
        model_type = self._detect_model_type_from_name(model_name)

        # Determine base directory based on model type
        base_models_directory = self.models_directory
        if model_type == "EMBEDDING":
            # Route embedding models to embeddings directory
            if download_url.endswith(".gguf") or ".gguf" in download_url:
                models_directory = os.path.join(base_models_directory, "embeddings", "gguf")
            else:
                # HuggingFace or another format of embedding models
                models_directory = os.path.join(base_models_directory, "embeddings", "huggingface")
        else:
            # Route LLM models to appropriate directories
            if download_url.endswith(".gguf") or ".gguf" in download_url:
                models_directory = os.path.join(base_models_directory, "gguf")
            else:
                models_directory = os.path.join(base_models_directory, "huggingface")

        # Ensure target directory exists
        os.makedirs(models_directory, exist_ok=True)

        # Create model directory if needed
        model_dir = os.path.join(models_directory, model_id)
        os.makedirs(model_dir, exist_ok=True)

        # Define a target file path
        file_ext = os.path.splitext(download_url.rsplit("/", maxsplit=1)[-1])[1]
        if not file_ext:
            file_ext = ".gguf"  # Default extension if none is found
        target_path = os.path.join(model_dir, f"{model_id}{file_ext}")

        logger.info("Downloading %s model '%s' to: %s", model_type, model_name, target_path)

        try:
            # Record download start in the database
            with SessionLocal() as db:
                get_or_create_server_setting(
                    db,
                    f"download_status_{model_id}",
                    {
                        "model_id": model_id,
                        "model_name": model_name,
                        "status": "downloading",
                        "progress": 0,
                        "started_at": datetime.now(UTC).isoformat(),
                    },
                    f"Download status for model {model_name}",
                )

            # Start download with progress tracking
            logger.info("Starting download of model %s from %s", model_name, download_url)

            # Download using httpx with streaming and progress tracking
            async with aiohttp.ClientSession() as client:
                async with client.get(download_url, follow_redirects=True) as response:
                    response.raise_for_status()

                    # Get content length if available
                    total_size = int(response.headers.get("Content-Length", 0))
                    downloaded_size = 0
                    last_update_time = time.time()

                    # Open file for writing in binary mode
                    async with aiofiles.open(target_path, "wb") as f:
                        # Process chunks as they arrive
                        async for chunk in response.content.iter_chunked(8192):
                            # Write chunk to file - this returns a coroutine that must be awaited
                            await f.write(chunk)
                            downloaded_size += len(chunk)

                            # Update progress approximately once per second
                            current_time = time.time()
                            if current_time - last_update_time >= 1.0:
                                progress = round((downloaded_size / total_size * 100), 2) if total_size > 0 else 0

                                # Update the download status in the database
                                with SessionLocal() as db:
                                    download_status = get_or_create_server_setting(
                                        db,
                                        f"download_status_{model_id}",
                                        {"model_id": model_id, "status": "downloading"},
                                        f"Download status for model {model_name}",
                                    )

                                    # Update download status without triggering ORM issues
                                    updated_value = download_status.setting_value.copy()
                                    updated_value["progress"] = progress
                                    updated_value["downloaded"] = downloaded_size
                                    updated_value["total_size"] = total_size

                                    # Use raw SQL to avoid casting issues
                                    import json

                                    connection = db.connection()
                                    json_str = json.dumps(updated_value)

                                    if DB_TYPE == "postgresql":
                                        raw_connection = connection.connection
                                        with raw_connection.cursor() as cursor:
                                            cursor.execute(
                                                "UPDATE server_settings SET setting_value = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                                                (json_str, str(download_status.id)),
                                            )
                                    else:
                                        from sqlalchemy import text

                                        db.execute(
                                            text(
                                                "UPDATE server_settings SET setting_value = :json_data, updated_at = CURRENT_TIMESTAMP WHERE id = :setting_id"
                                            ),
                                            {
                                                "json_data": json_str,
                                                "setting_id": str(download_status.id),
                                            },
                                        )
                                    db.commit()

                                last_update_time = current_time
                                logger.info(
                                    "Downloading %s: %.1f%% (%.1f MB)",
                                    model_name,
                                    progress,
                                    downloaded_size / (1024 * 1024),
                                )
            # Record successful download
            with SessionLocal() as db:
                download_status = get_or_create_server_setting(
                    db,
                    f"download_status_{model_id}",
                    {"model_id": model_id, "status": "downloading"},
                    f"Download status for model {model_name}",
                )

                # Update download status without triggering ORM issues
                updated_value = download_status.setting_value.copy()
                updated_value["status"] = "completed"
                updated_value["completed_at"] = datetime.now(UTC).isoformat()

                # Use raw SQL to avoid casting issues
                import json

                connection = db.connection()
                json_str = json.dumps(updated_value)

                if DB_TYPE == "postgresql":
                    raw_connection = connection.connection
                    with raw_connection.cursor() as cursor:
                        cursor.execute(
                            "UPDATE server_settings SET setting_value = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                            (json_str, str(download_status.id)),
                        )
                else:
                    from sqlalchemy import text

                    db.execute(
                        text("UPDATE server_settings SET setting_value = :json_data, updated_at = CURRENT_TIMESTAMP WHERE id = :setting_id"),
                        {"json_data": json_str, "setting_id": str(download_status.id)},
                    )
                db.commit()

            # Add model to system settings
            self.add_model_to_system_settings(model_id, target_path)
            logger.info("Model %s downloaded successfully to %s", model_name, target_path)

            # Refresh the model database to include this new model
            await self.refresh_models_database()

            return {
                "status": "success",
                "message": f"Model {model_name} downloaded successfully",
            }

        except Exception as e:
            logger.error("Error downloading model %s: %s", model_name, str(e))

            # Record download failure
            with SessionLocal() as db:
                download_status = get_or_create_server_setting(
                    db,
                    f"download_status_{model_id}",
                    {"model_id": model_id, "status": "downloading"},
                    f"Download status for model {model_name}",
                )

                # Update download status without triggering ORM issues
                updated_value = download_status.setting_value.copy()
                updated_value["status"] = "failed"
                updated_value["error"] = str(e)
                updated_value["failed_at"] = datetime.now(UTC).isoformat()

                # Use raw SQL to avoid casting issues
                import json

                connection = db.connection()
                json_str = json.dumps(updated_value)

                if DB_TYPE == "postgresql":
                    raw_connection = connection.connection
                    with raw_connection.cursor() as cursor:
                        cursor.execute(
                            "UPDATE server_settings SET setting_value = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                            (json_str, str(download_status.id)),
                        )
                else:
                    from sqlalchemy import text

                    db.execute(
                        text("UPDATE server_settings SET setting_value = :json_data, updated_at = CURRENT_TIMESTAMP WHERE id = :setting_id"),
                        {"json_data": json_str, "setting_id": str(download_status.id)},
                    )
                db.commit()

            return {"status": "error", "message": f"Error downloading model: {e!s}"}

    @staticmethod
    def add_model_to_system_settings(model_name: str, model_path: str) -> bool:
        """
        Add a model to the system settings database.

        Args:
            model_name: Display name for the model
            model_path: Path to the model file

        Returns:
            bool: True if successful, False otherwise
        """
        try:
            # Create a database session
            with SessionLocal() as db:
                # Get server settings for system models
                server_settings = get_or_create_server_setting(
                    db,
                    "system_models",
                    {"models": []},
                    "List of system models and their status",
                )

                # Get a current models list
                models_list = server_settings.setting_value.get("models", [])

                # Check if the model already exists
                for i, model in enumerate(models_list):
                    if model.get("id") == model_name:
                        # Update existing model
                        models_list[i] = {
                            "id": model_name,
                            "name": model_name,
                            "path": model_path,
                            "parameters": {
                                "temperature": 0.1,
                                "top_p": 0.95,
                                "top_k": 40,
                                "repeat_penalty": 1.1,
                                "context_length": 4096,
                                "max_output_length": 2048,
                            },
                            "added_at": datetime.now(UTC).isoformat(),
                        }
                        # Use raw SQL to avoid casting issues
                        import json

                        connection = db.connection()
                        json_str = json.dumps({"models": models_list})

                        if DB_TYPE == "postgresql":
                            raw_connection = connection.connection
                            with raw_connection.cursor() as cursor:
                                cursor.execute(
                                    "UPDATE server_settings SET setting_value = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                                    (json_str, str(server_settings.id)),
                                )
                        else:
                            from sqlalchemy import text

                            db.execute(
                                text("UPDATE server_settings SET setting_value = :json_data, updated_at = CURRENT_TIMESTAMP WHERE id = :setting_id"),
                                {
                                    "json_data": json_str,
                                    "setting_id": str(server_settings.id),
                                },
                            )
                        db.commit()
                        logger.info("Model %s updated in system settings database", model_name)
                        return True

                # Add a new model
                models_list.append(
                    {
                        "id": model_name,
                        "name": model_name,
                        "path": model_path,
                        "parameters": {
                            "temperature": 0.1,
                            "top_p": 0.95,
                            "top_k": 40,
                            "repeat_penalty": 1.1,
                            "context_length": 4096,
                            "max_output_length": 2048,
                        },
                        "added_at": datetime.now(UTC).isoformat(),
                    }
                )

                # Update server settings using raw SQL to avoid casting issues
                import json

                connection = db.connection()
                json_str = json.dumps({"models": models_list})

                if DB_TYPE == "postgresql":
                    raw_connection = connection.connection
                    with raw_connection.cursor() as cursor:
                        cursor.execute(
                            "UPDATE server_settings SET setting_value = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                            (json_str, str(server_settings.id)),
                        )
                else:
                    from sqlalchemy import text

                    db.execute(
                        text("UPDATE server_settings SET setting_value = :json_data, updated_at = CURRENT_TIMESTAMP WHERE id = :setting_id"),
                        {"json_data": json_str, "setting_id": str(server_settings.id)},
                    )
                db.commit()
                logger.info("Model %s added to system settings database", model_name)
                return True

        except Exception as e:
            logger.error("Error adding model to system settings: %s", str(e))
            return False

    @staticmethod
    def is_valid_local_model(model_name: str) -> tuple[bool, str | None]:
        """
        Check if a local model exists and is valid.

        Args:
            model_name: The ID of the model to check

        Returns:
            Tuple containing:
            - Boolean indicating if the model is valid
            - String with a path to the model file if valid, an error message if invalid
        """
        try:
            # Get the GGUF models directory using centralized utility
            gguf_dir = get_gguf_models_directory()

            logger.info("Checking if model exists: %s", model_name)
            logger.info("Looking in directory: %s", gguf_dir)

            # Use centralized model path finding utility
            model_path = find_model_in_directory(model_name, gguf_dir, use_fuzzy_matching=True)
            model_found = model_path is not None

            if model_found:
                logger.info("Found local model: %s", model_path)
            else:
                logger.warning("Model not found: %s in directory: %s", model_name, gguf_dir)

            if model_found:
                return True, model_path
            else:
                if os.path.exists(gguf_dir):
                    all_files = [f for f in os.listdir(gguf_dir) if os.path.isfile(os.path.join(gguf_dir, f))]
                    all_dirs = [d for d in os.listdir(gguf_dir) if os.path.isdir(os.path.join(gguf_dir, d))]

                    all_models = all_files + all_dirs
                    model_list_str = ", ".join(all_models) if all_models else "none"

                    return (
                        False,
                        f"Model '{model_name}' not found in {gguf_dir}. Available models: {model_list_str}",
                    )
                else:
                    return False, f"GGUF directory does not exist: {gguf_dir}"

        except Exception as e:
            logger.exception("Error checking local model: %s", str(e))
            return False, f"Error checking model: {e!s}"

    async def _sync_remote_provider_if_needed(
        self,
        db: Session,
        provider_id: str,
        provider_type: str,
        api_key: str | None = None,
        api_base: str | None = None,
    ) -> bool:
        """Sync remote provider models if the provider supports remote API calls."""
        remote_providers = [
            "ollama",
            "vllm",
            "deepseek",
            "openai",
            "anthropic",
            "openrouter",
            "google",
        ]

        if provider_type.lower() not in remote_providers:
            return False

        try:
            logger.info("🔄 Syncing remote models for provider %s (ID: %s)", provider_type, provider_id)
            # Use standardized model sync utility
            from src.main.utils.llm.model_utils import sync_provider_models_standard

            success, message, models = await sync_provider_models_standard(
                self.remote_sync_service,
                db,
                provider_id,
                provider_type,
                api_key,
                api_base,
                True,
            )

            if success:
                logger.info("Successfully synced %s models from %s", len(models), provider_type)
                return True
            else:
                logger.warning("⚠️ Failed to sync %s: %s", provider_type, message)
                return False

        except Exception as e:
            logger.exception("❌ Error syncing %s: %s", provider_type, str(e))
            return False

    async def _sync_remote_providers(self, db: Session, provider_types: list[str]) -> None:
        """Sync models from remote providers that support live API checks."""
        try:
            # Get provider details for remote sync
            # to Allow any provider with an API key, regardless of status
            # Build IN clause for database compatibility with proper parameter binding
            if not provider_types:
                return  # No providers to sync

            provider_type_placeholders = ",".join([":provider_type_" + str(i) for i in range(len(provider_types))])
            provider_query = f"""
                SELECT id, provider_type, name, api_key, api_base
                FROM model_providers
                WHERE provider_type IN ({provider_type_placeholders})
                AND api_key IS NOT NULL AND api_key != ''
            """

            # Create parameter dictionary for proper binding
            params = {f"provider_type_{i}": provider_type for i, provider_type in enumerate(provider_types)}
            result = db.execute(text(provider_query), params)
            providers_data = result.fetchall()

            for provider_row in providers_data:
                provider_id, provider_type, provider_name, api_key, api_base = provider_row

                # Only sync remote providers that support API calls
                if await self._sync_remote_provider_if_needed(db, provider_id, provider_type, api_key, api_base):
                    logger.info("🔄 Synced remote provider: %s (%s)", provider_name, provider_type)

        except Exception as e:
            logger.exception("❌ Error syncing remote providers: %s", str(e))

    async def list_provider_models(
        self,
        providers: list[str] | None = None,
        model_type: str | None = None,
        search: str | None = None,
        user_id: str | None = None,
        page: int | None = None,
        limit: int | None = None,
        refresh: bool | None = False,
    ) -> tuple[list["GroupedProviderDTO"], int]:
        """Fetch available models grouped by provider using modern Python patterns. Supports global search across all providers."""

        # Modern logging with walrus operator and f-strings
        logger.info(
            "🔍 Listing models: providers=%s, type=%s, search=%s, user=%s...", providers, model_type, search, str(user_id)[:8] if user_id else "None"
        )

        # Use walrus operator for concise boolean assignment
        provider_count = 0
        strict_filtering = bool(providers and (provider_count := len(providers)) > 0)
        logger.info("📋 Strict filtering: %s (%s providers)", strict_filtering, provider_count if strict_filtering else 0)

        # Modern async function with enhanced error handling and functional programming
        async def execute_db_query(db_session: Session, query_str: str, q_params: dict) -> list[dict[str, Any]]:
            """Execute a database query using modern Python patterns and functional programming."""
            try:
                if not (result := db_session.execute(text(query_str), q_params)):
                    return []

                rows = result.fetchall()
                logger.info("📊 Query returned %s rows", len(rows))

                # Functional approach with proper function definition (PEP 8 compliant)
                def create_model_info(row):
                    """Create a model info dictionary from a database row."""
                    # Active model concept removed - no is_active tracking
                    model_info = {
                        "id": row[0],
                        "name": row[2],
                        "display_name": row[3] or row[2],
                        "provider_id": row[1],
                        "provider_type": row[7],
                        "provider_name": row[8],
                        "model_type": row[4],
                        "is_embedding_model": row[4] == "EMBEDDING",
                        "dimensions": row[6],
                        "deployment_status": None,
                        "deployment_message": None,
                        "is_system_model": row[10] is None,  # System models have user_id IS NULL
                    }

                    # Add deployment status for local models
                    if row[7] == "local":  # provider_type is local
                        from src.main.service.local_models.model_service import (
                            MODEL_PROCESSES,
                            MODEL_STATUS,
                        )

                        model_name = row[2]  # model name

                        # Check deployment status
                        deployment_status = "unknown"
                        deployment_message = None

                        # Check MODEL_STATUS first (more detailed)
                        if model_name in MODEL_STATUS:
                            status_info = MODEL_STATUS[model_name]
                            deployment_status = status_info.get("status", "unknown")
                            deployment_message = status_info.get("message")
                        # Fallback to MODEL_PROCESSES
                        elif model_name in MODEL_PROCESSES:
                            process_info = MODEL_PROCESSES[model_name]
                            deployment_status = process_info.get("status", "unknown")

                        model_info["deployment_status"] = deployment_status
                        if deployment_message:
                            model_info["deployment_message"] = deployment_message

                        # Active model concept removed - no is_active field to override

                    return model_info

                return [create_model_info(row) for row in rows]

            except Exception as ex:
                logger.error("❌ Database query failed: %s", ex)
                return []

        # Modern initialization with type hints and session management
        all_models: list[ProviderModelDTO] = []
        total_count = 0  # Initialize to prevent UnboundLocalError

        # Use context manager for database session
        db = SessionLocal()

        try:
            # Modern provider discovery with functional programming
            providers = await self._discover_active_providers(db, providers, strict_filtering)

            if not providers:
                logger.info("🚫 No active providers found - allowing empty result for direct API calls")
                # Return empty immediately to let controller handle direct API calls
                return [], 0

            logger.info("Using providers: %s", ", ".join(providers))

            # Sync remote providers only if refresh=true (for live API checks)
            if refresh:
                logger.info("🔄 Refresh=true, syncing remote providers from APIs")
                await self._sync_remote_providers(db, providers)
            else:
                logger.info("📋 Refresh=false, using database cache only (no remote API sync)")

            # Active model concept removed - build query components only
            provider_condition, user_filter, model_type_condition = self._build_query_components(providers, strict_filtering, user_id, model_type)

            # Add search condition if provided
            search_condition = ""
            if search:
                search_condition = "AND (LOWER(m.model_name) LIKE LOWER(:search) OR LOWER(m.display_name) LIKE LOWER(:search))"

            # Modern query building with enhanced readability
            logger.info("🔧 Query components: provider_condition=%s..., user_filter=%s", provider_condition[:50], user_filter)

            # Modern query construction with f-strings and better formatting
            base_conditions = f"""
                (p.api_key IS NOT NULL AND p.api_key != '' OR p.provider_type IN ('local', 'ollama', 'vllm'))
                AND (p.show_models = TRUE OR p.provider_type = 'local')
                AND p.status IN ('active', 'enabled')
                AND {provider_condition}
                {user_filter}
                {model_type_condition}
                {search_condition}
            """

            count_query = f"""
                SELECT COUNT(*)
                FROM model_provider_models m
                JOIN model_providers p ON m.provider_id = p.id
                WHERE {base_conditions}
            """

            # Modern pagination with walrus operator
            pagination_clause = f"LIMIT {limit} OFFSET {(page - 1) * limit}" if (page and limit) else ""

            main_query = f"""
                SELECT
                    m.id, m.provider_id, m.model_name, m.display_name, m.model_type,
                    m.model_namespace, m.dimensions, p.provider_type, p.name as provider_name,
                    p.status as provider_status, p.user_id
                FROM model_provider_models m
                JOIN model_providers p ON m.provider_id = p.id
                WHERE {base_conditions}
                ORDER BY
                    CASE WHEN p.user_id IS NULL THEN 0 ELSE 1 END,
                    CASE WHEN p.provider_type = 'local' THEN 0 ELSE 1 END,
                    m.display_name
                {pagination_clause}
            """

            # Modern parameter building using dictionary comprehension and walrus operator
            query_params = {
                **({"user_id": user_id} if user_id else {}),
                **({"model_type": model_type} if model_type else {}),
                **({"search": f"%{search}%"} if search else {}),
            }

            # Execute a count query if pagination is needed
            total_count = 0
            if page and limit:
                try:
                    total_count = db.execute(text(count_query), query_params).scalar() or 0
                except Exception as count_error:
                    logger.error("❌ Error getting count: %s", count_error)
                    total_count = 0

            # Execute main query and process results using modern patterns
            models_data = await execute_db_query(db, main_query, query_params)
            if models_data:
                # Functional approach to convert models using list comprehension
                converted_models = [ProviderModelDTO.from_dict(self._ensure_dto_compatible_types(model)) for model in models_data]
                all_models.extend(converted_models)
                logger.info("Added %s models from database", len(converted_models))

            # Modern local model discovery using functional programming
            if self._should_discover_local_models(strict_filtering, providers, user_id):
                await self._discover_and_add_local_models(db, all_models)

        except Exception as e:
            logger.error("❌ Error fetching models: %s", e)
        finally:
            db.close()

        # Modern fallback handling using functional programming
        if self._should_use_fallback(providers, all_models, strict_filtering):
            await self._handle_fallback_initialization(db, user_id)
            # Retry with an updated database using a modern query retry pattern
            # noinspection PyTypeChecker
            if retry_models := await self._initialize_and_retry_query(db, providers, strict_filtering, user_id, model_type, page, limit):
                all_models.extend(retry_models)
                # Update total count if pagination was requested
                if page and limit:
                    # noinspection PyTypeChecker
                    total_count = await self._get_total_count_after_retry(db, providers, strict_filtering, user_id, model_type)

        # Filter out models with deployment errors before deduplication
        filtered_models = []
        for model in all_models:
            # Skip local models with deployment errors
            # noinspection PyUnresolvedReferences
            if (
                hasattr(model, "provider_type")
                and model.provider_type == "local"
                and hasattr(model, "deployment_status")
                and model.deployment_status == "error"
            ):
                logger.debug("🚫 Filtering out failed model: %s", model.model_name)
                continue
            filtered_models.append(model)

        logger.info("🔍 Filtered %s failed models", len(all_models) - len(filtered_models))

        # Modern deduplication using functional programming and set comprehension
        unique_models = {(model.model_name, model.provider_type): model for model in filtered_models}.values()

        # Modern sorting with lambda and multiple criteria
        # Sort order: system models first, then local models, then others
        sorted_models = sorted(
            unique_models,
            key=lambda m: (
                0 if getattr(m, "is_system_model", False) else 1,
                0 if m.provider_type == "local" else 1,
                m.display_name or m.model_name,
            ),
        )

        # Group models by provider using proper DTOs

        providers_with_models = {}
        for model in sorted_models:
            provider_type = model.provider_type
            provider_name = getattr(model, "provider_name", provider_type)
            provider_id = getattr(model, "provider_id", None)

            if provider_type not in providers_with_models:
                providers_with_models[provider_type] = {
                    "id": provider_id,
                    "provider_type": provider_type,
                    "name": provider_name,
                    "models": [],
                }

            # Add provider info to model and convert to ProviderModelDTO
            model_dict = model.model_dump() if hasattr(model, "model_dump") else model.__dict__
            model_dict["provider"] = provider_type
            model_dict["provider_type"] = provider_type

            # Convert to ProviderModelDTO
            provider_model = ProviderModelDTO.from_dict(model_dict)
            providers_with_models[provider_type]["models"].append(provider_model)

        # Convert to GroupedProviderDTO objects
        grouped_providers = [
            GroupedProviderDTO(
                id=provider_data["id"],
                provider_type=provider_data["provider_type"],
                name=provider_data["name"],
                models=provider_data["models"],
            )
            for provider_data in providers_with_models.values()
        ]

        logger.info(
            "🎯 Returning %s unique models grouped into %s providers (total_count: %s)", len(sorted_models), len(grouped_providers), total_count
        )
        return grouped_providers, total_count

    async def _get_total_count_after_retry(
        self,
        db,
        providers: list[str],
        strict_filtering: bool,
        user_id: str | None,
        model_type: str | None,
    ) -> int:
        """Modern helper to get total count after retry using functional programming."""
        try:
            provider_condition, user_filter, model_type_condition = self._build_query_components(providers, strict_filtering, user_id, model_type)

            count_query = f"""
                SELECT COUNT(*)
                FROM model_provider_models m
                JOIN model_providers p ON m.provider_id = p.id
                WHERE (p.api_key IS NOT NULL AND p.api_key != '' OR p.provider_type IN ('local', 'ollama', 'vllm'))
                    AND (p.show_models = TRUE OR p.provider_type = 'local')
                    AND p.status IN ('active', 'enabled')
                    AND {provider_condition}
                    {user_filter}
                    {model_type_condition}
            """

            query_params = {
                **({"user_id": user_id} if user_id else {}),
                **({"model_type": model_type} if model_type else {}),
            }

            return db.execute(text(count_query), query_params).scalar() or 0

        except Exception as e:
            logger.error("❌ Error getting retry count: %s", e)
            return 0

    @staticmethod
    def normalize_model_display_name(model_name: str) -> str:
        """
        Normalize the model name for UI display by creating a clean, human-readable display name.
        This works in conjunction with the frontend getSimplifiedName() function.
        """
        return normalize_model_display_name(model_name)

    @staticmethod
    def _is_hash_like_name(name: str) -> bool:
        """Check if a directory name looks like a hash (long alphanumeric string)"""
        if len(name) < 20:  # Hashes are typically longer
            return False
        # Check if it's mostly alphanumeric and looks like a hash
        return len(name) > 30 and all(c.isalnum() for c in name) and any(c.isdigit() for c in name) and any(c.isalpha() for c in name)

    @staticmethod
    def _is_generic_cache_name(name: str) -> bool:
        """Check if a directory name is a generic cache/temp name"""
        name_lower = name.lower()

        # Exact matches for very generic names
        exact_generic_names = {
            "model",
            "models",
            "accurate",
            "fast",
            "slow",
            "temp",
            "tmp",
            "cache",
            "download",
            "downloads",
            "data",
            "files",
            "assets",
            "resources",
            "config",
            "configs",
            "bin",
            "lib",
            "libs",
        }

        if name_lower in exact_generic_names:
            return True

        # Check for names that are too generic or look like file extensions
        if (
            len(name) <= 3  # Very short names
            or name_lower in ["png", "jpg", "gif", "pdf", "txt", "json", "xml", "bin"]
            or name.startswith(".")  # Hidden files/directories
            or name.endswith(".tmp")
            or name.endswith(".cache")
        ):
            return True

        return False

    @staticmethod
    async def _get_models_from_database() -> list[dict[str, Any]]:
        """
        Query models from the model_provider_models table.
        Returns cached models from the database without filesystem scanning.
        """
        from src.main.models.sqlmodel_providers import ModelProvider, ModelProviderModel

        try:
            with SessionLocal() as db:
                # Get a local provider
                # noinspection PyUnresolvedReferences
                local_provider = (
                    db.query(ModelProvider)
                    .filter(
                        ModelProvider.provider_type == "local",
                        ModelProvider.user_id.is_(None),  # System provider
                    )
                    .first()
                )

                if not local_provider:
                    logger.debug("Local provider not found in database")
                    return []

                # Get all models for a local provider
                # noinspection PyTypeChecker
                db_models = (
                    # noinspection PyTypeChecker
                    db.query(ModelProviderModel).filter(ModelProviderModel.provider_id == local_provider.id).all()
                )

                if not db_models:
                    logger.debug("No models found in database for local provider")
                    return []

                # Convert ORM models to dictionary format
                models = []
                for db_model in db_models:
                    model_dict = {
                        "id": str(db_model.id),
                        "name": db_model.model_name,
                        "display_name": db_model.display_name or db_model.model_name,
                        "model_type": db_model.model_type or "NORMAL",
                        "provider": "local",
                        "status": "ready",
                    }

                    # Add optional fields if they exist
                    if db_model.dimensions:
                        model_dict["dimensions"] = db_model.dimensions
                    if db_model.context_window:
                        model_dict["context_window"] = db_model.context_window

                    models.append(model_dict)

                logger.info("Retrieved %s models from database cache", len(models))
                return models

        except Exception as e:
            logger.error("Error querying models from database: %s", e)
            return []

    async def get_installed_models(self, model_type_filter: str | None = None, force_refresh: bool = False) -> list[dict[str, Any]]:
        """
        Get the list of locally installed models.

        Args:
            model_type_filter: Filter by model type (NORMAL, EMBEDDING, VISION)
            force_refresh: If True, scan filesystem and update a database.
                          If False, use database cache (default, much faster)

        Returns:
            List of model dictionaries
        """
        from src.main.config.database import DB_TYPE

        # Step 1: Try to use the database cache (fast path)
        if not force_refresh:
            models_from_db = await self._get_models_from_database()

            if models_from_db:
                logger.info("Using database cache: %s models (skipping filesystem scan)", len(models_from_db))
                # Apply filters and return
                return self._apply_model_type_filter(models_from_db, model_type_filter)

            # Database is empty - first run, need to scan filesystem
            logger.info("Database cache empty - performing initial filesystem scan to populate database")
        else:
            logger.info("Force refresh requested - scanning filesystem to update database")

        # Step 2: Filesystem scan (only if force_refresh=True OR database empty)
        models_directory = MODELS_DIRECTORY
        logger.info("Scanning models directory: %s", models_directory)
        db_models = []

        # Create a database session
        with SessionLocal() as db:
            # Get database models from server settings
            # noinspection PyTypeChecker
            server_settings = db.query(ServerSetting).filter(ServerSetting.setting_key == "system_models").first()

            # If we have server settings, get the tracked models
            if server_settings and server_settings.setting_value and "models" in server_settings.setting_value:
                db_models = server_settings.setting_value["models"]

        # List all models in the directory and its subdirectories
        models = []

        # Function to recursively find all model files

        def find_model_files(directory: str, depth: int = 0) -> list:
            m_files = []
            if not os.path.exists(directory):
                return m_files

            # Check if we're in the embeddings directory
            is_embeddings_dir = "embeddings" in str(directory).lower()

            for item in os.listdir(directory):
                item_path = os.path.join(directory, item)

                # Check if it's a file with a valid model extension
                if os.path.isfile(item_path) and any(item.endswith(model_ext) for model_ext in VALID_MODEL_EXTENSIONS):
                    # Skip cache metadata files and other non-model files
                    if (
                        item.endswith(".metadata")
                        or ".cache" in item_path
                        or item.startswith(".git")
                        or item in [".gitignore", ".gitattributes"]
                        or item.startswith("README")
                        or item.endswith(".md")
                        or item.endswith(".txt")
                        or item.endswith(".json")
                        or item.endswith(".yaml")
                        or item.endswith(".yml")
                    ):
                        continue

                    # Additional check: a file must be reasonably large (> 1MB) to be a real model
                    try:
                        file_size = os.path.getsize(item_path)
                        if file_size < 1024 * 1024:  # Less than 1MB
                            continue
                    except OSError:
                        continue

                    m_files.append(item_path)

                # Check if it's a directory that might contain model files
                elif os.path.isdir(item_path):
                    # Skip only the .cache directory
                    dir_name = os.path.basename(item_path)
                    if dir_name in [".cache"]:
                        logger.info("Skipping directory: %s at path: %s", dir_name, item_path)
                        continue

                    # For embeddings directory, scan up to 3 levels deep to include model files
                    # embeddings/huggingface/all-MiniLM-L6-v2/pytorch_model.bin
                    if is_embeddings_dir and depth >= 3:
                        continue

                    m_files.extend(find_model_files(item_path, depth + 1))

            return m_files

        # Find all model files with valid extensions in the models directory
        model_files = find_model_files(models_directory)
        logger.info("Found %s model files in directory and subdirectories", len(model_files))

        # Process each model file
        for file_path in model_files:
            file_path = str(file_path)
            file_stats = os.stat(file_path)

            # Extract model name from filename
            filename = os.path.basename(file_path)

            # Remove various model file extensions
            for ext in VALID_MODEL_EXTENSIONS:
                if filename.endswith(ext):
                    model_name = filename[: -len(ext)]
                    break
            else:
                model_name = filename

            # Also include a parent directory in model ID if it's in a subdirectory
            rel_path = os.path.relpath(file_path, models_directory)
            parent_dir = os.path.dirname(rel_path)

            # For embedding models, use the deepest directory name that's not a provider type
            if "embeddings" in file_path.lower():
                # For embeddings/huggingface/all-MiniLM-L6-v2/pytorch_model.bin
                # We want to extract "all-MiniLM-L6-v2" as the model name
                path_parts = parent_dir.split(os.sep)
                # Find the model name (skip embeddings, provider type directories)
                for part in reversed(path_parts):
                    if part not in [
                        "embeddings",
                        "huggingface",
                        "gguf",
                        "local",
                        ".",
                        "",
                    ]:
                        model_name = part
                        break
            elif parent_dir and parent_dir != "." and parent_dir != "gguf":
                # Use parent directory as model_name if exists, but validate it's a proper model name
                parent_name = str(os.path.basename(parent_dir))
                # Skip hash-like directory names and generic names that are likely cache/temp directories
                if (
                    not self._is_hash_like_name(parent_name) and not self._is_generic_cache_name(parent_name) and len(parent_name) > 2
                ):  # Avoid very short names
                    model_name = parent_name

            # Skip docling models - they are internal document processing tools, not user-selectable models
            if "docling" in model_name.lower():
                logger.debug("Skipping docling model during filesystem scan: %s", model_name)
                continue

            # Determine provider based on model name
            provider = determine_provider(model_name)

            # Set icon based on the provider
            icon = get_model_icon(provider)

            # Extract parameters (if available in the model name)
            parameters = extract_parameter_size(model_name)

            # Check if this model is in database models
            db_model = next((m for m in db_models if m.get("id") == model_name), None)

            # Active model concept removed - all models are ready
            status = "ready"

            # Get any additional metadata from the database
            # noinspection PyUnresolvedReferences
            metadata = db_model["metadata"] if db_model and "metadata" in db_model else {}

            # Auto-detect a model type by inspecting model files and configuration
            model_type = metadata.get("model_type", "NORMAL")

            # Force re-detection for models in the embeddings directory (to fix previously cached models)
            if "embeddings" in file_path.lower():
                detected_type = self._detect_model_type(file_path, model_name)
                if detected_type != "NORMAL":
                    model_type = detected_type
                    # Update metadata with a detected model type
                    metadata["model_type"] = model_type
                    logger.info("Force re-detected %s model in embeddings directory: %s", model_type.lower(), model_name)
            elif model_type == "NORMAL":  # Only auto-detect if not already set
                detected_type = self._detect_model_type(file_path, model_name)
                if detected_type != "NORMAL":
                    model_type = detected_type
                    # Update metadata with a detected model type
                    metadata["model_type"] = model_type
                    logger.info("Auto-detected %s model: %s", model_type.lower(), model_name)

            # Clean tags if present in metadata
            if "tags" in metadata:
                metadata["tags"] = clean_tags(metadata["tags"])

            # Calculate compatibility score based on model parameters and system capabilities
            score = 80  # Default compatibility score
            if parameters:
                # Adjust the score based on model size - smaller models get higher scores for compatibility
                if parameters <= 1.0:  # Very small models (1B or less)
                    score = 95
                elif parameters <= 3.0:  # Small models (1-3B)
                    score = 90
                elif parameters <= 7.0:  # Medium models (3-7B)
                    score = 85
                elif parameters <= 13.0:  # Large models (7-13B)
                    score = 75
                elif parameters <= 30.0:  # Very large models (13-30B)
                    score = 65
                else:  # Extremely large models (30B+)
                    score = 50

            models.append(
                {
                    "id": self._get_model_uuid_from_db(model_name),
                    "name": model_name,
                    "display_name": self.normalize_model_display_name(model_name),
                    "file_size": file_stats.st_size,
                    "parameters": parameters,
                    "format": str(os.path.splitext(file_path)[1])[1:],  # Get a format from the extension without the dot
                    "path": file_path,
                    "status": status,
                    "provider": provider,
                    "icon": icon,
                    "installed_date": time.ctime(file_stats.st_mtime),
                    "score": score,
                    **metadata,  # Include any additional metadata
                }
            )

        # Always update the database with current models regardless of the previous state
        try:
            # Update a database with current models
            with SessionLocal() as db:
                # Get or create server settings for system models
                server_settings = get_or_create_server_setting(
                    db,
                    "system_models",
                    {"models": []},
                    "List of system models and their status",
                )

                # Get a current models list
                db_models = server_settings.setting_value.get("models", [])

                # Check if we have models to update
                if models:
                    # Update the model list with current models
                    db_model_ids = [m.get("id") for m in db_models]
                    for model in models:
                        if model["id"] not in db_model_ids:
                            # Add a new model to a database
                            db_models.append(
                                {
                                    "id": model["id"],
                                    "name": model["name"],
                                    "provider": model["provider"],
                                    "parameters": model["parameters"],
                                    "metadata": {"description": f"Local GGUF model: {model['name']}"},
                                }
                            )
                    # Remove models from a database that no longer exist
                    model_ids = [m["id"] for m in models]
                    db_models = [m for m in db_models if m.get("id") in model_ids]

                    # Update the server settings using raw SQL to avoid casting issues
                    import json

                    connection = db.connection()
                    json_str = json.dumps({"models": db_models})

                    if DB_TYPE == "postgresql":
                        raw_connection = connection.connection
                        with raw_connection.cursor() as cursor:
                            cursor.execute(
                                "UPDATE server_settings SET setting_value = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                                (json_str, str(server_settings.id)),
                            )
                    else:
                        from sqlalchemy import text

                        db.execute(
                            text("UPDATE server_settings SET setting_value = :json_data, updated_at = CURRENT_TIMESTAMP WHERE id = :setting_id"),
                            {
                                "json_data": json_str,
                                "setting_id": str(server_settings.id),
                            },
                        )
                    db.commit()
                    logger.info("Updated models database with %d models", len(db_models))
                else:
                    # If no models found in filesystem but db has models, reset to an empty list
                    if db_models:
                        # Use raw SQL to avoid casting issues
                        import json

                        connection = db.connection()
                        json_str = json.dumps({"models": []})

                        if DB_TYPE == "postgresql":
                            raw_connection = connection.connection
                            with raw_connection.cursor() as cursor:
                                cursor.execute(
                                    "UPDATE server_settings SET setting_value = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                                    (json_str, str(server_settings.id)),
                                )
                        else:
                            from sqlalchemy import text

                            db.execute(
                                text("UPDATE server_settings SET setting_value = :json_data, updated_at = CURRENT_TIMESTAMP WHERE id = :setting_id"),
                                {
                                    "json_data": json_str,
                                    "setting_id": str(server_settings.id),
                                },
                            )
                        db.commit()
                        logger.warning("No models found in filesystem but had db entries. Resetting to empty list.")
                    else:
                        logger.info("No models found - database is already empty")
        except Exception as db_error:
            logger.error("Error updating models database: %s", str(db_error))

        # Sync all GGUF models to the model_provider_models table
        try:
            self._sync_local_models_to_database(models)
        except Exception as sync_error:
            logger.error("Error syncing local models to database: %s", str(sync_error))

        # Clean any tags before returning the models
        for model in models:
            if "tags" in model:
                model["tags"] = clean_tags(model["tags"])

        # Filter out models with deployment errors (same logic as list_provider_models)
        filtered_models = []
        for model in models:
            model_name = model.get("name", "")

            # Check deployment status for local models
            deployment_status = "ready"  # Default status
            try:
                from src.main.service.local_models.model_service import MODEL_STATUS

                if model_name in MODEL_STATUS:
                    status_info = MODEL_STATUS[model_name]
                    if isinstance(status_info, dict):
                        deployment_status = status_info.get("status", "ready")
                    else:
                        deployment_status = status_info
            except ImportError:
                # noinspection PyPep8Naming
                MODEL_STATUS = None
                logger.warning("Could not import MODEL_STATUS, skipping deployment filtering")

            # Skip models with deployment errors
            if deployment_status == "error":
                logger.debug("🚫 Filtering out failed installed model: %s", model_name)
                continue

            filtered_models.append(model)

        logger.info("🔍 Filtered %s failed installed models", len(models) - len(filtered_models))
        models = filtered_models

        # Apply filtering and return
        return self._apply_model_type_filter(models, model_type_filter)

    @staticmethod
    def _apply_model_type_filter(models: list[dict[str, Any]], model_type_filter: str | None = None) -> list[dict[str, Any]]:
        """
        Apply model type filtering to a list of models.

        Args:
            models: List of model dictionaries
            model_type_filter: Filter by specific type, or None to exclude embeddings by default

        Returns:
            Filtered list of models
        """
        # Apply model type filter if specified
        if model_type_filter:
            # Filter for models that match the specified type
            type_filtered_models = []
            for model in models:
                model_type = model.get("model_type", "NORMAL")
                if model_type == model_type_filter:
                    type_filtered_models.append(model)
            filtered_models = type_filtered_models
        else:
            # Default behavior: exclude embedding models unless specifically requested
            default_filtered_models = []
            for model in models:
                model_type = model.get("model_type", "NORMAL")
                if model_type != "EMBEDDING":
                    default_filtered_models.append(model)
            filtered_models = default_filtered_models
            logger.info("Filtered out embedding models. Returning %s LLM models", len(filtered_models))

        return filtered_models

    @staticmethod
    def _detect_model_type(model_path: str, model_name: str) -> str:
        """
        Programmatically detect the model type by inspecting model files and configuration.
        Returns: "NORMAL", "EMBEDDING", "VISION", or "AUDIO"
        """
        try:
            import json
            from pathlib import Path

            model_file = Path(model_path)
            model_dir = model_file.parent  # Get the directory containing the model file

            # 0. Check if the model is in the embeddings directory (path-based detection)
            if "embeddings" in str(model_path).lower():
                logger.info("Path-based embedding detection for: %s (path contains 'embeddings')", model_name)
                return "EMBEDDING"

            # 1. Check for config.json - most reliable method
            # Look for config.json in the model directory and parent directories
            config_path = model_dir / "config.json"
            if not config_path.exists():
                # Try parent directory (for models like all-MiniLM-L6-v2/openvino/model.bin)
                config_path = model_dir.parent / "config.json"
            if config_path.exists():
                try:
                    with open(config_path, encoding="utf-8") as f:
                        config = json.load(f)

                    # Check a model architecture type
                    architectures = config.get("architectures", [])
                    if architectures:
                        arch_str = str(architectures[0]).lower()

                        # Embedding model architectures
                        if any(
                            pattern in arch_str
                            for pattern in [
                                "sentence",
                                "embedding",
                                "encode",
                                "retrieval",
                                "bert",
                                "roberta",
                                "distilbert",
                            ]
                        ):
                            # Check if it's specifically for embeddings
                            if (
                                any(
                                    pattern in arch_str
                                    for pattern in [
                                        "sentence",
                                        "embedding",
                                        "encode",
                                        "retrieval",
                                    ]
                                )
                                or config.get("model_type") == "sentence-transformers"
                            ):
                                return "EMBEDDING"

                        # Vision model architectures
                        if any(
                            pattern in arch_str
                            for pattern in [
                                "vision",
                                "clip",
                                "vit",
                                "deit",
                                "swin",
                                "convnext",
                                "resnet",
                            ]
                        ):
                            return "VISION"

                        # Audio model architectures
                        if any(
                            pattern in arch_str
                            for pattern in [
                                "whisper",
                                "wav2vec",
                                "audio",
                                "speech",
                                "hubert",
                            ]
                        ):
                            return "AUDIO"

                    # Check model_type field in config
                    model_type = config.get("model_type", "").lower()
                    if "sentence" in model_type or "embedding" in model_type:
                        return "EMBEDDING"

                    # Check task-specific configurations
                    task = config.get("task", "").lower()
                    if "embedding" in task or "sentence-similarity" in task:
                        return "EMBEDDING"

                except (json.JSONDecodeError, KeyError, FileNotFoundError) as e:
                    logger.debug("Could not parse config.json for %s: %s", model_name, e)

            # 2. Check for sentence-transformers-specific files
            if (model_dir / "sentence_bert_config.json").exists():
                return "EMBEDDING"

            if (model_dir / "modules.json").exists():
                try:
                    with open(model_dir / "modules.json", encoding="utf-8") as f:
                        modules = json.load(f)
                    if any("sentence_transformers" in str(module) for module in modules):
                        return "EMBEDDING"
                except (json.JSONDecodeError, FileNotFoundError) as e:
                    logger.debug("Could not read modules.json for %s: %s", model_dir, e)

            # 3. Check tokenizer config for clues
            tokenizer_config_path = model_dir / "tokenizer_config.json"
            if tokenizer_config_path.exists():
                try:
                    with open(tokenizer_config_path, encoding="utf-8") as f:
                        tokenizer_config = json.load(f)

                    # Check for embedding-specific tokenizer settings
                    if tokenizer_config.get("model_max_length") == 512:  # Common for embedding models
                        model_name_lower = model_name.lower()
                        if any(
                            pattern in model_name_lower
                            for pattern in [
                                "minilm",
                                "mpnet",
                                "distilroberta",
                                "bge",
                                "gte",
                                "e5",
                            ]
                        ):
                            return "EMBEDDING"

                except (json.JSONDecodeError, FileNotFoundError) as e:
                    logger.debug("Could not read tokenizer_config.json for %s: %s", model_dir, e)

            # 4. Check model file sizes and structure (embedding models are typically smaller)
            model_files = list(model_dir.glob("*.bin")) + list(model_dir.glob("*.safetensors"))
            if model_files:
                total_size = sum(f.stat().st_size for f in model_files if f.exists())
                # Embedding models are typically under 500MB
                if total_size < 500 * 1024 * 1024:  # 500MB
                    model_name_lower = model_name.lower()
                    # Check for embedding model naming patterns as a secondary indicator
                    if any(pattern in model_name_lower for pattern in ["embedding", "sentence", "retrieval", "encode"]):
                        return "EMBEDDING"

            # 5. Check README.md for model description
            readme_path = model_dir / "README.md"
            if readme_path.exists():
                try:
                    with open(readme_path, encoding="utf-8") as f:
                        readme_content = f.read().lower()

                    # Look for embedding-specific keywords in README
                    if any(
                        phrase in readme_content
                        for phrase in [
                            "sentence embedding",
                            "text embedding",
                            "semantic similarity",
                            "sentence-transformers",
                            "embedding model",
                            "retrieval",
                        ]
                    ):
                        return "EMBEDDING"

                    # Look for other model types
                    if any(phrase in readme_content for phrase in ["vision", "image", "computer vision", "clip"]):
                        return "VISION"

                    if any(phrase in readme_content for phrase in ["speech", "audio", "whisper", "wav2vec"]):
                        return "AUDIO"

                except (FileNotFoundError, UnicodeDecodeError) as e:
                    logger.debug("Could not read README.md for %s: %s", model_dir, e)

            # 6. Fallback: Check model name patterns (only as last resort)
            model_name_lower = model_name.lower()
            if any(
                pattern in model_name_lower
                for pattern in [
                    "all-minilm",
                    "all-mpnet",
                    "all-distilroberta",
                    "bge-",
                    "gte-",
                    "e5-",
                ]
            ):
                logger.info("Using name pattern fallback for embedding detection: %s", model_name)
                return "EMBEDDING"

            return "NORMAL"

        except Exception as e:
            logger.error("Error detecting model type for %s: %s", model_name, e)
            return "NORMAL"

    async def get_featured_models(
        self,
        search: str | None = None,
        min_parameters: int | None = None,
        max_parameters: int | None = None,
        force_cpu_models: bool | None = False,
    ) -> list[dict[str, Any]]:
        """Get featured models from Hugging Face that can be installed"""
        # Detect if a system is CPU-only by checking system capabilities
        try:
            system_capabilities = await self.get_system_capabilities()
            # If no GPU is detected, it's a CPU-only system
            is_cpu_system = not system_capabilities.get("has_gpu", False)
            logger.info("System has GPU: %s", not is_cpu_system)
        except Exception as e:
            logger.error("Error detecting system capabilities: %s", str(e))
            # Default to CPU-friendly models if we can't detect system capabilities
            is_cpu_system = True

        # Force CPU models if requested
        if force_cpu_models:
            is_cpu_system = True
            logger.info("Forcing CPU - friendly models as requested")

        # Set a parameter range based on system capabilities
        min_param_value = min_parameters
        max_param_value = max_parameters

        # For CPU-only systems, set the parameter range to 0-3B if not explicitly specified
        if is_cpu_system and min_parameters is None and max_parameters is None:
            logger.info("CPU - only system detected, using smaller parameter range (0 - 3B)")
            min_param_value = 0
            max_param_value = 3
        # For GPU systems, set the parameter range to 8-33B if not explicitly specified
        elif not is_cpu_system and min_parameters is None and max_parameters is None:
            logger.info("GPU system detected, using larger parameter range (8 - 33B)")
            min_param_value = 8
            max_param_value = 33

        # Get featured models from API - always returns exactly 9 models
        # noinspection PyTypeChecker
        models = await self._fetch_featured_models_from_huggingface(search, min_param_value, max_param_value)

        # Update compatibility scores for each model
        if is_cpu_system:
            for model in models:
                # Extract parameter size as a number
                param_str = str(model.get("parameters", "0B") or "0B")
                param_size = extract_parameter_size(param_str.lower())

                # For CPU systems, smaller models get higher scores
                if param_size is not None:
                    # CPU systems favor small models (1-3B)
                    if param_size <= 3:
                        model["compatibility_score"] = 0.9 + (3 - param_size) * 0.03  # 0.9 to 1.0
                    else:
                        # Larger models get progressively lower scores
                        model["compatibility_score"] = max(0.1, 0.9 - (param_size - 3) * 0.1)  # 0.9 down to 0.1
        else:
            # For GPU systems, mid-range to larger models get higher scores
            for model in models:
                # Extract parameter size as a number
                param_str = str(model.get("parameters", "0B") or "0B")
                param_size = extract_parameter_size(param_str.lower())

                if param_size is not None:
                    # GPU systems favor larger models (7-33B)
                    if 7 <= param_size <= 33:
                        model["compatibility_score"] = min(1.0, 0.7 + (param_size / 70))  # 0.8 to 1.0
                    else:
                        # Smaller models get lower scores but are still usable
                        model["compatibility_score"] = max(0.5, 0.7 - (7 - param_size) * 0.05)  # 0.7 down to 0.5

        return models

    @staticmethod
    def _process_model_info(model, min_params=None, max_params=None) -> dict[str, Any] | None:
        """Process a model from API results to extract metadata."""
        # Handle both ModelInfo objects and dictionaries
        try:
            # Try to access as ModelInfo object first
            if hasattr(model, "id"):
                model_id = model.id
                model_name = model_id  # For ModelInfo, the id IS the model name/repo ID
                card_data = getattr(model, "card_data", None) or getattr(model, "cardData", None)
                downloads = getattr(model, "downloads", 0)
                likes = getattr(model, "likes", 0)
                tags = getattr(model, "tags", [])
            else:
                # Fallback to dictionary access
                model_id = model.get("id")
                model_name = model.get("name") or model_id  # Dictionary might have 'name'
                card_data = model.get("cardData") or model.get("card_data")
                downloads = model.get("downloads", 0)
                likes = model.get("likes", 0)
                tags = model.get("tags", [])

            # Skip models with missing IDs
            if not model_id and not model_name:
                return None

            if not model_name:
                return None

            # Extract parameter size from model name first, then description as fallback
            param_size = extract_parameter_size(model_name)

            # If not found in model name, try description
            if param_size is None:
                description = ""
                if card_data:
                    if hasattr(card_data, "get"):
                        description = card_data.get("description", "")
                    else:
                        description = getattr(card_data, "description", "")
                param_size = extract_parameter_size(description)

            # If still no parameter size found, use pattern-based fallback
            if param_size is None:
                logger.debug(
                    "Parameter size not found in name/description for %s, using pattern fallback",
                    model_name,
                )
                model_name_lower = model_name.lower()
                if any(x in model_name_lower for x in ["small", "mini", "1b", "2b"]):
                    param_size = 1.0
                elif any(x in model_name_lower for x in ["3b", "4b"]):
                    param_size = 3.0
                elif any(x in model_name_lower for x in ["7b", "8b"]):
                    param_size = 7.0
                elif any(x in model_name_lower for x in ["13b", "14b"]):
                    param_size = 13.0
                else:
                    # Default to 7B for unknown models to avoid filtering them out
                    param_size = 7.0
                    logger.debug(
                        "Could not determine parameter size for %s, defaulting to 7B",
                        model_name,
                    )

            # Filter by parameter size
            if min_params is not None and param_size < min_params:
                logger.debug("Skipping %s: %sB < %sB (min)", model_name, param_size, min_params)
                return None

            if max_params is not None and param_size > max_params:
                logger.debug("Skipping %s: %sB > %sB (max)", model_name, param_size, max_params)
                return None

            # Calculate score based on downloads/likes (already extracted above)
            score = 80  # Default base score

            # Get description from card_data if available
            description = f"Model from {model_name}"
            if card_data:
                if hasattr(card_data, "get"):
                    # Dictionary-style access
                    description = card_data.get("description", f"Model from {model_name}")
                else:
                    # Attribute access for ModelCardData object
                    description = getattr(card_data, "description", f"Model from {model_name}")

            # Apply scoring based on popularity metrics
            if downloads:
                score += min(10, int(downloads / 10000))  # Max +10 for downloads
            if likes:
                score += min(10, int(likes / 100))  # Max +10 for likes

            # Use the clean_tags function for consistent tag cleaning
            tags = clean_tags(tags[:3] if tags else [])

            # Return the processed model with basic metadata
            return {
                "id": model_name.lower().replace("-", "_"),
                "name": model_name,
                "description": (description[:100] if description else f"Model from {model_name}"),
                "parameters": f"{param_size}B",
                "tags": tags,
                "downloads": downloads,
                "likes": likes,
                "trust_score": score,
            }
        except Exception as e:
            logger.error("Error processing model info: %s", e)
            return None

    async def _fetch_featured_models_from_huggingface(self, search=None, min_params=None, max_params=None) -> list[dict[str, Any]]:
        """
        Fetch featured models from HuggingFace API based on search criteria and parameter sizes.
        Uses incremental pagination to efficiently find exactly nine valid models without over-fetching.
        """
        # We always want to return exactly 9 models (UI design constraint)

        max_models = 9

        try:
            # Import huggingface_hub here to avoid making it a global dependency
            from huggingface_hub import HfApi

            # Get token from settings
            hf_token = resolved_secrets.get("huggingface_token")

            # Log token status (not the actual token)
            if hf_token:
                logger.info("Using Hugging Face API with authentication")
            else:
                logger.info("Using Hugging Face API without authentication (anonymous mode)")

            # Create an API client with token if available
            api = HfApi(token=hf_token)

            # Check if this looks like an embedding model search
            embedding_keywords = [
                "embed",
                "embedding",
                "bge",
                "e5",
                "sentence-transformer",
            ]
            # noinspection PyTypeChecker
            is_embedding_search = search and any(keyword in search.lower() for keyword in embedding_keywords)

            if is_embedding_search:
                logger.warning(
                    "Detected embedding model search in featured models: '%s'. This section is for chat/reasoning models only.",
                    search,
                )
                # Return informative placeholder models instead of random fallback
                return [
                    {
                        "id": f"embedding_search_info_{i}",
                        "name": "Embedding Model Search Detected",
                        "description": f"You searched for '{search}' which appears to be an embedding model. "
                        "Embedding models are configured in the embedding provider settings, not here. "
                        "This section is for chat and reasoning models only.",
                        "parameters": "N/A",
                        "format": "info",
                        "from_api": False,
                        "is_fallback": True,
                        "status": "info",
                        "score": 0,
                        "tags": ["info", "embedding-search"],
                    }
                    for i in range(max_models)
                ]

            # Incremental search strategy
            all_models = []
            existing_ids = set()

            # Define search strategies with different batch sizes
            search_strategies = []

            if search:
                # Explicit user query: search ONLY for what was asked. The old
                # flow appended backup strategies ("gguf small", "gguf 1b", …)
                # whose fallback results outscored and buried the actual query
                # matches — searching "qwen" returned generic CPU models. The
                # filter="gguf" tag already restricts results to GGUF repos,
                # and the parameter range is not enforced for explicit
                # searches (the compatibility score communicates fit instead).
                search_strategies.append(("primary", search.strip(), 30))
                min_params = None
                max_params = None
            else:
                # Browse mode: curated mix sized to the machine.
                first_query = "gguf"
                search_strategies.append(("primary", first_query, 20))

            # Backup searches based on parameter size (browse mode only)
            backup_searches = []
            if search:
                pass
            elif min_params is not None and min_params >= 8:
                # For larger models (GPU)
                backup_searches = [
                    "gguf llama",
                    "gguf phi",
                    "gguf qwen",
                ]
            else:
                # For smaller models (CPU)
                backup_searches = ["gguf small", "gguf 1b", "gguf 3b", "gguf gemma"]

            if not search:
                for backup_query in backup_searches:
                    search_strategies.append(("backup", backup_query, 15))

                # Generic fallback
                search_strategies.append(("generic", "gguf", 10))

            # Execute search strategies incrementally
            for strategy_type, query, batch_size in search_strategies:
                if len(all_models) >= max_models:
                    break

                logger.info("%s search: %s", strategy_type.capitalize(), query)

                try:
                    # Calculate how many more models we need
                    models_needed = max_models - len(all_models)

                    # Use smaller batch sizes for more efficient API usage
                    # Get 3x what we need to account for filtering
                    current_batch_size = min(batch_size, models_needed * 3)

                    results = api.list_models(
                        filter="gguf",
                        search=query,
                        limit=current_batch_size,
                        cardData=True,
                    )

                    # Process results incrementally
                    valid_models_found = 0
                    for model in results:
                        if len(all_models) >= max_models:
                            break

                        # Apply parameter filtering during processing
                        if strategy_type == "generic":
                            # For generic search, be more lenient with parameter filtering
                            processed = self._process_model_info(model, None, None)
                        else:
                            processed = self._process_model_info(model, min_params, max_params)

                        if processed and processed["id"] not in existing_ids:
                            if strategy_type != "primary":
                                processed["is_fallback"] = True

                            all_models.append(processed)
                            existing_ids.add(processed["id"])
                            valid_models_found += 1

                    logger.info(
                        "%s search found %s valid models (total: %s)",
                        strategy_type.capitalize(),
                        valid_models_found,
                        len(all_models),
                    )

                    # If we got enough models from this strategy, we can stop
                    if len(all_models) >= max_models:
                        break

                except Exception as e:
                    logger.error("Error in %s search: %s", strategy_type, str(e))
                    continue

            # Sort models by score (descending)
            all_models.sort(key=lambda x: x.get("score", 0), reverse=True)

            # Apply improved tag cleaning to ALL models
            for model in all_models:
                if "tags" in model:
                    model["tags"] = clean_tags(model["tags"])

            # Browse mode pads to exactly nine; an explicit search returns the
            # honest match count instead of padding with unrelated fallbacks.
            result = all_models[:max_models] if search else self._ensure_exactly_nine_models(all_models)

            logger.info("Returning exactly %s models from HuggingFace API", len(result))
            return result

        except Exception as e:
            logger.error("Error fetching models from Hugging Face API: %s", str(e))
            logger.error("This is likely due to missing huggingface_token in secrets.yaml or network connectivity issues")
            logger.error("To fix: Add 'huggingface_token: your_token_here' to secrets.yaml")
            logger.error("Get a free token at: https://huggingface.co/settings/tokens")
            return []

    @staticmethod
    def _ensure_exactly_nine_models(models: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Ensure we have exactly nine models with unique IDs."""
        # noinspection PyPep8Naming
        EXACT_COUNT = 9

        def fix_duplicate_ids(m: list[dict[str, Any]]) -> list[dict[str, Any]]:
            """Fix duplicate IDs by appending a timestamp."""
            ids_seen = set()
            for i, model in enumerate(m):
                if model["id"] in ids_seen:
                    # Add timestamp to make ID unique
                    m[i]["id"] = f"{model['id']}_{int(time.time() * 1000) + i}"
                ids_seen.add(m[i]["id"])
            return m

        if len(models) == EXACT_COUNT:
            # Check for duplicate IDs and fix them if found
            return fix_duplicate_ids(models)

        if len(models) > EXACT_COUNT:
            # Take the top 9 models by score
            top_models = sorted(models, key=lambda x: x.get("score", 0), reverse=True)[:EXACT_COUNT]
            # Check for duplicate IDs
            return fix_duplicate_ids(top_models)

        # We need to add more models to reach EXACT_COUNT
        result = models.copy()
        existing_ids = {model["id"] for model in result}

        # If we have no models at all, create placeholders
        if not models:
            return [
                {
                    "id": f"placeholder_{i}_{int(time.time() * 1000)}",
                    "name": f"Model {i + 1}",
                    "description": "No models found matching your criteria",
                    "parameters": "Unknown",
                    "format": "gguf",  # Default format for placeholder models
                    "from_api": False,
                    "is_fallback": True,
                    "status": "unavailable",
                    "score": 0,
                    "tags": [],
                }
                for i in range(EXACT_COUNT)
            ]

        # Otherwise, create variations with guaranteed unique IDs
        source_models = models.copy()
        while len(result) < EXACT_COUNT:
            model_idx = (len(result) - len(models)) % len(source_models)
            base_model = source_models[model_idx]

            # Create a unique ID using millisecond timestamp
            timestamp_ms = int(time.time() * 1000) + len(result)
            unique_id = f"{base_model['id']}_{timestamp_ms}"

            # Double-check that the ID is truly unique
            while unique_id in existing_ids:
                timestamp_ms += 1
                unique_id = f"{base_model['id']}_{timestamp_ms}"

            existing_ids.add(unique_id)

            # Create variant with unique ID
            variant = {
                **base_model,
                "id": unique_id,
                "name": f"{base_model['name']} (Alt {len(result) - len(models) + 1})",
                "score": max(0, base_model.get("score", 80) - (len(result) - len(models)) * 2),
            }

            result.append(variant)

        return result

    @staticmethod
    async def get_service_status() -> dict[str, Any]:
        """Get the status of the local LLM service"""
        try:
            # Get the models directory from configuration
            models_directory = os.path.abspath(resolved_config.get("llm", {}).get("models_directory", "./models"))

            # Check if the service is running
            llm_host = resolved_config.get("llm", {}).get("host", "localhost")
            llm_port = resolved_config.get("llm", {}).get("port", 8090)
            # noinspection HttpUrlsUsage
            service_endpoint = f"http://{llm_host}:{llm_port}"
            service_version = "1.0.0"  # This should be dynamically determined

            # Try to ping the service (suppress httpcore debug logs for expected connection failures)
            # noinspection PyBroadException
            try:
                import logging

                httpcore_logger = logging.getLogger("httpcore.connection")
                prev_level = httpcore_logger.level
                httpcore_logger.setLevel(logging.WARNING)
                try:
                    async with httpx.AsyncClient() as client:
                        service_running = (await client.get(f"{service_endpoint}/health", timeout=2.0)).status_code == 200
                finally:
                    httpcore_logger.setLevel(prev_level)
            except Exception:
                service_running = False

            return {
                "running": service_running,
                "api_base": service_endpoint,
                "version": service_version,
                "models_directory": models_directory,
            }
        except Exception as e:
            logger.error("Failed to get service status: %s", str(e))
            return {
                "running": False,
                "api_base": "unknown",
                "version": "unknown",
                "models_directory": "./models",
                "error": str(e),
            }

    @staticmethod
    async def get_gpu_status(model_name: str | None = None) -> dict[str, Any]:
        """
        Get current GPU status and memory usage.

        Args:
            model_name: Optional ID of a specific model to check

        Returns:
            Dictionary with GPU status information
        """
        try:
            # Add timeout protection for GPU detection
            import asyncio

            def _get_gpu_info():
                # Use the same GPU detection logic as LLMManager
                from src.main.utils.gpu.devices import (
                    get_all_gpus,
                    get_device_type,
                    get_system_capabilities,
                    is_gpu_available,
                )

                return get_all_gpus(), get_device_type(), get_system_capabilities(), is_gpu_available()

            try:
                # Set an 8-second timeout for GPU detection to prevent API timeout
                all_gpus, device_type, system_capabilities, gpu_available = await asyncio.wait_for(asyncio.to_thread(_get_gpu_info), timeout=8.0)
            except TimeoutError:
                logger.warning("GPU detection timed out after 8 seconds, returning cached/minimal info")
                return {
                    "is_available": False,
                    "message": "GPU detection timed out - system may be under heavy load",
                    "devices": [],
                    "timeout": True,
                }

            # Check if any GPU is available (CUDA, OpenCL, etc.)
            if not gpu_available:
                return {
                    "is_available": False,
                    "message": "No GPU available on this system",
                    "devices": [],
                }

            # Convert GPU information to the expected format
            devices = []
            for i, gpu in enumerate(all_gpus):
                device_info = {
                    "index": i,
                    "name": gpu.get("name", "Unknown GPU"),
                    "vendor": gpu.get("vendor", "Unknown"),
                    "total_memory_mb": gpu.get("total_memory_mb", 0),
                    "free_memory_mb": gpu.get("free_memory_mb", 0),
                    "used_memory_mb": gpu.get("used_memory_mb", 0),
                    "detection_method": gpu.get("detection_method", "unknown"),
                    "device_type": device_type,
                }

                # Try to get additional GPU utilization for NVIDIA GPUs
                if gpu.get("vendor") == "NVIDIA":
                    try:
                        import pynvml

                        pynvml.nvmlInit()
                        handle = pynvml.nvmlDeviceGetHandleByIndex(i)
                        utilization = pynvml.nvmlDeviceGetUtilizationRates(handle)
                        device_info["utilization"] = {
                            "gpu": utilization.gpu,
                            "memory": utilization.memory,
                        }
                    except (ImportError, Exception) as e:
                        logger.debug("Could not get NVIDIA GPU utilization: %s", str(e))

                devices.append(device_info)

            # Check if a specific model is running on GPU
            model_status = None
            if model_name:
                # This would need to be implemented based on how models are tracked
                # For now we'll just return a placeholder
                model_status = {
                    "is_loaded": False,
                    "device": device_type,
                    "memory_used_mb": 0,
                }

                # Check if the model is loaded in any active processes,
                # This is a simplified check and would need to be expanded
                # based on how models are actually loaded and tracked
                try:
                    # This is a placeholder for actual model tracking logic
                    pass
                except Exception as e:
                    logger.debug("Error checking model status: %s", str(e))

            return {
                "is_available": True,
                "device_count": len(devices),
                "device_type": device_type,
                "devices": devices,
                "system_capabilities": system_capabilities,
                "model_status": model_status if model_name else None,
            }

        except Exception as e:
            logger.error("Error getting GPU status: %s", str(e))
            return {"is_available": False, "error": str(e)}

    async def start_model_on_gpu(self, model_name: str, gpu_layers: int = None, model_path: str = None) -> dict[str, Any]:
        """Start a model on the GPU."""
        # Implementation details...

    @staticmethod
    def _parse_provider_list(provider_list):
        """
        Parse a provider list that might be a string or a list into a proper list.

        Args:
            provider_list: List of providers or string representation

        Returns:
            List of provider types
        """
        # Convert from string to list if needed (in case the env var is provided as a string)
        if isinstance(provider_list, str):
            import json

            try:
                provider_list = json.loads(provider_list)
            except json.JSONDecodeError:
                # If it's not valid JSON, try splitting by comma and removing brackets
                provider_list = [pt.strip() for pt in provider_list.replace("[", "").replace("]", "").split(",")]

        # Ensure we return a proper list
        return list(provider_list) if provider_list else []

    @staticmethod
    def _ensure_dto_compatible_types(data: dict[str, Any]) -> dict[str, Any]:
        """
        Ensure all values in the dictionary are of compatible types for DTOs.
        Specifically, converts UUID objects to strings and ensures all required fields are present.

        Args:
            data: Dictionary with data

        Returns:
            Dictionary with converted values and required fields
        """
        result = {}
        for key, value in data.items():
            if isinstance(value, uuid.UUID):
                result[key] = str(value)
            else:
                result[key] = value

        # Format provider name properly
        provider_type = data.get("provider_type", "")
        provider_name = data.get("provider_name", "")

        # Convert provider_type to proper display name
        if provider_type == "openrouter":
            formatted_provider_name = "OpenRouter"
        elif provider_type == "local":
            formatted_provider_name = "Local AI"
        elif provider_type == "ollama":
            formatted_provider_name = "Ollama"
        elif provider_type == "vllm":
            formatted_provider_name = "vLLM"
        else:
            formatted_provider_name = provider_name or provider_type

        # Format display name to include provider name in parentheses for remote providers
        display_name = data.get("display_name", data.get("name", ""))
        if provider_type in ["openrouter"] and display_name:
            # Only add provider suffix if it's not already there
            # noinspection PyUnresolvedReferences
            if not display_name.endswith(f"({formatted_provider_name})"):
                display_name = f"{display_name} ({formatted_provider_name})"

        # Ensure all required fields for ProviderModelDTO are present
        # Use converted values from result dict to avoid UUID type errors
        required_fields = {
            "id": result.get("id", ""),
            "provider_id": result.get("provider_id", ""),
            "provider_type": provider_type,
            "provider_name": formatted_provider_name,
            "model_name": result.get("model_name", result.get("id", "")),  # API identifier (required, must be string)
            "display_name": display_name,  # Optional - UI can fallback to model_name if missing
            "model_type": data.get("model_type", "NORMAL"),  # Default to NORMAL if not specified
        }

        # Add any missing required fields
        for field, default_value in required_fields.items():
            if field not in result:
                result[field] = default_value

        return result

    @staticmethod
    def _detect_model_type_from_name(model_name: str) -> str:
        """
        Detect a model type based on model name patterns.

        Args:
            model_name: Name of the model to analyze

        Returns:
            Model type: "EMBEDDING" or "NORMAL"
        """
        if not model_name:
            return "NORMAL"

        model_name_lower = model_name.lower()

        # Common embedding model patterns
        embedding_patterns = [
            "embed",
            "embedding",
            "sentence",
            "minilm",
            "e5-",
            "bge-",
            "gte-",
            "instructor",
            "multilingual-e5",
            "nomic-embed",
            "text-embedding",
            "all-minilm",
            "sentence-transformers",
            "intfloat",
            "thenlper",
            "BAAI",
        ]

        # Check if the model name contains embedding patterns
        for pattern in embedding_patterns:
            if pattern in model_name_lower:
                logger.debug("Detected EMBEDDING model: %s (pattern: %s)", model_name, pattern)
                return "EMBEDDING"

        # Default to NORMAL for LLM models
        logger.debug("Detected NORMAL/LLM model: %s", model_name)
        return "NORMAL"

    @staticmethod
    async def _sync_embedding_models_from_disk(db: Session):
        """
        Sync embedding models from disk to database.
        Checks config.yaml for configured models and ensures they're in the database.
        """
        try:
            import os

            from src.main.utils.llm.provider_utils import get_system_provider

            # noinspection PyProtectedMember
            from src.main.utils.models.downloader import (
                _get_embedding_models_from_config,
            )

            # Get configured embedding models from config.yaml
            config_models = _get_embedding_models_from_config()
            if not config_models:
                logger.info("No embedding models configured in config.yaml")
                return

            # Get or create the local provider
            system_provider, _ = get_system_provider(db)
            provider_id = system_provider["id"]

            # Get project root and embeddings directory
            project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(str(__file__))))))
            embeddings_dir = os.path.join(str(project_root), "data", "models", "embeddings", "huggingface")

            logger.info("Checking for embedding models in: %s", embeddings_dir)

            # Check each model from config
            for model_config in config_models:
                folder_name = model_config.get("name")
                repo_id = model_config.get("repo_id")

                if not folder_name or not repo_id:
                    continue

                # Check if model exists on disk (only check top-level directories)
                model_path = os.path.join(embeddings_dir, str(folder_name))
                if not os.path.exists(model_path) or not os.path.isdir(model_path):
                    logger.debug("Model not found on disk: %s", model_path)
                    continue

                # Extract clean display name from repo_id
                display_name = repo_id.split("/")[-1] if "/" in repo_id else repo_id

                # Check if model already exists in database (check both model_name and display_name to avoid duplicates)
                existing_model = db.execute(
                    text("""
                        SELECT id FROM model_provider_models
                        WHERE provider_id = :provider_id
                        AND (model_name = :repo_id OR display_name = :display_name)
                        AND model_type = 'EMBEDDING'
                    """),
                    {
                        "provider_id": provider_id,
                        "repo_id": repo_id,
                        "display_name": display_name,
                    },
                ).fetchone()

                if existing_model:
                    logger.debug("Model already in database: %s", repo_id)
                    continue

                # Get dimensions from config (default values)
                dimensions = 384  # Default for all-MiniLM-L6-v2
                if "e5-large" in repo_id.lower() or "multilingual-e5-large" in repo_id.lower():
                    dimensions = 1024

                # Add model to database
                model_id = str(uuid.uuid4())

                db.execute(
                    text("""
                        INSERT INTO model_provider_models
                        (id, provider_id, model_name, display_name, model_type,
                         dimensions, context_window, created_at, updated_at)
                        VALUES (:id, :provider_id, :model_name, :display_name, :model_type,
                                :dimensions, :context_window, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """),
                    {
                        "id": model_id,
                        "provider_id": provider_id,
                        "model_name": repo_id,
                        "display_name": display_name,
                        "model_type": "EMBEDDING",
                        "dimensions": dimensions,
                        "context_window": 512,
                    },
                )
                db.commit()
                logger.info("Added embedding model to database: %s → %s (dimensions: %s)", repo_id, display_name, dimensions)

        except Exception as e:
            logger.exception("Error syncing embedding models from disk: %s", e)
            db.rollback()

    async def list_embedding_models(self, user_id: str | None = None) -> list[ProviderModelDTO]:
        """Fetch available embedding models from all configured and active providers."""
        db: Session = SessionLocal()
        try:
            # First, sync models from disk to database if needed (with timeout)
            try:
                await asyncio.wait_for(self._sync_embedding_models_from_disk(db), timeout=5.0)
            except TimeoutError:
                logger.warning("Embedding model sync timed out after 5 seconds, using existing database models")

            # Query to select model details and provider information
            # Filters for model_type = 'EMBEDDING', non-null dimensions, and active providers.
            # Config defaults are now stored in the database via Alembic migration 018
            # NOTE: Includes local embedding models but excludes other local provider types (ollama, vllm for LLMs)
            query_str = """
                    SELECT
                        m.id AS model_id,                    -- 0
                        m.provider_id AS provider_id,        -- 1
                        m.model_name AS model_name,          -- 2
                        m.display_name AS display_name,      -- 3
                        m.model_type AS model_type,          -- 4
                        m.model_namespace AS model_namespace,-- 5
                        m.dimensions AS dimensions,          -- 6
                        p.provider_type AS provider_type,    -- 7
                        p.name AS provider_name,             -- 8
                        p.api_base AS provider_api_base,     -- 9
                        p.user_id AS provider_user_id        -- 10
                    FROM
                        model_provider_models m
                    JOIN
                        model_providers p ON m.provider_id = p.id
                    WHERE
                        m.model_type = :model_type
                        AND m.dimensions IS NOT NULL
                        AND (
                            -- Include local embedding models (they have no API key requirement)
                            (p.provider_type = 'local' AND m.model_type = 'EMBEDDING')
                            OR
                            -- Include cloud embedding models with API keys
                            (p.provider_type NOT IN ('local', 'ollama', 'vllm')
                             AND p.api_key IS NOT NULL AND p.api_key != '')
                        )
                """
            params = {"model_type": "EMBEDDING"}

            if user_id:
                # Filter for global providers (user_id IS NULL) or providers specific to the user
                query_str += " AND (p.user_id IS NULL OR p.user_id = :user_id)"
                params["user_id"] = user_id

            query_str += " ORDER BY CASE WHEN p.provider_type = 'local' THEN 0 ELSE 1 END, p.name, m.display_name;"

            result = db.execute(text(query_str), params)
            rows = result.fetchall()

            # Get preferred models from config for hardware optimization detection
            from src.main.utils.config.loader import resolved_config

            preferred_models = resolved_config.get("defaults", {}).get("embedding", {}).get("preferred_models", [])

            embedding_models = []
            for row_data in rows:
                display_name = row_data[3]
                model_name = row_data[2]

                # Determine hardware optimization based on preferred_models order
                # First model in list = GPU optimized, second = CPU optimized
                hardware_optimization = None
                if preferred_models:
                    # Extract the model name part from preferred models (after last slash)
                    # e.g., "intfloat/multilingual-e5-large-instruct" -> "multilingual-e5-large-instruct"
                    for idx, preferred in enumerate(preferred_models):
                        # Get the model name without provider prefix
                        preferred_model_name = preferred.split("/")[-1] if "/" in preferred else preferred

                        # Check if display_name or model_name matches (case-insensitive, exact match)
                        if (display_name and preferred_model_name.lower() == display_name.lower()) or (
                            model_name and preferred_model_name.lower() in model_name.lower()
                        ):
                            hardware_optimization = "gpu" if idx == 0 else "cpu"
                            break

                model_dict = {
                    "id": str(row_data[0]),  # model_id (UUID)
                    "model_name": model_name,  # Actual model name for lookups
                    "name": display_name or model_name,  # display_name or model_name
                    "display_name": display_name,
                    "provider_id": str(row_data[1]),  # provider_id (UUID)
                    "provider_type": row_data[7],
                    "provider_name": row_data[8],
                    "model_type": "EMBEDDING",  # Explicitly set
                    "is_embedding_model": True,
                    "dimensions": row_data[6],
                    "hardware_optimization": hardware_optimization,
                }
                # Ensure all required fields for ProviderModelDTO are present and types are correct
                compatible_data = self._ensure_dto_compatible_types(model_dict)
                embedding_models.append(ProviderModelDTO(**compatible_data))

            logger.info("Returning %s embedding models from database (including config defaults)", len(embedding_models))
            return embedding_models
        except Exception as ex:
            logger.exception("Error fetching embedding models from database: %s", ex)
            return []  # Return an empty list on error to prevent breaking the caller
        finally:
            if db:
                db.close()

    @staticmethod
    async def _discover_active_providers(
        db: Session,
        requested_providers: list[str] | None,
        _strict_filtering: bool,
    ) -> list[str]:
        """Modern provider discovery using functional programming and walrus operator."""

        if not requested_providers:
            # Auto-discover all providers with API keys using a modern query pattern
            query = """
                SELECT DISTINCT provider_type FROM model_providers
                WHERE (api_key IS NOT NULL AND api_key != '' OR provider_type IN ('local', 'ollama', 'vllm'))
                AND status IN ('active', 'enabled')
            """
            if result := db.execute(text(query)):
                discovered = [row[0] for row in result.fetchall()]
                logger.info("🔍 Auto-discovered %s providers with API keys: %s", len(discovered), ", ".join(discovered))
                return discovered
            return []

        # Validate requested providers exist and have API keys
        provider_list = "', '".join(requested_providers)
        validation_query = f"""
            SELECT DISTINCT provider_type
            FROM model_providers
            WHERE (api_key IS NOT NULL AND api_key != '' OR provider_type IN ('local', 'ollama', 'vllm'))
            AND status IN ('active', 'enabled')
            AND provider_type IN ('{provider_list}')
        """

        if result := db.execute(text(validation_query)):
            valid_providers = [row[0] for row in result.fetchall()]

            # Check for providers that exist but are inactive vs. providers that don't exist at all
            if invalid := set(requested_providers) - set(valid_providers):
                # Check which providers exist but are inactive vs. completely missing
                existing_query = f"""
                    SELECT DISTINCT provider_type
                    FROM model_providers
                    WHERE provider_type IN ('{provider_list}')
                """
                existing_result = db.execute(text(existing_query))
                existing_providers = [row[0] for row in existing_result.fetchall()] if existing_result else []

                inactive_providers = set(existing_providers) & invalid
                missing_providers = invalid - set(existing_providers)

                # Only warn about inactive providers, not missing ones (which are just unconfigured)
                if inactive_providers:
                    logger.warning("⚠️ Inactive providers: %s", ", ".join(inactive_providers))
                if missing_providers:
                    logger.debug("🔧 Unconfigured providers (will return empty results): %s", ", ".join(missing_providers))

            return valid_providers

        return []

    @staticmethod
    async def _build_active_models_map(db: Session, providers: list[str], user_id: str | None) -> dict[str, str]:
        """Build active models mapping using modern Python patterns, eliminating get_user_active_providers dependency."""

        active_models = {}

        # Modern query to get all provider IDs for providers with API keys directly
        provider_list = "', '".join(providers)
        provider_query = f"""
            SELECT id, provider_type
            FROM model_providers
            WHERE provider_type IN ('{provider_list}')
            AND (api_key IS NOT NULL AND api_key != '' OR provider_type IN ('local', 'ollama', 'vllm'))
            AND (user_id IS NULL OR user_id = :user_id)
        """

        try:
            if result := db.execute(text(provider_query), {"user_id": user_id}):
                provider_data = result.fetchall()
                logger.info("📋 Found %s active provider instances", len(provider_data))

                # Active model concept removed - no active models map needed
                logger.debug("Active models map not built - active model concept removed")

        except Exception as e:
            logger.error("❌ Failed to build active models map: %s", e)

        return active_models

    @staticmethod
    def _build_query_components(
        providers: list[str],
        strict_filtering: bool,
        user_id: str | None,
        model_type: str | None,
    ) -> tuple[str, str, str]:
        """Build query components using modern string formatting and functional approach."""

        # Provider validation condition using modern approach
        provider_list = "', '".join(providers)

        if strict_filtering:
            provider_condition = f"p.provider_type IN ('{provider_list}')"
        else:
            # Enhanced validation for remote providers with API keys
            provider_condition = """
                (p.provider_type IN ('local', 'ollama', 'vllm')
                 OR (p.provider_type NOT IN ('local', 'ollama', 'vllm')
                     AND p.api_key IS NOT NULL
                     AND TRIM(p.api_key) != ''
                     AND LENGTH(TRIM(p.api_key)) > 0))
            """

        # User filter using walrus operator for concise logic
        user_filter = "AND (p.user_id IS NULL OR p.user_id = :user_id)" if user_id else "AND p.user_id IS NULL" if strict_filtering else ""

        # Model type filter
        model_type_filter = "AND m.model_type = :model_type" if model_type else ""

        return provider_condition, user_filter, model_type_filter

    @staticmethod
    def _should_discover_local_models(strict_filtering: bool, providers: list[str] | None, user_id: str | None) -> bool:
        """Check if we should discover local models from disk using modern boolean logic."""
        return bool(strict_filtering and providers and "local" in providers and len(providers) == 1 and not user_id)

    async def _discover_and_add_local_models(self, db: Session, all_models: list["ProviderModelDTO"]) -> None:
        """Discover and add local models from disk using modern patterns."""
        try:
            from src.main.utils.llm.provider_utils import get_system_provider

            if not (system_provider := get_system_provider(db)[0]):
                return

            # Refresh models database to ensure we have the latest models
            await self.refresh_models_database()

            # Get local models and existing model IDs using functional approach
            local_models = await self.get_installed_models()
            existing_ids = {getattr(model, "id", model.get("id") if isinstance(model, dict) else None) for model in all_models} - {None}

            # Add new local models using list comprehension and filtering
            new_models = [
                ProviderModelDTO.from_dict(
                    self._ensure_dto_compatible_types(
                        {
                            **model,
                            "provider_id": system_provider["id"],
                            "provider_type": "local",
                            "provider_name": "Local AI",
                        }
                    )
                )
                for model in local_models
                if model["id"] not in existing_ids
            ]

            all_models.extend(new_models)
            logger.info("➕ Added %s local models from disk", len(new_models))

        except Exception as e:
            logger.error("❌ Failed to discover local models: %s", e)

    @staticmethod
    def _should_use_fallback(
        providers: list[str] | None,
        all_models: list["ProviderModelDTO"],
        strict_filtering: bool,
    ) -> bool:
        """Check of fallback initialization should be used."""
        return not providers and not all_models and not strict_filtering

    async def _handle_fallback_initialization(self, db: Session, user_id: str | None) -> None:
        """Handle fallback initialization for when no models are found."""
        try:
            await self.initialize_local_models(db, user_id)
            logger.info("🔄 Fallback initialization completed")
        except Exception as e:
            logger.error("❌ Fallback initialization failed: %s", e)

    async def _initialize_and_retry_query(
        self,
        db: Session,
        providers: list[str],
        strict_filtering: bool,
        user_id: str | None,
        model_type: str | None,
        page: int | None,
        limit: int | None,
    ) -> list["ProviderModelDTO"]:
        """Initialize local models and retry the query using modern patterns."""
        try:
            await self.initialize_local_models(db, user_id)
            logger.info("🔄 Local models initialized, retrying query")

            # Rebuild query components for retry
            provider_condition, user_filter, model_type_condition = self._build_query_components(providers, strict_filtering, user_id, model_type)

            # Modern pagination with walrus operator
            pagination_clause = f"LIMIT {limit} OFFSET {(page - 1) * limit}" if (page and limit) else ""

            # Modern retry query construction
            retry_query = f"""
                SELECT
                    m.id, m.provider_id, m.model_name, m.display_name, m.model_type,
                    m.model_namespace, m.dimensions, p.provider_type, p.name as provider_name,
                    p.status as provider_status
                FROM model_provider_models m
                JOIN model_providers p ON m.provider_id = p.id
                WHERE
                    p.status IN ('active', 'enabled')
                    AND p.show_models = TRUE
                    AND {provider_condition}
                    {user_filter}
                    {model_type_condition}
                ORDER BY
                    CASE WHEN p.provider_type = 'local' THEN 0 ELSE 1 END,
                    m.display_name
                {pagination_clause}
            """

            # Build query parameters
            query_params = {
                **({"user_id": user_id} if user_id else {}),
                **({"model_type": model_type} if model_type else {}),
            }

            # Execute a retry query using modern patterns
            if result := db.execute(text(retry_query), query_params):
                retry_models = [
                    ProviderModelDTO.from_dict(
                        self._ensure_dto_compatible_types(
                            {
                                "id": row[0],
                                "provider_id": row[1],
                                "name": row[2],
                                "display_name": row[3] or row[2],
                                "model_type": row[4],
                                "model_namespace": row[5],
                                "dimensions": row[6],
                                "provider_type": row[7],
                                "provider_name": row[8],
                                "is_embedding_model": row[4] == "EMBEDDING",
                                "is_active": False,
                            }
                        )
                    )
                    for row in result.fetchall()
                ]
                logger.info("Retry query added %s models", len(retry_models))
                return retry_models

            return []

        except Exception as e:
            logger.error("❌ Retry query failed: %s", e)
            return []

    def _sync_local_models_to_database(self, models: list[dict[str, Any]]) -> None:
        """
        Sync all detected local GGUF models to the model_provider_models table.
        This ensures that all local models detected from the filesystem are available
        in the database with provider_type="local".
        """
        from src.main.models.sqlmodel_providers import (
            ModelProvider,
            ModelProviderModel,
        )

        if not models:
            logger.debug("No local models found to sync to database")
            return

        logger.info("Syncing %s local GGUF models to database", len(models))

        with SessionLocal() as db:
            try:
                # Get or create the local provider
                # noinspection PyUnresolvedReferences
                local_provider = (
                    db.query(ModelProvider)
                    .filter(
                        ModelProvider.provider_type == "local",
                        ModelProvider.user_id.is_(None),  # System provider
                    )
                    .first()
                )
                if not local_provider:
                    logger.error("Local provider not found in database - cannot sync local models")
                    return

                synced_count = 0
                for model in models:
                    model_name = model.get("name")
                    if not model_name:
                        continue
                    model_name = str(model_name)

                    try:
                        # Use UPSERT approach to handle race conditions
                        # First try to get the current model to work.
                        existing_model = (
                            db.query(ModelProviderModel)
                            .filter(
                                ModelProviderModel.provider_id == local_provider.id,
                                ModelProviderModel.model_name == model_name,
                            )
                            .first()
                        )

                        model_type = model.get("model_type", "NORMAL")

                        if existing_model:
                            # Update existing model
                            existing_model.display_name = model.get("display_name", model_name)
                            existing_model.model_type = model_type

                            # Fix namespace for existing embedding models
                            if model_type == "EMBEDDING":
                                if model_name == "all-MiniLM-L6-v2" or "sentence-transformers" in model_name:
                                    existing_model.model_namespace = "sentence-transformers"
                                elif model_name.startswith("intfloat/") or model_name.startswith("nomic-ai/"):
                                    existing_model.model_namespace = model_name.split("/")[0] if "/" in model_name else "local"
                                else:
                                    existing_model.model_namespace = "local"
                                existing_model.dimensions = self._get_embedding_dimensions(model_name)
                            else:
                                existing_model.model_namespace = "local"
                            logger.debug(
                                "Updated existing local model: %s (type: %s, namespace: %s)", model_name, model_type, existing_model.model_namespace
                            )
                        else:
                            # Determine correct namespace based on model name and type
                            if model_type == "EMBEDDING":
                                # For embedding models, use appropriate namespace
                                if model_name == "all-MiniLM-L6-v2" or "sentence-transformers" in model_name:
                                    model_namespace = "sentence-transformers"
                                elif model_name.startswith("intfloat/") or model_name.startswith("nomic-ai/"):
                                    # Keep the existing namespace for models that already have one
                                    model_namespace = model_name.split("/")[0] if "/" in model_name else "local"
                                else:
                                    model_namespace = "local"
                            else:
                                # For LLM models, use local namespace
                                model_namespace = "local"

                            # Create new model entry
                            new_model_data = {
                                "provider_id": local_provider.id,
                                "model_name": model_name,
                                "display_name": model.get("display_name", model_name),
                                "model_type": model_type,
                                "model_namespace": model_namespace,
                            }

                            # Add dimensions only for embedding models
                            if model_type == "EMBEDDING":
                                new_model_data["dimensions"] = self._get_embedding_dimensions(model_name)

                            new_model = ModelProviderModel(**new_model_data)
                            db.add(new_model)
                            logger.info("Added new local model to database: %s (type: %s)", model_name, model_type)

                        # Commit each model individually to avoid race conditions
                        db.commit()
                        synced_count += 1

                    except Exception as model_error:
                        # Handle individual model sync errors (like unique constraint violations)
                        if "duplicate key value violates unique constraint" in str(model_error):
                            logger.debug("Model %s already exists (race condition), skipping", model_name)
                            db.rollback()
                            # Try to update the existing model instead
                            try:
                                existing_model = (
                                    db.query(ModelProviderModel)
                                    .filter(
                                        ModelProviderModel.provider_id == local_provider.id,
                                        ModelProviderModel.model_name == model_name,
                                    )
                                    .first()
                                )
                                if existing_model:
                                    existing_model.display_name = model.get("display_name", model_name)
                                    existing_model.model_type = model.get("model_type", "NORMAL")
                                    if existing_model.model_type == "EMBEDDING":
                                        existing_model.dimensions = self._get_embedding_dimensions(model_name)
                                    db.commit()
                                    synced_count += 1
                                    logger.debug("Updated existing local model after race condition: %s", model_name)
                            except Exception as update_error:
                                logger.warning("Failed to update model %s after race condition: %s", model_name, update_error)
                                db.rollback()
                        else:
                            logger.error("Error syncing model %s: %s", model_name, model_error)
                            db.rollback()

                logger.info("Successfully synced %s local models to database", synced_count)

            except Exception as e:
                logger.exception("Error syncing local models to database: %s", e)
                db.rollback()

    @staticmethod
    def _get_embedding_dimensions(model_name: str) -> int:
        """
        Get the embedding dimensions for a model based on its name.
        Uses configuration from config.yaml instead of hardcoded values.
        """
        from src.main.utils.config.loader import resolved_config

        # Get embedding config from config.yaml
        embedding_config = resolved_config.get("defaults", {}).get("embedding", {})

        # Get model-specific dimensions from config
        model_dimensions = embedding_config.get("model_dimensions", {})

        # Check if we have specific dimensions configured for this model
        model_name_lower = model_name.lower()
        for config_model_name, dimensions in model_dimensions.items():
            config_model_lower = config_model_name.lower()
            if config_model_lower in model_name_lower or model_name_lower in config_model_lower:
                return dimensions

        # Default dimensions from config
        return embedding_config.get("embedding_dimensions", 384)


# Initialize the service instance
llm_inference_service = LLMInferenceService()
