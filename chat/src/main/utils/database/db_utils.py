"""
Database utility functions for common database operations.

Consolidates session management helpers previously scattered across
utils/db_utils.py (generator-based) and background/db_utils.py (SessionLocal-based).
"""

from contextlib import contextmanager

from fastapi import HTTPException
from sqlalchemy import and_
from sqlalchemy.orm import Session

from src.main.config.database import SessionLocal, get_sqlmodel_session
from src.main.models.sqlmodel_settings import ServerSetting
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def is_postgresql() -> bool:
    """Return True if the application is configured to use PostgreSQL."""
    from src.main.config import database as _db_module

    return getattr(_db_module, "DB_TYPE", None) == "postgresql"


async def execute_db_operation(operation_func, error_message="Database operation failed"):
    """
    Execute a database operation with proper session handling and error handling.

    Args:
            operation_func: Async function that takes a db session and performs operations
            error_message: Error message to use if the operation fails

    Returns:
            The result of the operation function

    Raises:
            HTTPException: If the operation fails
    """
    # Create a new SQLModel session for this operation (supports .exec() method)
    db = get_sqlmodel_session()
    try:
        # Execute the operation function with the session
        result = await operation_func(db)
        # Commit changes if successful
        db.commit()
        return result
    except HTTPException as ex:
        # Rollback on error
        db.rollback()
        # Re-raise HTTP exceptions
        raise ex from ex
    except Exception as e:
        # Rollback on error
        db.rollback()
        logger.exception("%s: %s", error_message, str(e))
        raise HTTPException(status_code=500, detail=f"{error_message}: {e!s}") from e
    finally:
        # Always close the session
        db.close()


def get_or_create_server_setting(db: Session, key: str, default_value: dict, _description: str = None) -> ServerSetting:
    """Get or create a server setting with the given key."""
    # noinspection PyTypeChecker
    setting = db.query(ServerSetting).filter(and_(ServerSetting.setting_key == key)).first()
    if setting is not None:
        return setting

    # Create a new setting if not found
    new_setting = ServerSetting(setting_key=key, setting_value=default_value)
    db.add(new_setting)
    return new_setting


@contextmanager
def db_session():
    """
    Lightweight context manager for a database session using SessionLocal directly.

    Guarantees the session is closed even if an exception is raised.
    No automatic commit — callers are responsible for committing.
    Previously lived in background/db_utils.py; consolidated here.

    Usage::

        with db_session() as db:
            result = db.query(MyModel).first()
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def get_db_session():
    """
    Context manager for proper database session handling.

    Ensures sessions are properly closed and transactions are handled correctly.

    Usage:
        with get_db_session() as db:
            result = db.execute(text("SELECT * FROM table"))
            # Session automatically closed and committed
    """
    from src.main.config.database import get_db

    db_generator = get_db()
    db = next(db_generator)

    try:
        yield db
        db.commit()  # Commit if no exceptions
    except Exception:
        db.rollback()  # Rollback on any exception
        raise
    finally:
        # Ensure proper session cleanup
        try:
            db.close()
            # Close the generator properly
            try:
                next(db_generator)
            except StopIteration:
                # Expected: generator already exhausted after the single yield.
                pass
        except Exception as cleanup_error:
            logger.warning("Error during session cleanup: %s", cleanup_error)
