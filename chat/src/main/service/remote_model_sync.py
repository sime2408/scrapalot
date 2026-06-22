"""
Remote model synchronization service for fetching models from various AI providers.
"""

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime
import traceback
from typing import Any
from urllib.parse import urljoin

import aiohttp
from sqlalchemy.orm import Session

from src.main.models.sqlmodel_providers import ModelProvider, ModelProviderModel
from src.main.utils.core.logger import get_logger
from src.main.utils.http.fetchers import fetch_ollama_models_api, fetch_ollama_version, fetch_vllm_models_api
from src.main.utils.llm.model_name_utils import normalize_model_display_name

logger = get_logger(__name__)

# Import API fetching utilities to avoid circular imports

# Import model name normalization utility to avoid circular imports


def get_default_api_base(provider_type: str) -> str | None:
    """
    Get the default API base URL for a given provider type.

    Args:
        provider_type: The type of the provider (e.g., 'deepseek', 'openai', etc.)

    Returns:
        The default API base URL for the provider type, or None if not found
    """
    default_api_bases = {
        "deepseek": "https://api.deepseek.com",
        "openai": "https://api.openai.com/v1",
        "anthropic": "https://api.anthropic.com",
        "google": "https://generativelanguage.googleapis.com/v1beta",
        "openrouter": "https://openrouter.ai/api/v1",
        "lmstudio": "http://localhost:1234/v1",
        "ollama": "http://localhost:11434",
        "vllm": "http://localhost:8000/v1",
    }

    return default_api_bases.get(provider_type.lower())


def detect_model_provider_icon(model_name: str, provider_type: str) -> str:
    """Detect the actual model provider icon from model name for OpenRouter models."""
    if not model_name:
        return f"/providers/{provider_type.lower()}.svg"

    name_lower = model_name.lower()

    # For OpenRouter, detect the actual model provider from the model name
    if provider_type.lower() == "openrouter":
        # Claude models (Anthropic) - case-insensitive like matching
        if "claude" in name_lower:
            return "/providers/anthropic.svg"

        # GPT models (OpenAI) - case-insensitive like matching
        if any(pattern in name_lower for pattern in ["gpt", "o1-", "o3-", "chatgpt"]):
            return "/providers/openai.svg"

        # Gemini models (Google) - case-insensitive like matching
        if any(pattern in name_lower for pattern in ["gemini", "gemma", "bard"]):
            return "/providers/google.svg"

        # DeepSeek models - case-insensitive like matching
        if "deepseek" in name_lower:
            return "/providers/deepseek.svg"

        # LM Studio models - case-insensitive like matching
        if any(pattern in name_lower for pattern in ["lmstudio"]):
            return "/providers/lmstudio.svg"

        # Meta models - case-insensitive like matching
        if any(pattern in name_lower for pattern in ["llama", "meta", "code-llama"]):
            return "/providers/meta.svg"

        # Microsoft models - case-insensitive like matching
        if any(pattern in name_lower for pattern in ["phi", "microsoft"]):
            return "/providers/microsoft.svg"

        # Alibaba models - case-insensitive like matching
        if any(pattern in name_lower for pattern in ["qwen", "alibaba"]):
            return "/providers/alibaba.svg"

        # Perplexity models - case-insensitive like matching
        if any(pattern in name_lower for pattern in ["perplexity", "pplx"]):
            return "/providers/perplexity.svg"

    # Default to provider type icon
    return f"/providers/{provider_type.lower()}.svg"


class RemoteModelSyncService:
    """Service for synchronizing models from remote AI providers."""

    def __init__(self, session_timeout: int = 30):
        """
        Initialize the remote model sync service.

        Args:
            session_timeout: Timeout for HTTP sessions in seconds
        """
        self.session_timeout = session_timeout
        # Create connector with minimal settings to avoid aiohttp version conflicts
        self.connector = None
        # Use legacy connector settings to avoid eager_start parameter issues
        self.connector_kwargs = {
            "limit": 100,
            "limit_per_host": 30,
            "ttl_dns_cache": 300,
            "use_dns_cache": True,
        }

    @staticmethod
    def _validate_api_key(api_key: str | None, provider_name: str) -> tuple[bool, str]:
        """Validate API key for a provider.

        Args:
            api_key: The API key to validate
            provider_name: Name of the provider for error messages

        Returns:
            Tuple of (is_valid, error_message)
        """
        if not api_key:
            return False, f"{provider_name} API key is required"
        return True, ""

    @staticmethod
    def _build_openai_compatible_url(api_base: str, endpoint: str = "models") -> str:
        """Build URL for OpenAI-compatible APIs.

        Args:
            api_base: Base API URL
            endpoint: API endpoint (default: "models")

        Returns:
            Complete API URL
        """
        # Fix URL construction - urljoin drops the /v1 part when joining with /models
        # Ensure we have the correct endpoint: https://api.openai.com/v1/models
        if api_base.endswith("/v1"):
            url = f"{api_base}/{endpoint}"
        else:
            url = urljoin(api_base, f"/v1/{endpoint}")
        return url

    @staticmethod
    def _create_bearer_headers(api_key: str) -> dict[str, str]:
        """Create authorization headers with Bearer token.

        Args:
            api_key: API key for authorization

        Returns:
            Headers dictionary
        """
        return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    def _prepare_openai_request(self, api_key: str | None, api_base: str | None) -> tuple[bool, str, str, dict[str, str]]:
        """Prepare OpenAI API request with validation, URL, and headers.

        Args:
            api_key: OpenAI API key
            api_base: Optional API base URL

        Returns:
            Tuple of (is_valid, error_message, url, headers)
        """
        # Validate API key
        is_valid, error_msg = self._validate_api_key(api_key, "OpenAI")
        if not is_valid:
            return False, error_msg, "", {}

        if not api_base:
            api_base = get_default_api_base("openai")
        api_base = api_base or "https://api.openai.com"

        # Build URL and headers using helper methods
        # noinspection PyTypeChecker
        url = self._build_openai_compatible_url(api_base)
        headers = self._create_bearer_headers(api_key or "")

        logger.info("OpenAI API URL constructed: %s", url)

        return True, "", url, headers

    async def close(self):
        """Close the HTTP connector to clean up resources."""
        if hasattr(self, "connector") and self.connector:
            await self.connector.close()

    async def _create_http_session(self) -> aiohttp.ClientSession:
        """Create a reusable HTTP session with standard configuration."""
        timeout = aiohttp.ClientTimeout(total=self.session_timeout)
        connector = aiohttp.TCPConnector(**self.connector_kwargs)
        return aiohttp.ClientSession(timeout=timeout, connector=connector)

    @staticmethod
    def _apply_client_side_pagination(items: list[Any], limit: int | None = None, offset: int | None = None, provider_name: str = "API") -> list[Any]:
        """Apply client-side pagination to a list of items."""
        if offset is not None and offset > 0:
            start_idx = offset
            end_idx = start_idx + (limit or len(items))
            paginated_items = items[start_idx:end_idx]
            logger.info(
                "%s client-side pagination: showing %s items from offset %s",
                provider_name,
                len(paginated_items),
                offset,
            )
            return paginated_items
        else:
            return items[:limit] if limit else items

    @staticmethod
    def _classify_modality_capabilities(model_name: str) -> dict[str, bool]:
        """Auto-classify image / audio / realtime capability flags from a model name.

        Pattern-based, applied at sync time so the chat layer can gate UI affordances
        (the "Generate Image" button, voice mode toggle, ...) without an out-of-band
        admin step.
        """
        n = model_name.lower()
        return {
            "supports_image_generation": (n.startswith(("dall-e", "dalle", "gpt-image", "flux", "stable-diffusion", "sd-", "sdxl")) or "imagen" in n),
            # OpenAI Realtime models cover both directions; match before audio so
            # they get the realtime flag in addition to audio_in/out below.
            "supports_realtime": "realtime" in n,
            "supports_audio_input": (n.startswith(("whisper",)) or "audio" in n or "transcribe" in n or "realtime" in n),
            "supports_audio_output": (n.startswith(("tts",)) or "audio" in n or "-tts" in n or "realtime" in n),
        }

    def _get_model_metadata_by_provider(self, model_name: str, provider_type: str) -> dict[str, Any]:
        """Get model metadata (context length, costs, capabilities) by provider."""
        provider_type_lower = provider_type.lower()
        modality = self._classify_modality_capabilities(model_name)

        if provider_type_lower == "openai":
            return {
                "model_type": self._determine_openai_model_type(model_name),
                "context_length": self._get_openai_context_length(model_name),
                "input_cost": self._get_openai_input_cost(model_name),
                "output_cost": self._get_openai_output_cost(model_name),
                "supports_tools": self._openai_supports_tools(model_name),
                "supports_vision": self._openai_supports_vision(model_name),
                **modality,
            }
        elif provider_type_lower == "google":
            return {
                "model_type": "NORMAL",
                "context_length": self._get_google_context_length(model_name),
                "input_cost": self._get_google_input_cost(model_name),
                "output_cost": self._get_google_output_cost(model_name),
                "supports_tools": True,
                "supports_vision": "vision" in model_name.lower(),
                **modality,
            }
        elif provider_type_lower == "deepseek":
            return {
                "model_type": self._determine_deepseek_model_type(model_name),
                "context_length": self._get_deepseek_context_length(model_name),
                "input_cost": self._get_deepseek_input_cost(model_name),
                "output_cost": self._get_deepseek_output_cost(model_name),
                "supports_tools": self._deepseek_supports_tools(model_name),
                "supports_vision": self._deepseek_supports_vision(model_name),
                **modality,
            }
        elif provider_type_lower == "ollama":
            return {
                "model_type": self._determine_ollama_model_type(model_name),
                "context_length": self._get_ollama_context_length(model_name),
                "input_cost": 0.0,  # Ollama is typically free/local
                "output_cost": 0.0,
                "supports_tools": self._ollama_supports_tools(model_name),
                "supports_vision": self._ollama_supports_vision(model_name),
                **modality,
            }
        elif provider_type_lower == "vllm":
            return {
                "model_type": self._determine_vllm_model_type(model_name),
                "context_length": self._get_vllm_context_length(model_name),
                "input_cost": 0.0,  # vLLM is typically self-hosted
                "output_cost": 0.0,
                "supports_tools": self._vllm_supports_tools(model_name),
                "supports_vision": self._vllm_supports_vision(model_name),
                **modality,
            }
        elif provider_type_lower == "anthropic":
            return {
                "model_type": "NORMAL",
                "context_length": self._get_anthropic_context_length(model_name),
                "input_cost": self._get_anthropic_input_cost(model_name),
                "output_cost": self._get_anthropic_output_cost(model_name),
                "supports_tools": True,
                "supports_vision": True,
                **modality,
            }
        elif provider_type_lower == "lmstudio":
            return {
                "model_type": "NORMAL",
                "context_length": 4096,  # LMStudio depends on loaded model, conservative default
                "input_cost": 0.0,
                "output_cost": 0.0,
                "supports_tools": False,
                "supports_vision": False,
                **modality,
            }
        elif provider_type_lower == "openrouter":
            # OpenRouter metadata comes from API response, not hardcoded maps.
            # This branch is a fallback when _get_model_metadata_by_provider is
            # called outside the normal OpenRouter fetch flow.
            return {
                "model_type": "NORMAL",
                "context_length": 4096,
                "input_cost": 0.0,
                "output_cost": 0.0,
                "supports_tools": False,
                "supports_vision": False,
                **modality,
            }
        else:
            # Default metadata
            return {
                "model_type": "NORMAL",
                "context_length": 4096,
                "input_cost": 0.0,
                "output_cost": 0.0,
                "supports_tools": False,
                "supports_vision": False,
                **modality,
            }

    @staticmethod
    async def _handle_api_request_with_error_handling(
        session: aiohttp.ClientSession,
        method: str,
        url: str,
        headers: dict[str, str] | None = None,
        json_payload: dict[str, Any] | None = None,
        provider_name: str = "API",
    ) -> tuple[bool, dict[str, Any] | None, str | None]:
        """Handle API request with standardized error handling.

        Returns:
            Tuple of (success, response_data, error_message)
        """
        try:
            if method.upper() == "GET":
                async with session.get(url, headers=headers) as response:
                    response_text = await response.text()
                    logger.info("%s API response status: %s", provider_name, response.status)
                    logger.debug("%s API response body: %s...", provider_name, response_text[:500])

                    if response.status != 200:
                        error_msg = f"{provider_name} API error {response.status}: {response_text}"
                        logger.error(error_msg)
                        return False, None, error_msg

                    try:
                        response_data = await response.json()
                        return True, response_data, None
                    except Exception as json_error:
                        # If we can't parse JSON, try to parse the text we already got
                        # noinspection PyBroadException
                        try:
                            import json

                            response_data = json.loads(response_text)
                            return True, response_data, None
                        except Exception:
                            error_msg = f"{provider_name} API returned invalid JSON: {json_error!s}"
                            logger.error(error_msg)
                            return False, None, error_msg

            elif method.upper() == "POST":
                async with session.post(url, headers=headers, json=json_payload) as response:
                    response_text = await response.text()
                    logger.info("%s API response status: %s", provider_name, response.status)
                    logger.debug("%s API response body: %s...", provider_name, response_text[:500])

                    if response.status not in [200, 400]:  # 400 can be ok for validation
                        error_msg = f"{provider_name} API error {response.status}: {response_text}"
                        logger.error(error_msg)
                        return False, None, error_msg

                    try:
                        response_data = await response.json()
                        # Even if the status is 400, log it as a warning since it might contain error details
                        if response.status == 400:
                            logger.warning("%s API returned 400 status with response: %s", provider_name, response_data)
                        return True, response_data, None
                    except Exception as json_error:
                        # If we can't parse JSON, try to parse the text we already got
                        # noinspection PyBroadException
                        try:
                            import json

                            response_data = json.loads(response_text)
                            if response.status == 400:
                                logger.warning("%s API returned 400 status with response: %s", provider_name, response_data)
                            return True, response_data, None
                        except Exception:
                            error_msg = f"{provider_name} API returned invalid JSON: {json_error!s}"
                            logger.error(error_msg)
                            return False, None, error_msg
            else:
                return False, None, f"Unsupported HTTP method: {method}"
        except Exception as e:
            error_msg = f"Request failed: {e!s}"
            logger.error(error_msg)
            return False, None, error_msg

    @staticmethod
    def _update_provider_validation_status(db: Session, provider_id: str, success: bool, error_message: str | None = None):
        """Update provider validation status in the database."""
        try:
            # noinspection PyTypeChecker
            provider = db.query(ModelProvider).filter(ModelProvider.id == provider_id).first()
            if provider:
                now = datetime.now(UTC).isoformat()
                provider.validation_status = "valid" if success else "invalid"
                provider.validation_error = error_message if not success else None
                provider.last_validation_at = now
                if success:
                    provider.last_successful_validation_at = now
                db.commit()
                logger.info("Updated validation status for provider %s: %s", provider_id, provider.validation_status)
        except Exception as e:
            logger.error("Failed to update validation status for provider %s: %s", provider_id, str(e))
            db.rollback()

    @staticmethod
    def _persist_provider_version(db: Session, provider_id: str, version: str) -> None:
        """Store the backend semantic version reported by a self-hosted provider.

        Used by the structured-output router to gate features that require a
        minimum version (e.g. Ollama's native ``format=<schema>`` enforcement
        landed in 0.5.0).
        """
        try:
            # noinspection PyTypeChecker
            provider = db.query(ModelProvider).filter(ModelProvider.id == provider_id).first()
            if provider and provider.provider_version != version:
                provider.provider_version = version
                db.commit()
                logger.info("Persisted provider %s version: %s", provider_id, version)
        except Exception as e:
            logger.warning("Failed to persist provider version for %s: %s", provider_id, str(e))
            db.rollback()

    async def sync_provider(self, db: Session, provider) -> tuple[bool, str, list[dict[str, Any]]]:
        """Convenience method: sync a provider object (used by gRPC auto-sync)."""
        return await self.sync_provider_models(
            db=db,
            provider_id=str(provider.id),
            provider_type=provider.provider_type,
            api_key=provider.api_key,
            api_base=provider.api_base,
        )

    async def sync_all_providers(self, db: Session) -> None:
        """Sync models for all active providers (merge mode, preserves existing data)."""

        from src.main.models.sqlmodel_providers import ModelProvider

        # noinspection PyTypeChecker
        providers = db.query(ModelProvider).filter(ModelProvider.status == "active").all()
        for provider in providers:
            try:
                # Timeout per provider to prevent one slow/unreachable provider from blocking all others
                await asyncio.wait_for(self.sync_provider(db, provider), timeout=15.0)
            except TimeoutError:
                logger.warning("Timeout syncing provider %s (%s) - skipping", provider.name, provider.provider_type)
            except Exception as e:
                logger.warning("Failed to sync provider %s (%s): %s", provider.name, provider.provider_type, str(e))

    async def fetch_and_cache_models(self, db: Session) -> None:
        """Alias for sync_all_providers (used by gRPC FetchProviderModels)."""
        await self.sync_all_providers(db)

    async def sync_provider_models(
        self,
        db: Session,
        provider_id: str,
        provider_type: str,
        api_key: str | None = None,
        api_base: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        merge_and_cleanup: bool = True,
        selected_models: list[str] | None = None,
        replace_all: bool = False,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """
        Synchronize models for a specific provider.

        Args:
            db: Database session
            provider_id: Provider ID
            provider_type: Type of provider (openai, anthropic, openrouter, ollama, vllm, etc.)
            api_key: API key for authentication
            api_base: Custom API base URL
            limit: Optional limit for number of models to fetch
            offset: Optional offset for pagination (client-side for providers without API pagination)
            merge_and_cleanup: If True (default), merge with existing DB data and remove obsolete models.
                              Preserves manually-set context_window values.
            selected_models: Optional list of specific model names to sync.
                           If provided, only these models will be updated/added, and only obsolete
                           models from this list will be deleted.
                           If None, all available models from API are synced.
            replace_all: If True, delete all existing models and replace with fresh API data.
                        Overrides merge_and_cleanup. Use only when explicitly requested.

        Returns:
            Tuple of (success, message, models_list)
        """
        try:
            logger.info(
                "Starting model sync for provider %s (type: %s, replace_all=%s)",
                provider_id,
                provider_type,
                replace_all,
            )

            # replace_all=True forces full replacement (delete all + insert)
            # otherwise use merge_and_cleanup (default True = smart merge)
            effective_merge = merge_and_cleanup and not replace_all

            # Attempt to sync models with the provider
            if provider_type.lower() == "openai":
                success, message, models = await self._sync_openai_models(
                    db, provider_id, api_key, api_base, limit, offset, effective_merge, selected_models
                )
            elif provider_type.lower() == "anthropic":
                success, message, models = await self._sync_anthropic_models(
                    db, provider_id, api_key, limit, offset, effective_merge, selected_models
                )
            elif provider_type.lower() == "openrouter":
                success, message, models = await self._sync_openrouter_models(
                    db, provider_id, api_key, limit, offset, effective_merge, selected_models
                )
            elif provider_type.lower() == "google":
                success, message, models = await self._sync_google_models(db, provider_id, api_key, limit, offset, effective_merge, selected_models)
            elif provider_type.lower() == "ollama":
                success, message, models = await self._sync_ollama_models(
                    db, provider_id, api_base, limit, offset, effective_merge, selected_models, api_key=api_key
                )
            elif provider_type.lower() == "vllm":
                success, message, models = await self._sync_vllm_models(db, provider_id, api_base, limit, offset, effective_merge, selected_models)
            elif provider_type.lower() == "deepseek":
                success, message, models = await self._sync_deepseek_models(db, provider_id, api_key, limit, offset, effective_merge, selected_models)
            elif provider_type.lower() == "groq":
                # Groq uses OpenAI-compatible API
                groq_base = api_base or "https://api.groq.com/openai/v1"
                success, message, models = await self._sync_openai_models(
                    db, provider_id, api_key, groq_base, limit, offset, effective_merge, selected_models
                )
            else:
                success, message, models = await self.fetch_provider_models_only(provider_type, api_key, api_base, limit, offset)

            # Update provider validation status based on sync result
            self._update_provider_validation_status(db, provider_id, success, message if not success else None)

            return success, message, models

        except Exception as e:
            error_msg = f"Error syncing models for provider {provider_id}: {e!s}"
            logger.error("%s\n%s", error_msg, traceback.format_exc())

            # Update provider validation status to indicate failure
            self._update_provider_validation_status(db, provider_id, False, error_msg)

            return False, error_msg, []

    async def fetch_provider_models_only(
        self,
        provider_type: str,
        api_key: str | None = None,
        api_base: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """
        Fetch models from a provider API without saving to a database.
        Used for initial model discovery and user selection.

        Args:
            provider_type: Type of provider (openai, anthropic, openrouter, etc.)
            api_key: API key for authentication
            api_base: Custom API base URL
            limit: Optional limit for number of models to fetch
            offset: Optional offset for pagination

        Returns:
            Tuple of (success, message, models_list)
        """
        try:
            logger.info("Fetching models from %s API (no database save)", provider_type)

            # Fetch models based on a provider type without database operations
            if provider_type.lower() == "openrouter":
                return await self._fetch_openrouter_models_only(api_key, limit, offset)
            elif provider_type.lower() == "openai":
                return await self._fetch_openai_models_only(api_key, api_base, limit, offset)
            elif provider_type.lower() == "anthropic":
                return await self._fetch_anthropic_models_only(api_key, limit, offset)
            elif provider_type.lower() == "google":
                return await self._fetch_google_models_only(api_key, limit, offset)
            elif provider_type.lower() == "ollama":
                return await self._fetch_ollama_models_only(api_base, limit, offset)
            elif provider_type.lower() == "vllm":
                return await self._fetch_vllm_models_only(api_base, limit, offset)
            elif provider_type.lower() == "deepseek":
                return await self._fetch_deepseek_models_only(api_key, limit, offset)
            elif provider_type.lower() == "lmstudio":
                return await self._fetch_lmstudio_models_only(api_base, limit, offset)
            else:
                return False, f"Unsupported provider type: {provider_type}", []

        except Exception as e:
            error_msg = f"Error fetching models from {provider_type}: {e!s}"
            logger.error("%s\n%s", error_msg, traceback.format_exc())
            return False, error_msg, []

    async def _fetch_openrouter_models_common(
        self, api_key: str | None, limit: int | None = None, offset: int | None = None
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Common method to fetch and process OpenRouter models from API."""
        api_base = get_default_api_base("openrouter")
        url = f"{api_base}/models"

        headers = {"Content-Type": "application/json"}

        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        try:
            timeout = aiohttp.ClientTimeout(total=self.session_timeout)
            connector = aiohttp.TCPConnector(limit=100, limit_per_host=30, ttl_dns_cache=300, use_dns_cache=True)
            async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
                async with session.get(url, headers=headers) as response:
                    if response.status != 200:
                        error_text = await response.text()
                        return False, f"OpenRouter API error {response.status}: {error_text}", []

                    data = await response.json()
                    all_models_data = data.get("data", [])

                    # Apply client-side pagination since OpenRouter API doesn't support server-side pagination
                    if limit is not None and offset is not None:
                        paginated_models_data = all_models_data[offset : offset + limit]
                        logger.info(
                            "Applied client-side pagination: offset=%s, limit=%s, total_available=%s, returned=%s",
                            offset,
                            limit,
                            len(all_models_data),
                            len(paginated_models_data),
                        )
                    else:
                        paginated_models_data = all_models_data
                        logger.info("No pagination applied, processing all %s models", len(all_models_data))

                    models = []

                    for model_data in paginated_models_data:
                        model_id = model_data.get("id", "")
                        pricing = model_data.get("pricing", {})
                        architecture = model_data.get("architecture", {})
                        supported_params = model_data.get("supported_parameters", [])

                        # Skip models without proper pricing data or that are likely test/beta models
                        if not model_id or not pricing:
                            continue

                        # Get context length from model data or top_provider
                        context_length = model_data.get("context_length") or 0
                        top_provider = model_data.get("top_provider", {})
                        if not context_length and top_provider:
                            context_length = top_provider.get("context_length") or 0
                        if not context_length:
                            context_length = 4096

                        # Check for vision support from input modalities
                        input_modalities = architecture.get("input_modalities", [])
                        has_vision = "image" in input_modalities

                        # Determine a model type from architecture, model name, and vision capabilities
                        if has_vision:
                            model_type = "VISION"
                        else:
                            model_type = self._determine_openrouter_model_type(model_id, architecture)

                        # Check for tool support - look for various tool-related parameters
                        supports_tools = any(param in supported_params for param in ["tools", "tool_choice", "function_call", "functions"])

                        models.append(
                            {
                                "model_name": model_id,
                                "model_type": model_type,
                                "context_length": context_length,
                                "input_cost": float(pricing.get("prompt", "0")),
                                "output_cost": float(pricing.get("completion", "0")),
                                "supports_tools": supports_tools,
                                "supports_vision": has_vision,
                                "supports_streaming": True,
                                "supports_function_calling": supports_tools,
                            }
                        )

                    return True, f"Successfully processed {len(models)} OpenRouter models", models

        except TimeoutError:
            return False, "Timeout while fetching OpenRouter models", []
        except Exception as e:
            return False, f"Error fetching OpenRouter models: {e!s}", []

    async def _fetch_openrouter_models_only(
        self, api_key: str | None, limit: int | None = None, offset: int | None = None
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Fetch models from OpenRouter API without saving to a database."""
        success, message, models = await self._fetch_openrouter_models_common(api_key, limit, offset)
        if success:
            message = f"Successfully fetched {len(models)} OpenRouter models"
        return success, message, models

    # Fetch-only methods (no database operations)
    async def _fetch_openai_models_only(
        self,
        api_key: str | None,
        api_base: str | None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Fetch models from OpenAI API without database operations."""
        # Use common OpenAI preparation helper
        is_valid, error_msg, url, headers = self._prepare_openai_request(api_key, api_base)
        if not is_valid:
            return False, error_msg, []

        return await self._fetch_models_generic(
            url=url,
            headers=headers,
            provider_name="OpenAI",
            provider_type="openai",
            data_key="data",
            model_id_key="id",
            validation_func=self._is_valid_openai_model,
            limit=limit,
            offset=offset,
        )

    async def _fetch_anthropic_models_common(
        self,
        api_key: str | None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Common method to fetch models from Anthropic API."""
        if not api_key:
            return False, "Anthropic API key is required", []

        api_base = get_default_api_base("anthropic")
        url = f"{api_base}/v1/models"
        headers = {"x-api-key": api_key, "Content-Type": "application/json", "anthropic-version": "2023-06-01"}

        try:
            async with await self._create_http_session() as session:
                success, data, error = await self._handle_api_request_with_error_handling(session, "GET", url, headers, provider_name="Anthropic")

                if not success:
                    return False, error or "", []

                all_models = []
                # noinspection PyUnresolvedReferences
                for model_data in data.get("data", []):
                    model_id = model_data.get("id", "")
                    if model_id and self._is_valid_anthropic_model(model_id):
                        metadata = self._get_model_metadata_by_provider(model_id, "anthropic")
                        metadata["model_name"] = model_id
                        all_models.append(metadata)

                models = self._apply_client_side_pagination(all_models, limit, offset, "Anthropic API")
                return True, "", models

        except TimeoutError:
            return False, "Timeout while fetching Anthropic models", []
        except Exception as e:
            return False, f"Error fetching Anthropic models: {e!s}", []

    async def _fetch_anthropic_models_only(
        self,
        api_key: str | None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Fetch models from Anthropic API without database operations."""
        success, error_message, models = await self._fetch_anthropic_models_common(api_key, limit, offset)

        if not success:
            return success, error_message, models

        message = f"Successfully fetched {len(models)} Anthropic models"
        return True, message, models

    async def _fetch_google_models_only(
        self,
        api_key: str | None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Fetch models from Google API without database operations."""
        if not api_key:
            return False, "Google API key is required", []

        api_base = get_default_api_base("google")
        url = f"{api_base}/models"
        headers = {"X-goog-api-key": api_key}

        try:
            async with await self._create_http_session() as session:
                success, data, error = await self._handle_api_request_with_error_handling(session, "GET", url, headers, provider_name="Google")

                if not success:
                    return False, error or "", []

                all_models = []
                # noinspection PyUnresolvedReferences
                for model_data in data.get("models", []):
                    model_name = model_data.get("name", "")
                    if model_name.startswith("models/"):
                        model_id = model_name.replace("models/", "")
                        # Filter for generative models using the same logic as _sync_google_models
                        if "generateContent" in model_data.get("supportedGenerationMethods", []):
                            metadata = self._get_model_metadata_by_provider(model_id, "google")
                            metadata["model_name"] = model_id
                            all_models.append(metadata)

                models = self._apply_client_side_pagination(all_models, limit, offset, "Google API")
                message = f"Successfully fetched {len(models)} Google models"
                return True, message, models

        except TimeoutError:
            return False, "Timeout while fetching Google models", []
        except Exception as e:
            return False, f"Error fetching Google models: {e!s}", []

    async def _fetch_ollama_models_only(
        self,
        api_base: str | None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Fetch models from Ollama API without database operations."""
        if not api_base:
            api_base = get_default_api_base("ollama")
        api_base = api_base or "http://localhost:11434"

        # noinspection PyTypeChecker
        url = urljoin(api_base, "/api/tags")

        # Simple validation function that accepts any non-empty model ID
        def validate_ollama_model(model_id: str) -> bool:
            return bool(model_id)

        return await self._fetch_models_generic(
            url=url,
            headers={},
            provider_name="Ollama",
            provider_type="ollama",
            data_key="models",
            model_id_key="name",
            validation_func=validate_ollama_model,
            limit=limit,
            offset=offset,
        )

    async def _fetch_vllm_models_only(
        self,
        api_base: str | None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Fetch models from vLLM API without database operations."""
        if not api_base:
            api_base = get_default_api_base("vllm")
        api_base = api_base or "http://localhost:8000"

        # noinspection PyTypeChecker
        url = urljoin(api_base, "/v1/models")

        # Simple validation function that accepts any non-empty model ID
        def validate_vllm_model(model_id: str) -> bool:
            return bool(model_id)

        return await self._fetch_models_generic(
            url=url,
            headers={},
            provider_name="vLLM",
            provider_type="vllm",
            data_key="data",
            model_id_key="id",
            validation_func=validate_vllm_model,
            limit=limit,
            offset=offset,
        )

    async def _fetch_deepseek_models_only(
        self,
        api_key: str | None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Fetch models from DeepSeek API without database operations."""
        if not api_key:
            return False, "DeepSeek API key is required", []

        api_base = get_default_api_base("deepseek")
        url = f"{api_base}/v1/models"
        # DeepSeek uses standard OpenAI-compatible authentication
        headers = {"Authorization": f"Bearer {api_key}"}

        return await self._fetch_models_generic(
            url=url,
            headers=headers,
            provider_name="DeepSeek",
            provider_type="deepseek",
            data_key="data",
            model_id_key="id",
            validation_func=self._is_valid_deepseek_model,
            limit=limit,
            offset=offset,
        )

    async def _fetch_lmstudio_models_only(
        self,
        api_base: str | None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Fetch models from LM Studio API without database operations."""
        if not api_base:
            api_base = get_default_api_base("lmstudio")

        if not api_base:
            return False, "LM Studio API base is required", []

        url = f"{api_base}/models"
        # LM Studio doesn't require authentication for local instances
        headers = {}

        return await self._fetch_models_generic(
            url=url,
            headers=headers,
            provider_name="LM Studio",
            provider_type="lmstudio",
            data_key="data",
            model_id_key="id",
            validation_func=self._is_valid_lmstudio_model,
            limit=limit,
            offset=offset,
        )

    async def _sync_openai_models(
        self,
        db: Session,
        provider_id: str,
        api_key: str | None = None,
        api_base: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        merge_and_cleanup: bool = True,
        selected_models: list[str] | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Sync models from OpenAI API."""
        # Use common OpenAI preparation helper
        is_valid, error_msg, url, headers = self._prepare_openai_request(api_key, api_base)
        if not is_valid:
            return False, error_msg, []

        # Use the generic fetch method to get models
        success, message, models = await self._fetch_models_generic(
            url=url,
            headers=headers,
            provider_name="OpenAI",
            provider_type="openai",
            data_key="data",
            model_id_key="id",
            validation_func=self._is_valid_openai_model,
            limit=limit,
            offset=offset,
        )

        if not success:
            return success, message, models

        # Update database
        success = await self._update_provider_models(db, provider_id, models, merge_and_cleanup, selected_models)
        message = f"Successfully synced {len(models)} OpenAI models"

        return success, message, models

    async def _sync_openrouter_models(
        self,
        db: Session,
        provider_id: str,
        api_key: str | None,
        limit: int | None = None,
        offset: int | None = None,
        merge_and_cleanup: bool = True,
        selected_models: list[str] | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Sync models from OpenRouter API."""
        # Fetch models using the existing method
        success, message, models = await self._fetch_openrouter_models_only(api_key, limit, offset)

        if not success:
            return success, message, models

        # Update database
        db_success = await self._update_provider_models(db, provider_id, models, merge_and_cleanup, selected_models)
        if db_success:
            message = f"Successfully synced {len(models)} OpenRouter models"
        else:
            message = f"Fetched {len(models)} OpenRouter models but failed to update database"
            success = False

        return success, message, models

    async def _sync_anthropic_models(
        self,
        db: Session,
        provider_id: str,
        api_key: str | None,
        limit: int | None = None,
        offset: int | None = None,
        merge_and_cleanup: bool = True,
        selected_models: list[str] | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Sync models from Anthropic API."""
        success, error_message, models = await self._fetch_anthropic_models_common(api_key, limit, offset)

        if not success:
            return success, error_message, models

        # Update database
        success = await self._update_provider_models(db, provider_id, models, merge_and_cleanup, selected_models)
        message = f"Successfully synced {len(models)} Anthropic models"

        return success, message, models

    async def _sync_google_models(
        self,
        db: Session,
        provider_id: str,
        api_key: str | None,
        limit: int | None = None,
        offset: int | None = None,
        merge_and_cleanup: bool = True,
        selected_models: list[str] | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Sync models from Google AI API."""
        if not api_key:
            return False, "Google API key is required", []

        # Build URL with pagination parameters
        api_base = get_default_api_base("google")
        url = f"{api_base}/models"
        headers = {"X-goog-api-key": api_key}

        # Add pagination parameters if provided
        params = []
        if limit is not None:
            params.append(f"pageSize={min(limit, 1000)}")  # Google API max is 1000
        if offset is not None and offset > 0:
            logger.info("Google API pagination: client-side slicing with limit=%s, offset=%s", limit, offset)

        if params:
            url += "?" + "&".join(params)

        try:
            async with await self._create_http_session() as session:
                success, data, error = await self._handle_api_request_with_error_handling(session, "GET", url, headers, provider_name="Google")

                if not success:
                    return False, error or "", []

                all_models = []
                # noinspection PyUnresolvedReferences
                for model_data in data.get("models", []):
                    model_name = model_data.get("name", "").replace("models/", "")

                    # Filter for generative models
                    if "generateContent" in model_data.get("supportedGenerationMethods", []):
                        metadata = self._get_model_metadata_by_provider(model_name, "google")
                        metadata["model_name"] = model_name
                        all_models.append(metadata)

                # Apply client-side pagination
                models = self._apply_client_side_pagination(all_models, limit, offset, "Google API")

                # Update database
                success = await self._update_provider_models(db, provider_id, models, merge_and_cleanup, selected_models)
                message = f"Successfully synced {len(models)} Google models"

                return success, message, models

        except TimeoutError:
            return False, "Timeout while fetching Google models", []
        except Exception as e:
            return False, f"Error fetching Google models: {e!s}", []

    async def _sync_ollama_models(
        self,
        db: Session,
        provider_id: str,
        api_base: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        merge_and_cleanup: bool = True,
        selected_models: list[str] | None = None,
        api_key: str | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Sync models from Ollama API. Supports Ollama Cloud with API key."""
        if not api_base:
            api_base = "http://localhost:11434"
        api_base = api_base or "http://localhost:11434"

        try:
            # Use standalone API fetcher to avoid circular imports
            # noinspection PyTypeChecker
            basic_models = await fetch_ollama_models_api(api_base, api_key=api_key)

            if not basic_models:
                return False, "No models returned from Ollama API", []

            # Persist Ollama backend version so the structured-output router can gate
            # native format=schema enforcement (Ollama >= 0.5). Best-effort: a missing
            # /api/version endpoint or transient failure leaves the column NULL.
            version = await fetch_ollama_version(api_base, api_key=api_key)
            if version:
                self._persist_provider_version(db, provider_id, version)

            # Enrich basic model data with metadata for database storage
            all_models = []
            for model_data in basic_models:
                model_name = model_data.get("name", model_data.get("id", ""))
                if not model_name:
                    continue

                metadata = self._get_model_metadata_by_provider(model_name, "ollama")
                metadata["model_name"] = model_name
                # Add Ollama-specific fields
                metadata["size_bytes"] = 0  # Not available from basic fetch
                metadata["modified_at"] = ""  # Not available from basic fetch
                all_models.append(metadata)

            # Apply client-side pagination
            models = self._apply_client_side_pagination(all_models, limit, offset, "Ollama API")

            # Update database
            success = await self._update_provider_models(db, provider_id, models, merge_and_cleanup, selected_models)
            message = f"Successfully synced {len(models)} Ollama models"

            return success, message, models

        except TimeoutError:
            return False, "Timeout while fetching Ollama models", []
        except Exception as e:
            return False, f"Error fetching Ollama models: {e!s}", []

    async def _sync_vllm_models(
        self,
        db: Session,
        provider_id: str,
        api_base: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        merge_and_cleanup: bool = True,
        selected_models: list[str] | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Sync models from vLLM API using existing tested fetch method."""
        if not api_base:
            return False, "vLLM API base URL is required", []

        try:
            # Use standalone API fetcher to avoid circular imports
            basic_models = await fetch_vllm_models_api(api_base)

            if not basic_models:
                return False, "No models returned from vLLM API", []

            # Enrich basic model data with metadata for database storage
            all_models = []
            for model_data in basic_models:
                model_name = model_data.get("name", model_data.get("id", ""))
                if not model_name:
                    continue

                metadata = self._get_model_metadata_by_provider(model_name, "vllm")
                metadata["model_name"] = model_name
                all_models.append(metadata)

            # Apply client-side pagination
            models = self._apply_client_side_pagination(all_models, limit, offset, "vLLM API")

            # Update database
            success = await self._update_provider_models(db, provider_id, models, merge_and_cleanup, selected_models)
            message = f"Successfully synced {len(models)} vLLM models"

            return success, message, models

        except Exception as e:
            return False, f"Error fetching vLLM models: {e!s}", []

    async def _sync_deepseek_models(
        self,
        db: Session,
        provider_id: str,
        api_key: str | None,
        limit: int | None = None,
        offset: int | None = None,
        merge_and_cleanup: bool = True,
        selected_models: list[str] | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Sync models from DeepSeek API."""
        if not api_key:
            return False, "DeepSeek API key is required", []

        api_base = get_default_api_base("deepseek")
        url = f"{api_base}/v1/models"
        # DeepSeek uses standard OpenAI-compatible authentication
        headers = {"Authorization": f"Bearer {api_key}"}

        try:
            async with await self._create_http_session() as session:
                success, data, error = await self._handle_api_request_with_error_handling(session, "GET", url, headers, provider_name="DeepSeek")

                if not success:
                    return False, error or "", []

                all_models = []
                # noinspection PyUnresolvedReferences
                for model_data in data.get("data", []):
                    model_id = model_data.get("id", "")

                    # Filter valid DeepSeek models
                    if self._is_valid_deepseek_model(model_id):
                        metadata = self._get_model_metadata_by_provider(model_id, "deepseek")
                        metadata["model_name"] = model_id
                        all_models.append(metadata)

                # Apply client-side pagination
                models = self._apply_client_side_pagination(all_models, limit, offset, "DeepSeek API")

                # Update database only if provider_id is provided (saved provider)
                # For "Add Provider" flow, provider_id is None, so skip database update
                if provider_id:
                    success = await self._update_provider_models(db, provider_id, models, merge_and_cleanup, selected_models)
                    message = f"Successfully synced {len(models)} DeepSeek models"
                    return success, message, models
                else:
                    # "Add Provider" flow - just return the models without saving to a database
                    message = f"Successfully fetched {len(models)} DeepSeek models"
                    return True, message, models

        except TimeoutError:
            return False, "Timeout while fetching DeepSeek models", []
        except Exception as e:
            error_msg = f"Error syncing DeepSeek models: {e!s}"
            logger.error("%s\n%s", error_msg, traceback.format_exc())
            return False, error_msg, []

    async def _fetch_models_generic(
        self,
        url: str,
        headers: dict[str, str],
        provider_name: str,
        provider_type: str,
        data_key: str,
        model_id_key: str,
        validation_func: Callable[[str], bool],
        limit: int | None = None,
        offset: int | None = None,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Generic method to fetch models from API and process them.

        Args:
            url: API endpoint URL
            headers: HTTP headers for the request
            provider_name: Display name for the provider (e.g., "OpenAI")
            provider_type: Provider type for metadata (e.g., "openai")
            data_key: Key in response data containing models array (e.g., "data", "models")
            model_id_key: Key in model data containing model ID (e.g., "id", "name")
            validation_func: Function to validate if model should be included
            limit: Optional limit for pagination
            offset: Optional offset for pagination

        Returns:
            Tuple of (success, message, models_list)
        """
        try:
            async with await self._create_http_session() as session:
                success, data, error = await self._handle_api_request_with_error_handling(session, "GET", url, headers, provider_name=provider_name)

                if not success:
                    return False, error or "", []

                all_models = []
                # noinspection PyUnresolvedReferences
                for model_data in data.get(data_key, []):
                    model_id = model_data.get(model_id_key, "")
                    if model_id and validation_func(model_id):
                        metadata = self._get_model_metadata_by_provider(model_id, provider_type)
                        metadata["model_name"] = model_id
                        all_models.append(metadata)

                models = self._apply_client_side_pagination(all_models, limit, offset, f"{provider_name} API")
                message = f"Successfully fetched {len(models)} {provider_name} models"
                return True, message, models

        except TimeoutError:
            return False, f"Timeout while fetching {provider_name} models", []
        except Exception as e:
            return False, f"Error fetching {provider_name} models: {e!s}", []

    @staticmethod
    def _create_model_instance(provider_id: str, model_data: dict[str, Any]) -> ModelProviderModel:
        """Create a new ModelProviderModel instance from model data.

        Args:
            provider_id: The provider ID
            model_data: Dictionary containing model information

        Returns:
            ModelProviderModel instance
        """
        model_name = model_data["model_name"]

        # Calculate display_name using the normalization function
        display_name = None
        try:
            display_name = normalize_model_display_name(model_name)
            logger.debug("Normalized display name for %s: %s", model_name, display_name)
        except Exception as e:
            logger.warning("Failed to normalize display name for %s: %s", model_name, e)

        # Fallback if normalization fails
        if not display_name:
            fallback_display_name = model_data.get("display_name")
            display_name = fallback_display_name or model_name
            logger.debug("Using fallback display name for %s: %s (from model_data: %s)", model_name, display_name, fallback_display_name)

        return ModelProviderModel(
            provider_id=provider_id,
            model_name=model_name,
            display_name=display_name,
            model_type=model_data.get("model_type", "NORMAL"),
            context_window=model_data.get("context_length") or 4096,
            input_cost=model_data.get("input_cost") or 0.0,
            output_cost=model_data.get("output_cost") or 0.0,
            supports_tools=model_data.get("supports_tools", False),
            supports_vision=model_data.get("supports_vision", False),
            supports_streaming=model_data.get("supports_streaming", True),
            supports_function_calling=model_data.get("supports_function_calling", False),
            supports_image_generation=model_data.get("supports_image_generation", False),
            supports_audio_input=model_data.get("supports_audio_input", False),
            supports_audio_output=model_data.get("supports_audio_output", False),
            supports_realtime=model_data.get("supports_realtime", False),
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )

    async def _update_provider_models(
        self,
        db: Session,
        provider_id: str,
        models: list[dict[str, Any]],
        merge_and_cleanup: bool = True,
        selected_models: list[str] | None = None,
    ) -> bool:
        """Update the database with the fetched models."""
        try:
            if merge_and_cleanup:
                # Merge mode: update existing models and add new ones, delete obsolete ones
                # noinspection PyTypeChecker
                existing_models = (
                    # noinspection PyTypeChecker
                    db.query(ModelProviderModel).filter(ModelProviderModel.provider_id == provider_id).all()
                )

                existing_model_names = {model.model_name for model in existing_models}

                # Filter models based on selected_models if provided
                if selected_models:
                    # Only sync selected models
                    models_to_sync = [m for m in models if m["model_name"] in selected_models]
                    new_model_names = set(selected_models)
                    logger.info("Selective sync: processing %s selected models out of %s available", len(models_to_sync), len(models))
                else:
                    # Sync all models (existing behavior)
                    models_to_sync = models
                    new_model_names = {model_data["model_name"] for model_data in models}

                # Delete obsolete models (exist in DB but not in API response)
                # Only delete models that were in the selected list (if provided) or all models (if no selection)
                if selected_models:
                    # Only delete obsolete models from the selected list
                    selected_existing_models = existing_model_names & set(selected_models)
                    obsolete_models = selected_existing_models - new_model_names
                else:
                    # Delete all obsolete models (existing behavior)
                    obsolete_models = existing_model_names - new_model_names

                if obsolete_models:
                    # noinspection PyTypeChecker,PyUnresolvedReferences
                    db.query(ModelProviderModel).filter(
                        ModelProviderModel.provider_id == provider_id,
                        ModelProviderModel.model_name.in_(obsolete_models),
                    ).delete(synchronize_session=False)
                    logger.info("Deleted %s obsolete models for provider %s", len(obsolete_models), provider_id)

                # Update or add models (only selected ones if specified)
                for model_data in models_to_sync:
                    # noinspection PyTypeChecker
                    existing_model = (
                        db.query(ModelProviderModel)
                        .filter(
                            ModelProviderModel.provider_id == provider_id,
                            ModelProviderModel.model_name == model_data["model_name"],
                        )
                        .first()
                    )

                    if existing_model:
                        # Update existing model
                        existing_model.model_type = model_data.get("model_type", "NORMAL")

                        # Preserve existing context_window if it was manually set to a specific value
                        # and the new value is a generic fallback default
                        new_context = model_data.get("context_length") or 4096
                        existing_context = existing_model.context_window or 0
                        generic_defaults = {0, 4096, 8192}
                        if existing_context in generic_defaults or new_context > existing_context:
                            existing_model.context_window = new_context
                        else:
                            logger.debug(
                                "Preserving context_window=%s for %s (API returned %s)",
                                existing_context,
                                existing_model.model_name,
                                new_context,
                            )

                        existing_model.input_cost = model_data.get("input_cost") or 0.0
                        existing_model.output_cost = model_data.get("output_cost") or 0.0
                        existing_model.supports_tools = model_data.get("supports_tools", False)
                        existing_model.supports_vision = model_data.get("supports_vision", False)
                        existing_model.supports_streaming = model_data.get("supports_streaming", True)
                        existing_model.supports_function_calling = model_data.get("supports_function_calling", False)
                        existing_model.supports_image_generation = model_data.get("supports_image_generation", False)
                        existing_model.supports_audio_input = model_data.get("supports_audio_input", False)
                        existing_model.supports_audio_output = model_data.get("supports_audio_output", False)
                        existing_model.supports_realtime = model_data.get("supports_realtime", False)
                        existing_model.updated_at = datetime.now(UTC)

                        # Update display_name using the normalization function
                        old_display_name = existing_model.display_name
                        try:
                            normalized_display_name = normalize_model_display_name(existing_model.model_name)
                            existing_model.display_name = normalized_display_name
                            logger.debug(
                                "Updated display name for existing model %s: %s → %s",
                                existing_model.model_name,
                                old_display_name,
                                normalized_display_name,
                            )
                        except Exception as e:
                            logger.warning("Failed to normalize display name for existing model %s: %s", existing_model.model_name, e)
                            # Fallback: use model_name if display_name is "Unknown" or empty
                            if not existing_model.display_name or existing_model.display_name == "Unknown":
                                existing_model.display_name = existing_model.model_name
                                logger.debug(
                                    "Updated display name for existing model %s: %s → %s (fallback)",
                                    existing_model.model_name,
                                    old_display_name,
                                    existing_model.model_name,
                                )
                    else:
                        # Add new model
                        model = self._create_model_instance(provider_id, model_data)
                        db.add(model)
            else:
                # Default mode: remove all existing models and replace with new ones
                # noinspection PyTypeChecker
                db.query(ModelProviderModel).filter(ModelProviderModel.provider_id == provider_id).delete()

                # Add new models
                for model_data in models:
                    model = self._create_model_instance(provider_id, model_data)
                    db.add(model)

            db.commit()
            logger.info("Successfully updated %s models for provider %s", len(models), provider_id)

            # Publish Redis event for Kotlin sync
            try:
                from src.main.service.model_provider_snapshot import publish_model_provider_event

                publish_model_provider_event(
                    event_type="MODEL_PROVIDER_MODELS_SYNCED",
                    provider_id=provider_id,
                    payload={"provider_id": provider_id, "model_count": len(models)},
                    db=db,
                )
            except Exception as pub_err:
                logger.warning("Failed to publish models synced event: %s", pub_err)

            return True

        except Exception as e:
            db.rollback()
            logger.error("Error updating models for provider %s: %s", provider_id, str(e))
            return False

    @staticmethod
    def _is_valid_openai_model(model_id: str) -> bool:
        """Check if an OpenAI model is valid for chat completion.

        Filters out:
        - Embedding models (text-embedding-*)
        - Audio models (whisper-*, tts-*)
        - Image models (dall-e-*)
        - Legacy completion models (text-davinci-*, text-curie-*, text-babbage-*, text-ada-*)
        - Instruct/completion models (*-instruct) - these use completions endpoint, not chat

        Only chat-compatible models will be synced to the database.
        """
        invalid_prefixes = [
            "text-embedding",  # Embedding models
            "whisper",  # Audio transcription
            "tts",  # Text-to-speech
            "dall-e",  # Image generation
            "text-davinci",  # Legacy completion models
            "text-curie",  # Legacy completion models
            "text-babbage",  # Legacy completion models
            "text-ada",  # Legacy completion models
        ]

        # Filter out models with invalid prefixes
        if any(model_id.startswith(prefix) for prefix in invalid_prefixes):
            return False

        # Filter out instruct/completion models (they use /v1/completions endpoint, not /v1/chat/completions)
        # Examples: gpt-3.5-turbo-instruct, gpt-4-instruct (if it exists)
        return "-instruct" not in model_id.lower()

    @staticmethod
    def _determine_openai_model_type(model_id: str) -> str:
        """Determine the model type for OpenAI models."""
        if "o1" in model_id:
            return "NORMAL"  # All models use dynamic reasoning detection
        elif "gpt" in model_id or "claude" in model_id:
            return "NORMAL"
        else:
            return "NORMAL"

    @staticmethod
    def _get_openai_context_length(model_id: str) -> int:
        """Get context length for OpenAI models.

        Order matters: more specific patterns must come before generic ones
        (e.g. 'gpt-4.1' before 'gpt-4', 'o1-mini' before 'o1').
        """
        context_map = {
            # GPT-5.x family (400K context)
            "gpt-5.2-chat": 128000,
            "gpt-5.1-chat": 128000,
            "gpt-5": 400000,
            # GPT-4.1 family (1M context)
            "gpt-4.1": 1000000,
            # GPT-4o family (128K context)
            "gpt-4o-mini": 128000,
            "gpt-4o": 128000,
            # GPT-4 legacy
            "gpt-4-turbo": 128000,
            "gpt-4": 8192,
            # GPT-3.5
            "gpt-3.5-turbo": 16385,
            # Audio models (128K context)
            "gpt-audio": 128000,
            # Realtime models (128K context)
            "gpt-realtime": 128000,
            # Image models (32K context)
            "gpt-image": 32768,
            "chatgpt-image": 32768,
            # Reasoning models (200K context)
            "o4-mini": 200000,
            "o3-pro": 200000,
            "o3-deep-research": 200000,
            "o3-mini": 200000,
            "o3": 200000,
            "o1-preview": 128000,
            "o1-mini": 128000,
            "o1-pro": 200000,
            "o1": 200000,
            # Codex models (200K context)
            "codex-mini": 200000,
            # Legacy models
            "babbage-002": 16384,
            "davinci-002": 16384,
            # Moderation / Sora
            "omni-moderation": 32768,
            "sora": 32768,
        }

        for key, length in context_map.items():
            if key in model_id:
                return length
        return 128000

    @staticmethod
    def _get_openai_input_cost(model_id: str) -> float:
        """Get input cost per 1K tokens for OpenAI models."""
        cost_map = {
            "gpt-4o": 0.0025,
            "gpt-4o-mini": 0.00015,
            "gpt-4-turbo": 0.01,
            "gpt-4": 0.03,
            "gpt-3.5-turbo": 0.0005,
            "o1-preview": 0.015,
            "o1-mini": 0.003,
            "o1-pro": 0.06,
        }

        for key, cost in cost_map.items():
            if key in model_id:
                return cost
        return 0.0

    @staticmethod
    def _get_openai_output_cost(model_id: str) -> float:
        """Get output cost per 1K tokens for OpenAI models."""
        cost_map = {
            "gpt-4o": 0.01,
            "gpt-4o-mini": 0.0006,
            "gpt-4-turbo": 0.03,
            "gpt-4": 0.06,
            "gpt-3.5-turbo": 0.0015,
            "o1-preview": 0.06,
            "o1-mini": 0.012,
            "o1-pro": 0.24,
        }

        for key, cost in cost_map.items():
            if key in model_id:
                return cost
        return 0.0

    @staticmethod
    def _openai_supports_tools(model_id: str) -> bool:
        """Check if OpenAI model supports function calling."""
        # Most modern OpenAI models support tools
        unsupported = ["gpt-3.5-turbo-instruct"]
        return model_id not in unsupported

    @staticmethod
    def _openai_supports_vision(model_id: str) -> bool:
        """Check if OpenAI model supports vision."""
        vision_models = ["gpt-4o", "gpt-4-turbo", "gpt-4-vision"]
        return any(vm in model_id for vm in vision_models)

    @staticmethod
    def _determine_ollama_model_type(model_name: str) -> str:
        """Determine model type for Ollama models."""
        name_lower = model_name.lower()

        # All models now use dynamic reasoning detection
        reasoning_patterns = ["r1", "thinking", "reasoning"]
        if any(pattern in name_lower for pattern in reasoning_patterns):
            return "NORMAL"  # All models use dynamic reasoning detection

        # Check for embedding models
        embedding_patterns = ["embed", "embedding", "nomic-embed", "mxbai-embed"]
        if any(pattern in name_lower for pattern in embedding_patterns):
            return "EMBEDDING"

        return "NORMAL"

    @staticmethod
    def _determine_openrouter_model_type(model_id: str, architecture: dict[str, Any]) -> str:
        """Determine a model type for OpenRouter models based on ID and architecture."""
        model_name_lower = model_id.lower()

        # Check for reasoning models by name patterns
        reasoning_patterns = ["o1", "o3", "r1", "thinking", "reasoning", "magistral", "grok-4", "grok-3"]

        if any(pattern in model_name_lower for pattern in reasoning_patterns):
            return "NORMAL"  # All models use dynamic reasoning detection

        # Check architecture for reasoning indicators
        instruct_type = architecture.get("instruct_type")
        # noinspection PyUnresolvedReferences
        if instruct_type and "reasoning" in instruct_type.lower():
            return "NORMAL"  # All models use dynamic reasoning detection

        # Check if the model name contains reasoning indicators
        if "deepseek-r1" in model_name_lower or "qwen3-235b-a22b-thinking" in model_name_lower:
            return "NORMAL"  # All models use dynamic reasoning detection

        return "NORMAL"

    @staticmethod
    def _get_google_context_length(model_name: str) -> int:
        """Get context length for Google models."""
        if "gemini-2.0" in model_name:
            return 1000000
        elif "gemini-1.5" in model_name:
            return 2000000
        elif "gemini-pro" in model_name:
            return 32768
        return 8192

    @staticmethod
    def _get_google_input_cost(model_name: str) -> float:
        """Get input cost for Google models (per 1K tokens)."""
        if "gemini-2.0" in model_name:
            return 0.00025
        elif "gemini-1.5-pro" in model_name:
            return 0.00125
        elif "gemini-1.5-flash" in model_name:
            return 0.000075
        return 0.0

    @staticmethod
    def _get_google_output_cost(model_name: str) -> float:
        """Get output cost for Google models (per 1K tokens)."""
        if "gemini-2.0" in model_name:
            return 0.001
        elif "gemini-1.5-pro" in model_name:
            return 0.005
        elif "gemini-1.5-flash" in model_name:
            return 0.0003
        return 0.0

    @staticmethod
    def _get_ollama_context_length(model_name: str) -> int:
        """Get context length for Ollama models."""
        name_lower = model_name.lower()

        # Common context lengths for popular models
        if "llama3" in name_lower or "llama-3" in name_lower:
            return 8192
        elif "lmstudio" in name_lower:
            return 4096
        elif "qwen" in name_lower:
            return 32768
        elif "deepseek" in name_lower:
            if "r1" in name_lower:
                return 131072
            return 32768

        return 4096  # Default

    @staticmethod
    def _ollama_supports_tools(model_name: str) -> bool:
        """Check if Ollama model supports function calling."""
        name_lower = model_name.lower()
        # Most modern models support tools
        tools_patterns = ["llama4", "deepseek", "gpt-oss", "qwen"]
        return any(pattern in name_lower for pattern in tools_patterns)

    @staticmethod
    def _ollama_supports_vision(model_name: str) -> bool:
        """Check if Ollama model supports vision."""
        name_lower = model_name.lower()
        vision_patterns = ["vision", "davinci", "gemma", "llava", "minicpm-v"]
        return any(pattern in name_lower for pattern in vision_patterns)

    @staticmethod
    def _determine_vllm_model_type(model_id: str) -> str:
        """Determine model type for vLLM models."""
        name_lower = model_id.lower()

        # All models now use dynamic reasoning detection
        reasoning_patterns = ["r1", "thinking", "reasoning", "o1"]
        if any(pattern in name_lower for pattern in reasoning_patterns):
            return "NORMAL"  # All models use dynamic reasoning detection

        return "NORMAL"

    @staticmethod
    def _get_vllm_context_length(model_id: str) -> int:
        """Get context length for vLLM models."""
        # vLLM can host various models, use common defaults
        name_lower = model_id.lower()

        if "llama3" in name_lower:
            return 8192
        elif "lmstudio" in name_lower:
            return 4096
        elif "qwen" in name_lower:
            return 32768

        return 4096  # Default

    @staticmethod
    def _vllm_supports_tools(model_id: str) -> bool:
        """Check if vLLM model supports function calling."""
        name_lower = model_id.lower()
        return "llama3" in name_lower or "lmstudio" in name_lower or "qwen" in name_lower

    @staticmethod
    def _vllm_supports_vision(model_id: str) -> bool:
        """Check if vLLM model supports vision."""
        name_lower = model_id.lower()
        vision_patterns = ["vision", "llava", "minicpm-v"]
        return any(pattern in name_lower for pattern in vision_patterns)

    @staticmethod
    def _is_valid_deepseek_model(model_id: str) -> bool:
        """Check if the model is a valid DeepSeek model."""
        if not model_id:
            return False

        # DeepSeek model patterns - updated to match actual API response
        valid_patterns = ["deepseek-chat", "deepseek-coder", "deepseek-reasoner", "deepseek-r1"]
        return any(pattern in model_id.lower() for pattern in valid_patterns)

    @staticmethod
    def _is_valid_lmstudio_model(model_id: str) -> bool:
        """Check if the model is a valid LM Studio model."""
        if not model_id:
            return False

        # LM Studio can host any model, so we accept all non-empty model IDs
        # This is because LM Studio is a local model server that can load various models
        return True

    @staticmethod
    def _determine_deepseek_model_type(model_id: str) -> str:
        """Determine model type for DeepSeek models."""
        name_lower = model_id.lower()

        if "r1" in name_lower or "reasoner" in name_lower:
            return "NORMAL"  # All models use dynamic reasoning detection

        return "NORMAL"

    @staticmethod
    def _get_deepseek_context_length(model_id: str) -> int:
        """Get context length for DeepSeek models."""
        name_lower = model_id.lower()

        if "r1" in name_lower or "reasoner" in name_lower:
            return 131072  # DeepSeek R1/Reasoner has 128K context
        elif "coder" in name_lower:
            return 16384  # DeepSeek Coder has 16K context

        return 32768  # Default for DeepSeek Chat

    @staticmethod
    def _get_deepseek_input_cost(model_id: str) -> float:
        """Get input cost per 1K tokens for DeepSeek models."""
        name_lower = model_id.lower()

        if "r1" in name_lower or "reasoner" in name_lower:
            return 0.0014  # DeepSeek R1/Reasoner pricing
        elif "coder" in name_lower:
            return 0.00014  # DeepSeek Coder pricing

        return 0.00014  # DeepSeek Chat pricing

    @staticmethod
    def _get_deepseek_output_cost(model_id: str) -> float:
        """Get output cost per 1K tokens for DeepSeek models."""
        name_lower = model_id.lower()

        if "r1" in name_lower or "reasoner" in name_lower:
            return 0.0028  # DeepSeek R1/Reasoner pricing
        elif "coder" in name_lower:
            return 0.00028  # DeepSeek Coder pricing

        return 0.00028  # DeepSeek Chat pricing

    @staticmethod
    def _deepseek_supports_tools(_model_id: str) -> bool:
        """Check if DeepSeek model supports function calling."""
        # Most DeepSeek models support tools
        return True

    @staticmethod
    def _deepseek_supports_vision(_model_id: str) -> bool:
        """Check if DeepSeek model supports vision."""
        # Currently, DeepSeek models don't support vision
        return False

    @staticmethod
    def _is_valid_anthropic_model(model_id: str) -> bool:
        """Check if the model is a valid Anthropic model."""
        if not model_id:
            return False

        # Anthropic model patterns - Claude models
        valid_patterns = ["claude"]
        return any(pattern in model_id.lower() for pattern in valid_patterns)

    @staticmethod
    def _get_anthropic_context_length(model_name: str) -> int:
        """Get context length for Anthropic models."""
        model_lower = model_name.lower()
        context_map = {
            "claude-opus-4": 200000,
            "claude-sonnet-4": 200000,
            "claude-haiku-4": 200000,
            "claude-3-7-sonnet": 200000,
            "claude-3-5-sonnet": 200000,
            "claude-3-5-haiku": 200000,
            "claude-3-opus": 200000,
            "claude-3-sonnet": 200000,
            "claude-3-haiku": 200000,
        }
        for pattern, ctx in context_map.items():
            if pattern in model_lower:
                return ctx
        return 200000  # Anthropic default

    @staticmethod
    def _get_anthropic_input_cost(model_name: str) -> float:
        """Get input cost per 1K tokens for Anthropic models."""
        model_lower = model_name.lower()
        cost_map = {
            "claude-opus-4": 0.015,
            "claude-sonnet-4": 0.003,
            "claude-haiku-4": 0.0008,
            "claude-3-7-sonnet": 0.003,
            "claude-3-5-sonnet": 0.003,
            "claude-3-5-haiku": 0.0008,
            "claude-3-opus": 0.015,
            "claude-3-sonnet": 0.003,
            "claude-3-haiku": 0.00025,
        }
        for pattern, cost in cost_map.items():
            if pattern in model_lower:
                return cost
        return 0.003  # Default

    @staticmethod
    def _get_anthropic_output_cost(model_name: str) -> float:
        """Get output cost per 1K tokens for Anthropic models."""
        model_lower = model_name.lower()
        cost_map = {
            "claude-opus-4": 0.075,
            "claude-sonnet-4": 0.015,
            "claude-haiku-4": 0.004,
            "claude-3-7-sonnet": 0.015,
            "claude-3-5-sonnet": 0.015,
            "claude-3-5-haiku": 0.004,
            "claude-3-opus": 0.075,
            "claude-3-sonnet": 0.015,
            "claude-3-haiku": 0.00125,
        }
        for pattern, cost in cost_map.items():
            if pattern in model_lower:
                return cost
        return 0.015  # Default

    def _get_deepseek_fallback_models(self) -> list[dict[str, Any]]:
        """Get fallback DeepSeek models when API authentication fails."""
        fallback_model_ids = ["deepseek-chat", "deepseek-coder", "deepseek-r1"]

        fallback_models = []
        for model_id in fallback_model_ids:
            metadata = self._get_model_metadata_by_provider(model_id, "deepseek")
            metadata["model_name"] = model_id
            fallback_models.append(metadata)

        return fallback_models
