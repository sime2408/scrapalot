# Scrapalot API Gateway

**Spring Cloud Gateway** for the Scrapalot microservices architecture - provides centralized authentication, routing, rate limiting, and circuit breakers.

[![Discord](https://img.shields.io/badge/Discord-Join%20our%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/mmuCqzFXs7)

> 💬 **Join the community** — questions, self-hosting help, and roadmap discussion live on our [Discord server](https://discord.gg/mmuCqzFXs7).

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Key Features](#key-features)
4. [Prerequisites](#prerequisites)
5. [Quick Start](#quick-start)
6. [Configuration](#configuration)
7. [Routing Rules](#routing-rules)
8. [Rate Limiting](#rate-limiting)
9. [Deployment](#deployment)
10. [Monitoring](#monitoring)
11. [Troubleshooting](#troubleshooting)

---

## Overview

The Scrapalot API Gateway acts as a single entry point for all client requests, providing:

- **Centralized Authentication**: JWT and API key validation
- **Intelligent Routing**: Routes requests to scrapalot-backend (CRUD) or scrapalot-chat (AI/RAG)
- **Rate Limiting**: Redis-backed token bucket algorithm with tier-based limits
- **Circuit Breakers**: Resilience4j fault tolerance for downstream services
- **API Versioning**: Support for multiple API versions (`/api/v1`, `/api/v2`)
- **CORS Handling**: Centralized cross-origin resource sharing configuration
- **User Context Propagation**: Adds X-User-ID, X-User-Role headers for downstream services

**Technology Stack:**
- **Spring Boot**: 3.4.1
- **Spring Cloud Gateway**: 2024.0.0
- **Kotlin**: 2.1.0
- **Java**: 21 (LTS)
- **Redis**: Rate limiting and session affinity
- **gRPC**: Authentication validation with scrapalot-backend (port 9090)

---

## Architecture

```
┌─────────────┐
│   Client    │
│  (Browser)  │
└──────┬──────┘
       │ HTTPS (443)
       ▼
┌─────────────────┐
│ Nginx Proxy Mgr │
│  (api.scrapalot │
│      .app)      │
└──────┬──────────┘
       │ HTTP (8080)
       ▼
┌─────────────────────────────────────────────┐
│         scrapalot-gw (API Gateway)          │
│  ┌────────────────────────────────────┐    │
│  │  1. JWT/API Key Validation         │    │
│  │  2. Extract User Context           │    │
│  │  3. Rate Limiting (Redis)          │    │
│  │  4. Route Selection                │    │
│  │  5. Circuit Breaker Check          │    │
│  │  6. Add Headers (X-User-ID, etc.)  │    │
│  └────────────────────────────────────┘    │
└──────────┬────────────────┬─────────────────┘
           │                │
           ▼                ▼
    ┌─────────────┐  ┌──────────────┐
    │ scrapalot-  │  │ scrapalot-   │
    │  backend    │  │   chat       │
    │  (8091)     │  │  (8090)      │
    │             │  │              │
    │ • Auth      │  │ • AI/RAG     │
    │ • CRUD      │  │ • Streaming  │
    │ • gRPC      │  │ • LLM        │
    └─────────────┘  └──────────────┘
```

---

## Key Features

### 1. Authentication & Authorization

**JWT Validation:**
- Validates bearer tokens on every request
- Extracts user context (userId, role, subscriptionTier)
- Propagates context via headers to downstream services

**API Key Support:**
- Desktop application authentication
- Validates via gRPC call to scrapalot-backend
- Adds X-API-Key-ID header for tracking

**Public Endpoints:**
- `/actuator/health` - Gateway health check
- `/api/v1/desktop/**` - Desktop app endpoints (no auth)

### 2. Intelligent Routing

**Route Selection Logic:**

| Path Pattern | Target Service | Use Case |
|-------------|----------------|----------|
| `/api/v1/auth/**` | Backend (8091) | Authentication, OAuth |
| `/api/v1/users/**` | Backend (8091) | User management |
| `/api/v1/workspaces/**` | Backend (8091) | Workspace CRUD |
| `/api/v1/collections/**` | Backend (8091) | Collection management |
| `/api/v1/notes/**` | Backend (8091) | Collaborative notes |
| `/api/v1/chat/**` | Chat (8090) | AI streaming |
| `/api/v1/sessions/**` | Chat (8090) | Chat sessions |
| `/api/v1/messages/**` | Chat (8090) | Chat history |
| `/api/v1/research/**` | Chat (8090) | Deep research |
| `/api/v1/documents/upload**` | Chat (8090) | File processing |
| `/api/v1/llm-inference/**` | Chat (8090) | Model management |
| `/stomp/**` | Chat (8090) | WebSocket streaming |

### 3. Rate Limiting

**Tier-Based Limits:**

| Subscription Tier | AI Operations | CRUD Operations |
|------------------|---------------|-----------------|
| Researcher       | 10 req/sec    | 100 req/sec     |
| Professional     | 50 req/sec    | 500 req/sec     |
| Enterprise       | Unlimited     | Unlimited       |

**Implementation:**
- Redis-backed token bucket algorithm
- Replenish rate + burst capacity configuration
- Per-user rate limiting based on subscription tier

### 4. Circuit Breakers

**Resilience4j Configuration:**

| Service | Failure Threshold | Wait Duration | Timeout |
|---------|------------------|---------------|---------|
| Backend | 60% (lenient)    | 60 seconds    | 60 sec  |
| Chat    | 60% (lenient)    | 60 seconds    | 120 sec |

**Why Lenient Settings?**
- AI workloads can have variable latency
- Deep research operations may take longer
- Prevents premature circuit opening for valid slow requests

### 5. API Versioning

**Supported Versions:**
- `/api/v1/**` - Current production API
- `/api/v2/**` - Future version support

**Version Routing:**
- Path-based versioning
- Easy to add new versions without breaking existing clients
- Gateway-level version management

---

## Prerequisites

### Required Services

Before deploying the gateway, ensure these services are running:

1. **Redis** - For rate limiting and session affinity
2. **scrapalot-backend** - Business logic service (port 8091, gRPC 9090)
3. **scrapalot-chat** - AI/RAG service (port 8090)

### System Requirements

- **Java**: 21 or higher
- **Memory**: Minimum 512MB, Recommended 1GB
- **Docker**: 20.10+ (for containerized deployment)
- **Network**: Ports 8080 (HTTP) accessible

---

## Quick Start

### Development Mode

```bash
# 1. Clone repository
cd /opt/scrapalot/scrapalot-gw

# 2. Create .env file
cat > .env << EOF
JWT_SECRET=your_jwt_secret_here
REDIS_PASSWORD=your_redis_password
BACKEND_URL=http://localhost:8091
CHAT_URL=http://localhost:8090
GRPC_CLIENT_HOST=localhost
GRPC_CLIENT_PORT=9090
EOF

# 3. Build project
./gradlew clean build

# 4. Run locally
./gradlew bootRun
```

### Docker Deployment

```bash
# 1. Build image
docker build -t scrapalot-gw:latest .

# 2. Run container
docker compose up -d scrapalot-gw

# 3. Check health
curl http://localhost:8080/actuator/health
```

### Verify Gateway

```bash
# Test health endpoint
curl -f http://localhost:8080/actuator/health

# Test routing to backend
curl -f http://localhost:8080/api/v1/health

# Test with JWT (replace TOKEN)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     http://localhost:8080/api/v1/workspaces
```

---

## Configuration

### Environment Variables

**Required:**

```bash
# JWT Configuration
JWT_SECRET=your_jwt_secret_here          # Must match backend
JWT_EXPIRATION_MS=1800000                # 30 minutes

# Redis Configuration
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
REDIS_DB=2                               # Gateway uses DB 2

# Backend Service
BACKEND_URL=http://scrapalot-backend:8091
BACKEND_TIMEOUT_MS=60000

# Chat Service
CHAT_URL=http://scrapalot-chat:8090
CHAT_TIMEOUT_MS=120000

# gRPC Client
GRPC_CLIENT_HOST=scrapalot-backend
GRPC_CLIENT_PORT=9090
GRPC_CLIENT_TIMEOUT_MS=5000
```

**Optional:**

```bash
# Server Configuration
SERVER_PORT=8080
SPRING_PROFILES_ACTIVE=prod

# CORS Configuration
CORS_ALLOWED_ORIGINS=https://scrapalot.app,http://localhost:3000
CORS_ALLOW_CREDENTIALS=true

# Rate Limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT_RESEARCHER_RATE=10
RATE_LIMIT_PROFESSIONAL_RATE=50
RATE_LIMIT_ENTERPRISE_RATE=1000

# Circuit Breaker
CIRCUIT_BREAKER_ENABLED=true
CIRCUIT_BREAKER_FAILURE_THRESHOLD=60
CIRCUIT_BREAKER_WAIT_DURATION_SECONDS=60

# Logging
LOG_LEVEL_ROOT=WARN
LOG_LEVEL_APP=INFO
LOG_LEVEL_GATEWAY=INFO

# Java Options
JAVA_OPTS=-Xms256m -Xmx1024m -XX:+UseG1GC
```

### Spring Profiles

**Development (`application-dev.yml`):**
- Detailed logging
- No rate limiting
- Permissive CORS

**Production (`application-prod.yml`):**
- Error-level logging
- Strict rate limiting
- Restricted CORS origins

---

## Routing Rules

### Authentication Flow

```
1. Client → Gateway (JWT in Authorization header)
2. Gateway validates JWT (JwtTokenProvider)
3. Gateway extracts user context (userId, role, tier)
4. Gateway adds headers:
   - X-User-ID: <uuid>
   - X-User-Role: USER | ADMIN
   - X-Subscription-Tier: researcher | professional | enterprise
5. Gateway forwards to backend/chat
6. Backend/chat uses X-User-ID (no re-validation needed)
```

### Route Priority

1. **Actuator endpoints** - Highest priority (health, metrics)
2. **Static routes** - Desktop API, public endpoints
3. **Dynamic routes** - Pattern-based routing to backend/chat
4. **Fallback** - 404 Not Found

### WebSocket Support

**STOMP over WebSocket:**
- Path: `/stomp/**`
- Target: scrapalot-chat:8090
- Upgrade: HTTP → WebSocket
- Heartbeat: 10 seconds

---

## Rate Limiting

### Implementation

**Token Bucket Algorithm:**
- Replenish rate: Tokens added per second
- Burst capacity: Maximum tokens available
- User-specific buckets: Based on X-User-ID

**Redis Keys:**
```
rate_limit:{userId}:ai_operations
rate_limit:{userId}:crud_operations
```

### Configuration by Tier

```yaml
# Researcher Tier
rate_limit:
  researcher:
    ai_rate: 10          # 10 requests/second
    ai_capacity: 20      # Burst of 20
    crud_rate: 100
    crud_capacity: 200

# Professional Tier
rate_limit:
  professional:
    ai_rate: 50
    ai_capacity: 100
    crud_rate: 500
    crud_capacity: 1000

# Enterprise Tier
rate_limit:
  enterprise:
    unlimited: true      # No rate limits
```

### Rate Limit Headers

Responses include rate limit information:

```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 7
X-RateLimit-Reset: 1640000000
```

---

## Deployment

### Production Deployment

**Prerequisites:**
1. Deploy Redis
2. Deploy scrapalot-backend (with gRPC on 9090)
3. Deploy scrapalot-chat
4. **Then** deploy scrapalot-gw

**Deployment Steps:**

```bash
# 1. Navigate to gateway directory
cd /opt/scrapalot/scrapalot-gw

# 2. Create production .env (see Configuration section)
cat > .env << EOF
# ... (see environment variables above)
EOF

# 3. Build Docker image
docker build -t scrapalot-gw:latest .

# 4. Deploy via Docker Compose
docker compose up -d scrapalot-gw

# 5. Verify deployment
docker compose ps scrapalot-gw
docker compose logs -f scrapalot-gw

# 6. Health check
curl -f http://localhost:8080/actuator/health
```

### CI/CD Deployment

**GitHub Actions Workflow:**
- Automatic deployment on push to main (currently disabled)
- Manual workflow dispatch available
- Environment-based deployments (dev/rc/prod)

**Trigger Deployment:**
```bash
# Manual deployment via GitHub Actions
# Go to Actions → CICD-Gateway → Run workflow
```

**Note:** CI/CD is currently disabled to allow preparation of other services first.

---

## Monitoring

### Health Checks

**Gateway Health:**
```bash
curl http://localhost:8080/actuator/health
```

**Response:**
```json
{
  "status": "UP",
  "components": {
    "redis": {
      "status": "UP"
    },
    "gateway": {
      "status": "UP"
    }
  }
}
```

### Metrics

**Prometheus Metrics:**
```bash
curl http://localhost:8080/actuator/prometheus
```

**Key Metrics:**
- `gateway_requests_total` - Total requests
- `gateway_route_duration_seconds` - Routing latency
- `circuit_breaker_state` - Circuit breaker status
- `rate_limit_exceeded_total` - Rate limit violations

### Logging

**View Logs:**
```bash
# Docker
docker compose logs -f scrapalot-gw

# Application logs
tail -f /var/log/scrapalot-gw/application.log
```

**Log Levels:**
- `ERROR` - Production errors
- `WARN` - Production warnings
- `INFO` - Service state changes
- `DEBUG` - Development only

---

## Troubleshooting

### Issue: Gateway Won't Start

**Symptoms:**
- Container starts but immediately exits
- Health check fails

**Check:**
```bash
# View logs
docker compose logs scrapalot-gw

# Check environment variables
docker exec scrapalot-gw env | grep -E "BACKEND|CHAT|REDIS|JWT"
```

**Common Causes:**
1. Redis not running
2. Backend/chat services not accessible
3. Invalid JWT secret
4. Port 8080 already in use

---

### Issue: 502 Bad Gateway

**Symptoms:**
- Gateway returns 502 for all requests
- Logs show connection errors

**Check:**
```bash
# Test backend connectivity
docker exec scrapalot-gw wget -q -O- http://scrapalot-backend:8091/health

# Test chat connectivity
docker exec scrapalot-gw wget -q -O- http://scrapalot-chat:8090/health

# Check circuit breaker state
curl http://localhost:8080/actuator/health
```

**Solutions:**
1. Verify backend/chat are running
2. Check Docker network connectivity
3. Restart gateway: `docker compose restart scrapalot-gw`

---

### Issue: Authentication Fails

**Symptoms:**
- Valid JWT returns 401 Unauthorized
- API key validation fails

**Check:**
```bash
# Verify JWT secret matches backend
echo $JWT_SECRET

# Test gRPC connection
docker exec scrapalot-gw nc -zv scrapalot-backend 9090
```

**Debug:**
```bash
# Enable debug logging
export LOG_LEVEL_GATEWAY=DEBUG
docker compose restart scrapalot-gw

# Check logs for JWT validation
docker compose logs -f scrapalot-gw | grep JWT
```

---

### Issue: Rate Limiting Not Working

**Symptoms:**
- Users exceed rate limits without 429 errors
- Redis connection errors in logs

**Check:**
```bash
# Test Redis connectivity
docker exec scrapalot-gw redis-cli -h redis -a $REDIS_PASSWORD ping

# Check rate limit keys
docker exec redis redis-cli -a $REDIS_PASSWORD KEYS "rate_limit:*"
```

**Solutions:**
1. Verify Redis is running
2. Check REDIS_PASSWORD is correct
3. Ensure RATE_LIMIT_ENABLED=true

---

### Issue: WebSocket Connection Failed

**Symptoms:**
- `/stomp/**` connections fail
- Browser shows WebSocket error

**Check:**
```bash
# Test WebSocket upgrade
curl -i -N -H "Connection: Upgrade" \
     -H "Upgrade: websocket" \
     http://localhost:8080/stomp/ws
```

**Solutions:**
1. Verify chat service is running
2. Check Nginx WebSocket support enabled
3. Ensure gateway WebSocket configuration is correct

---

## Development

### Project Structure

```
scrapalot-gw/
├── src/
│   └── main/
│       ├── kotlin/
│       │   └── com/scrapalot/gateway/
│       │       ├── GatewayApplication.kt        # Main application
│       │       ├── config/
│       │       │   ├── SecurityConfig.kt        # Spring Security
│       │       │   └── RouteConfig.kt           # Route definitions
│       │       ├── filter/
│       │       │   └── AuthenticationFilter.kt  # JWT validation
│       │       ├── security/
│       │       │   ├── JwtTokenProvider.kt      # JWT parsing
│       │       │   └── ApiKeyValidator.kt       # API key validation
│       │       └── grpc/
│       │           └── AuthGrpcClient.kt        # gRPC client
│       └── resources/
│           ├── application.yml                  # Main config
│           ├── application-dev.yml              # Dev profile
│           └── application-prod.yml             # Prod profile
├── build.gradle.kts                             # Gradle build
├── Dockerfile                                   # Container image
├── docker-compose.yml                           # Local deployment
└── README.md                                    # This file
```

### Building from Source

```bash
# Clean build
./gradlew clean build

# Run tests
./gradlew test

# Build Docker image
docker build -t scrapalot-gw:latest .

# Run locally
./gradlew bootRun --args='--spring.profiles.active=dev'
```

### Adding a New Route

1. Edit `src/main/resources/application.yml`
2. Add route configuration:
```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: new-route
          uri: http://scrapalot-backend:8091
          predicates:
            - Path=/api/v1/new/**
          filters:
            - name: CircuitBreaker
              args:
                name: backendCircuitBreaker
```
3. Rebuild and deploy

---

## Contributing

**Guidelines:**
1. Follow Kotlin coding conventions
2. Write tests for new routes/filters
3. Update this README with configuration changes
4. Test with both backend and chat services

**Testing:**
```bash
# Unit tests
./gradlew test

# Integration tests
./gradlew integrationTest

# Manual testing
curl -f http://localhost:8080/actuator/health
```

---

## Security

**Best Practices:**
1. **Never commit** `.env` files with secrets
2. **Rotate JWT secrets** every 90 days
3. **Use HTTPS** in production (via Nginx)
4. **Enable rate limiting** to prevent abuse
5. **Monitor** failed authentication attempts
6. **Keep dependencies updated** via Gradle

**Security Headers:**
- `Strict-Transport-Security` - Force HTTPS
- `X-Content-Type-Options` - Prevent MIME sniffing
- `X-Frame-Options` - Prevent clickjacking
- `Content-Security-Policy` - XSS protection

---

## Performance

**Optimizations:**
- **Connection pooling** - Reuse HTTP connections
- **Redis caching** - Fast rate limit checks
- **Reactive programming** - Non-blocking I/O
- **Circuit breakers** - Fail fast on errors
- **Request deduplication** - Prevent duplicate requests

**Benchmarks:**
- Gateway latency: <10ms added overhead
- Throughput: 10,000+ req/sec on 2 CPU cores
- Memory: 256MB baseline, 1GB recommended

---

## License

Scrapalot is **open-core**. This repository is part of the **proprietary, hosted Scrapalot product** (Pro / Team / Enterprise) — © 2024–2026 Scrapalot, all rights reserved.

A free, self-hostable **Community Edition** is published separately under the **AGPL-3.0** license. See [Editions](https://docs.scrapalot.app/getting-started/editions) for what each includes.

**Open Source Components:**
- Spring Cloud Gateway (Apache 2.0)
- Resilience4j (Apache 2.0)
- Kotlin (Apache 2.0)

---

## Support

**Issues:**
- GitHub: [scrapalot-gw/issues](https://github.com/sime2408/scrapalot/issues)
- Email: support@scrapalot.com

**Documentation:**
- Backend: `../scrapalot-backend/README.md`
- Chat: `../scrapalot-chat/docs/README_DEPLOYMENT_GUIDE.md`
- UI: `../scrapalot-ui/docs/README_CLOUD_DEPLOYMENT.md`

---

**Last Updated:** 2025-12-20
**Version:** 1.0.0
**Maintained By:** Scrapalot Team
**Technology:** Spring Cloud Gateway + Kotlin + Java 21
