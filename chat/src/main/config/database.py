import os
import re
import sys
from typing import Any
from urllib.parse import quote_plus

_THIS_FILE: str = str(__file__)

from datetime import UTC

from sqlalchemy import create_engine, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel import Session

from src.main.utils.config.loader import resolved_config, resolved_secrets
from src.main.utils.core.logger import get_logger, timing_decorator

# Global state variables
DB_TYPE = None
DB_SCHEMA = None
DB_PORT = None
SQLALCHEMY_DATABASE_URL = None
SQLALCHEMY_DATABASE_URL_ASYNC = None
using_sqlite_fallback = False
DB_INITIALIZATION_INCOMPLETE = False

# Add the project root to the Python path
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(_THIS_FILE)))))

logger = get_logger(__name__)


# Database connection utilities


def get_pg_connection_params():
    """Get PostgreSQL connection parameters from config"""
    # Unified configuration using environment variables and config file defaults
    pg_config = resolved_config.get("postgres", {})
    # Explicitly log the password being used to help debug connection issues
    password = resolved_secrets.get("postgres_password")

    # IMPORTANT: Prioritize environment variables over config defaults
    # When running in Docker, POSTGRES_HOST and POSTGRES_PORT are set by docker-compose
    # When running locally, use defaults suitable for host machine
    import os

    return {
        "host": os.environ.get("POSTGRES_HOST") or pg_config.get("host", "localhost"),
        "port": int(os.environ.get("POSTGRES_PORT") or pg_config.get("port", 15432)),
        "db": os.environ.get("POSTGRES_DB") or pg_config.get("db", "scrapalot"),
        "user": os.environ.get("POSTGRES_USER") or pg_config.get("user", "scrapalot"),
        # Fallback to 'scrapalot' if password is None or empty
        "password": os.environ.get("POSTGRES_PASSWORD") or password or "scrapalot",
    }


def build_pg_connection_string(params, driver="psycopg2"):
    """Build a PostgreSQL connection string"""
    ssl_mode = os.environ.get("POSTGRES_SSL_MODE", "disable")
    return f"postgresql+{driver}://{params['user']}:{params['password']}@{params['host']}:{params['port']}/{params['db']}?sslmode={ssl_mode}"


# noinspection SqlResolve
@timing_decorator("Checking pgvector extension (sync)")
def check_pgvector_extension_sync(connection_string):
    """
    Synchronous version of check_pgvector_extension.
    Checks if the pgvector extension is installed in the PostgreSQL database.

    Args:
        connection_string: The PostgreSQL connection string

    Returns:
        bool: True if the extension is installed, False otherwise
    """

    # Check if this is a PostgreSQL connection string
    if not connection_string or not ("postgresql" in connection_string.lower() or "postgres" in connection_string.lower()):
        logger.info("Non - PostgreSQL database detected - pgvector extension check not applicable")
        return False

    try:
        # Create a temporary engine for this check
        temp_engine = create_engine(connection_string)

        # Check if the extension exists
        with temp_engine.connect() as conn:
            result = conn.execute(text("SELECT * FROM pg_extension WHERE extname = 'vector'"))  # type: ignore[arg-type]
            extension_exists = result.fetchone() is not None

            if not extension_exists:
                logger.warning("pgvector extension is not installed in the database.")
                logger.warning("Vector search functionality will not be available.")
                logger.warning("Please install the pgvector extension in your PostgreSQL database.")
                return False

            logger.info("pgvector extension is installed and available.")
            return True

    except Exception as ex:
        logger.error("Error checking pgvector extension: %s", str(ex))
        return False


# Create the sqlite directory if it doesn't exist
def ensure_sqlite_dir():
    """Ensure the SQLite database directory exists"""
    # Get the project root directory (scrapalot-chat)
    project_root = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(_THIS_FILE)))), ""))
    sqlite_dir = os.path.join(project_root, "data", "db")

    # Create the directory if it doesn't exist
    os.makedirs(sqlite_dir, exist_ok=True)

    # Return the full path to the database file
    return os.path.join(sqlite_dir, "scrapalot.db")


# Define run_migrations here before it's called
def _setup_alembic_paths(script_dir, fail_on_error):
    """
    Helper function to set up Alembic paths and verify the configuration file exists.

    Args:
        script_dir: Optional script directory overrides
        fail_on_error: If True, raise exceptions on errors; if False, log errors but continue

    Returns:
        tuple: (script_dir, alembic_ini_path) if successful, or (None, None) if failed and fail_on_error=False
    """
    if not script_dir:
        script_dir = os.path.abspath(os.path.join(os.path.dirname(_THIS_FILE), "../../.."))

    alembic_ini_path = os.path.join(script_dir, "alembic.ini")

    if not os.path.exists(alembic_ini_path):
        logger.error("Alembic configuration file not found at %s", alembic_ini_path)
        if fail_on_error:
            raise FileNotFoundError(f"Alembic configuration file not found at {alembic_ini_path}")
        return None, None

    return script_dir, alembic_ini_path


def run_migrations(db_engine=None, db_type=None, check_needed=True, fail_on_error=True, custom_env=None, script_dir=None):
    """
    Run database migrations using Alembic.

    Args:
        db_engine: SQLAlchemy engine instance
        db_type: Type of database ('sqlite' or 'postgresql')
        check_needed (bool): If True, first check if migrations are needed
        fail_on_error (bool): If True, raise exceptions on migration errors; if False, log errors but continue
        custom_env (dict): Optional custom environment variables for subprocess call
        script_dir (str): Optional script directory override

    Returns:
        bool: True if migrations were successful or not needed, False if they failed (when fail_on_error=False)
    """
    # Note: ENABLE_MIGRATIONS check is now handled in app_instance.py

    # Preserve the current logging configuration before Alembic potentially overrides it
    import logging.config
    import os  # Ensure os is available in function scope

    # Save current logging configuration
    current_loggers = {}
    for name in logging.Logger.manager.loggerDict:
        current_loggers[name] = logging.getLogger(name)

    logger.info("🗄️ Starting database migration process...")

    # Import Alembic modules at the function level to avoid global import issues
    try:
        from alembic.config import Config
        from alembic.runtime.migration import MigrationContext
        from alembic.script import ScriptDirectory

        from alembic import command
    except ImportError as import_ex:
        logger.error("Failed to import Alembic modules: %s", str(import_ex))
        if fail_on_error:
            raise
        return False

    # Get database URL based on provided engine or global settings
    have_engine = db_engine and hasattr(db_engine, "url")

    # If we have an engine, use it directly but always regenerate the connection URL
    # to get the real password, not the masked one from engine.url
    if have_engine:
        # For logging only - this will have the masked password
        logging_db_url = str(db_engine.url)
        logger.info("Using provided engine with masked URL: %s", logging_db_url)

        # Determine if it's SQLite or PostgreSQL
        if "postgresql" in logging_db_url or "postgres" in logging_db_url:
            # For PostgreSQL, rebuild the connection string with the real password from pg_params
            pg_params = get_pg_connection_params()
            db_url = build_pg_connection_string(pg_params, "psycopg2")
        else:
            # For SQLite, we can use the URL directly as it has no password
            db_url = str(db_engine.url)
    else:
        # Use global URL if available, otherwise construct based on a type
        if db_type == "sqlite":
            db_url = f"sqlite:///{ensure_sqlite_dir()}"
        elif "SQLALCHEMY_DATABASE_URL" in globals():
            # Access global variable without declaring it again
            db_url = globals()["SQLALCHEMY_DATABASE_URL"]
        else:
            # Default to PostgreSQL if no specific info provided
            pg_params = get_pg_connection_params()
            db_url = build_pg_connection_string(pg_params, "psycopg2")

    # Set up Alembic paths
    script_dir, alembic_ini_path = _setup_alembic_paths(script_dir, fail_on_error)
    if alembic_ini_path is None:
        return False

    # Prepare environment for subprocess calls
    env = os.environ.copy()
    if custom_env:
        env.update(custom_env)

    # Add script_dir to PYTHONPATH
    if "PYTHONPATH" in env:
        env["PYTHONPATH"] = f"{script_dir}:{env['PYTHONPATH']}"
    else:
        env["PYTHONPATH"] = script_dir

    # Set up environment variables
    env = os.environ.copy()
    if custom_env:
        env.update(custom_env)

    # Add environment variables for Alembic
    env["ALEMBIC_DB_URL"] = db_url

    # Set PYTHONPATH to include the root project directory
    if "PYTHONPATH" in env:
        env["PYTHONPATH"] = f"{script_dir}:{env['PYTHONPATH']}"
    else:
        env["PYTHONPATH"] = script_dir

    # Fast migration check using Alembic API directly
    needs_migration = True
    if check_needed:
        try:
            logger.debug("Quick check if migrations are needed...")

            # Set up Alembic paths
            script_dir, alembic_ini_path = _setup_alembic_paths(script_dir, fail_on_error)
            if alembic_ini_path is None:
                return False

            # Create alembic config
            alembic_cfg = Config(alembic_ini_path)

            if have_engine:
                # If we have an engine, don't set the sqlalchemy.url option.
                # The engine will be used directly
                logger.debug("Using provided SQLAlchemy engine for migrations")
                # We can set an environment variable with a test double URL since we'll use the engine
                os.environ["ALEMBIC_DB_URL"] = "provided_via_engine"

                # Store the engine in the alembic config attributes for env.py to use
                alembic_cfg.attributes["connection"] = db_engine
            else:
                # Only set the URL if we don't have an engine
                logger.info("Setting sqlalchemy.url for migrations")
                os.environ["ALEMBIC_DB_URL"] = db_url
                alembic_cfg.set_main_option("sqlalchemy.url", db_url)

            try:
                # Get the script directory to check available migrations
                script = ScriptDirectory.from_config(alembic_cfg)

                # Get the head revision (the latest migration)
                head_revision = script.get_current_head()

                # Use the provided engine or create a temporary one
                if have_engine:
                    check_engine = db_engine
                else:
                    check_engine = create_engine(db_url)
                    logger.info("Created temporary engine for migration checks")

                # Check current database revision
                with check_engine.connect() as conn:
                    context = MigrationContext.configure(conn)
                    current_rev = context.get_current_revision()

                    logger.info("Current database revision: %s", current_rev)

                    if current_rev == head_revision:
                        needs_migration = False
                    elif current_rev is None:
                        logger.info("No migration history found. Checking if database schema exists...")

                        # Check if tables already exist (a database might be pre-migration)
                        from sqlalchemy import inspect

                        existing_tables = inspect(check_engine).get_table_names()  # type: ignore[union-attr]

                        if len(existing_tables) > 10:  # If we have the most expected tables
                            logger.info("Found %s existing tables. Database appears to be already set up.", len(existing_tables))
                            logger.info("Stamping database with current migration version instead of running migrations.")

                            # Use already imported command from line 172

                            command.stamp(alembic_cfg, head_revision or "head")
                            logger.info("Database stamped with revision: %s", head_revision)
                            needs_migration = False
                        else:
                            logger.info("No existing schema found. Initial migration needed.")
                            needs_migration = True
                    else:
                        needs_migration = True
            except Exception as check_ex:
                logger.error("Failed to check migration status: %s", str(check_ex))
                # If we can't check, assume migrations are needed
                needs_migration = True

        except ImportError as import_ex:
            logger.warning("Alembic not available: %s. Assuming migrations are needed.", str(import_ex))
            needs_migration = True
        except Exception as ex:
            logger.warning("Alembic API check failed: %s", str(ex))
            logger.info("Assuming migrations are needed due to check failure.")
            logger.error("Failed to check migration status: %s", str(ex))
            # Check if this is a connection-related error
            if "too many clients" in str(ex).lower() or "connection" in str(ex).lower():
                logger.warning("Database connection issue detected. Skipping migration check to prevent connection exhaustion.")
                return False
            if fail_on_error:
                raise
            # If we can't check, assume migrations are needed
            needs_migration = True

    if needs_migration:
        logger.info("⬆️ Pending migrations detected or couldn't determine current version. Running migrations...")

        # Use direct alembic API for more reliable execution
        try:
            # Set up Alembic paths
            script_dir, alembic_ini_path = _setup_alembic_paths(script_dir, fail_on_error)
            if alembic_ini_path is None:
                return False

            # Create alembic config
            alembic_cfg = Config(alembic_ini_path)

            if have_engine:
                # If we have an engine, don't set the sqlalchemy.url option
                # The engine will be used directly through the SQLAlchemy connection
                # We can set an environment variable with a test double URL since we'll use the engine
                os.environ["ALEMBIC_DB_URL"] = "provided_via_engine"

                # Store the engine in the alembic config attributes for env.py to use
                alembic_cfg.attributes["connection"] = db_engine
            else:
                # Only set the URL if we don't have an engine
                logger.info("Setting sqlalchemy.url for migrations")
                os.environ["ALEMBIC_DB_URL"] = db_url
                alembic_cfg.set_main_option("sqlalchemy.url", db_url)

            logger.info("Alembic config file: %s", alembic_ini_path)

            # Run migrations using alembic command API
            command.upgrade(alembic_cfg, "head")

            logger.info("✔️ Database migrations completed successfully using direct API.")

            # Verify the migration was successful by checking the current version
            try:
                logger.info("Checking current database revision after migration:")
                command.current(alembic_cfg)
            except Exception as check_ex:
                logger.warning("Could not verify current revision after migration: %s", str(check_ex))

            # Restore original logging configuration after Alembic may have changed it
            try:
                # Re-configure logging using our original config, preserving LLM and Alembic loggers
                script_dir_for_logging = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(_THIS_FILE)))))
                logging_conf_path = os.path.join(script_dir_for_logging, "configs", "logging.conf")
                if os.path.exists(logging_conf_path):
                    # Use disable_existing_loggers=False to keep our LLM and migration loggers
                    logging.config.fileConfig(logging_conf_path, disable_existing_loggers=False)
                    logger.info("Restored original logging configuration after migrations (preserving LLM / migration loggers)")
                else:
                    logger.warning("Could not find logging.conf to restore configuration")
            except Exception as logging_ex:
                logger.warning("Failed to restore logging configuration: %s", logging_ex)

            return True

        except Exception as ex:
            # Restore logging configuration even on failure
            try:
                script_dir_for_logging = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(_THIS_FILE)))))
                logging_conf_path = os.path.join(script_dir_for_logging, "configs", "logging.conf")
                if os.path.exists(logging_conf_path):
                    # Preserve LLM and migration loggers when restoring after error
                    logging.config.fileConfig(logging_conf_path, disable_existing_loggers=False)
                    logger.info("Restored original logging configuration after migration error (preserving LLM / migration loggers)")
            except Exception as logging_ex:
                logger.warning("Failed to restore logging configuration after error: %s", logging_ex)

            logger.error("Error during migration execution: %s", str(ex))
            logger.exception("Migration traceback:")
            if fail_on_error:
                raise
            return False

    # Restore logging configuration for the no-migration case too
    try:
        script_dir_for_logging = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(_THIS_FILE)))))
        logging_conf_path = os.path.join(script_dir_for_logging, "configs", "logging.conf")
        if os.path.exists(logging_conf_path):
            # Always preserve LLM and migration loggers
            logging.config.fileConfig(logging_conf_path, disable_existing_loggers=False)
    except Exception as logging_ex:
        logger.warning("Failed to ensure logging configuration: %s", logging_ex)

    logger.info("💭 No migrations needed - database is up to date.")
    return True


# Try to use PostgreSQL first, fall back to SQLite if needed


@timing_decorator("Database connection setup")
def register_sqlite_functions(dbapi_connection, _connection_record):
    """Register custom SQLite functions."""
    if dbapi_connection is None:
        return

    # Register SQLite datetime functions
    def sqlite_now():
        from datetime import datetime

        return datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")

    dbapi_connection.create_function("now", 0, sqlite_now, deterministic=True)


def setup_database_connection():
    """
    Set up a database connection based on configuration.
    """
    # Access the global variables
    global SQLALCHEMY_DATABASE_URL, SQLALCHEMY_DATABASE_URL_ASYNC, using_sqlite_fallback, DB_INITIALIZATION_INCOMPLETE, DB_TYPE, DB_SCHEMA

    # Initialize to None/empty to avoid "might be referenced before assignment" errors
    engine_db = None
    db_url = ""

    # Check for desktop mode first - force SQLite if enabled
    from src.main.utils.config.desktop_mode import get_desktop_database_path, is_desktop_mode

    if is_desktop_mode():
        logger.info("🖥️  Desktop mode detected - forcing SQLite database")
        DB_TYPE = "sqlite"
        DB_SCHEMA = "main"
        using_sqlite_fallback = True

        # Use desktop-specific database path
        sqlite_db_path = get_desktop_database_path()
        logger.info("Desktop database path: %s", sqlite_db_path)

        db_url = f"sqlite:///{sqlite_db_path}"

        # Skip PostgreSQL connection attempt in desktop mode
        connection_successful = False
    elif os.environ.get("POSTGRES_FALLBACK_TO_SQLITE", "false").lower() in ["true", "1", "yes"]:
        logger.info("💾 POSTGRES_FALLBACK_TO_SQLITE enabled - forcing SQLite database")
        DB_TYPE = "sqlite"
        DB_SCHEMA = "main"
        using_sqlite_fallback = True

        # Skip PostgreSQL connection attempt when fallback is explicitly enabled
        connection_successful = False
    else:
        # Get database configuration from config.yaml using the dedicated function
        pg_params = get_pg_connection_params()

        # Start with PostgreSQL connection attempt
        logger.info("Attempting to connect to PostgreSQL at %s:%s", pg_params["host"], pg_params["port"])
        logger.info("Connection pool settings: pool_size=10, max_overflow=15, pool_recycle=300s")

        DB_TYPE = "postgresql"
        DB_SCHEMA = "public"  # Use public schema instead of scrapalot

        # Construct PostgreSQL URL using build function (includes SSL mode)
        # Use empty driver for base PostgreSQL URL (driver prefix will be added by build function)
        ssl_mode = os.environ.get("POSTGRES_SSL_MODE", "disable")
        db_url = f"postgresql://{quote_plus(str(pg_params['user']))}:{quote_plus(str(pg_params['password']))}@{pg_params['host']}:{pg_params['port']}/{pg_params['db']}?sslmode={ssl_mode}"

        # Use a separate try-except block just for the initial connection test with retry logic
        # This ensures timeout errors are caught quickly but allows for transient network issues
        connection_successful = False
        max_retries = 3
        retry_delay = 2  # seconds
        import socket
        import time

        for attempt in range(max_retries):
            try:
                logger.info("Connection attempt %s/%s", attempt + 1, max_retries)

                # Test PostgreSQL connection with a longer timeout for remote Supabase
                ssl_mode = os.environ.get("POSTGRES_SSL_MODE", "disable")
                test_engine = create_engine(db_url, echo=False, pool_pre_ping=True, connect_args={"connect_timeout": 30, "sslmode": ssl_mode})

                # Set a longer timeout for a remote connection attempt
                original_timeout = socket.getdefaulttimeout()
                socket.setdefaulttimeout(30)  # 30-second timeout for remote connections

                try:
                    with test_engine.connect() as test_conn:
                        # Make a simple query to verify the connection
                        test_conn.execute(text("SELECT 1"))  # type: ignore[arg-type]
                    logger.info("Successfully connected to the database")
                    connection_successful = True
                    break  # Success, exit retry loop
                finally:
                    # Reset the socket timeout to its original value
                    socket.setdefaulttimeout(original_timeout)
                    test_engine.dispose()  # Clean up test engine

            except Exception as conn_error:
                logger.warning("PostgreSQL connection attempt %s failed: %s", attempt + 1, conn_error)
                if attempt < max_retries - 1:  # Don't sleep on last attempt
                    logger.info("Retrying in %s seconds...", retry_delay)
                    time.sleep(retry_delay)
                else:
                    logger.warning("All connection attempts failed, falling back to SQLite")
                    connection_successful = False

    # Continue with PostgreSQL only if the test was successful
    if connection_successful:
        try:
            # Configure connection arguments for Supabase or regular PostgreSQL
            # Increased timeout for remote Supabase connections.
            #
            # TCP keepalives (README_DATABASE_DESIGN.md "Connection Management"): without
            # these, the kernel cannot detect a dead socket between queries.
            # `pool_pre_ping=True` only catches it on checkout via
            # `SELECT 1`; a connection that dies AFTER pre-ping passes will
            # surface mid-query as "server closed the connection
            # unexpectedly", masking the real work. Keepalives_idle=30s
            # fires the first probe well under PgBouncer's 600s idle
            # timeout and any cloud LB's 350s.
            connect_args = {
                "connect_timeout": 30,
                "application_name": "scrapalot-chat",
                "options": "-c statement_timeout=30000",  # 30-second statement timeout
                "keepalives": 1,
                "keepalives_idle": 30,
                "keepalives_interval": 10,
                "keepalives_count": 5,
            }

            # Add SSL configuration based on environment
            pg_params = get_pg_connection_params()
            ssl_mode = os.environ.get("POSTGRES_SSL_MODE", "disable")
            # Only force SSL for supabase, otherwise respect POSTGRES_SSL_MODE
            if "supabase.co" in str(pg_params["host"]) and ssl_mode != "disable":
                connect_args["sslmode"] = "require"
                logger.info("Configured SSL connection for supabase database")
            else:
                # Use environment variable SSL mode (default: disable for local PostgreSQL)
                connect_args["sslmode"] = ssl_mode
                logger.info("Configured SSL mode: %s for database", ssl_mode)

            # Create a PostgreSQL engine now that we know it works
            engine_db = create_engine(
                db_url,
                echo=False,  # Don't log SQL statements (change to True for debugging)
                # pgvector default max_connections=100. With chat + workers +
                # workers-graph each holding pool_size + max_overflow, the
                # prior 30+50=80 per process easily exhausted the server. Cap
                # at 10+15=25/process so 3 processes + Kotlin backend fit
                # under 100 (verified during 2026-05-29 DB pool exhaustion
                # incident; doc 45a6228e Cat-I reprocess SIGTERM at 17 min).
                pool_size=10,
                max_overflow=15,
                pool_pre_ping=True,  # Test connections before using them
                pool_recycle=300,  # 5 min — release idle leaks faster than the prior 15 min window
                pool_timeout=30,  # 30s — fail fast instead of stacking blocked checkouts
                connect_args=connect_args,
            )

            # Run database migrations with Alembic if enabled
            if os.environ.get("ENABLE_MIGRATIONS", "0") == "1":
                # Call the run_migrations function with proper parameters
                run_migrations(db_engine=engine_db, db_type=DB_TYPE)
                logger.info("✔️ Database migrations completed successfully")
            else:
                logger.info("Skipping migrations (ENABLE_MIGRATIONS != 1) — workers and read-only processes are designed to skip migrator startup")

        except Exception as ex:
            # Check if this is a critical system error vs. connection issue
            error_msg = str(ex).lower()

            # Database schema/migration errors are critical system issues
            if any(
                pattern in error_msg
                for pattern in [
                    "relation",
                    "does not exist",
                    "column",
                    "migration",
                    "schema",
                    "undefined table",
                    "syntax error",
                    "invalid table",
                    "table missing",
                    "invalid input syntax",
                    "gen_random_uuid",
                    "uuid",
                ]
            ):
                logger.error("❌[ERROR] Database schema error during PostgreSQL connection: %s", ex)
                logger.error("Critical: Database migration or schema issue detected")
            else:
                # All PostgreSQL connection failures are now treated as errors for monitoring
                logger.error("❌[ERROR] Failed to connect to PostgreSQL: %s", ex)

            logger.info("Falling back to SQLite database")
            connection_successful = False

    # If the PostgreSQL connection failed, fall back to SQLite
    if not connection_successful:
        # Update the global state to reflect SQLite fallback
        DB_TYPE = "sqlite"
        DB_SCHEMA = "main"  # SQLite default schema
        using_sqlite_fallback = True

        # Define SQLite database location - check environment variable first
        database_url = os.environ.get("DATABASE_URL")
        if database_url and database_url.startswith("sqlite:///"):
            # Use DATABASE_URL environment variable
            sqlite_db_path = database_url.replace("sqlite:///", "")
            # Ensure directory exists
            sqlite_dir = os.path.dirname(sqlite_db_path)
            if sqlite_dir:
                os.makedirs(sqlite_dir, exist_ok=True)
            logger.info("Using SQLite database from DATABASE_URL: %s", sqlite_db_path)
            db_url = database_url
        else:
            # Use default path - ensure_sqlite_dir function to get the path
            sqlite_db_path = ensure_sqlite_dir()
            logger.info("Using SQLite database at: %s", sqlite_db_path)
            # Construct SQLite URL
            db_url = f"sqlite:///{sqlite_db_path}"
        logger.info("Using database URL: %s", db_url)

        # Create an SQLite engine with proper parameters for multi-threading
        engine_db = create_engine(
            db_url,
            echo=False,
            connect_args={"check_same_thread": False},  # Allow multi - threading
            pool_size=40,  # Increased pool size for SQLite to handle concurrent document processing
            max_overflow=60,  # Increased overflow to handle spikes during heavy operations
            pool_timeout=30,  # Increased timeout to 30 seconds for long operations
            pool_recycle=1800,  # Recycle connections every 30 minutes instead of 1 hour
            pool_pre_ping=True,  # Test connections before using them
        )

        # Register SQLite functions
        from sqlalchemy import event

        event.listen(engine_db, "connect", register_sqlite_functions)

        # Check if the SQLite database file already exists
        db_exists = os.path.isfile(sqlite_db_path)

        try:
            # Import SQLModel metadata for table creation
            from src.main.models.sqlmodel_alembic_compat import get_sqlmodel_metadata

            metadata = get_sqlmodel_metadata()

            # NOTE: Don't import SQLModel modules here to avoid double-registration conflicts
            # Tables will be created when controllers import the models

            # Set up the SQLite compatibility layer
            from src.main.models.sqlite_compat import setup_sqlite_event_listeners

            setup_sqlite_event_listeners()

            # For SQLite, always use direct table creation instead of migrations
            logger.info("Creating SQLite tables directly using SQLModel metadata")
            metadata.create_all(bind=engine_db)

            if db_exists:
                logger.info("Using existing SQLite database at %s", sqlite_db_path)
            else:
                logger.info("Created new SQLite database at %s", sqlite_db_path)

            # Note: Alembic migrations now handle model_providers table creation and seeding
            # No manual table checks needed since migrations handle this properly
            logger.info("Table creation and seeding handled by Alembic migrations")
        except Exception as ex:
            logger.error("Error during SQLite setup: %s", str(ex))
            logger.warning("Attempting to create tables manually as a fallback")

            try:
                # Import SQLModel metadata for fallback table creation
                from src.main.models.sqlmodel_alembic_compat import get_sqlmodel_metadata

                fallback_metadata = get_sqlmodel_metadata()

                # NOTE: Don't import SQLModel modules here to avoid double-registration conflicts
                # Tables will be created when controllers import the models

                # Set up SQLite compatibility layer
                from src.main.models.sqlite_compat import setup_sqlite_event_listeners

                setup_sqlite_event_listeners()

                fallback_metadata.create_all(bind=engine_db)
                logger.info("Successfully created tables manually using SQLModel metadata")
            except Exception as table_error:
                logger.error("Failed to create tables manually: %s", str(table_error))
                # Mark as incomplete but don't fail
                DB_INITIALIZATION_INCOMPLETE = True

    # Set up global variables
    SQLALCHEMY_DATABASE_URL = db_url
    using_sqlite_fallback = DB_TYPE == "sqlite"

    # Create async engine URL
    if DB_TYPE == "postgresql":
        pg_params = get_pg_connection_params()
        ssl_mode = os.environ.get("POSTGRES_SSL_MODE", "disable")
        SQLALCHEMY_DATABASE_URL_ASYNC = f"postgresql+asyncpg://{pg_params['user']}:{pg_params['password']}@{pg_params['host']}:{pg_params['port']}/{pg_params['db']}?ssl={ssl_mode}"
    elif DB_TYPE == "sqlite":
        # For SQLite, use the same path as the sync connection
        sqlite_db_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(_THIS_FILE)))), "data", "db", "scrapalot.db")
        SQLALCHEMY_DATABASE_URL_ASYNC = f"sqlite+aiosqlite:///{sqlite_db_path}"
    else:
        # Fallback to ensure SQLALCHEMY_DATABASE_URL_ASYNC is never None
        logger.warning("Unknown database type detected, async database URL not configured properly")
        SQLALCHEMY_DATABASE_URL_ASYNC = None

    return engine_db


# Set up the database connection
engine = setup_database_connection()

# Initialize async_engine to None before conditional assignment
async_engine = None

# Configure the engine based on the selected database
if SQLALCHEMY_DATABASE_URL_ASYNC is not None:
    try:
        if using_sqlite_fallback:
            # SQLite configuration with aiosqlite
            logger.info("Creating async SQLite engine with URL: %s", SQLALCHEMY_DATABASE_URL_ASYNC)
            async_engine = create_async_engine(
                SQLALCHEMY_DATABASE_URL_ASYNC,
                # Note: check_same_thread is not compatible with aiosqlite
                pool_pre_ping=True,
            )
        else:
            # Configure async connection arguments for Supabase or regular PostgreSQL
            # Increased timeout for remote Supabase connections
            async_connect_args: dict[str, Any] = {"command_timeout": 30}

            # Add SSL configuration for Supabase or when SSL is explicitly required
            _pg_params = get_pg_connection_params()
            _ssl_mode = os.environ.get("POSTGRES_SSL_MODE", "disable")
            if "supabase.co" in str(_pg_params["host"]) or _ssl_mode in ("require", "verify-ca", "verify-full"):
                async_connect_args["ssl"] = "require"
                logger.info("Configured SSL connection for async production database")

            # PostgreSQL configuration
            async_engine = create_async_engine(
                # noinspection PyTypeChecker
                SQLALCHEMY_DATABASE_URL_ASYNC,
                # Mirror the sync engine ceiling so async + sync engines together
                # don't blow past pgvector max_connections=100. Pool sizing
                # rationale: see the sync block above.
                pool_size=10,
                max_overflow=15,
                pool_timeout=30,
                pool_pre_ping=True,
                pool_recycle=300,
                connect_args=async_connect_args,
            )
    except Exception as e:
        logger.error("Failed to create async database engine: %s", str(e))
        async_engine = None
else:
    logger.warning("Async database URL is None, skipping async engine creation")

# Check for pgvector extension using the synchronous method (only for PostgreSQL)
try:
    _sync_db_url = SQLALCHEMY_DATABASE_URL
    if DB_TYPE == "postgresql" and _sync_db_url:
        check_pgvector_extension_sync(str(_sync_db_url))
    elif DB_TYPE == "sqlite":
        logger.info("SQLite database detected - skipping pgvector extension check (not applicable)")
    else:
        logger.warning("Unknown database type '%s' - skipping pgvector extension check", DB_TYPE)
except Exception as e:
    logger.warning("Could not check pgvector extension during initialization: %s", str(e))
# Non-fatal error, continue initialization

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)


def init_engine_for_subprocess(
    pool_size: int = 2,
    max_overflow: int = 8,
    pool_recycle: int = 60,
    pool_pre_ping: bool = True,
) -> None:
    """Re-initialize the global ``engine`` + ``SessionLocal`` inside a spawned subprocess.

    Called from ``src.main.workers.subprocess_job._initializer`` as the first
    thing in every spawned child process. Required because:

      * SQLAlchemy's connection pool is not safe to share across processes.
        Even with ``mp.get_context("spawn")`` (fresh Python interpreter),
        re-importing this module re-uses the parent's module-level globals
        via spawn's pickling of the import graph — which leaves the pool
        objects referencing stale TCP sockets the parent owns.
      * The fix per SQLAlchemy docs is to dispose the inherited engine and
        create a fresh one inside the child:
        https://docs.sqlalchemy.org/en/20/core/pooling.html#using-connection-pools-with-multiprocessing-or-os-fork

    Pool sizing is intentionally small because each subprocess handles a
    SINGLE document at a time (no concurrent DB work inside the child).
    Default ``pool_size=2 + max_overflow=8`` matches Onyx's tuning for
    their indexing-worker spawn children (``onyx/background/indexing/
    job_client.py:78-80``). ``pool_recycle=60`` forces fresh connections
    every minute so a transient PG hang doesn't propagate; ``pool_pre_ping``
    validates each checkout cheaply.

    Idempotent: safe to call more than once (replaces globals each time).
    """
    global engine, SessionLocal

    logger.info(
        "init_engine_for_subprocess: reinitialising engine (pool_size=%d, max_overflow=%d, recycle=%ds)",
        pool_size,
        max_overflow,
        pool_recycle,
    )

    # Dispose the inherited engine — closes all sockets owned by the parent.
    try:
        engine.dispose()
    except Exception:
        logger.exception("init_engine_for_subprocess: dispose() failed (continuing)")

    # Resolve a fresh SQLAlchemy URL the same way setup_database_connection() does,
    # but skip the full setup ceremony (migrations, pgvector probe, etc.) —
    # the subprocess inherits a fully-migrated DB from the parent.
    if DB_TYPE == "sqlite":
        new_url = SQLALCHEMY_DATABASE_URL
        engine = create_engine(
            new_url,
            connect_args={"check_same_thread": False},
            pool_pre_ping=pool_pre_ping,
            pool_recycle=pool_recycle,
        )
    else:
        new_url = SQLALCHEMY_DATABASE_URL
        connect_args: dict[str, Any] = {"connect_timeout": 30}
        ssl_mode = os.environ.get("POSTGRES_SSL_MODE", "disable")
        if ssl_mode in ("require", "verify-ca", "verify-full") or "supabase.co" in str(new_url):
            connect_args["sslmode"] = ssl_mode if ssl_mode != "disable" else "require"
        engine = create_engine(
            new_url,
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_timeout=30,
            pool_pre_ping=pool_pre_ping,
            pool_recycle=pool_recycle,
            connect_args=connect_args,
        )

    # Rebind SessionLocal to the fresh engine
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)


# SQLModel session factory
def get_sqlmodel_session():
    """Create an SQLModel session using the same engine as SQLAlchemy"""
    return Session(engine)


def get_sqlmodel_db_session():
    """Create an SQLModel session for direct use (not as a FastAPI dependency)"""
    return Session(engine)


# noinspection SqlResolve
def create_db_and_schema_sync(connection_string, db_name, drop_schema=False):
    """
    Synchronous version of create_db_and_extension.
    Creates a database and schema.

    Args:
        connection_string: The PostgreSQL connection string
        db_name: The name of the database
        drop_schema: If True, will drop the existing schema first
    """
    logger.info("Attempting to create database and schema. Connection string: %s, DB name: %s", connection_string, db_name)

    try:
        # Extract connection details from the connection string
        # Example: postgresql://user:password@localhost:5432/dbname
        match = re.match(r"postgresql(?:\+\w+)?://([^:]+):([^@]+)@([^:]+):(\d+)/.*", connection_string)

        if not match:
            raise ValueError(f"Invalid PostgreSQL connection string format: {connection_string}")

        user, password, host, port = match.groups()

        # Connect to the 'postgres' database to create our target database if needed
        postgres_url = f"postgresql://{quote_plus(user)}:{quote_plus(password)}@{host}:{port}/postgres"

        try:
            # Create a temporary engine to connect to a postgres database
            temp_engine = create_engine(postgres_url)

            with temp_engine.connect() as conn:
                # Make the connection autocommit to execute CREATE DATABASE
                conn = conn.execution_options(isolation_level="AUTOCOMMIT")

                # Check if database exists
                result = conn.execute(text("SELECT 1 FROM pg_database WHERE datname = %s"), (db_name,))
                db_exists = result.scalar() is not None

                if not db_exists:
                    logger.info("Creating database '%s'", db_name)
                    # Use identifier() for safe SQL identifier quoting
                    from sqlalchemy import identifier

                    conn.execute(text(f"CREATE DATABASE {identifier(db_name)}"))
                    logger.info("Database '%s' created successfully", db_name)
                else:
                    logger.info("Database '%s' already exists", db_name)

        except Exception as ex:
            logger.error("Error creating database: %s", str(ex))
            raise

        # Now connect to the target database to create schema and extensions
        try:
            # Create a temporary engine to connect to the target database
            target_engine = create_engine(connection_string)

            with target_engine.connect() as conn:
                # Make the connection autocommit
                conn = conn.execution_options(isolation_level="AUTOCOMMIT")

                # Drop schema if requested
                if drop_schema:
                    logger.info("Dropping existing schema...")
                    conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
                    conn.execute(text("CREATE SCHEMA public"))
                    logger.info("Schema dropped and recreated")

                # Set proper permissions
                from sqlalchemy import identifier

                conn.execute(text(f"ALTER SCHEMA public OWNER TO {identifier(user)}"))
                conn.execute(text(f"GRANT ALL ON SCHEMA public TO {identifier(user)}"))
                conn.execute(text("GRANT ALL ON SCHEMA public TO public"))

                # Create pgvector extension if it doesn't exist
                try:
                    conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
                    logger.info("Vector extension enabled")
                except Exception as ex:
                    logger.warning("Could not create vector extension: %s", str(ex))
                    logger.warning("Vector search functionality will not be available")

        except Exception as exc:
            logger.error("Error setting up database schema: %s", str(exc))
            raise

    except Exception as ex:
        logger.error("Database connection error: %s", str(ex))
        raise


# noinspection SqlResolve
async def create_db_and_extension(connection_string, db_name):
    logger.info("Attempting to create database and extension. Connection string: %s, DB name: %s", connection_string, db_name)

    try:
        # Extract connection details from the connection string
        # Example: postgresql://user:password@localhost:5432/dbname
        match = re.match(r"postgresql(?:\+\w+)?://([^:]+):([^@]+)@([^:]+):(\d+)/.*", connection_string)

        if not match:
            raise ValueError(f"Invalid PostgreSQL connection string format: {connection_string}")

        user, password, host, port = match.groups()

        # Connect to the 'postgres' database to create our target database if needed
        postgres_url = f"postgresql://{quote_plus(user)}:{quote_plus(password)}@{host}:{port}/postgres"

        try:
            # Create a temporary engine to connect to a postgres database
            temp_engine = create_async_engine(postgres_url)

            async with temp_engine.connect() as conn:
                # Make the connection autocommit to execute CREATE DATABASE
                conn = await conn.execution_options(isolation_level="AUTOCOMMIT")

                # Check if database exists
                result = await conn.execute(text("SELECT 1 FROM pg_database WHERE datname = %s"), (db_name,))
                db_exists = (await result.scalar()) is not None

                if not db_exists:
                    logger.info("Creating database '%s'", db_name)
                    # Use identifier() for safe SQL identifier quoting
                    from sqlalchemy import identifier

                    await conn.execute(text(f"CREATE DATABASE {identifier(db_name)}"))
                    logger.info("Database '%s' created successfully", db_name)
                else:
                    logger.info("Database '%s' already exists", db_name)

        except Exception as ex:
            logger.error("Error creating database: %s", str(ex))
            raise

        # Now connect to the target database to create schema and extensions
        try:
            # Create a temporary engine to connect to the target database
            target_engine = create_async_engine(connection_string)

            async with target_engine.connect() as conn:
                # Make the connection autocommit
                conn = await conn.execution_options(isolation_level="AUTOCOMMIT")

                # Create schema if it doesn't exist
                await conn.execute(text("CREATE SCHEMA IF NOT EXISTS public"))
                from sqlalchemy import identifier

                await conn.execute(text(f"ALTER SCHEMA public OWNER TO {identifier(user)}"))
                await conn.execute(text(f"GRANT ALL ON SCHEMA public TO {identifier(user)}"))
                await conn.execute(text("GRANT ALL ON SCHEMA public TO public"))

                # Create pgvector extension if it doesn't exist
                try:
                    await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
                    logger.info("Vector extension created or already exists")
                except Exception as ex:
                    logger.warning("Could not create vector extension: %s", str(ex))
                    logger.warning("Vector search functionality will not be available")

        except Exception as ex:
            logger.error("Error setting up database schema: %s", str(ex))
            raise

    except Exception as ex:
        logger.error("Database connection error: %s", str(ex))
        raise


# noinspection SqlResolve
async def check_pgvector_extension(connection_string):
    """
    Asynchronous version of check_pgvector_extension.
    Checks if the pgvector extension is installed in the PostgreSQL database.

    Args:
        connection_string: The PostgreSQL connection string

    Returns:
        bool: True if the extension is installed, False otherwise
    """
    # Check if this is a PostgreSQL connection string
    if not connection_string or not ("postgresql" in connection_string.lower() or "postgres" in connection_string.lower()):
        logger.info("Non - PostgreSQL database detected - pgvector extension check not applicable")
        return False

    try:
        # Create a temporary async engine for this check
        temp_engine = create_async_engine(connection_string)

        # Check if the extension exists
        async with temp_engine.connect() as conn:
            result = await conn.execute(text("SELECT * FROM pg_extension WHERE extname = 'vector'"))
            row = result.fetchone()
            extension_exists = row is not None

            if not extension_exists:
                logger.warning("pgvector extension is not installed in the database.")
                logger.warning("Vector search functionality will not be available.")
                logger.warning("Please install the pgvector extension in your PostgreSQL database.")
                return False

            logger.info("pgvector extension is installed and available.")
            return True

    except Exception as ex:
        logger.error("Error checking pgvector extension: %s", str(ex))
        return False


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_sqlmodel_db():
    """
    Dependency that provides an SQLModel database session.
    """
    session = get_sqlmodel_session()
    try:
        yield session
    finally:
        session.close()


# Create an async session factory
AsyncSessionLocal = None
if async_engine is not None:
    AsyncSessionLocal = async_sessionmaker(bind=async_engine, class_=AsyncSession, expire_on_commit=False, autocommit=False, autoflush=False)


def init_db():
    """
    Initialize the database schema by running Alembic migrations.
    This function creates all necessary tables and sets up the database schema.
    """
    try:
        logger.info("Initializing database schema...")

        # Run migrations to create all tables
        success = run_migrations(db_engine=engine, db_type=DB_TYPE, check_needed=True, fail_on_error=True, custom_env={})

        if success:
            logger.info("Database schema initialized successfully")
        else:
            logger.error("Failed to initialize database schema")
            raise RuntimeError("Database schema initialization failed")

    except Exception as ex:
        logger.error("Error during database initialization: %s", str(ex))
        raise


async def get_session_local():
    """Async dependency that yields an async session"""
    if AsyncSessionLocal is None:
        raise RuntimeError("AsyncSessionLocal is not initialized. Check database configuration.")

    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


# Export DATABASE_URL alias for backward compatibility
DATABASE_URL = SQLALCHEMY_DATABASE_URL
