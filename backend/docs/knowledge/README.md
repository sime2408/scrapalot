# Knowledge Base

External knowledge harvested from AI/ML practitioner communities and curated for ideas
that can improve Scrapalot (RAG, knowledge graph, agents, document processing, self-hosting).

This folder is **research input**, not product documentation — it captures techniques,
tools, and findings from the wider local/sovereign-AI ecosystem so engineering decisions
are informed by what others have already learned. Each entry notes its source and the
Scrapalot subsystem it applies to.

## Index

| File | Contents |
|---|---|
| `improvement-insights.md` | **Start here.** Prioritized improvements (P1–P3, Slava-talk S1–S6, repo deep-reads R1–R14) for Scrapalot, each mapped to a subsystem with source + caveats. |
| `repo-deep-reads.md` | Deep technical reads of PixelRAG, BorgOS, Arcanum, ResonantOS, Prompt-nomicon — concrete schemas, numbers, and reusable patterns (R-series source). |
| `slava-scalable-agents-talk.md` | Deep notes from Slava Fill's talk: envelope compression, LightRAG multi-graph verification, doc-driven architecture, role-scoped skills. |
| `local-ai-hardware.md` | Self-hosting hardware: the memory-bandwidth iron triangle, specific machines. |
| `models-and-runtimes.md` | Models, quantization tradeoffs, runtimes (vLLM/llama.cpp/Ollama/LMStudio). |
| `tools-and-links.md` | Community-built tools and a consolidated link index. |

## Sources

- **Augmentatism / ResonantOS** Discord community (local & sovereign AI), 2026-06-20 harvest.

## Maintenance

New harvests are appended here over time. When adding:
- Keep everything in **English**.
- Record the **source** and **capture date** in front-matter.
- Route findings into `improvement-insights.md` with a priority and the target subsystem,
  rather than leaving raw transcripts.
