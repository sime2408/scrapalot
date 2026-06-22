"""
LLMWhisperer v2 (Unstract) client — layout-preserving OCR for hard scanned PDFs.

INERT without an API key: every entry point returns ``None`` / ``False`` so the
default OCR engine (Docling/RapidOCR) is untouched. Wire the key into
``document_processing.ocr_escalation`` to activate; the actual API calls are
implemented to the v2 spec but should be smoke-tested once a real key exists.
"""

from __future__ import annotations

import time

from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# We pass page_separator explicitly on submit (the API misspells the param), so
# the split marker is deterministic regardless of the account's default.
_PAGE_SEP = "\f"
# Account region is EU-west. Override via LLMWHISPERER_BASE_URL for us-central /
# self-hosted. The "/api/v2" suffix is appended by _v2(); a base that already
# carries it (e.g. the Postman value) is normalized so both forms work.
_DEFAULT_BASE = "https://llmwhisperer-api.eu-west.unstract.com"


def _cfg() -> dict:
    return resolved_config.get("document_processing", {}).get("ocr_escalation", {}) or {}


def _api_key() -> str:
    return str(_cfg().get("api_key", "") or "").strip()


def _base_url() -> str:
    return str(_cfg().get("base_url", "") or "").strip() or _DEFAULT_BASE


def _v2(base: str) -> str:
    """Return the ``…/api/v2`` root, tolerating a base with or without it."""
    base = base.rstrip("/")
    if base.endswith("/api/v2"):
        return base
    return f"{base}/api/v2"


def is_configured() -> bool:
    """True only when the escalation is enabled AND an API key is present."""
    from src.main.service.document.ocr.ocr_escalation import _as_bool

    return _as_bool(_cfg().get("enabled")) and bool(_api_key())


def extract_pages(file_path: str) -> list[str] | None:
    """OCR ``file_path`` via LLMWhisperer v2; return per-page layout-preserved text.

    Returns ``None`` on any failure / missing key so the caller keeps the default
    OCR output. Synchronous wrapper over the async submit → poll → retrieve flow.
    """
    key = _api_key()
    if not key:
        return None
    try:
        import requests

        v2 = _v2(_base_url())
        headers = {"unstract-key": key}
        with open(file_path, "rb") as fh:
            data = fh.read()
        # 1) submit — high_quality OCR, layout-preserving, explicit page marker.
        # v2 is async: a successful submit returns 202 + whisper_hash.
        sub = requests.post(
            f"{v2}/whisper",
            headers={**headers, "Content-Type": "application/octet-stream"},
            params={
                "mode": "high_quality",
                "output_mode": "layout_preserving",
                "page_seperator": _PAGE_SEP,  # API's (misspelled) param; deterministic split
            },
            data=data,
            timeout=120,
        )
        sub.raise_for_status()
        whisper_hash = sub.json().get("whisper_hash")
        if not whisper_hash:
            logger.warning("LLMWhisperer submit returned no whisper_hash for %s", file_path)
            return None
        # 2) poll status until 'processed'
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            st = requests.get(f"{v2}/whisper-status", headers=headers, params={"whisper_hash": whisper_hash}, timeout=30)
            st.raise_for_status()
            status = (st.json().get("status") or "").lower()
            if status in ("processed", "delivered"):
                break
            if status in ("error", "failed"):
                logger.warning("LLMWhisperer status=%s for %s", status, file_path)
                return None
            time.sleep(4)
        else:
            logger.warning("LLMWhisperer timed out polling for %s", file_path)
            return None
        # 3) retrieve — text_only=true returns the raw extracted text directly
        rt = requests.get(
            f"{v2}/whisper-retrieve",
            headers=headers,
            params={"whisper_hash": whisper_hash, "text_only": "true"},
            timeout=120,
        )
        rt.raise_for_status()
        text = rt.text
        if not text or not text.strip():
            return None
        return text.split(_PAGE_SEP)
    except Exception as e:  # never break the OCR path
        logger.warning("LLMWhisperer extract failed for %s: %s", file_path, e)
        return None
