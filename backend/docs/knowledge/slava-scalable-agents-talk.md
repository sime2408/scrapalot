---
title: "Slava Fill — The Architecture Behind Scalable AI Agents (talk notes)"
tags: [scrapalot, knowledge-graph, token-compression, agents, rag, lightrag]
source: ResonantOS Archive — YouTube
  (full: https://youtu.be/JiVPm-Q5NVs · edited: https://youtu.be/chgBtvnCBB0)
  summary+transcript doc: https://docs.google.com/document/d/1wybOz_ondg3uVSAXEnhls6QiDn5gV30LZkfUA7OJ9I0
captured: 2026-06-20
reliability: NAMES FROM ASR TRANSCRIPT — approximate; verify exact repos/libs before adopting.
---

# Slava Fill — "The Architecture Behind Scalable AI Agents"

Senior data engineer's end-to-end system for AI-driven data projects. Core thesis:
**organize documentation and architectural guardrails before coding**; drive token cost
down to ~10% via compression + knowledge graphs + local processing while keeping accuracy.

> ⚠️ Tool/library names below come from an auto-generated transcript and are approximate.
> Verify the exact repo before relying on any of them. "Headroom" here is a JSON-compression
> library — **not** the (unrelated) Claude Code proxy of the same name.

## 1. Input-envelope token compression — "Headroom"-style
- A compression library (GitHub) that strips redundant noise from **JSON envelopes and logs**
  used in agent orchestration — compresses *inputs*, not model outputs.
- Claimed **50–90% input token reduction** at ~100% accuracy; Slava's **measured ~34%** in
  real workflows. Rolled out selectively, then system-wide once proven.
- Most effective on JSON-heavy payloads (agent requests + returned data).

## 2. Knowledge graphs for code/architecture understanding — LightRAG + Retriever-LM
- Map dependencies, data models, and architectural decisions into graphs so **agents query
  the graph instead of re-scanning raw code** (which is token-heavy and loses context as the
  codebase grows).
- **Retriever-LM wrapper**: orchestrates queries across **multiple knowledge graphs** and
  **iteratively verifies uncertain results** by querying alternative sources → "infinite
  context" when accuracy matters more than speed (e.g. post-merge architectural review).
- Graph types used: task graphs, ML-workflow graphs, web-extraction schemas, DB-schema graphs.

## 3. AI documentation management
- **Architecture as a "driving document"**: start simple, grow as the project evolves; the
  doc becomes an index that **splits into sub-documents** as complexity rises. Agents load
  only the docs relevant to their **role**, avoiding redundant context.
- **Markdown for humans, knowledge graphs for AI retrieval.** Chunked docs drift inconsistent
  → Retriever-LM cross-validates.
- **Static vs live split:** LightRAG for static reference (architecture, data models);
  "LiveWiki" for frequently-changing docs, with **incremental change detection** (only
  re-graph what changed).

## 4. Agent orchestration & memory
- **Skills = deterministic functions + injected code queries + knowledge-graph lookups**,
  with verification steps. Agents get access **only to the specific skills they need**
  (e.g. scraper agents can't touch databases) → security + token efficiency.
- **Workflow checkpoints (LangGraph-inspired)**: save state at nodes, recover from crashes,
  reuse tokens on interruption.
- **Memory:** session-specific harness memory is unpredictable across sessions; plan to
  **normalize memory across harnesses (Cloud Code / Hermes / Codex) into a shared vector DB**
  (prompt MD memory + SQL memory → growing skills).
- **Atomic hypergraph (experimental):** multi-dimensional knowledge with distance metrics
  between "atoms"; query from multiple perspectives; graph dissolves post-query.
  (Cf. OpenCog AtomSpace — worth a look.)

## 5. Hybrid local/cloud
- **Local (16GB RAM):** graph engines (LightRAG/LiveWiki), compilation, simpler ML, local
  Ollama for deterministic tasks. **Cloud:** frontier models (Opus, GLM-5.2) for heavy
  orchestration/planning. Extract memory regularly to avoid vendor lock-in.

## Tools mentioned (verify names)
LightRAG · "LiveWiki" · "Retriever-LM wrapper" · "Headroom" (JSON compression) · LangGraph ·
Hermes (harness, SQL memory) · Ollama · DBT (lineage inspiration) · IPFS (community
suggestion) · OpenCog AtomSpace (implied by "atomic hypergraph").

## Slava's philosophy
> "The harness you build is more important than chasing the latest model. Build predictable,
> controllable systems; use cheaper/local models where possible; gradually shift from cloud
> to sovereign infrastructure."

→ Actionable items routed into `improvement-insights.md` (section "From Slava's talk").
