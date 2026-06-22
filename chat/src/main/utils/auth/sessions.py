"""
Session-related helpers.

Sessions are owned by the Kotlin backend. These functions only:

* Parse the composite ``"user_id:session_id"`` format that the Kotlin
  side emits for cross-process correlation.
* Provide a thin "lookup or 404" entrypoint used by FastAPI controllers
  that still need to compose session info into responses without
  actually persisting a session row.
"""

from __future__ import annotations

from uuid import UUID

from sqlmodel import Session as SQLModelSession

from src.main.utils.auth.jwt import User


def parse_composite_session_id(session_id: str) -> str:
    """Return just the session UUID part of a ``"user_id:session_id"`` token.

    Examples::

        >>> parse_composite_session_id("user123:session456")
        'session456'
        >>> parse_composite_session_id("session456")
        'session456'
    """
    if ":" in session_id:
        parts = session_id.split(":")
        if len(parts) == 2:
            return parts[1]
    return session_id


def split_composite_session_id(session_id: str) -> tuple[str | None, str]:
    """Split a composite session id into ``(user_id, session_id)``.

    Returns ``(None, session_id)`` when ``session_id`` is not composite.

    Examples::

        >>> split_composite_session_id("user123:session456")
        ('user123', 'session456')
        >>> split_composite_session_id("session456")
        (None, 'session456')
    """
    if ":" in session_id:
        parts = session_id.split(":")
        if len(parts) == 2:
            return parts[0], parts[1]
    return None, session_id


def get_user_session(_db: SQLModelSession, session_id: UUID, current_user: User) -> dict | None:
    """Return a minimal session payload trusted from the gRPC context.

    Sessions are owned by Kotlin; the chat process trusts the
    ``session_id`` it was handed and simply echoes back the link to the
    current user. The first parameter is kept (and ignored) for
    backward-compat with callers that pass the SQL session.
    """
    return {"id": session_id, "user_id": current_user.id}


def get_user_session_or_404(db: SQLModelSession, session_id: UUID, current_user: User) -> dict:
    """``get_user_session`` that raises ``HTTPException(404)`` on miss."""
    # Local import keeps this module usable from non-FastAPI contexts.
    from fastapi import HTTPException

    session = get_user_session(db, session_id, current_user)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found or does not belong to the user")
    return session
