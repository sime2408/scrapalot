# CLAUDE.md — API Gateway (Spring Cloud Gateway)

**Last Updated**: April 2026

Spring Cloud Gateway reverse-proxy in front of the Kotlin backend and Python AI. JWT validation, rate limiting, circuit breakers, route selection, STOMP WebSocket passthrough. Business logic and deep technical detail live in the `docs/` and `application.yml` files — this file is a navigator with rules only.

## Quick Reference

| Item | Value |
|---|---|
| Language / JVM | Kotlin 2.1.0 on Java 21 LTS |
| Framework | Spring Cloud Gateway 2024.0.0 |
| Build | Gradle 8.12 |
| Port | 8080 |
| Redis | DB 2 (rate limiting, session affinity) |
| gRPC client | Auth validation to Kotlin backend on 9090 |
| Throughput | ~10 k req/sec on 2 vCPU |
| Overhead | < 10 ms per request (JWT + routing) |

## Commands

```bash
./gradlew build
./gradlew test
./gradlew bootRun --args='--spring.profiles.active=dev'
./gradlew bootJar
docker build -t scrapalot-gw:latest .
```

## Architecture (one-line flow)

```
Client → Nginx (443, api.scrapalot.app) → Gateway :8080 → Kotlin BE :8091 → gRPC :9091 → Python AI :8090
                                             ↓ JWT, Redis DB 2, Resilience4j      ↓ user context    ↓ STOMP
```

Gateway never calls Python directly — it routes to Kotlin, which calls Python via gRPC with `{userId, workspaceId, collectionIds, documentIds}`. Python never queries user tables; it receives IDs as parameters.

## Intelligent Routing

| Path pattern | Target | Port | Notes |
|---|---|---|---|
| `/api/v1/auth/**` | Kotlin backend | 8091 | JWT issuance, OAuth, sessions |
| `/api/v1/users/**` | Kotlin backend | 8091 | User CRUD |
| `/api/v1/workspaces/**` | Kotlin backend | 8091 | Workspace CRUD |
| `/api/v1/collections/**` | Kotlin backend | 8091 | Collection CRUD |
| `/api/v1/notes/**` | Kotlin backend | 8091 | Notes collaboration |
| `/api/v1/settings/**` | Kotlin backend | 8091 | Settings source of truth |
| `/api/v1/chat/**` | Kotlin → Python | 8091 → 8090 | RAG, LLM streaming |
| `/api/v1/sessions/**` | Kotlin → Python | 8091 → 8090 | Chat sessions |
| `/api/v1/messages/**` | Kotlin → Python | 8091 → 8090 | Chat messages |
| `/api/v1/research/**` | Kotlin → Python | 8091 → 8090 | Deep research 5-phase |
| `/upload/**` | Kotlin backend | 8091 | Document upload → `StaticFileController.kt` |
| `/api/v1/llm-inference/**` | Python AI | 8090 | Direct LLM inference |
| `/stomp/**` | Python AI | 8090 | WebSocket STOMP (streaming packets) |

Full route definitions: `src/main/resources/application.yml`. 11 consolidated routes.

## Rate Limiting (Redis DB 2)

| Subscription tier | AI ops | CRUD ops |
|---|---|---|
| Researcher | 10 req/sec | 100 req/sec |
| Professional | 50 req/sec | 500 req/sec |
| Enterprise | unlimited | unlimited |

Redis keys: `rate_limit:{userId}:ai_operations`. Tier comes from JWT claim, **never** a DB lookup. Enterprise bypasses entirely — no Redis keys are written.

## Circuit Breakers (Resilience4j)

| Service | Failure threshold | Wait | Request timeout |
|---|---|---|---|
| Kotlin backend | 60 % (lenient) | 60 s | 60 s |
| Python AI | 60 % (lenient) | 60 s | 120 s |

**Lenient** because AI workloads (RAG, deep research, entity extraction) have variable latency — a strict threshold trips circuits on slow-but-working requests. Circuit state visible at `/actuator/health`.

## Documentation Index

| Topic | Document |
|---|---|
| Gateway overview | `README.md` |
| Nginx routing (SSL, upstream timeouts) | `docs/README_NGINX_ROUTING.md` |
| Cloud deployment | `docs/README_CLOUD_DEPLOYMENT.md` |
| Backend architecture (dual-DB, gRPC) | `../scrapalot-backend/docs/README_ARCHITECTURE.md` |
| gRPC + Redis Streams SAGA | `../scrapalot-backend/docs/README_GRPC_ARCHITECTURE.md` |
| Full deployment guide | `../scrapalot-backend/docs/README_DEPLOYMENT_GUIDE.md` |

Route config: `application.yml`. Env-var reference: `application-dev.yml`, `application-prod.yml`.

## Critical Rules

### Filter chain order
1. `AuthenticationFilter` — JWT / API-key validation (highest priority).
2. `RateLimitFilter` — Redis-backed per user + tier.
3. Route predicate → target URI.
4. `CircuitBreakerFilter` — Resilience4j fault tolerance.
5. `HeaderPropagationFilter` — adds `X-User-ID`, `X-User-Role`, `X-Subscription-Tier` to downstream request.

### Routing
6. **Path precedence** — specific paths before wildcards. Critical ordering routes use `order: 1`; consolidated routes use `order: 5`. Do not break this.
7. **Trailing slashes matter** — `/api/v1/chat` and `/api/v1/chat/` are different routes to Spring Cloud Gateway. Route config must cover both explicitly.
8. **STOMP WebSocket** — requires `Upgrade` and `Connection` headers to be preserved; routes to Python on 8090.
9. Gateway never calls Python for AI operations directly — it must go through Kotlin backend, which owns user context injection.
10. **Predicate list > order for specificity** — when a catch-all predicate list (`backend-routes`) contains `/api/v1/X/**`, adding a separate route with `Path=/api/v1/X/specific` and lower `order` does NOT win. Spring Gateway picks the most specific path inside ONE predicate block. To route a sub-path to Python, split the list into specific sub-paths (e.g. remove `/api/v1/research/**`, keep `/api/v1/research/plans/**`, `/api/v1/research/start`) so the wildcard no longer swallows the sub-path.

### Security
10. **JWT secret** — must match Kotlin backend AND Python AI backend (256-bit minimum, 32 chars). Mismatch → every request returns 401.
11. **CORS** is configured in Gateway, not Nginx. Nginx does SSL termination only.
12. **API key** validation (desktop clients) uses gRPC to Kotlin backend's auth service on 9090.

### Redis / state
13. **Redis database isolation**: Python on DB 0, Kotlin on DB 1, Gateway on DB 2. Never cross.
14. **Subscription tier comes from JWT claims**, not a DB lookup. JWT is the source of truth for tier-based rate limiting.
15. **Health depends on Redis** — if Redis goes down, `/actuator/health` returns DOWN and Gateway becomes unhealthy in front of Nginx.

### Deployment
16. **Startup order**: Redis → Postgres (pgvector) → Neo4j → Kotlin backend → Python AI → **then** Gateway. Gateway last because it health-checks its upstreams at boot.
17. **CI/CD** auto-deploys on push to `main`; manual dispatch supports dev/rc/prod environments. Secrets are per-environment (GitHub environments), not repository-level.
18. **Required secrets**: `JWT_SECRET`, `REDIS_PASSWORD`, `GH_TOKEN`. Secrets live under `https://github.com/sime2408/scrapalot-gw/settings/environments`.
19. **Prod host** — Hetzner Cloud vServer, 8 vCPU / 16 GB RAM. Canonical spec in `scrapalot-chat/docs/README_CLOUD_INFRA_05_INFRASTRUCTURE.md`. Do not restate as "CX33" — that is a 4 vCPU instance and does not match prod.

### Docs
20. Never create new `*.md` files without user approval. All docs English only, under `docs/` with `README_` prefix.

## Troubleshooting quick reference

| Symptom | Likely cause |
|---|---|
| 502 Bad Gateway | Backend or Python AI unreachable — check container health |
| 401 Unauthorized | JWT secret mismatch between Gateway / Kotlin / Python |
| 429 Too Many Requests | Rate limit for user's tier exceeded (check headers `X-RateLimit-*`) |
| Circuit breaker OPEN | Too many failures → inspect downstream logs; `/actuator/health` shows state |
| STOMP handshake fails | Nginx or Gateway stripping `Upgrade`/`Connection` headers |
| Health DOWN on Gateway | Redis unreachable — `docker exec scrapalot-gw wget -q -O- http://redis:6379` |

Full request-flow debugging recipes (`docker logs`, per-service wget probes, rate-limit stress tests): `README.md` § Debugging.

## Key Files

| Category | Files |
|---|---|
| Entry point | `GatewayApplication.kt` |
| Security config | `SecurityConfig.kt`, `JwtTokenProvider.kt`, `ApiKeyValidator.kt` |
| Filters | `AuthenticationFilter.kt` |
| gRPC client | `AuthGrpcClient.kt` |
| Route config | `src/main/resources/application.yml`, `application-dev.yml`, `application-prod.yml` |

---

**Workspace**: `../CLAUDE.md` · **Kotlin backend**: `../scrapalot-backend/CLAUDE.md` · **Python AI**: `../scrapalot-chat/CLAUDE.md` · **Frontend**: `../scrapalot-ui/CLAUDE.md`
