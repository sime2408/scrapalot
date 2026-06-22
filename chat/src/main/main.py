import asyncio
import os
import sys
import traceback
from typing import TYPE_CHECKING
import warnings

from src.main.utils.core.logger import get_logger

if TYPE_CHECKING:
    from src.main.service.memory.database_summary_buffer_memory import DatabaseSummaryBufferMemory

# Suppress specific deprecation warnings
warnings.filterwarnings("ignore", category=DeprecationWarning, module="websockets.legacy")
warnings.filterwarnings("ignore", category=DeprecationWarning, module="uvicorn.protocols.websockets.websockets_impl")
warnings.filterwarnings("ignore", category=DeprecationWarning, module="pydantic._internal._config")
# Suppress SWIG deprecation warnings from PyMuPDF and other SWIG-based packages
warnings.filterwarnings("ignore", message="builtin type .* has no __module__ attribute", category=DeprecationWarning)
# Suppress Click parser deprecation warnings from spaCy and weasel packages
warnings.filterwarnings("ignore", message="Importing 'parser.split_arg_string' is deprecated.*", category=DeprecationWarning)

# Lazy import to avoid pydot startup delay
# from langchain_community.chat_message_histories import RedisChatMessageHistory

# Set up app dir first - This might be redundant if run_service does it well
# noinspection PyTypeChecker
APP_DIR = str(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
if APP_DIR not in sys.path:
    sys.path.append(APP_DIR)  # Add only if not present

# Configure application logging
logger = get_logger(__name__)


class Main:
    """Main application class for Scrapalot Chat."""

    _instance = None  # Singleton instance holder - Keep internal
    main_instance = None  # Explicitly match the example's naming for global access

    @classmethod
    def get_instance(cls):
        try:
            # Use main_instance to match the example more closely
            if cls.main_instance is None:
                logger.error("Main instance has not been initialized. Call Main.create first.")
                raise RuntimeError("Main instance has not been initialized. Call Main.create first.")
            return cls.main_instance
        except Exception as e:
            logger.exception("Error getting Main instance: %s", str(e))
            return None

    @classmethod
    async def create(
        cls,
        redis_config: dict,
        config: dict,
        retriever,
        neo4j_config: dict,
        process_pool=None,
        llm_manager=None,
        retriever_manager=None,
    ):
        """Factory method to create and initialize the Main application instance."""
        try:
            # Prevent re-creation if already exists
            if cls.main_instance is not None:
                logger.warning("Main.create called when instance already exists.")
                return cls.main_instance

            logger.info("🏗️ Creating and initializing Main instance...")
            instance = cls(redis_config, config, retriever, neo4j_config, process_pool, llm_manager, retriever_manager)
            logger.info("✔️ Main instance object created, now initializing components...")

            try:
                await instance._initialize_components()  # Call async initialization helper
                logger.info("✔️ Main instance components initialized successfully.")
            except Exception as init_error:
                error_details = traceback.format_exc()
                logger.critical("Failed to initialize Main instance components: %s", init_error)
                logger.critical("Component initialization error details: %s", error_details)
                raise RuntimeError(f"Failed to initialize Main instance components: {init_error}") from init_error

            # Store the created instance in the class variable for global access
            cls.main_instance = instance
            # Optionally store in _instance too if needed internally
            cls._instance = instance
            return instance
        except Exception as e:
            error_details = traceback.format_exc()
            logger.critical("Failed to create Main instance: %s", e)
            logger.critical("Error details: %s", error_details)
            raise RuntimeError(f"Failed to create Main instance: {e}") from e

    def __init__(self, redis_config, config, retriever, neo4j_config, process_pool=None, llm_manager=None, retriever_manager=None):
        """Initialize the Main application instance."""
        try:
            self.redis_config = redis_config
            self.config = config
            self.retriever = retriever
            self.neo4j_config = neo4j_config
            self.process_pool = process_pool
            self.llm_manager = llm_manager
            self.retriever_manager = retriever_manager
            self.llm_reasoning = None
            self.llm = None  # Initialize to None - will be obtained through llm_manager when needed

            # Extract redis_url from redis_config (handle both embedded and regular Redis)
            if redis_config:
                self.redis_url = redis_config.get("url")
                self.redis_client = redis_config.get("client")  # For embedded Redis
                self.is_embedded_redis = redis_config.get("is_embedded", False)
            else:
                self.redis_url = None
                self.redis_client = None
                self.is_embedded_redis = False

            # Extract memory_buffer_size from config
            memory_config = config.get("memory", {})
            self.memory_buffer_size = memory_config.get("buffer_size", 5)  # Default to 5 if not specified

            self.initialized = False
        except Exception as e:
            error_details = traceback.format_exc()
            logger.critical("Error initializing Main instance attributes: %s", e)
            logger.critical("Initialization error details: %s", error_details)
            raise RuntimeError(f"Error initializing Main instance attributes: {e}") from e

    async def _initialize_components(self):
        """Initialize all components of the application."""
        try:
            # Initialize Redis adapter for truly embedded Redis support
            logger.info("🔧 Initializing Redis adapter for embedded Redis support...")
            from src.main.utils.redis.adapter import patch_langchain_redis_for_embedded

            patch_langchain_redis_for_embedded()
            logger.info("✔️ Redis adapter initialized successfully")

            # Neo4j retriever will be created per-user as needed
            self.neo4j_retriever = None
            logger.info("️️📆 Neo4j retriever will be created per-user as needed")

            # Schedule background model preloading after startup is complete (much longer delay)
            if self.llm_manager:
                # Don't await - this should run in the background without blocking initialization
                logger.info("Scheduling background model preloading task...")
                try:
                    # noinspection PyAsyncCall
                    asyncio.create_task(self._delayed_background_model_preload())
                    # Don't store task reference to avoid blocking - let it run completely detached
                    logger.info("Background model preloading task scheduled successfully")
                except Exception as task_error:
                    logger.warning("Failed to schedule background model preloading task: %s", str(task_error))
                    # Continue with initialization even if a background task fails to the start

            self.rag_strategy = None  # Initialize as None, will be set per request
            logger.info("RAG strategy will be loaded dynamically per user request.")

            # Create the main LLM chain
            self.chain = None
            logger.info("Chain creation deferred until LLM is available.")

            # DO NOT INCLUDE ROUTERS HERE ANYMORE

            self.initialized = True
            logger.debug("All components initialized successfully.")
        except Exception as e:
            error_details = traceback.format_exc()
            logger.critical("Failed to initialize components: %s", e)
            logger.critical("Component initialization error details: %s", error_details)
            self.initialized = False
            raise RuntimeError(f"Failed to initialize components: {e}") from e

    async def _delayed_background_model_preload(self):
        """
        Preload commonly used models in the background to improve user experience.
        This runs well after the application startup to avoid blocking the startup process.
        Loads models from the model_providers database table.

        Embedding models are always loaded (needed for UI), but other models
        are only loaded when deploy_on_startup is enabled.
        """
        try:
            logger.info("🔄 Starting background model preloading task...")

            # Check of model preloading is enabled in configuration
            from src.main.utils.config.loader import get_resolved_config

            config = get_resolved_config()
            local_ai_config = config.get("local_ai", {})

            # Only proceed if local AI is enabled
            if not local_ai_config.get("enabled", False):
                logger.info("Local AI is disabled in configuration, skipping model pre-loading")
                return

            # Check the deploy_on_startup setting for reasoning models
            deploy_inference_models = local_ai_config.get("deploy_on_startup", False)
            if not deploy_inference_models:
                logger.info("deploy_on_startup is disabled, will not pre-load models")
            else:
                logger.info("deploy_on_startup is enabled, will pre-load all models")

            # Wait much longer after startup to let the application fully stabilize and serve requests
            # This prevents blocking startup while still providing preloading benefits
            logger.info("Background model preloading will start in 5 seconds...")
            await asyncio.sleep(5)  # Reduced from 30 to 5 seconds to prevent blocking startup
            logger.info("Background model preloading started...")

            # Get models from the database instead of config
            models_to_preload = []

            try:
                from sqlalchemy import text

                from src.main.config.database import SessionLocal

                # Query the database for Local AI provider models
                db = SessionLocal()
                try:
                    # Get the Local AI provider
                    provider_query = text("""
                        SELECT id FROM model_providers
                        WHERE provider_type = 'local' AND status = 'active'
                        LIMIT 1
                    """)
                    provider_result = db.execute(provider_query).first()

                    if provider_result:
                        provider_id = provider_result[0]

                        # Build model type filter based on the deploy_on_startup setting
                        if deploy_inference_models:
                            # Load both embedding and chat models
                            model_type_filter = "AND model_type IN ('NORMAL', 'EMBEDDING', 'VISION', 'AUDIO')"
                            logger.info("Loading both EMBEDDING and NORMAL models")
                        else:
                            # Only load embedding models (always needed for UI)
                            model_type_filter = "AND model_type = 'EMBEDDING'"
                            logger.info("Loading only EMBEDDING models (reasoning models disabled by deploy_on_startup=false)")

                        # Get models for this provider with conditional type filtering
                        models_query = text(f"""
                            SELECT model_name, model_type, display_name
                            FROM model_provider_models
                            WHERE provider_id = :provider_id
                            {model_type_filter}
                            ORDER BY
                                CASE
                                    WHEN model_type = 'EMBEDDING' THEN 1
                                    WHEN model_type = 'NORMAL' THEN 2
                                    ELSE 3
                                END,
                                min_gpu_memory_mb ASC NULLS LAST
                            LIMIT 5
                        """)
                        models_result = db.execute(models_query, {"provider_id": provider_id}).fetchall()

                        # Select one reasoning model and one embedding model for preloading
                        reasoning_model = None
                        embedding_model = None

                        for model in models_result:
                            model_name = model[0]
                            model_type = model[1]
                            display_name = model[2]

                            if model_type == "NORMAL" and not reasoning_model:
                                reasoning_model = (model_name, "local", "chat", display_name)
                            elif model_type == "EMBEDDING" and not embedding_model:
                                embedding_model = (model_name, "local", "embedding", display_name)

                        if reasoning_model:
                            models_to_preload.append(reasoning_model)
                        if embedding_model:
                            models_to_preload.append(embedding_model)

                        logger.info("Found %s models to pre - load from database", len(models_to_preload))
                    else:
                        logger.warning("No active Local AI provider found in database")

                finally:
                    db.close()

            except Exception as db_error:
                logger.warning("Error querying database for models: %s", str(db_error))
                # Fallback: don't preload any models
                models_to_preload = []

            # Preload models with timeout to avoid blocking indefinitely
            for model_name, provider, model_type, display_name in models_to_preload:
                try:
                    logger.info("⬇️ Pre-loading %s model: %s (%s) from Provider: %s", model_type, display_name, model_name, provider)

                    # Handle embedding models differently from LLM models
                    if model_type == "embedding":
                        # Preload embedding models through the embedding factory
                        logger.info("🔍 Pre-loading embedding model: %s (%s) from Provider: %s", display_name, model_name, provider)
                        try:
                            # Lazy import to avoid triggering pydot during startup
                            def _load_embedding_model():
                                from src.main.service.llm.llm_embedding_factory import get_embedding_function

                                return get_embedding_function(provider=provider, model_name=model_name)

                            # Load an embedding model with timeout
                            embedding_model = await asyncio.wait_for(
                                asyncio.to_thread(_load_embedding_model),
                                timeout=60.0,  # 1 minute timeout for embedding models
                            )
                            if embedding_model:
                                logger.info("Successfully pre-loaded embedding model: %s", display_name)
                            else:
                                logger.warning("⚠️ Failed to pre-load embedding model: %s", display_name)
                        except Exception as e:
                            logger.warning("⚠️ Error pre-loading embedding model %s: %s: %s", display_name, type(e).__name__, str(e))
                            logger.debug("Full traceback for embedding model error: %s", traceback.format_exc())
                        continue
                    else:
                        # Only preload reasoning/chat models through LLM manager if deployment is enabled
                        if not deploy_inference_models:
                            logger.info("Skipping reasoning model %s - deploy_on_startup is disabled", display_name)
                            continue

                        # Use a shorter timeout for background loading to prevent excessive resource usage
                        llm = await asyncio.wait_for(
                            self.llm_manager.get_llm(model_name=model_name, provider_type=provider),
                            timeout=60.0,  # Reduced from 2 minutes to 1 minute per model
                        )

                        if llm:
                            logger.info("Successfully pre-loaded %s model: %s", model_type, display_name)
                            # Store reference for quick access
                            if model_type == "reasoning":
                                self.llm_reasoning = llm
                                logger.info("🧠 Set reasoning LLM to: %s", display_name)
                        else:
                            logger.warning("⚠️ Failed to pre-load %s model: %s", model_type, display_name)

                except TimeoutError:
                    logger.warning("Timeout pre-loading %s model: %s (took longer than 1 minute)", model_type, display_name)
                except Exception as e:
                    logger.warning("Error pre-loading %s model %s: %s", model_type, display_name, str(e))
                    # Continue with other models even if one fails
                    continue

                # Longer delay between models to avoid overwhelming the system during background loading
                await asyncio.sleep(5)  # Increased from 1 to 5 seconds

            logger.info("🎉 Background model pre-loading completed")

        except Exception as e:
            logger.error("Error in background model pre-loading: %s", str(e))
            logger.error(traceback.format_exc())

    @staticmethod
    def get_conversation(session_id: str) -> "DatabaseSummaryBufferMemory":
        # Lazy import to avoid pydot startup delay
        from src.main.config.database import get_db
        from src.main.service.memory.database_summary_buffer_memory import DatabaseSummaryBufferMemory

        try:
            logger.info("Creating DatabaseSummaryBufferMemory (buffer + LLM summaries) for session: %s", session_id)

            # Get database session for storing conversation messages and summaries
            db_session = next(get_db())

            # Create DatabaseSummaryBufferMemory with buffer pattern
            # - Keeps last 10 messages in buffer (fast access)
            # - Automatically summarizes older messages with LLM when buffer exceeds token limit
            # - max_token_limit auto-calculated as 25% of the model's context_window
            # - Stores summaries in sessions.conversation_summary
            memory = DatabaseSummaryBufferMemory(
                session_id=session_id,
                db_session=db_session,
                max_buffer_size=10,  # Keep the last 10 messages in buffer
                # max_token_limit auto-calculated from the agent model's context_window
                min_messages_before_summary=4,  # Minimum messages before first summary
            )
            logger.info("Successfully created DatabaseSummaryBufferMemory for session: %s", session_id)
            return memory
        except Exception as e:
            logger.error("Error in get_conversation for session %s: %s", session_id, str(e))
            logger.info("Falling back to minimal DatabaseSummaryBufferMemory for session: %s", session_id)

            # Final fallback to DatabaseSummaryBufferMemory with no database session (in-memory only)
            try:
                memory = DatabaseSummaryBufferMemory(
                    session_id=session_id,
                    db_session=None,  # No database session - will work in-memory only
                    max_buffer_size=10,
                    # max_token_limit auto-calculated from the agent model's context_window
                    min_messages_before_summary=4,
                )
                logger.info("Successfully created fallback DatabaseSummaryBufferMemory for session: %s", session_id)
                return memory
            except Exception as fallback_error:
                logger.error(
                    "Even fallback DatabaseSummaryBufferMemory failed for session %s: %s",
                    session_id,
                    str(fallback_error),
                )
                # This should not happen, but handle gracefully
                raise

    async def shutdown(self):
        """
        Gracefully shut down the Main instance and release resources.
        This method is called during application shutdown.
        """
        import asyncio

        try:
            logger.info("Main instance shutdown sequence initiated.")
            shutdown_tasks = []

            # Close the Neo4j connection if it exists
            if hasattr(self, "neo4j_retriever") and self.neo4j_retriever is not None:

                async def close_neo4j():
                    try:
                        logger.info("Shutting down Neo4j connection...")
                        await self.neo4j_retriever.close()
                        logger.info("Neo4j connection shutdown completed successfully.")
                    except Exception as ex1:
                        logger.error("Error shutting down Neo4j connection: %s", ex1)

                shutdown_tasks.append(asyncio.create_task(close_neo4j()))

            # Clean up RAG strategy resources if needed
            if hasattr(self, "rag_strategy") and self.rag_strategy is not None:

                async def cleanup_rag():
                    try:
                        logger.info("Shutting down RAG strategy resources...")
                        if hasattr(self.rag_strategy, "close") and callable(self.rag_strategy.close):
                            # noinspection PyUnresolvedReferences
                            await self.rag_strategy.close()
                        elif hasattr(self.rag_strategy, "cleanup") and callable(self.rag_strategy.cleanup):
                            # noinspection PyUnresolvedReferences
                            await self.rag_strategy.cleanup()
                        logger.info("RAG strategy resources shutdown completed.")
                    except Exception as ex2:
                        logger.error("Error shutting down RAG strategy resources: %s", ex2)

                shutdown_tasks.append(asyncio.create_task(cleanup_rag()))

            # Clean up retriever resources
            if hasattr(self, "retriever") and self.retriever is not None:

                async def close_retriever():
                    try:
                        logger.info("Shutting down retriever connections...")
                        if hasattr(self.retriever, "close") and callable(self.retriever.close):
                            # noinspection PyUnresolvedReferences
                            await self.retriever.close()
                        logger.info("Retriever connections shutdown completed.")
                    except Exception as ex3:
                        logger.error("Error shutting down retriever connections: %s", ex3)

                shutdown_tasks.append(asyncio.create_task(close_retriever()))

            # Clean up LLM manager if it exists
            if hasattr(self, "llm_manager") and self.llm_manager is not None:

                async def shutdown_llm_manager():
                    try:
                        logger.info("Shutting down LLM manager...")
                        if hasattr(self.llm_manager, "shutdown") and callable(self.llm_manager.shutdown):
                            # noinspection PyUnresolvedReferences
                            await self.llm_manager.shutdown()
                        logger.info("LLM manager shutdown completed successfully.")
                    except Exception as ex3:
                        logger.error("Error shutting down LLM manager: %s", ex3)

                shutdown_tasks.append(asyncio.create_task(shutdown_llm_manager()))

            # Clean up Retriever manager
            async def shutdown_retriever_manager():
                try:
                    logger.info("Shutting down Retriever manager...")
                    from src.main.service.retriever.retriever_manager import retriever_manager

                    await retriever_manager.shutdown()
                    logger.info("Retriever manager shutdown completed successfully.")
                except Exception as ex4:
                    logger.error("Error shutting down Retriever manager: %s", ex4)

            shutdown_tasks.append(asyncio.create_task(shutdown_retriever_manager()))

            # Clean up database connections
            async def shutdown_database():
                try:
                    logger.info("Shutting down database connections...")
                    from src.main.config.database import async_engine, engine

                    # Dispose synchronous engine
                    if engine:
                        engine.dispose()
                        logger.info("Synchronous database engine disposed")

                    # Dispose asynchronous engine
                    if async_engine:
                        # noinspection PyUnresolvedReferences
                        await async_engine.dispose()
                        logger.info("Asynchronous database engine disposed")

                    logger.info("Database connections shutdown completed successfully.")
                except Exception as ex5:
                    logger.error("Error shutting down database connections: %s", ex5)

            shutdown_tasks.append(asyncio.create_task(shutdown_database()))

            # Execute all shutdown tasks concurrently with timeout
            if shutdown_tasks:
                try:
                    logger.info("Executing %s shutdown tasks...", len(shutdown_tasks))
                    # Store task references to prevent garbage collection issues
                    task_refs = list(shutdown_tasks)

                    await asyncio.wait_for(
                        asyncio.gather(*shutdown_tasks, return_exceptions=True),
                        timeout=15.0,  # 15-second timeouts for all shutdown tasks
                    )
                    logger.info("All shutdown tasks completed successfully.")

                    # Ensure all tasks are properly completed
                    for task in task_refs:
                        if not task.done():
                            task.cancel()
                            try:
                                # Give each task a short time to complete cancellation
                                await asyncio.wait_for(task, timeout=0.5)
                            except (TimeoutError, asyncio.CancelledError) as e:
                                logger.debug("Task did not finish cancelling cleanly: %s", e)

                    # Keep references until explicitly cleared
                    task_refs.clear()
                except TimeoutError:
                    logger.warning("Shutdown tasks timed out after 15 seconds. Some resources may not be properly cleaned up.")
                    # Cancel any remaining tasks
                    for task in shutdown_tasks:
                        if not task.done():
                            task.cancel()
                            try:
                                # Give each task a short time to complete cancellation
                                await asyncio.wait_for(task, timeout=0.1)
                            except (TimeoutError, asyncio.CancelledError) as e:
                                logger.debug("Remaining shutdown task did not cancel cleanly: %s", e)

            # Set initialized flag to False
            self.initialized = False
            logger.info("Main instance shutdown sequence completed successfully.")
        except Exception as e:
            logger.error("Error during Main instance shutdown sequence: %s", e)
            logger.error(traceback.format_exc())
        # Don't re-raise during shutdown to avoid masking other shutdown issues.
