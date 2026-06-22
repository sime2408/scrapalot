"""
Model downloader utility for pre-downloading Docling and other ML models.

This module handles downloading models at startup or during Docker build
to ensure they're available offline and avoid download delays during processing.
"""

import os
import platform
import time

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def _mount_cloud_storage_if_needed():
    """
    Check for cloud storage availability.
    Since we're using Scrapalot with persistent disk storage, cloud mounting is no longer needed.
    Returns False to indicate no cloud models are available.
    """
    logger.info("🌩️ Checking cloud storage availability for production environment...")

    # Scrapalot configuration uses persistent disk storage instead of cloud mounting
    logger.info("⚠️ Cloud storage mounting skipped - Scrapalot environment uses persistent disk storage")
    logger.info("🔄 Will rely on local model downloads from Hugging Face to persistent storage")

    return False


def _get_embedding_models_from_config():
    """
    Extract embedding models from the config.yaml configuration.

    Returns:
        List of embedding model configurations
    """
    try:
        # Try to load config directly from the YAML file as fallback.
        # File now lives at src/main/utils/models/downloader.py -> go up 5 dirnames to project root.
        # noinspection PyTypeChecker
        project_root = str(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))))
        config_path = os.path.join(project_root, "configs", "config.yaml")

        if not os.path.exists(config_path):
            logger.warning("Config file not found at: %s", config_path)
            return []

        import yaml

        with open(config_path, encoding="utf-8") as f:
            config = yaml.safe_load(f)

        if not config:
            logger.warning("Could not load configuration from %s", config_path)
            return []

        embedding_models = []

        # Get models from defaults.embedding.preferred_models
        defaults_embedding = config.get("defaults", {}).get("embedding", {})
        preferred_models = defaults_embedding.get("preferred_models", [])

        # Helper to convert repo_id to a local dir name
        def _to_local_embedding_dir_name(repo_id: str) -> str:
            """Map a HuggingFace repo_id to our local embeddings directory name.
            Examples:
              - "intfloat/multilingual-e5-large-instruct" -> "intfloat--multilingual-e5-large-instruct"
              - "sentence-transformers/all-MiniLM-L6-v2" -> "all-MiniLM-L6-v2"
            """
            if not repo_id:
                return ""
            if "/" in repo_id:
                org, model_part = repo_id.split("/", 1)
                if org in ["sentence-transformers"]:
                    return model_part
                return f"{org}--{model_part}"
            return repo_id

        for model_repo_id in preferred_models:
            # Extract the model name from repo_id with proper handling for different formats
            model_name = _to_local_embedding_dir_name(model_repo_id)

            # Avoid duplicates by checking both repo_id and converted name
            if not any(em["repo_id"] == model_repo_id or em["name"] == model_name for em in embedding_models):
                embedding_models.append(
                    # All embedding models go in embeddings/huggingface/
                    {"name": model_name, "repo_id": model_repo_id, "type": "huggingface"}
                )

        # Also get models from documents.metadata_extraction.preferred_models (embedding models only)
        metadata_preferred = config.get("documents", {}).get("metadata_extraction", {}).get("preferred_models", [])

        for model_repo_id in metadata_preferred:
            # Only include models that are clearly embedding models (contain common embedding model patterns)
            if any(pattern in model_repo_id.lower() for pattern in ["embed", "minilm", "e5-", "bge-", "gte-", "instructor"]):
                # Extract model name with proper handling for different formats
                model_name = _to_local_embedding_dir_name(model_repo_id)

                # Avoid duplicates by checking both repo_id and converted name
                if not any(em["repo_id"] == model_repo_id or em["name"] == model_name for em in embedding_models):
                    embedding_models.append({"name": model_name, "repo_id": model_repo_id, "type": "huggingface"})

        # Get a reranker model from rag.reranker_model
        reranker_model = config.get("rag", {}).get("reranker_model")

        # Resolve environment variable patterns like ${RAG_RERANKER_MODEL:-all-MiniLM-L6-v2}
        if reranker_model and reranker_model.startswith("${") and reranker_model.endswith("}"):
            # Extract default value from ${VAR:-default} pattern
            if ":-" in reranker_model:
                default_value = reranker_model.split(":-", 1)[1].rstrip("}")
                reranker_model = default_value
            else:
                # Try to get from environment or skip
                var_name = reranker_model[2:-1]  # Remove ${ and }
                reranker_model = os.environ.get(var_name)

        if reranker_model and any(pattern in reranker_model.lower() for pattern in ["embed", "minilm", "e5-", "bge-", "gte-", "instructor"]):
            # Extract model name with proper handling for different formats
            model_name = _to_local_embedding_dir_name(reranker_model)

            # Avoid duplicates by checking both repo_id and converted name
            if not any(em["repo_id"] == reranker_model or em["name"] == model_name for em in embedding_models):
                embedding_models.append({"name": model_name, "repo_id": reranker_model, "type": "huggingface"})

        logger.info("Found %d embedding models in configuration", len(embedding_models))
        for model in embedding_models:
            logger.info("  - %s (%s)", model["name"], model["repo_id"])

        return embedding_models

    except Exception as ex:
        logger.warning("Failed to load embedding models from config: %s", str(ex))
        return []


def configure_huggingface_environment():
    """Configure HuggingFace environment variables and create proper directory structure."""
    try:
        # Get the project root directory for local model storage.
        # File now lives at src/main/utils/models/downloader.py -> go up 4 levels.
        current_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.abspath(os.path.join(current_dir, "..", "..", "..", ".."))

        # Base models directory following the documented structure from README_MODEL_MANAGEMENT.md
        base_models_dir = os.path.join(project_root, "data", "models")
        contents = os.listdir(base_models_dir) if os.path.exists(base_models_dir) else "Directory does not exist"
        logger.info("Models directory contents: %s", contents)

        # Note: Removed global HF_HUB_OFFLINE setting to allow model search API calls
        # Individual model loading will handle offline mode as needed

        # HuggingFace cache directory (for general HF operations)
        hf_cache_dir = os.path.join(base_models_dir, "huggingface")

        # Create the complete directory structure as documented
        directories_to_create = [
            base_models_dir,
            hf_cache_dir,
            os.path.join(base_models_dir, "gguf"),  # LLM models in GGUF format
            os.path.join(base_models_dir, "embeddings"),  # All embedding models
            os.path.join(base_models_dir, "embeddings", "gguf"),  # GGUF embedding models
            os.path.join(base_models_dir, "embeddings", "huggingface"),  # HuggingFace embedding models
            os.path.join(base_models_dir, "cache"),  # Model cache and temporary files
            os.path.join(base_models_dir, "cache", "downloads"),
        ]

        for directory in directories_to_create:
            os.makedirs(directory, exist_ok=True)

        # Configure HuggingFace cache directory
        os.environ["HF_HOME"] = hf_cache_dir
        os.environ["HUGGINGFACE_HUB_CACHE"] = hf_cache_dir

        # Windows-specific configuration to avoid symlink issues
        if platform.system() == "Windows":
            os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
            os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"
            logger.info("Applied Windows-specific HuggingFace configuration (symlinks disabled)")

        # General HuggingFace optimizations
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        os.environ["HF_HUB_DISABLE_EXPERIMENTAL_WARNING"] = "1"

        logger.info("Models directory structure created: %s", base_models_dir)
        logger.info("HuggingFace cache configured: %s", hf_cache_dir)
        return base_models_dir

    except Exception as ex:
        logger.warning("Failed to configure HuggingFace environment: %s", str(ex))
        return None


def _download_with_timeout_and_retry(repo_id: str, local_dir: str, max_retries: int = 3, timeout_seconds: int = 300) -> bool:
    """
    Download a model with timeout and retry mechanisms.

    Args:
        repo_id: HuggingFace repository ID
        local_dir: Local directory to download to
        max_retries: Maximum number of retry attempts
        timeout_seconds: Timeout in seconds for each attempt

    Returns:
        True if download successful, False otherwise
    """
    import signal
    import threading

    from huggingface_hub import snapshot_download

    def timeout_handler(_signum, _frame):
        raise TimeoutError("Download timeout exceeded")

    for attempt in range(max_retries):
        try:
            logger.info("Download attempt %s/%s for %s", attempt + 1, max_retries, repo_id)

            # Set up timeout (Unix-like systems)
            if platform.system() != "Windows":
                signal.signal(signal.SIGALRM, timeout_handler)
                signal.alarm(timeout_seconds)

            # Download with timeout wrapper for Windows
            if platform.system() == "Windows":
                download_success: list = [False]
                download_error: list = [None]

                def download_thread():
                    try:
                        snapshot_download(
                            repo_id=repo_id,
                            local_dir=local_dir,
                            local_files_only=False,
                            resume_download=True,  # Resume partial downloads
                        )
                        download_success[0] = True
                    except Exception as thread_exc:
                        download_error[0] = thread_exc

                thread = threading.Thread(target=download_thread)
                thread.daemon = True
                thread.start()
                thread.join(timeout=timeout_seconds)

                if thread.is_alive():
                    logger.warning("Download timeout after %s seconds, attempt %s", timeout_seconds, attempt + 1)
                    # Thread will be cleaned up by daemon flag
                    if attempt < max_retries - 1:
                        time.sleep(5)  # Wait before retry
                        continue
                    else:
                        raise TimeoutError(f"Download timeout after {max_retries} attempts")

                if download_error[0]:
                    raise download_error[0]

                if not download_success[0]:
                    raise Exception("Download failed for unknown reason")

            else:
                # Unix-like systems with signal-based timeout
                snapshot_download(repo_id=repo_id, local_dir=local_dir, local_files_only=False, resume_download=True)
                signal.alarm(0)  # Cancel timeout

            logger.info("✓ Successfully downloaded %s to %s", repo_id, local_dir)
            return True

        except (TimeoutError, Exception) as e:
            if platform.system() != "Windows":
                signal.alarm(0)  # Cancel timeout

            logger.warning("Download attempt %s failed: %s", attempt + 1, str(e))

            if attempt < max_retries - 1:
                wait_time = (attempt + 1) * 10  # Exponential backoff
                logger.info("Retrying in %s seconds...", wait_time)
                time.sleep(wait_time)
            else:
                logger.error("All %s download attempts failed for %s", max_retries, repo_id)
                return False

    return False


def download_docling_models(_force_download: bool = False) -> bool:
    """
    Download Docling models to the proper directory structure.
    Skips download on CPU-only systems since PyMuPDF4LLM is used instead.

    Args:
        force_download: If True, re-download even if models exist

    Returns:
        True if models are available (downloaded or already cached), False otherwise
        :param _force_download:
    """
    try:
        logger.info("Checking Docling model requirements...")
        start_time = time.time()

        # Check if we have GPU capability - if not, skip Docling models
        try:
            from src.main.utils.gpu.devices import get_device_type

            device_type = get_device_type()
            has_gpu = device_type in ["cuda", "mps", "rocm"]

            if not has_gpu:
                logger.info("🔍 CPU-only system detected (device: %s)", device_type)
                logger.info("📥 Downloading Docling models (needed for OCR documents even on CPU)")
                logger.info("💡 PyMuPDF4LLM will be used for clean PDFs, Docling for OCR/scanned documents")
            else:
                logger.info("🚀 GPU system detected - proceeding with Docling model download...")

        except Exception as e:
            logger.warning("Could not detect GPU capability: %s - proceeding with download", str(e))
            logger.info("📥 Downloading Docling models to support OCR document processing")

        # Configure HuggingFace environment and get base models directory
        base_models_dir = configure_huggingface_environment()
        if not base_models_dir:
            logger.error("Failed to configure HuggingFace environment")
            return False

        # Docling models go in the huggingface directory (they're not embeddings)
        docling_models_dir = os.path.join(base_models_dir, "huggingface")

        # Try to import Docling components (use fallback if not available)
        try:
            # Import check only - we'll use HuggingFace Hub directly for reliability
            import docling  # noqa: F401

            logger.info("Docling library available")
        except ImportError as e:
            logger.warning("Docling not available: %s", str(e))

        # Download the main layout model used by Docling
        model_name = "ds4sd/docling-layout-heron"
        logger.info("Downloading Docling layout model: %s", model_name)

        try:
            # Ensure symlinks are disabled for Windows compatibility (belt and suspenders approach)
            if platform.system() == "Windows":
                os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"
                os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

            # Create a specific directory for this model in the huggingface directory
            model_dir = os.path.join(docling_models_dir, "docling-layout-heron")
            os.makedirs(model_dir, exist_ok=True)

            # Check if model already exists and is complete (unless force download)
            if not _force_download:
                essential_files = ["config.json", "model.safetensors"]
                if all(os.path.exists(os.path.join(model_dir, f)) for f in essential_files):
                    logger.info("✓ Docling model already exists and appears complete")
                    return True

            # Use improved download function with timeout and retry
            # noinspection PyShadowingNames
            success = _download_with_timeout_and_retry(
                repo_id=model_name,
                local_dir=model_dir,
                max_retries=3,
                timeout_seconds=300,  # 5 minutes per attempt
            )

            if success:
                elapsed = time.time() - start_time
                logger.info("✓ Docling models downloaded successfully in %.1f seconds", elapsed)
                return True
            else:
                logger.error("Failed to download Docling models after all retry attempts")
                return False

        except Exception as e:
            logger.error("Failed to download Docling models: %s", str(e))
            return False

    except Exception as ex:
        logger.error("Unexpected error during model download: %s", str(ex))
        return False


def verify_models_available() -> bool:
    """
    Verify that required models are available in the proper directory structure.

    Returns:
        True if models are available, False otherwise
    """
    try:
        # Get base models directory
        base_models_dir = configure_huggingface_environment()
        if not base_models_dir:
            logger.warning("Models directory not configured")
            return False

        models_found = True

        # Check Docling models only if we have GPU capability
        try:
            from src.main.utils.gpu.devices import get_device_type

            device_type = get_device_type()

            # Check for Docling models regardless of GPU (needed for OCR on CPU)
            logger.info("Checking for Docling models (device: %s)...", device_type)
            hf_cache_dir = os.path.join(base_models_dir, "huggingface")

            # Check for Docling models in both possible locations:
            # 1. Standard HuggingFace cache structure
            cache_model_path = os.path.join(hf_cache_dir, "models--ds4sd--docling-layout-heron")
            # 2. Our local_dir structure
            local_model_path = os.path.join(hf_cache_dir, "docling-layout-heron")

            docling_found = False
            if os.path.exists(cache_model_path) and os.path.isdir(cache_model_path):
                logger.info("✓ Docling models found in HF cache: %s", cache_model_path)
                docling_found = True
            elif os.path.exists(local_model_path) and os.path.isdir(local_model_path):
                # Check if essential model files exist
                essential_files = ["config.json", "model.safetensors"]
                all_files_exist = all(os.path.exists(os.path.join(local_model_path, f)) for f in essential_files)
                if all_files_exist:
                    logger.info("✓ Docling models found in local dir: %s", local_model_path)
                    docling_found = True
                else:
                    logger.warning("✗ Docling model directory exists but missing essential files: %s", local_model_path)

            if not docling_found:
                logger.warning("✗ Docling models not found")
                models_found = False

        except Exception as e:
            logger.warning("Could not verify Docling models: %s", str(e))
            logger.warning("Docling may not be available for OCR document processing")

        # Check embedding models from config
        embedding_models_dir = os.path.join(base_models_dir, "embeddings", "huggingface")
        config_embedding_models = _get_embedding_models_from_config()

        # If no config models, check default
        if not config_embedding_models:
            config_embedding_models = [{"name": "all-MiniLM-L6-v2", "repo_id": "sentence-transformers/all-MiniLM-L6-v2", "type": "huggingface"}]

        # Debug: Log the embedding models directory structure
        logger.info("🔍 Checking embedding models in: %s", embedding_models_dir)
        if os.path.exists(embedding_models_dir):
            try:
                embedding_dir_contents = os.listdir(embedding_models_dir)
                logger.info("🔍 Embedding directory contents: %s", embedding_dir_contents)
            except Exception as e:
                logger.warning("🔍 Could not list embedding directory contents: %s", str(e))
        else:
            logger.warning("🔍 Embedding models directory does not exist: %s", embedding_models_dir)
            # Check if models might be in the main huggingface directory instead
            main_hf_dir = os.path.join(base_models_dir, "huggingface")
            if os.path.exists(main_hf_dir):
                try:
                    main_hf_contents = os.listdir(main_hf_dir)
                    logger.info("🔍 Main HuggingFace directory contents: %s", main_hf_contents)
                except Exception as e:
                    logger.warning("🔍 Could not list main HF directory contents: %s", str(e))

        embedding_models_found = 0
        for model_info in config_embedding_models:
            model_name = model_info["name"]
            model_path = os.path.join(embedding_models_dir, model_name)

            # Debug: Log what we're looking for
            logger.info("🔍 Looking for embedding model '%s' at: %s", model_name, model_path)

            if os.path.exists(model_path) and os.path.isdir(model_path):
                # Check if essential embedding files exist
                essential_embedding_files = ["config.json", "pytorch_model.bin", "model.safetensors"]
                embedding_files_exist = any(os.path.exists(os.path.join(model_path, f)) for f in essential_embedding_files)
                if embedding_files_exist:
                    logger.info("✓ Embedding model found: %s", model_path)
                    embedding_models_found += 1
                else:
                    logger.warning("✗ Embedding model directory exists but missing essential files: %s", model_path)
                    # Debug: Show what files are actually there
                    try:
                        actual_files = os.listdir(model_path)
                        logger.info("🔍 Files in model directory: %s", actual_files)
                    except Exception as e:
                        logger.warning("🔍 Could not list model directory files: %s", str(e))
            else:
                logger.warning("✗ Embedding model not found: %s", model_path)

                # Check alternative locations where the model might be
                # 1. Check in main huggingface directory
                alt_path_1 = os.path.join(base_models_dir, "huggingface", model_name)
                if os.path.exists(alt_path_1):
                    logger.info("🔍 Found model in alternative location: %s", alt_path_1)

                # 2. Check for HuggingFace cache format (models--org--model)
                repo_id = model_info.get("repo_id", "")
                if repo_id:
                    cache_name = f"models--{repo_id.replace('/', '--')}"
                    alt_path_2 = os.path.join(base_models_dir, "huggingface", cache_name)
                    if os.path.exists(alt_path_2):
                        logger.info("🔍 Found model in HF cache format: %s", alt_path_2)

        if embedding_models_found == 0:
            logger.warning("✗ No embedding models found")
            models_found = False
        elif embedding_models_found < len(config_embedding_models):
            logger.warning("⚠️ Found %d/%d embedding models (some missing)", embedding_models_found, len(config_embedding_models))
            models_found = False
        else:
            logger.info("✓ Found %d/%d embedding models", embedding_models_found, len(config_embedding_models))

        # Summary log
        if models_found:
            logger.info("Model verification complete: All required models are available")
        else:
            logger.warning("❌ Model verification complete: Some required models are missing")
            logger.info("💡 Missing models will be downloaded automatically")

        return models_found

    except Exception as ex:
        logger.error("Error verifying model availability: %s", str(ex))
        return False


def download_embedding_models(base_models_dir: str, force_download: bool = False) -> bool:
    """
    Download embedding models from config.yaml and essential defaults.

    Args:
        base_models_dir: Base models directory path
        force_download: If True, re-download even if models exist

    Returns:
        True if embedding models are available, False otherwise
    """
    try:
        logger.info("Starting embedding model download...")
        start_time = time.time()

        # Get embedding models from config.yaml
        embedding_models = _get_embedding_models_from_config()

        if not embedding_models:
            logger.info("No embedding models found in config, using defaults")
            # Fallback to essential embedding models as documented in README_MODEL_MANAGEMENT.md
            embedding_models = [
                {
                    "name": "all-MiniLM-L6-v2",
                    "repo_id": "sentence-transformers/all-MiniLM-L6-v2",
                    "type": "huggingface",  # This goes in embeddings/huggingface/
                }
            ]

        # noinspection PyShadowingNames
        success = True

        for model_info in embedding_models:
            try:
                model_name = model_info["name"]
                repo_id = model_info["repo_id"]
                model_type = model_info["type"]

                # Determine target directory based on model type
                if model_type == "huggingface":
                    target_dir = os.path.join(base_models_dir, "embeddings", "huggingface", model_name)
                elif model_type == "gguf":
                    target_dir = os.path.join(base_models_dir, "embeddings", "gguf", model_name)
                else:
                    logger.warning("Unknown embedding model type: %s", model_type)
                    continue

                # Check if the model already exists (unless force download)
                if not force_download and os.path.exists(target_dir) and os.listdir(target_dir):
                    logger.info("✓ Embedding model already exists: %s", model_name)
                    continue

                logger.info("Downloading embedding model: %s to %s", model_name, target_dir)
                os.makedirs(target_dir, exist_ok=True)

                # Ensure symlinks are disabled for Windows compatibility (belt and suspenders approach)
                if platform.system() == "Windows":
                    os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"
                    os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

                # Use improved download function with timeout and retry
                # noinspection PyShadowingNames
                success = _download_with_timeout_and_retry(
                    repo_id=repo_id,
                    local_dir=target_dir,
                    max_retries=3,
                    timeout_seconds=300,  # 5 minutes per attempt
                )

                if not success:
                    raise Exception(f"Failed to download {model_name} after all retry attempts")

                logger.info("✓ Downloaded embedding model: %s", model_name)

            except Exception as e:
                logger.error("Failed to download embedding model %s: %s", model_info.get("name", "unknown"), str(e))
                # noinspection PyShadowingNames
                success = False

        elapsed = time.time() - start_time
        if success:
            logger.info("✓ All embedding models downloaded successfully in %.1f seconds", elapsed)
        else:
            logger.warning("⚠️ Some embedding models failed to download (%.1f seconds)", elapsed)

        return success

    except Exception as ex:
        logger.error("Unexpected error during embedding model download: %s", str(ex))
        return False


def download_spacy_models(force_download: bool = False) -> bool:
    """
    Download spaCy models for NLP processing.

    Args:
        force_download: If True, re-download even if models exist

    Returns:
        True if spaCy models are available, False otherwise
    """
    try:
        logger.info("Starting spaCy model download...")
        start_time = time.time()

        import spacy
        from spacy.cli import download

        # Essential spaCy models for entity extraction
        spacy_models = [
            "en_core_web_md",  # Medium English model with word vectors (100MB)
        ]

        # noinspection PyShadowingNames
        success = True

        for model_name in spacy_models:
            try:
                # Check if the model is already available
                if not force_download:
                    try:
                        spacy.load(model_name)
                        logger.info("✓ spaCy model already available: %s", model_name)
                        continue
                    except OSError:
                        pass  # Model not found, need to download

                logger.info("Downloading spaCy model: %s", model_name)

                # Download the model
                download(model_name, direct=False, sdist=False)

                # Verify the download
                spacy.load(model_name)
                logger.info("✓ Downloaded and verified spaCy model: %s", model_name)

            except Exception as e:
                logger.error("Failed to download spaCy model %s: %s", model_name, str(e))
                # noinspection PyShadowingNames
                success = False

        elapsed = time.time() - start_time
        if success:
            logger.info("All spaCy models downloaded successfully in %.1f seconds", elapsed)
        else:
            logger.warning("⚠️ Some spaCy models failed to download (%.1f seconds)", elapsed)

        return success

    except Exception as ex:
        logger.error("Unexpected error during spaCy model download: %s", str(ex))
        return False


def download_all_models(force_download: bool = False) -> bool:
    """
    Download all required models for the application.

    Args:
        force_download: If True, re-download even if models exist

    Returns:
        True if all models are available, False otherwise
    """
    logger.info("=== Model Download Process Started ===")

    # Configure environment and get base directory
    base_models_dir = configure_huggingface_environment()
    if not base_models_dir:
        logger.error("Failed to configure models environment")
        return False

    # noinspection PyShadowingNames
    success = True

    # Download Docling models (for document processing)
    if not download_docling_models(_force_download=force_download):
        logger.error("Failed to download Docling models")
        # noinspection PyShadowingNames
        success = False

    # Download embedding models (for RAG and similarity search)
    if not download_embedding_models(base_models_dir, force_download):
        logger.error("Failed to download embedding models")
        # noinspection PyShadowingNames
        success = False

    # Download spaCy models (for entity extraction)
    if not download_spacy_models(force_download):
        logger.error("Failed to download spaCy models")
        # noinspection PyShadowingNames
        success = False

    # Add other model downloads here as needed,
    # For example, LLM models, specialized models, etc.

    if success:
        logger.info("=== All Models Downloaded Successfully ===")
    else:
        logger.error("=== Some Models Failed to Download ===")

    return success


def ensure_models_available(force_immediate_download: bool = False) -> bool:
    """
    Ensure models are available, downloading if necessary.

    Args:
        force_immediate_download: If True, download missing models immediately instead of in background

    Note: Cloud storage mounting is now handled at app startup in app_instance.py
    to ensure it happens before any code accesses /app/data/models.

    Returns:
        True if models are available, False otherwise
    """
    # Configure environment first to check for cloud models
    base_models_dir = configure_huggingface_environment()
    if not base_models_dir:
        logger.warning("Failed to configure models environment")
        return False

    # First, check if models are already available locally
    models_available = verify_models_available()
    if models_available:
        logger.info("All required models already available in local cache")
        return True

    # Models are missing - log the actual situation clearly
    logger.warning("⚠️ Some required models are missing from local cache")

    if force_immediate_download:
        # Download models immediately (blocking)
        logger.info("🔄 Starting immediate model download (this may take a few minutes)...")
        # noinspection PyShadowingNames
        success = download_all_models(force_download=False)
        if success:
            logger.info("Immediate model download completed successfully")
            return True
        else:
            logger.error("❌ Immediate model download failed")
            return False
    else:
        # Download models in background (non-blocking)
        logger.info("🔄 Starting background model download to avoid blocking app startup...")
        import threading

        def background_download():
            try:
                logger.info("📥 Background model download started...")
                dl_success = download_all_models(force_download=False)
                if dl_success:
                    logger.info("Background model download completed successfully")
                else:
                    logger.error("❌ Background model download failed - some models may be unavailable")
            except Exception as e:
                logger.error("❌ Background model download error: %s", e)

        # Start download in background thread
        download_thread = threading.Thread(target=background_download, daemon=True)
        download_thread.start()

        # Return True so app can start - models will download in background
        logger.info("🚀 App starting with background model download in progress...")
        logger.info("💡 Note: Some features may be limited until model download completes")
        return True


if __name__ == "__main__":
    # Allow running this module directly for testing or manual downloads
    import sys

    force = "--force" in sys.argv
    immediate = "--immediate" in sys.argv

    if force:
        # Force re-download all models
        success = download_all_models(force_download=True)
    elif immediate:
        # Ensure models are available with immediate download
        success = ensure_models_available(force_immediate_download=True)
    else:
        # Default behavior (background download)
        success = ensure_models_available(force_immediate_download=False)

    if success:
        print("✓ All models are available")
        sys.exit(0)
    else:
        print("✗ Failed to ensure models are available")
        sys.exit(1)
