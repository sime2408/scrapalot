"""Shared utilities for gRPC service implementations.

Provides session management, user construction, and proto conversion helpers
to eliminate boilerplate across gRPC service handlers.
"""

from contextlib import contextmanager
from datetime import UTC, datetime

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


@contextmanager
def grpc_db_session():
    """Context manager for gRPC handler database sessions.

    Replaces the repeated pattern:
        db = SessionLocal()
        try:
            ...
        finally:
            db.close()

    Usage:
        with grpc_db_session() as db:
            result = db.query(Model).all()
    """
    from src.main.config.database import SessionLocal

    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def grpc_sqlmodel_session():
    """Context manager for gRPC handler SQLModel sessions.

    For handlers that use get_sqlmodel_session() instead of SessionLocal().

    Usage:
        with grpc_sqlmodel_session() as db:
            result = db.exec(select(Model)).all()
    """
    from src.main.config.database import get_sqlmodel_session

    db = get_sqlmodel_session()
    try:
        yield db
    finally:
        db.close()


def build_grpc_user(user_id: str):
    """Build a lightweight User object for gRPC service functions.

    gRPC services receive user_id but don't query the users table
    (user management lives in Kotlin backend). This creates a minimal
    User object that satisfies service function signatures.
    """
    from src.main.utils.auth.jwt import User

    return User(id=user_id) if user_id else None


def build_grpc_user_dto(user_id: str):
    """Build a full User DTO for services that need the richer model.

    Used by chat services that require UserRole and created_at fields.
    """
    from src.main.dto.users import User, UserRole

    return User(
        id=user_id,
        username="grpc_user",
        email="grpc@scrapalot.app",
        is_active=True,
        role=UserRole.USER,
        created_at=datetime.now(UTC),
    )
