---
title: Scrapalot Improvement Insights — mined from Augmentatism Discord
tags: [scrapalot, rag, knowledge-graph, agents, self-hosting]
source: Discord channels #deep-thinking #automation #hardware-models #showcase-your-porject #systems-theory #resonantos-core #academy #home-lab + #general
captured: 2026-06-20
---

# Scrapalot Improvement Insights

Concrete, actionable ideas harvested from the Augmentatism / ResonantOS community,
mapped onto Scrapalot subsystems. Priority = (impact × fit × evidence).

---

## P1 — High impact, strong fit, concrete

### 1. Pixel-native retrieval branch for tables / scanned docs — **PixelRAG**
- **What:** Search the *rendered page as pixels* with a VLM reader instead of extracting
  text. Reported table evidence recall: text parsers ~5–24% vs pixels ~35%.
- **Scrapalot fit:** Add a **visual-retrieval branch** to the existing RAG router (the
  22-strategy / 4-tier layer) that fires for table-heavy or scanned/OCR docs — attacks the
  weakest spot (Docling tables / RapidOCR).
- **Caveats raised in-thread (important):** pixel-first *loses* hyperlink/entity structure
  (your KG backbone) and only wins ~2–3 pts on plain prose. → complementary router branch,
  **not** a replacement. Keep text+KG path primary; route to pixels only on table/scan signal.
- Repo: https://github.com/StarTrail-org/PixelRAG  (lead: isapenname; analyzed by orbita24)

### 2. Governed memory write pipeline + scheduled "dream cycle" — **BorgOS / TIAMAT**
- **What:** Facts pass a **validation pipeline with confidence tiers** before entering the
  store; a scheduled 3AM "dream cycle" does supersession / promotion / dedup over facts.
- **Scrapalot fit:** Maps directly onto Neo4j **entity dedup + nightly graph housekeeping**
  (recompute weights/fingerprints, merge duplicates). Add **confidence/provenance tiers** to
  entities so the graph distinguishes verified vs low-trust facts; formalize the nightly
  beat as a "supersession/promotion/dedup" pass.
- Repo: https://github.com/hifiguy/BorgOS  (lead: secdude24694023)

### 3. Edge-extraction cost wall — batch / gate before LLM scoring
- **What (warning):** comradekukr measured LLM-based edge extraction at **~30s/candidate**
  → 342 candidates ≈ **3h**. A real cost/time wall for KG building.
- **Scrapalot fit:** For entity/edge extraction, **gate LLM edge scoring behind cheaper
  heuristics** (co-occurrence, embedding similarity threshold) and **batch** candidates.
  Measure cost-per-book; don't LLM-score every pair.

### 4. Provenance layers: "bedrock truth" vs "derived" — Multi-LLM lore engine
- **What:** Separate a **read-only verified layer** ("bedrock truth") from a mutable
  LLM-derived layer; cell-reference RAG. Reported **88–92% token reduction/session** and
  near-zero hallucination on 8M words by separating canonical vs derived.
- **Scrapalot fit:** Tag KG entities/relations with a **trust tier** (extracted-from-source
  vs LLM-inferred). Retrieval and deep-research can prefer bedrock, fall back to derived,
  and cite provenance. Strong hallucination-control lever.  (lead: djvarangian)

---

## P2 — Strong ideas, medium effort or partial overlap

### 5. Tiered model routing by task (local → cloud → frontier)
- **What:** Multiple members converged on **N-tier routing**: tiny model tests/routes
  (1B–3B), mid models do retrieval/chat (7B), big/cloud does "deep thinking" (32B+ →
  private cloud → trusted frontier). Mantra: **"speed on the interface, quality on the deep
  answer"** and **"reliability > smartness."**
- **Scrapalot fit:** Extend agentic routing with a **model-selection policy by task class**
  (extraction/routing/summarize on cheap local SLMs; deep-research synthesis on frontier).
  Already partially present via `gpt-4o-mini` system-provider pattern — make it a tier table.

### 6. ICM markdown-handoff for multi-agent context
- **What:** Persist each agent step as a durable **markdown "context layer" on disk**;
  agents read the compact state file instead of the whole conversation. Plus a **context
  distiller** prompt that rewrites the state between phases.
- **Scrapalot fit:** In deep-research multi-agent orchestration, write per-phase state to
  disk and pass compact layers between agents — cuts tokens and prevents cross-agent context
  contamination. Video: https://youtu.be/956DPSPX4wg · paper: https://arxiv.org/abs/2603.16021

### 7. JIT context / tool router (don't dump everything in context)
- **What:** Amnesia Labs "Brain" retrieves the **right skills/tools/docs only when needed**
  rather than loading all of them. comradekukr also flagged that 100+ skills ship their
  name+summary on *every* turn → big hidden token cost (small local backends drown: ~10k
  tokens of harness boilerplate over a 30-token instruction).
- **Scrapalot fit:** Apply **deferred/lazy tool loading** (the very pattern this MCP uses)
  to the deep-research agent; keep system prompts trimmed when routing to small local
  providers.  (lead: mrjoshpittsburgh; https://amnesia-labs.com/)

### 8. Hybrid retrieval recipe to benchmark against tri-modal fusion
- **What:** BorgOS hybrid RAG = **Qdrant dense + BM25 + RRF**, embeddings **Snowflake
  arctic-embed (1024d)**.
- **Scrapalot fit:** Benchmark scrapalot's tri-modal fusion vs RRF(dense+BM25); evaluate
  **arctic-embed-1024** as an alternative to MiniLM-384 where recall matters (dim/cost tradeoff).

### 9. "Beyond Grep" — lexical + structural + semantic fusion for retrieval
- **What:** Talk (BerlinBuzzwords) arguing reliable large-corpus retrieval needs **combined
  lexical + structural + semantic** context, not any single mode. Independently validates
  the tri-modal fusion thesis.
- **Scrapalot fit:** Mine it for **reranking + context-assembly** ideas — how to weight and
  merge the three modes per query type, and structural (AST/section) signals scrapalot's
  fusion may underuse. Video: https://youtu.be/aD-BHksHgu0  (lead: iceberg_ssj)

### 10. AI "interview spec" intake to structure vague queries
- **What:** An agent that **asks the right clarifying questions** to turn a vague/non-expert
  request into structured input before work starts (seabeepirate).
- **Scrapalot fit:** Add a **query-refinement / intake step** to the deep-research entry
  point — interview the user (or auto-expand) into a structured research spec, improving
  retrieval precision and reducing wasted agent passes.

---

## P3 — Self-hosting & model-selection guidance (for docs + provider presets)

- **Target unified-memory profiles** (Apple Silicon, AMD Strix Halo 128GB), not just
  discrete-GPU VRAM tiers. **Memory bandwidth is the real bottleneck**, not headline VRAM.
- **Tolerate CPU-only / low tok/s**: self-hosters will run small quantized models with no
  GPU. Deep-research/agent loops must not assume a GPU or high throughput.
- **Quant matters for instruction-following**: small/low-bit quants **ignore system-prompt
  directions** (security risk — confirmed by a system-prompt-adherence test). For
  extraction/routing roles, prefer higher-bit quants; **enforce constraints in code, never
  rely on system prompt alone** for security with local/small models.
- **Optimized llama.cpp ≈ 2× turnkey** (jemalloc, MoE/MTP build flags) — e.g. Qwen3 35B-A3B
  ~14 tok/s, Gemma 4 E4B ~40 tok/s on old hardware. Recommend over Ollama/Studio wrappers.
- **Small fine-tuned domain models are viable on-device** (sub-1GB can tool-call after
  post-training) — candidate: ship a fine-tuned local model for one narrow job (entity
  extraction or query routing). Talk: https://youtu.be/fLUtUkqYHnQ (Maxime Labonne / LFM2.5).
- **Model picker reference:** https://artificialanalysis.ai/models (quality/price/speed/
  latency/context) — useful when populating `model_providers`.
- **Eval-driven pipeline iteration:** gate each pipeline version on an explicit eval before
  extending; rewrite a stage rather than compounding debt (matches scrapalot rule #5).
- **Offline KG appliance packaging:** a Docker image that serves a self-contained KG + API
  on localhost with no internet — aligns with scrapalot's self-host goal; make ingest
  deterministic/repeatable.
- **CPU-only ternary (BitNet-style) tier:** train in large RAM, run inference CPU-only via an
  AVX/SSE translation layer — a viable low-resource path for GPU-less self-hosters (could back
  a cheap embedding/routing tier).  (lead: tomepenn1046)
- **Human-in-the-loop verification over raw codegen speed** (Addy Osmani / Google Cloud talk):
  compiler + tests as the trust loop. Reinforces an eval/verification gate on scrapalot's RAG
  and graph outputs. https://www.youtube.com/watch?v=jYvNSLQ_Qio
- **Chrome DevTools MCP** for agent-driven UI review (screenshots, drive live UI) — dev/test
  tooling that complements scrapalot's "Chrome first, Playwright second" rule.
  https://github.com/ChromeDevTools/chrome-devtools-mcp  (lead: zadok7.eth)
- **All-in-one self-host ceiling:** DGX Station-class desktops (e.g. ASUS ExpertCenter Pro
  ET900N G3) and DGX Spark mini-boxes can host the full stack (Neo4j + pgvector + local LLM +
  OCR GPU) on one node; memory capacity is the binding constraint when co-locating models.

---

## From Slava Fill's talk — "Scalable AI Agents" (2026-06-19)

Full notes: `slava-scalable-agents-talk.md`. Tool names are ASR-approximate — verify repos.

- **S1 (P1) — Compress orchestration JSON envelopes.** A "Headroom"-style input-compression
  pass on the JSON/log payloads flowing between agents (and over gRPC) cut Slava's tokens
  **~34% measured** (50–90% claimed). **Scrapalot fit:** compress deep-research agent
  envelopes + gRPC request/response bodies and streaming packets; compress *inputs/data
  flows*, not final outputs. Concrete, measurable, low-risk.
- **S2 (P1) — Multi-graph query with iterative verification.** Agents query the KG instead of
  re-scanning source; a "Retriever-LM"-style wrapper queries **multiple graphs** and
  **re-verifies uncertain results against alternative sources**. **Scrapalot fit:** add a
  cross-source verification pass to Neo4j RAG for accuracy-critical queries (deep-research),
  trading latency for correctness ("infinite context when accuracy > speed").
- **S3 (P2) — Incremental doc-change re-graphing.** Static reference docs → one graph;
  frequently-changing docs → a "live" graph with **incremental change detection** (only
  re-graph what changed). **Scrapalot fit:** make the reprocess pipeline diff-aware — re-embed
  / re-extract only changed chunks/sections instead of whole-document rebuilds.
- **S4 (P2) — Role-scoped skills with verification steps.** Skills = deterministic fn + KG
  query + verification; each agent gets **only the skills it needs** (scraper can't touch DB).
  **Scrapalot fit:** scope deep-research sub-agent tool access per role — security + fewer
  tokens. Pairs with the JIT tool-loading idea (#7).
- **S5 (P3) — Workflow checkpoints for long runs.** LangGraph-style state checkpoints to
  recover from crashes and reuse tokens. **Scrapalot fit:** checkpoint the deep-research
  5-phase orchestration (and Celery long jobs) so an interruption resumes mid-phase.
- **S6 (research) — Atomic hypergraph / OpenCog AtomSpace.** Multi-dimensional knowledge with
  distance metrics between "atoms"; query from multiple perspectives. **Scrapalot fit:**
  speculative direction for the KG beyond entity/relation triples. (User is already exploring
  "Atomspace Metagraph Integration".)

---

## From repo deep-reads (2026-06-20)

Full detail: `repo-deep-reads.md`. **Convergence signal:** four independent sources (BorgOS,
ResonantOS, Arcanum, Prompt-nomicon) all land on the same meta-pattern — **provenance +
confidence tiering on KG facts/claims, with review-gated promotion and contradiction
preservation instead of silent overwrite.** That convergence makes the KG-trust theme the
single most-supported direction in this whole harvest.

### Theme A — KG provenance & confidence tiering (strongly converged)
- **R1 (P1) — Confidence tiers on entities/relations.** `hypothesis | experimental | verified`
  driven by **distinct-Book provenance count** (1 book = hypothesis, ≥2 independent = experimental,
  curated = verified). Gives reranking a trust signal; upgrades `SHARED_ENTITY`/`CO_OCCURS_WITH`
  weighting. (BorgOS tiers + ResonantOS trust-tiers + Prompt-nomicon evidence rubric.)
- **R2 (P1) — 3-zone dedup gate** in nightly housekeeping: cosine **>0.92 auto-merge**,
  **0.85–0.92 flag-for-review (do NOT auto-merge)**, **<0.85 distinct**. Prevents over-merging
  distinct entities (e.g. "Mercury" planet vs element). Replaces today's binary dedup. (BorgOS)
- **R3 (P2) — Bitemporal supersession, not delete.** On contradicting newer facts, close
  `valid_to` + append new; a conflict pass surfaces contradictions to the Admin Inspector
  instead of auto-resolving. Append-only provenance. (BorgOS + ResonantOS contradiction notes)
- **R4 (P2) — Review-gated KG writes + structure-validated synthesis writer.** Extracted facts
  land in an INTAKE tier; a verified promote-path writes trusted nodes; duplicate-candidate
  flagging not silent merge; required-sections + deterministic fallback on AI-generated pages.
  (ResonantOS LLM-Wiki)

### Theme B — Deep-research orchestration hardening
- **R5 (P1) — Dispatch-spec / run-manifest before fan-out.** Materialize a validated plan:
  `dispatch_id`, per-agent `{role, concern, central_question, exclusions, input_source}`,
  `join_policy`, and a **subagent lifecycle ledger that forbids reporting "done" while any child
  is pending/abandoned**. Add `dispatch_id`/`parent_dispatch_id` to streaming packets to group
  siblings and report whole-fan-out success. *Highest-leverage, lowest-risk import.* (Arcanum)
- **R6 (P1) — Structured source-linked compaction** for `deep_research_orchestrator`: raw
  transcript (append-only, recoverable) + compact-state block + **decision ledger with
  `sourceMessageIds`**, instead of prose-summary accumulation. Auditable & reversible. (ResonantOS ADR-016)
- **R7 (P2) — Evidence-or-it-didn't-happen agent contract.** Every finding cites a concrete
  source (chunk id / Neo4j node); synthesis emits **tensions (contradictions), not summaries**;
  source-kind taxonomy `primary | inferred | analogy | open-residue` blocks promoting an
  inferred/analogy claim into the KG. (Arcanum robot-talks/research-tower + Prompt-nomicon)
- **R8 (P2) — Strategy-preview + permission gate** before the expensive multi-agent phase:
  emit a "run strategy proposal" packet (planned agents, why each, cost) and gate on confirm. (Arcanum refine)
- **R9 (P2) — LLM-as-next-action-proposer loop:** model proposes ONE strict-JSON action → host
  validates against a whitelist → execute → **verify state changed (else stop/re-target)** → cap
  iterations → deterministic fallback. Prevents agent ping-pong. (ResonantOS)

### Theme C — Provider routing & guards
- **R10 (P1) — Workload-keyed provider routing.** Named workloads (`deep_research_synthesis`,
  `entity_extraction`, `kg_write`, `chat`, `recovery`) each with ordered fallback chain +
  **cost posture** + **`hard_stop` for quality-sensitive writes** (KG promotion refuses rather
  than use a weak model) + **local emergency floor**. Maps onto `model_providers` tables; make it
  user-editable. (ResonantOS provider fabric)
- **R11 (P1) — Merge-storm / volume guard** on housekeeping recomputes: if a pass would
  merge/delete > N nodes, **abort and surface for operator review**. Cheap safety rail; aligns
  with CLAUDE.md gotcha #12. (BorgOS anomaly detectors)
- **R12 (P3) — Corpus health grade A/B/C/D** nightly (orphan ratio, dedup backlog, embedding
  coverage, low-confidence fraction) on the Admin Inspector. (BorgOS)

### Theme D — Retrieval
- **R13 (P2, refines #1) — Pixel/visual retrieval as a 4th fusion signal.** PyMuPDF
  `page.get_pixmap()` rasterize (near-free, no Chromium) → **1024px strip chunks** → VL-embed
  (dim 2048, separate pgvector column) → route only on table/scan/low-confidence signal → plug
  into existing reranker. Win is narrow (NQ-Tables +~5 EM; plain text = wash) and GPU-VL-embedder
  is the cost → **opt-in per-collection**. (PixelRAG)
- **R14 (P2) — Anti-hallucination grounding contract** in RAG-answer / entity-extraction system
  prompts: cite chunk/entity per claim; "if not in retrieved context, say not found, never
  invent"; red-flag phrase list. Low effort. (Prompt-nomicon)

---

## Leads to study (repos & resources)

| Lead | URL | Why |
|---|---|---|
| PixelRAG | https://github.com/StarTrail-org/PixelRAG | P1 — visual retrieval for tables/scans |
| BorgOS / TIAMAT | https://github.com/hifiguy/BorgOS | P1 — governed memory + dream cycles |
| Arcanum (Sigils) | https://github.com/cyberAlchemyAI/Arcanum | Modular agent-capability patterns; mogt multi-agent research subdir |
| The-Prompt-nomicon | https://github.com/Resonant-Jones/The-Prompt-nomicon | Agent workflow / orchestration prompt vault |
| LLMs-local (awesome) | https://github.com/0xSojalSec/LLMs-local | Catalog of local-LLM tools/platforms |
| FedHarv | https://github.com/pvcalarco/FedHarv | DSpace scholarly harvester (connector ideas) |
| Amnesia Labs | https://amnesia-labs.com/ | JIT context/tool router |
| GLM-5.2 | https://z.ai/blog/glm-5.2 | Frontier open-weight memory reality check |
| NeMo fine-tune (Spark) | https://build.nvidia.com/spark/nemo-fine-tune/overview | Local fine-tuning path |
| ICM video / paper | https://youtu.be/956DPSPX4wg · https://arxiv.org/abs/2603.16021 | Markdown-handoff multi-agent context |
| Maxime Labonne talk | https://youtu.be/fLUtUkqYHnQ | Training small tool-calling models |
| ResonantOS archive | https://www.youtube.com/@ResonantOS | Full call recordings (incl. Slava's KG/compression talk) |
| Appen SubQ benchmark | https://www.appen.com/whitepapers/subquadratic-preview-model-benchmark-evaluation | Long-context retrieval eval |
| Beadwork (talk) | https://www.youtube.com/live/UmB_uz7nTvs | Filesystem-native git-backed knowledge data-model |
| Beyond Grep (talk) | https://youtu.be/aD-BHksHgu0 | P2 — lexical+structural+semantic retrieval fusion |
| Chrome DevTools MCP | https://github.com/ChromeDevTools/chrome-devtools-mcp | Agent-driven UI review tooling |
| ResonantOS 2.0.0-alpha | https://github.com/ResonantOS/2.0.0-alpha | Browser-first agentic OS; PR #166 pluggable local STT (Whisper/Parakeet) |
| LightRAG | (verify repo) | S2/S3 — KG generation from MD/code, incremental change detection |
| LangGraph | https://github.com/langchain-ai/langgraph | S5 — workflow checkpointing / state recovery |
| OpenCog AtomSpace | https://github.com/opencog/atomspace | S6 — hypergraph knowledge representation |
| Slava talk (doc) | https://docs.google.com/document/d/1wybOz_ondg3uVSAXEnhls6QiDn5gV30LZkfUA7OJ9I0 | S1–S6 source: summary + transcript |

---

## Channel coverage status

| Channel | Status |
|---|---|
| #general (Community Channels, 1423225703637323830) | ✅ harvested |
| #deep-thinking | ✅ harvested |
| #automation | ✅ harvested |
| #hardware-models | ✅ harvested |
| #showcase-your-porject (forum) | ✅ harvested (incl. scrapalot's own thread by orbita24) |
| #systems-theory-and-cybernetics | ✅ harvested (sparse) |
| #weekly-call-info-and-links | ✅ harvested (logistics only; substance is in YT archive) |
| #resonantos-core | ✅ harvested |
| #academy | ✅ harvested (sparse; meeting recordings) |
| #home-lab | ✅ harvested (sparse; hardware chatter) |
| #general (main, 1486772913171468378) | ⛔ 403 Missing Access |
| #fleet-compute-networking | ⛔ 403 Missing Access |
| #resonantos / #dao | ⏳ not yet harvested |

> Next harvest candidates: #resonantos, #dao, and mining the **ResonantOS YouTube archive**
> (@ResonantOS) + the linked Google-Doc meeting notes for Slava's (fili_s) KG +
> token-compression talk — the single richest scrapalot-relevant source, not on Discord.
