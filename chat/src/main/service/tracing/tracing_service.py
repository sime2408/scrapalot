"""(CE) RAG/LLM tracing is a hosted-only admin feature.

This is a no-op stub so call sites that conditionally trace degrade cleanly in the
Community Edition. The full tracing service (DB persistence, admin inspector) ships
only in the hosted product.
"""
from __future__ import annotations

from typing import Any


def is_tracing_enabled(*_args: Any, **_kwargs: Any) -> bool:
    return False


def persist_llm_trace(*_args: Any, **_kwargs: Any) -> None:
    return None


def serialize_retrieved_chunks(*_args: Any, **_kwargs: Any) -> list:
    return []
