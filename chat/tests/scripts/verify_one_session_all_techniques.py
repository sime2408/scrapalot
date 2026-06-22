"""One chat session, all 30 techniques, with a real topical query — and confirm
citations come through (post messages.citations-column drop).

Reuses the API harness: logs in as admin, opens ONE session, and for each of the
30 techniques sets it as the manual strategy then sends the SAME real question
(so retrieval actually matches → citations appear). Captures the strategy that
ran + the citation count per message. Restores settings at the end, then
DB-confirms the session's assistant messages carry metadata.citations.

    docker exec scrapalot-chat python tests/scripts/verify_one_session_all_techniques.py
"""

import json
import sys
import time
import uuid

sys.argv = ["x"]

from tests.scripts.verify_techniques_via_api import (  # noqa: E402
    COLLECTION_ID,
    INDIVIDUAL,
    ORCHESTRATORS,
    WORKSPACE_ID,
    _post,
    login,
    restore_settings,
    set_manual_strategy,
)

QUERY = "What do these books say about kinship systems and marriage in early human societies? Please cite the sources."


def chat(token, sid, prompt):
    body = {
        "model": "scrapalot-default",
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
        "scrapalot": {"collection_ids": [COLLECTION_ID], "workspace_id": WORKSPACE_ID},  # no mode → RAG (Engine A, manual)
    }
    resp = _post("/chat/completions", body, token=token, conversation_id=sid, stream=True, timeout=300)
    ran, ans, ci = None, "", 0
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
            ans += d["content"]
        sc = d.get("scrapalot") or {}
        if sc.get("type") in ("strategy_selected", "strategy_transparency"):
            ran = sc.get("strategy_name") or (sc.get("content") or {}).get("strategy_name") or ran
        if sc.get("type") == "citation_info":
            ci += 1
    return ran, len(ans), ci


def main():
    token = login()
    sid = str(uuid.uuid4())
    print(f"ONE session {sid} — all {len(ORCHESTRATORS) + len(INDIVIDUAL)} techniques, manual\n", flush=True)
    rows = []
    try:
        for tech in ORCHESTRATORS + INDIVIDUAL:
            set_manual_strategy(tech, tech in ORCHESTRATORS)
            # One retry to ride out the intermittent "Failed to get LLM" glitch
            # (a transient model-resolution hiccup that yields an empty answer).
            ran, ln, ci = None, 0, 0
            for attempt in (1, 2):
                try:
                    ran, ln, ci = chat(token, sid, QUERY)
                except Exception as e:
                    print(f"  [retry] {tech:30s} attempt {attempt}: {type(e).__name__}"[:90], flush=True)
                    ran, ln, ci = None, 0, 0
                if ln > 0:
                    break
                if attempt == 1:
                    time.sleep(4)
            ok = ln > 0
            rows.append((tech, ran, ln, ci, ok))
            print(f"  [{'OK ' if ok else 'FAIL'}] {tech:34s} ran={ran or '?':30s} len={ln:5d} citations={ci}", flush=True)
    finally:
        restore_settings()

    n_ok = sum(1 for r in rows if r[4])
    n_cited = sum(1 for r in rows if r[3] > 0)
    print(f"\nSUMMARY: {n_ok}/{len(rows)} ran OK · {n_cited}/{len(rows)} produced citations · SESSION={sid}", flush=True)

    # DB proof: assistant messages in this session with metadata.citations.
    from sqlalchemy import text

    from src.main.config.database import SessionLocal

    db = SessionLocal()
    try:
        r = db.execute(
            text(
                "SELECT count(*), count(*) FILTER (WHERE COALESCE(jsonb_array_length(metadata->'citations'),0) > 0) "
                "FROM messages WHERE session_id = :s AND role = 'assistant'"
            ),
            {"s": sid},
        ).first()
        print(f"DB: {r[0]} assistant messages persisted, {r[1]} with metadata.citations", flush=True)
    finally:
        db.close()


if __name__ == "__main__":
    main()
