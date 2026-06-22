"""Utilities for working with Tiptap JSON content."""

from __future__ import annotations

import json
from typing import Any

_BLOCK_LEVEL_TYPES = frozenset({"paragraph", "heading", "blockquote", "codeBlock", "listItem"})


def _coerce_to_dict(content: dict[str, Any] | str) -> dict[str, Any] | None:
    """Decode a string payload to a dict; return ``None`` for invalid input."""
    if isinstance(content, str):
        try:
            decoded = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            return None
        return decoded if isinstance(decoded, dict) else None
    return content if isinstance(content, dict) else None


def extract_text_from_tiptap_json(content: dict[str, Any] | str) -> str:
    """Extract plain text from Tiptap JSON content for search indexing.

    Example::

        >>> content = {"type": "doc", "content": [
        ...     {"type": "paragraph", "content": [{"type": "text", "text": "Hello"}]},
        ...     {"type": "heading",   "content": [{"type": "text", "text": "World"}]},
        ... ]}
        >>> extract_text_from_tiptap_json(content)
        'Hello\\nWorld'
    """
    root = _coerce_to_dict(content)
    if root is None:
        return ""

    def _walk(node: dict[str, Any]) -> list[str]:
        texts: list[str] = []
        if node.get("type") == "text" and "text" in node:
            texts.append(node["text"])
        children = node.get("content")
        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict):
                    texts.extend(_walk(child))
            if node.get("type") in _BLOCK_LEVEL_TYPES and texts and texts[-1] != "\n":
                texts.append("\n")
        return texts

    text = "".join(_walk(root))
    while "\n\n\n" in text:
        text = text.replace("\n\n\n", "\n\n")
    return text.strip()


def validate_tiptap_json(content: dict[str, Any] | str) -> bool:
    """Return ``True`` when ``content`` looks like a valid Tiptap document."""
    root = _coerce_to_dict(content)
    if root is None or "type" not in root:
        return False
    if root.get("type") == "doc":
        children = root.get("content")
        if not isinstance(children, list):
            return False
    return True
