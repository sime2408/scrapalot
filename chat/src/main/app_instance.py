"""
FastAPI application instance and API definitions.
This module initializes and configures the FastAPI application.
"""

import asyncio
from contextlib import asynccontextmanager
import datetime
import os
import traceback
import warnings

from fastapi import FastAPI, Request, WebSocket
from starlette import status
from starlette.responses import JSONResponse, Response

# Ensure database setup runs before app initialization
from src.main.config.database import setup_database_connection
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger, timing_decorator
from src.main.utils.health.endpoints import create_health_endpoints, create_websocket_test_endpoints
from src.main.utils.http.security import log_authorization_header_middleware, security_middleware
from src.main.utils.startup.asyncio_cleanup import cleanup_all_asyncio_tasks

# noinspection PyProtectedMember
from src.main.utils.startup.initialization import (
    _background_initialization,
    _setup_redis_config_with_fallback,
    run_heavy_initialization,
)
from src.main.utils.startup.monitor import startup_monitor
from src.main.utils.websocket.manager import websocket_manager

logger = get_logger(__name__)

# Suppress websockets deprecation warnings early in the import chain
warnings.filterwarnings("ignore", category=DeprecationWarning, module="websockets.legacy")
warnings.filterwarnings("ignore", category=DeprecationWarning, message=".*websockets.legacy is deprecated.*")
warnings.filterwarnings(
    "ignore",
    category=DeprecationWarning,
    message=".*websockets.server.WebSocketServerProtocol is deprecated.*",
)
warnings.filterwarnings(
    "ignore",
    category=DeprecationWarning,
    module="uvicorn.protocols.websockets.websockets_impl",
)
warnings.filterwarnings("ignore", category=DeprecationWarning, message=".*websockets.*")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """
    FastAPI lifespan context manager for handling startup and shutdown events.

    OPTIMIZED STARTUP:
    - Port binds immediately for Render's port scanner
    - Heavy initialization runs in the background after port binding
    - Uses startup state tracking for monitoring initialization progress
    """
    # Startup
    logger.info("🚀 FastAPI application starting up...")
    startup_monitor.checkpoint("Application Lifespan Start")

    # Store main event loop reference for job progress subscriber (Celery → WebSocket bridge)
    try:
        from src.main.service.job_progress_subscriber import set_main_event_loop

        set_main_event_loop(asyncio.get_running_loop())
    except Exception as loop_err:
        logger.debug("Suppressed exception: %s", loop_err)

    # CRITICAL: Mount cloud storage FIRST before any other initialization
    # This prevents other code from accessing /app/data/models before mounting
    if os.environ.get("ENVIRONMENT") == "prod":
        logger.info("🌩️ Production environment detected - mounting cloud storage first...")
        try:
            # noinspection PyProtectedMember
            from src.main.utils.models.downloader import _mount_cloud_storage_if_needed

            _mount_cloud_storage_if_needed()
        except Exception as mount_err:
            logger.error("❌ Failed to mount cloud storage: %s", mount_err)

    # Start heavy initialization in the background (non-blocking)
    logger.info("🚀 Starting background initialization tasks...")
    background_init_task = asyncio.create_task(run_heavy_initialization(_app))
    _app.state.background_init_task = background_init_task  # Store for proper cleanup

    startup_monitor.checkpoint("Background Initialization Started")
    logger.info("FastAPI startup complete - port binding ready")

    try:
        # STEP 1: Database setup (essential for authentication)
        startup_monitor.checkpoint("Database Setup Start")

        # Enable migrations by default to ensure tables are created
        import socket

        os.environ["ENABLE_MIGRATIONS"] = "1"
        logger.info("Enabled database migrations for table creation")

        # Get hostname for environment detection
        hostname = socket.gethostname()

        # Detect production environment based on reliable indicators
        is_production = (
            "scrapalot" in hostname.lower()
            or os.path.exists("/.dockerenv")
            or os.environ.get("ENVIRONMENT", "").lower() == "prod"  # Running in Docker
            or os.environ.get("NODE_ENV", "").lower() == "production"
        )

        if is_production:
            logger.info("🌐 Production environment detected - using enhanced initialization")
        else:
            logger.info("🔧 Development environment detected")

        # Initialize database connection and run migrations (using module-level imports)
        try:
            from src.main.config.database import using_sqlite_fallback as db_sqlite_fallback

            # Initialize data_dir to avoid reference errors
            data_directory = None

            # Enhanced database setup for production
            if is_production:
                logger.info("Initializing database for production deployment...")
                # Ensure a data directory exists for SQLite
                data_directory = os.path.join(os.getcwd(), "data", "db")
                os.makedirs(data_directory, exist_ok=True)
                logger.info("Ensured data directory exists: %s", data_directory)

            setup_database_connection()
            logger.info("Database connection established successfully")

            # Update the global using_sqlite_fallback variable
            using_sqlite_fallback = db_sqlite_fallback

            # Log database connection mode
            if using_sqlite_fallback:
                logger.info("Using SQLite database mode")
                in_memory = resolved_config.get("sqlite", {}).get("in_memory", False)
                db_path = resolved_config.get("sqlite", {}).get("db_path", "scrapalot.db")
                masked_url = "sqlite+aiosqlite:///:memory:" if in_memory else f"sqlite+aiosqlite:///{db_path}"

                # For production, log the actual database file path
                if is_production and not in_memory:
                    # noinspection PyTypeChecker
                    actual_db_path = os.path.join(data_directory, os.path.basename(db_path)) if data_directory else db_path
                    logger.info("SQLite database file: %s", actual_db_path)
            else:
                # Get the base database URL for PostgreSQL
                pg_config = resolved_config.get("postgres", {})
                db_host = pg_config.get("host", "localhost")
                db_port = pg_config.get("port", 15432)
                db_name = pg_config.get("db", "scrapalot")
                db_user = pg_config.get("user", "scrapalot")

                # Mask the password in the log
                masked_url = f"postgresql://{db_user}:****@{db_host}:{db_port}/{db_name}"

            # Log the connection string without credentials
            logger.info("Database connection: %s", masked_url)

            # Verify database tables are created (especially important for production)
            if is_production:
                try:
                    from sqlalchemy import text

                    from src.main.config.database import get_db

                    db = next(get_db())

                    # Database-agnostic table existence check
                    dialect_name = db.bind.dialect.name
                    if dialect_name == "postgresql":
                        # Use information_schema for PostgreSQL/Supabase
                        result = db.execute(
                            text("""SELECT EXISTS (
                                SELECT FROM information_schema.tables
                                WHERE table_name = 'documents' AND table_schema = 'public'
                            )""")
                        ).fetchone()
                        table_exists = result[0] if result else False
                    else:
                        # Use sqlite_master for SQLite
                        # noinspection SqlResolve
                        result = db.execute(text("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'")).fetchone()
                        table_exists = result is not None

                    if table_exists:
                        logger.info("Database tables verified - documents table exists")
                    else:
                        logger.warning("Database tables not found - database may need initialization")
                    db.close()
                except Exception as verify_error:
                    logger.warning("Could not verify database tables: %s", verify_error)

        except Exception as db_error:
            logger.error("Failed to initialize database: %s", str(db_error))
            if is_production:
                logger.error("Production database initialization failed - this may cause 401/500 errors")
            raise RuntimeError(f"Database initialization failed: {db_error}") from db_error

        startup_monitor.checkpoint("Database Setup Complete")

        logger.info("✔️ Database initialization completed - login ready.")

        # Recover zombie graph_sync_status records from previous crashes.
        # An entity_running older than 60 minutes is a dead extraction —
        # demote it to 'hierarchy_done' (NOT 'failed') so the pending-graph
        # backfill (ensure_pending_graphs_built) re-picks and completes it.
        # NOTE: we deliberately do NOT touch 'pending' rows here. With the
        # graph backfill, 'pending' is a long-lived backlog (~600 docs built
        # two-at-a-time over days), not a dispatched task awaiting pickup —
        # mass-failing them on every restart wrongly killed the whole backlog
        # (619 docs on 2026-06-02). The backfill driver owns 'pending'.
        try:
            from sqlalchemy import text as sa_text

            from src.main.config.database import SessionLocal

            recovery_db = SessionLocal()
            try:
                result = recovery_db.execute(
                    sa_text(
                        "UPDATE graph_sync_status SET status = 'hierarchy_done', "
                        "error_message = 'Entity extraction interrupted — re-queued for rebuild', "
                        "updated_at = NOW() "
                        "WHERE status = 'entity_running' "
                        "AND updated_at < NOW() - INTERVAL '60 minutes'"
                    )
                )
                if result.rowcount > 0:
                    logger.warning("Recovered %d stale entity_running records → hierarchy_done (re-queued)", result.rowcount)

                recovery_db.commit()
            finally:
                recovery_db.close()
        except Exception as recovery_error:
            logger.warning("Graph sync status recovery skipped: %s", str(recovery_error))

        # (CE) Stripe/billing is a hosted-only feature — no validation needed.

        # Initialize system AI provider from config
        try:
            logger.info("Initializing system AI provider from config...")
            from src.main.config.database import SessionLocal
            from src.main.utils.llm.provider_utils import ensure_system_ai_provider

            db = SessionLocal()
            try:
                provider_data, was_created = ensure_system_ai_provider(db)
                action = "Created" if was_created else "Found existing"
                logger.info("✔️ %s system AI provider: %s (ID: %s)", action, provider_data["name"], provider_data["id"])
            finally:
                db.close()
        except Exception as provider_error:
            logger.error("Failed to initialize system AI provider: %s", str(provider_error))
            # Don't fail startup if system provider creation fails

        # STEP 2: Basic Redis configuration with embedded fallback (needed for sessions)
        logger.info("Setting up Redis configuration...")
        startup_monitor.checkpoint("Redis Setup Start")
        redis_config = await _setup_redis_config_with_fallback()
        logger.info("✔️ Redis configured: %s", redis_config["url"])
        if redis_config.get("is_embedded"):
            logger.info("🔧 Using embedded Redis server")
        startup_monitor.checkpoint("Redis Setup Complete")

        # STEP 3: Store minimal state for immediate app functionality
        _app.state.using_sqlite_fallback = using_sqlite_fallback
        _app.state.redis_config = redis_config
        _app.state.initialization_complete = False  # Flag to track background initialization

        logger.info("🎯 MINIMAL STARTUP COMPLETE - Users can now login!")
        logger.info("✔️ Fast startup mode enabled - heavy initialization deferred")
        startup_monitor.checkpoint("Minimal Startup Complete")

        # Create a background task for heavy initialization with error handling
        async def safe_background_initialization():
            try:
                startup_monitor.checkpoint("Background Initialization Start")
                await _background_initialization(_app, redis_config)
                _app.state.initialization_complete = True
                startup_monitor.checkpoint("Background Initialization Complete")
                startup_monitor.summary()
            except Exception as exc:
                logger.error("Background initialization failed: %s", str(exc))
                logger.error(traceback.format_exc())
                _app.state.initialization_complete = False

        background_task = asyncio.create_task(safe_background_initialization())
        _app.state.background_task = background_task
        logger.info("Background initialization task created")
        startup_monitor.checkpoint("Background Task Created")

        # (CE) External-books preview cleanup is a hosted-only feature.

    except Exception as ex:
        logger.critical("FATAL ERROR during minimal application startup: %s", ex)
        logger.critical("Error details: %s", traceback.format_exc())
        # Re-raise to prevent app start on critical failure
        raise RuntimeError(f"Minimal startup failed: {ex}") from ex

    yield  # Let the application run

    # --- Shutdown Logic ---
    logger.info("Application shutdown sequence initiated.")

    shutdown_timeout = 25.0  # Total shutdown timeout in seconds
    shutdown_start_time = datetime.datetime.now(datetime.UTC)

    # Cancel the background initialization tasks if they're still running
    try:
        # Cancel the main background initialization task
        if hasattr(_app.state, "background_init_task") and _app.state.background_init_task:
            if not _app.state.background_init_task.done():
                logger.info("Cancelling background initialization task...")
                _app.state.background_init_task.cancel()
                try:
                    await asyncio.wait_for(_app.state.background_init_task, timeout=2.0)
                except (asyncio.CancelledError, TimeoutError):
                    logger.info("Background initialization task cancelled successfully.")
            else:
                logger.info("Background initialization task already completed.")

        # Cancel the secondary background task
        if hasattr(_app.state, "background_task") and _app.state.background_task:
            if not _app.state.background_task.done():
                logger.info("Cancelling secondary background task...")
                _app.state.background_task.cancel()
                try:
                    await asyncio.wait_for(_app.state.background_task, timeout=2.0)
                except (asyncio.CancelledError, TimeoutError):
                    logger.info("Secondary background task cancelled successfully.")

            else:
                logger.info("Secondary background task already completed.")

        # (CE) External-books preview cleanup is a hosted-only feature.
    except Exception as ex:
        logger.error("Error cancelling background initialization tasks: %s", str(ex))

    # Cancel the MCP startup task if it's still running
    try:
        if hasattr(_app.state, "mcp_startup_task") and _app.state.mcp_startup_task:
            if not _app.state.mcp_startup_task.done():
                logger.info("Cancelling MCP startup task...")
                _app.state.mcp_startup_task.cancel()
                try:
                    await asyncio.wait_for(_app.state.mcp_startup_task, timeout=1.0)
                except (asyncio.CancelledError, TimeoutError):
                    logger.info("MCP startup task cancelled successfully.")
            else:
                logger.info("MCP startup task already completed.")
    except Exception as ex:
        logger.error("Error cancelling MCP startup task: %s", str(ex))

    # Stop Redis event subscriber for collection_workspace_map sync
    try:
        from src.main.service.redis_event_subscriber import stop_redis_event_subscriber

        stop_redis_event_subscriber()
        logger.info("Redis event subscriber stopped")
    except Exception as ex:
        logger.error("Error stopping Redis event subscriber: %s", str(ex))

    # Stop job progress subscriber (Celery → WebSocket bridge)
    try:
        from src.main.service.job_progress_subscriber import stop_job_progress_subscriber

        stop_job_progress_subscriber()
        logger.info("Job progress subscriber stopped")
    except Exception as ex:
        logger.error("Error stopping job progress subscriber: %s", str(ex))

    # Clean up a truly embedded Redis server if running
    try:
        logger.info("Cleaning up truly embedded Redis server...")
        from src.main.config.redis_embedded import cleanup_truly_embedded_redis

        cleanup_truly_embedded_redis()
        logger.info("Truly embedded Redis cleanup completed")
    except Exception as ex:
        logger.error("Error cleaning up truly embedded Redis: %s", str(ex))

    # Clean up background tasks from memory services first
    try:
        logger.info("Shutting down memory service background tasks...")
        # DatabaseSummaryBufferMemory uses async background tasks for LLM summarization,
        # but these are fire-and-forget tasks that complete independently.
        # Database connections are managed by the session lifecycle.
        logger.info("DatabaseSummaryBufferMemory async tasks complete independently.")
        logger.info("Memory service background tasks shutdown completed.")
    except Exception as ex:
        logger.error("Error shutting down memory service background tasks: %s", str(ex))

    # Stop the local AI service if it's running
    try:
        logger.info("Shutting down local AI service...")
        from src.main.service.local_models.model_service import stop_service

        await asyncio.wait_for(stop_service(), timeout=5.0)
        logger.info("Local AI service shutdown completed successfully.")
    except TimeoutError:
        logger.warning("Local AI service shutdown timed out after 5 seconds.")
    except Exception as ex:
        logger.error("Error shutting down local AI service: %s", str(ex))

    # Shutdown the RetrieverManager
    try:
        logger.info("Shutting down RetrieverManager...")
        from src.main.service.retriever.retriever_manager import retriever_manager

        await asyncio.wait_for(retriever_manager.shutdown(), timeout=10.0)
    except TimeoutError:
        logger.warning("RetrieverManager shutdown timed out after 10 seconds.")
    except Exception as ex:
        logger.error("Error shutting down RetrieverManager: %s", str(ex))

    # Stop the MCP server
    try:
        from src.main.mcp.mcp_server_manager import stop_mcp_server

        await asyncio.wait_for(stop_mcp_server(), timeout=5.0)
    except TimeoutError:
        logger.warning("MCP server shutdown timed out after 5 seconds.")
    except Exception as ex:
        logger.error("Error shutting down MCP server: %s", str(ex))

    # Clean up database connections
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
    except Exception as ex:
        logger.error("Error shutting down database connections: %s", str(ex))

    # Retrieve instances from the state
    main_instance = getattr(_app.state, "main_instance", None)

    remaining_time = max(
        5.0,
        shutdown_timeout - (datetime.datetime.now(datetime.UTC) - shutdown_start_time).total_seconds(),
    )

    if main_instance:
        try:
            logger.info("Shutting down Main instance...")

            # noinspection PyUnresolvedReferences
            await asyncio.wait_for(main_instance.shutdown(), timeout=remaining_time)
        except TimeoutError:
            logger.warning("Main instance shutdown timed out after %.1f seconds.", remaining_time)
        except Exception as ex:
            logger.error("Error shutting down Main instance: %s", str(ex))
            logger.error(traceback.format_exc())
    else:
        logger.info("Main instance was not initialized, skipping shutdown.")

    # Clean up any remaining WebSocket connections
    try:
        logger.info("Shutting down WebSocket connections...")
        cancelled_tasks = []

        if websocket_manager and hasattr(websocket_manager, "scheduled_updates"):
            # Cancel any pending update tasks and collect them for awaiting
            for job_id, task in list(websocket_manager.scheduled_updates.items()):
                if not task.done():
                    logger.debug("Cancelling scheduled update task for job %s", job_id)
                    task.cancel()
                    cancelled_tasks.append(task)
            websocket_manager.scheduled_updates.clear()

            # Wait for canceled tasks to complete their cancellation
            if cancelled_tasks:
                logger.info("Waiting for %s cancelled WebSocket tasks to complete...", len(cancelled_tasks))
                # Calculate the remaining time for task cancellation
                elapsed = (datetime.datetime.now(datetime.UTC) - shutdown_start_time).total_seconds()
                remaining_time = max(3.0, shutdown_timeout - elapsed - 5.0)  # Reserve 5s for another cleanup

                # Store task references to prevent garbage collection issues
                task_refs = list(cancelled_tasks)

                await asyncio.wait_for(
                    asyncio.gather(*cancelled_tasks, return_exceptions=True),
                    timeout=remaining_time,
                )

                # Ensure all tasks are properly completed
                for task in task_refs:
                    if not task.done():
                        # Try to cancel again if needed
                        task.cancel()
                        try:
                            # Give each task a short time to complete cancellation
                            await asyncio.wait_for(task, timeout=0.1)
                        except (TimeoutError, asyncio.CancelledError) as e:
                            logger.debug("Shutdown task did not cancel cleanly: %s", e)

                # Keep references until explicitly cleared at the end of shutdown
                # This prevents premature garbage collection
                _app.state.cancelled_websocket_tasks = task_refs

                logger.info("WebSocket tasks cancelled successfully.")
            else:
                logger.info("No WebSocket tasks to cancel.")

            logger.info("WebSocket connections shutdown completed.")
    except Exception as ex:
        logger.error("Error shutting down WebSocket connections: %s", str(ex))

    # Final cleanup of any remaining asyncio tasks to prevent garbage collection exceptions
    try:
        logger.info("🧹 Performing final asyncio task cleanup...")

        # Use the robust cleanup utility with proper error handling
        try:
            cancelled_count = await cleanup_all_asyncio_tasks(timeout=2.0)  # Reduced timeout for faster shutdown

            if cancelled_count > 0:
                logger.info("Successfully cancelled %s tasks during shutdown", cancelled_count)
            else:
                logger.info("🧹 No pending tasks found for cleanup.")

        except asyncio.CancelledError:
            # This is expected during the shutdown - the cleanup itself might be cancelled
            logger.debug("Task cleanup was cancelled during shutdown - this is expected")
        except Exception as cleanup_error:
            logger.warning("Error during task cleanup: %s", str(cleanup_error))

        # Clear all task references to prevent garbage collection issues
        try:
            # Clear any stored task references
            if hasattr(_app.state, "background_init_task"):
                _app.state.background_init_task = None
            if hasattr(_app.state, "background_task"):
                _app.state.background_task = None
            if hasattr(_app.state, "cancelled_websocket_tasks"):
                _app.state.cancelled_websocket_tasks = None

            # Clear preloaded document service references
            if hasattr(_app.state, "document_service"):
                _app.state.document_service = None
            if hasattr(_app.state, "document_job_manager"):
                _app.state.document_job_manager = None
            if hasattr(_app.state, "document_processor"):
                _app.state.document_processor = None
            if hasattr(_app.state, "graph_integration_service"):
                _app.state.graph_integration_service = None

            # Force garbage collection to clean up tasks before event loop shutdown
            import gc

            gc.collect()

        except Exception as gc_error:
            logger.debug("Error during garbage collection: %s", str(gc_error))

    except Exception as final_cleanup_error:
        logger.error("Error during final asyncio task cleanup: %s", str(final_cleanup_error))

    total_shutdown_time = (datetime.datetime.now(datetime.UTC) - shutdown_start_time).total_seconds()
    logger.info(
        "Application shutdown sequence completed successfully. Total time: %.2fs",
        total_shutdown_time,
    )


# Initialize FastAPI application
try:
    app = FastAPI(
        title="Scrapalot Chat API",
        description="API for Scrapalot Chat application",
        version="1.0.0",
        lifespan=lifespan,
    )
    logger.info("FastAPI application instance created successfully")
except Exception as e:
    error_details = traceback.format_exc()
    logger.critical("Failed to create FastAPI application instance: %s", e)
    logger.critical("Error details: %s", error_details)
    raise

# Add security middleware (must be added before other middleware)
app.middleware("http")(security_middleware)
logger.info("🛡️ Security middleware enabled - protection against malicious requests active")

# Add the debug middleware *before* CORS middleware if possible,
# or just after app initialization to ensure it runs early.
app.middleware("http")(log_authorization_header_middleware)

# Mount WebSocket app BEFORE adding CORS middleware
# This prevents CORS middleware from interfering with WebSocket upgrade requests
try:
    logger.info("Mounting Socket.IO and STOMP WebSocket servers")
    app.mount("/ws", websocket_manager.get_app(), name="socketio_server")
    # Mount STOMP app if available
    if websocket_manager.stomp_app:
        app.mount("/stomp", websocket_manager.stomp_app, name="stomp_server")
        logger.info("STOMP server mounted successfully at /stomp")
    logger.info("Socket.IO server mounted successfully at /ws")
except Exception as e:
    error_details = traceback.format_exc()
    logger.critical("Failed to mount WebSocket servers: %s", e)
    logger.critical("Error details: %s", error_details)
    raise

# Add custom CORS middleware that exempts WebSocket paths
try:
    logger.info("Configuring CORS middleware")
    logger.debug("Full resolved_config security section: %s", resolved_config.get("security", {}))

    # Get CORS configuration from config file
    cors_config = resolved_config.get("security", {}).get("cors", {})
    allow_all_origins = cors_config.get("allow_all_origins", False)
    additional_origins = cors_config.get("additional_origins", [])
    allowed_methods = cors_config.get("allowed_methods", ["*"])
    allowed_headers = cors_config.get("allowed_headers", ["*"])

    # Start with default production origin
    origins = ["https://scrapalot.app"]  # Main production app

    # Add origins from config file
    origins.extend(additional_origins)

    # Remove duplicates while preserving order (dict.fromkeys() maintains insertion order in Python 3.7+)
    origins = list(dict.fromkeys(origins))

    logger.info("CORS origins from config: %s", origins)

    # CRITICAL: Validate CORS configuration for production safety
    # Wildcard (*) is incompatible with credentials mode (cookies/JWT)
    if allow_all_origins:
        logger.warning("⚠️ CORS configured with allow_all_origins=True. This will cause errors when credentials are used!")
        logger.warning("⚠️ Setting Access-Control-Allow-Origin to '*' is incompatible with credentials mode. Forcing specific origins instead.")
        # Force specific origins even if allow_all_origins is true
        # This prevents the CORS credentials error in production
        logger.info("CORS configured with specific origins (forced): %s", origins)
    else:
        logger.info("CORS configured with specific origins: %s", origins)

    # Custom CORS middleware wrapper that exempts WebSocket upgrade requests
    @app.middleware("http")
    async def custom_cors_middleware(request: Request, call_next):
        """
        Custom CORS middleware that exempts WebSocket upgrade requests.
        Standard CORSMiddleware doesn't handle WebSocket upgrades properly.

        IMPORTANT: In production, Gateway handles CORS - skip middleware to avoid duplicate headers.
        """
        # Check if running in production (Docker) - Gateway handles CORS
        is_production = (
            os.environ.get("ENVIRONMENT", "").lower() == "prod"
            or os.path.exists("/.dockerenv")  # Running in Docker
            or os.environ.get("CORS_HANDLED_BY_GATEWAY", "false").lower() == "true"
        )

        if is_production:
            # Production: Gateway handles CORS, just pass through without adding headers
            return await call_next(request)

        # Check if this is a WebSocket upgrade request
        is_websocket = request.headers.get("upgrade", "").lower() == "websocket" or request.headers.get("connection", "").lower() == "upgrade"

        # WebSocket paths that should bypass CORS
        websocket_paths = [
            "/ws",
            "/stomp",
            "/stomp-direct",
            "/api/ws/notes",
            "/ws-echo",
        ]
        is_websocket_path = any(request.url.path.startswith(path) for path in websocket_paths)

        if is_websocket and is_websocket_path:
            # For WebSocket upgrade requests, skip CORS middleware
            logger.debug("Bypassing CORS for WebSocket upgrade request: %s", request.url.path)
            return await call_next(request)

        # Get the origin from the request
        origin = request.headers.get("origin")

        # Handle CORS preflight (OPTIONS) requests
        if request.method == "OPTIONS":
            # Create response for preflight
            response = JSONResponse(content={}, status_code=200)

            if origin:
                # Check if origin is allowed
                origin_allowed = False

                # Check exact match in allowed origins
                if origin in origins:
                    origin_allowed = True

                # Check regex pattern for localhost/127.0.0.1
                import re

                if re.match(r"^https?://(127\.0\.0\.1|localhost):\d+$", origin):
                    origin_allowed = True

                if origin_allowed:
                    response.headers["Access-Control-Allow-Origin"] = origin
                    response.headers["Access-Control-Allow-Credentials"] = "true"
                    # Allow all common HTTP methods explicitly
                    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD"
                    # Get the headers requested by the browser
                    requested_headers = request.headers.get("access-control-request-headers", "")
                    if requested_headers:
                        # Allow exactly what the browser is requesting
                        response.headers["Access-Control-Allow-Headers"] = requested_headers
                    else:
                        # Allow common headers explicitly
                        response.headers["Access-Control-Allow-Headers"] = "authorization, content-type, accept, origin, x-requested-with"
                    response.headers["Access-Control-Max-Age"] = "3600"

            return response

        # For all other requests, apply standard CORS
        response = await call_next(request)

        if origin:
            # Check if origin is allowed
            origin_allowed = False

            # Check exact match in allowed origins
            if origin in origins:
                origin_allowed = True

            # Check regex pattern for localhost/127.0.0.1
            import re

            if re.match(r"^https?://(127\.0\.0\.1|localhost):\d+$", origin):
                origin_allowed = True

            if origin_allowed:
                response.headers["Access-Control-Allow-Origin"] = origin
                response.headers["Access-Control-Allow-Credentials"] = "true"
                response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD"
                response.headers["Access-Control-Allow-Headers"] = "authorization, content-type, accept, origin, x-requested-with"
                response.headers["Access-Control-Expose-Headers"] = "*"

        return response

    logger.info("Custom CORS middleware configured successfully (WebSocket-aware)")
except Exception as cors_err:
    error_details = traceback.format_exc()
    logger.critical("Failed to configure CORS middleware: %s", cors_err)
    logger.critical("Error details: %s", error_details)
    raise

# Create health check and WebSocket test endpoints
create_health_endpoints(app)
create_websocket_test_endpoints(app)

# All REST controllers deregistered — Kotlin backend handles all HTTP traffic via Gateway.
# Python only serves gRPC (port 9091) + WebSocket (notes collaboration) + health endpoints.
# Exception: YouTube transcript endpoint (requires server-side fetch, optional proxy support).


@app.get("/api/v1/youtube/transcript")
async def youtube_transcript(
    url: str,
    language: str = "en",
    include_timestamps: bool = True,
    include_metadata: bool = False,
):
    """Fetch YouTube transcript server-side. Supports proxy via config.yaml."""
    # noinspection PyProtectedMember
    from src.main.service.chat.attachment_processor import _fetch_youtube_transcript

    try:
        text = _fetch_youtube_transcript(
            url,
            language=language,
            include_timestamps=include_timestamps,
            include_metadata=include_metadata,
        )
        return {"transcript": text}
    except Exception as exc:
        return JSONResponse(status_code=422, content={"error": str(exc)})


# Report export endpoint (binary download — not suitable for gRPC streaming)


@app.get("/api/v1/research/templates")
async def get_research_templates():
    """Return all system research templates (seeded in migration 052)."""
    try:
        from src.main.config.database import SessionLocal
        from src.main.models.sqlmodel_research import ResearchTemplate

        db = SessionLocal()
        try:
            templates = (
                db.query(ResearchTemplate)
                # noinspection PyUnresolvedReferences
                .filter(ResearchTemplate.is_system.is_(True))
                .order_by(ResearchTemplate.name)
                .all()
            )
            return JSONResponse(
                content={
                    "templates": [
                        {
                            "id": str(t.id),
                            "name": t.name,
                            "description": t.description or "",
                            "template_type": t.template_type or "",
                            "methodology": t.methodology or "analytical",
                            "depth": t.depth,
                            "breadth": t.breadth,
                            "source_types": t.source_types or [],
                            "output_format": t.output_format,
                            "clarification_categories": t.clarification_categories or [],
                            "tone": t.tone,
                            "max_iterations": t.max_iterations,
                            "is_default": t.is_default,
                            "citation_style": t.citation_style,
                            "quality_standards": t.quality_standards,
                        }
                        for t in templates
                    ]
                }
            )
        finally:
            db.close()
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})


@app.post("/api/v1/research/export")
async def export_research_report(request: dict):
    """(CE) Research report export is part of Deep Research — a hosted-only feature."""
    return JSONResponse(
        status_code=501,
        content={"error": "Research report export is available in the hosted edition only."},
    )


# Add WebSocket endpoint for note collaboration


@app.websocket("/api/ws/notes/{note_id}")
async def note_collaboration_websocket(websocket: WebSocket, note_id: str):
    """WebSocket endpoint for real-time note collaboration."""
    logger.info("🔥 NOTE COLLABORATION WebSocket endpoint HIT for note_id: %s", note_id)
    try:
        logger.info(">>>>> About to call _handle_note_collaboration")
        # noinspection PyProtectedMember
        await websocket_manager._handle_note_collaboration(websocket, note_id)
        logger.info("<<<<< _handle_note_collaboration completed")
    except Exception as exc:
        logger.exception("!!!!! EXCEPTION in _handle_note_collaboration: %s", str(exc))


logger.info("Note collaboration WebSocket endpoint registered at /api/ws/notes/{note_id}")

# Setup upload directory for profile pictures and file serving
try:
    from src.main.utils.http.static_files import mount_data_directory

    mount_data_directory(app)
    logger.info("Upload directory mounted for profile pictures")
except Exception as e:
    logger.error("❌ Failed to setup upload directory: %s", e)


def get_app():
    """Returns the FastAPI application instance."""
    return app


# Exception handler for application-wide errors
@app.exception_handler(Exception)
@timing_decorator("Global Exception Handler")
async def global_exception_handler(request: Request, exc: Exception):
    """
    Global exception handler that reduces noise from malicious requests.
    """
    from src.main.utils.http.security import is_malicious_request

    # Check if this is a malicious request that we should handle quietly
    request_path = str(request.url.path)
    # noinspection PyUnresolvedReferences
    client_ip = request.client.host if request.client else "unknown"

    if is_malicious_request(request_path):
        # Log malicious requests at warning level, not error level
        logger.warning("🚫 Malicious request blocked: %s -> %s", client_ip, request_path)
        # Return 404 for malicious requests to not reveal application structure
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"detail": "Not Found"},
        )

    # For legitimate requests, log the full error details
    err_details = traceback.format_exc()
    logger.error("Unhandled exception in request %s: %s", request.url, exc)
    logger.error("Exception details: %s", err_details)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error", "type": type(exc).__name__},
    )
