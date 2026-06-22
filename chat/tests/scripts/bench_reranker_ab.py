"""A/B reranker models: CPU latency + ranking agreement on real chunks.

Compares the current production reranker against faster candidates. Quality is
proxied by top-10 overlap with the current model (the baseline we trust today).

    docker exec scrapalot-chat python tests/scripts/bench_reranker_ab.py
"""

import os
import statistics
import time

os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("MKL_NUM_THREADS", "2")

COLL = "5eeec701-511d-4f85-b8b5-6cbcd64e4467"  # anthropology
QUERIES = [
    "What do these books say about kinship systems and social structure in early human societies?",
    "How did the shift to agriculture change human social organization?",
]
MODELS = [
    ("base (current)", "mixedbread-ai/mxbai-rerank-base-v1"),
    ("xsmall", "mixedbread-ai/mxbai-rerank-xsmall-v1"),
    ("MiniLM-L6", "cross-encoder/ms-marco-MiniLM-L-6-v2"),
]
N = 16


def main():
    from sentence_transformers import CrossEncoder
    from sqlalchemy import text

    from src.main.config.database import SessionLocal

    db = SessionLocal()
    rows = db.execute(
        text(
            "SELECT e.document FROM langchain_pg_embedding e "
            "JOIN langchain_pg_collection c ON c.uuid = e.collection_id "
            "WHERE c.name = :n AND e.document IS NOT NULL AND length(e.document) > 200 "
            "ORDER BY e.document LIMIT :k"
        ),
        {"n": COLL, "k": N},
    ).fetchall()
    docs = [r[0] for r in rows]
    print(f"{len(docs)} candidate docs · {len(QUERIES)} queries · CPU · OMP={os.environ['OMP_NUM_THREADS']}\n", flush=True)

    base_top: dict = {}
    for label, name in MODELS:
        try:
            t0 = time.monotonic()
            m = CrossEncoder(name, max_length=512, device="cpu")
            load = time.monotonic() - t0
        except Exception as e:
            print(f"{label:16s} LOAD FAILED: {str(e)[:80]}", flush=True)
            continue
        lat = []
        tops: dict = {}
        for qi, q in enumerate(QUERIES):
            pairs = [(q, d) for d in docs]
            s = time.monotonic()
            scores = m.predict(pairs)
            lat.append(time.monotonic() - s)
            tops[qi] = set(sorted(range(len(docs)), key=lambda i: scores[i], reverse=True)[:10])
        med = statistics.median(lat)
        if label.startswith("base"):
            base_top = tops
            agree = "(reference)"
        else:
            ov = [len(tops[qi] & base_top[qi]) / 10 for qi in tops] if base_top else [0]
            agree = f"{sum(ov) / len(ov) * 100:.0f}% top-10 overlap vs base"
        speedup = ""
        print(
            f"{label:16s} load={load:4.1f}s · rerank {len(docs)} docs: {med:6.2f}s ({med / len(docs) * 1000:5.0f} ms/doc) · {agree}{speedup}",
            flush=True,
        )
    db.close()


if __name__ == "__main__":
    main()
