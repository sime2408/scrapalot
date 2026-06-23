"""
Application initialization utilities.

This module provides functions for heavy initialization tasks including
- Database setup and configuration
- Redis configuration
- Model deployment and preloading
- Service prewarming
- Background initialization
"""

import asyncio
import time

from fastapi import FastAPI

from src.main.config.database import (
    SQLALCHEMY_DATABASE_URL,
    engine,
    init_db,
    setup_database_connection,
)
from src.main.utils.config.loader import resolved_config, resolved_secrets
from src.main.utils.core.logger import get_logger
from src.main.utils.startup.monitor import startup_monitor
from src.main.utils.startup.state import get_startup_state

logger = get_logger(__name__)


def _build_redis_url():
    """
    Build Redis URL from configuration components.
    Handles empty or whitespace-only passwords properly.
    Returns the constructed Redis URL string.
    """
    import os

    try:
        # First try to use REDIS_URL environment variable (Docker/cloud environments)

        redis_url_env = os.environ.get("REDIS_URL")
        if redis_url_env:
            # Add password if provided separately
            redis_password = resolved_secrets.get("redis_password") if resolved_secrets else None
            # noinspection PyUnresolvedReferences
            if redis_password and redis_password.strip():
                # Parse the URL and add password if not already included
                if ":" not in redis_url_env.split("@")[-1].split("/")[0] or "@" not in redis_url_env:
                    # URL doesn't have password, add it
                    if "://" in redis_url_env:
                        scheme, rest = redis_url_env.split("://", 1)
                        return f"{scheme}://:{redis_password}@{rest}"
            masked_url = redis_url_env.replace(str(redis_password), "***") if redis_password else redis_url_env
            logger.info("Using Redis URL from environment: %s", masked_url)
            return redis_url_env

        # Fallback to building from config components
        if resolved_config is None or resolved_secrets is None:
            logger.warning("Config not fully initialized, using defaults")
            default_port = os.environ.get("REDIS_PORT", "6379")
            return f"redis://redis:{default_port}/0"  # Use service name in Docker

        redis_config = resolved_config.get("redis", {})
        redis_host = redis_config.get("host", "redis")  # Use service name by default
        redis_port = redis_config.get("port", 6379)  # Use standard Redis port
        redis_password = resolved_secrets.get("redis_password", "")
        redis_db = redis_config.get("db", 0)

        # Handle empty or whitespace-only passwords
        if redis_password and redis_password.strip():
            return f"redis://:{redis_password}@{redis_host}:{redis_port}/{redis_db}"
        else:
            return f"redis://{redis_host}:{redis_port}/{redis_db}"

    except Exception as e:
        logger.warning("Error building Redis URL, using defaults: %s", str(e))
        default_port = os.environ.get("REDIS_PORT", "6379")
        return f"redis://redis:{default_port}/0"  # Use service name in Docker


async def _recover_stuck_jobs():
    """Reset jobs and documents stuck from a previous crash/restart."""
    from sqlalchemy import text

    from src.main.config.database import SessionLocal

    db = SessionLocal()
    try:
        stuck_running = db.execute(
            text(
                "UPDATE jobs SET status = 'pending', error_message = 'Reset after server restart' "
                "WHERE status = 'running' AND updated_at < NOW() - INTERVAL '10 minutes' "
                "RETURNING id"
            )
        ).fetchall()

        if stuck_running:
            logger.info("Reset %d stuck running jobs to pending", len(stuck_running))

        orphaned = db.execute(
            text(
                "UPDATE documents SET processing_status = 'pending' "
                "WHERE processing_status IN ('processing') "
                "AND id NOT IN ("
                "  SELECT document_id FROM jobs WHERE status IN ('pending', 'running') AND document_id IS NOT NULL"
                ") "
                "AND deleted_at IS NULL "
                "RETURNING id"
            )
        ).fetchall()

        if orphaned:
            logger.info("Reset %d orphaned processing documents to pending", len(orphaned))

        db.commit()
    except Exception as e:
        logger.error("Failed to recover stuck jobs: %s", e)
        db.rollback()
    finally:
        db.close()


async def run_heavy_initialization(app_instance=None):
    """
    Run all heavy initialization tasks in the background after the server starts.
    This function handles database setup, Redis configuration, model deployment, and diagnostics.
    """
    startup_state = get_startup_state()

    try:
        logger.info("🚀 Starting background initialization tasks...")

        # Database connection setup (using module-level imports from run_service.py approach)
        startup_state.start_task("database_connection")
        try:
            if not engine:
                setup_database_connection()
                logger.info("Database connection confirmed.")

            startup_state.complete_task("database_connection", {"url": SQLALCHEMY_DATABASE_URL})
        except Exception as e1:
            startup_state.fail_task("database_connection", str(e1))
            logger.error("Failed to setup database connection: %s", str(e1))

        # Database schema initialization (using module-level imports)
        startup_state.start_task("database_schema")
        try:
            # Check if using SQLite and initialize database schema if needed
            # noinspection PyUnresolvedReferences
            if SQLALCHEMY_DATABASE_URL and "sqlite" in SQLALCHEMY_DATABASE_URL.lower():
                logger.info("SQLite database detected. Initializing database schema...")
                init_db()
                logger.info("Database schema initialization completed successfully.")

            startup_state.complete_task("database_schema")
        except Exception as e1:
            startup_state.fail_task("database_schema", str(e1))
            logger.error("Failed to initialize database schema: %s", str(e1))
            # Don't raise - let server continues running

        # Recover jobs stuck from a previous crash/restart
        try:
            await _recover_stuck_jobs()
        except Exception as e_recovery:
            logger.warning("Stuck job recovery failed (non-fatal): %s", e_recovery)

        # Redis setup with embedded fallback
        startup_state.start_task("redis_setup")
        try:
            from src.main.config.redis_embedded import (
                get_redis_config_with_truly_embedded_fallback,
            )

            # Build Redis URL using a utility function
            primary_redis_url = _build_redis_url()

            # Extract components for logging
            redis_config = resolved_config.get("redis", {})
            redis_host = redis_config.get("host", "localhost")
            redis_port = redis_config.get("port", 6379)
            redis_db = redis_config.get("db", 0)

            logger.info(
                "Attempting to connect to Redis at: redis://%s:%s/%s",
                redis_host,
                redis_port,
                redis_db,
            )

            redis_client, is_embedded = get_redis_config_with_truly_embedded_fallback(
                primary_redis_url=primary_redis_url, db_file=redis_config.get("db_file")
            )

            startup_state.complete_task(
                "redis_setup",
                {"embedded": is_embedded, "host": redis_host, "port": redis_port},
            )
            logger.info("Redis setup complete. Using embedded: %s", is_embedded)
        except Exception as e2:
            startup_state.fail_task("redis_setup", str(e2))
            logger.error("Failed to setup Redis: %s", str(e2))

        # Model deployment (optional)
        startup_state.start_task("model_deployment")
        try:
            # Check if auto-deployment is enabled
            auto_deploy = resolved_config.get("llm", {}).get("auto_deploy_on_startup", False)
            if auto_deploy:
                await _deploy_startup_models()
                startup_state.complete_task("model_deployment", {"auto_deployed": True})
            else:
                startup_state.complete_task("model_deployment", {"auto_deployed": False})
                logger.info("Model auto-deployment disabled - models can be deployed manually via UI")
        except Exception as e1:
            startup_state.fail_task("model_deployment", str(e1))
            logger.error("Failed to deploy startup models: %s", str(e1))

        # ML Models pre-download and preload (prevent delays during document processing)
        startup_state.start_task("model_download")
        try:
            logger.info("🤖 Pre-downloading and pre-loading ML models to prevent document processing delays...")

            from src.main.utils.models.downloader import download_docling_models, ensure_models_available

            model_start = time.time()

            # First, ensure Docling models are downloaded (critical for document processing)
            logger.info("📄 Pre-downloading Docling models for document processing...")
            docling_start = time.time()
            docling_success = download_docling_models(_force_download=False)
            docling_time = time.time() - docling_start

            if docling_success:
                logger.info("Docling models downloaded successfully in %.2f seconds", docling_time)
            else:
                logger.warning("⚠️ Docling models download failed - document processing may be slower")

            # Then explicitly download embedding models (critical for RAG functionality)
            logger.info("🔤 Pre-downloading embedding models for RAG functionality...")
            from src.main.utils.models.downloader import configure_huggingface_environment, download_embedding_models

            embedding_start = time.time()
            base_models_dir = configure_huggingface_environment()
            embedding_success = False
            embedding_time = 0.0  # Initialize with the default value

            if base_models_dir:
                embedding_success = download_embedding_models(base_models_dir, force_download=False)
                embedding_time = time.time() - embedding_start

                if embedding_success:
                    logger.info("Embedding models downloaded successfully in %.2f seconds", embedding_time)
                else:
                    logger.warning("⚠️ Embedding models download failed - RAG functionality may be limited")
            else:
                logger.error("❌ Failed to configure models environment for embedding downloads")

            # Finally, ensure all other models are available (background download for remaining)
            models_available = ensure_models_available()
            model_time = time.time() - model_start

            if models_available:
                logger.info("ML models downloaded successfully in %.2f seconds", model_time)

                # Schedule spaCy model preloading in the background (non-blocking)
                logger.info("🧠 Scheduling spaCy model pre-loading in background...")
                asyncio.create_task(_background_spacy_preload(app_instance))

                startup_state.complete_task(
                    "model_download",
                    {
                        "models_available": True,
                        "docling_available": docling_success,
                        "embedding_available": embedding_success,
                        "download_time": model_time,
                        "docling_time": docling_time,
                        "embedding_time": embedding_time if "embedding_time" in locals() else 0,
                        "spacy_preloaded": False,
                        "spacy_scheduled": True,
                    },
                )
            else:
                logger.warning("⚠️ Some ML models failed to download - will retry on-demand")
                startup_state.complete_task(
                    "model_download",
                    {
                        "models_available": False,
                        "docling_available": docling_success,
                        "embedding_available": embedding_success,
                        "download_time": model_time,
                        "docling_time": docling_time,
                        "embedding_time": embedding_time if "embedding_time" in locals() else 0,
                    },
                )

        except Exception as e:
            startup_state.fail_task("model_download", str(e))
            logger.warning("Failed to pre-download ML models: %s", str(e))

        # Reranker model loading is not available in this edition (cross-encoder
        # reranking was removed). RAG falls back to MMR reranking at query time.
        startup_state.start_task("reranker_loading")
        logger.info("ℹ️ Reranker not available in this edition - RAG will use MMR reranking")
        startup_state.complete_task("reranker_loading", {"loaded": False})

        # Service pre-warming (prevent 61-second delays on first document request)
        startup_state.start_task("service_prewarming")
        try:
            logger.info("🔥 Pre-warming services (lightweight initialization)...")

            # Knowledge graph is not available in this edition - nothing heavy to
            # pre-warm here. Document operations run without graph integration.
            logger.info("ℹ️ Knowledge graph not available in this edition - skipping graph pre-warm")

            startup_state.complete_task("service_prewarming")

        except Exception as e:
            startup_state.fail_task("service_prewarming", str(e))
            logger.warning("Failed to pre-warm services: %s", str(e))

        # Production diagnostics
        startup_state.start_task("diagnostics")
        try:
            from src.main.utils.startup.diagnostics import log_startup_diagnostics

            log_startup_diagnostics()
            startup_state.complete_task("diagnostics")
        except Exception as e1:
            startup_state.fail_task("diagnostics", str(e1))
            logger.warning("Failed to run startup diagnostics: %s", str(e1))

        logger.info("Background initialization completed successfully")

    except Exception as e1:
        logger.error("Background initialization failed: %s", str(e1))
        # Don't raise - server should continue running


async def _deploy_startup_models():
    """
    Deploy models on startup if configured to do so.
    This function checks for available models and deploys the first suitable one.
    """
    try:
        logger.info("Starting automatic model deployment on startup")

        # Import here to avoid circular imports
        import os

        from src.main.config.database import SessionLocal
        from src.main.service.llm_inference import LLMInferenceService
        from src.main.service.local_models.model_service import start_service
        from src.main.utils.llm.provider_utils import get_system_provider

        # Get database session
        db = SessionLocal()
        try:
            # Get a local provider
            local_provider, _ = get_system_provider(db)
            if not local_provider:
                logger.warning("Local provider not found, skipping startup model deployment")
                return

            # Initialize LLM service to discover models
            llm_service = LLMInferenceService()
            await llm_service.initialize_local_models(db, None)  # Use None for a system-wide provider

            # Get models directory from config
            models_dir = resolved_config.get("llm", {}).get("local_ai", {}).get("models_dir", "models")

            # Check both LLM and embedding GGUF directories
            gguf_dirs = [
                os.path.join(models_dir, "gguf"),  # Main LLM models
                os.path.join(models_dir, "embeddings", "gguf"),  # Embedding models
            ]

            model_files = []
            selected_dir = None

            # Search for GGUF models in both directories (including subdirectories)
            for gguf_dir in gguf_dirs:
                if os.path.exists(gguf_dir):
                    # Search recursively for .gguf files in subdirectories
                    for r, _dirs, files in os.walk(gguf_dir):
                        gguf_files = [f for f in files if f.endswith(".gguf")]
                        if gguf_files:
                            model_files = gguf_files
                            selected_dir = r  # Use the actual directory containing the .gguf file
                            break
                    if model_files:
                        break

            if not model_files:
                logger.warning("No .gguf model files found in %s, skipping startup deployment", gguf_dirs)
                return

            # Use the first model found
            model_file = model_files[0]
            model_name = os.path.splitext(model_file)[0]
            model_path = str(os.path.join(selected_dir or "", model_file))

            logger.info("Deploying model %s on startup from %s", model_name, model_path)

            # Deploy the model using the service
            # noinspection PyTypeChecker
            result = await start_service(model_name, model_path)

            if result.get("success"):
                logger.info("Successfully deployed model %s on startup", model_name)
            else:
                logger.error("Failed to deploy model %s on startup: %s", model_name, result.get("message", "Unknown error"))

        finally:
            db.close()

    except Exception as ex:
        logger.exception("Error during startup model deployment: %s", str(ex))


async def _deploy_startup_models_background():
    """Deploy models in the background without blocking startup."""
    try:
        # Wait a bit to let the server fully start up first
        await asyncio.sleep(5.0)
        logger.info("🚀 Starting background model deployment...")
        await _deploy_startup_models()
    except Exception as e:
        logger.exception("❌ Error during background model deployment: %s", str(e))


async def _setup_redis_config_with_fallback():
    """Set up Redis configuration with a truly embedded fallback."""
    from src.main.config.redis_embedded import (
        get_redis_config_with_truly_embedded_fallback,
    )

    primary_redis_url = _build_redis_url()
    redis_password = resolved_secrets.get("redis_password")

    # Get Redis client or URL with truly embedded fallback
    redis_client_or_url, is_embedded = get_redis_config_with_truly_embedded_fallback(primary_redis_url)

    if is_embedded:
        # For embedded Redis, we have a client object
        return {
            "client": redis_client_or_url,
            "url": (redis_client_or_url.get_connection_url() if hasattr(redis_client_or_url, "get_connection_url") else "embedded://redis"),
            "password": None,  # Embedded Redis doesn't use password
            "is_embedded": True,
        }
    else:
        # For regular Redis, we have a URL
        return {
            "client": None,
            "url": redis_client_or_url,
            "password": redis_password,
            "is_embedded": False,
        }


async def _background_initialization(_app: FastAPI, redis_config: dict):
    """Background initialization of heavy components."""
    try:
        logger.info("Starting background initialization...")

        # Ensure resolved_config and resolved_secrets are accessible
        from src.main.utils.config.loader import resolved_config, resolved_secrets

        # Run production diagnostics for debugging deployment issues
        try:
            from src.main.utils.startup.diagnostics import log_startup_diagnostics

            log_startup_diagnostics()
        except Exception as diag_error:
            logger.warning("Failed to run startup diagnostics: %s", diag_error)

        # Enhanced Redis setup with embedded fallback (moved from run_service.py)
        logger.info("Setting up enhanced Redis configuration...")
        try:
            # Build Redis URL using a utility function
            redis_url = _build_redis_url()

            # Extract components for logging
            redis_config_settings = resolved_config.get("redis", {})
            redis_host = redis_config_settings.get("host", "localhost")
            redis_port = redis_config_settings.get("port", 6379)
            redis_db = redis_config_settings.get("db", 0)

            logger.info(
                "Redis configuration: host=%s, port=%s, db=%s",
                redis_host,
                redis_port,
                redis_db,
            )

            # Test Redis connection
            import redis

            redis_client = redis.from_url(redis_url, decode_responses=True)
            redis_client.ping()
            logger.info("Redis connection successful")
            redis_client.close()

            # Start Redis event subscriber for collection_workspace_map sync
            try:
                from src.main.service.redis_event_subscriber import start_redis_event_subscriber

                start_redis_event_subscriber()
                logger.info("Redis event subscriber started for collection_workspace_map sync")
            except Exception as sub_error:
                logger.warning("Failed to start Redis event subscriber: %s", sub_error)

            # Start job progress subscriber to bridge Celery worker progress to WebSocket
            try:
                from src.main.service.job_progress_subscriber import start_job_progress_subscriber

                start_job_progress_subscriber()
                logger.info("Job progress subscriber started for Celery worker progress bridging")
            except Exception as sub_error:
                logger.warning("Failed to start job progress subscriber: %s", sub_error)

        except Exception as redis_error:
            logger.warning("Redis connection failed, will use embedded fallback: %s", redis_error)
            # The existing _setup_redis_config_with_fallback will handle embedded Redis

        # SQLite database optimization (moved from run_service.py)
        logger.info("Optimizing SQLite database configuration...")
        try:
            from src.main.config.database import get_db, using_sqlite_fallback

            if using_sqlite_fallback:
                # Apply SQLite optimizations for production
                db = next(get_db())
                try:
                    from sqlalchemy import text

                    # Enable WAL mode for better concurrency
                    db.execute(text("PRAGMA journal_mode=WAL;"))
                    # Optimize SQLite settings
                    db.execute(text("PRAGMA synchronous=NORMAL;"))
                    db.execute(text("PRAGMA cache_size=10000;"))
                    db.execute(text("PRAGMA temp_store=MEMORY;"))
                    db.commit()
                    logger.info("SQLite optimizations applied")
                except Exception as pragma_error:
                    logger.warning("Could not apply SQLite optimizations: %s", pragma_error)
                finally:
                    db.close()
        except Exception as sqlite_error:
            logger.warning("SQLite optimization failed: %s", sqlite_error)

        # GPU Detection
        logger.info("Starting background GPU detection...")
        startup_monitor.checkpoint("GPU Detection Start")
        start_time = time.time()
        from src.main.utils.gpu.devices import get_device_type

        device_type = get_device_type()
        gpu_time = time.time() - start_time
        logger.info(
            "Background GPU detection completed. Device type: %s (took %.2f seconds)",
            device_type,
            gpu_time,
        )
        startup_monitor.checkpoint("GPU Detection Complete")

        # LLM Manager - already initialized as singleton, just store reference
        logger.info("Setting up LLM Manager...")
        startup_monitor.checkpoint("LLM Manager Start")
        start_time = time.time()
        from src.main.service.llm.llm_manager import llm_manager

        llm_time = time.time() - start_time
        logger.info("LLM Manager ready (took %.2f seconds)", llm_time)
        _app.state.llm_manager = llm_manager
        startup_monitor.checkpoint("LLM Manager Complete")

        # Preload embedding model and cache globally (system-wide, not per-user)
        logger.info("Pre-loading embedding model into global cache...")
        startup_monitor.checkpoint("Embedding Models Preload Start")
        start_time = time.time()
        try:
            from src.main.config.database import get_db
            from src.main.service.llm.embedding_cache import get_embedding_cache
            from src.main.service.llm.llm_embedding_factory import get_embeddings
            from src.main.utils.llm.model_utils import get_default_embedding_model

            # Get database session to query for available embedding models
            db = next(get_db())
            try:
                # Preload the default embedding model from database (provider_type='local', model_type='EMBEDDING')
                default_embedding_model = get_default_embedding_model("local", db=db)
                if default_embedding_model:
                    logger.info("Pre-loading default embedding model: %s", default_embedding_model)
                    embeddings = get_embeddings(model_name=default_embedding_model, namespace="Local")
                    if embeddings:
                        # Cache the embedding model globally for reuse by all users/retrievers
                        embedding_cache = get_embedding_cache()
                        embedding_cache.set_embedding_model(embeddings, default_embedding_model)
                        logger.info("Successfully cached embedding model globally: %s", default_embedding_model)
                    else:
                        logger.warning("Failed to pre-load embedding model: %s", default_embedding_model)
                else:
                    logger.warning("No default embedding model found for pre-loading")
            finally:
                db.close()
        except Exception as embedding_error:
            logger.warning("Failed to pre-load embedding models: %s", embedding_error)

        embedding_time = time.time() - start_time
        logger.info("Embedding model pre-loading completed (took %.2f seconds)", embedding_time)
        startup_monitor.checkpoint("Embedding Models Preload Complete")

        # Reranker model is not available in this edition (cross-encoder reranking
        # was removed). RAG falls back to MMR reranking at query time.
        logger.info("ℹ️ Reranker not available in this edition - skipping preload (RAG uses MMR)")
        startup_monitor.checkpoint("Reranker Model Preload Skipped")

        # Retriever Manager initialization with config
        logger.info("Initializing Retriever Manager...")
        startup_monitor.checkpoint("Retriever Manager Start")
        start_time = time.time()
        from src.main.service.retriever.retriever_manager import retriever_manager

        await asyncio.wait_for(
            retriever_manager.initialize(resolved_config, resolved_secrets),
            timeout=30.0,
        )
        retriever_time = time.time() - start_time
        logger.info("Retriever manager initialized (took %.2f seconds)", retriever_time)
        _app.state.retriever_manager = retriever_manager
        startup_monitor.checkpoint("Retriever Manager Complete")

        # Document Service and Job Manager preloading
        logger.info("Preloading Document Service and related components...")
        startup_monitor.checkpoint("Document Service Preload Start")
        start_time = time.time()
        try:
            # Import and initialize DocumentService in the background
            # Initialize DocumentService with a temporary database session for preloading
            from src.main.config.database import get_db
            from src.main.service.document.document_job_manager import document_job_manager
            from src.main.service.document.document_processor import document_processor
            from src.main.service.document.documents import DocumentService

            db = next(get_db())
            try:
                # Create DocumentService instance to trigger initialization
                document_service = DocumentService(db=db)
                logger.info("DocumentService preloaded successfully")

                # Knowledge graph (Neo4j) is not available in this edition - no
                # graph integration service or Neo4j optimizations to set up.
                logger.info("ℹ️  Knowledge graph not available in this edition - skipping graph integration")

                # Store references for potential cleanup
                _app.state.document_service = document_service
                _app.state.document_job_manager = document_job_manager
                _app.state.document_processor = document_processor
                _app.state.graph_integration_service = None  # Not available in this edition

            finally:
                db.close()

            document_service_time = time.time() - start_time
            logger.info("Document Service preloading completed (took %.2f seconds)", document_service_time)

        except Exception as doc_service_error:
            logger.warning("Failed to preload Document Service (will lazy load): %s", str(doc_service_error))
            # Don't fail startup if document service preloading fails

        startup_monitor.checkpoint("Document Service Preload Complete")

        # Main application instance creation with a truly lazy import
        logger.info("Creating Main application instance...")
        startup_monitor.checkpoint("Main Instance Start")
        start_time = time.time()

        # Lazy import function to avoid heavy LangChain imports during startup
        async def _create_main_instance():
            from src.main.main import Main  # Import only when actually needed

            # Get Neo4j config from resolved_config (not resolved_secrets)
            neo4j_config = resolved_config.get("neo4j", {})

            return await Main.create(
                redis_config=redis_config,
                config=resolved_config,
                retriever=None,  # Pass None for retriever parameter, use retriever_manager instead
                neo4j_config=neo4j_config,
                llm_manager=llm_manager,
                retriever_manager=retriever_manager,
            )

        # Create the Main instance with timeout to avoid blocking startup with heavy imports
        main_instance = await asyncio.wait_for(_create_main_instance(), timeout=8.0)
        main_time = time.time() - start_time
        logger.info("Main application instance created (took %.2f seconds)", main_time)
        _app.state.main_instance = main_instance
        startup_monitor.checkpoint("Main Instance Complete")

        # Check if automatic model deployment on startup is enabled
        deploy_on_startup_raw = resolved_config.get("llm", {}).get("local_ai", {}).get("deploy_on_startup", False)

        # Convert string values to boolean (config values are often strings)
        if isinstance(deploy_on_startup_raw, str):
            deploy_on_startup = deploy_on_startup_raw.lower() in (
                "true",
                "1",
                "yes",
                "on",
            )
        else:
            deploy_on_startup = bool(deploy_on_startup_raw)

        # Debug logging to see what configuration is actually being read
        logger.info("DEBUG: deploy_on_startup raw value = %s (type: %s)", deploy_on_startup_raw, type(deploy_on_startup_raw))
        logger.info("DEBUG: deploy_on_startup converted value = %s", deploy_on_startup)
        logger.info("DEBUG: local_ai config section = %s", resolved_config.get("llm", {}).get("local_ai", {}))

        if deploy_on_startup:
            logger.info("Automatic model deployment on startup is enabled - scheduling background deployment")
            # Schedule deployment as a background task to avoid blocking startup
            asyncio.create_task(_deploy_startup_models_background())
        else:
            logger.info("Automatic model deployment on startup is disabled - models should be deployed manually through the UI")

        # MCP Server initialization
        logger.info("Starting MCP server initialization...")
        startup_monitor.checkpoint("MCP Server Start")
        start_time = time.time()
        try:
            from src.main.mcp.mcp_server_manager import start_mcp_server

            # Create the MCP server task and store reference for proper cleanup
            mcp_task = asyncio.create_task(start_mcp_server(), name="mcp_server_startup")
            _app.state.mcp_startup_task = mcp_task  # Store reference for cleanup

            mcp_started = await asyncio.wait_for(mcp_task, timeout=10.0)
            mcp_time = time.time() - start_time
            if mcp_started:
                logger.info("MCP server started successfully (took %.2f seconds)", mcp_time)
                _app.state.mcp_server_running = True
            else:
                logger.warning("MCP server failed to start (took %.2f seconds)", mcp_time)
                _app.state.mcp_server_running = False
        except TimeoutError:
            mcp_time = time.time() - start_time
            logger.warning(
                "MCP server startup timed out after 10 seconds (took %.2f seconds)",
                mcp_time,
            )
            _app.state.mcp_server_running = False
            # Cancel the MCP task if it timed out
            if hasattr(_app.state, "mcp_startup_task") and not _app.state.mcp_startup_task.done():
                _app.state.mcp_startup_task.cancel()
        except Exception as mcp_error:
            mcp_time = time.time() - start_time
            logger.error(
                "Error starting MCP server: %s (took %.2f seconds)",
                str(mcp_error),
                mcp_time,
            )
            _app.state.mcp_server_running = False
            # Cancel the MCP task if it failed
            if hasattr(_app.state, "mcp_startup_task") and not _app.state.mcp_startup_task.done():
                _app.state.mcp_startup_task.cancel()
        startup_monitor.checkpoint("MCP Server Complete")

        total_time = start_time - time.time()
        logger.info(
            "Background initialization completed successfully in %.2f seconds",
            total_time,
        )

    except Exception as ex:
        logger.exception("Error during background initialization: %s", str(ex))
        startup_monitor.checkpoint("Background Initialization FAILED")


def _load_spacy_model():
    """
    Load spaCy model in a blocking way (to be run in thread pool).
    Tries multiple models in order of preference with fallback.
    """
    import spacy

    # Try models in order of preference (largest to smallest)
    models_to_try = [
        "en_core_web_md",  # Medium model (best accuracy)
        "en_core_web_sm",  # Small model (faster, less accurate)
    ]

    for model_name in models_to_try:
        try:
            logger.info("Attempting to load spaCy model: %s", model_name)
            return spacy.load(model_name)
        except OSError:
            logger.warning("spaCy model '%s' not found, trying next fallback...", model_name)
            continue

    # If all models fail, raise an error
    raise OSError("No spaCy models available. Please install a model using: python -m spacy download en_core_web_sm")


async def _background_spacy_preload(app_instance):
    """
    Preload spaCy models in the background without blocking the event loop.
    This runs after the server is already serving requests.
    """
    try:
        # Wait a bit to let the server fully start
        await asyncio.sleep(10)

        logger.info("🧠 Starting background spaCy model pre-loading...")
        spacy_start = time.time()

        # Run the blocking spaCy load in a thread pool
        loop = asyncio.get_running_loop()
        # noinspection PyTypeChecker
        spacy_model = await loop.run_in_executor(None, _load_spacy_model)  # Use the default thread pool

        # Store in-app state for reuse
        if app_instance:
            app_instance.state.preloaded_spacy_model = spacy_model

        spacy_time = time.time() - spacy_start
        logger.info("spaCy model pre-loaded into memory in %.2f seconds", spacy_time)

    except Exception as spacy_error:
        logger.warning("⚠️ Failed to pre-load spaCy model in background (will load on-demand): %s", str(spacy_error), exc_info=True)
