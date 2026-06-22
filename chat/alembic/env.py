from contextlib import asynccontextmanager
import os
import urllib.parse

from sqlalchemy import engine_from_config, pool, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from alembic import context
from src.main.utils.core.logger import get_logger

config = context.config

# Use SQLModel metadata for Alembic (SQLModel-only architecture)
from src.main.models.sqlmodel_alembic_compat import target_metadata

# Set up logger using the project's standard logger utility
logger = get_logger("alembic")

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.

# Removed manual .env loading and URL setting.
# The sqlalchemy.url should be provided by the calling
# script (e.g., run_migrations in database.py) when using command.upgrade.
# For alembic CLI usage, the URL in alembic.ini is used.


def build_database_url_from_env():
    """Build a properly URL-encoded database URL from environment variables."""
    host = os.environ.get("POSTGRES_HOST")
    port = os.environ.get("POSTGRES_PORT")
    user = os.environ.get("POSTGRES_USER")
    password = os.environ.get("POSTGRES_PASSWORD")
    database = os.environ.get("POSTGRES_DB")

    if not all([host, port, user, password, database]):
        return None

    # URL encode the password to handle special characters
    # noinspection PyTypeChecker
    encoded_password = urllib.parse.quote_plus(password)
    # noinspection PyTypeChecker
    encoded_user = urllib.parse.quote_plus(user)

    return f"postgresql://{encoded_user}:{encoded_password}@{host}:{port}/{database}"


@asynccontextmanager
# noinspection PyTypeChecker
async def get_async_session() -> AsyncEngine:
    # This async context manager seems unused by standard Alembic offline/online modes.
    # Ensure the URL is correctly configured if this is used elsewhere.
    db_url = config.get_main_option("sqlalchemy.url")
    if not db_url:
        raise ValueError("Database URL not configured in Alembic config.")
    engine = create_async_engine(db_url)
    async with engine.begin() as conn:
        yield conn


async def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.
    By skipping the Engine creation,
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""

    # First check if a connection was provided directly (from run_migrations)
    provided_engine = context.config.attributes.get("connection")
    if provided_engine:
        logger.info("Using engine provided directly via config.attributes")
        # We'll use this engine directly later
        connectable = provided_engine
        # Check if it's SQLite
        is_sqlite_fallback = "sqlite" in str(provided_engine.url).lower()
    else:
        # No engine provided, try to get URL from environment or config
        # Check if ALEMBIC_DB_URL environment variable is set
        env_db_url = os.environ.get("ALEMBIC_DB_URL")

        if env_db_url and env_db_url != "provided_via_engine":
            db_url = env_db_url
            logger.info("Using database URL from ALEMBIC_DB_URL environment variable")
        else:
            # Try to build URL from environment variables first
            env_url = build_database_url_from_env()
            if env_url:
                db_url = env_url
                logger.info("Using database URL built from environment variables")
            else:
                # Fall back to the config URL (may have interpolation issues)
                try:
                    db_url = config.get_main_option("sqlalchemy.url")
                    logger.info("Using database URL from configuration")
                except Exception as e:
                    logger.warning("Config URL interpolation failed: %s", e)
                    # Last resort fallback
                    db_url = "sqlite:///data/db/scrapalot.db"
                    logger.info("Falling back to SQLite due to configuration issues")

        is_sqlite_fallback = db_url.startswith("sqlite")

    # Log which database we're using
    if is_sqlite_fallback:
        logger.info("Running migrations with SQLite database")
    else:
        logger.info("Running migrations with PostgreSQL database (public schema)")

    # Only create a new engine if we don't have one from the provided engine
    if not provided_engine:
        # Temporarily set a valid URL to avoid ConfigParser interpolation issues
        original_url = None
        try:
            # Try to get original URL, but this might fail due to interpolation
            # noinspection PyBroadException
            try:
                original_url = config.get_main_option("sqlalchemy.url")
            except Exception:
                # Ignore interpolation errors when getting original URL
                pass

            # Set a temporary valid URL to prevent interpolation errors
            # Escape % characters in URL to prevent ConfigParser interpolation errors
            # noinspection PyUnboundLocalVariable
            escaped_db_url = db_url.replace("%", "%%")
            config.set_main_option("sqlalchemy.url", escaped_db_url)
            # Get base configuration from settings
            cfg = config.get_section(config.config_ini_section, {})
        finally:
            # Restore original URL (though we'll override it anyway)
            if original_url:
                # noinspection PyTypeChecker
                config.set_main_option("sqlalchemy.url", original_url)

        # Override the URL directly in the config dict
        # noinspection PyTypeChecker
        cfg["sqlalchemy.url"] = db_url

        # Add SSL configuration for PostgreSQL
        connect_args_dict = {}
        if "postgresql" in db_url:
            ssl_mode = os.environ.get("POSTGRES_SSL_MODE", "disable")
            connect_args_dict = {"sslmode": ssl_mode}
            logger.info("Alembic migrations using SSL mode: %s", ssl_mode)

        connectable = engine_from_config(
            cfg,
            prefix="sqlalchemy.",
            poolclass=pool.NullPool,
            connect_args=connect_args_dict,
        )
        logger.info("Created new engine for migrations")

    def include_object(_object_, name, type_, _reflected, _compare_to):
        """
        Filter objects for autogenerate comparison.

        This prevents autogenerate from suggesting destructive operations
        for tables that should be ignored.
        """
        # Ignore PostGIS/spatial tables
        if type_ == "table" and name == "spatial_ref_sys":
            return False

        # Ignore Alembic's own version table
        if type_ == "table" and name == "alembic_version":
            return False

        return True

    def process_revision_directives(_context, _revision, directives):
        """
        Hook to process and validate autogenerated migration directives.

        This adds safety checks to prevent destructive migrations from being
        auto-generated when the database is out of sync.

        Note: This hook only runs during migration execution (alembic upgrade),
        not during file generation (alembic revision). For sequential numbering,
        use: python alembic/create_migration.py "description"
        """
        if config.cmd_opts and config.cmd_opts.autogenerate:
            # Get the migration script
            migration_script = directives[0]

            # Check for table drops
            drop_count = 0
            create_count = 0

            for operation in migration_script.upgrade_ops.ops:
                op_type = type(operation).__name__
                if "Drop" in op_type:
                    drop_count += 1
                    logger.warning("  - Detected DROP operation: %s", operation)
                elif "Create" in op_type:
                    create_count += 1

            # If we have many drops, warn about potential sync issues
            if drop_count > 5:
                logger.error("=" * 80)
                logger.error("SAFETY WARNING: Autogenerate detected many DROP operations!")
                logger.error("  - %s drop operations", drop_count)
                logger.error("  - %s create operations", create_count)
                logger.error("")
                logger.error("This usually means the database schema is significantly out of sync")
                logger.error("with your models. This can happen when:")
                logger.error("  1. Not all migrations have been applied to the database")
                logger.error("  2. Models were changed without creating migrations")
                logger.error("  3. Database was modified manually outside of migrations")
                logger.error("")
                logger.error("RECOMMENDED ACTIONS:")
                logger.error("  1. Check migration status: alembic current")
                logger.error("  2. Apply pending migrations: alembic upgrade head")
                logger.error("  3. Then retry autogenerate")
                logger.error("  4. Or create a manual migration instead")
                logger.error("=" * 80)

                # Don't auto-generate this dangerous migration
                # Clear the directives to prevent file creation
                directives[:] = []

                raise RuntimeError(
                    f"Autogenerate blocked: Too many DROP operations ({drop_count}). Database may be out of sync. Apply pending migrations first."
                )

    # noinspection PyUnboundLocalVariable
    with connectable.connect() as connection:
        # For PostgreSQL, ensure we're using public schema (default)
        if not is_sqlite_fallback:
            try:
                # Set search path to public (this is usually the default anyway)
                # noinspection PyTypeChecker
                connection.execute(text("SET search_path TO public"))
                logger.info("Set search path to public schema")
            except Exception as e:
                # Log the error but continue - public is usually the default anyway
                logger.warning("Error setting search path: %s", e)
                pass

        # Configure context for migrations
        context_config = {
            "connection": connection,
            "target_metadata": target_metadata,
            "include_object": include_object,
            "process_revision_directives": process_revision_directives,
            # Use non-transactional DDL and manual transaction handling
            "transaction_per_migration": False,
            "transactional_ddl": False,
        }

        # For PostgreSQL, use public schema (default) for version table
        if not is_sqlite_fallback:
            # Use public schema for the version table (this is the default anyway)
            context_config["version_table"] = "alembic_version"

        context.configure(**context_config)

        # Run migrations without explicit transaction and commit manually
        context.run_migrations()

        # For PostgreSQL, explicitly commit the transaction
        if not is_sqlite_fallback:
            try:
                connection.commit()
                logger.info("Explicitly committed PostgreSQL transaction")
            except Exception as e:
                logger.warning("Error during explicit commit: %s", e)


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
