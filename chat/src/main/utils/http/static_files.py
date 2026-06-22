"""
Static-file mounting for the embedded React UI.

Locates the ``static/`` directory (env override + local + docker paths),
mounts asset subfolders, the ``data/`` upload tree, and registers the
SPA catch-all route that serves ``index.html`` for non-API paths.
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Directory discovery
# ---------------------------------------------------------------------------

# Common cloud / Docker mount points to fall back to. The local-dev path is
# resolved relative to this file: ``…/src/main/utils/http/static_files.py``
# climbs five levels to reach the repository root.
_THIS_FILE = os.path.abspath(__file__)
_LOCAL_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(_THIS_FILE)))))
_FALLBACK_PATHS: tuple[str, ...] = (
    "/app/static",
    "/opt/app/static",
    "/home/app/static",
    os.path.join(os.getcwd(), "static"),
    os.path.join(_LOCAL_PROJECT_ROOT, "static"),
)


def _is_static_root(path: str) -> bool:
    """A directory qualifies as the React build root when it contains ``index.html``."""
    return bool(path) and os.path.exists(path) and os.path.exists(os.path.join(path, "index.html"))


def find_static_directory() -> str:
    """Resolve the React ``static/`` directory across deployment shapes.

    Lookup order:
      1. ``STATIC_DIR`` environment variable (production override)
      2. Common Docker / cloud mount points
      3. Repository-relative ``static/`` (local development)
      4. Final fallback next to this file (may not exist)
    """
    env_static = os.environ.get("STATIC_DIR")
    if env_static and _is_static_root(env_static):
        logger.info("Using static directory from STATIC_DIR environment: %s", env_static)
        return env_static

    for candidate in _FALLBACK_PATHS:
        if _is_static_root(candidate):
            logger.info("Found static directory at: %s", candidate)
            return candidate

    fallback = os.path.join(os.path.dirname(_THIS_FILE), "static")
    logger.warning("⚠️ Using fallback static directory (may not exist): %s", fallback)
    return fallback


def log_static_directory_info(static_dir: str) -> None:
    """Emit a one-line summary of what's inside ``static_dir`` for debugging."""
    if not static_dir or not os.path.exists(static_dir):
        return
    try:
        contents = os.listdir(static_dir)
        logger.info(
            "📁 Static directory contents: %s%s",
            contents[:10],
            "..." if len(contents) > 10 else "",
        )
        missing = [f for f in ("index.html", "assets") if not os.path.exists(os.path.join(static_dir, f))]
        if missing:
            logger.warning("⚠️ Missing critical static files: %s", missing)
        else:
            logger.info("All critical static files found")
    except Exception as e:
        logger.warning("⚠️ Could not list static directory contents: %s", e)


# ---------------------------------------------------------------------------
# Mounts
# ---------------------------------------------------------------------------

_ASSET_SUBDIRS = ("assets", "icons", "connectors", "frameworks", "providers", "product")
_ROOT_FILES = (
    "favicon.ico",
    "logo512-circle.png",
    "logo512.png",
    "logo-black.svg",
    "placeholder.svg",
)
# Any path starting with these prefixes is treated as non-SPA and the
# catch-all returns ``{"detail": "Not Found"}`` instead of ``index.html``.
_NON_SPA_PREFIXES: tuple[str, ...] = (
    "api/",
    "static/",
    "data/",
    "upload/",
    "ws/",
    "stomp/",
    "health",
    "websocket-test",
    "assets/",
    "icons/",
    "connectors/",
    "frameworks/",
    "providers/",
    "product/",
    *_ROOT_FILES,
)


def mount_static_files(app: FastAPI, static_dir: str) -> None:
    """Mount asset subfolders at the root + ``/static`` for backward compat."""
    if not os.path.exists(static_dir):
        logger.warning("⚠️ Static directory not found: %s", static_dir)
        return

    for subdir in _ASSET_SUBDIRS:
        subdir_path = os.path.join(static_dir, subdir)
        if os.path.exists(subdir_path):
            app.mount(f"/{subdir}", StaticFiles(directory=subdir_path), name=subdir)

    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    logger.info("Static files mounted at root level and /static from: %s", static_dir)


def mount_data_directory(app: FastAPI) -> None:
    """Mount ``data/`` and ``data/upload/`` (creating ``data/upload`` if missing)."""
    data_dir = os.path.join(os.getcwd(), "data")
    if os.path.exists(data_dir):
        app.mount("/data", StaticFiles(directory=data_dir), name="data")
        logger.info("Data files mounted at /data from: %s", data_dir)
    else:
        logger.warning("⚠️ Data directory not found: %s", data_dir)

    upload_dir = os.path.join(data_dir, "upload")
    if os.path.exists(upload_dir):
        app.mount("/upload", StaticFiles(directory=upload_dir), name="upload")
        logger.info("Upload files mounted at /upload from: %s", upload_dir)
        profile_pics_dir = os.path.join(upload_dir, "profile_pictures")
        if os.path.exists(profile_pics_dir):
            logger.info("Profile pictures directory found: %s", profile_pics_dir)
        else:
            logger.info("📁 Profile pictures directory will be created when needed: %s", profile_pics_dir)
        return

    try:
        os.makedirs(upload_dir, exist_ok=True)
        app.mount("/upload", StaticFiles(directory=upload_dir), name="upload")
        logger.info("Created and mounted upload directory at /upload: %s", upload_dir)
    except Exception as e:
        logger.warning("⚠️ Could not create upload directory: %s", e)


def create_static_file_routes(app: FastAPI, static_dir: str) -> None:
    """Register individual handlers for top-level static files (favicon, logo, ...)."""
    for filename in _ROOT_FILES:
        file_path = os.path.join(static_dir, filename)
        if not os.path.exists(file_path):
            continue

        def _make_handler(path: str):
            async def _serve() -> FileResponse:
                return FileResponse(path)

            return _serve

        route_name = filename.replace(".", "_").replace("-", "_")
        app.get(f"/{filename}", include_in_schema=False, name=f"serve_{route_name}")(_make_handler(file_path))


def create_ui_routes(app: FastAPI, static_dir: str) -> None:
    """Register the SPA index + catch-all for client-side routing."""
    index_html_path = os.path.join(static_dir, "index.html")

    # noinspection PyUnusedFunction
    @app.get("/", include_in_schema=False)
    async def serve_ui():
        """Serve the embedded React UI index.html at the root path."""
        if os.path.exists(index_html_path):
            return FileResponse(index_html_path)
        logger.error("❌ index.html not found at: %s", index_html_path)
        return {"error": "UI not found", "path": index_html_path}

    # noinspection PyUnusedFunction
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_ui_routes(full_path: str):
        """Serve the React UI for any non-API route (SPA routing)."""
        if full_path.startswith(_NON_SPA_PREFIXES):
            return {"detail": "Not Found"}
        if os.path.exists(index_html_path):
            return FileResponse(index_html_path)
        logger.error("❌ index.html not found at: %s", index_html_path)
        return {"error": "UI not found", "path": index_html_path}


def setup_static_files(app: FastAPI) -> None:
    """One-call entrypoint that wires up every static surface."""
    static_dir = find_static_directory()
    log_static_directory_info(static_dir)
    mount_static_files(app, static_dir)
    mount_data_directory(app)
    create_static_file_routes(app, static_dir)
    create_ui_routes(app, static_dir)
