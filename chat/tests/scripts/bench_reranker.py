"""Benchmark the CPU cross-encoder reranker (mxbai-rerank-base-v1) in isolation.

Measures WARM rerank latency vs document count, using real anthropology chunks,
on an otherwise-idle box — to separate true rerank cost from the CPU contention
seen when the verify harness ran inside the live container.

    docker exec scrapalot-chat python tests/scripts/bench_reranker.py
"""

import asyncio
import statistics
import time

COLL_LC_NAME = "5eeec701-511d-4f85-b8b5-6cbcd64e4467"  # anthropology
QUERY = "What do these books say about kinship systems and social structure in early human societies?"
import os as _os

SIZES = [int(x) for x in _os.environ.get("BENCH_SIZES", "5,10,16,32").split(",")]
REPS = 2


async def main():
    import os

    # Optional: cap torch threads to the container CPU quota (BENCH_THREADS=2).
    # The container is capped at 2 CPUs but torch sees the host's 8 cores and
    # spawns 8 intra/inter-op threads → oversubscription thrashing.
    _t = os.environ.get("BENCH_THREADS")
    if _t:
        import torch

        try:
            torch.set_num_interop_threads(int(_t))
        except Exception as e:
            print(f"(interop set skipped: {e})", flush=True)
        torch.set_num_threads(int(_t))
        print(f"capped torch threads to {_t} (was 8)", flush=True)

    from langchain_core.documents import Document
    from sqlalchemy import text

    from src.main.config.database import SessionLocal
    from src.main.service.retriever.reranker_manager import get_reranker_manager

    db = SessionLocal()
    rows = db.execute(
        text(
            "SELECT e.document FROM langchain_pg_embedding e "
            "JOIN langchain_pg_collection c ON c.uuid = e.collection_id "
            "WHERE c.name = :n AND e.document IS NOT NULL AND length(e.document) > 200 "
            "ORDER BY e.document LIMIT 120"
        ),
        {"n": COLL_LC_NAME},
    ).fetchall()
    texts = [r[0] for r in rows]
    avg = sum(len(t) for t in texts) // max(len(texts), 1)
    print(f"fetched {len(texts)} real chunks; avg {avg} chars (~{avg // 4} tokens)", flush=True)
    docs_all = [Document(page_content=t) for t in texts]

    rm = get_reranker_manager()
    t0 = time.monotonic()
    ok = rm.load_reranker()
    print(f"reranker loaded={ok} model={rm._model_name} load={time.monotonic() - t0:.1f}s", flush=True)

    # Warm the model + thread pool (first call pays one-time costs).
    await rm.rerank_documents_async(QUERY, docs_all[:16], top_n=10)

    print(f"\n{'N':>4} {'median_s':>9} {'min_s':>7} {'max_s':>7} {'per_doc_ms':>11} {'batches16':>10}", flush=True)
    results = {}
    for n in SIZES:
        if n > len(docs_all):
            continue
        docs = docs_all[:n]
        ts = []
        for _ in range(REPS):
            s = time.monotonic()
            await rm.rerank_documents_async(QUERY, docs, top_n=10)
            ts.append(time.monotonic() - s)
        med = statistics.median(ts)
        results[n] = med
        batches = -(-n // 16)
        print(f"{n:>4} {med:>9.2f} {min(ts):>7.2f} {max(ts):>7.2f} {med / n * 1000:>11.1f} {batches:>10}", flush=True)

    print("\nSUMMARY:", {k: round(v, 2) for k, v in results.items()}, flush=True)
    db.close()


if __name__ == "__main__":
    asyncio.run(main())
