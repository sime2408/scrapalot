"""
JWT validation + minting and the lightweight ``User`` Pydantic model.

The chat process never authenticates users itself — the Kotlin backend
owns the password and OAuth flows. We only:

* Validate incoming JWTs on WebSocket / FastAPI dependency paths.
* Issue tokens for the desktop variant (single local user, see
  ``src.main.grpc.services.desktop_service``).

The module raises at import time when ``jwt_secret`` is not configured.
This is intentional: starting the app without a secret would silently
accept forged tokens.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from jose import JWTError, jwt
from pydantic import BaseModel

from src.main.utils.config.loader import resolved_secrets
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

SECRET_KEY: str | None = resolved_secrets.get("jwt_secret")
logger.debug("JWT secret loaded: %s", "SUCCESS" if SECRET_KEY else "FAILED")
logger.debug("Available secrets keys: %s", list(resolved_secrets.keys()))

if not SECRET_KEY:
    logger.critical("'jwt_secret' is not set in resolved_secrets! This is a critical security issue.")
    logger.critical("Please ensure jwt_secret is properly configured in your secrets.yaml file.")
    logger.critical("Application cannot start without a proper JWT secret for security reasons.")
    raise RuntimeError("JWT_SECRET is required but not configured. Application startup aborted for security reasons.")

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 480  # 8 hours for a better mobile experience
REFRESH_TOKEN_EXPIRE_DAYS = 30


class User(BaseModel):
    """Lightweight user model constructed from JWT claims or gRPC headers.

    No database backing — user management lives in the Kotlin backend.
    """

    id: str
    username: str = ""
    email: str = ""
    is_active: bool = True
    role: str = "user"
    first_name: str | None = None
    last_name: str | None = None
    profile_picture: str | None = None
    is_external: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


def validate_token(token: str) -> User | None:
    """Decode and validate a JWT, returning a ``User`` (or ``None`` on failure).

    Used by WebSocket connections where FastAPI's dependency injection is
    not available. Expired or malformed tokens return ``None`` rather
    than raising.
    """
    try:
        payload = jwt.decode(
            token,
            key=SECRET_KEY,
            algorithms=[ALGORITHM],
            options={"verify_aud": False, "verify_exp": True},
        )
    # noinspection PyUnresolvedReferences
    except jwt.ExpiredSignatureError:
        logger.warning("Token validation failed: token expired")
        return None
    except JWTError as e:
        logger.warning("Token validation failed: %s", str(e))
        return None
    except Exception as e:
        logger.warning("Token validation error: %s", str(e))
        return None

    user_id = payload.get("sub")
    if not user_id:
        logger.warning("Token validation failed: no sub claim")
        return None

    return User(
        id=user_id,
        username="",
        email="",
        role=payload.get("role", "user"),
        is_active=True,
    )


def _encode(data: dict[str, Any], expires_delta: timedelta, audience: str) -> str:
    """Encode ``data`` into a JWT with ``exp`` and ``aud`` claims set."""
    to_encode = data.copy()
    to_encode.update({"exp": datetime.now(UTC) + expires_delta, "aud": audience})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def create_access_token(data: dict[str, Any], expires_delta: timedelta | None = None) -> str:
    """Create a short-lived access JWT (default 15 min). Desktop-service helper."""
    return _encode(data, expires_delta or timedelta(minutes=15), audience="scrapalot-users")


def create_refresh_token(data: dict[str, Any], expires_delta: timedelta | None = None) -> str:
    """Create a long-lived refresh JWT (default ``REFRESH_TOKEN_EXPIRE_DAYS``)."""
    return _encode(
        data,
        expires_delta or timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
        audience="scrapalot-refresh",
    )
