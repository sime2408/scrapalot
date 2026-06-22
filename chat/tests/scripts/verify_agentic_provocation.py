"""Agentic provocation battery — ONE session, varied questions each crafted to
provoke a DIFFERENT technique, against ONE collection (anthropology).

Proves: different questions push the agentic router to pick different techniques
and exercise different retrieval behaviour (sources / sub-queries / citations).
Each query targets a specific Tier-1 rule (see tiered_router.py); we capture what
the router ACTUALLY fired (strategy_transparency packet), not what we hoped.

    docker exec scrapalot-chat python tests/scripts/verify_agentic_provocation.py
"""

import json
import sys
import time
import uuid

sys.argv = ["x"]

from tests.scripts.verify_techniques_via_api import (  # noqa: E402
    COLLECTION_ID,
    WORKSPACE_ID,
    _post,
    login,
    set_agentic_routing,
)

# (intended technique, query crafted to provoke it via a Tier-1 rule / router rule)
BATTERY = [
    ("RAGHybridSummarySearch", "Summarize the main themes and key ideas of this collection."),
    ("RAGSectionExpansion", "Give me the complete section on the incest taboo, verbatim."),
    ("RAGRegexGrep", 'Find the exact phrase "elementary structures of kinship" in the books.'),
    ("RAGSelfQuery", "What are the most recent anthropological theories on kinship published after 1950?"),
    ("RAGSparseSearch", "What is the meaning of the term TOTEM in these societies?"),
    ("RAGEntityExpanded", "What do all the books say about totemism across the collection?"),
    ("RAGGraphSearch", "How is the mother's brother connected to inheritance and descent?"),
    ("RAGStepBack", "Why does the incest taboo exist universally in human societies?"),
    ("RAGDecomposition", "What is exogamy, and what is endogamy, and how does each one work?"),
    ("RAGMultiQuery", "Compare patrilineal and matrilineal descent systems."),
    ("RAGSimilaritySearch", "What is bridewealth?"),
    ("RAGRewriteRetrieveRead", "kinship terms"),
    ("RAGQueryChain", "How did the rise of agriculture lead, step by step, to changes in kinship organization?"),
    ("RAGFusion", "Give me a thorough, comprehensive analysis of everything about totemism and its social functions."),
    ("RAGParentDocument", "What is the broader surrounding context of the discussion of taboo in these texts?"),
    ("RAGAgenticContextNavigator", "Walk me through the chapters that cover ritual and ceremony."),
    ("RAGAgenticExpansion", "Search broadly across the collection and then go deeper on initiation rites."),
    ("RAGHyDE", "Explain the concept of mana as if to a complete beginner."),
    ("RAGHybridSelfQuery", "What does the kinship term avunculate refer to in descent theory?"),
    ("RAGGenerativeFeedbackLoop", "Building on what you said earlier about descent, can you elaborate on matrilineal systems?"),
]


def chat(token, sid, prompt):
    body = {
        "model": "scrapalot-default",
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
        "scrapalot": {"collection_ids": [COLLECTION_ID], "workspace_id": WORKSPACE_ID, "language": "en", "mode": "agentic"},
    }
    resp = _post("/chat/completions", body, token=token, conversation_id=sid, stream=True, timeout=300)
    picked, cites, ans = {}, 0, 0
    for raw in resp:
        line = raw.decode("utf-8", "ignore").strip()
        if not line.startswith("data:"):
            continue
        p = line[5:].strip()
        if p in ("", "[DONE]"):
            continue
        try:
            ch = json.loads(p)
        except Exception:
            continue
        d = (ch.get("choices") or [{}])[0].get("delta", {})
        if d.get("content"):
            ans += len(d["content"])
        sc = d.get("scrapalot") or {}
        t = sc.get("type")
        if t == "strategy_transparency":
            picked = {k: sc.get(k) for k in ("strategy_name", "executor", "sources_queried", "sub_queries", "rationale")}
        if t == "citation_info":
            cites += 1
    return picked, cites, ans


def main():
    token = login()
    set_agentic_routing(True)  # keep agentic default on (mode=agentic also forces Engine B per request)
    sid = str(uuid.uuid4())
    print(f"AGENTIC provocation session {sid} — {len(BATTERY)} queries, collection=anthropology\n", flush=True)
    rows = []
    for intended, q in BATTERY:
        picked, cites, ans = {}, 0, 0
        for attempt in (1, 2):
            try:
                picked, cites, ans = chat(token, sid, q)
            except Exception as e:
                print(f"  [retry] {intended} attempt {attempt}: {type(e).__name__}"[:90], flush=True)
                picked, cites, ans = {}, 0, 0
            if ans > 0:
                break
            if attempt == 1:
                time.sleep(4)
        fired = picked.get("strategy_name") or "?"
        execu = picked.get("executor") or "?"
        srcs = ",".join(picked.get("sources_queried") or [])
        nsub = len(picked.get("sub_queries") or [])
        rule = (picked.get("rationale") or "")[:62]
        rows.append((intended, fired, execu, srcs, nsub, cites, ans))
        print(f"  Q: {q[:56]}", flush=True)
        print(f"     intended={intended:24s} FIRED={fired:26s} exec={execu}", flush=True)
        print(f"     sources=[{srcs}] sub_q={nsub} citations={cites} len={ans}  | {rule}", flush=True)

    distinct = sorted({r[1] for r in rows if r[1] != "?"})
    print(f"\nSUMMARY: {len(rows)} queries → {len(distinct)} DISTINCT techniques fired", flush=True)
    print(f"  techniques: {distinct}", flush=True)
    print(f"SESSION={sid}", flush=True)


if __name__ == "__main__":
    main()
