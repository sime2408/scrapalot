import asyncio
import os
import platform
import signal
import sys
import traceback
import warnings

from dotenv import load_dotenv

# FastMCP instance
from fastmcp import FastMCP
import uvicorn

# Core application imports
from src.main.utils.core.logger import get_logger  # Import logger after path setup

# Set environment variable to suppress deprecation warnings at the system level
os.environ["PYTHONWARNINGS"] = "ignore::DeprecationWarning"

# Configure HuggingFace for Windows to avoid symlink issues

if platform.system() == "Windows":
    # Disable symlinks for HuggingFace Hub (requires admin privileges on Windows)
    os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
    os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"


# Configure Docling accelerator detection BEFORE any imports
# This must be set early to ensure Docling's internal accelerator detection uses the correct device
def setup_docling_accelerator_environment():
    """Set up Docling accelerator environment variables before any imports."""
    try:
        # Check if we have GPU capability by looking for LLM manager configuration
        # This is a simplified check - the full detection happens later in LLM manager
        gpu_available = False
        device_type = "cpu"

        # Try to detect GPU capability early (simplified detection)
        if platform.system() == "Windows":
            # Check for common GPU indicators
            try:
                import subprocess

                # Check for NVIDIA GPU
                result = subprocess.run(["nvidia-smi"], capture_output=True, text=True, timeout=5, check=False)
                if result.returncode == 0:
                    gpu_available = True
                    device_type = "cuda"
            # noinspection PyUnboundLocalVariable
            except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
                pass

            # Check for AMD GPU (OpenCL)
            if not gpu_available:
                try:
                    # Check for AMD GPU drivers or OpenCL
                    import winreg

                    key_path = r"SOFTWARE\Khronos\OpenCL\Vendors"
                    try:
                        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path):
                            gpu_available = True
                            device_type = "opencl"
                    except FileNotFoundError:
                        pass
                except ImportError:
                    winreg = None

        # Note: Docling device configuration is handled programmatically via AcceleratorOptions
        # in the document processor, not through environment variables.
        # See: https://docling-project.github.io/docling/examples/run_with_accelerator/

        # Set device-specific environment variables for other components (not Docling)
        if gpu_available:
            if device_type == "opencl":
                # For OpenCL GPUs (AMD), configure for CPU fallback but enable OpenCL where supported
                os.environ["TORCH_DEVICE"] = "cpu"  # Force PyTorch to CPU for OpenCL GPUs
                os.environ["DOCLING_FORCE_CPU_TORCH"] = "1"

                # OpenCL specific settings
                os.environ["GPU_FORCE_64BIT_PTR"] = "1"
                os.environ["GPU_MAX_HEAP_SIZE"] = "100"
                os.environ["GPU_MAX_ALLOC_PERCENT"] = "100"
            elif device_type == "cuda":
                # For CUDA GPUs (NVIDIA)
                os.environ["TORCH_DEVICE"] = "cuda"
                os.environ["CUDA_VISIBLE_DEVICES"] = "0"

            print(f"Configured for {device_type.upper()} acceleration (detected early)")
        else:
            # Ensure CPU-only configuration
            os.environ["TORCH_DEVICE"] = "cpu"
            print("Configured for CPU-only processing (no GPU detected)")

    except Exception as ex:
        # Fallback to CPU if detection fails
        os.environ["TORCH_DEVICE"] = "cpu"
        print(f"WARNING: GPU detection failed, using CPU fallback: {ex}")


# Set up Docling environment before any potential imports
setup_docling_accelerator_environment()


# Suppress websockets and uvicorn deprecation warnings
# Consolidated filters to avoid duplication and improve performance
def setup_warning_filters():
    """Set up warning filters to suppress known deprecation warnings."""
    # General deprecation warning suppression
    warnings.filterwarnings("ignore", category=DeprecationWarning)

    # Websockets-related warnings (covers all websockets modules and messages)
    warnings.filterwarnings("ignore", category=DeprecationWarning, module=".*websockets.*")
    warnings.filterwarnings("ignore", category=DeprecationWarning, module=".*uvicorn.*")

    # Catch-all for websockets messages
    warnings.filterwarnings("ignore", ".*websockets.*", DeprecationWarning)


# Apply warning filters
setup_warning_filters()

mcp = FastMCP("Scrapalot Chat")

# Disable SSL certificate verification for internal services
# This fixes the "Invalid argument" error when SSL_CERT_FILE points to an invalid path
os.environ["SSL_CERT_FILE"] = ""
os.environ["CURL_CA_BUNDLE"] = ""
os.environ["REQUESTS_CA_BUNDLE"] = ""
os.environ["NODE_EXTRA_CA_CERTS"] = ""

# Also, set httpx to not verify SSL by default - safer than modifying the client directly
os.environ["HTTPX_VERIFY"] = "false"

load_dotenv()

# Enable migrations by default unless explicitly disabled
if "ENABLE_MIGRATIONS" not in os.environ:
    os.environ["ENABLE_MIGRATIONS"] = "1"
    print("ENABLE_MIGRATIONS set to '1' by default")

# Configure logging after path setup
logger = get_logger(__name__)

# Explicitly add the script's directory (which contains 'src') to sys.path
# This helps Uvicorn find the 'src' package when using 'src.main.app_instance:app'
script_dir = os.path.dirname(os.path.abspath(__file__))
if script_dir not in sys.path:
    sys.path.insert(0, script_dir)

if sys.platform.startswith("win"):
    # This policy is often needed for asyncio on Windows
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

# Global variables for graceful shutdown
server_instance = None
shutdown_event = None


def signal_handler(signum, _frame):
    """Handle shutdown signals gracefully."""
    signal_name = signal.Signals(signum).name if hasattr(signal, "Signals") else str(signum)
    logger.info("Received signal %s (%s). Initiating graceful shutdown...", signal_name, signum)

    # Signal uvicorn server to shut down
    if server_instance:
        server_instance.should_exit = True

    # Set shutdown event if available
    if shutdown_event and not shutdown_event.is_set():
        shutdown_event.set()


def setup_signal_handlers():
    """Set up signal handlers for graceful shutdown."""
    if sys.platform.startswith("win"):
        # Windows only supports SIGINT and SIGTERM
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
        logger.debug("Signal handlers set up for Windows (SIGINT, SIGTERM)")
    else:
        # Unix systems support more signals
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
        if hasattr(signal, "SIGHUP"):
            signal.signal(signal.SIGHUP, signal_handler)
            logger.debug("Signal handlers set up for Unix (SIGINT, SIGTERM, SIGHUP)")
        else:
            logger.debug("Signal handlers set up for Unix (SIGINT, SIGTERM)")


async def start_grpc_server_background():
    """Start gRPC server in background and keep it running."""
    try:
        # Generated pb2_grpc files use bare imports (e.g. "import chat_pb2")
        # noinspection PyTypeChecker
        grpc_dir = os.path.join(os.path.dirname(__file__), "src", "main", "grpc")
        if grpc_dir not in sys.path:
            # noinspection PyTypeChecker
            sys.path.insert(0, grpc_dir)

        from src.main.grpc.server import GrpcServer

        grpc_server = GrpcServer()
        logger.info("Starting gRPC server in background (port 9091)...")
        await grpc_server.start()
        # Keep server running by waiting for termination
        await grpc_server.wait_for_termination()
    # noinspection PyBroadException,PyShadowingNames
    except Exception as exc:
        logger.exception("Failed to start gRPC server: %s", str(exc))
        # Don't fail if gRPC server fails - FastAPI can still work


async def run_server_with_graceful_shutdown():
    """Run uvicorn server with fast port binding but proper graceful shutdown."""
    # Use the port that was already determined and set in SCRAPALOT_PORT
    # noinspection PyShadowingNames
    port = int(os.environ.get("SCRAPALOT_PORT", os.environ.get("PORT", 8090)))

    logger.info("Starting Scrapalot Chat server with fast binding and graceful shutdown...")
    logger.info("🚀 Uvicorn will bind to 0.0.0.0:%s", port)

    # Enterprise-grade uvicorn config for thousands of concurrent users
    is_production = os.environ.get("ENVIRONMENT", "dev").lower() == "prod"

    # FastAPI serves ONLY health check + WebSocket (notes collaboration).
    # ALL AI/ML work goes through the gRPC server (port 9091) which shares this
    # asyncio event loop. Using workers=1 is critical: with workers > 1, uvicorn's
    # multiprocess supervisor blocks the event loop, starving the gRPC server.
    worker_count = 1
    max_connections = 2000
    backlog_size = 4096
    keep_alive = 65 if is_production else 30
    concurrency_limit = 2000

    logger.info("FastAPI Configuration (health + WebSocket only):")
    logger.info("   • Workers: %s (gRPC server shares event loop)", worker_count)
    logger.info("   • Max connections: %s", max_connections)
    logger.info("   • Environment: %s", "Production" if is_production else "Development")

    # Set up a custom logging filter for uvicorn access logs
    import logging

    from src.main.utils.core.logger import ServiceLogsFilter

    # Apply filter to uvicorn access logger to exclude service-logs endpoint
    # noinspection PyShadowingNames
    uvicorn_access_logger = logging.getLogger("uvicorn.access")
    # noinspection PyShadowingNames
    service_logs_filter = ServiceLogsFilter()
    uvicorn_access_logger.addFilter(service_logs_filter)

    config = uvicorn.Config(
        "src.main.app_instance:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        log_config=None,  # Use our existing logging configuration
        access_log=True,
        workers=worker_count,
        backlog=backlog_size,
        limit_concurrency=concurrency_limit,
        # Performance optimizations
        loop="asyncio",
        http="httptools",  # Faster HTTP parsing
        ws="websockets",  # WebSocket support for real-time chat
        lifespan="on",  # Enable lifespan events
        # Connection management for chat applications
        timeout_keep_alive=keep_alive,
        timeout_graceful_shutdown=80,  # Must be < docker stop_grace_period (90s)
        # Production stability
        use_colors=not is_production,  # Disable colors in production logs
        server_header=False,  # Hide server version for security
        date_header=True,  # Include date headers
    )

    # Create server instance for proper shutdown control
    # noinspection PyShadowingNames
    server_instance = uvicorn.Server(config)

    # This binds the port immediately
    try:
        logger.info("🚀 Starting uvicorn server on 0.0.0.0:%s...", port)
        await server_instance.serve()
    # noinspection PyBroadException,PyShadowingNames
    except Exception as exc:
        logger.error("Failed to start uvicorn server: %s", exc)
        logger.error("Error details: %s", traceback.format_exc())
        raise


# Background initialization moved to app_instance.py startup events
# This keeps run_service.py focused on immediate server startup


if __name__ == "__main__":
    try:
        # Set up signal handlers
        setup_signal_handlers()

        # Debug environment variables
        logger.info("🔍 Environment variable debug:")
        env_vars_to_check = [
            "ENVIRONMENT",
        ]
        for var in env_vars_to_check:
            value = os.environ.get(var, "NOT_SET")
            logger.info("   • %s=%s", var, value)

        # Force Render detection if we're in Docker with a production environment
        if os.environ.get("ENVIRONMENT") == "prod":
            logger.info("🐳 Docker production environment detected - assuming Render deployment")
            is_render = True

        # Get port
        port = int(os.environ.get("PORT", 8090))
        logger.info("🏠 Local development mode - using port %s", port)

        logger.info("🚀 FAST STARTUP: Starting server immediately...")

        # Ensure the port is passed to the server function
        os.environ["SCRAPALOT_PORT"] = str(port)

        # Start both FastAPI and gRPC servers - background initialization handled by FastAPI startup events
        async def start_servers_immediately():
            try:
                logger.info("🚀 About to start FastAPI server (port %s) and gRPC server (port 9091)...", port)
                # Start both servers concurrently
                await asyncio.gather(
                    run_server_with_graceful_shutdown(),
                    start_grpc_server_background(),
                    return_exceptions=True,  # Don't fail if gRPC fails
                )
            # noinspection PyShadowingNames
            except Exception as exc:
                logger.error("❌ Failed to start servers: %s", exc)
                logger.error("Error details: %s", traceback.format_exc())
                raise

        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            logger.info("🔄 Starting asyncio event loop...")
            loop.run_until_complete(start_servers_immediately())
        except Exception as exc:
            logger.error("❌ Event loop failed: %s", exc)
            logger.error("Error details: %s", traceback.format_exc())
            # Try direct uvicorn approach as fallback
            logger.info("🔄 Attempting direct uvicorn startup as fallback...")
            # Apply the same logging filter to fallback uvicorn
            import logging

            import uvicorn as fallback_uvicorn

            from src.main.utils.core.logger import ServiceLogsFilter

            uvicorn_access_logger = logging.getLogger("uvicorn.access")
            service_logs_filter = ServiceLogsFilter()
            uvicorn_access_logger.addFilter(service_logs_filter)

            fallback_uvicorn.run("src.main.app_instance:app", host="0.0.0.0", port=port, reload=False, log_level="info")

    except (KeyboardInterrupt, asyncio.CancelledError):
        logger.info("Application shutdown requested by user or system.")
    except SystemExit as e:
        logger.info("Application exiting with code: %s", e.code)
    except Exception as e:
        logger.critical("Fatal error during server startup: %s", str(e))
        logger.critical("Error details: %s", traceback.format_exc())
        sys.exit(1)
    finally:
        logger.info("Server shutdown complete.")
