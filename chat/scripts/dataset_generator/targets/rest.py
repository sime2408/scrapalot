"""Scrapalot REST API uploader for the dataset generator pipeline.

Handles authentication, collection mapping, and markdown registration via HTTP.
Each worker process creates its own instance (no shared state across processes).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import time

import requests

from scripts.dataset_generator.targets.base import derive_collection_name
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_API_RETRY_DELAYS = (5, 15, 30)


@dataclass
class UploadContext:
    """Configuration for the Scrapalot API uploader."""

    api_base: str
    username: str
    password: str
    workspace_name: str
    input_dir: str


class ScrapalotUploader:
    """Thin client for uploading extracted markdown to the Scrapalot API.

    Performs lazy authentication (first call triggers login), then caches
    the workspace and collection IDs for the duration of the run.

    Duplicate prevention: on first access to a collection, all existing
    document filenames are fetched and cached so subsequent uploads in the
    same session skip already-present documents without hitting the API again.
    """

    def __init__(self, ctx: UploadContext) -> None:
        self._ctx = ctx
        self._token: str | None = None
        self._workspace_id: str | None = None
        self._collection_cache: dict[str, str] = {}
        # Lazily populated per collection: collection_id → set of filenames already on server
        self._remote_docs: dict[str, set[str]] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def register_markdown(self, book_file_path: str, markdown: str, chapters=None) -> bool:
        """Upload the extracted markdown for a book to the Scrapalot API.

        Returns True on success or when the document already exists remotely.
        Returns False on non-retryable failure.
        """
        try:
            self._ensure_authenticated()
            collection_name = derive_collection_name(book_file_path, self._ctx.input_dir)
            collection_id = self._get_or_create_collection(collection_name)
            return self._post_markdown(book_file_path, markdown, collection_id)
        except Exception as e:
            logger.warning("Upload failed for '%s': %s", book_file_path, e)
            return False

    def close(self) -> None:
        """No-op — the requests session is implicit; nothing to release."""
        return None

    # ------------------------------------------------------------------
    # Authentication
    # ------------------------------------------------------------------

    def _ensure_authenticated(self) -> None:
        if self._token is None:
            self._token = self._login()
        if self._workspace_id is None:
            self._workspace_id = self._resolve_workspace()

    def _login(self) -> str:
        url = f"{self._ctx.api_base}/auth/login"
        resp = requests.post(
            url,
            json={"username": self._ctx.username, "password": self._ctx.password},
            timeout=30,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Login failed ({resp.status_code}): {resp.text}")
        data = resp.json()
        token = data.get("accessToken") or data.get("access_token")
        if not token:
            raise RuntimeError(f"Login response missing accessToken: {data}")
        logger.info("Authenticated as %s", self._ctx.username)
        return token

    # ------------------------------------------------------------------
    # Workspace resolution
    # ------------------------------------------------------------------

    def _resolve_workspace(self) -> str:
        """Find the workspace by name (case-insensitive) or create it."""
        name = self._ctx.workspace_name
        ws_id = self._find_workspace_by_name(name)
        if ws_id:
            return ws_id

        resp = self._post(f"{self._ctx.api_base}/workspaces", {"name": name})
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Failed to create workspace '{name}': {resp.status_code} {resp.text}")
        ws_id = resp.json()["id"]
        logger.info("Created workspace '%s' (id=%s)", name, ws_id)
        return ws_id

    def _find_workspace_by_name(self, name: str) -> str | None:
        """Paginate through all workspaces and return the id of a case-insensitive name match."""
        # GET /workspaces uses explicit snake_case query params: page, page_size
        page = 1
        while True:
            resp = self._get(
                f"{self._ctx.api_base}/workspaces",
                params={"page": page, "page_size": 100},
            )
            if resp.status_code != 200:
                logger.warning("Could not list workspaces (status %d)", resp.status_code)
                return None
            data = resp.json()
            items = data.get("workspaces", data) if isinstance(data, dict) else data
            for ws in items:
                if ws.get("name", "").lower() == name.lower():
                    ws_id = ws["id"]
                    logger.info("Found workspace '%s' (id=%s)", name, ws_id)
                    return ws_id

            pagination = data.get("pagination", {}) if isinstance(data, dict) else {}
            total_pages = pagination.get("pages", 1)
            if page >= total_pages or not items:
                break
            page += 1
        return None

    # ------------------------------------------------------------------
    # Collection resolution
    # ------------------------------------------------------------------

    def _get_or_create_collection(self, name: str) -> str:
        if name in self._collection_cache:
            return self._collection_cache[name]

        cid = self._find_collection_by_name(name)
        if cid:
            self._collection_cache[name] = cid
            return cid

        payload = {
            "name": name,
            "workspace_id": self._workspace_id,
            "chunking_strategy": "recursive",
            "chunk_size": 1000,
            "chunk_overlap": 200,
        }
        resp = self._post(f"{self._ctx.api_base}/collections", payload)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Failed to create collection '{name}': {resp.status_code} {resp.text}")
        cid = resp.json()["id"]
        self._collection_cache[name] = cid
        logger.info("Created collection '%s' (id=%s)", name, cid)
        return cid

    def _find_collection_by_name(self, name: str) -> str | None:
        """Paginate through all collections in the workspace and return the id of a case-insensitive name match.

        NOTE: The collections endpoint uses camelCase query param 'workspaceId' (Spring Boot reads the
        Kotlin parameter name directly — it does not apply Jackson snake_case to query params).
        """
        page = 1
        while True:
            resp = self._get(
                f"{self._ctx.api_base}/collections",
                params={"workspaceId": self._workspace_id, "page": page, "limit": 100},
            )
            if resp.status_code != 200:
                logger.warning("Could not list collections (status %d)", resp.status_code)
                return None
            data = resp.json()
            items = data.get("collections", []) if isinstance(data, dict) else data
            for col in items:
                if col.get("name", "").lower() == name.lower():
                    cid = col["id"]
                    logger.info("Found collection '%s' (id=%s)", name, cid)
                    return cid

            pagination = data.get("pagination", {}) if isinstance(data, dict) else {}
            has_more = pagination.get("has_more", False)
            if not has_more or not items:
                break
            page += 1
        return None

    # ------------------------------------------------------------------
    # Remote document cache (duplicate prevention)
    # ------------------------------------------------------------------

    def _load_remote_docs(self, collection_id: str) -> None:
        """Fetch all document filenames already in a collection and cache them (once per session).

        Prevents duplicate uploads without relying on the server returning 409 (it does not).
        """
        if collection_id in self._remote_docs:
            return

        filenames: set[str] = set()
        page = 1
        while True:
            resp = self._get(
                f"{self._ctx.api_base}/documents/collection/{collection_id}",
                params={"page": page, "page_size": 100},
            )
            if resp.status_code != 200:
                logger.warning(
                    "Could not fetch existing documents for collection %s (status %d) — dedup check skipped",
                    collection_id,
                    resp.status_code,
                )
                break
            data = resp.json()
            docs = data.get("documents", [])
            if not isinstance(docs, list):
                docs = []
            for doc in docs:
                fname = doc.get("filename") or doc.get("name") or ""
                if fname:
                    filenames.add(fname)

            has_more = data.get("has_more", False)
            if not has_more or not docs:
                break
            page += 1

        self._remote_docs[collection_id] = filenames
        if filenames:
            logger.info(
                "Loaded %d existing documents from collection %s",
                len(filenames),
                collection_id,
            )

    # ------------------------------------------------------------------
    # Document upload
    # ------------------------------------------------------------------

    def _post_markdown(self, book_file_path: str, markdown: str, collection_id: str) -> bool:
        src_path = Path(book_file_path)
        filename = src_path.name

        # Client-side dedup: fetch existing docs once and skip if already present
        self._load_remote_docs(collection_id)
        if filename in self._remote_docs.get(collection_id, set()):
            logger.info("Document already exists remotely '%s' — skipping upload", filename)
            return True

        url = f"{self._ctx.api_base}/documents/register-markdown"
        payload = {
            "collection_id": collection_id,
            "filename": filename,
            "title": src_path.stem,
            "markdown_content": markdown,
        }

        for attempt, delay in enumerate(_API_RETRY_DELAYS, 1):
            resp = self._post(url, payload, timeout=120)

            if resp.status_code in (200, 201):
                doc_id = resp.json().get("document_id") or resp.json().get("id") or resp.json().get("documentId")
                logger.info("Uploaded '%s' (doc_id=%s)", filename, doc_id)
                self._remote_docs.setdefault(collection_id, set()).add(filename)
                return True

            # Defensive: keep handling 409 even though current API does not return it
            if resp.status_code == 409:
                logger.info("Document already exists (409) '%s' — skipping", filename)
                self._remote_docs.setdefault(collection_id, set()).add(filename)
                return True

            if resp.status_code == 401:
                logger.info("Token expired — re-authenticating")
                self._token = self._login()

            if attempt < len(_API_RETRY_DELAYS):
                logger.warning(
                    "Upload attempt %d failed (%d) for '%s', retrying in %ds...",
                    attempt,
                    resp.status_code,
                    filename,
                    delay,
                )
                time.sleep(delay)
            else:
                logger.warning(
                    "Upload failed after %d attempts for '%s': %d %s",
                    attempt,
                    filename,
                    resp.status_code,
                    resp.text[:200],
                )

        return False

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"}

    def _get(self, url: str, params: dict | None = None) -> requests.Response:
        return requests.get(url, headers=self._headers(), params=params, timeout=30)

    def _post(self, url: str, payload: dict, timeout: int = 60) -> requests.Response:
        return requests.post(url, json=payload, headers=self._headers(), timeout=timeout)
