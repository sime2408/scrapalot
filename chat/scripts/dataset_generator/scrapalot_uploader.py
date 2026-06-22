"""Backward-compat re-export — canonical location is ``targets.rest``.

Kept so the user-facing CLI entry point can import ``UploadContext`` and
``ScrapalotUploader`` from this path without modification.
"""

from scripts.dataset_generator.targets.rest import ScrapalotUploader, UploadContext  # noqa: F401

__all__ = ["ScrapalotUploader", "UploadContext"]
