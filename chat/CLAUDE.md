# CLAUDE.md — Python AI Backend

**Last Updated**: April 2026

Concise guidance for AI agents. **Detailed docs live in `docs/`** — follow the Documentation Index below.

## Quick Reference

| Item | Value |
|------|-------|
| Python | 3.12.8 |
| Framework | gRPC (9091) + SQLAlchemy + Alembic (FastAPI minimal: health + WebSocket) |
| AI | Pydantic AI 1.77.0, LangChain 1.2.0 |
| Database | PostgreSQL + pgvector (port 5432) |
| Role | PURE AI/ML service (RAG, LLM, embeddings) |

## Commands

```bash
# PRODUCTION (Docker — always use docker exec)
docker exec scrapalot-chat python run_service.py
docker exec scrapalot-chat alembic upgrade head
docker exec scrapalot-chat python alembic/create_migration.py "Description" --autogenerate
docker exec scrapalot-chat python -m pytest tests/

# LOCAL DEVELOPMENT
conda activate scrapalot-chat
python run_service.py
```

## Documentation Index

| Topic | Document |
|-------|----------|
| **Development Patterns & Gotchas (READ FIRST)** | `docs/README_DEVELOPMENT_PATTERNS.md` |
| Background Jobs, Celery & Redis Streams | `docs/README_BACKGROUND_JOBS.md` |
| Document Processing + Chunking | `docs/README_DOCUMENT_PROCESSING.md` |
| RAG Architecture | `docs/README_RAG_ARCHITECTURE.md` (22 strategies, 9 orchestrators) |
| Streaming Protocol | `docs/README_STREAMING.md` (83 packet types) |
| Deep Research | `docs/README_DEEP_RESEARCH.md` (5-phase system) |
| Database Schema | `docs/README_DATABASE_DESIGN.md` |
| WebSocket/STOMP | `docs/README_WEBSOCKET_ARCHITECTURE.md` |
| Model Management | `docs/README_MODEL_MANAGEMENT.md` |
| Knowledge Graph | `docs/README_KNOWLEDGE_GRAPH.md` (Neo4j entity extraction) |
| Graph Housekeeping + Resilience patterns | `docs/README_GRAPH_HOUSEKEEPING.md` |
| Deployment | `docs/README_DEPLOYMENT_GUIDE.md` |
| Backup & Recovery (weekly → Cloudflare R2) | `docs/README_BACKUP_RECOVERY.md` |
| Cloud Infrastructure | `docs/README_CLOUD_INFRASTRUCTURE.md` |
| Dataset Generator | `scripts/README_DATASET_GENERATOR.md` |
| Pydantic AI Skills | `.claude/skills/pydantic-ai/skill.md` |

## Architecture Overview

```
Kotlin Backend → gRPC (9091) → Python AI Backend
        │                            ↓
        └─ Sends: {userId,      RAG Service → Strategy Selection
           workspaceId,              ↓
           documentIds}         PgVector + Neo4j → LLM Generation
                                     ↓
                                PacketEmitter → Streaming (83 packets)
```

**Key Directories**:
- `src/main/grpc/` — gRPC service implementations (port 9091)
- `src/main/service/chat/` — Chat business logic (deep research, web search, agentic RAG, document QA)
- `src/main/service/rag/` — 22 strategies, 9 orchestrators, 15 chunking methods
- `src/main/service/deep_research/` — 5-phase research system
- `src/main/service/streaming/` — PacketEmitter and 83 packet types
- `src/main/service/agents/` — Pydantic AI agents and tools (16 RAG agents)
- `src/main/service/document/` — Document ingestion pipeline
- `src/main/service/document_processing/` — Upload, reprocess, cleanup orchestration
- `src/main/background/` — Lightweight async jobs (asyncio)
- `src/main/workers/` — Celery tasks → `scrapalot-workers` container

## Critical Rules (Top 10)

Full list in `docs/README_DEVELOPMENT_PATTERNS.md`. **Must-know**:

1. **Docker production only** — always `docker exec`, NO conda in production
2. **PacketEmitter Only** — never manual JSON formatting for streaming (`docs/README_STREAMING.md`)
3. **Status Codes, NOT English** — `emit_status("analyzing_query")` NOT `"Analyzing query..."`
4. **Use `text()` Wrapper** — raw SQL requires `from sqlalchemy import text`
5. **Never `db.expire()`** after `db.commit()`
6. **Logger `%s`, NOT f-strings** — `logger.info("Query: %s", query_text)`
7. **Use `create_migration.py`** — NEVER `alembic revision --autogenerate` directly
8. **LLM Prompts → `configs/prompts.yaml`** — never hardcoded in Python
9. **System Provider for agents** — NEVER user's chat model for system tasks
10. **No Hot-Reload for gRPC** — changes to `grpc/services/*.py` require `docker restart scrapalot-chat`
11. **Proto canonical source is scrapalot-backend** — edit `../scrapalot-backend/src/main/proto/*.proto`, then `cp` to `src/main/service/bridge/proto/src/`, run `grpc_tools.protoc` in container, patch generated files with `from src.main.grpc import common_pb2 as common__pb2` (protoc emits a broken bare import), `docker cp` pb2 back to host, `docker restart scrapalot-chat`. The `src/main/grpc/protos/` directory is an orphan copy and editing it does nothing. Full steps in `memory/reference_proto_regen_workflow.md`
12. **Prompts live in `resolved_prompts`, NOT `resolved_config["prompts"]`** — `configs/prompts.yaml` loads into a SEPARATE module attribute `resolved_prompts` in `src/main/utils/config_loader.py`. `resolved_config.get("prompts", ...)` has always returned `{}` and silently fell through to inline hardcoded fallbacks. Always `from src.main.utils.config_loader import resolved_prompts`; `prompts.get("notes_assistant", {})` or similar. Grep guardrail: `grep -rn 'resolved_config\.get("prompts"' src/main --include="*.py"` must return zero. Commit `61b1296` fixed 12 call sites across notes_assistant, deep_research, paper_generation.
13. **Seed migrations for system resources MUST set `is_system=True`** — the `/research/templates` (and similar) endpoints filter `WHERE is_system = TRUE`. If a seed migration omits the column (defaults to `False`), the row exists in the DB but is invisible to the API. When adding a system template via Alembic, include both the column in INSERT and the value `True`.
14. **SQLModel relationship annotations stay `Optional["X"]`** — converting to `"X | None"` breaks SQLAlchemy mapper resolution (the whole quoted string is treated as ONE forward-ref class name → `InvalidRequestError: failed to locate a name`). Verified via `configure_mappers()`; applies to `models/sqlmodel_models.py` and `models/sqlmodel_research.py`. Never "modernize" these unions.
15. **Lint/format with HOST ruff, never `docker exec` ruff** — use `.venv-precommit/bin/ruff` from the repo root (same pin as pre-commit). The Docker image carries an older ruff AND a stale `pyproject.toml` (only `src/` is bind-mounted), so in-container measurements report phantom errors; in-container `--fix` also writes root-owned files through the mount.

## Git Workflow

- **Commit messages MUST use commitizen-conventional prefix** — one of
  `build`, `bump`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`,
  `refactor`, `revert`, `style`, `test`, with optional `(scope)` and
  optional `!` for breaking. Bare scopes like `docker:` or `notes:`
  fail the pre-commit hook with exit code 14 — the commit silently
  stays staged. Use `fix(docker):` / `chore(docker):` etc. instead.
  scrapalot-chat is the ONLY scrapalot repo enforcing this; backend /
  ui / gw / docs accept free-form messages.
- **`typos` pre-commit hook auto-renames identifiers** — it once "fixed" the
  BM25 variable `nd` to the Python keyword `and` (SyntaxError). After the hook
  fails/modifies, ALWAYS `git diff` before re-staging. Never rename an
  identifier to satisfy the hook — add the word to `_typos.toml`
  `[default.extend-words]` with a one-line comment instead.

## Testing

- **NEVER mock** — integration tests use REAL database, REAL API, REAL LLM calls
- **Go through controllers** — never import services directly
- **Prove data exists** — query PostgreSQL/Neo4j/pgvector after operations
- **Fix bugs, not tests** — failing tests reveal source bugs

Full rules: `docs/README_DEVELOPMENT_PATTERNS.md#integration-test-rules`.

## Key Files Reference

| Category | Files |
|----------|-------|
| gRPC | `grpc/services/chat_service.py`, `document_processing_service.py`, `document_extras_service.py`, `admin_service.py` |
| Chat Logic | `service/chat/chat_deep_research.py`, `chat_web_search.py`, `chat_agentic_rag.py`, `chat_document.py` |
| Deep Research | `service/deep_research/deep_research_orchestrator.py`, `agents/*_agent.py` |
| RAG | `service/rag/rag_*.py`, `orchestrators/*.py`, `chunking/*.py` |
| Streaming | `service/streaming/packet_emitter.py`, `dto/streaming.py` |
| Agents | `service/agents/base_agent.py`, `agent_factory.py`, `rag_agents/*.py` |
| Document Processing | `service/document/*.py`, `service/document_processing/documents.py` |
| Celery Workers | `workers/celery_app.py`, `workers/tasks/*.py` |
| Redis Streams | `service/redis_event_subscriber.py`, `saga_ack_waiter.py`, `collection_workspace_cache.py`, `connector_cache.py`, `model_provider_snapshot.py` |
| Token Usage | `service/token_usage_tracker.py` (Redis Streams → Kotlin) |
| Graph | `service/graph/neo4j_service.py`, `entity_pipeline.py`, `graph_structure_service.py`, `node_factory.py` |
| Docker | `docker-scrapalot/docker-compose.yaml` |

## Environment

- Hetzner Cloud vServer: 8 vCPU, 16GB RAM, 38GB root SSD + 60GB volume
- Containers: `scrapalot-chat` (8GB), `scrapalot-workers` (8GB), `scrapalot-workers-graph` (3GB), `pgvector` (2GB), `neo4j` (3GB), `redis`
- Deep research tests sensitive to VPS load (run last)

---

**Workspace guidance**: `../CLAUDE.md`
**Frontend guidance**: `../scrapalot-ui/CLAUDE.md`
