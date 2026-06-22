---
title: Repo deep-reads — techniques mined for scrapalot
tags: [scrapalot, rag, knowledge-graph, agents, provenance, routing]
source: deep-read of GitHub repos surfaced by the Augmentatism community
captured: 2026-06-20
---

# Repo deep-reads

Detailed technical notes from deep-reading the high-value repos. Actionable items routed
into `improvement-insights.md` (R-series). Specifics (numbers, schemas) preserved here.

---

## PixelRAG (`StarTrail-org/PixelRAG`, 534★, Apache-2.0, Berkeley SkyLab)

**Thesis:** retrieve documents by how they *look*, not their parsed text. Wins on
tables/charts/scanned/layout; wash on plain text.

**Pipeline (render → chunk → embed → index → serve → read):**
- Render page → image tiles. (Web uses Chromium-CDP; **for scrapalot ignore that — PDFs
  rasterize near-free via PyMuPDF `page.get_pixmap()` / poppler @ dpi 200**.)
- **Chunk:** slice tall tiles into **1024px strips** (`CHUNK_HEIGHT=1024`, drop <28px tails).
  Cuts visual tokens ~8× vs full tiles — this is what makes embedding affordable.
- **Embed:** each strip → 1 vector via `Qwen3-VL-Embedding-2B` (GPU VL model), last-token+L2,
  **dim 2048**, float16.
- **Index:** FAISS `IndexIVFFlat` (nlist 8192 / nprobe 128), dedup on `(article,tile,chunk)`.
- **Serve:** `/search` accepts **text OR image OR embedding** query (true multimodal). No
  reranker — raw FAISS cosine + over-fetch(`k*5–10`)+filter (`min_tile_height` drops blank
  strips, `articles_only` regex drops TOC/meta pages).
- **Read:** winning page-image PNGs fed to a VL reader (`Qwen3-VL-4B`), reads answer off image.

**Numbers (LLM-judge):** SimpleQA pixel-LoRA top3 **77.9%** vs text-parser **70.2%**;
**NQ-Tables EM 0.275 vs 0.227 (+~5 pts — the headline)**; plain NQ ≈ wash; TriviaQA saturated.
Query embed ~42ms/GPU. Cost: indexes 5–10× larger than text (Wikipedia 215GB FAISS + 5.6TB PNG).

**For scrapalot:** add visual retrieval as a **4th fusion signal**, opt-in per-collection,
routed only on table/scan/low-confidence-quantitative signal. pgvector holds dim-2048 image
vectors next to dim-384 MiniLM text. Reuse PyMuPDF raster + 1024px strips; plug into the
**existing** reranker (don't copy their no-rerank design). GPU VL embedder is the real cost.

---

## BorgOS (`hifiguy/BorgOS`) — **DESIGN SPEC, no code** (mine the numbers)

Spec-only repo (README + architecture.md + api.md). No implementation. But the thresholds
are concrete and that's the value.

**Governed memory write (12-stage, cheap-reject-first):** auth → rate-limit → sanitize →
self-ref tag → embed → L4 shadow-reject → **dedup gate** → confidence validate → anti-launder
→ anomaly score → bitemporal assemble → **dual write Postgres-first then vector**.
Outcomes: ADD / MERGE / SKIP / REJECT.

**Dedup gate (the gold):** cosine **>0.92 → SKIP/auto-merge**, **0.85–0.92 → MERGE-review**,
**<0.85 → ADD distinct**.

**Confidence tiers (monotonic — rise only via external validation):**
- `hypothesis` 0.0–0.49 (default) · `experimental` 0.5–0.79 (needs `derived_from` a *different*
  source) · `verified` 0.8–1.0 (operator/multi-source consensus). Self-referential capped at
  hypothesis. Content-type decay: identity 365d / observation 30d / transient 7d.

**Dream cycle (nightly systemd timer, 7 passes):** vitality decay → dedup-merge → archive stale
→ L3→L2 promotion (quality-gated: length-ratio, entity-preservation, semantic-fidelity, with
rollback snapshot) → **conflict detection (operator-mediated, not auto)** → health grade A/B/C/D
→ snapshot cleanup.

**Hybrid retrieval:** Qdrant BM25+dense, `arctic-embed-l-v2.0` (1024d), `composite_score` =
similarity × confidence × vitality × layer-precedence; intent-classified routing (factual→
verified-first, causal→provenance traversal, exploratory→low-threshold). RRF weights NOT public.

**For scrapalot:** adopt **dedup zones, confidence tiers (driven by distinct-Book provenance
count), merge-storm guard, bitemporal supersession**. Skip the multi-agent-adversarial machinery
(per-agent keys, 3-hop laundering, identity-injection) — scrapalot is single-tenant trusted
ingestion. Don't swap embeddings to 1024d (prod is 384d MiniLM — dims must match existing data).

---

## Arcanum (`cyberAlchemyAI/Arcanum`, 15★) — spec framework, not code

~5,300 markdown/YAML "Sigil" capability-contracts. Value = the orchestration patterns.

**Sigil = capability contract** (not a prompt): `objective / applicability / non-applicability /
inputs / process / quality-bar / anti-patterns / output-contract`. Three tiers by autonomy:
Formulae (deterministic) · Transmutations (bounded synthesis) · Arcana (sovereign orchestration).

**`dispatch-spec` (most transferable):** a machine-validatable run-manifest produced *before*
any fan-out. Fields: `dispatch_id`, `intent{raw,objective}`, `mode`, `steps[]`, `gates`,
`observability`. Step `pattern ∈ {sequential, fanout, dialectic, tournament, distill, xray,
validation, synthesis, handoff}`. Validation rules worth stealing: non-first step **must name an
input source**; any `parallel` step **must declare a `join_policy`**; tournament/dialectic **must
declare roles + convergence criteria**; a step with no input/output/parent is an **orphan →
invalid**. **Subagent lifecycle ledger:** every spawned agent must reach terminal `join_status`
+ `close_status`; a parent **cannot report `pass` while any sibling is pending/abandoned**.
`dispatch_id`/`parent_dispatch_id` link siblings → telemetry asks "did the whole fan-out
succeed?", not just per-agent.

**`robot-talks` (multi-agent investigation):** decompose **by concern, not by file**; each agent
returns Key Findings (**each with file+line evidence** — "a finding without evidence is
speculation"), Gaps, Tensions, Questions. Synthesis surfaces **tensions (A says X, B says NOT-X),
never summaries**. Human gate before action.

**`distill`/`refine`:** bounded tournament modes with **cycle-guards** (stop when a round adds
terminology but no new structure); Proposer/Balancer dual-role (generate vs adversarially object).
`refine` emits a validated dispatch-spec + a "Run Strategy Proposal" and **stops for permission
before spawning**. `research-tower`: source-kind taxonomy `primary | related | local-inference |
analogy | operator-reading | open-residue` — every claim labelled; analogies can't become source
claims; subagent-closeout ledger.

**For scrapalot:** lift the **shape** (validated plan + join policy + lifecycle ledger +
cited-evidence rule + source-kind taxonomy), not the bureaucracy. Their own
`AGENT-FRAMEWORK-IMPROVEMENTS.md` says: import ONE small thing first (link siblings by
`dispatch_id`) with a kill criterion.

---

## ResonantOS (`ResonantOS/2.0.0-alpha`, branch `dev`) — real implementation

Browser-first agentic OS (~52k TS / 29k Rust / 34k Node ESM, 84 docs). Skip the browser-OS
framing; three patterns are genuinely implemented and portable.

**1. Workload-keyed provider routing (`provider-fabric-core.mjs`) — strongest lift.** Three
tables: `providerProfiles`, `modelCatalog` (model → runtime cloud|local, costTier, qualityTier),
`defaultRoutingStrategies`. **Routing is per-WORKLOAD, not per-request.** Each named workload
(`augmentor-chat`, `agent-control`, `archive-ingest`, `routine-delegation`, `recovery-engineer`)
declares `primaryModel`, ordered `fallbackModels`, a `costPosture` (subscription-first /
low-cost-first / **quality-first** / best-available-in-emergency), and a **`hardStop` flag**.
E.g. `archive-ingest` = quality-first + hardStop (KG writes refuse rather than use a weak model);
`recovery-engineer` ends in a **local model emergency floor**. Resolver walks primary-health →
auth-tier → adapter → locality → resurrection → hard-fallback, returns typed reason. UI shows
each workload's resolved chain as live `routable/unavailable` badges. *"The best model is not
always the right model."*

**2. Structured context compaction (ADR-016) — for deep research.** Active prompt = **compact
state block + recent uncompressed turns**, NOT prose summary. Layers: immutable raw transcript
(append-only, recoverable) → rolling summary → **decision ledger** (binding choices with
`reason` + `sourceMessageIds` + `relatedDocPaths`) → facts/entities (source-linked,
`unverified` flag, observed-date) → open tasks → artifact pointers. Rules: compaction explicit /
auditable / **reversible from raw transcript**; intent + *why* are first-class; user prefs kept
separate from project decisions.

**3. Review-gated, trust-tiered memory writes (`memory-schema.mjs`, "LLM Wiki").** Agents write
only to `INTAKE/`; a separate strategist promote-path writes trusted `AI_MEMORY/wiki/`, each
promotion review-gated (`autoApprove` only for summary/metadata refresh). **Duplicate-candidate
flagging instead of silent merge; contradiction/open-question note instead of overwrite.** Pages
are typed (source/entity/concept/claim/comparison/synthesis/open-question). Ingest writer is
**structure-validated** (7 required sections + ≥300 bytes else deterministic fallback). Also:
LLM-as-next-action-proposer loop — model proposes ONE strict-JSON action → host validates against
whitelist → execute → **verify state changed (else stop/re-target)** → cap 12 iterations →
deterministic fallback.

**Caveats:** two parallel shells (~87k LOC overlap, flagged as their top risk); memory *search*
is keyword not vector (scrapalot's pgvector is ahead — adopt the governance, not retrieval); open
P0 security findings (capability tokens in 0600 file, keys in localStorage on fallback) — borrow
patterns, not weaknesses. Local STT (PR #166): ONNX Runtime WASM Whisper/Parakeet + model picker,
partially landed.

---

## The-Prompt-nomicon (`Resonant-Jones/The-Prompt-nomicon`, 5★) — evidence discipline only

NOT a memory/orchestration vault (task framing was wrong). It's an AI-assisted-coding methodology
guide. ~70% substance in the **verification** category:

- **Five Truth Surfaces:** Plan / Implementation / Test-evidence / Runtime-proof / Release-promise
  — a lower surface may never assert a higher one's authority.
- **5-Tier Evidence Rubric:** T1 Live Runtime Proof → T2 Automated Test → T3 Code-Level → T4
  Synthetic → **T5 Assertion ("agent said so" = weakest, not evidence)**, + freshness-decay.
- **Anti-hallucination contract:** reason only within evidentiary space; **"silence is not
  confirmation" → say "not found in provided context"**; red-flag lexicon to catch ("as is
  standard…", "we can simply…", "obviously…").
- **Loop-Status rubric:** Closed ✅ / Partial ⚠️ / Gap 🔴 decision tree.

**For scrapalot:** use the evidence rubric + truth surfaces as the **scoring schema for the
deep-research verification agent** (T1 cited claim → T5 uncited assertion = drop/down-weight),
and lift the grounding contract + red-flag list into RAG-answer / entity-extraction system prompts.
