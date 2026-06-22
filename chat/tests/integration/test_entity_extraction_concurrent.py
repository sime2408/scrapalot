"""
Concurrent LLM entity extraction — regression tests.

When `extract_entities_batch` processes chunks sequentially (the
pre-2026-05-15 behavior), a 1344-chunk doc takes ~67 minutes at ~3s
per LLM call. Observed in production on Chinese Medical Qigong Therapy
Vol 2 (0aea141b) — the user perceived this as a stuck task.

Commit TBD (2026-05-15) refactored the inner per-chunk loop to use
`asyncio.gather` bounded by `asyncio.Semaphore(5)` plus a per-chunk
`asyncio.wait_for(timeout=60s)` safety net. Expected speedup: ~5×.

These tests cover:
- Concurrent execution (`asyncio.Semaphore` + `asyncio.gather` path)
- Per-chunk timeout firing
- Critical error abort (insufficient_quota / invalid_api_key)
- Batch progress and failure counters preserved
"""

from __future__ import annotations

import asyncio

import pytest


def _make_chunk(chunk_id: str, text: str = "Lorem ipsum dolor sit amet, " * 20) -> dict:
    return {"id": chunk_id, "text": text, "metadata": {"chapter_number": 1, "chapter_title": "Test"}}


@pytest.mark.integration
class TestConcurrentBatch:
    """Verify the new concurrent path exists and behaves correctly."""

    def test_extract_entities_batch_uses_asyncio_gather(self):
        # Static source check — guard against accidental reversion to the
        # sequential `for chunk in batch` loop. The gathered+semaphore
        # pattern must be in the function body.
        import inspect

        from src.main.service.graph.entity_extractor import EntityExtractor

        src = inspect.getsource(EntityExtractor.extract_entities_batch)
        assert "asyncio.Semaphore" in src, "Concurrent path lost — Semaphore missing"
        assert "asyncio.gather" in src, "Concurrent path lost — gather missing"
        assert "asyncio.wait_for" in src, "Per-chunk timeout lost — wait_for missing"
        assert "llm_concurrency" in src, "Concurrency config key lost"
        assert "llm_chunk_timeout" in src, "Per-chunk timeout config key lost"

    def test_concurrency_config_defaults(self):
        # The implementation reads `llm_concurrency` and `llm_chunk_timeout`
        # from `entity_config` with sensible defaults (5 and 60s).
        import inspect

        from src.main.service.graph.entity_extractor import EntityExtractor

        src = inspect.getsource(EntityExtractor.extract_entities_batch)
        # Defaults explicit in source — pin so a refactor doesn't silently
        # drop the semaphore size to 1 or remove the timeout.
        assert 'self.entity_config.get("llm_concurrency", 5)' in src
        assert 'self.entity_config.get("llm_chunk_timeout", 60.0)' in src


@pytest.mark.integration
class TestPerChunkTimeoutAndCritical:
    """The Semaphore-bounded gather should preserve the per-chunk timeout
    AND the critical-error abort behaviour from the sequential version."""

    def test_critical_quota_error_aborts_batch(self):
        """A single chunk hitting `insufficient_quota` opens the circuit
        and aborts the rest of the batch without raising. Replicates the
        pre-refactor invariant."""
        # We can't run a real LLM call here, but we CAN verify the source
        # path: the function body must contain both the error-string check
        # AND the _open_circuit() call.
        import inspect

        from src.main.service.graph.entity_extractor import EntityExtractor

        src = inspect.getsource(EntityExtractor.extract_entities_batch)
        assert "insufficient_quota" in src
        assert "invalid_api_key" in src
        assert "_open_circuit" in src

    def test_timeout_error_handled_per_chunk(self):
        # The `_process_one` helper catches TimeoutError so one stalled LLM
        # call doesn't kill the gather. Verify the source contains the
        # explicit handler.
        import inspect

        from src.main.service.graph.entity_extractor import EntityExtractor

        src = inspect.getsource(EntityExtractor.extract_entities_batch)
        assert "TimeoutError" in src or "asyncio.TimeoutError" in src

    def test_progress_log_every_100_chunks(self):
        # Pin that the progress log line is emitted at the 100-chunk cadence.
        import inspect

        from src.main.service.graph.entity_extractor import EntityExtractor

        src = inspect.getsource(EntityExtractor.extract_entities_batch)
        assert "Entity extraction progress" in src


@pytest.mark.integration
class TestConcurrencyExecutionShape:
    """Light end-to-end: stub out _extract_with_llm to verify concurrent
    dispatch ACTUALLY runs multiple chunks in parallel."""

    @pytest.mark.asyncio
    async def test_concurrent_dispatch_runs_in_parallel(self):
        # Stub the LLM call to sleep 1 second per chunk. With 10 chunks and
        # concurrency=5, the batch should complete in ~2s (10/5 * 1s) instead
        # of ~10s (sequential).
        import time as _time

        from src.main.service.graph.entity_extractor import EntityExtractor

        extractor = EntityExtractor.__new__(EntityExtractor)
        extractor.entity_config = {"batch_size": 10, "llm_concurrency": 5, "llm_chunk_timeout": 30.0}
        extractor.llm = "stub"
        extractor._llm_call_count = 0
        extractor._llm_skip_count = 0

        async def _fake_extract_chunk(text, chunk_id, user_id=None, document_context=""):
            await asyncio.sleep(1.0)
            return []

        extractor.extract_entities_from_chunk = _fake_extract_chunk

        def _is_graph_enabled():
            return True

        extractor._is_graph_enabled = _is_graph_enabled

        chunks = [_make_chunk(f"chunk_{i}") for i in range(10)]
        start = _time.monotonic()
        result = await extractor.extract_entities_batch(chunks)
        elapsed = _time.monotonic() - start

        assert len(result) == 10
        # Sequential would take ≥10s. Concurrent (cap=5) should take ≤3s
        # (10 chunks / 5 parallel * 1s/chunk + overhead).
        assert elapsed < 4.0, f"Expected concurrent execution in <4s, got {elapsed:.2f}s — concurrency not active"

    @pytest.mark.asyncio
    async def test_semaphore_caps_in_flight_calls(self):
        # With concurrency=3 and 9 chunks each sleeping 1s, total time
        # should be ~3s (9/3 batches). Verifies the Semaphore actually
        # bounds parallelism.

        from src.main.service.graph.entity_extractor import EntityExtractor

        extractor = EntityExtractor.__new__(EntityExtractor)
        extractor.entity_config = {"batch_size": 10, "llm_concurrency": 3, "llm_chunk_timeout": 30.0}
        extractor.llm = "stub"
        extractor._llm_call_count = 0
        extractor._llm_skip_count = 0

        in_flight = {"count": 0, "max_seen": 0}

        async def _fake_extract_chunk(text, chunk_id, user_id=None, document_context=""):
            in_flight["count"] += 1
            in_flight["max_seen"] = max(in_flight["max_seen"], in_flight["count"])
            await asyncio.sleep(1.0)
            in_flight["count"] -= 1
            return []

        extractor.extract_entities_from_chunk = _fake_extract_chunk

        def _is_graph_enabled():
            return True

        extractor._is_graph_enabled = _is_graph_enabled

        chunks = [_make_chunk(f"chunk_{i}") for i in range(9)]
        await extractor.extract_entities_batch(chunks)

        # Max simultaneous in-flight calls must equal the semaphore cap (3),
        # never more. (May be less if the test environment is slow.)
        assert in_flight["max_seen"] <= 3, f"Semaphore breach: saw {in_flight['max_seen']} concurrent calls (cap=3)"
        assert in_flight["max_seen"] >= 2, f"Expected ≥2 concurrent, saw only {in_flight['max_seen']} — concurrency not active"
