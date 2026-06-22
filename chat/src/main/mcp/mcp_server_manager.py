"""MCP Server Manager for Scrapalot Chat

This module manages the lifecycle of the MCP server, allowing it to be started
and stopped as part of the main application lifecycle.

Follows controller patterns for consistent error handling and logging.
"""

import asyncio
from functools import wraps
import os
import subprocess
import sys
import time

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def log_mcp_manager_performance(func):
    """Decorator to log MCP manager performance metrics"""

    @wraps(func)
    async def async_wrapper(*args, **kwargs):
        start_time = time.time()
        operation_name = f"{func.__name__}"

        try:
            result = await func(*args, **kwargs)
            duration = time.time() - start_time
            logger.info("[MCP_MANAGER] %s completed in %.3fs", operation_name, duration)
            return result
        except Exception as e:
            duration = time.time() - start_time
            logger.error("[MCP_MANAGER] %s failed after %.3fs: %s", operation_name, duration, str(e))
            raise

    @wraps(func)
    def sync_wrapper(*args, **kwargs):
        start_time = time.time()
        operation_name = f"{func.__name__}"

        try:
            result = func(*args, **kwargs)
            duration = time.time() - start_time
            logger.info("[MCP_MANAGER] %s completed in %.3fs", operation_name, duration)
            return result
        except Exception as e:
            duration = time.time() - start_time
            logger.error("[MCP_MANAGER] %s failed after %.3fs: %s", operation_name, duration, str(e))
            raise

    return async_wrapper if asyncio.iscoroutinefunction(func) else sync_wrapper


def handle_mcp_manager_errors(func):
    """Decorator to handle MCP manager errors consistently"""

    @wraps(func)
    async def async_wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)
        except subprocess.SubprocessError as e:
            logger.error("Subprocess error in %s: %s", func.__name__, str(e))
            return False
        except OSError as e:
            logger.error("OS error in %s: %s", func.__name__, str(e))
            return False
        except Exception as e:
            logger.error("Unexpected error in %s: %s", func.__name__, str(e))
            return False

    @wraps(func)
    def sync_wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except subprocess.SubprocessError as e:
            logger.error("Subprocess error in %s: %s", func.__name__, str(e))
            return False
        except OSError as e:
            logger.error("OS error in %s: %s", func.__name__, str(e))
            return False
        except Exception as e:
            logger.error("Unexpected error in %s: %s", func.__name__, str(e))
            return False

    return async_wrapper if asyncio.iscoroutinefunction(func) else sync_wrapper


class MCPServerManager:
    """Manager for the MCP server lifecycle"""

    def __init__(self):
        self.process: subprocess.Popen | None = None
        self.is_running = False

    @log_mcp_manager_performance
    @handle_mcp_manager_errors
    async def start_server(self) -> bool:
        """
        Start the MCP server as a subprocess

        Returns:
            bool: True if server started successfully, False otherwise
        """
        if self.is_running:
            logger.warning("MCP server is already running")
            return True

        try:
            # Get the path to the MCP server script
            script_dir = os.path.dirname(os.path.abspath(__file__))
            mcp_server_path = os.path.join(script_dir, "scrapalot_mcp_server.py")

            if not os.path.exists(mcp_server_path):
                logger.error("MCP server script not found at: %s", mcp_server_path)
                return False

            # Start the MCP server process
            logger.info("Starting MCP server...")

            # Use the same Python executable that's running the main application
            python_executable = sys.executable

            # Start the process with stdio pipes for MCP communication
            self.process = subprocess.Popen(
                [python_executable, mcp_server_path],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=0,  # Unbuffered for real-time communication
                # noinspection PyTypeChecker
                cwd=str(os.path.dirname(os.path.dirname(os.path.dirname(script_dir)))),  # Project root
            )

            # Give the process a moment to the start
            await asyncio.sleep(1)

            # Check if the process is still running (didn't crash immediately)
            # noinspection PyUnresolvedReferences
            if self.process.poll() is None:
                self.is_running = True
                # noinspection PyUnresolvedReferences
                logger.info("MCP server started successfully with PID: %s", self.process.pid)
                return True
            else:
                # Process terminated immediately, check for errors
                # noinspection PyUnresolvedReferences
                stderr_output = self.process.stderr.read() if self.process.stderr else "No error output"
                logger.error("MCP server failed to start. Error: %s", stderr_output)
                self.process = None
                return False

        except Exception as e:
            logger.error("Failed to start MCP server: %s", str(e))
            if self.process:
                try:
                    self.process.terminate()
                except Exception as e:
                    logger.debug("Suppressed exception: %s", e)
                self.process = None
            return False

    async def stop_server(self) -> bool:
        """
        Stop the MCP server

        Returns:
            bool: True if server stopped successfully, False otherwise
        """
        if not self.is_running or not self.process:
            logger.info("MCP server is not running")
            return True

        try:
            logger.info("Stopping MCP server...")

            # Try graceful shutdown first
            self.process.terminate()

            # Wait for graceful shutdown with timeout
            try:
                await asyncio.wait_for(asyncio.create_task(self._wait_for_process_end()), timeout=5.0)
                logger.info("MCP server stopped gracefully")
            except TimeoutError:
                # Force kill if graceful shutdown failed
                logger.warning("MCP server didn't stop gracefully, forcing termination...")
                self.process.kill()
                await asyncio.sleep(1)

            self.process = None
            self.is_running = False
            return True

        except Exception as e:
            logger.error("Error stopping MCP server: %s", str(e))
            # Force cleanup
            if self.process:
                try:
                    self.process.kill()
                except Exception as e:
                    logger.debug("Suppressed exception: %s", e)
                self.process = None
            self.is_running = False
            return False

    async def _wait_for_process_end(self):
        """Wait for the process to end (helper for asyncio compatibility)"""
        while self.process and self.process.poll() is None:
            await asyncio.sleep(0.1)

    def get_status(self) -> dict:
        """
        Get the current status of the MCP server

        Returns:
            dict: Status information
        """
        if not self.is_running or not self.process:
            return {"running": False, "pid": None, "status": "stopped"}

        # Check if process is still alive
        if self.process.poll() is None:
            return {"running": True, "pid": self.process.pid, "status": "running"}
        else:
            # Process died
            self.is_running = False
            return {"running": False, "pid": self.process.pid if self.process else None, "status": "crashed"}


# Global instance
mcp_server_manager = MCPServerManager()


async def start_mcp_server() -> bool:
    """Start the MCP server (convenience function)"""
    return await mcp_server_manager.start_server()


async def stop_mcp_server() -> bool:
    """Stop the MCP server (convenience function)"""
    return await mcp_server_manager.stop_server()


def get_mcp_server_status() -> dict:
    """Get MCP server status (convenience function)"""
    return mcp_server_manager.get_status()
