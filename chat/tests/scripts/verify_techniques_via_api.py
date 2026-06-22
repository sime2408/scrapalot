"""Drive EVERY RAG technique through the REAL chat API, creating 2 visible chat
sessions under the admin account (the proof the in-process harness could not give).

- SESSION A (manual): for each of the 30 techniques, set the user's manual
  strategy in settings (use_agentic_routing=false) then send a chat message in
  the SAME session (mode=rag → Engine A runs exactly that technique).
- SESSION B (automatic): use_agentic_routing on + mode=agentic → Engine B's
  router picks per query; send a battery of queries and record what it chose.

Runs inside scrapalot-chat (reaches scrapalot-gw + the settings DB). Restores the
admin's original settings at the end. Both sessions show up in the admin's chat.

    docker exec scrapalot-chat python tests/scripts/verify_techniques_via_api.py
"""

import json
import time
import urllib.request
import uuid

GW = "http://scrapalot-gw:8080/api/v1"
ADMIN_USER, ADMIN_PASS = "admin", "admin123"
USER_ID = "ad93054b-635b-47b0-b6f4-7c7e06989c4c"
COLLECTION_ID = "5eeec701-511d-4f85-b8b5-6cbcd64e4467"  # anthropology
WORKSPACE_ID = "0ebf2e09-7198-4b7a-a100-87b6dc969387"

ORCHESTRATORS = [
    "EnhancedTriModalOrchestrator",
    "RAGAdaptiveOrchestrator",
    "RAGBalancedOrchestrator",
    "RAGContextEnhancedOrchestrator",
    "RAGDocumentHierarchyOrchestrator",
    "RAGFeedbackLoopOrchestrator",
    "RAGKnowledgeIntensiveOrchestrator",
    "RAGPrecisionOrchestrator",
    "RAGQueryRefinementOrchestrator",
]
INDIVIDUAL = [
    "RAGSimilaritySearch",
    "RAGSparseSearch",
    "RAGRegexGrep",
    "RAGSelfQuery",
    "RAGHybridSelfQuery",
    "RAGHyDE",
    "RAGMultiQuery",
    "RAGFusion",
    "RAGHybridSummarySearch",
    "RAGParentDocument",
    "RAGStepBack",
    "RAGDecomposition",
    "RAGGraphSearch",
    "RAGGenerativeFeedbackLoop",
    "RAGQueryChain",
    "RAGRewriteRetrieveRead",
    "RAGSectionExpansion",
    "RAGAgenticExpansion",
    "RAGAgenticContextNavigator",
    "RAGTwoPhaseContext",
    "RAGEntityExpanded",
]
# Automatic-session battery: queries crafted to exercise the router's range
# (Tier-1 rule triggers + a few ambiguous → LLM).
AUTO_QUERIES = [
    "What does commit a1b2c3d4e5f6 change about kinship theory?",  # git sha → grep
    "Summarize the main themes of this book",  # overview → summary
    "How is kinship related to economic exchange across these books?",  # relation → graph
    "Compare matrilineal and patrilineal descent systems",  # compare → multi-query
    "Why does Lévi-Strauss emphasize the incest taboo?",  # why → step-back
    "Show me the full section on the elementary structures of kinship",  # full section
    "What do these books say across all of them about marriage rules?",  # cross-doc → entity
    "error code ERR-404 in fieldwork methodology",  # error code
    "What is reciprocity?",  # short/vague
    "Explain the relationship between gift-giving and social obligation",  # semantic
    "kinship",  # ALL-lower single term
    "What are the kinship systems described here and how do they shape society?",  # ambiguous/general
]

ORIG_SETTINGS = {}


def _post(path, body, token=None, conversation_id=None, stream=False, timeout=180):
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if conversation_id:
        headers["Conversation-Id"] = conversation_id
    req = urllib.request.Request(f"{GW}{path}", data=data, headers=headers, method="POST")
    return urllib.request.urlopen(req, timeout=timeout)


def login():
    resp = _post("/auth/login", {"username_or_email": ADMIN_USER, "password": ADMIN_PASS}, timeout=20)
    return json.loads(resp.read())["access_token"]


def set_manual_strategy(technique, is_orchestrator):
    """Write the admin's settings so Engine A runs exactly `technique`."""
    from sqlalchemy import text

    from src.main.config.database import SessionLocal

    db = SessionLocal()
    try:
        row = db.execute(
            text("SELECT setting_value FROM user_settings WHERE user_id = :u AND setting_key = 'settings_general'"),
            {"u": USER_ID},
        ).first()
        cur = dict(row[0]) if row and isinstance(row[0], dict) else {}
        if not ORIG_SETTINGS:
            ORIG_SETTINGS.update(cur)  # snapshot once for restore
        cur.update(
            {
                "use_agentic_routing": False,
                "use_orchestrator": is_orchestrator,
                "rag_orchestrator": technique if is_orchestrator else cur.get("rag_orchestrator", "EnhancedTriModalOrchestrator"),
                "rag_strategy": technique if not is_orchestrator else cur.get("rag_strategy", "RAGSimilaritySearch"),
            }
        )
        db.execute(
            text("UPDATE user_settings SET setting_value = :v WHERE user_id = :u AND setting_key = 'settings_general'"),
            {"v": json.dumps(cur), "u": USER_ID},
        )
        db.commit()
    finally:
        db.close()


def set_agentic_routing(enabled):
    from sqlalchemy import text

    from src.main.config.database import SessionLocal

    db = SessionLocal()
    try:
        row = db.execute(
            text("SELECT setting_value FROM user_settings WHERE user_id = :u AND setting_key = 'settings_general'"),
            {"u": USER_ID},
        ).first()
        cur = dict(row[0]) if row and isinstance(row[0], dict) else {}
        if not ORIG_SETTINGS:
            ORIG_SETTINGS.update(cur)
        cur["use_agentic_routing"] = enabled
        db.execute(
            text("UPDATE user_settings SET setting_value = :v WHERE user_id = :u AND setting_key = 'settings_general'"),
            {"v": json.dumps(cur), "u": USER_ID},
        )
        db.commit()
    finally:
        db.close()


def restore_settings():
    if not ORIG_SETTINGS:
        return
    from sqlalchemy import text

    from src.main.config.database import SessionLocal

    db = SessionLocal()
    try:
        db.execute(
            text("UPDATE user_settings SET setting_value = :v WHERE user_id = :u AND setting_key = 'settings_general'"),
            {"v": json.dumps(ORIG_SETTINGS), "u": USER_ID},
        )
        db.commit()
        print(f"  [restored original settings: use_agentic_routing={ORIG_SETTINGS.get('use_agentic_routing')}]", flush=True)
    finally:
        db.close()


def chat(token, session_id, prompt, agentic):
    """Send one message; return (strategy_used, answer_len, http_status, error)."""
    extras = {"collection_ids": [COLLECTION_ID], "workspace_id": WORKSPACE_ID}
    if agentic:
        extras["mode"] = "agentic"
    body = {"model": "scrapalot-default", "messages": [{"role": "user", "content": prompt}], "stream": True, "scrapalot": extras}
    picked, ans_len, err = None, 0, None
    try:
        resp = _post("/chat/completions", body, token=token, conversation_id=session_id, stream=True, timeout=180)
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload in ("", "[DONE]"):
                continue
            try:
                chunk = json.loads(payload)
            except Exception:
                continue
            delta = (chunk.get("choices") or [{}])[0].get("delta", {})
            if delta.get("content"):
                ans_len += len(delta["content"])
            sc = delta.get("scrapalot") or {}
            t = sc.get("type", "")
            if t in ("strategy_selected", "strategy_transparency"):
                picked = sc.get("strategy_name") or (sc.get("content") or {}).get("strategy_name") or picked
            if "error" in t.lower() and err is None:
                err = str(sc.get("message") or sc.get("content") or t)[:120]
        return picked, ans_len, 200, err
    except Exception as e:
        return picked, ans_len, getattr(e, "code", 0), f"{type(e).__name__}: {e}"[:160]


def db_proof(session_a, session_b):
    from sqlalchemy import text

    from src.main.config.database import SessionLocal

    db = SessionLocal()
    try:
        for label, sid in (("A/manual", session_a), ("B/auto", session_b)):
            r = db.execute(text("SELECT count(*) FROM messages WHERE session_id = :s"), {"s": sid}).scalar()
            print(f"  session {label} {sid}: {r} messages persisted", flush=True)
    except Exception as e:
        print(f"  (proof query skipped: {e})", flush=True)
    finally:
        db.close()


def main():
    token = login()
    print(f"logged in as {ADMIN_USER} ({USER_ID})", flush=True)
    session_a = str(uuid.uuid4())
    session_b = str(uuid.uuid4())
    results = {"manual": [], "auto": []}
    try:
        # ---- SESSION A: manual, all 30 techniques ----
        print(f"\n=== SESSION A (manual) {session_a} ===", flush=True)
        for tech in ORCHESTRATORS + INDIVIDUAL:
            is_orch = tech in ORCHESTRATORS
            set_manual_strategy(tech, is_orch)
            time.sleep(0.5)
            picked, ln, st, err = chat(token, session_a, f"What do these books say about {tech.replace('RAG', '')}? Focus on kinship.", agentic=False)
            ok = st == 200 and ln > 0 and not err
            results["manual"].append({"tech": tech, "ran": picked, "len": ln, "ok": ok, "err": err})
            print(f"  [{'OK ' if ok else 'FAIL'}] {tech:34s} ran={picked or '?':28s} len={ln} {err or ''}", flush=True)

        # ---- SESSION B: automatic router ----
        print(f"\n=== SESSION B (automatic) {session_b} ===", flush=True)
        set_agentic_routing(True)
        for q in AUTO_QUERIES:
            picked, ln, st, err = chat(token, session_b, q, agentic=True)
            ok = st == 200 and ln > 0 and not err
            results["auto"].append({"q": q[:40], "picked": picked, "len": ln, "ok": ok, "err": err})
            print(f"  [{'OK ' if ok else 'FAIL'}] picked={picked or '?':28s} len={ln:5d}  q='{q[:48]}' {err or ''}", flush=True)
    finally:
        restore_settings()

    mok = sum(1 for r in results["manual"] if r["ok"])
    aok = sum(1 for r in results["auto"] if r["ok"])
    picked = sorted({r["picked"] for r in results["auto"] if r["picked"]})
    print("\n=== SUMMARY ===", flush=True)
    print(f"manual: {mok}/{len(results['manual'])} OK · auto: {aok}/{len(results['auto'])} OK", flush=True)
    print(f"auto router picked {len(picked)} distinct techniques: {picked}", flush=True)
    db_proof(session_a, session_b)
    with open("/app/data/api_session_proof.json", "w") as f:
        json.dump({"session_a": session_a, "session_b": session_b, "results": results}, f, indent=2)
    print(f"\nsessions visible in admin chat: A={session_a}  B={session_b}", flush=True)


if __name__ == "__main__":
    main()
