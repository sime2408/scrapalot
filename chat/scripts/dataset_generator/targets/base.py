"""Pluggable upload destination protocol + shared helpers.

A *target* is anything the pipeline can hand a (book_file_path, markdown,
chapters) triple to after extraction. Both the REST API uploader and the
direct-PostgreSQL writer implement this protocol so the pipeline can treat
them uniformly without sprinkling ``isinstance`` checks everywhere.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable


@runtime_checkable
class UploadTarget(Protocol):
    """Common contract for shipping extracted markdown to a destination.

    Implementations are expected to be created per worker process (no shared
    state across processes). ``register_markdown`` must be idempotent for the
    same ``book_file_path`` — duplicate uploads return True silently.
    """

    def register_markdown(
        self,
        book_file_path: str,
        markdown: str,
        chapters: list | None = None,
    ) -> bool:
        """Persist the markdown for one book. Return True on success."""
        ...

    def close(self) -> None:
        """Release any connections / model handles held by this instance."""
        ...


def derive_collection_name(book_file_path: str, input_dir: str) -> str:
    """Return the collection name derived from the book's path relative to ``input_dir``.

    Convention: ``<input_dir>/<collection>/<book.pdf>`` → collection name is
    the first subdirectory component. If the book lives directly under
    ``input_dir`` (no nested folder), the input dir's own name is used.
    """
    try:
        rel = Path(book_file_path).relative_to(input_dir)
        if len(rel.parts) > 1:
            return rel.parts[0]
    except ValueError:
        pass
    return Path(input_dir).name
