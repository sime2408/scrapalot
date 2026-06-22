"""Shared Scrapalot REST-client helpers for the covers/ scripts.

Both ``download_openlibrary_covers.py`` and ``upload_calibre_covers.py`` need
to authenticate against the Scrapalot REST API and POST a single cover image
to ``/documents/{id}/thumbnail``. The same five-line POST and the same
``Bearer`` header construction lived in both files — now they live here.
"""

from __future__ import annotations

import logging

import requests

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def auth_headers(token: str) -> dict:
    """Return the ``Authorization: Bearer …`` header dict for ``token``."""
    return {"Authorization": f"Bearer {token}"}


def login(
    api_base: str,
    username: str,
    password: str,
    *,
    timeout: float = 30.0,
) -> str:
    """POST ``/auth/login`` and return the access token.

    Raises ``SystemExit`` if the server rejects the credentials or returns
    a response without a token — callers are CLI scripts that should fail
    fast in either case.
    """
    resp = requests.post(
        f"{api_base}/auth/login",
        json={"username": username, "password": password},
        timeout=timeout,
    )
    if resp.status_code != 200:
        raise SystemExit(f"Login failed ({resp.status_code}): {resp.text}")
    data = resp.json()
    token = data.get("accessToken") or data.get("access_token")
    if not token:
        raise SystemExit(f"No accessToken in login response: {data}")
    log.info("Authenticated as %s", username)
    return token


# ---------------------------------------------------------------------------
# Thumbnail helpers
# ---------------------------------------------------------------------------


def has_custom_thumbnail(doc: dict) -> bool:
    """Return True when ``doc`` already has a user-uploaded thumbnail.

    Tolerates both camelCase (``fileMetadata``) and snake_case
    (``file_metadata``) shapes, since the API mixes both.
    """
    meta = doc.get("fileMetadata") or doc.get("file_metadata") or {}
    thumb = meta.get("thumbnail", {})
    return bool(thumb.get("has_custom") or thumb.get("has_thumbnail"))


def upload_thumbnail(
    api_base: str,
    token: str,
    document_id: str,
    image_bytes: bytes,
    *,
    filename: str = "cover.jpg",
    content_type: str = "image/jpeg",
    timeout: float = 60.0,
) -> bool:
    """POST ``image_bytes`` to ``/documents/{document_id}/thumbnail``.

    Returns True on 200/201, and also on 409 (a thumbnail already exists,
    which both callers treat as success). Logs a warning and returns False
    on any other status.
    """
    resp = requests.post(
        f"{api_base}/documents/{document_id}/thumbnail",
        files={"file": (filename, image_bytes, content_type)},
        headers=auth_headers(token),
        timeout=timeout,
    )
    if resp.status_code in (200, 201, 409):
        return True
    log.warning(
        "Thumbnail upload failed for %s: %d %s",
        document_id,
        resp.status_code,
        resp.text[:120],
    )
    return False
