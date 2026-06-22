# Scrapalot — Community Edition

> ⚠️ **Work in progress.** This is the open-source **Community Edition** of Scrapalot,
> being assembled from the hosted product via an automated strip-and-publish pipeline.
> It does not boot yet — surgery on the extracted modules is in progress.

Self-hostable, **open-core** AI document RAG. Upload your documents, chat over them with
retrieval-augmented generation, take collaborative notes, and run it entirely on your own
infrastructure.

**License:** [AGPL-3.0](LICENSE) *(added at first clean publish).*
**Hosted product** (advanced RAG, deep research, knowledge graph, AI Scientist, voice,
mobile app, team collaboration): https://scrapalot.app
**Community:** [Discord](https://discord.gg/mmuCqzFXs7)

## What's included (Community Edition)
- Document ingestion (PDF + common formats), OCR, chunking, embeddings (pgvector)
- Core vector + sparse (BM25) + lexical hybrid RAG chat
- Collaborative notes editor (real-time)
- Read-aloud (TTS)
- Web search · conversation memory · Bring Your Own Key (OpenAI/Anthropic/DeepSeek/local)
- Local AI model inference
- Self-host with Docker Compose — no usage quotas

## What's hosted-only (proprietary)
Advanced RAG (fusion, agentic routing, reranking) · Deep Research · Knowledge Graph (Neo4j) ·
AI Scientist papers · Notes AI assistant · STT / voice chat · Image generation · MCP integrations ·
external connectors · team chat & shared workspaces · API access · Android app.

## Layout (monorepo)
```
chat/      # Python AI backend (gRPC + RAG)        — being extracted first
backend/   # Kotlin backend (auth, workspaces, notes)
ui/        # React frontend
gw/        # API gateway
docker-compose.yml   # one-command self-host (added at publish)
```

See https://docs.scrapalot.app/getting-started/editions for the full Community vs Hosted breakdown.
