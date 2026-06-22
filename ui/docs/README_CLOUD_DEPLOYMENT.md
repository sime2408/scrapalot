# Scrapalot UI - Deployment Guide

Complete guide for deploying Scrapalot UI on Cloud with Docker and CI/CD.

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [GitHub Secrets Configuration](#github-secrets-configuration)
4. [Deployment Methods](#deployment-methods)
5. [Verification & Testing](#verification--testing)
6. [Troubleshooting](#troubleshooting)

---

## Overview

The Scrapalot UI is a React-based frontend application built with:
- **Framework:** React 18.3.1 + TypeScript 5.9.3 + Vite 5.4.1
- **UI Library:** Radix UI + shadcn/ui + Tailwind CSS
- **Editor:** TipTap (most extensions on 2.10.3, newer extensions on 2.27.1) with Y.js for collaboration
- **Animations:** Framer Motion 12.23.24
- **i18n:** i18next (English, Croatian)
- **Deployment:** Docker container via GitHub Actions CI/CD

**Production Architecture:**
```
User (HTTPS) → Nginx Proxy Manager (443) → Scrapalot UI (3000)
                                              ↓
                                         API Gateway (8080)
                                              ↓
                        ┌─────────────────────┴─────────────────────┐
                        ↓                                           ↓
            scrapalot-backend (8091)                    scrapalot-chat (8090)
            - User management                           - AI/RAG operations
            - CRUD operations                           - Deep research (5 phases)
            - Business logic                            - Document processing
            - PostgreSQL + Neo4j                        - LLM inference
                                                        - WebSocket (STOMP)
```

**Gateway Features:**
- Centralized JWT/API key validation
- Rate limiting (Redis-backed, 100 req/min per user)
- Circuit breakers for fault tolerance
- API versioning support (`/api/v1`, `/api/v2`)
- Intelligent routing (Python for AI, Kotlin for CRUD)
- CORS handling for all environments

---

## Prerequisites

### Required

- **API Gateway deployed** - The API Gateway (scrapalot-gw) must be deployed first
- **Backend services deployed** - Both scrapalot-backend and scrapalot-chat must be running
- **User permissions configured** - `scrapalot-dev` group and user setup complete
- **GitHub Actions runner** - Self-hosted runner on server
- **Nginx Proxy Manager** - Configured with SSL certificate for both scrapalot.app and api.scrapalot.app
- **Domain name** - Pointing to your server

### Server Requirements

The UI shares the same server as the backend and gateway:
- **Server:** Hetzner Cloud vServer (8 vCPUs, 16GB RAM, 38GB root SSD + 60GB volume)
- **OS:** Ubuntu 24.04 LTS
- **Docker:** 24.0+ with Docker Compose v2
- **Network:** Ports 80/443 open (external), 3000/8080/8090/8091 (internal)
- **Storage:** Docker volumes for data persistence

### User & Group Setup (Critical)

**IMPORTANT**: Before deploying the UI, ensure the following users and groups are configured:

**Required Group:**
- `scrapalot-dev` - Shared development group for collaboration

**Required Users:**
- `scrapalot` - Application owner (member of: scrapalot, docker, github-runner, scrapalot-dev)
- `github-runner` - CI/CD operations (member of: github-runner, users, docker, scrapalot, scrapalot-dev)

**Verify Setup:**
```bash
# Check group exists
getent group scrapalot-dev

# Check user memberships
groups scrapalot
groups github-runner

# Expected output:
# scrapalot : scrapalot docker github-runner scrapalot-dev
# github-runner : github-runner users docker scrapalot scrapalot-dev
```

**If Not Configured:**
See the comprehensive user management guide in the backend infrastructure documentation:
- [User Management & Permissions Setup](https://github.com/sime2408/scrapalot-chat/blob/main/docs/README_CLOUD_INFRASTRUCTURE.md#user-management-and-permissions-setup)

**Why This Matters:**
The GitHub Actions workflow (`deploy-ui.yml`) uses the `scrapalot-dev` group to:
1. Set correct ownership on deployed files: `sudo chown -R $USER:scrapalot-dev /opt/scrapalot/scrapalot-ui`
2. Enable group write permissions: `sudo chmod -R g+w /opt/scrapalot/scrapalot-ui`
3. Set setgid for automatic group inheritance: `sudo chmod -R g+s /opt/scrapalot/scrapalot-ui`

Without proper group configuration, deployments will fail with permission errors.

---

## GitHub Secrets Configuration

### How to Add Secrets

1. Go to: `https://github.com/sime2408/scrapalot-ui/settings/secrets/actions`
2. Click **New repository secret**
3. Add each secret below

### Required UI Secrets

**4 secrets needed for UI deployment:**

| Secret Name | Description | Example Value |
|------------|-------------|---------------|
| `GH_TOKEN` | GitHub PAT for git operations | `github_pat_...` |
| `VITE_API_BASE_URL` | API Gateway endpoint | `https://api.scrapalot.app/api/v1` |
| `VITE_LLM_INFERENCE_ENDPOINT` | LLM inference endpoint (via gateway) | `https://api.scrapalot.app/api/v1/llm-inference` |
| `FRONTEND_URL` | Frontend public URL | `https://scrapalot.app` |

**Git Authentication Secret (`GH_TOKEN`):**
The CI/CD workflow uses `GH_TOKEN` to authenticate git operations when pulling code. This must be:
- A Personal Access Token (PAT) with `repo` permissions
- Set in the repository's **prod** environment (Settings → Environments → prod → Secrets)
- For fine-grained PATs: `Contents: Read and write` permission on the repository

**Note:** All API requests now go through the API Gateway (scrapalot-gw), which handles authentication and routing to the appropriate backend service.

**Important Notes:**
- These are the **only** secrets needed in the UI repository
- Update URLs with your actual domain after SSL setup
- All other secrets (database, OAuth, API keys) are configured in the **backend repository**

**Generate these secrets:**
```bash
echo "VITE_API_BASE_URL=https://api.scrapalot.app/api/v1"
echo "VITE_LLM_INFERENCE_ENDPOINT=https://api.scrapalot.app/api/v1/llm-inference"
echo "FRONTEND_URL=https://scrapalot.app"
```

### Backend Secrets

All backend secrets (database, OAuth, API keys, etc.) are configured in the **scrapalot-chat** repository.

**See:** [Backend Secrets Documentation](https://github.com/sime2408/scrapalot-chat/blob/main/docs/README_CLOUD_INFRASTRUCTURE.md#complete-secrets-reference)

### Environment Configuration

The UI build uses these environment variables **passed as Docker build arguments**:

```bash
# These are passed during docker build via --build-arg flags
VITE_API_BASE_URL=https://api.scrapalot.app/api/v1
VITE_LLM_INFERENCE_ENDPOINT=https://api.scrapalot.app/api/v1/llm-inference
VITE_APP_ENV=production
VITE_ENABLE_DEBUG_LOGS=false
VITE_ENABLE_PERFORMANCE_MONITORING=true
```

**Important:** Vite environment variables must be available **at build time** (not runtime). The GitHub workflow passes these as `--build-arg` flags to `docker build`, which bakes them into the JavaScript bundle.

---

## GitHub Actions Runner Setup

The UI deployment requires a self-hosted GitHub Actions runner. The infrastructure uses **three separate runners**:

1. **Backend Runner** - `/opt/scrapalot/actions-runner` (scrapalot-chat)
2. **UI Runner** - `/opt/scrapalot/actions-runner-ui` (scrapalot-ui)
3. **Docs Runner** - `/opt/scrapalot/actions-runner-docs` (scrapalot-docs)

**Check UI Runner Status:**
```bash
# SSH into server
ssh hetzner-scrapalot

# Check UI runner
sudo systemctl status actions.runner.sime2408-scrapalot-ui.ubuntu-scrapalot-1.service

# Check all runners
sudo systemctl status actions.runner.*
```

**If UI runner is not set up**, see the [Infrastructure Documentation](https://github.com/sime2408/scrapalot-chat/blob/main/docs/README_CLOUD_INFRASTRUCTURE.md#github-actions-runners) for setup instructions.

---

## Deployment Order

**IMPORTANT:** Services must be deployed in this order:

1. **Infrastructure** - Redis, PostgreSQL (Supabase)
2. **Backend** (scrapalot-backend) - Business logic, CRUD operations
3. **Chat** (scrapalot-chat) - AI/RAG operations
4. **Gateway** (scrapalot-gw) - API Gateway (routes to backend + chat)
5. **UI** (scrapalot-ui) - React frontend

The gateway depends on both backend and chat services being available. The UI requires the gateway to be running.

---

## Deployment Methods

### Method 1: GitHub Actions (Recommended)

**Automatic deployment via CI/CD pipeline**

#### Step 1: Verify Backend is Deployed

```bash
# SSH into Hetzner server
ssh hetzner-scrapalot

# Check backend is running
cd /opt/scrapalot/scrapalot-chat/docker-scrapalot
docker compose -f docker-compose.yaml ps scrapalot-chat
```

#### Step 2: Trigger UI Deployment

**From GitHub:**
1. Go to **Actions** tab in scrapalot-ui repository
2. Select **CICD-ui** workflow
3. Click **Run workflow**
4. Select environment (production/staging)
5. Click **Run workflow**

**From local machine:**
```bash
# Push to main branch (if auto-deploy is enabled)
git add .
git commit -m "Deploy UI updates"
git push origin main
```

#### Step 3: Monitor Deployment

**On GitHub:**
- Watch the workflow progress in **Actions** tab
- Check for any errors in the logs

**On Server:**
```bash
# View deployment logs
cd /opt/scrapalot/scrapalot-chat/docker-scrapalot
docker compose -f docker-compose.yaml logs -f scrapalot-ui
```

---

### Method 2: Manual Deployment

**Direct deployment on the server**

#### Step 1: Clone/Update Repository

```bash
# SSH into Hetzner server
ssh hetzner-scrapalot

# Clone UI repository (first time only)
cd /opt/scrapalot
git clone https://github.com/sime2408/scrapalot-ui.git

# Or update existing repository
cd /opt/scrapalot/scrapalot-ui
git pull origin main
```

#### Step 2: Create Environment File

```bash
cd /opt/scrapalot/scrapalot-ui

# Create .env.production
cat > .env.production << EOF
VITE_API_BASE_URL=https://api.scrapalot.app/api/v1
VITE_LLM_INFERENCE_ENDPOINT=https://api.scrapalot.app/api/v1/llm-inference
VITE_APP_ENV=production
VITE_ENABLE_DEBUG_LOGS=false
VITE_ENABLE_PERFORMANCE_MONITORING=true
EOF
```

#### Step 3: Build Docker Image

```bash
# Build UI image with environment variables
docker build \
  -f Dockerfile \
  -t scrapalot-ui:latest \
  --build-arg NODE_ENV=production \
  --build-arg VITE_API_BASE_URL="https://api.scrapalot.app/api/v1" \
  --build-arg VITE_LLM_INFERENCE_ENDPOINT="https://api.scrapalot.app/api/v1/llm-inference" \
  --build-arg VITE_APP_ENV="production" \
  --build-arg VITE_ENABLE_DEBUG_LOGS="false" \
  --build-arg VITE_ENABLE_PERFORMANCE_MONITORING="true" \
  .
```

**Note:** The `.env.production` file created in Step 2 is no longer used. Environment variables must be passed as `--build-arg` flags during the Docker build.

#### Step 4: Deploy UI Container

```bash
# Navigate to backend docker-compose directory
cd /opt/scrapalot/scrapalot-chat/docker-scrapalot

# Deploy UI service
docker compose -f docker-compose.yaml up -d scrapalot-ui

# Check status
docker compose -f docker-compose.yaml ps scrapalot-ui
```

#### Step 5: Verify Deployment

```bash
# Check UI is accessible
docker exec scrapalot-ui wget --spider -q http://localhost:3000

# View logs
docker compose -f docker-compose.yaml logs --tail=50 scrapalot-ui
```

---

## Verification & Testing

### 1. Check Container Status

```bash
cd /opt/scrapalot/scrapalot-chat/docker-scrapalot

# Check UI container
docker compose -f docker-compose.yaml ps scrapalot-ui

# Should show: Up and healthy
```

### 2. Check Logs

```bash
# View UI logs
docker compose -f docker-compose.yaml logs -f scrapalot-ui

# Look for:
# - "VITE v5.x.x ready in XXX ms"
# - "Local: http://localhost:3000/"
# - No error messages
```

### 3. Test Internal Access

```bash
# Test from within Docker network
docker exec scrapalot-ui wget --spider -q http://localhost:3000
echo $?  # Should return 0 (success)
```

### 4. Test External Access

**Via Browser:**
1. Open: `https://scrapalot.app`
2. Should load the Scrapalot UI
3. Check browser console for errors (F12)

**Via curl:**
```bash
# From local machine or server
curl -I https://scrapalot.app

# Should return: HTTP/2 200
```

### 5. Test API Connection

**In Browser:**
1. Open: `https://scrapalot.app`
2. Try to login with Google OAuth
3. Check if API calls work (Network tab in DevTools)

**Expected API endpoints (all via gateway):**
- `https://api.scrapalot.app/actuator/health` - Gateway health
- `https://api.scrapalot.app/api/v1/auth/google` - OAuth (routed to backend)
- `https://api.scrapalot.app/api/v1/workspaces` - Workspaces (routed to backend)
- `https://api.scrapalot.app/api/v1/sessions` - Chat sessions (routed to chat)
- `https://api.scrapalot.app/api/v1/llm-inference` - LLM inference (routed to chat)

**Architecture Flow:**
```
Client → Nginx (443) → Gateway (8080) → Backend (8091) / Chat (8090)
                            ↓
                      JWT Validation
                      Rate Limiting
                      Circuit Breakers
```

### 6. Verify Nginx Proxy Configuration

```bash
# Check Nginx Proxy Manager logs
docker logs nginx-proxy-manager | grep scrapalot-ui

# Should show successful proxy requests
```

---

## Nginx Proxy Manager Configuration

### Overview

With the microservices architecture, you need to configure two proxy hosts in Nginx Proxy Manager:

1. **scrapalot.app** → UI (scrapalot-ui:3000)
2. **api.scrapalot.app** → API Gateway (scrapalot-gw:8080)

### Access Nginx Proxy Manager

**URL**: `https://routes.scrapalot.app` (or your NPM domain)

**Default Credentials** (change immediately):
- Email: `admin@example.com`
- Password: `changeme`

### 1. Configure Frontend Proxy Host (scrapalot.app)

**Navigate**: Hosts → Proxy Hosts → Add Proxy Host

**Details Tab:**
```
Domain Names: scrapalot.app
Scheme: http
Forward Hostname / IP: scrapalot-ui
Forward Port: 3000
Cache Assets: Enabled
Block Common Exploits: Enabled
Websockets Support: Enabled (CRITICAL for STOMP)
```

**SSL Tab:**
```
SSL Certificate: Request New SSL Certificate (Let's Encrypt)
Force SSL: Enabled
HTTP/2 Support: Enabled
HSTS Enabled: Enabled
HSTS Subdomains: Enabled

Email: your-email@example.com
Terms of Service: Agree
```

**Advanced Tab:**
```nginx
# Add security headers
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "no-referrer-when-downgrade" always;

# WebSocket upgrade headers (critical for STOMP)
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;

# Increase timeouts for long-polling connections
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

### 2. Configure API Gateway Proxy Host (api.scrapalot.app)

**Navigate**: Hosts → Proxy Hosts → Add Proxy Host

**Details Tab:**
```
Domain Names: api.scrapalot.app
Scheme: http
Forward Hostname / IP: scrapalot-gw
Forward Port: 8080
Cache Assets: ❌ Disabled (API responses shouldn't be cached)
Block Common Exploits: Enabled
Websockets Support: Enabled (for /stomp/** endpoints)
```

**SSL Tab:**
```
SSL Certificate: Request New SSL Certificate (Let's Encrypt)
Force SSL: Enabled
HTTP/2 Support: Enabled
HSTS Enabled: Enabled
HSTS Subdomains: Enabled

Email: your-email@example.com
Terms of Service: Agree
```

**Advanced Tab:**
```nginx
# API Gateway headers
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Port $server_port;

# WebSocket support for STOMP endpoints
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";

# Increase timeouts for AI/streaming operations
proxy_connect_timeout 120s;
proxy_send_timeout 120s;
proxy_read_timeout 120s;

# Allow large file uploads (for document processing)
client_max_body_size 100M;

# Security headers
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

### 3. Verify Configuration

**Test Frontend:**
```bash
# Should return 200 OK
curl -I https://scrapalot.app

# Should redirect to HTTPS
curl -I http://scrapalot.app
```

**Test API Gateway:**
```bash
# Health check
curl https://api.scrapalot.app/actuator/health

# Should return gateway info
curl https://api.scrapalot.app/api/v1/health
```

**Test WebSocket (from browser console):**
```javascript
// Test STOMP connection
const socket = new WebSocket('wss://api.scrapalot.app/stomp/ws');
socket.onopen = () => console.log('WebSocket connected!');
socket.onerror = (err) => console.error('WebSocket error:', err);
```

### 4. Architecture Flow Verification

**Request Flow:**
```
Browser (https://scrapalot.app)
    ↓
Nginx Proxy Manager (443 → 3000)
    ↓
scrapalot-ui:3000
    ↓ (API calls)
Browser (https://api.scrapalot.app/api/v1/...)
    ↓
Nginx Proxy Manager (443 → 8080)
    ↓
scrapalot-gw:8080
    ↓ (routing)
scrapalot-backend:8091 OR scrapalot-chat:8090
```

### 5. Common Nginx Issues

**Issue: 502 Bad Gateway**
```bash
# Check if services are running
docker ps | grep -E "scrapalot-(ui|gw)"

# Check NPM can reach services
docker exec nginx-proxy-manager wget -q -O- http://scrapalot-ui:3000
docker exec nginx-proxy-manager wget -q -O- http://scrapalot-gw:8080/actuator/health
```

**Issue: WebSocket Connection Failed**
- Ensure "Websockets Support" is checked in NPM
- Verify `proxy_set_header Upgrade $http_upgrade` in Advanced config
- Check browser console for specific WebSocket errors

**Issue: SSL Certificate Not Renewing**
```bash
# Force certificate renewal in NPM
# Go to SSL Certificates → Click on certificate → Force Renew
```

### 6. DNS Configuration Required

Ensure your DNS has A records pointing to your server IP:

```
A    scrapalot.app           → YOUR_SERVER_IP
A    api.scrapalot.app       → YOUR_SERVER_IP
A    routes.scrapalot.app    → YOUR_SERVER_IP (NPM admin)
```

**TTL**: Set to 300 (5 minutes) during initial setup, increase to 3600 after stable.

---

## Troubleshooting

### Issue: CI/CD Workflow Fails with "Invalid username or token"

**Cause:** Git authentication failure when pulling code.

**Check:**
```bash
# 1. Check for conflicting git configs in production directory
cd /opt/scrapalot/scrapalot-ui
cat .git/config

# Look for old/conflicting entries like:
# - url.https://x-access-token:@github.com/.insteadOf
# - http.https://github.com/.extraheader
# - credential.helper
```

**Solution:**
```bash
# Clean up old/conflicting git configs
cd /opt/scrapalot/scrapalot-ui
git config --local --unset-all url.https://x-access-token:@github.com/.insteadOf 2>/dev/null || true
git config --local --unset-all http.https://github.com/.extraheader 2>/dev/null || true
git config --local --unset-all credential.helper 2>/dev/null || true

# Verify clean config
cat .git/config
```

**Also verify:**
1. `GH_TOKEN` secret exists in prod environment (Settings → Environments → prod)
2. Token has `repo` or `Contents: Read and write` permission
3. Token is not expired or revoked

**Test token locally:**
```bash
GH_TOKEN="your_token_here"
git clone "https://x-access-token:${GH_TOKEN}@github.com/sime2408/scrapalot-ui.git" /tmp/test-clone
rm -rf /tmp/test-clone
```

---

### Issue: UI Container Won't Start

**Check logs:**
```bash
docker compose -f docker-compose.yaml logs scrapalot-ui
```

**Common causes:**
1. **Build failed** - Check Dockerfile and dependencies
2. **Port conflict** - Port 3000 already in use
3. **Environment variables missing** - Check .env.production

**Solution:**
```bash
# Rebuild image
cd /opt/scrapalot/scrapalot-ui
docker build -f Dockerfile -t scrapalot-ui:latest .

# Restart container
cd /opt/scrapalot/scrapalot-chat/docker-scrapalot
docker compose -f docker-compose.yaml restart scrapalot-ui
```

---

### Issue: UI Loads But Shows Errors

**Check browser console:**
1. Open DevTools (F12)
2. Check Console tab for errors
3. Check Network tab for failed requests

**Common causes:**
1. **API endpoint wrong** - Check `VITE_API_BASE_URL`
2. **CORS errors** - Check backend CORS configuration
3. **SSL certificate issues** - Check Nginx Proxy Manager

**Solution:**
```bash
# Verify environment variables
docker exec scrapalot-ui cat /app/.env.production

# Check if API is accessible
curl https://scrapalot.app/api/v1/health
```

---

### Issue: 502 Bad Gateway

**Possible causes:**
1. UI container not running
2. Nginx proxy misconfigured
3. Docker network issues

**Check:**
```bash
# 1. Check UI is running
docker ps | grep scrapalot-ui

# 2. Check Nginx Proxy Manager configuration
# Access: https://routes.scrapalot.app
# Verify proxy host for scrapalot.app points to scrapalot-ui:3000

# 3. Test internal connectivity
docker exec nginx-proxy-manager wget --spider -q http://scrapalot-ui:3000
```

**Solution:**
```bash
# Restart UI container
docker compose -f docker-compose.yaml restart scrapalot-ui

# Restart Nginx Proxy Manager
docker compose -f docker-compose.yaml restart nginx-proxy-manager
```

---

### Issue: Slow Loading / Performance Issues

**Check resource usage:**
```bash
# Check container stats
docker stats scrapalot-ui

# Check server resources
htop
df -h
```

**Optimize:**
```bash
# 1. Enable production optimizations (already in .env.production)
# 2. Check if assets are being cached
# 3. Consider enabling CDN for static assets

# Restart with fresh build
cd /opt/scrapalot/scrapalot-ui
docker build --no-cache -f Dockerfile -t scrapalot-ui:latest .
cd /opt/scrapalot/scrapalot-chat/docker-scrapalot
docker compose -f docker-compose.yaml up -d scrapalot-ui
```

---

### Issue: OAuth Login Not Working

**Check:**
1. **Redirect URI** - Must match Google OAuth configuration
2. **Backend API** - Must be accessible
3. **Cookies** - Check browser allows cookies

**Verify:**
```bash
# Check backend OAuth endpoint
curl https://scrapalot.app/api/v1/auth/google

# Check redirect URI in GitHub secrets
# Should be: https://scrapalot.app/api/v1/auth/google/callback
```

**Solution:**
1. Update `GOOGLE_OAUTH_REDIRECT_URI` in backend secrets
2. Update authorized redirect URIs in Google Cloud Console
3. Redeploy backend and UI

---

### Issue: WebSocket Connection Failed

**Check browser console:**
```
WebSocket connection to 'wss://scrapalot.app/...' failed
```

**Solution:**
Ensure Nginx Proxy Manager has WebSocket support enabled:

1. Access: `https://routes.scrapalot.app`
2. Edit proxy host for `scrapalot.app`
3. **Details** tab → **Websockets Support**
4. Save and test again

---

### Issue: 502 / 1006 on `/stomp-direct/ws` or `/api/ws/notes/*` after a Python restart

**Symptom:**
After restarting `scrapalot-chat` (e.g. to pick up gRPC changes, or after an
OOM recovery), the browser logs:
```
wss://api.scrapalot.app/stomp-direct/ws failed (1006)
wss://api.scrapalot.app/api/ws/notes/<id> failed (1006)
```
…while `wss://api.scrapalot.app/stomp-backend/ws` (Kotlin) still works.

**Cause:**
Nginx Proxy Manager ships a custom override at
`/data/nginx/custom/server_proxy.conf` that proxies the Python WebSocket
paths directly to `scrapalot-chat:8090`, bypassing the gateway. NGINX
resolves container hostnames **once at startup** and caches the IP
forever. Docker assigns a new IP to `scrapalot-chat` on every restart, so
the cached IP goes stale and NGINX logs `connect() failed (111: Connection
refused)` → returns 502 → browser sees 1006 abnormal close.

A quick probe confirms the stale IP:
```bash
docker exec nginx-proxy-manager tail -20 /data/logs/proxy-host-6_error.log
# connect() failed (111: Connection refused) upstream: "http://172.30.0.12:8090/..."

docker inspect scrapalot-chat --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'
# 172.28.1.3  172.30.0.10   ← real IP differs from the cached 172.30.0.12
```

**Quick fix (one-time):**
```bash
docker exec nginx-proxy-manager nginx -s reload
```
Reload re-resolves container hostnames and caches the new IPs.

**Permanent fix — use Docker's embedded DNS with a short TTL:**
Edit `/data/nginx/custom/server_proxy.conf` and wrap every upstream in a
variable + declare the Docker resolver at file scope. This makes NGINX
re-resolve the hostname every 10 s.

```nginx
# Re-resolve Docker container hostnames every 10 s so WebSocket upstreams
# survive a scrapalot-chat restart without a manual `nginx -s reload`.
resolver 127.0.0.11 valid=10s ipv6=off;

location ~ ^/stomp(-direct)?(/.*)?$ {
    set $chat_upstream scrapalot-chat:8090;
    proxy_pass http://$chat_upstream;          # <-- variable, not literal

    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    # ...remaining headers + timeouts unchanged
}

location ~ ^/api/ws/notes(/.*)?$ {
    set $chat_upstream scrapalot-chat:8090;
    proxy_pass http://$chat_upstream;
    # ...
}

location /api/v1/chat/completions {
    set $gw_upstream scrapalot-gw:8080;
    proxy_pass http://$gw_upstream;
    # ...
}
```

Key points:
- `127.0.0.11` is Docker's embedded DNS server (always present inside a
  user-defined network).
- `valid=10s` caps the cache TTL; without it NGINX respects Docker's DNS
  TTL which is effectively infinite inside a long-lived worker process.
- `proxy_pass http://$variable` (not a literal hostname) is what forces
  NGINX to hit the resolver on every request — a literal hostname is
  resolved once at config-load time and never again.
- `ipv6=off` avoids an AAAA lookup that Docker's resolver rejects with
  `SERVFAIL` on pure-IPv4 networks.

**Install + reload:**
```bash
# On the host
sudo nano /opt/scrapalot/npm-data/nginx/custom/server_proxy.conf   # adjust path if needed
# or directly inside the container:
docker cp server_proxy.conf nginx-proxy-manager:/data/nginx/custom/server_proxy.conf
docker exec nginx-proxy-manager nginx -t    # syntax check
docker exec nginx-proxy-manager nginx -s reload
```

**Verify:**
```bash
curl -sk -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
     -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
     -H 'Sec-WebSocket-Version: 13' \
     -o /dev/null -w '%{http_code}\n' --max-time 3 \
     'https://api.scrapalot.app/stomp-direct/ws'
# expected: 101
```

The `/stomp-backend/ws` path does not need this because it goes through
the default `location /` block to `scrapalot-gw:8080`, and the gateway
is long-lived — its IP rarely changes.

---

## Maintenance

### Update UI

```bash
# Method 1: Via GitHub Actions
# Push changes to main branch or manually trigger workflow

# Method 2: Manual update
cd /opt/scrapalot/scrapalot-ui
git pull origin main
docker build -f Dockerfile -t scrapalot-ui:latest .
cd /opt/scrapalot/scrapalot-chat/docker-scrapalot
docker compose -f docker-compose.yaml up -d scrapalot-ui
```

### View Logs

```bash
# Real-time logs
docker compose -f docker-compose.yaml logs -f scrapalot-ui

# Last 100 lines
docker compose -f docker-compose.yaml logs --tail=100 scrapalot-ui

# Save logs to file
docker compose -f docker-compose.yaml logs scrapalot-ui > ui-logs.txt
```

### Restart UI

```bash
cd /opt/scrapalot/scrapalot-chat/docker-scrapalot

# Restart UI only
docker compose -f docker-compose.yaml restart scrapalot-ui

# Or stop and start
docker compose -f docker-compose.yaml stop scrapalot-ui
docker compose -f docker-compose.yaml up -d scrapalot-ui
```

### Clean Up Old Images

```bash
# Edit crontab
crontab -e

# Add weekly cleanup (every Sunday at 2 AM)
0 2 * * 0 docker image prune -af --filter "until=168h" && docker container prune -f
```

---

## Security Best Practices

### 1. Environment Variables

- Never commit `.env` files to Git
- Use GitHub Secrets for sensitive values
- Rotate secrets regularly (every 90 days)

### 2. HTTPS Only

- Always use HTTPS in production
- Enable Force SSL in Nginx Proxy Manager
- Enable HSTS headers

### 3. Content Security Policy

Add CSP headers in Nginx Proxy Manager **Advanced** tab:

```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://scrapalot.app;" always;
```

### 4. Regular Updates

```bash
# Update system packages monthly
sudo apt update && sudo apt upgrade

# Update Node.js dependencies
cd /opt/scrapalot/scrapalot-ui
npm audit
npm update
```

---

## Additional Resources

- **Main Deployment Guide:** See backend `README_CLOUD_DEPLOYMENT.md`
- **Infrastructure Guide:** See backend `README_CLOUD_INFRASTRUCTURE.md`
- **Style Guide:** See `README_STYLE.md` in this repository
- **Tiptap Editor:** See `README_TIPTAP.md` in this repository

---

## Common Commands

```bash
# Navigate to docker-compose directory
cd /opt/scrapalot/scrapalot-chat/docker-scrapalot

# Check UI status
docker compose -f docker-compose.yaml ps scrapalot-ui

# View UI logs
docker compose -f docker-compose.yaml logs -f scrapalot-ui

# Restart UI
docker compose -f docker-compose.yaml restart scrapalot-ui

# Rebuild and restart UI
cd /opt/scrapalot/scrapalot-ui
docker build -f Dockerfile -t scrapalot-ui:latest .
cd /opt/scrapalot/scrapalot-chat/docker-scrapalot
docker compose -f docker-compose.yaml up -d scrapalot-ui

# Check UI health
docker exec scrapalot-ui wget --spider -q http://localhost:3000 && echo "UI is healthy" || echo "UI is down"

# Execute command in UI container
docker exec -it scrapalot-ui sh

# View container resource usage
docker stats scrapalot-ui
```

---

**Last Updated:** March 2026
**Version:** 3.2
**Maintained By:** Scrapalot Team
**Architecture:** Microservices with API Gateway (scrapalot-gw)
**UI Secrets:** Only 3 VITE environment variables required
**Frontend Stack:** React 18.3.1 + TypeScript 5.9.3 + Vite 5.4.1
