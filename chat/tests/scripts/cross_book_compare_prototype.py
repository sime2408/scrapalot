"""PROTOTYPE: delegation path for "compare across books".

Instead of one tool-agent doing everything, this fans out: ONE wide retrieval →
partition chunks by book → one Pydantic-AI subagent PER book (parallel) extracts
that book's stance → a synthesizer agent compares them. The parallel step is
purely LLM-bound (summarisation), so it scales on the 2-CPU box where the
single shared rerank would otherwise serialise — and each subagent is its own
agent with its own structured output + (optional) usage budget.

Prints a parallel-vs-sequential timing so the win is measured, not asserted.

    docker exec scrapalot-chat python tests/scripts/cross_book_compare_prototype.py
"""

import asyncio
from collections import defaultdict
import time
from uuid import UUID

from pydantic import BaseModel, Field

COLLECTION_ID = "5eeec701-511d-4f85-b8b5-6cbcd64e4467"  # anthropology
USER_ID = "ad93054b-635b-47b0-b6f4-7c7e06989c4c"
QUERY = "Compare how the different books here describe kinship systems and the organization of social structure."
N_BOOKS = 4
PASSAGES_PER_BOOK = 6
WIDE_K = 60  # wide, non-reranked net so chunks span multiple books


class BookStance(BaseModel):
    """One book's position on the topic, distilled from its passages."""

    position: str = Field(description="this book's stance on the topic in 1-2 sentences")
    key_points: list[str] = Field(description="2-4 concrete claims this book makes about the topic")


class Comparison(BaseModel):
    common_ground: list[str] = Field(description="points most books agree on")
    differences: list[str] = Field(description="where the books diverge, naming which book holds which view")
    synthesis: str = Field(description="a short comparative paragraph for the reader")


async def main():
    from pydantic_ai import Agent
    from sqlalchemy import text

    from src.main.config.database import SessionLocal
    from src.main.service.retriever.retriever_manager import retriever_manager
    from src.main.utils.config.loader import resolved_config, resolved_secrets
    from src.main.utils.llm.agent_model_utils import get_system_agent_model

    await retriever_manager.initialize(resolved_config, resolved_secrets)
    retriever = await retriever_manager.get_retriever(user_id=USER_ID, retriever_type="pgvector")
    model = get_system_agent_model(agent_type="agentic_rag").get_pydantic_ai_model()
    db = SessionLocal()

    print(f"QUERY: {QUERY}\n", flush=True)

    # 1) ONE wide retrieval over the collection. skip_reranking keeps a broad
    #    vector-ranked net (the rerank would otherwise narrow to ~10 chunks that
    #    cluster in the single most-relevant book — useless for a comparison).
    t0 = time.monotonic()
    chunks = await retriever.similarity_search(QUERY, k=WIDE_K, collection_ids=[UUID(COLLECTION_ID)], skip_reranking=True)
    t_retrieval = time.monotonic() - t0
    print(f"[1] retrieval: {len(chunks)} chunks in {t_retrieval:.1f}s", flush=True)

    # 2) Partition by book; take the N books with the most relevant chunks.
    by_doc: dict = defaultdict(list)
    for c in chunks:
        did = c.metadata.get("document_id")
        if did:
            by_doc[did].append(c)
    # Rank books by relevant-chunk count, then keep the top N with DISTINCT
    # titles (the collection can hold two document_ids for the same title).
    ranked = sorted(by_doc.items(), key=lambda kv: len(kv[1]), reverse=True)
    top: list = []
    titles: dict = {}
    seen_titles: set = set()
    for did, chs in ranked:
        row = db.execute(text("SELECT title FROM documents WHERE id = :i"), {"i": did}).first()
        title = (row[0] if row and row[0] else str(did))[:70]
        if title in seen_titles:
            continue
        seen_titles.add(title)
        titles[did] = title
        top.append((did, chs))
        if len(top) >= N_BOOKS:
            break
    print(f"[2] {len(top)} books: {[titles[d] for d, _ in top]}\n", flush=True)
    if len(top) < 2:
        print("Not enough distinct books to compare — aborting.", flush=True)
        return

    stance_agent = Agent(
        model,
        output_type=BookStance,
        system_prompt=(
            "You read passages from ONE book and report only THAT book's position on the user's "
            "topic. Be faithful to the passages; do not import outside knowledge. If the book barely "
            "addresses the topic, say so in `position`."
        ),
    )

    async def stance(did, chs) -> tuple[str, BookStance]:
        passages = "\n\n".join(c.page_content[:1200] for c in chs[:PASSAGES_PER_BOOK])
        res = await stance_agent.run(f"Topic: {QUERY}\n\nBook: {titles[did]}\n\nPassages:\n{passages}")
        return titles[did], res.output

    # 3a) PARALLEL fan-out (the delegation win).
    t0 = time.monotonic()
    stances = await asyncio.gather(*[stance(did, chs) for did, chs in top])
    t_parallel = time.monotonic() - t0

    # 3b) Same work SEQUENTIALLY, to measure the parallel speedup.
    t0 = time.monotonic()
    for did, chs in top:
        await stance(did, chs)
    t_seq = time.monotonic() - t0

    print(
        f"[3] {len(stances)} book-stances — parallel {t_parallel:.1f}s vs sequential {t_seq:.1f}s (speedup {t_seq / t_parallel:.1f}x)\n", flush=True
    )
    for title, st in stances:
        print(f"  • {title}: {st.position}", flush=True)

    # 4) Synthesize the comparison from the structured stances.
    synth_agent = Agent(
        model,
        output_type=Comparison,
        system_prompt="You compare what several books say about a topic, citing which book holds which view.",
    )
    stance_text = "\n".join(f"- {title}: {st.position} | points: {st.key_points}" for title, st in stances)
    t0 = time.monotonic()
    comp = (await synth_agent.run(f"Topic: {QUERY}\n\nBook positions:\n{stance_text}")).output
    t_synth = time.monotonic() - t0

    total = t_retrieval + t_parallel + t_synth
    print(f"\n[4] synthesis in {t_synth:.1f}s", flush=True)
    print("\n=== COMPARISON ===", flush=True)
    print("Common ground:", comp.common_ground, flush=True)
    print("Differences:", comp.differences, flush=True)
    print("Synthesis:", comp.synthesis, flush=True)
    print(
        f"\n=== TIMING ===  retrieval {t_retrieval:.1f}s + stances(parallel) {t_parallel:.1f}s + "
        f"synth {t_synth:.1f}s = {total:.1f}s total  (sequential stances would add "
        f"{t_seq - t_parallel:.1f}s)",
        flush=True,
    )
    db.close()


if __name__ == "__main__":
    asyncio.run(main())
