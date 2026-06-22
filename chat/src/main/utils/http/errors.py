"""Consistent FastAPI HTTPException helpers."""

from __future__ import annotations

from fastapi import HTTPException

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


async def handle_http_error(detail: str, original_error: Exception | None = None) -> None:
    """Log ``detail`` (with optional cause) and raise ``HTTPException(500, detail)``.

    Always raises; the return type is ``None`` for typing's sake. The
    optional ``original_error`` is attached via ``raise ... from`` for
    proper exception chaining.
    """
    if original_error is not None:
        logger.error("%s: %s", detail, str(original_error))
        raise HTTPException(status_code=500, detail=detail) from original_error
    logger.error(detail)
    raise HTTPException(status_code=500, detail=detail)
