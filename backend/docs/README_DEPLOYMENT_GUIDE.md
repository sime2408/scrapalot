# Scrapalot Backend - Comprehensive Deployment Guide

**Version**: 2.1.0
**Last Updated**: March 2026
**Status**: Migration COMPLETE

Complete guide for deploying the Scrapalot Kotlin Backend - covering local development, production JAR/Docker deployment, and automated cloud deployment with GitHub Actions.

---

## 📋 Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Local Development Setup](#local-development-setup)
4. [Production Deployment](#production-deployment)
   - [JAR Deployment](#option-1-jar-deployment)
   - [Docker Deployment](#option-2-docker-deployment)
   - [Cloud Deployment (GitHub Actions)](#option-3-cloud-deployment-github-actions)
5. [Infrastructure Setup](#infrastructure-setup)
6. [Database Migration](#database-migration)
7. [Monitoring & Health Checks](#monitoring--health-checks)
8. [Troubleshooting](#troubleshooting)
9. [Performance Tuning](#performance-tuning)
10. [Security Checklist](#security-checklist)
11. [Backup Strategy](#backup-strategy)
12. [Production Readiness](#production-readiness-checklist)

---

## Architecture Overview

### Gateway-Based Microservices Architecture

Scrapalot uses a **three-tier architecture** with API Gateway as the entry point:

```
UI (React) → API Gateway (8080) → Kotlin Backend (8091) ⟷ gRPC ⟷ Python CHAT (8090)
                                         ↓                           ↓
                                    PostgreSQL                  PostgreSQL
                                    (scrapalot_backend)         (scrapalot)
                                         ↓                           ↓
                                    Redis (DB 1)                Redis (DB 0)
                                         ↓                           ↓
                                         └──────── Pub/Sub ──────────┘
```

### Service Responsibilities

**API Gateway** (`scrapalot-gw:8080`):
- Single entry point for ALL client requests
- Routes traffic based on path patterns
- Load balancing, circuit breakers, retries
- **Routes**: `POST /api/v1/**` to appropriate backend

**Kotlin Backend** (`scrapalot-backend:8091`):
- **OWNS**: ALL user-facing operations
  - Authentication (JWT, OAuth, sessions)
  - Users, Workspaces, Collections
  - Documents (metadata only)
  - Notes & collaboration
  - Settings, Billing, API keys
  - Chat proxy (sessions, messages)
- **gRPC Server** on port 9090 (Python calls this)
- **WebSocket** for real-time notifications
- **Database**: `scrapalot_backend` (PostgreSQL)

**Python CHAT** (`scrapalot-chat:8090`):
- **OWNS**: PURE AI/ML operations
  - RAG (18 strategies + 11 orchestrators)
  - LLM integration (OpenAI, Anthropic, etc.)
  - Document processing (parsing, OCR, chunking)
  - Embeddings & vector search
  - Knowledge graph (Neo4j)
  - Deep Research (5-phase system)
- **gRPC Client** (calls Kotlin for minimal data needs)
- **NO user awareness**, NO authentication, NO REST API
- **Database**: `scrapalot` (PostgreSQL with pgvector)

### Communication Flow

**User Operations** (UI → Gateway → Kotlin):
```
POST /api/v1/auth/login       → Kotlin (Auth)
GET  /api/v1/workspaces       → Kotlin (User data)
POST /api/v1/documents/upload → Kotlin (Metadata + gRPC to Python)
GET  /api/v1/notes            → Kotlin (Notes)
```

**AI/ML Operations** (Kotlin → Python via gRPC):
```
Kotlin: RAGQueryRequest     → [gRPC:9091] → Python: Process RAG
Kotlin: ProcessDocumentReq  → [gRPC:9091] → Python: Parse & Embed
Kotlin: GetSettingsRequest  → [gRPC:9091] → Python: Use settings
```

**Event Broadcasting** (Bidirectional via Redis Pub/Sub):
```
Kotlin publishes:     Python publishes:
- DOCUMENT_UPLOADED   - DOCUMENT_PROCESSING_PROGRESS
- COLLECTION_CREATED  - RAG_QUERY_COMPLETED
- SETTINGS_UPDATED    - EMBEDDING_COMPLETED
- NOTE_UPDATED        - DEEP_RESEARCH_PROGRESS
```

**For complete architecture details, see**: [`README_ARCHITECTURE.md`](./README_ARCHITECTURE.md) and [`README_MIGRATION_PRD_USER_ABSTRACTION.md`](./README_MIGRATION_PRD_USER_ABSTRACTION.md)

---

## Prerequisites

### Required Software

**For Local Development:**
- **Java 21 LTS** (Amazon Corretto, OpenJDK, or Oracle JDK)
- **Kotlin 2.1.0** (with context receivers enabled)
- **Gradle 8.12** (via wrapper - `./gradlew`)
- **Spring Boot 3.4.1**
- **PostgreSQL 18+** (for database)
- **Redis 7+** (for caching and pub/sub)
- **Docker** (optional, for containerized services)

**Technology Stack:**
- **gRPC**: 1.62.2 (server + client)
- **Liquibase**: 4.30.0 (database migrations)
- **MapStruct**: 1.6.3 (DTO mapping)
- **Springdoc OpenAPI**: 2.7.0 (API documentation)
- **JWT**: 0.12.6 (authentication)
- **Testcontainers**: 1.20.4 (testing)

**For Production Deployment:**
- **Java 21 LTS** (runtime environment)
- **PostgreSQL 18+** (pgvector Docker container)
- **Redis** (shared with Python backend, databases 0 and 1)
- **Docker** (for container deployment)
- **Nginx** (for reverse proxy and SSL)

### Cloud Infrastructure (Production)

**Hetzner Server**:
- **Current**: CX43 (8 vCPUs, 16GB RAM, 40GB SSD)
- **OS**: Ubuntu 24.04 LTS
- **Recommended**: CX43 or higher (dual-backend architecture)

**PostgreSQL** (pgvector Docker container):
- Database: `scrapalot_backend`
- Schema: `scrapalot`
- Port: 5432
- Connection pooling: Max 30 connections

**Redis Server**:
- Running on the same server (Docker container)
- Database 0: Python backend
- Database 1: Kotlin backend
- Pub/Sub for event broadcasting

**GitHub Actions Runner**:
- Self-hosted runner for `scrapalot-backend` repository
- Location: `/opt/scrapalot/actions-runner-backend`
- User: `github-runner` with Docker access
- Labels: `hetzner`, `production`

**Domain Configuration**:
- Domain: `scrapalot.app`
- API subdomain: `api.scrapalot.app`
- SSL certificates: Let's Encrypt via Nginx Proxy Manager

### Required Environment Variables

See `.env.example` for complete list. Critical variables:

```bash
# Server
SPRING_PROFILES_ACTIVE=prod
SERVER_PORT=8091
GRPC_SERVER_PORT=9090

# Database
POSTGRES_BACKEND_HOST=pgvector
POSTGRES_BACKEND_PORT=5432
POSTGRES_BACKEND_DB=scrapalot_backend
POSTGRES_BACKEND_USER=scrapalot
POSTGRES_BACKEND_PASSWORD=strong-password-here

# Security
JWT_SECRET=your-production-secret-min-256-bits-change-this
CORS_ALLOWED_ORIGINS=https://scrapalot.app,https://app.scrapalot.app

# OAuth
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-your-secret
GOOGLE_OAUTH_REDIRECT_URI=https://api.scrapalot.app/api/v1/auth/google/callback
FRONTEND_URL=https://scrapalot.app

# Redis
REDIS_ENABLED=true
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=your-redis-password
REDIS_DATABASE=1  # Kotlin uses DB 1, Python uses DB 0

# Logging
LOG_LEVEL_ROOT=WARN
LOG_LEVEL_APP=INFO

# Production Security
SPRINGDOC_ENABLED=false
SWAGGER_UI_ENABLED=false
```

---

## Local Development Setup

### 1. Start Required Services

**Using Docker Compose**:
```bash
cd docker-scrapalot
docker-compose --profile local up -d postgres-backend redis
```

**Or install PostgreSQL manually**:
```bash
# Create database
psql -U postgres
CREATE DATABASE scrapalot_backend;
CREATE USER scrapalot WITH PASSWORD 'scrapalot123';
GRANT ALL PRIVILEGES ON DATABASE scrapalot_backend TO scrapalot;

# Create schema
\c scrapalot_backend
CREATE SCHEMA IF NOT EXISTS scrapalot;
GRANT ALL ON SCHEMA scrapalot TO scrapalot;
```

**Or install Redis manually**:
```bash
# Ubuntu/Debian
sudo apt install redis-server
sudo systemctl start redis-server

# macOS
brew install redis
brew services start redis
```

### 2. Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit with your local configuration
nano .env
```

**Minimal local `.env`**:
```bash
SPRING_PROFILES_ACTIVE=dev
POSTGRES_BACKEND_HOST=localhost
POSTGRES_BACKEND_PORT=5432
POSTGRES_BACKEND_DB=scrapalot_backend
POSTGRES_BACKEND_USER=scrapalot
POSTGRES_BACKEND_PASSWORD=scrapalot123
JWT_SECRET=local-dev-secret-min-32-chars-change-this-in-prod
REDIS_ENABLED=true
REDIS_HOST=localhost
REDIS_PORT=6379
```

### 3. Build and Run

```bash
# Build project
./gradlew clean build

# Run with dev profile (CORS enabled for localhost:3000)
./gradlew bootRun --args='--spring.profiles.active=dev'

# Or run JAR directly
java -jar build/libs/scrapalot-backend-1.0.0.jar --spring.profiles.active=dev
```

**Dev Profile Features**:
- CORS enabled for `localhost:3000`, `localhost:5173` (Vite)
- Swagger UI available at `/api/v1/swagger-ui.html`
- Detailed logging (DEBUG level)
- H2 console (if configured)

### 4. Verify Installation

```bash
# Health check
curl http://localhost:8091/actuator/health

# Expected response:
# {"status":"UP"}

# Swagger UI (dev only)
open http://localhost:8091/api/v1/swagger-ui.html

# gRPC health check (if grpcurl installed)
grpcurl -plaintext localhost:9090 list
```

### 5. Run Tests

```bash
# Run all tests
./gradlew test

# Run specific test class
./gradlew test --tests "*UserServiceTest"

# Run with coverage
./gradlew test jacocoTestReport

# Coverage report at: build/reports/jacoco/test/html/index.html
```

---

## Production Deployment

### Option 1: JAR Deployment

Suitable for traditional server deployments with systemd service management.

#### 1. Build Production JAR

```bash
# Clean and build with production profile
./gradlew clean build -Pprod

# JAR created at: build/libs/scrapalot-backend-1.0.0.jar
# Size: ~80-100 MB (includes all dependencies)
```

#### 2. Configure Production Environment

Create `/etc/scrapalot/backend.env`:

```bash
# Server Configuration
SPRING_PROFILES_ACTIVE=prod
SERVER_PORT=8091
GRPC_SERVER_PORT=9090

# Database Configuration
POSTGRES_BACKEND_HOST=pgvector
POSTGRES_BACKEND_PORT=5432
POSTGRES_BACKEND_DB=scrapalot_backend
POSTGRES_BACKEND_USER=scrapalot
POSTGRES_BACKEND_PASSWORD=your-strong-password

# Security Configuration
JWT_SECRET=your-production-secret-min-256-bits-change-this
CORS_ALLOWED_ORIGINS=https://scrapalot.app,https://app.scrapalot.app

# OAuth Configuration
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-your-secret
GOOGLE_OAUTH_REDIRECT_URI=https://api.scrapalot.app/api/v1/auth/google/callback
FRONTEND_URL=https://app.scrapalot.app

# Redis Configuration
REDIS_ENABLED=true
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your-redis-password
REDIS_DATABASE=1

# Logging Configuration
LOG_LEVEL_ROOT=WARN
LOG_LEVEL_APP=INFO

# Production Security
SPRINGDOC_ENABLED=false
SWAGGER_UI_ENABLED=false
```

#### 3. Create Systemd Service

Create `/etc/systemd/system/scrapalot-backend.service`:

```ini
[Unit]
Description=Scrapalot Backend Service (Kotlin)
After=network.target postgresql.service redis.service
Wants=postgresql.service redis.service

[Service]
Type=simple
User=scrapalot
Group=scrapalot
WorkingDirectory=/opt/scrapalot-backend

# Load environment variables
EnvironmentFile=/etc/scrapalot/backend.env

# Java options
Environment="JAVA_OPTS=-Xms512m -Xmx2g -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -XX:+UseStringDeduplication"

# Run application
ExecStart=/usr/bin/java $JAVA_OPTS \
    -jar /opt/scrapalot-backend/scrapalot-backend-1.0.0.jar \
    --spring.profiles.active=prod

# Restart policy
Restart=always
RestartSec=10

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=scrapalot-backend

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/log/scrapalot-backend /var/scrapalot/uploads

[Install]
WantedBy=multi-user.target
```

#### 4. Deploy and Start Service

```bash
# Create directory structure
sudo mkdir -p /opt/scrapalot-backend
sudo mkdir -p /var/log/scrapalot-backend
sudo mkdir -p /var/scrapalot/uploads

# Copy JAR
sudo cp build/libs/scrapalot-backend-1.0.0.jar /opt/scrapalot-backend/

# Set ownership and permissions
sudo chown -R scrapalot:scrapalot /opt/scrapalot-backend
sudo chown -R scrapalot:scrapalot /var/log/scrapalot-backend
sudo chown -R scrapalot:scrapalot /var/scrapalot
sudo chmod 600 /etc/scrapalot/backend.env  # Protect secrets

# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable scrapalot-backend
sudo systemctl start scrapalot-backend

# Check status
sudo systemctl status scrapalot-backend

# View logs
sudo journalctl -u scrapalot-backend -f --lines 100
```

---

### Option 2: Docker Deployment

Recommended for containerized environments with easier scaling and isolation.

#### 1. Dockerfile Configuration

The project includes a multi-stage Dockerfile:

```dockerfile
# Build stage
FROM eclipse-temurin:21-jre-jammy AS builder

WORKDIR /app
COPY gradlew .
COPY gradle gradle
COPY build.gradle.kts .
COPY settings.gradle.kts .
COPY src src

RUN chmod +x gradlew
RUN ./gradlew clean build -x test

# Runtime stage
FROM eclipse-temurin:21-jre-jammy

WORKDIR /app

# Create non-root user
RUN addgroup -S scrapalot && adduser -S scrapalot -G scrapalot

# Copy JAR from builder
COPY --from=builder /app/build/libs/*.jar app.jar

# Create directories
RUN mkdir -p /var/log/scrapalot-backend /var/scrapalot/uploads && \
    chown -R scrapalot:scrapalot /app /var/log/scrapalot-backend /var/scrapalot

USER scrapalot

# Expose ports
EXPOSE 8091 9090

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:8091/actuator/health || exit 1

ENTRYPOINT ["java", "-Xms512m", "-Xmx2g", "-XX:+UseG1GC", "-jar", "app.jar"]
```

#### 2. Build Docker Image

```bash
# Build image
docker build -t scrapalot-backend:1.0.0 .

# Tag for registry
docker tag scrapalot-backend:1.0.0 your-registry/scrapalot-backend:1.0.0

# Push to registry (if using private registry)
docker push your-registry/scrapalot-backend:1.0.0
```

#### 3. Docker Compose Configuration

Create `docker-compose.prod.yaml`:

```yaml
version: '3.8'

services:
  scrapalot-backend:
    image: scrapalot-backend:1.0.0
    container_name: scrapalot-backend
    restart: unless-stopped
    ports:
      - "8091:8091"  # REST API
      - "9090:9090"  # gRPC Server
    environment:
      SPRING_PROFILES_ACTIVE: prod
      POSTGRES_BACKEND_HOST: ${POSTGRES_BACKEND_HOST}
      POSTGRES_BACKEND_PORT: ${POSTGRES_BACKEND_PORT}
      POSTGRES_BACKEND_DB: ${POSTGRES_BACKEND_DB}
      POSTGRES_BACKEND_USER: ${POSTGRES_BACKEND_USER}
      POSTGRES_BACKEND_PASSWORD: ${POSTGRES_BACKEND_PASSWORD}
      JWT_SECRET: ${JWT_SECRET}
      CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS}
      GOOGLE_OAUTH_CLIENT_ID: ${GOOGLE_OAUTH_CLIENT_ID}
      GOOGLE_OAUTH_CLIENT_SECRET: ${GOOGLE_OAUTH_CLIENT_SECRET}
      GOOGLE_OAUTH_REDIRECT_URI: ${GOOGLE_OAUTH_REDIRECT_URI}
      FRONTEND_URL: ${FRONTEND_URL}
      REDIS_ENABLED: true
      REDIS_HOST: redis
      REDIS_PORT: 6379
      REDIS_PASSWORD: ${REDIS_PASSWORD}
      REDIS_DATABASE: 1
      SPRINGDOC_ENABLED: false
      SWAGGER_UI_ENABLED: false
    volumes:
      - backend-uploads:/var/scrapalot/uploads
      - backend-logs:/var/log/scrapalot-backend
    networks:
      - scrapalot-network
    depends_on:
      - redis
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8091/actuator/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  redis:
    image: redis:8-alpine
    container_name: redis
    restart: unless-stopped
    command: redis-server --requirepass ${REDIS_PASSWORD}
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    networks:
      - scrapalot-network
    healthcheck:
      test: ["CMD", "redis-cli", "--raw", "incr", "ping"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  backend-uploads:
  backend-logs:
  redis-data:

networks:
  scrapalot-network:
    driver: bridge
```

#### 4. Deploy with Docker Compose

```bash
# Create .env file with production secrets
cat > .env << 'EOF'
# Database
POSTGRES_BACKEND_HOST=pgvector
POSTGRES_BACKEND_PORT=5432
POSTGRES_BACKEND_DB=scrapalot_backend
POSTGRES_BACKEND_USER=scrapalot
POSTGRES_BACKEND_PASSWORD=your-strong-password

# Security
JWT_SECRET=your-production-secret-min-256-bits
CORS_ALLOWED_ORIGINS=https://scrapalot.app,https://app.scrapalot.app

# OAuth
GOOGLE_OAUTH_CLIENT_ID=your-client-id
GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
GOOGLE_OAUTH_REDIRECT_URI=https://api.scrapalot.app/api/v1/auth/google/callback
FRONTEND_URL=https://scrapalot.app

# Redis
REDIS_PASSWORD=your-redis-password
EOF

# Set proper permissions for secrets
chmod 600 .env

# Start services
docker-compose -f docker-compose.prod.yaml up -d

# View logs
docker-compose -f docker-compose.prod.yaml logs -f scrapalot-backend

# Stop services
docker-compose -f docker-compose.prod.yaml down

# Restart specific service
docker-compose -f docker-compose.prod.yaml restart scrapalot-backend
```

---

### Option 3: Cloud Deployment (GitHub Actions)

**Automated deployment to Hetzner Cloud using GitHub Actions CI/CD**.

#### 1. GitHub Secrets Configuration

Navigate to: `Settings → Secrets and variables → Actions → Repository secrets`

**Required Secrets:**

| Secret Name | Description | Example |
|------------|-------------|---------|
| `POSTGRES_BACKEND_HOST` | PostgreSQL host (pgvector container) | `pgvector` |
| `POSTGRES_BACKEND_PORT` | PostgreSQL port | `5432` |
| `POSTGRES_BACKEND_DB` | Database name | `scrapalot_backend` |
| `POSTGRES_BACKEND_USER` | Database user | `scrapalot_backend_user` |
| `POSTGRES_BACKEND_PASSWORD` | Database password (strong!) | Generate with `openssl rand -base64 32` |
| `JWT_SECRET` | JWT signing secret (min 32 chars) | Generate with `openssl rand -base64 32` |
| `REDIS_PASSWORD` | Redis password | Generate with `openssl rand -base64 32` |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth Client ID | `116849...apps.googleusercontent.com` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth Client Secret | `GOCSPX-...` |

**Required Variables:**

Navigate to: `Settings → Secrets and variables → Actions → Repository variables`

| Variable Name | Value |
|--------------|-------|
| `CORS_ALLOWED_ORIGINS` | `https://scrapalot.app,https://app.scrapalot.app` |
| `GOOGLE_OAUTH_REDIRECT_URI` | `https://api.scrapalot.app/api/v1/auth/google/callback` |
| `FRONTEND_URL` | `https://scrapalot.app` |

**Generate Secrets Script:**

```bash
#!/bin/bash
echo "========================================="
echo "Scrapalot Backend - Secrets Generator"
echo "========================================="
echo ""

echo "# Database Configuration"
echo "POSTGRES_BACKEND_HOST=pgvector"
echo "POSTGRES_BACKEND_PORT=5432"
echo "POSTGRES_BACKEND_DB=scrapalot_backend"
echo "POSTGRES_BACKEND_USER=scrapalot_backend_user"
echo "POSTGRES_BACKEND_PASSWORD=$(openssl rand -base64 32)"
echo ""

echo "# Security Configuration"
echo "JWT_SECRET=$(openssl rand -base64 32)"
echo "REDIS_PASSWORD=$(openssl rand -base64 32)"
echo ""

echo "# OAuth Configuration (Update with your actual values)"
echo "GOOGLE_OAUTH_CLIENT_ID=your_client_id.apps.googleusercontent.com"
echo "GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-your_secret"
echo ""

echo "========================================="
echo "Copy these values to GitHub Secrets"
echo "========================================="
```

#### 2. Deployment Workflow

**Automatic Deployment:**

The backend deploys automatically when you push changes to the `main` branch that affect:
- `src/**` - Source code changes
- `build.gradle.kts` - Dependency changes
- `Dockerfile` - Docker configuration
- `.github/workflows/deploy-backend.yml` - Workflow changes

**Push to Deploy:**
```bash
git add .
git commit -m "Update backend feature"
git push origin main

# GitHub Actions will automatically:
# 1. Build Gradle project
# 2. Run tests
# 3. Build Docker image
# 4. Deploy to Hetzner server
# 5. Restart container
```

**Manual Deployment:**

Trigger via GitHub Actions UI:
1. Go to: https://github.com/YOUR_ORG/scrapalot-backend/actions
2. Select **CICD-Backend-Kotlin** workflow
3. Click **Run workflow**
4. Select environment: `dev`, `rc`, or `prod`
5. Click **Run workflow**

**Monitor Deployment:**
```bash
# SSH into server
ssh hetzner-scrapalot

# Check container status
docker ps | grep scrapalot-backend

# View deployment logs
docker logs scrapalot-backend -f

# Check health
curl https://api.scrapalot.app/actuator/health
```

---

## Infrastructure Setup

### 1. Setup GitHub Actions Runner

**Self-hosted runner is required** for deploying to Hetzner server:

```bash
# SSH into Hetzner server
ssh hetzner-scrapalot

# Create runner directory
mkdir -p /opt/scrapalot/actions-runner-backend
cd /opt/scrapalot/actions-runner-backend

# Download GitHub Actions runner
curl -o actions-runner-linux-x64-2.329.0.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.329.0/actions-runner-linux-x64-2.329.0.tar.gz

tar xzf ./actions-runner-linux-x64-2.329.0.tar.gz

# Configure runner (get token from GitHub)
# https://github.com/YOUR_ORG/scrapalot-backend/settings/actions/runners/new
./config.sh \
  --url https://github.com/YOUR_ORG/scrapalot-backend \
  --token YOUR_RUNNER_TOKEN \
  --work /opt/scrapalot/_work_backend \
  --labels hetzner,production \
  --name hetzner-backend-runner

# Install and start service
sudo ./svc.sh install github-runner
sudo ./svc.sh start
sudo ./svc.sh status

# Verify runner is online
# Check GitHub: Settings → Actions → Runners
```

### 2. Configure Nginx Proxy Manager (CRITICAL)

**⚠️ CRITICAL**: Nginx must route traffic to **BOTH Kotlin and Python backends** based on endpoint paths.

**Complete routing configuration**: See [`README_NGINX_ROUTING.md`](../../scrapalot-gw/docs/README_NGINX_ROUTING.md)

**Quick Setup:**

1. Access Nginx Proxy Manager: https://routes.scrapalot.app
2. Click **Hosts** → **Proxy Hosts** → **Add Proxy Host**

**Details Tab:**
- Domain Names: `api.scrapalot.app`
- Scheme: `http`
- Forward Hostname/IP: `scrapalot-backend` (container name)
- Forward Port: `8091` (default to Kotlin)
- Block Common Exploits
- Websockets Support

**SSL Tab:**
- Request new SSL Certificate (Let's Encrypt)
- Force SSL
- HTTP/2 Support
- HSTS Enabled

**Advanced Tab** - **CRITICAL ROUTING RULES**:

```nginx
# ============================================
# CRITICAL: Dual Backend Routing
# Route traffic to BOTH Kotlin and Python
# ============================================

# ----------------------------------------
# Python Backend Routes (scrapalot-chat)
# ----------------------------------------
location /api/v1/chat {
    proxy_pass http://scrapalot-chat:8090;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 300s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
}

location /api/v1/sessions {
    proxy_pass http://scrapalot-chat:8090;
}

location /api/v1/messages {
    proxy_pass http://scrapalot-chat:8090;
}

location /api/v1/jobs {
    proxy_pass http://scrapalot-chat:8090;
}

location /llm-inference/ {
    proxy_pass http://scrapalot-chat:8091/;
}

# ----------------------------------------
# Kotlin Backend Routes (scrapalot-backend)
# ----------------------------------------
location /api/v1/auth {
    proxy_pass http://scrapalot-backend:8091;
}

location /api/v1/users {
    proxy_pass http://scrapalot-backend:8091;
}

location /api/v1/workspaces {
    proxy_pass http://scrapalot-backend:8091;
}

location /api/v1/collections {
    proxy_pass http://scrapalot-backend:8091;
}

location /api/v1/documents {
    proxy_pass http://scrapalot-backend:8091;
}

location /api/v1/notes {
    proxy_pass http://scrapalot-backend:8091;
}

location /api/v1/settings {
    proxy_pass http://scrapalot-backend:8091;
}

# Default: Route all other /api/v1/* to Kotlin
location /api/v1/ {
    proxy_pass http://scrapalot-backend:8091;
}

# Actuator endpoints (Kotlin)
location /actuator/ {
    proxy_pass http://scrapalot-backend:8091;
}

# WebSocket support (headers)
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
```

**📚 For full Nginx configuration with load balancing, caching, and security headers, see**: [`README_NGINX_ROUTING.md`](../../scrapalot-gw/docs/README_NGINX_ROUTING.md)

### 3. Ensure Redis is Running

The Kotlin backend shares Redis with Python but uses **database 1** (Python uses database 0):

```bash
# Check if Redis is running
docker ps | grep redis

# If not running, start Redis
cd /opt/scrapalot/scrapalot-chat/docker-scrapalot
docker compose up -d redis

# Verify Redis is accessible
docker exec redis redis-cli -a YOUR_REDIS_PASSWORD ping
# Expected: PONG

# Test Kotlin's database (DB 1)
docker exec redis redis-cli -a YOUR_REDIS_PASSWORD -n 1 KEYS '*'

# Test Python's database (DB 0)
docker exec redis redis-cli -a YOUR_REDIS_PASSWORD -n 0 KEYS '*'
```

---

## Database Migration

### Liquibase Migrations

Liquibase manages database schema changes automatically on application startup.

**Migration Files Location:**
```
src/main/resources/db/changelog/
├── db.changelog-master.yaml          # Master changelog
└── changes/
    ├── 001-create-users-table.yaml
    ├── 002-create-workspaces-table.yaml
    ├── 003-create-collections-table.yaml
    ├── ...                              # 69 changesets total
    └── 129-owner-superadmin.yaml        # current head
```

**Automatic Migration:**
```bash
# Migrations run automatically on startup
./gradlew bootRun

# Or when deploying JAR
java -jar scrapalot-backend-1.0.0.jar

# Check migration status in logs
docker logs scrapalot-backend | grep -i liquibase
```

**Manual Migration Commands:**
```bash
# Generate new migration (after modifying entities)
./gradlew liquibaseDiffChangelog

# Validate changelog
./gradlew liquibaseValidate

# View SQL that will be executed
./gradlew liquibaseSqlUpdate

# Apply migrations manually
./gradlew liquibaseUpdate

# Rollback last migration
./gradlew liquibaseRollbackCount -PliquibaseCommandValue=1
```

### Database Backup and Restore

**Backup Database:**
```bash
# Using pg_dump
pg_dump -h your-db-host -U scrapalot -d scrapalot_backend \
    -F c -f scrapalot_backend_$(date +%Y%m%d_%H%M%S).dump

# Backup specific schema only
pg_dump -h your-db-host -U scrapalot -d scrapalot_backend \
    -n scrapalot -F c -f scrapalot_schema_backup.dump
```

**Restore Database:**
```bash
# Restore from dump
pg_restore -h your-db-host -U scrapalot -d scrapalot_backend \
    -c scrapalot_backend_backup.dump

# Or using SQL
psql -h your-db-host -U scrapalot -d scrapalot_backend \
    < scrapalot_backend_backup.sql
```

**Verify Schema:**
```bash
# Connect to database
psql -h your-db-host -U scrapalot -d scrapalot_backend

# List tables
\dt scrapalot.*

# View table structure
\d scrapalot.users

# Check Liquibase changelog
SELECT * FROM databasechangelog ORDER BY dateexecuted DESC LIMIT 10;
```

---

## Monitoring & Health Checks

### Spring Boot Actuator Endpoints

**Public Endpoints:**

| Endpoint | Description | Access |
|----------|-------------|--------|
| `/actuator/health` | Health status | Public |
| `/actuator/info` | Application info | Public |

**Authorized Endpoints:**

| Endpoint | Description | Access |
|----------|-------------|--------|
| `/actuator/metrics` | Application metrics | Requires auth |
| `/actuator/prometheus` | Prometheus metrics | Requires auth |
| `/actuator/env` | Environment info | Requires auth |
| `/actuator/loggers` | Logger configuration | Requires auth |

**Test Health Endpoints:**
```bash
# Basic health check
curl https://api.scrapalot.app/actuator/health

# Expected response:
# {"status":"UP"}

# Detailed health (requires authentication)
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/actuator/health

# Application info
curl https://api.scrapalot.app/actuator/info

# Application metrics
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/actuator/metrics

# Specific metric (heap memory)
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/actuator/metrics/jvm.memory.used

# Prometheus metrics (for monitoring)
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/actuator/prometheus
```

### Container Monitoring

```bash
# View container status
docker ps | grep scrapalot-backend

# View container resources
docker stats scrapalot-backend

# View real-time logs
docker logs scrapalot-backend --tail 100 -f

# View logs filtered by level
docker logs scrapalot-backend | grep ERROR
docker logs scrapalot-backend | grep WARN

# View recent startup logs
docker logs scrapalot-backend --tail 200 | head -50
```

### Database Migration Status

```bash
# Check Liquibase changelog
docker exec scrapalot-backend sh -c 'psql -h $POSTGRES_BACKEND_HOST -U $POSTGRES_BACKEND_USER -d $POSTGRES_BACKEND_DB -c "SELECT * FROM databasechangelog ORDER BY dateexecuted DESC LIMIT 10"'

# View pending migrations
docker logs scrapalot-backend | grep -i "liquibase"

# Count applied migrations
docker exec scrapalot-backend sh -c 'psql -h $POSTGRES_BACKEND_HOST -U $POSTGRES_BACKEND_USER -d $POSTGRES_BACKEND_DB -c "SELECT COUNT(*) FROM databasechangelog"'
```

### Log Management

**View Logs:**
```bash
# Systemd logs (JAR deployment)
sudo journalctl -u scrapalot-backend -f --lines 100

# Application logs (if configured)
tail -f /var/log/scrapalot-backend/application.log

# Docker logs
docker logs scrapalot-backend -f --tail 100
```

**Configure Log Rotation:**

Create `/etc/logrotate.d/scrapalot-backend`:

```
/var/log/scrapalot-backend/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 0640 scrapalot scrapalot
    sharedscripts
    postrotate
        systemctl reload scrapalot-backend > /dev/null 2>&1 || true
    endscript
}
```

---

## Troubleshooting

### 1. Build Failures

**Symptoms:**
- Gradle build fails
- Docker build fails
- Tests fail

**Solutions:**
```bash
# Check build logs
./gradlew build --stacktrace

# Clean and rebuild
./gradlew clean build --refresh-dependencies

# Skip tests if needed (not recommended)
./gradlew build -x test

# Check Gradle wrapper permissions
chmod +x gradlew

# Docker build with no cache
docker build --no-cache -t scrapalot-backend:1.0.0 .

# View Docker build logs
docker build -t scrapalot-backend:1.0.0 . 2>&1 | tee build.log
```

### 2. Application Won't Start

**Symptoms:**
- Container exits immediately
- Service fails to start
- Health check fails

**Solutions:**
```bash
# Check application logs
docker logs scrapalot-backend --tail 200

# Check systemd status (JAR deployment)
sudo systemctl status scrapalot-backend
sudo journalctl -u scrapalot-backend -n 100

# Verify environment variables
docker exec scrapalot-backend env | grep POSTGRES

# Check port availability
sudo lsof -i :8091
sudo lsof -i :9090

# Verify database connectivity
docker exec scrapalot-backend sh -c 'nc -zv $POSTGRES_BACKEND_HOST $POSTGRES_BACKEND_PORT'

# Test database connection
docker exec scrapalot-backend sh -c 'psql -h $POSTGRES_BACKEND_HOST -U $POSTGRES_BACKEND_USER -d $POSTGRES_BACKEND_DB -c "SELECT 1"'
```

### 3. Database Connection Issues

**Symptoms:**
- "Connection refused" errors
- "Authentication failed" errors
- "Too many connections" errors

**Solutions:**
```bash
# Verify database credentials
docker exec scrapalot-backend env | grep POSTGRES

# Test connection from container
docker exec scrapalot-backend sh -c 'psql -h $POSTGRES_BACKEND_HOST -U $POSTGRES_BACKEND_USER -d $POSTGRES_BACKEND_DB -c "SELECT version()"'

# Check connection pool
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/actuator/metrics/hikaricp.connections.active

# View database logs (if accessible)
psql -h your-db-host -U scrapalot -d scrapalot_backend \
     -c "SELECT * FROM pg_stat_activity WHERE datname = 'scrapalot_backend'"

# Check Liquibase schema
docker exec scrapalot-backend sh -c 'psql -h $POSTGRES_BACKEND_HOST -U $POSTGRES_BACKEND_USER -d $POSTGRES_BACKEND_DB -c "SELECT * FROM databasechangelog LIMIT 5"'
```

### 4. Redis Connection Issues

**Symptoms:**
- Redis timeout errors
- Cache not working
- Pub/Sub events not received

**Solutions:**
```bash
# Check Redis is running
docker ps | grep redis

# Test Redis connection
docker exec redis redis-cli -a $REDIS_PASSWORD ping
# Expected: PONG

# Check Kotlin's Redis database (DB 1)
docker exec redis redis-cli -a $REDIS_PASSWORD -n 1 KEYS '*'

# Check Python's Redis database (DB 0)
docker exec redis redis-cli -a $REDIS_PASSWORD -n 0 KEYS '*'

# Monitor Redis pub/sub
docker exec redis redis-cli -a $REDIS_PASSWORD PSUBSCRIBE 'scrapalot:events:*'

# Check Redis info
docker exec redis redis-cli -a $REDIS_PASSWORD INFO

# Restart Redis
docker restart redis
```

### 5. gRPC Server Issues

**Symptoms:**
- Python backend can't communicate with Kotlin backend
- gRPC connection errors
- Port 9090 not accessible

**Solutions:**
```bash
# Check if gRPC port is accessible
docker exec scrapalot-backend netstat -tuln | grep 9090

# Test gRPC health check (if grpcurl installed)
docker exec scrapalot-backend grpcurl -plaintext localhost:9090 list

# Check gRPC logs
docker logs scrapalot-backend | grep -i grpc

# Verify gRPC is enabled in config
docker exec scrapalot-backend env | grep GRPC

# Test from Python container
docker exec scrapalot-chat python -c "import grpc; channel = grpc.insecure_channel('scrapalot-backend:9090'); print('Connected' if channel else 'Failed')"
```

### 6. Health Check Failed

**Symptoms:**
- `/actuator/health` returns 503 or 500
- Container marked as unhealthy
- Load balancer removes instance

**Solutions:**
```bash
# Check application logs
docker logs scrapalot-backend --tail 100

# Test health endpoint directly
curl -v http://localhost:8091/actuator/health

# Check if database is accessible
docker exec scrapalot-backend sh -c 'nc -zv $POSTGRES_BACKEND_HOST $POSTGRES_BACKEND_PORT'

# Check if Redis is accessible
docker exec scrapalot-backend sh -c 'nc -zv redis 6379'

# Restart container
docker restart scrapalot-backend

# View health check configuration
docker inspect scrapalot-backend | jq '.[0].State.Health'
```

### 7. WebSocket Connection Issues

**Symptoms:**
- WebSocket handshake fails
- Connections drop immediately
- CORS errors in browser console

**Solutions:**
```bash
# Check Nginx WebSocket configuration
docker exec nginx-proxy-manager cat /data/nginx/proxy_host/XX.conf | grep -A 10 "Upgrade"

# Verify CORS settings
docker exec scrapalot-backend env | grep CORS

# Test WebSocket connection
wscat -c wss://api.scrapalot.app/api/v1/ws

# Check application logs for WebSocket errors
docker logs scrapalot-backend | grep -i websocket

# Review WebSocketConfig.kt allowed origins
# File: src/main/kotlin/com/scrapalot/backend/config/WebSocketConfig.kt
```

### 8. Out of Memory Errors

**Symptoms:**
- `java.lang.OutOfMemoryError`
- Container restarts frequently
- High memory usage

**Solutions:**
```bash
# Check memory usage
docker stats scrapalot-backend

# Increase heap size
# Update JAVA_OPTS: -Xms1g -Xmx4g

# Analyze heap dump (if HeapDumpOnOutOfMemoryError enabled)
# Heap dump location: /var/log/scrapalot-backend/heapdump.hprof

# Monitor JVM memory metrics
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/actuator/metrics/jvm.memory.used

# View garbage collection stats
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/actuator/metrics/jvm.gc.pause
```

---

## Performance Tuning

### JVM Options

**Recommended JVM Options:**

```bash
# Heap sizing (adjust based on available memory)
-Xms512m -Xmx2g

# Garbage collection (G1GC recommended for Spring Boot)
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:+UseStringDeduplication

# GC logging (for performance analysis)
-Xlog:gc*:file=/var/log/scrapalot-backend/gc.log:time,uptime:filecount=5,filesize=10M

# Heap dump on OOM (for debugging memory issues)
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/var/log/scrapalot-backend/heapdump.hprof

# Enable JMX (for monitoring with VisualVM)
-Dcom.sun.management.jmxremote
-Dcom.sun.management.jmxremote.port=9010
-Dcom.sun.management.jmxremote.authenticate=false
-Dcom.sun.management.jmxremote.ssl=false
```

**Apply to Systemd Service:**

Edit `/etc/systemd/system/scrapalot-backend.service`:

```ini
Environment="JAVA_OPTS=-Xms512m -Xmx2g -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -XX:+UseStringDeduplication -Xlog:gc*:file=/var/log/scrapalot-backend/gc.log:time,uptime:filecount=5,filesize=10M"
```

**Apply to Docker:**

Update `docker-compose.prod.yaml`:

```yaml
services:
  scrapalot-backend:
    environment:
      JAVA_OPTS: "-Xms512m -Xmx2g -XX:+UseG1GC -XX:MaxGCPauseMillis=200"
```

### Database Connection Pool

Configure HikariCP in `application-prod.yaml`:

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 20         # Max connections
      minimum-idle: 5               # Min idle connections
      connection-timeout: 30000     # 30 seconds
      idle-timeout: 600000          # 10 minutes
      max-lifetime: 1800000         # 30 minutes
      leak-detection-threshold: 60000  # 60 seconds (detect leaks)
      auto-commit: true
```

**Monitor Connection Pool:**
```bash
# Active connections
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/actuator/metrics/hikaricp.connections.active

# Idle connections
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/actuator/metrics/hikaricp.connections.idle

# Connection wait time
curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://api.scrapalot.app/actuator/metrics/hikaricp.connections.acquire
```

### Redis Configuration

**Redis Performance Settings:**

```yaml
spring:
  data:
    redis:
      host: redis
      port: 6379
      database: 1
      password: ${REDIS_PASSWORD}
      timeout: 5000
      lettuce:
        pool:
          max-active: 20      # Max connections
          max-idle: 10        # Max idle connections
          min-idle: 5         # Min idle connections
          max-wait: -1ms      # Wait indefinitely
```

### Application Performance

**Spring Boot Performance Tips:**

1. **Enable HTTP/2** (in Nginx or Spring Boot with SSL)
2. **Enable compression** (gzip/Brotli)
3. **Use caching** (Redis, Caffeine)
4. **Optimize database queries** (indexes, pagination)
5. **Use async processing** (CompletableFuture, @Async)
6. **Profile with Spring Boot Actuator** (metrics)

---

## Security Checklist

### Configuration Security

- [ ] Change default JWT secret (`JWT_SECRET` - min 256 bits)
- [ ] Use strong database passwords (min 32 chars)
- [ ] Enable HTTPS/TLS (Let's Encrypt via Nginx)
- [ ] Configure firewall (allow only necessary ports: 80, 443)
- [ ] Enable Redis password protection
- [ ] Disable Swagger in production (`SWAGGER_UI_ENABLED=false`)
- [ ] Set appropriate CORS origins (whitelist only)
- [ ] Use secure OAuth credentials (keep secrets private)

### Application Security

- [ ] Implement rate limiting (Redis-based)
- [ ] Enable CSRF protection (for non-API endpoints)
- [ ] Use prepared statements (prevent SQL injection)
- [ ] Validate all user input
- [ ] Sanitize output (prevent XSS)
- [ ] Enable audit logging
- [ ] Implement proper error handling (don't expose stack traces)

### Infrastructure Security

- [ ] Use non-root user in Docker (user: scrapalot)
- [ ] Enable systemd security hardening (NoNewPrivileges, ProtectSystem)
- [ ] Set proper file permissions (600 for secrets)
- [ ] Enable log rotation (prevent disk full)
- [ ] Set up database backups (daily automated)
- [ ] Monitor for security updates (Java, dependencies)
- [ ] Use managed secrets (GitHub Secrets, env files)

### Database Security

- [ ] Enable PostgreSQL SSL (in production)
- [ ] Use Row Level Security (RLS)
- [ ] Limit database user permissions (least privilege)
- [ ] Enable database audit logging
- [ ] Regular security patches

### Monitoring Security

- [ ] Monitor failed login attempts
- [ ] Alert on suspicious activity
- [ ] Track API usage patterns
- [ ] Monitor unauthorized access attempts

---

## Backup Strategy

### Database Backups

**Automated Daily Backup:**

Create `/usr/local/bin/backup-scrapalot-backend.sh`:

```bash
#!/bin/bash
set -e

# Configuration
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/var/backups/scrapalot-backend"
RETENTION_DAYS=30

# Database credentials (from environment or .env)
source /etc/scrapalot/backend.env

# Create backup directory
mkdir -p $BACKUP_DIR

# Backup database
echo "Starting backup: $DATE"
pg_dump -h $POSTGRES_BACKEND_HOST \
        -U $POSTGRES_BACKEND_USER \
        -d $POSTGRES_BACKEND_DB \
        -F c \
        -f $BACKUP_DIR/scrapalot_backend_$DATE.dump

# Compress backup
gzip $BACKUP_DIR/scrapalot_backend_$DATE.dump

# Keep last 30 days
find $BACKUP_DIR -name "scrapalot_backend_*.dump.gz" -mtime +$RETENTION_DAYS -delete

echo "Backup completed: scrapalot_backend_$DATE.dump.gz"
```

**Schedule with Cron:**

```bash
# Make script executable
sudo chmod +x /usr/local/bin/backup-scrapalot-backend.sh

# Add to crontab (daily at 2 AM)
sudo crontab -e
0 2 * * * /usr/local/bin/backup-scrapalot-backend.sh >> /var/log/scrapalot-backend/backup.log 2>&1
```

### Application Backups

**Configuration Files:**
- `/etc/scrapalot/backend.env` - Environment variables
- `/etc/systemd/system/scrapalot-backend.service` - Systemd service
- `/etc/nginx/sites-available/scrapalot.app` - Nginx config

**Application Data:**
- `/var/scrapalot/uploads/` - Uploaded files
- `/var/log/scrapalot-backend/` - Log files

**Backup Script:**

```bash
#!/bin/bash
DATE=$(date +%Y%m%d)
BACKUP_DIR="/var/backups/scrapalot-backend"

# Backup configuration
tar -czf $BACKUP_DIR/config_$DATE.tar.gz /etc/scrapalot

# Backup uploads
tar -czf $BACKUP_DIR/uploads_$DATE.tar.gz /var/scrapalot/uploads

# Backup logs (last 7 days)
tar -czf $BACKUP_DIR/logs_$DATE.tar.gz /var/log/scrapalot-backend
```

### Restore Procedures

**Restore Database:**
```bash
# Decompress backup
gunzip scrapalot_backend_20260207.dump.gz

# Restore
pg_restore -h $POSTGRES_BACKEND_HOST \
           -U $POSTGRES_BACKEND_USER \
           -d $POSTGRES_BACKEND_DB \
           -c \
           scrapalot_backend_20260207.dump
```

**Restore Configuration:**
```bash
# Extract backup
tar -xzf config_20260207.tar.gz -C /

# Restart service
sudo systemctl restart scrapalot-backend
```

---

## Production Readiness Checklist

### Infrastructure

- [ ] Hetzner server provisioned and configured
- [ ] GitHub Actions runner installed and running
- [ ] Redis server running and accessible
- [ ] PostgreSQL (pgvector Docker container) configured
- [ ] Domain DNS configured (api.scrapalot.app)
- [ ] SSL certificates issued and valid (Let's Encrypt)
- [ ] Nginx Proxy Manager configured with dual backend routing

### GitHub Configuration

- [ ] All secrets added to repository (9 secrets)
- [ ] All variables configured (3 variables)
- [ ] Runner connected and online (green status)
- [ ] Workflow file committed to repository (`.github/workflows/deploy-backend.yml`)
- [ ] Test workflow runs successfully

### Application

- [ ] Docker build successful (no errors)
- [ ] Container starts without errors
- [ ] Health check passes (`/actuator/health` returns 200)
- [ ] Database migrations completed (check Liquibase logs)
- [ ] Redis connection working (both DB 0 and DB 1)
- [ ] gRPC server accessible on port 9090
- [ ] API endpoints responding correctly (test auth, workspaces)
- [ ] WebSocket connections working (test chat)

### Security

- [ ] JWT_SECRET is strong and unique (32+ chars, generated)
- [ ] Database passwords are strong (32+ chars)
- [ ] Redis password configured
- [ ] CORS origins configured correctly (whitelist only)
- [ ] OAuth credentials configured (Google)
- [ ] API documentation disabled in production (Swagger off)
- [ ] Security headers configured in Nginx
- [ ] HTTPS enforced (HTTP redirects to HTTPS)

### Monitoring

- [ ] Actuator endpoints accessible
- [ ] Prometheus metrics enabled
- [ ] Container logs accessible (`docker logs`)
- [ ] Resource limits configured (memory, CPU)
- [ ] Health checks passing (Docker healthcheck)
- [ ] Log rotation configured (logrotate)

### Deployment

- [ ] Automated deployment works (push to main)
- [ ] Manual deployment works (GitHub Actions UI)
- [ ] Rollback procedure tested
- [ ] Backup strategy in place (daily database backups)
- [ ] Recovery procedures documented

### Integration

- [ ] Python backend can call Kotlin gRPC (test from Python container)
- [ ] Kotlin can publish to Redis (test pub/sub)
- [ ] Python can receive Redis events (test subscription)
- [ ] Nginx routes traffic correctly (test both backends)
- [ ] Frontend can authenticate (test login flow)
- [ ] Frontend can access Kotlin endpoints (test workspaces)
- [ ] Frontend can access Python endpoints via Kotlin proxy (test chat)

---

## Support & Documentation

### Related Documentation

- [Architecture Overview](./README_ARCHITECTURE.md) - System architecture
- [Migration PRD](./README_MIGRATION_PRD_USER_ABSTRACTION.md) - Migration plan
- [gRPC & Redis Architecture](./README_GRPC_ARCHITECTURE.md) - Inter-service communication
- [Nginx Routing](../../scrapalot-gw/docs/README_NGINX_ROUTING.md) - Gateway-based routing configuration
- [WebSocket Integration](./README_WEBSOCKET_INTEGRATION.md) - WebSocket setup
- [MapStruct Integration](./README_MAPSTRUCT_INTEGRATION.md) - Entity-DTO mapping

### Useful Commands

```bash
# ========================================
# Container Management
# ========================================

# View all running services
docker ps

# View all services (including stopped)
docker ps -a

# View container logs
docker logs scrapalot-backend -f --tail 100

# Restart backend
docker restart scrapalot-backend

# Rebuild and restart
docker-compose -f docker-compose.prod.yaml build scrapalot-backend
docker-compose -f docker-compose.prod.yaml up -d scrapalot-backend

# ========================================
# System Monitoring
# ========================================

# Check disk space
df -h

# Check memory usage
free -h

# Check Docker resource usage
docker system df

# View container stats
docker stats

# ========================================
# Health Checks
# ========================================

# Application health
curl https://api.scrapalot.app/actuator/health

# gRPC health (if reflection enabled)
grpcurl -plaintext localhost:9090 list

# Redis health
docker exec redis redis-cli -a $REDIS_PASSWORD ping

# Database connection
docker exec scrapalot-backend sh -c 'psql -h $POSTGRES_BACKEND_HOST -U $POSTGRES_BACKEND_USER -d $POSTGRES_BACKEND_DB -c "SELECT 1"'

# ========================================
# Troubleshooting
# ========================================

# View application logs
docker logs scrapalot-backend --tail 200

# View error logs only
docker logs scrapalot-backend | grep ERROR

# View Liquibase migrations
docker logs scrapalot-backend | grep -i liquibase

# View gRPC logs
docker logs scrapalot-backend | grep -i grpc

# Check environment variables
docker exec scrapalot-backend env

# Test network connectivity
docker exec scrapalot-backend nc -zv redis 6379
docker exec scrapalot-backend nc -zv $POSTGRES_BACKEND_HOST $POSTGRES_BACKEND_PORT
```

### GitHub Actions Workflow

**Workflow File**: `.github/workflows/deploy-backend.yml`

**Triggers:**
- Push to main branch (with path filters)
- Manual trigger via GitHub Actions UI
- Workflow dispatch with environment selection

**Environment Options:**
- `dev` - Development environment
- `rc` - Release candidate
- `prod` - Production environment

**Self-hosted Runner:**
- User: `github-runner`
- Labels: `hetzner`, `production`
- Location: `/opt/scrapalot/actions-runner-backend`

---

## Changelog

### Version 2.0.0 (February 7, 2026)

**Architecture Changes:**
- New gateway-based microservices architecture
- Kotlin Backend handles ALL user-facing operations
- Python CHAT is PURE AI/ML service (no user awareness)
- gRPC server on port 9090
- Redis pub/sub for event broadcasting
- Dual backend routing via Nginx

**Deployment Changes:**
- Comprehensive deployment guide (local + JAR + Docker + cloud)
- GitHub Actions CI/CD with self-hosted runner
- Automated cloud deployment to Hetzner
- Nginx Proxy Manager configuration (CRITICAL routing)

**Infrastructure Changes:**
- PostgreSQL (pgvector Docker container) for Kotlin backend
- Shared Redis (DB 1 for Kotlin, DB 0 for Python)
- Docker containerization with health checks
- SSL via Let's Encrypt

---

**Version**: 2.0.0
**Last Updated**: March 2026
**Status**: Migration COMPLETE
