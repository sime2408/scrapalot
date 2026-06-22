# Cloud Deployment Guide - Scrapalot Gateway (Kotlin/Spring Cloud Gateway)

**Last Updated**: February 9, 2026

Complete guide for deploying Scrapalot API Gateway on Hetzner Cloud production environment.

## Recent Changes

**February 9, 2026** - GitHub Secrets Migration:
- Migrated from repository secrets to environment-specific secrets (dev, rc, prod)
- Added `GH_TOKEN` to Gateway container environment
- Added GitHub CLI commands for secrets management
- Removed all repository secrets (JWT_SECRET, REDIS_PASSWORD)
- Updated CI/CD workflow to use environment secrets

## Table of Contents

1. [Infrastructure Overview](#infrastructure-overview)
2. [Source Code Location](#source-code-location)
3. [Prerequisites](#prerequisites)
4. [GitHub Actions CI/CD](#github-actions-cicd)
5. [Manual Deployment](#manual-deployment)
6. [Troubleshooting](#troubleshooting)

---

## Infrastructure Overview

**Server**: Hetzner Cloud vServer `ubuntu-scrapalot-1` (canonical spec: `scrapalot-chat/docs/README_CLOUD_INFRA_05_INFRASTRUCTURE.md`)
- **CPU**: 8 vCPUs
- **RAM**: 16GB
- **Disk**: 38GB root SSD + 60GB volume (`/mnt/volume-nbg1-1`, Docker data-root)
- **OS**: Ubuntu 24.04 LTS

**Networking**:
- **External**: Port 8080 (proxied via Nginx)
- **Public URL**: https://api.scrapalot.app
- **Internal**: Docker network `docker-scrapalot_scrapalot-network`

**Architecture**:
```
Client → Nginx (SSL termination, :443) → Gateway (:8080) → Backend (:8091) / Chat (:8090)
```

**Dependencies**:
- Nginx Proxy Manager (SSL, ports 80, 443)
- scrapalot-backend (Kotlin, port 8091)
- scrapalot-chat (Python, port 8090)
- Redis (port 6379) - Rate limiting and session affinity

---

## Source Code Location

**⚠️ CRITICAL**: Source code is in `/opt/scrapalot/scrapalot-gw/`, NOT in GitHub runner workspace.

```
/opt/scrapalot/
├── scrapalot-gw/            Source code (persistent)
├── scrapalot-backend/       Source code
├── scrapalot-chat/          Source code
├── scrapalot-ui/            Source code
└── actions-runner-gw/       ❌ GitHub runner (temporary checkout only)
    └── _work/
        └── scrapalot-gw/
            └── scrapalot-gw/  ❌ DO NOT use this directory
```

**Why this structure?**
- Source code in `/opt/scrapalot/` is persistent and accessible
- GitHub runner workspace is temporary and gets cleaned
- Multiple users (scrapalot, github-runner) can access `/opt/scrapalot/`
- Matches structure of all other services (backend, chat, ui)

**Permissions**:
```bash
Owner: github-runner:scrapalot
Permissions: 775 (rwxrwxr-x)
Group sticky bit: All new files inherit 'scrapalot' group
```

---

## Prerequisites

### 1. Java OpenJDK 21

**Installed on production server** for manual Gradle builds:

```bash
# Check Java version
java -version
# Output: openjdk version "21.0.x"

# Java location
which java
# /usr/bin/java

# JAVA_HOME
echo $JAVA_HOME
# /usr/lib/jvm/java-21-openjdk-amd64
```

**Installation** (if needed):
```bash
sudo apt update
sudo apt install -y openjdk-21-jdk
```

### 2. Docker & Docker Compose

```bash
# Docker version
docker --version
# Docker version 24.x

# Docker Compose version
docker compose version
# Docker Compose version v2.x
```

### 3. Gradle

**Using Gradle Wrapper** (recommended):
```bash
cd /opt/scrapalot/scrapalot-gw
./gradlew --version
# Gradle 8.12
```

**No system Gradle installation required** - use `./gradlew` wrapper.

---

## GitHub Actions CI/CD

### Workflow File

Located at: `.github/workflows/deploy-gateway.yml`

**Trigger**:
- Push to `main` branch (auto-deploy)
- Manual dispatch via GitHub UI

**Workflow Steps**:

1. **Checkout code** → temporary folder `scrapalot-gw/`
2. **Copy to deployment directory** → `/opt/scrapalot/scrapalot-gw/`
3. **Fix permissions** → `chgrp -R scrapalot`, `chmod -R g+rw`
4. **Build Docker image** → Multi-stage Dockerfile build
5. **Deploy using docker-compose** → `docker compose up -d scrapalot-gw`
6. **Health check** → Wait for `/actuator/health` to be UP
7. **Verify routes** → Test routing to backend/chat services
8. **Cleanup** → Remove old Docker images

### Environment Variables (GitHub Secrets)

**⚠️ IMPORTANT**: As of February 2026, secrets are configured per environment (dev, rc, prod), NOT as repository secrets.

**Configuration Location**: https://github.com/sime2408/scrapalot-gw/settings/environments

Required secrets for each environment (dev, rc, prod):

- `JWT_SECRET` - JWT signing key (MUST match backend)
- `REDIS_PASSWORD` - Redis password
- `GH_TOKEN` - GitHub Personal Access Token (for CI/CD and API access)

Required environment variables (not secrets):

- `CORS_ALLOWED_ORIGINS` - CORS origins (https://scrapalot.app)

**Migration from Repository Secrets** (February 2026):
- Migrated: JWT_SECRET, REDIS_PASSWORD, GH_TOKEN → per-environment secrets
- ❌ Removed: All repository secrets (use environment-specific secrets instead)
- ℹ️ Benefit: Different values for dev, rc, prod environments

### Configuring GitHub Environments

**Setup Instructions**:

1. **Navigate to GitHub Environments**:
   - Go to: https://github.com/sime2408/scrapalot-gw/settings/environments
   - Create environments: `dev`, `rc`, `prod` (if not exist)

2. **Add secrets to each environment** (via Web UI or CLI):

   **Option A: GitHub Web UI**:
   - Click on environment name (e.g., `prod`)
   - Click "Add environment secret"
   - Add each secret:
     - Name: `JWT_SECRET`, Value: `<your-jwt-secret>`
     - Name: `REDIS_PASSWORD`, Value: `<your-redis-password>`
     - Name: `GH_TOKEN`, Value: `<your-github-token>`

   **Option B: GitHub CLI** (faster for multiple environments):
   ```bash
   # Add secrets to prod environment
   gh secret set JWT_SECRET --env prod --body "your-jwt-secret-here"
   gh secret set REDIS_PASSWORD --env prod --body "your-redis-password-here"
   gh secret set GH_TOKEN --env prod --body "your-github-token-here"

   # Add to rc environment
   gh secret set JWT_SECRET --env rc --body "your-jwt-secret-here"
   gh secret set REDIS_PASSWORD --env rc --body "your-redis-password-here"
   gh secret set GH_TOKEN --env rc --body "your-github-token-here"

   # Add to dev environment
   gh secret set JWT_SECRET --env dev --body "your-jwt-secret-here"
   gh secret set REDIS_PASSWORD --env dev --body "your-redis-password-here"
   gh secret set GH_TOKEN --env dev --body "your-github-token-here"

   # Verify secrets were added
   gh secret list --env prod
   gh secret list --env rc
   gh secret list --env dev
   ```

3. **Remove old repository secrets** (if migrating):
   ```bash
   # List current repository secrets
   gh secret list --repo sime2408/scrapalot-gw

   # Remove repository secrets (now using environment-specific secrets)
   gh secret remove JWT_SECRET --repo sime2408/scrapalot-gw
   gh secret remove REDIS_PASSWORD --repo sime2408/scrapalot-gw
   ```

5. **Verify workflow uses environment**:
   - Workflow file: `.github/workflows/deploy-gateway.yml`
   - Line 49: `environment: ${{ github.event.inputs.environment || 'prod' }}`
   - This ensures secrets are loaded from the correct environment

6. **Test deployment**:
   ```bash
   # Trigger manual deployment to prod
   gh workflow run deploy-gateway.yml -f environment=prod

   # Check workflow logs
   gh run list --workflow=deploy-gateway.yml
   ```

**How Workflow Selects Environment**:
- **Auto-deploy** (push to main): Uses `prod` environment by default
- **Manual dispatch**: Select environment via dropdown (dev, rc, prod)

### Deployment Method

**Gateway is deployed via docker-compose** (not `docker run`):

```bash
docker compose -f /opt/scrapalot/scrapalot-chat/docker-scrapalot/docker-compose.yaml up -d scrapalot-gw
```

**Why docker-compose?**
- Automatic dependency management (waits for backend, chat, redis)
- Service health checks built-in
- Centralized configuration in one file
- Easy to update and restart

---

## Manual Deployment

### Option 1: Using GitHub Actions (Recommended)

1. **Push changes to main branch**:
   ```bash
   cd /opt/scrapalot/scrapalot-gw
   git add .
   git commit -m "Your changes"
   git push origin main
   ```

2. **GitHub Actions will automatically**:
   - Build Docker image
   - Deploy via docker-compose
   - Run health checks

3. **Monitor deployment**:
   - GitHub Actions: https://github.com/sime2408/scrapalot-gw/actions
   - Container logs: `docker logs -f scrapalot-gw`

### Option 2: Manual Build & Deploy

**Prerequisites**: Must be in `/opt/scrapalot/scrapalot-gw/`

```bash
# 1. Navigate to source code
cd /opt/scrapalot/scrapalot-gw

# 2. Pull latest changes
git pull origin main

# 3. Build Docker image
docker build -t scrapalot-gw:latest .

# 4. Deploy using docker-compose
docker compose -f /opt/scrapalot/scrapalot-chat/docker-scrapalot/docker-compose.yaml up -d scrapalot-gw

# 5. Check health
sleep 10  # Wait for startup
curl -f http://localhost:8080/actuator/health
# Expected: {"status":"UP"}
```

### Option 3: Docker Run (Alternative)

**If docker-compose is not available**:

```bash
cd /opt/scrapalot/scrapalot-gw

# Build JAR first
./gradlew clean bootJar --no-daemon

# Build Docker image
docker build -t scrapalot-gw:latest .

# Stop existing container
docker stop scrapalot-gw || true
docker rm scrapalot-gw || true

# Start new container
docker run -d \
  --name scrapalot-gw \
  --network docker-scrapalot_scrapalot-network \
  -p 8080:8080 \
  -e SPRING_PROFILES_ACTIVE=prod \
  -e JWT_SECRET=your_jwt_secret \
  -e REDIS_HOST=redis \
  -e REDIS_PORT=6379 \
  -e REDIS_PASSWORD=your_redis_password \
  -e BACKEND_URL=http://scrapalot-backend:8091 \
  -e CHAT_URL=http://scrapalot-chat:8090 \
  --restart unless-stopped \
  scrapalot-gw:latest
```

---

## Docker Compose Configuration

**Location**: `/opt/scrapalot/scrapalot-chat/docker-scrapalot/docker-compose.yaml`

**Gateway service definition**:
```yaml
scrapalot-gw:
  image: scrapalot-gw:latest
  container_name: scrapalot-gw
  ports:
    - "8080:8080"
  depends_on:
    scrapalot-backend:
      condition: service_healthy
    scrapalot-chat:
      condition: service_healthy
    redis:
      condition: service_healthy
  environment:
    SPRING_PROFILES_ACTIVE: prod
    JWT_SECRET: ${JWT_SECRET}
    REDIS_HOST: redis
    REDIS_PORT: 6379
    REDIS_PASSWORD: ${REDIS_PASSWORD}
    BACKEND_URL: http://scrapalot-backend:8091
    CHAT_URL: http://scrapalot-chat:8090
```

**Health check**:
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8080/actuator/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 60s
```

---

## Troubleshooting

### Build Fails: "Permission denied: ./gradlew"

**Problem**: Gradle wrapper not executable

**Solution**:
```bash
cd /opt/scrapalot/scrapalot-gw
chmod +x gradlew
```

### Build Fails: "JAVA_HOME not set"

**Problem**: Java not found

**Solution**:
```bash
# Check Java installation
java -version

# If not installed
sudo apt install -y openjdk-21-jdk

# Set JAVA_HOME (if needed)
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
```

### Deployment Fails: "Error response from daemon: Conflict. The container name '/scrapalot-backend' is already in use"

**Problem**: docker-compose tries to create backend container, but it's already running outside docker-compose

**Solution**:
```bash
# Use --no-deps to deploy Gateway without recreating dependencies
docker compose -f /opt/scrapalot/scrapalot-chat/docker-scrapalot/docker-compose.yaml up -d --no-deps scrapalot-gw
```

### Container Fails to Start: "Cannot connect to backend"

**Problem**: Backend or Chat services not running

**Solution**:
```bash
# Check all services are running
docker ps | grep -E "scrapalot-(backend|chat|gw)"

# Start missing services
docker start scrapalot-backend
docker start scrapalot-chat

# Or use docker-compose
cd /opt/scrapalot/scrapalot-chat/docker-scrapalot
docker compose up -d
```

### Health Check Fails: "Connection refused"

**Problem**: Gateway not ready or crashed

**Solution**:
```bash
# Check container status
docker ps -a | grep scrapalot-gw

# Check logs
docker logs scrapalot-gw --tail 100

# Check if port 8080 is in use
sudo netstat -tlnp | grep 8080

# Check Redis connection
docker exec scrapalot-gw curl redis:6379 || echo "Cannot reach Redis"
```

### Routing Fails: "502 Bad Gateway"

**Problem**: Backend/Chat services are unreachable

**Solution**:
```bash
# Test connectivity from Gateway container
docker exec scrapalot-gw curl -f http://scrapalot-backend:8091/actuator/health
docker exec scrapalot-gw curl -f http://scrapalot-chat:8090/health

# Check Docker network
docker network inspect docker-scrapalot_scrapalot-network

# Verify all services are on same network
docker inspect scrapalot-gw | grep NetworkMode
docker inspect scrapalot-backend | grep NetworkMode
docker inspect scrapalot-chat | grep NetworkMode
```

### CI/CD Fails: "Image build failed"

**Problem**: Docker build context issue

**Solution**:
```bash
# Verify Dockerfile exists
ls -la /opt/scrapalot/scrapalot-gw/Dockerfile

# Try building manually to see error
cd /opt/scrapalot/scrapalot-gw
docker build -t scrapalot-gw:latest . --no-cache
```

### WebSocket Connection Fails

**Problem**: WebSocket routing not working

**Solution**:
```bash
# Check Gateway WebSocket routes in application.yml
cat /opt/scrapalot/scrapalot-gw/src/main/resources/application.yml | grep -A10 "websocket"

# Test WebSocket endpoint
wscat -c wss://api.scrapalot.app/stomp-direct/ws?token=YOUR_JWT

# Check Nginx WebSocket headers
curl -I https://api.scrapalot.app/stomp-direct/ws \
  -H "Upgrade: websocket" \
  -H "Connection: Upgrade"
```

---

## Deployment Checklist

Before deploying to production:

- [ ] Source code is in `/opt/scrapalot/scrapalot-gw/`
- [ ] Permissions are correct (`github-runner:scrapalot`, 775)
- [ ] Java 21 is installed
- [ ] Docker network exists (`docker-scrapalot_scrapalot-network`)
- [ ] Backend container is running (scrapalot-backend:8091)
- [ ] Chat container is running (scrapalot-chat:8090)
- [ ] Redis container is running (redis:6379)
- [ ] GitHub secrets are configured (JWT_SECRET, REDIS_PASSWORD)
- [ ] Nginx is configured to proxy port 8080
- [ ] SSL certificates are valid (Let's Encrypt)
- [ ] Health endpoint responds: `http://localhost:8080/actuator/health`
- [ ] Routes are working: Test backend and chat routing

---

## Nginx Configuration

**Location**: `/data/nginx/proxy_host/6.conf` (Nginx Proxy Manager)

**Key configuration**:
```nginx
server {
  listen 443 ssl;
  server_name api.scrapalot.app;

  # Proxy to Gateway
  location / {
    proxy_pass http://scrapalot-gw:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket support
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

**CORS**: Handled by Gateway (Spring Cloud Gateway globalcors), NOT by Nginx.

---

## Additional Resources

**Related Documentation**:
- `README.md` - Gateway overview
- `CLAUDE.md` - Gateway configuration guide
- `/opt/scrapalot/CLAUDE.md` - Workspace-wide guidance
- `/opt/scrapalot/scrapalot-backend/docs/README_CLOUD_DEPLOYMENT.md` - Backend deployment

**Container Management**:
```bash
# Restart gateway
docker restart scrapalot-gw

# View logs
docker logs -f scrapalot-gw

# Access container shell
docker exec -it scrapalot-gw sh

# Check routes
docker exec scrapalot-gw curl http://localhost:8080/actuator/gateway/routes
```

**Testing Routes**:
```bash
# Test backend route
curl -H "Authorization: Bearer YOUR_JWT" https://api.scrapalot.app/api/v1/workspaces

# Test chat route
curl -H "Authorization: Bearer YOUR_JWT" https://api.scrapalot.app/api/v1/chat

# Test WebSocket
wscat -c wss://api.scrapalot.app/stomp-direct/ws?token=YOUR_JWT
```

---

**For Backend deployment**: See `/opt/scrapalot/scrapalot-backend/docs/README_CLOUD_DEPLOYMENT.md`
