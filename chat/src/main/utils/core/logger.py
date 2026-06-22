"""
Logging utilities for the application with enhanced formatting and timing decorators.
Provides get_logger() function, color formatting, and timing decorators.
"""

# noinspection PyPackageRequirements
from contextvars import ContextVar  # contextvars is part of Python standard library (3.7+)
import datetime
import functools
import inspect
import io
import logging
import logging.config
import logging.handlers
import os
import time

# Initialize a rich console for reliable colored output across all platforms
# Rich handles ANSI support automatically on Windows, Linux, Mac, IntelliJ, Docker, etc.
# noinspection PyBroadException
try:
    from rich.console import Console

    # Create a global console instance for ANSI color support
    # Rich automatically detects terminal capabilities and enables colors appropriately
    # Works reliably in: Windows CMD, PowerShell, IntelliJ, VS Code, Docker, Linux, Mac
    _rich_console = Console(
        force_terminal=True,  # Always enable colors (we want them in logs)
        legacy_windows=True,  # Enable colors on older Windows consoles
        force_interactive=False,  # Don't use interactive features (we're just logging)
    )

    # Enable Windows ANSI support via rich (no colorama needed)
    # Rich handles this internally using Windows Console API
    import sys

    if sys.platform.startswith("win"):
        # Rich automatically enables ANSI on Windows when Console is created
        # This works in all Windows environments: CMD, PowerShell, IntelliJ, VS Code
        pass
except Exception:
    # If rich initialization fails, ANSI codes will still pass through on systems that support them
    pass

# Define custom TIMING log level
TIMING_LEVEL = 25  # Between INFO (20) and WARNING (30)
logging.addLevelName(TIMING_LEVEL, "TIMING")

# Context variable to store user_id across async calls
user_id_context: ContextVar[str | None] = ContextVar("user_id", default=None)


class ServiceLogsFilter(logging.Filter):
    """Filter to exclude noisy endpoints from access logs to reduce log noise."""

    def filter(self, record):
        """
        Filter out log records for noisy endpoints like health checks, service logs, and polling endpoints.

        Args:
            record: The log record to filter

        Returns:
            False if the record should be filtered out, True otherwise
        """
        # Check if this is an access log record
        if hasattr(record, "getMessage"):
            message = record.getMessage()

            # Filter out OPTIONS requests (CORS preflight) - these are noisy and not useful at INFO level
            if "OPTIONS" in message:
                return False

            # Filter out service-logs endpoint requests
            if "/service-logs" in message and ("GET" in message or "POST" in message):
                return False

            # Filter out health check endpoint requests in production
            # Health checks from Portainer/Nginx every 10-30 seconds create excessive logs
            environment = os.environ.get("ENVIRONMENT", "dev").lower()
            if environment == "prod" and "/health" in message and "GET" in message and "200" in message:
                return False

            # Filter out frequently polled job status endpoints (every 5 seconds)
            # These create excessive noise in logs when no jobs are running
            if "/api/v1/jobs/active" in message and "GET" in message and "200" in message:
                return False
            if "/api/v1/jobs/status" in message and "GET" in message and "200" in message:
                return False

        return True


def _is_debugger_environment():
    """Detect if we're running in a debugger environment like PyCharm."""
    import sys

    # Check for PyCharm debugger
    if "pydevd" in sys.modules:
        return True
    # Check for other debuggers
    if hasattr(sys, "gettrace") and sys.gettrace() is not None:
        return True
    # Check for PyCharm specific environment variables
    return bool(any(key.startswith("PYCHARM") for key in os.environ))


class UTF8StreamHandler(logging.StreamHandler):
    """
    Custom StreamHandler that properly handles UTF-8 encoding on Windows.
    This allows Unicode characters (like emojis) to be displayed correctly.
    Falls back to ASCII replacements if UTF-8 encoding fails.
    """

    # Emoji to ASCII mapping for fallback
    EMOJI_FALLBACKS = {
        "🔄": "[*]",
        "⚠️": "! ",
        "❌": "X ",
        "🔥": "!! ",
        "🚀": "-> ",
        "🕒": "<- ",
        "🗄️": "[DB]",
        "💭": "[*]",
        "✔️": "[OK]",
    }

    def __init__(self, stream=None):
        # On Windows, try to wrap the stream with UTF-8 encoding to handle Unicode characters
        if stream is None:
            stream = sys.stderr

        # Store original stream for fallback
        self._original_stream = stream
        self._utf8_wrapped = False
        self._debugger_mode = _is_debugger_environment()

        # Skip UTF-8 wrapping in debugger environments as they often have closed streams
        if not self._debugger_mode and sys.platform.startswith("win"):
            if hasattr(stream, "buffer") and hasattr(stream.buffer, "write"):
                try:
                    # Check if buffer is actually writable
                    if hasattr(stream.buffer, "closed") and stream.buffer.closed:
                        raise ValueError("Stream buffer is closed")

                    # Create a UTF-8 wrapper for Windows console to handle Unicode emojis
                    wrapped_stream = io.TextIOWrapper(stream.buffer, encoding="utf-8", errors="replace")
                    stream = wrapped_stream
                    self._utf8_wrapped = True
                except (ValueError, OSError, AttributeError):
                    # If wrapping fails, fall back to the original stream
                    stream = self._original_stream
                    self._utf8_wrapped = False

        super().__init__(stream)

    def emit(self, record):
        """
        Emit a record with Unicode fallback handling.
        If Unicode encoding fails, replace emojis with ASCII equivalents.
        """
        # Check if the stream is closed before attempting to write
        # noinspection PyBroadException
        try:
            if hasattr(self.stream, "closed") and self.stream.closed:
                return  # Silently skip if the stream is closed

            # Check if the wrapped stream (from colorama) has a closed wrapped stream
            if hasattr(self.stream, "wrapped") and hasattr(self.stream.wrapped, "closed"):
                if self.stream.wrapped.closed:
                    return  # Colorama wrapped stream is closed

        except Exception:
            return  # If we can't even check, skip writing

        # In debugger mode, always use ASCII fallback to avoid stream issues
        if self._debugger_mode:
            self._emit_with_fallback(record)
            return

        # For normal console/file logging, try emojis first
        try:
            super().emit(record)
        except UnicodeEncodeError:
            # Replace emojis with ASCII equivalents and try again
            self._emit_with_fallback(record)
        except (ValueError, OSError, AttributeError):
            # If the stream is closed or unavailable, try fallback or silently ignore
            # AttributeError can occur if colorama's wrapped stream is being accessed after close
            # noinspection PyBroadException
            try:
                self._emit_with_fallback(record)
            except Exception:
                # Complete failure - silently ignore to prevent an application crash
                pass

    def _emit_with_fallback(self, record):
        """Emit record with emoji fallback replacements."""
        original_msg = record.getMessage()
        fallback_msg = original_msg

        # Replace emojis with ASCII equivalents
        for emoji, ascii_replacement in self.EMOJI_FALLBACKS.items():
            fallback_msg = fallback_msg.replace(emoji, ascii_replacement)

        # Temporarily replace the message
        original_format = record.msg
        original_args = record.args

        record.msg = fallback_msg
        record.args = ()

        try:
            super().emit(record)
        except (ValueError, OSError, UnicodeEncodeError):
            # Even fallback failed - silently ignore to prevent crashes
            pass
        finally:
            # Restore an original message
            record.msg = original_format
            record.args = original_args


class UTF8FileHandler(logging.FileHandler):
    """
    Custom FileHandler that ensures UTF-8 encoding for log files.
    This allows Unicode characters (like emojis) to be written to file correctly.
    """

    def __init__(self, filename, mode="a", _encoding="utf-8", delay=False, _errors=None):
        # Force UTF-8 encoding for all file operations
        super().__init__(filename, mode, encoding="utf-8", delay=delay, errors="replace")


class UTF8RotatingFileHandler(logging.handlers.RotatingFileHandler):
    """
    Custom RotatingFileHandler that ensures UTF-8 encoding for log files.
    This allows Unicode characters (like emojis) to be written to file correctly.
    """

    def __init__(self, filename, mode="a", max_bytes=0, backup_count=0, _encoding="utf-8", delay=False, _errors=None):
        # Force UTF-8 encoding for all file operations
        super().__init__(filename, mode, max_bytes, backup_count, encoding="utf-8", delay=delay, errors="replace")


class UTF8TimedRotatingFileHandler(logging.handlers.TimedRotatingFileHandler):
    """
    Custom TimedRotatingFileHandler with daily rotation and date-based naming.

    Features:
    - Current day logs go to 'scrapalot.log'
    - Previous days get rotated to 'scrapalot-ddMMYYYY.log'
    - UTF-8 encoding for Unicode characters
    - Automatic cleanup of old log files
    """

    # Maximum log file size before forced rotation (50MB)
    MAX_BYTES = 50 * 1024 * 1024

    # noinspection PyPep8Naming
    def __init__(self, filename, when="midnight", interval=1, backupCount=1, _encoding="utf-8", delay=False, utc=False):
        # Force UTF-8 encoding and set up daily rotation
        super().__init__(
            filename,
            when=when,
            interval=interval,
            backupCount=backupCount,
            encoding="utf-8",
            delay=delay,
            utc=utc,
            errors="replace",
        )

        # Store the base filename without extension for custom naming
        # noinspection PyTypeChecker
        self.base_filename = os.path.splitext(filename)[0]
        # noinspection PyTypeChecker
        self.log_dir = os.path.dirname(filename)

    def shouldRollover(self, record):
        """Rotate on time OR when the file exceeds MAX_BYTES."""
        if super().shouldRollover(record):
            return True
        if self.stream:
            try:
                self.stream.seek(0, 2)
                if self.stream.tell() >= self.MAX_BYTES:
                    return True
            except (OSError, ValueError):
                # Stream closed/unseekable; defer to time-based rotation.
                # Avoid logging here — we are inside the logging handler.
                pass
        return False

    # Maximum total size of all rotated log files (200MB)
    MAX_TOTAL_SIZE = 200 * 1024 * 1024

    def getFilesToDelete(self):
        """
        Determine the files to delete when going over the backup count.
        Deletes files older than 24 hours AND enforces a total size cap.
        """
        dir_name, _ = os.path.split(self.baseFilename)
        file_names = os.listdir(dir_name)
        result = []
        current_time = time.time()
        twenty_four_hours_ago = current_time - (24 * 60 * 60)

        import re

        pattern = re.compile(r"^scrapalot-\d{8}.*\.log$")

        rotated_files = []
        for file_name in file_names:
            if pattern.match(file_name):
                file_path = os.path.join(dir_name, file_name)
                try:
                    mtime = os.path.getmtime(file_path)
                    size = os.path.getsize(file_path)
                    if mtime < twenty_four_hours_ago:
                        result.append(file_path)
                    else:
                        rotated_files.append((file_path, mtime, size))
                except OSError:
                    continue

        # Enforce total size cap on remaining (non-expired) rotated files
        rotated_files.sort(key=lambda x: x[1], reverse=True)  # newest first
        total_size = 0
        for file_path, _, size in rotated_files:
            total_size += size
            if total_size > self.MAX_TOTAL_SIZE:
                result.append(file_path)

        result.sort(key=os.path.getmtime)
        return result

    def doRollover(self):
        """
        Do a rollover with custom date-based naming.
        The Current log becomes scrapalot-ddMMYYYY.log and a new scrapalot.log is created.
        Windows-compatible version with proper file handle management and retry logic.
        """
        # Ensure the stream is properly closed and a handle is released
        if self.stream:
            self.stream.close()
            self.stream = None

        # Force garbage collection to release any lingering file handles
        import gc

        gc.collect()

        # Get yesterday's date for the rotated file
        import datetime

        yesterday = datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=1)
        date_suffix = yesterday.strftime("%d%m%Y")

        # Create the rotated filename
        rotated_filename = f"scrapalot-{date_suffix}.log"
        rotated_path = os.path.join(self.log_dir, rotated_filename)

        # Only rotate if the current log file exists and has content
        if os.path.exists(self.baseFilename) and os.path.getsize(self.baseFilename) > 0:
            # If the rotated file already exists, append a counter
            counter = 1
            while os.path.exists(rotated_path):
                rotated_filename = f"scrapalot-{date_suffix}-{counter}.log"
                rotated_path = os.path.join(self.log_dir, rotated_filename)
                counter += 1

            # Windows-compatible file rotation with retry mechanism
            self._rotate_file_windows_safe(self.baseFilename, rotated_path)

        # Clean up old files if necessary
        files_to_delete = self.getFilesToDelete()
        for file_path in files_to_delete:
            self._safe_remove_file(file_path)

        # Create a new log file
        if not self.delay:
            self.stream = self._open()

        # Update rollover time for next rotation
        current_time = int(time.time())
        dst_now = time.daylight and time.localtime().tm_isdst
        new_rollover_at = self.computeRollover(current_time)
        while new_rollover_at <= current_time:
            new_rollover_at = new_rollover_at + self.interval

        # If DST changes and midnight or weekly rollover, adjust
        if (self.when == "MIDNIGHT" or self.when.startswith("W")) and not self.utc:
            dst_at_rollover = time.localtime(new_rollover_at).tm_isdst
            if dst_now != dst_at_rollover:
                if not dst_now:  # DST kicks in before next rollover, so we need to deduct an hour
                    addend = -3600
                else:  # DST bows out before next rollover, so we need to add an hour
                    addend = 3600
                new_rollover_at += addend

        self.rolloverAt = new_rollover_at

    @staticmethod
    def _rotate_file_windows_safe(source_path, target_path):
        """
        Windows-safe file rotation with retry mechanism and proper error handling.
        """
        import shutil
        import time

        max_retries = 5
        retry_delay = 0.1  # Start with 100ms delay

        for attempt in range(max_retries):
            try:
                # Try to rename first (most efficient)
                os.rename(source_path, target_path)
                return  # Success!
            except (OSError, PermissionError):
                if attempt == max_retries - 1:
                    # Last attempt - try copy and delete as fallback
                    try:
                        shutil.copy2(source_path, target_path)
                        # Wait a bit before trying to delete
                        time.sleep(0.2)
                        os.remove(source_path)
                        return  # Success with copy/delete
                    except (OSError, PermissionError):
                        # If all else fails, truncate the original file
                        try:
                            with open(source_path, "w", encoding="utf-8") as f:
                                f.truncate(0)
                        except (OSError, PermissionError):
                            pass  # Give up gracefully
                        return
                else:
                    # Wait and retry with exponential backoff
                    time.sleep(retry_delay)
                    retry_delay *= 2  # Double the delay for next attempt

    @staticmethod
    def _safe_remove_file(file_path):
        """
        Safely remove a file with retry mechanism for Windows compatibility.
        """
        import time

        max_retries = 3
        retry_delay = 0.1

        for attempt in range(max_retries):
            try:
                os.remove(file_path)
                return  # Success!
            except (OSError, PermissionError):
                if attempt < max_retries - 1:
                    time.sleep(retry_delay)
                    retry_delay *= 2
                # On final attempt, just ignore the error


class ColorFormatter(logging.Formatter):
    """
    Enhanced logging formatter with comprehensive visual organization:

    Features:
    1. **Selective Icons**: Visual indicators for WARNING (⚠️), ERROR (❌), and CRITICAL (🔥) levels only
    2. **Module Colors**: Logger names colored by module type (AI/ML=blue, Database=purple, Security=red, etc.)
    3. **Level Colors**: Entire lines colored by severity (DEBUG=gray, INFO=white, WARNING=orange, ERROR=red)
    4. **Alignment**: Improved vertical alignment with proper spacing and separators (|)
    5. **Smart Truncation**: Long logger names are intelligently abbreviated (e.g., s.m.s.g.graph_integration_service)

    Format: timestamp [icon][level   ] module_name | message (icons only for WARNING/ERROR/CRITICAL)
    """

    # ANSI color codes
    COLORS = {
        "DEBUG": "\033[90m",  # Light gray
        "INFO": "\033[1;37m",  # White bold
        "TIMING": "\033[37m",  # White
        "WARNING": "\033[38;5;208m",  # Orange
        "ERROR": "\033[31m",  # Red
        "CRITICAL": "\033[31m",  # Red
    }
    RESET = "\033[0m"

    # Module/package color mappings - colors based on logger name patterns
    MODULE_COLORS = {
        # AI/ML Components
        "langchain": "\033[94m",  # Light blue
        "llm": "\033[94m",
        "embedding": "\033[94m",
        "gguf": "\033[94m",  # Light blue for GGUF models
        "huggingface": "\033[94m",  # Light blue for HuggingFace
        "sentence-transformers": "\033[94m",  # Light blue for sentence transformers
        "rag": "\033[92m",  # Light green
        "retrieval": "\033[92m",
        "chunk": "\033[92m",
        # Database & Storage
        "database": "\033[33m",  # Brown/yellow
        "postgres": "\033[34m",  # Blue
        "sql": "\033[34m",
        "db": "\033[34m",
        "cache": "\033[35m",  # Purple
        "redis": "\033[35m",
        "memory": "\033[1;34m",  # Bold blue
        # Graph & Entities
        "entity": "\033[95m",  # Light purple
        "graph": "\033[95m",
        # Security & Auth
        "security": "\033[33m",  # Brown
        "auth": "\033[38;5;33m",  # Bright blue
        "jwt": "\033[38;5;33m",  # Bright blue
        # Web Server & HTTP
        "uvicorn": "\033[96m",  # Cyan
        "fastapi": "\033[96m",  # Cyan
        "httpcore": "\033[36m",  # Dark cyan
        "httpx": "\033[36m",  # Dark cyan
        # Network & API
        "request": "\033[93m",  # Light yellow
        "http": "\033[93m",
        "api": "\033[93m",
    }

    def __init__(self, fmt=None, datefmt=None, style="%"):
        """Initialize the color formatter."""
        if fmt is None:
            fmt = "%(asctime)s %(levelname_icon)s[%(levelname)-7s] %(name)s | %(message)s"
        super().__init__(fmt, datefmt, style)

    def format(self, record):
        """Format the log record with colors and icons."""
        # Add icons only for WARNING, ERROR, and CRITICAL levels
        level_icons = {
            "DEBUG": "",  # No icon for debug
            "INFO": "",  # No icon for info
            "TIMING": "",  # No icon for timing
            "WARNING": "⚠️",  # Warning emoji + space
            "ERROR": "❌",  # Error emoji + space
            "CRITICAL": "🔥",  # Fire emoji + space
        }
        icon = level_icons.get(record.levelname, "")
        record.levelname_icon = icon

        # Store original name and apply intelligent truncation
        original_name = record.name
        # Adjust max_width based on whether we have an icon (icons take ~3 characters of space)
        max_width = 32 if icon else 35
        truncated_name = self._truncate_logger_name(original_name, max_width=max_width)

        # Determine color for the logger name based on a module type
        logger_color = self._get_logger_color(original_name)

        # Apply color to truncated name (always apply colors, rich handles terminal detection)
        display_name = truncated_name
        if logger_color:
            display_name = f"{logger_color}{truncated_name}{self.RESET}"

        # Temporarily set the display name for formatting
        record.name = display_name

        # Get the formatted message from parent
        formatted = super().format(record)

        # Add color for the entire line based on log level (always apply colors)
        level_color = self.COLORS.get(record.levelname, "")
        if level_color:
            formatted = f"{level_color}{formatted}{self.RESET}"

        # Restore original name
        record.name = original_name

        return formatted

    def _get_logger_color(self, logger_name):
        """Determine the appropriate color for a logger name based on its module type."""
        if not logger_name:
            return None

        # Convert to lowercase for case-insensitive matching
        name_lower = logger_name.lower()

        # Sort patterns by length (longest first) to prioritize more specific matches
        sorted_patterns = sorted(self.MODULE_COLORS.items(), key=lambda x: len(x[0]), reverse=True)

        # Check each module pattern to see if it matches the logger name
        for module_pattern, color in sorted_patterns:
            if module_pattern in name_lower:
                return color

        return None  # No specific color, use default

    # noinspection GrazieInspection
    @staticmethod
    def _truncate_logger_name(logger_name, max_width=35):
        """
        Intelligently truncate logger names that are too long and ensure consistent width for alignment.

        Examples:
        - src.main.service.graph.graph_integration_service -> s.m.s.g.graph_integration_service (padded to 35)
        - src.main.utils.config.loader -> src.main.utils.config.loader      (padded to 35)
        - very.long.module.name.with.many.parts -> v.l.m.n.w.m.parts            (padded to 35)
        """
        if not logger_name:
            return " " * max_width  # Return empty string padded to width

        # If the name fits, pad it to the required width
        if len(logger_name) <= max_width:
            return logger_name.ljust(max_width)

        # Split the logger name by dots
        parts = logger_name.split(".")

        # If only one part, truncate it directly
        if len(parts) == 1:
            if len(logger_name) > max_width:
                truncated = logger_name[: max_width - 3] + "..."
                return truncated.ljust(max_width)
            return logger_name.ljust(max_width)

        # Try progressive abbreviation
        # Start with full last part and abbreviate earlier parts
        abbreviated_parts = []
        last_part = parts[-1]  # Keep the last part full

        # Calculate space needed for last part and separators
        remaining_width = max_width - len(last_part) - (len(parts) - 1)  # -1 for dots

        # If even with abbreviation it won't fit, truncate the last part too
        if remaining_width < len(parts) - 1:  # Need at least 1 char per abbreviated part
            truncated_last = last_part[: max_width // 2] if max_width > 10 else last_part[:5]
            remaining_width = max_width - len(truncated_last) - (len(parts) - 1)
            last_part = truncated_last

        # Abbreviate all parts except the last one
        for _i, part in enumerate(parts[:-1]):
            if remaining_width > 0 and len(part) > 0:
                abbreviated_parts.append(part[0])  # Take first character
                remaining_width -= 1
            else:
                break

        # Add the last part
        abbreviated_parts.append(last_part)

        result = ".".join(abbreviated_parts)

        # Final check - if still too long, truncate more aggressively
        if len(result) > max_width:
            # Keep only first letters and last significant part
            if len(parts) > 2:
                first_letters = "".join([p[0] for p in parts[:-2]])
                second_last = parts[-2][:3] if len(parts[-2]) > 3 else parts[-2]
                last = parts[-1][:10] if len(parts[-1]) > 10 else parts[-1]
                result = f"{first_letters}.{second_last}.{last}"

                # If still too long, truncate the end
                if len(result) > max_width:
                    result = result[: max_width - 3] + "..."

        # CRITICAL: Ensure result is exactly max_width characters for perfect alignment
        return result.ljust(max_width)


# Factory function for logging configuration
def create_color_formatter():
    """Create a color formatter instance."""
    return ColorFormatter(fmt="%(asctime)s %(levelname_icon)s[%(levelname)-7s] %(name)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")


def timing(self, message, *args, **kwargs):
    """Log a message with severity 'TIMING'."""
    if self.isEnabledFor(TIMING_LEVEL):
        self._log(TIMING_LEVEL, message, args, **kwargs)


# Add the timing method to Logger class
logging.Logger.timing = timing


# noinspection PyPackageRequirements
def get_user_id_from_context() -> str | None:
    """
    Get user_id from various sources in order of preference:
    1. Context variable (set by middleware)
    2. FastAPI request state (if available)
    """
    # noinspection PyBroadException
    try:
        # Try context variable first
        user_id = user_id_context.get()
        if user_id:
            return user_id

        # Try to get from FastAPI request if available
        # noinspection PyBroadException
        try:
            import inspect

            from starlette.requests import Request

            # Look through the call stack for a Request object
            frame = inspect.currentframe()
            while frame:
                # noinspection PyUnresolvedReferences
                local_vars = frame.f_locals
                for _var_name, var_value in local_vars.items():
                    if isinstance(var_value, Request):
                        if hasattr(var_value, "state") and hasattr(var_value.state, "user_id"):
                            return var_value.state.user_id
                # noinspection PyUnresolvedReferences
                frame = frame.f_back
        except Exception:
            # Could not extract user_id from call stack
            return None

        return None
    except Exception:
        # Could not extract user_id
        return None


def timing_decorator(operation_name: str | None = None, log_args: bool = False, log_result: bool = False, log_level: str = "timing"):
    """
    Decorator to log execution time of functions with enhanced context.

    Args:
        operation_name: Custom name for the operation. If None, uses function name.
        log_args: Whether to log function arguments (be careful with sensitive data)
        log_result: Whether to log the result (be careful with large objects)
        log_level: Logging level to use ("debug", "info", "warning", "error", "timing"). Default: "timing"

    Usage:
        @timing_decorator("Database Query")
        def fetch_data():
            pass

        @timing_decorator(log_args=True, log_level="info")
        async def process_document(doc_id: str):
            pass

        @timing_decorator(log_level="debug")
        def helper_function():
            pass
    """

    def _prepare_context_and_args(func, op_name, log_args_enabled, args, kwargs):
        """Helper function to prepare logging context and arguments"""
        logger = logging.getLogger(func.__module__)
        op_name = op_name or f"{func.__name__}"

        # Get user context
        user_id = get_user_id_from_context()
        user_context = f" [user: {user_id}]" if user_id else ""

        # Prepare argument logging
        args_info = ""
        if log_args_enabled and (args or kwargs):
            # noinspection PyBroadException
            try:
                # Get function signature for parameter names
                sig = inspect.signature(func)
                bound_args = sig.bind(*args, **kwargs)
                bound_args.apply_defaults()

                # Format arguments safely
                arg_strs = []
                for name, value in bound_args.arguments.items():
                    if isinstance(value, (str, int, float, bool)) and len(str(value)) < 100:
                        arg_strs.append(f"{name}={value}")
                    else:
                        arg_strs.append(f"{name}=<{type(value).__name__}>")

                if arg_strs:
                    args_info = f" with args: {', '.join(arg_strs)}"
            except Exception:
                args_info = " with args: <unable to format>"

        return logger, op_name, user_context, args_info

    def _prepare_result_info(log_res, result):
        """Helper function to prepare result logging information"""
        result_info = ""
        if log_res and result is not None:
            # noinspection PyBroadException
            try:
                if isinstance(result, (str, int, float, bool)) and len(str(result)) < 200:
                    result_info = f" -> {result}"
                else:
                    result_info = f" -> <{type(result).__name__}>"
            except Exception:
                result_info = " -> <unable to format>"
        return result_info

    def _log_timing_result(logger, op_name, user_context, start_time, result_info, level, success=True, error=None):
        """Helper function to log timing results"""
        end_time = datetime.datetime.now(datetime.UTC)
        duration = (end_time - start_time).total_seconds()

        # Get the appropriate logging method based on level
        # noinspection PyTypeChecker
        log_method = getattr(logger, level, logger.timing)

        if success:
            log_method("🕒 Completed %s%s in %.3fs%s", op_name, user_context, duration, result_info)
        else:
            log_method("❌ Failed %s%s in %.3fs: %s", op_name, user_context, duration, str(error))

    def decorator(func):
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            logger, op_name, user_context, args_info = _prepare_context_and_args(func, operation_name, log_args, args, kwargs)

            start_time = datetime.datetime.now(datetime.UTC)
            # Use the specified log level for the start message
            # noinspection PyUnresolvedReferences,PyTypeChecker
            log_method = getattr(logger, log_level, logger.timing)
            log_method("🚀 Starting %s%s%s", op_name, user_context, args_info)

            try:
                result = await func(*args, **kwargs)
                result_info = _prepare_result_info(log_result, result)
                # noinspection PyTypeChecker
                _log_timing_result(logger, op_name, user_context, start_time, result_info, log_level, success=True)
                return result

            except Exception as e:
                # noinspection PyTypeChecker
                _log_timing_result(logger, op_name, user_context, start_time, "", log_level, success=False, error=e)
                raise

        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            logger, op_name, user_context, args_info = _prepare_context_and_args(func, operation_name, log_args, args, kwargs)

            start_time = datetime.datetime.now(datetime.UTC)
            # Use the specified log level for the start message
            # noinspection PyUnresolvedReferences,PyTypeChecker
            log_method = getattr(logger, log_level, logger.timing)
            log_method("🚀 Starting %s%s%s", op_name, user_context, args_info)

            try:
                result = func(*args, **kwargs)
                result_info = _prepare_result_info(log_result, result)
                # noinspection PyTypeChecker
                _log_timing_result(logger, op_name, user_context, start_time, result_info, log_level, success=True)
                return result

            except Exception as e:
                # noinspection PyTypeChecker
                _log_timing_result(logger, op_name, user_context, start_time, "", log_level, success=False, error=e)
                raise

        # Return an appropriate wrapper based on whether the function is async
        if inspect.iscoroutinefunction(func):
            return async_wrapper
        else:
            return sync_wrapper

    return decorator


# Global flag to track if logging has been configured
_logging_configured = False


def setup_logging_config(config_path: str | None = None) -> bool:
    """
    Set up logging configuration from logging.conf file.

    Args:
        config_path: Optional path to logging config file. If None, uses default location.

    Returns:
        True if configuration was loaded successfully, False otherwise.
    """
    global _logging_configured
    if _logging_configured:
        return True  # Already configured

    # Always get the script directory (where the main application is located)
    # File now lives at src/main/utils/core/logger.py -> go up 5 dirnames to project root.
    # noinspection PyTypeChecker
    script_dir = str(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))))

    if config_path is None:
        config_path = str(os.path.join(script_dir, "configs", "logging.conf"))

    try:
        # noinspection PyTypeChecker
        if os.path.exists(config_path):
            # Ensure logs directory exists
            logs_dir = str(os.path.join(script_dir, "data", "logs"))
            os.makedirs(logs_dir, exist_ok=True)

            # Use consistent log filename for current day
            log_filename = "scrapalot.log"
            log_filepath = str(os.path.join(logs_dir, log_filename))

            # Read the configuration file and replace the placeholder with actual path
            import configparser

            config = configparser.ConfigParser()
            # noinspection PyTypeChecker
            config.read(config_path)

            # Update the file handler args with the actual log file path
            if config.has_section("handler_fileHandler"):
                config.set("handler_fileHandler", "args", f"('{log_filepath}',)")
            if config.has_section("handler_rotatingFileHandler"):
                config.set("handler_rotatingFileHandler", "args", f"('{log_filepath}', 'a', 10485760, 5)")
            if config.has_section("handler_timedRotatingFileHandler"):
                config.set("handler_timedRotatingFileHandler", "args", f"('{log_filepath}', 'midnight', 1, 1)")

            # Apply the modified configuration
            # Note: fileConfig() can sometimes close stdout/stderr when reconfiguring handlers
            # Save file descriptors so we can reopen if needed
            import io

            stdout_fd = sys.stdout.fileno()
            stderr_fd = sys.stderr.fileno()

            # noinspection PyBroadException
            try:
                logging.config.fileConfig(config, disable_existing_loggers=False)
            except Exception:
                # If fileConfig fails, ensure streams are still open
                pass
            finally:
                # Check if stdout/stderr were closed and reopen them if needed
                # We can't check .closed on a closed stream (raises ValueError), so try/except
                try:
                    # Try to write nothing - this will fail if closed
                    sys.stdout.flush()
                except (ValueError, OSError):
                    # Stdout is closed, reopen it from the file descriptor
                    sys.stdout = io.TextIOWrapper(open(stdout_fd, "wb", buffering=0, closefd=False), encoding="utf-8", line_buffering=True)  # noqa: SIM115 — wrapper becomes sys.stdout, must stay open

                try:
                    sys.stderr.flush()
                except (ValueError, OSError):
                    # Stderr is closed, reopen it from the file descriptor
                    sys.stderr = io.TextIOWrapper(open(stderr_fd, "wb", buffering=0, closefd=False), encoding="utf-8", line_buffering=True)  # noqa: SIM115 — wrapper becomes sys.stderr, must stay open

            # Get a test logger to verify the configuration
            test_logger = logging.getLogger(__name__)
            test_logger.debug("Logging configuration loaded successfully from %s", config_path)
            test_logger.debug("Log file: %s", log_filepath)
            _logging_configured = True
            return True
        else:
            print(f"Warning: Logging config file not found at: {config_path}")
            return False
    except Exception as e:
        print(f"Error: Failed to load logging configuration: {e}")
        return False


def get_logger(name: str = __name__) -> logging.Logger:
    """
    Get a logger instance with the specified name.

    Args:
        name: Logger name

    Returns:
        Logger instance
    """
    # Try to set up logging configuration if not already done
    if not _logging_configured:
        config_loaded = setup_logging_config()
        if not config_loaded:
            _setup_fallback_logging()

    return logging.getLogger(name)


def _setup_fallback_logging():
    """Set up fallback logging when config file loading fails."""
    global _logging_configured
    if _logging_configured:
        return

    # Create a handler with our UTF8StreamHandler that handles encoding gracefully
    handler = UTF8StreamHandler()
    handler.setFormatter(ColorFormatter())

    # Configure root logger
    root_logger = logging.getLogger()
    if not root_logger.handlers:
        root_logger.addHandler(handler)
        root_logger.setLevel(logging.DEBUG)

    _logging_configured = True


# Initialize logging configuration when this module is imported
# Removed automatic initialization to prevent circular imports
# Configuration will be loaded on the first logger request.
