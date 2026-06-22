# Nginx Routing Configuration for Gateway Architecture

Complete guide for configuring Nginx Proxy Manager to route traffic through the API Gateway.

---

## 🏗️ Architecture Overview

Scrapalot uses a **Gateway-based microservices architecture**:

```
                        Nginx Proxy Manager (443)
                                  |
                                  | HTTPS
                                  ▼
                        API Gateway (8080)
                        scrapalot-gw
                                  |
                 +----------------+----------------+
                 |                                 |
                 | Intelligent Routing             |
                 | JWT Validation                  |
                 | Rate Limiting                   |
                 | Circuit Breakers                |
                 |                                 |
        +--------+--------+              +---------+---------+
        |                 |              |                   |
        ▼                 ▼              ▼                   ▼
 Kotlin Backend (8091)              Python Backend (8090)
 scrapalot-backend                  scrapalot-chat
        |                                   |
 +------+------+                    +-------+-------+
 |             |                    |               |
Auth, Users,   Documents,      Chat, RAG,      Jobs,
Collections,   Notes,          Sessions,       Subscriptions,
Workspaces     Settings        Messages        Connectors

                  gRPC (9090, 9091)
         ←────────────────────────────────→
         Bidirectional gRPC Communication

                  Redis (6379)
         ←────────────────────────────────→
            Shared Event Bus (Pub/Sub)
```

**Key Change**: Nginx now routes **all traffic to Gateway**, which handles authentication, rate limiting, and intelligent routing to backend services.

---

## 📋 Service Responsibility Matrix

**Note**: The API Gateway (scrapalot-gw:8080) automatically routes requests to the appropriate backend based on path patterns. See [Gateway README](../README.md#routing-rules) for detailed routing logic.

### Kotlin Backend (scrapalot-backend:8091)

| Endpoint Pattern | Controller | Description |
|-----------------|------------|-------------|
| `/api/v1/auth/*` | AuthController | User authentication, login, logout, token refresh |
| `/api/v1/users/*` | UserController | User profile, preferences, settings |
| `/api/v1/workspaces/*` | WorkspaceController | Workspace CRUD, sharing, members |
| `/api/v1/collections/*` | CollectionController | Collection CRUD, permissions |
| `/api/v1/documents/*` | DocumentController | Document upload, metadata, deletion |
| `/api/v1/notes/*` | NoteController | Note CRUD, collaboration |
| `/api/v1/settings/*` | SettingsController | User and system settings |

**gRPC Server Port**: 9090 (internal only - accessed by Python backend)

### Python Backend (scrapalot-chat:8090)

| Endpoint Pattern | Controller | Description |
|-----------------|------------|-------------|
| `/api/v1/chat/*` | ChatController | RAG queries, streaming responses |
| `/api/v1/sessions/*` | SessionController | Chat session management |
| `/api/v1/messages/*` | MessageController | Message history, retrieval |
| `/api/v1/jobs/*` | JobController | Background job status |
| `/api/v1/subscriptions/*` | SubscriptionController | Subscription plans, billing |
| `/api/v1/connectors/*` | ConnectorController | External data connectors |
| `/llm-inference/*` | LLMController | LLM model management |
| `/health` | HealthController | Service health check |

---

## 🔧 Nginx Proxy Manager Configuration

### Step 1: Create Proxy Host for Main Domain

**Domain**: `api.scrapalot.app`

1. Go to Nginx Proxy Manager: https://routes.scrapalot.app
2. Click **Hosts** → **Proxy Hosts** → **Add Proxy Host**

**Details Tab:**
- Domain Names: `api.scrapalot.app`
- Scheme: `http`
- Forward Hostname/IP: `scrapalot-gw`  ⚠️ **Gateway, not backend!**
- Forward Port: `8080`
- Block Common Exploits
- Websockets Support

**SSL Tab:**
- Request new SSL Certificate (Let's Encrypt)
- Force SSL
- HTTP/2 Support
- HSTS Enabled

**Advanced Tab** - **SIMPLIFIED ROUTING**:

```nginx
# ============================================================================
# Gateway-Based Routing Configuration
# ============================================================================
#
# All traffic is routed to API Gateway (scrapalot-gw:8080)
# Gateway handles:
#   - JWT validation
#   - Rate limiting (tier-based)
#   - Intelligent routing to Kotlin/Python backends
#   - Circuit breakers for fault tolerance
#   - User context propagation (X-User-ID, X-User-Role headers)
#
# See Gateway documentation for detailed routing rules:
#   ../scrapalot-gw/README.md
# ============================================================================

# ============================================================================
# Route ALL Traffic to Gateway
# ============================================================================

location / {
    proxy_pass http://scrapalot-gw:8080;
    proxy_http_version 1.1;

    # WebSocket support (for STOMP chat streaming)
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_cache_bypass $http_upgrade;

    # Forward client information
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port $server_port;

    # Extended timeouts for AI operations and streaming
    proxy_connect_timeout 75s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
}

# ============================================================================
# Security Headers
# ============================================================================

add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;

# ============================================================================
# NOTES
# ============================================================================
# - CORS is handled by Gateway, not Nginx
# - Rate limiting is handled by Gateway (Redis-backed, tier-based)
# - Authentication is handled by Gateway (JWT + API keys)
# - No per-endpoint routing needed - Gateway handles all routing logic
```

---

## 🧪 Testing the Routing

All requests go through: **Nginx (443) → Gateway (8080) → Backend (8091/8090)**

### Test Gateway Health

```bash
# Gateway health check
curl https://api.scrapalot.app/actuator/health
# Expected: {"status":"UP","components":{"redis":{"status":"UP"},"gateway":{"status":"UP"}}}
```

### Test Kotlin Backend Endpoints (via Gateway)

```bash
# Authentication (Gateway validates, routes to Kotlin)
curl -X POST https://api.scrapalot.app/api/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"test123"}'

# Workspaces (Gateway adds X-User-ID header, routes to Kotlin)
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/api/v1/workspaces

# Collections
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/api/v1/collections

# Documents (metadata only)
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/api/v1/documents
```

### Test Python Backend Endpoints (via Gateway)

```bash
# Chat (Gateway validates JWT, routes to Python)
curl -X POST https://api.scrapalot.app/api/v1/chat \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"message":"Hello","session_id":"123"}'

# Sessions
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/api/v1/sessions

# Jobs
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/api/v1/jobs

# Research
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/api/v1/research
```

### Test Rate Limiting

```bash
# Exceed rate limit (depends on subscription tier)
for i in {1..100}; do
  curl -H "Authorization: Bearer YOUR_TOKEN" \
       https://api.scrapalot.app/api/v1/chat &
done

# Expected: 429 Too Many Requests (if tier limit exceeded)
# Headers: X-RateLimit-Remaining, X-RateLimit-Reset
```

---

## 🔍 Debugging Routing Issues

### Check Request Flow

The request flows through three layers:

```
1. Nginx Proxy Manager (443)
   ↓
2. API Gateway (8080) - JWT validation, routing decision, rate limiting
   ↓
3. Backend Service (8091/8090) - Business logic
```

### Verify Each Layer

**Layer 1: Nginx → Gateway**
```bash
# Check Nginx can reach Gateway
curl -I http://scrapalot-gw:8080/actuator/health
# Expected: 200 OK

# Check Nginx logs
docker logs nginx-proxy-manager --tail 100 -f
```

**Layer 2: Gateway Health**
```bash
# Check Gateway health
curl https://api.scrapalot.app/actuator/health
# Expected: {"status":"UP","components":{"redis":{"status":"UP"}}}

# Check Gateway logs
docker logs scrapalot-gw --tail 100 -f

# Check Gateway routing
# Gateway adds X-Gateway-Routed-To header for debugging
curl -I https://api.scrapalot.app/api/v1/chat
# Look for: X-Gateway-Routed-To: scrapalot-chat:8090
```

**Layer 3: Backend Services**
```bash
# Kotlin backend (direct access, bypass Gateway)
docker exec scrapalot-backend curl -f http://localhost:8091/actuator/health

# Python backend (direct access, bypass Gateway)
docker exec scrapalot-chat curl -f http://localhost:8090/health

# Backend logs
docker logs scrapalot-backend --tail 100 -f
docker logs scrapalot-chat --tail 100 -f
```

### Common Issues

**Issue 1: 502 Bad Gateway**
- Cause: Gateway cannot reach backend
- Check: `docker ps | grep scrapalot` - Are all services running?
- Fix: Restart services, check Docker network

**Issue 2: 401 Unauthorized**
- Cause: JWT validation failed in Gateway
- Check: JWT secret matches between Gateway and Kotlin Backend
- Debug: Enable Gateway debug logging: `LOG_LEVEL_GATEWAY=DEBUG`

**Issue 3: 429 Too Many Requests**
- Cause: Rate limit exceeded for user's subscription tier
- Check: User's subscription tier and rate limit configuration
- Debug: Check Redis keys: `redis-cli KEYS "rate_limit:*"`

**Issue 4: Slow Requests**
- Cause: Circuit breaker opened or backend timeout
- Check: Gateway actuator health for circuit breaker status
- Fix: Increase timeouts in Gateway configuration

### Verify Services are Running

```bash
# Check all services
docker ps | grep -E "scrapalot|nginx"

# Expected output:
# scrapalot-gw       (port 8080)
# scrapalot-backend  (port 8091)
# scrapalot-chat     (port 8090)
# nginx-proxy-manager (ports 80, 443)
# redis              (port 6379)
```

---

## 📚 Additional Resources

- **Gateway README**: `../README.md` - Complete Gateway documentation
- **Gateway Routing Rules**: `../README.md#routing-rules` - Detailed routing logic
- **Kotlin Backend Deployment**: `../../scrapalot-backend/docs/README_DEPLOYMENT_GUIDE.md`
- **Backend Architecture**: `../../scrapalot-backend/docs/README_ARCHITECTURE.md`
- **gRPC Communication**: `../../scrapalot-backend/docs/README_GRPC_ARCHITECTURE.md`
- **Cloud Infrastructure**: `../../scrapalot-chat/docs/README_CLOUD_INFRASTRUCTURE.md`

---

## 🔄 Migration from Direct Routing

If you're migrating from the old architecture (Nginx → Backends directly):

**Old Configuration:**
```nginx
location /api/v1/chat {
    proxy_pass http://scrapalot-chat:8090;  # Direct routing
}
```

**New Configuration (Gateway-based):**
```nginx
location / {
    proxy_pass http://scrapalot-gw:8080;  # All traffic to Gateway
}
```

**Benefits of Gateway:**
- Centralized JWT validation (no duplicate auth logic)
- Tier-based rate limiting (researcher, professional, enterprise)
- Circuit breakers for fault tolerance
- User context propagation (X-User-ID, X-User-Role headers)
- Intelligent routing based on path patterns
- Single point of configuration for all routing rules

---

**Last Updated:** February 2026
**Version:** 2.0.0 (Gateway Architecture)
