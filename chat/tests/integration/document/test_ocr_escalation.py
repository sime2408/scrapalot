"""
LLMWhisperer OCR-escalation gate — regression tests.

The escalation pipe (`src/main/service/document/ocr/`) lets Docling/RapidOCR
stay the default OCR engine and only hands a scanned PDF to LLMWhisperer when
(1) escalation is enabled, (2) an API key is configured, (3) the daily page
budget allows it, and (4) the default OCR genuinely under-extracted.

Without a key the whole pipe is INERT — `is_configured()` is False and
`maybe_escalate_ocr()` returns None so the caller keeps its Docling/RapidOCR
output. These tests pin that inert contract plus the two pure pieces that DON'T
need the external API: the env-string boolean coercion and the Redis-backed
daily page-budget reservation (real Redis, cleaned up after).

The actual LLMWhisperer submit→poll→retrieve flow needs a live key and is left
for a smoke test once one exists.
"""

from __future__ import annotations

import pytest

from src.main.service.document.ocr import llm_whisperer_client as lw
from src.main.service.document.ocr import ocr_escalation


@pytest.mark.integration
class TestAsBool:
    """Env-substituted `${VAR:-false}` yields the STRING "false" (truthy under
    plain bool()). `_as_bool` must coerce the real intent."""

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("false", False),
            ("False", False),
            ("FALSE", False),
            ("0", False),
            ("", False),
            (None, False),
            ("true", True),
            ("True", True),
            ("1", True),
            ("yes", True),
            ("on", True),
            (True, True),
            (False, False),
        ],
    )
    def test_coercion(self, value, expected):
        assert ocr_escalation._as_bool(value) is expected


@pytest.mark.integration
class TestInertWithoutKey:
    """No API key in the default config → the pipe does nothing."""

    def test_is_configured_false(self):
        assert lw.is_configured() is False

    def test_extract_pages_returns_none(self):
        assert lw.extract_pages("/does/not/matter.pdf") is None

    def test_maybe_escalate_returns_none(self):
        # Even with obviously-poor default OCR (0 chars over 10 pages) the gate
        # short-circuits on the missing key before touching anything.
        result = ocr_escalation.maybe_escalate_ocr("/nope.pdf", [], page_count=10)
        assert result is None


@pytest.mark.integration
class TestBudgetReservation:
    """Daily page budget against real Redis. Each test isolates itself by
    deleting today's budget key before and after."""

    def _budget_key(self):
        from datetime import UTC, datetime

        day = datetime.now(UTC).strftime("%Y-%m-%d")
        return f"{ocr_escalation._BUDGET_KEY_PREFIX}{day}"

    @pytest.fixture(autouse=True)
    def _clean_key(self):
        from src.main.utils.redis.client import get_redis_client

        redis = get_redis_client()
        key = self._budget_key()
        redis.delete(key)
        yield
        redis.delete(key)

    def test_reserve_within_budget(self):
        # Default daily_page_budget is 100; reserving 30 must succeed.
        assert ocr_escalation._reserve_budget(30) is True

    def test_single_doc_larger_than_budget_rejected(self):
        # A doc bigger than the whole daily budget can never be reserved.
        assert ocr_escalation._reserve_budget(1000) is False

    def test_budget_exhaustion_and_rollback(self):
        from src.main.utils.redis.client import get_redis_client

        # Reserve 80 of 100, then a 40-page doc must be rejected AND rolled
        # back so the counter stays at 80 (a later 20-page doc still fits).
        assert ocr_escalation._reserve_budget(80) is True
        assert ocr_escalation._reserve_budget(40) is False

        redis = get_redis_client()
        used = int(redis.get(self._budget_key()) or 0)
        assert used == 80, f"over-reservation not rolled back: counter={used}"

        # The remaining 20 still fit.
        assert ocr_escalation._reserve_budget(20) is True
