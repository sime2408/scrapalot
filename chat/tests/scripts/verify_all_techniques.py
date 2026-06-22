"""Operator verification harness: exercise EVERY RAG strategy + orchestrator in
BOTH execution modes against a real collection, and emit a report.

- MANUAL mode  → `strategy.process_chat_request()` (exactly what Engine A runs
  when the user picks a strategy with use_agentic_routing=false).
- AGENTIC mode → `create_rag_agent(strategy_preset=get_strategy_preset(T))` +
  `agent.run()` (exactly the Engine B tool-agent, configured for technique T).

Real DB, real pgvector retrieval, real system LLM (Scrapalot AI / gpt-4o-mini).
No mocks. Writes incremental JSON so a crash mid-run keeps partial results.

Usage (inside the container):
    docker exec scrapalot-chat python scripts/verify_all_techniques.py
    docker exec scrapalot-chat python scripts/verify_all_techniques.py --only manual
    docker exec scrapalot-chat python scripts/verify_all_techniques.py --techniques RAGHyDE,RAGGraphSearch
"""

import argparse
import asyncio
import json
import time
import traceback
from uuid import UUID

# Real target: admin's "anthropology" collection (127k chunks).
COLLECTION_ID = "5eeec701-511d-4f85-b8b5-6cbcd64e4467"
WORKSPACE_ID = "0ebf2e09-7198-4b7a-a100-87b6dc969387"
USER_ID = "ad93054b-635b-47b0-b6f4-7c7e06989c4c"

# A topical question with real signal in the anthropology corpus.
QUERY = "What do these books say about kinship systems and social structure in early human societies?"

PER_CELL_TIMEOUT_S = 300
OUT_JSON = "/app/data/technique_verification.json"
OUT_MD = "/app/data/technique_verification_report.md"


def _scan_packets(raw_chunks: list[str]) -> tuple[int, int, str | None]:
    """Return (answer_len, n_packets, first_error) from yielded packet strings."""
    answer_len = 0
    first_error = None
    n = 0
    for chunk in raw_chunks:
        if not isinstance(chunk, str):
            continue
        n += 1
        # tolerant parse — packets are NDJSON, sometimes multiple per yield
        for line in chunk.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                pkt = json.loads(line)
            except Exception:
                continue
            obj = pkt.get("obj", pkt) if isinstance(pkt, dict) else {}
            ptype = obj.get("type", "")
            if ptype in ("message_delta", "message_start"):
                answer_len += len(str(obj.get("content") or obj.get("text") or ""))
            elif "error" in ptype.lower():
                if first_error is None:
                    first_error = str(obj.get("message") or obj.get("content") or ptype)[:200]
    return answer_len, n, first_error


async def run_manual(technique: str, retriever_obj, manual_llm, db) -> dict:
    import inspect

    from src.main.dto.chat import ChatRequest
    from src.main.service.streaming.packet_emitter import PacketEmitter
    from src.main.utils.rag.strategies import get_rag_strategy_class

    cls = get_rag_strategy_class(technique)
    if cls is None:
        return {"mode": "manual", "technique": technique, "ok": False, "error": "unknown class"}
    # Build the strategy EXACTLY like Engine A / GenerateRAG does: a LangChain
    # request_llm (has .with_structured_output / LCEL), a packet_emitter, and
    # conditional neo4j_service / db_session by constructor signature.
    kwargs = dict(retriever=retriever_obj, llm=manual_llm, packet_emitter=PacketEmitter())
    params = inspect.signature(cls.__init__).parameters
    if "neo4j_service" in params:
        from src.main.service.graph.neo4j_service import get_neo4j_service

        kwargs["neo4j_service"] = get_neo4j_service()
    if "db_session" in params:
        kwargs["db_session"] = db
    strategy = cls(**kwargs)
    request = ChatRequest(
        prompt=QUERY,
        user_id=USER_ID,
        workspace_id=UUID(WORKSPACE_ID),
        collection_ids=[UUID(COLLECTION_ID)],
        session_id=f"verify-manual:{technique}",
        model_name="gpt-4o-mini",
        provider_type="openai",
    )
    raw: list[str] = []
    start = time.monotonic()
    try:
        async for chunk in strategy.process_chat_request(request):
            raw.append(chunk)
    except Exception as e:
        return {
            "mode": "manual",
            "technique": technique,
            "ok": False,
            "error": f"{type(e).__name__}: {e}"[:300],
            "traceback": traceback.format_exc()[-600:],
            "latency_ms": int((time.monotonic() - start) * 1000),
        }
    answer_len, n_pkts, first_err = _scan_packets(raw)
    return {
        "mode": "manual",
        "technique": technique,
        "ok": first_err is None and answer_len > 0,
        "answer_len": answer_len,
        "n_packets": n_pkts,
        "error": first_err,
        "latency_ms": int((time.monotonic() - start) * 1000),
    }


async def run_agentic(technique: str, retriever_obj, llm, model_string, db) -> dict:
    from src.main.service.agents.rag_agents.tool_based_rag_agent import create_rag_agent
    from src.main.service.agents.tools.base import RAGToolDependencies
    from src.main.service.rag.strategy_presets import get_strategy_preset
    from src.main.service.streaming.packet_emitter import PacketEmitter

    preset = get_strategy_preset(technique)
    start = time.monotonic()
    try:
        agent = create_rag_agent(
            model=model_string,
            query=QUERY,
            collection_ids=[UUID(COLLECTION_ID)],
            db=db,
            user_id=USER_ID,
            strategy_preset=preset,
        )
        deps = RAGToolDependencies(
            retriever=retriever_obj,
            llm=llm,
            collection_ids=[UUID(COLLECTION_ID)],
            user_id=USER_ID,
            db=db,
            workspace_id=WORKSPACE_ID,
            emitter=PacketEmitter(),
            retrieved_documents=[],
        )
        result = await agent.run(QUERY, deps=deps)
        answer = str(getattr(result, "output", "") or "")
        return {
            "mode": "agentic",
            "technique": technique,
            "ok": len(answer) > 0,
            "answer_len": len(answer),
            "n_retrieved": len(deps.retrieved_documents),
            "tool_categories": preset.get("tool_categories"),
            "error": None,
            "latency_ms": int((time.monotonic() - start) * 1000),
        }
    except Exception as e:
        return {
            "mode": "agentic",
            "technique": technique,
            "ok": False,
            "error": f"{type(e).__name__}: {e}"[:300],
            "traceback": traceback.format_exc()[-600:],
            "latency_ms": int((time.monotonic() - start) * 1000),
        }


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", choices=["manual", "agentic"], default=None)
    parser.add_argument("--techniques", default=None, help="comma list; default = all 30")
    args = parser.parse_args()

    from src.main.config.database import SessionLocal
    from src.main.service.retriever.retriever_manager import retriever_manager
    from src.main.utils.llm.agent_model_utils import get_system_agent_model
    from src.main.utils.rag.strategies import RAG_STRATEGY_CLASSES

    techniques = [t.strip() for t in args.techniques.split(",")] if args.techniques else sorted(RAG_STRATEGY_CLASSES.keys())

    # RetrieverManager must be initialized (startup does this) or get_retriever
    # returns None and every cell silently falls back to web/LLM (no real retrieval).
    from src.main.utils.config.loader import resolved_config, resolved_secrets

    await retriever_manager.initialize(resolved_config, resolved_secrets)
    retriever_obj = await retriever_manager.get_retriever(user_id=USER_ID, retriever_type="pgvector")
    if retriever_obj is None:
        raise RuntimeError("get_retriever returned None even after initialize()")
    agent_config = get_system_agent_model(agent_type="agentic_rag")
    llm = agent_config.get_pydantic_ai_model()
    model_string = agent_config.get_pydantic_ai_model_string()
    db = SessionLocal()

    # --- Reproduce the bits of app startup the engines expect ---------------
    # 1) Agentic create_rag_agent builds a bare "openai:..." model that reads
    #    OPENAI_API_KEY from env; production injects the system provider key.
    import os

    sys_key = getattr(agent_config, "api_key", None)
    sys_provider = (getattr(agent_config, "provider_type", "") or "openai").upper()
    if sys_key:
        # Bare "provider:model" strings make pydantic-ai read <PROVIDER>_API_KEY
        # from the environment (e.g. DEEPSEEK_API_KEY). Set the one that matches
        # the configured system provider, plus an OpenAI fallback.
        os.environ.setdefault(f"{sys_provider}_API_KEY", sys_key)
        os.environ.setdefault("OPENAI_API_KEY", sys_key)
    # 2) Manual process_chat_request resolves the generation LLM via
    #    app.state.llm_manager (set in startup/initialization.py); wire the
    #    same singleton here.
    from src.main.service.llm.llm_manager import llm_manager as _llm_mgr

    try:
        from src.main.app_instance import get_app

        get_app().state.llm_manager = _llm_mgr
    except Exception as e:
        print(f"WARN: could not wire llm_manager ({e}); manual cells may fail", flush=True)
    # 3) Manual strategies need a LangChain request_llm (with .with_structured_output /
    #    LCEL), exactly like GenerateRAG builds via llm_manager.get_llm — NOT the
    #    pydantic-ai model. Passing the wrong type was the cause of the manual failures.
    manual_llm = await _llm_mgr.get_llm(
        model_name=agent_config.model_name,
        provider_type="system",
        enable_metrics=False,
        subscription_tier="researcher",
        db=db,
        user_id=USER_ID,
    )

    print(f"Verifying {len(techniques)} techniques x modes against collection {COLLECTION_ID}", flush=True)
    print(f"Model: {model_string} | manual_llm: {type(manual_llm).__name__}", flush=True)

    # Merge into any existing results so batched runs (memory-bounded) accumulate.
    by_key: dict[tuple, dict] = {}
    try:
        with open(OUT_JSON) as f:
            for r in json.load(f):
                by_key[(r["mode"], r["technique"])] = r
    except Exception:
        pass

    modes = [args.only] if args.only else ["manual", "agentic"]
    for technique in techniques:
        for mode in modes:
            label = f"{mode:8s} {technique}"
            try:
                if mode == "manual":
                    res = await asyncio.wait_for(run_manual(technique, retriever_obj, manual_llm, db), timeout=PER_CELL_TIMEOUT_S)
                else:
                    res = await asyncio.wait_for(run_agentic(technique, retriever_obj, llm, model_string, db), timeout=PER_CELL_TIMEOUT_S)
            except TimeoutError:
                res = {"mode": mode, "technique": technique, "ok": False, "error": f"timeout >{PER_CELL_TIMEOUT_S}s"}
            except Exception as e:
                res = {"mode": mode, "technique": technique, "ok": False, "error": f"harness: {type(e).__name__}: {e}"[:200]}
            by_key[(mode, technique)] = res
            flag = "OK " if res.get("ok") else "FAIL"
            print(
                f"  [{flag}] {label:42s} len={res.get('answer_len', '-')} ret={res.get('n_retrieved', '-')} {res.get('latency_ms', '-')}ms {res.get('error') or ''}",
                flush=True,
            )
            with open(OUT_JSON, "w") as f:
                json.dump(list(by_key.values()), f, indent=2)

    results = list(by_key.values())
    _write_markdown(results, model_string)
    db.close()
    n_ok = sum(1 for r in results if r.get("ok"))
    print(f"\nDONE: {n_ok}/{len(results)} cells OK. Report: {OUT_MD}", flush=True)


def _write_markdown(results: list[dict], model_string: str):
    by_t: dict[str, dict] = {}
    for r in results:
        by_t.setdefault(r["technique"], {})[r["mode"]] = r
    lines = [
        "# RAG technique verification — manual vs agentic",
        "",
        f"Collection `{COLLECTION_ID}` · model `{model_string}` · query: _{QUERY}_",
        "",
        "| Technique | Manual | Manual ms | Agentic | Agentic ms | Notes |",
        "|---|---|---|---|---|---|",
    ]
    for t in sorted(by_t.keys()):
        m = by_t[t].get("manual", {})
        a = by_t[t].get("agentic", {})
        mflag = "✅" if m.get("ok") else "❌"
        aflag = "✅" if a.get("ok") else "❌"
        note = " ".join(
            filter(
                None,
                [
                    f"manual: {m.get('error')}" if m.get("error") else "",
                    f"agentic: {a.get('error')}" if a.get("error") else "",
                ],
            )
        )[:160]
        lines.append(f"| {t} | {mflag} | {m.get('latency_ms', '-')} | {aflag} | {a.get('latency_ms', '-')} | {note} |")
    n_ok = sum(1 for r in results if r.get("ok"))
    lines += ["", f"**{n_ok}/{len(results)} cells OK.**"]
    with open(OUT_MD, "w") as f:
        f.write("\n".join(lines))


if __name__ == "__main__":
    asyncio.run(main())
