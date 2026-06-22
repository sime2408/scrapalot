# CLAUDE.md — Backend (Kotlin / Spring Boot)

**Last Updated**: April 2026

Kotlin backend — auth, workspace/collection/notes CRUD, settings source-of-truth, subscriptions, Spring AI for lightweight tasks, gRPC client for heavy AI. Business logic and deep technical detail live in `docs/README_*.md` files linked from each section.

## Quick Reference

| Item | Value |
|---|---|
| Language / JVM | Kotlin 2.1.0 on Java 21 LTS |
| Framework | Spring Boot 3.4.1, Spring AI 1.0.0 |
| Build | Gradle 8.12 |
| Database | PostgreSQL 16 + pgvector (`scrapalot_backend` DB, `scrapalot` schema) |
| Migrations | Liquibase (`db/changelog/changes/NNN-*.yaml`, currently at 109) |
| Ports | REST 8091, gRPC server 9090, gRPC client → Python 9091 |

## Commands

```bash
./gradlew build                                             # Build
./gradlew test                                              # Tests
./gradlew bootRun --args='--spring.profiles.active=dev'     # Dev with CORS
./gradlew generateProto                                     # Regenerate gRPC stubs
```

Local dev runs against `http://localhost:8091/api/v1` with CORS enabled for `localhost:3000` (Vite). Prod disables CORS — Gateway handles it. Full setup + frontend `.env` values in `docs/README_DEPLOYMENT_GUIDE.md`.

## Documentation Index

| Topic | Document |
|---|---|
| System architecture (controllers, services, repos, mappers) | `docs/README_ARCHITECTURE.md` |
| **gRPC + Redis Streams SAGA (read first for cross-service)** | `docs/README_GRPC_ARCHITECTURE.md` |
| WebSocket / STOMP integration | `docs/README_WEBSOCKET_INTEGRATION.md` |
| MapStruct mapping patterns | `docs/README_MAPSTRUCT_INTEGRATION.md` |
| Mail configuration | `docs/README_MAIL.md` |
| OpenAPI / Swagger setup | `docs/README_OPENAPI.md` |
| Deployment guide (local + cloud) | `docs/README_DEPLOYMENT_GUIDE.md`, `docs/README_CLOUD_DEPLOYMENT.md` |

## Architecture (one-line flow)

```
REST /api/v1 (8091)       gRPC → Python (9091)     Redis Streams SAGA (DB 1)
     ↓                           ↓                           ↓
Controllers → Services → Repositories → PostgreSQL (scrapalot_backend)
                  │
                  ↓ MapStruct ↔ DTOs / Entities
```

**Key directories (`src/main/kotlin/.../backend/`):**

- `controller/` — 47 REST controllers (auth, users, workspaces, collections, documents, notes, settings, connectors, AI generation, etc.)
- `service/` — 33 business services
- `domain/` — 32 JPA entities (organized by aggregate: ai, auth, chat, collection, connectors, document, notes, profile, settings, user, workspace)
- `repository/` — 32 Spring Data repositories
- `mapper/` — 10 MapStruct mappers
- `grpc/` — 18 gRPC clients + server implementations
- `security/` — JWT provider and filters (shared secret with Python)

## Service Ownership (vs Python AI)

| This backend (Kotlin) | Python AI backend (scrapalot-chat) |
|---|---|
| Auth, OAuth, JWT issuance | JWT validation only |
| User / workspace / collection / notes CRUD | — |
| Settings **source of truth** (`user_settings`, `server_settings`) | Settings consumer (Redis Streams SAGA replica) |
| API keys, subscriptions, billing, token usage | — |
| **Spring AI local** (describe, translate, summarize, suggest) | — |
| **gRPC client** for RAG, deep research, entity extraction | **gRPC server** on 9091 |

**When to use Spring AI vs gRPC**:
- **Spring AI** (`AiGenerationService`): simple text generation, no document context. Calls OpenAI directly via cached `OpenAiChatModel`, key from `model_providers` replica.
- **gRPC → Python**: RAG, deep research, entity extraction, anything needing pgvector / Neo4j / collection context.

Full gRPC call pattern + SAGA flow + consumer groups: `docs/README_GRPC_ARCHITECTURE.md`.

## Redis Streams (cross-DB sync)

Kotlin is on Redis DB 1. Python is on DB 0. Gateway on DB 2.

| Stream | Direction | Purpose |
|---|---|---|
| `scrapalot:stream:workspaces` | K→P | Workspace CRUD |
| `scrapalot:stream:collections` | K→P | Collection CRUD |
| `scrapalot:stream:connectors` | K→P | Connector CRUD |
| `scrapalot:stream:user_settings` | K→P (SAGA) | Settings sync, ACK required |
| `scrapalot:stream:model_providers` | P→K (SAGA) | Provider CRUD, ACK required |
| `scrapalot:stream:token_usage` | P→K | Token usage tracking |
| `scrapalot:stream:saga_ack` | bidirectional | SAGA acknowledgements |

Snapshot: `scrapalot:sync:collection_workspace_snapshot` (K writes, P startup reads). DLQ: `scrapalot:dlq:cwm_sync` max 1000. Stream max length: 10000 (approximate trim). Full details in `docs/README_GRPC_ARCHITECTURE.md` § Redis Streams.

## Database

| Aspect | Value |
|---|---|
| Host / port | `pgvector:5432` (Docker) |
| Database | `scrapalot_backend` |
| Schema | `scrapalot` |
| Migrations | `src/main/resources/db/changelog/changes/NNN-*.yaml` |

**Key tables (Kotlin owns all user data):**
- Auth: `users`, `api_keys`
- Workspaces: `workspaces`, `workspace_users`
- Knowledge: `collections` (documents themselves are owned by Python, proxied via gRPC)
- Chat: `sessions`, `messages`, `chat_conversations`
- Notes: `notes`, `note_versions`, `note_shares`, `note_comments`
- Settings: `user_settings` (owner), `server_settings` (replica)
- Billing: `subscription_plans`, `user_subscriptions`, `user_token_usage`
- Jobs: `jobs` (replica; Python owns)

Full ownership + sync table: `../scrapalot-chat/docs/README_DATABASE_DESIGN.md`.

## Critical Rules

### Kotlin / Spring idioms
1. Use functional scope functions (`let`, `runCatching`, `takeIf`, `also`) over nested `if`/try-catch.
2. **Never `!!`** — use `requireNotNull(value) { "message" }`.
3. Data classes for DTOs and value objects.
4. Extension functions over utility classes.
5. Constructor injection, never `@Autowired` field injection.
6. `@Transactional` on service methods, not repositories.

### Mandatory reusable utilities
- **`grpcCall { }`** (`ResultExtensions.kt`) — wrap ALL gRPC client bodies, auto-maps exceptions to gRPC Status codes. Never hand-write try/catch in gRPC calls.
- **`resultOf { }.toResponseEntity()`** (`ResultExtensions.kt`) — ALL REST controller endpoints with error handling.
- **`asJsonResponse()` / `toJsonResponse(objectMapper)`** — JSON `ResponseEntity` returns. Never hand-assemble `ResponseEntity.ok().contentType(APPLICATION_JSON).body(...)`.
- **`toNdjsonStream { }`** (`GrpcProxyExtensions.kt`) — ALL NDJSON streaming responses.
- **`escapeJson()`** — manual JSON escaping inside streaming contexts.
- **`UserDetails.userId()`** — private helper in each controller for user ID extraction.

### Redis / transactions
7. **Redis events always deferred after `@Transactional` commit** via `runAfterCommit()`. Never publish events that could be seen before the DB commit lands. Pattern + helper in `docs/README_GRPC_ARCHITECTURE.md`.
8. SAGA flow: remote DB commits → ACK via `saga_ack` stream → local DB commits. Timeout 10 s → 503.

### Database
9. **Liquibase** changesets must have sequential `NNN-` prefixes. Create via the same pattern as 001–070.
10. All entities use **UUID** primary keys.
11. Soft deletes via `deletedAt` timestamp, never physical DELETE.

### API contract
12. **SNAKE_CASE JSON** — Jackson is globally configured for snake_case. All DTO fields and JSON payloads must use snake_case. `setUserSetting` replaces the entire JSON blob — services must merge existing + incoming data before save.
13. **SSE streaming** — use `ServerSentEvent.builder<String>().data(json).build()` with `Flux<ServerSentEvent<String>>`, **not** manual `"data: ${json}\n\n"` with `Flux<String>`. Spring WebFlux auto-prefixes `data:` for `TEXT_EVENT_STREAM_VALUE`; doing it manually produces `data:data:` double prefixes.

### gRPC
14. Proto files live at **canonical** location `src/main/proto/` (regenerate stubs with `./gradlew generateProto`). The mirror in `scrapalot-chat/src/main/grpc/protos/` is a copy only — never edit it.
15. Always pass `userId` / `workspaceId` as parameters to Python gRPC services. Python never queries user tables.
16. Use **coroutine stubs** (`*CoroutineStub`) for async operations.
17. Proto3 **message** fields support `has*()` presence tracking; **scalar** fields need the `optional` keyword for the same.

### Security
18. **JWT secret** must match Gateway and Python backend; minimum 256-bit (32 chars).
19. CORS configured in `SecurityConfig.kt` only for `dev` profile; prod delegates to Gateway.
20. Public endpoints explicitly enumerated in security config (`/auth/**`, `/health`, `/actuator/**`).

### Documentation
21. Never create new `*.md` files without user approval. All docs in English, placed in `docs/` with `README_` prefix.

## Key Files

| Category | Files |
|---|---|
| Entry point | `ScrapalotBackendApplication.kt` |
| Controllers | `controller/` (47 files) |
| Services | `service/` (33 files) |
| Spring AI | `service/AiGenerationService.kt`, `controller/AiGenerationController.kt`, `dto/AiGenerationDTOs.kt` |
| Security | `security/SecurityConfig.kt`, `JwtTokenProvider.kt`, `JwtAuthenticationFilter.kt` |
| gRPC | `src/main/proto/*.proto`, `grpc/` clients (18) |
| Redis | `config/RedisConfig.kt`, `redis/RedisEventPublisher.kt`, `redis/RedisStreamConsumer.kt`, `redis/SagaAckWaiter.kt` |
| Cross-DB sync | `service/sync/CollectionWorkspaceSyncService.kt`, `ConnectorSyncSnapshotService.kt`, `ModelProviderSyncService.kt` |
| Token usage | `service/TokenUsageService.kt`, `domain/UserTokenUsage.kt` |
| Mappers | `mapper/` (10 MapStruct files) |
| Migrations | `src/main/resources/db/changelog/changes/` |

---

**Workspace**: `../CLAUDE.md` · **Gateway**: `../scrapalot-gw/CLAUDE.md` · **Python AI**: `../scrapalot-chat/CLAUDE.md` · **Frontend**: `../scrapalot-ui/CLAUDE.md`
