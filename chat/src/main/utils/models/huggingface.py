"""
On-demand HuggingFace snapshot downloader.

Lives next to ``spacy_cache`` because both wrap a project-local model
cache directory and load lazily. Used by the embeddings stack to pull
``nomic-ai/nomic-embed-text-v2-moe`` and friends into
``<project>/models/embeddings/huggingface/<safe_name>/`` on first
request, then short-circuit subsequent calls.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Resolve <project>/models/embeddings/huggingface relative to this file.
# Layout: src/main/utils/models/huggingface.py
#         → .parent      = utils/models/
#         → .parent.parent = utils/
#         → .parent.parent.parent = main/
#         → .parent.parent.parent.parent = src/
#         → .parent.parent.parent.parent.parent = project root
_DEFAULT_MODELS_DIR = Path(__file__).resolve().parents[4] / "models" / "embeddings" / "huggingface"

# Files that signal a complete model snapshot.
_REQUIRED_FILES: tuple[str, ...] = ("config.json",)
_WEIGHT_FILES: tuple[str, ...] = ("pytorch_model.bin", "model.safetensors", "tokenizer.json")


def _safe_dir_name(model_name: str) -> str:
    """Convert a HF repo id (``org/model``) into a flat directory name."""
    return model_name.replace("/", "--")


class HuggingFaceDownloader:
    """Intelligent HuggingFace model downloader that manages a local cache."""

    def __init__(self, models_dir: str | None = None):
        self.models_dir = Path(models_dir) if models_dir else _DEFAULT_MODELS_DIR
        self.models_dir.mkdir(parents=True, exist_ok=True)
        logger.info("HuggingFace models directory: %s", self.models_dir)

    # ------------------------------------------------------------------ inspect

    def _model_dir(self, model_name: str) -> Path:
        return self.models_dir / _safe_dir_name(model_name)

    def is_model_available_locally(self, model_name: str) -> bool:
        """Return ``True`` when ``model_name`` has a complete local snapshot."""
        model_path = self._model_dir(model_name)
        if not (model_path.exists() and model_path.is_dir()):
            logger.debug("Model %s not found locally", model_name)
            return False

        has_config = any((model_path / f).exists() for f in _REQUIRED_FILES)
        has_weights = any((model_path / f).exists() for f in _WEIGHT_FILES)
        if has_config and has_weights:
            logger.debug("Model %s found locally at %s", model_name, model_path)
            return True
        return False

    def get_local_model_path(self, model_name: str) -> Path | None:
        """Return the local path for ``model_name`` if it is fully cached."""
        return self._model_dir(model_name) if self.is_model_available_locally(model_name) else None

    # ------------------------------------------------------------------ download

    def download_model(self, model_name: str, force_download: bool = False) -> Path | None:
        """Download ``model_name`` from HuggingFace Hub (or return cached path)."""
        if not force_download and self.is_model_available_locally(model_name):
            logger.info("Model %s already available locally", model_name)
            return self.get_local_model_path(model_name)

        try:
            from huggingface_hub import snapshot_download
        except ImportError:
            logger.error("huggingface_hub not installed. Please install with: pip install huggingface_hub")
            return None

        model_path = self._model_dir(model_name)
        logger.info("Downloading model %s to %s", model_name, model_path)
        try:
            downloaded_path = snapshot_download(
                repo_id=model_name,
                local_dir=str(model_path),
                local_dir_use_symlinks=False,
                ignore_patterns=["*.git*", "README.md", "*.md"],
            )
            logger.info("Successfully downloaded model %s", model_name)
            return Path(downloaded_path)
        except Exception as e:
            logger.error("Failed to download model %s: %s", model_name, str(e))
            return None

    def ensure_model_available(self, model_name: str) -> Path | None:
        """Local-first lookup; download if missing."""
        local_path = self.get_local_model_path(model_name)
        if local_path:
            return local_path
        logger.info("Model %s not found locally, attempting to download", model_name)
        return self.download_model(model_name)

    # ------------------------------------------------------------------ metadata

    def get_model_info(self, model_name: str) -> dict[str, Any]:
        """Return ``{model_name, is_local, local_path, size_mb}`` for ``model_name``."""
        info: dict[str, Any] = {
            "model_name": model_name,
            "is_local": self.is_model_available_locally(model_name),
            "local_path": None,
            "size_mb": None,
        }
        local_path = self.get_local_model_path(model_name)
        if local_path is None:
            return info

        info["local_path"] = str(local_path)
        try:
            total_size = sum(f.stat().st_size for f in local_path.rglob("*") if f.is_file())
            info["size_mb"] = round(total_size / (1024 * 1024), 2)
        except Exception as e:
            logger.warning("Could not calculate size for %s: %s", model_name, str(e))
        return info


# Module-level singleton accessor (lazy).
_downloader: HuggingFaceDownloader | None = None


def get_huggingface_downloader() -> HuggingFaceDownloader:
    """Return the process-wide singleton ``HuggingFaceDownloader``."""
    global _downloader
    if _downloader is None:
        _downloader = HuggingFaceDownloader()
    return _downloader
