# Cloud Deployment Guide - Scrapalot Backend (Kotlin/Spring Boot)

**Version**: 1.1.0
**Last Updated**: March 2026

Complete guide for deploying Scrapalot Kotlin Backend on Hetzner Cloud production environment.

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
- **HTTP API**: Port 8091
- **gRPC Server**: Port 9090
- **Internal**: Docker network `docker-scrapalot_scrapalot-network`

**Dependencies**:
- PostgreSQL (pgvector:5432)
- Redis (redis:6379)
- Python Chat Service (scrapalot-chat:8090, port 9091 for gRPC)

---

## Source Code Location

**⚠️ CRITICAL**: Source code is in `/opt/scrapalot/scrapalot-backend/`, NOT in GitHub runner workspace.

```
/opt/scrapalot/
├── scrapalot-backend/       Source code (persistent)
├── scrapalot-chat/          Source code
├── scrapalot-ui/            Source code
├── scrapalot-gw/            Source code
└── actions-runner-backend/  ❌ GitHub runner (temporary checkout only)
    └── _work/
        └── scrapalot-backend/
            └── scrapalot-backend/  ❌ DO NOT use this directory
```

**Why this structure?**
- Source code in `/opt/scrapalot/` is persistent and accessible
- GitHub runner workspace is temporary and gets cleaned
- Multiple users (scrapalot, github-runner) can access `/opt/scrapalot/`
- Matches structure of scrapalot-chat and scrapalot-ui

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
cd /opt/scrapalot/scrapalot-backend
./gradlew --version
# Gradle 8.12
```

**No system Gradle installation required** - use `./gradlew` wrapper.

---

## GitHub Actions CI/CD

### Workflow File

Located at: `.github/workflows/deploy-backend.yml`

**Trigger**:
- Push to `main` branch (auto-deploy)
- Manual dispatch via GitHub UI

**Workflow Steps**:

1. **Checkout code** → temporary folder `scrapalot-backend/`
2. **Copy to deployment directory** → `/opt/scrapalot/scrapalot-backend/`
3. **Fix permissions** → `chgrp -R scrapalot`, `chmod -R g+rw`
4. **Setup Java 21** → Temurin distribution
5. **Generate gRPC proto classes** → `./gradlew generateProto`
6. **Build Kotlin Backend** → `./gradlew clean build -x test`
7. **Run tests** → `./gradlew test` (failures ignored)
8. **Build Docker image** → `./gradlew bootJar`, `docker build`
9. **Stop existing container** → handled by compose recreate
10. **Start new container** → `docker compose up -d scrapalot-backend` from `/opt/scrapalot/scrapalot-chat/docker-scrapalot` (env vars come from the compose file, not `docker run` flags)
11. **Health check** → Wait for `/actuator/health` to be UP
12. **Cleanup** → Remove old Docker images

### Environment Variables (GitHub Secrets)

Required secrets in GitHub repository settings:

- `POSTGRES_BACKEND_PASSWORD` - PostgreSQL password
- `JWT_SECRET` - JWT signing key (256-bit minimum)
- `REDIS_PASSWORD` - Redis password

### Working Directory

All build steps use:
```yaml
working-directory: /opt/scrapalot/scrapalot-backend
```

**Never use**:
```yaml
❌ working-directory: /opt/scrapalot/actions-runner-backend/_work/...
```

---

## Manual Deployment

### Option 1: Using GitHub Actions (Recommended)

1. **Push changes to main branch**:
   ```bash
   cd /opt/scrapalot/scrapalot-backend
   git add .
   git commit -m "Your changes"
   git push origin main
   ```

2. **GitHub Actions will automatically**:
   - Build JAR file
   - Build Docker image
   - Deploy container
   - Run health checks

3. **Monitor deployment**:
   - GitHub Actions: https://github.com/sime2408/scrapalot-backend/actions
   - Container logs: `docker logs -f scrapalot-backend`

### Option 2: Manual Build & Deploy

**Prerequisites**: Must be in `/opt/scrapalot/scrapalot-backend/`

```bash
# 1. Navigate to source code
cd /opt/scrapalot/scrapalot-backend

# 2. Pull latest changes
git pull origin main

# 3. Generate gRPC proto classes
./gradlew generateProto --no-daemon

# 4. Build JAR file
./gradlew clean bootJar --no-daemon

# 5. Build Docker image
docker build -t scrapalot-backend:latest .

# 6. Stop existing container
docker stop scrapalot-backend || true
docker rm scrapalot-backend || true

# 7. Start new container
# NOTE: CI/CD and the canonical deploy use `docker compose up -d scrapalot-backend`
# (from /opt/scrapalot/scrapalot-chat/docker-scrapalot) so all env vars come from the
# compose file. The raw `docker run` below is a manual fallback only.
docker run -d \
  --name scrapalot-backend \
  --network docker-scrapalot_scrapalot-network \
  -p 8091:8091 \
  -p 9090:9090 \
  -e SPRING_PROFILES_ACTIVE=prod \
  -e POSTGRES_BACKEND_HOST=pgvector \
  -e POSTGRES_BACKEND_PORT=5432 \
  -e POSTGRES_BACKEND_DB=scrapalot_backend \
  -e POSTGRES_BACKEND_USER=scrapalot \
  -e POSTGRES_BACKEND_PASSWORD=your_password \
  -e JWT_SECRET=your_jwt_secret \
  -e REDIS_HOST=redis \
  -e REDIS_PORT=6379 \
  -e REDIS_PASSWORD=your_redis_password \
  -e GRPC_PYTHON_CHAT_ADDRESS=dns:///scrapalot-chat:9091 \
  --restart unless-stopped \
  scrapalot-backend:latest

# 8. Check health
curl -f http://localhost:8091/actuator/health
# Expected: {"status":"UP"}
```

### Option 3: Gradle Build Without Docker

**For testing only** (not recommended for production):

```bash
cd /opt/scrapalot/scrapalot-backend

# Build JAR
./gradlew clean bootJar --no-daemon

# Run JAR directly (not containerized)
java -jar build/libs/scrapalot-backend-1.0.0.jar \
  --spring.profiles.active=prod
```

---

## Troubleshooting

### Build Fails: "Permission denied: ./gradlew"

**Problem**: Gradle wrapper not executable

**Solution**:
```bash
cd /opt/scrapalot/scrapalot-backend
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

### Build Fails: "Out of memory"

**Problem**: Gradle daemon runs out of memory

**Solution**:
```bash
# Increase Gradle memory in gradle.properties
echo "org.gradle.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=512m" >> gradle.properties

# Or use --no-daemon flag
./gradlew build --no-daemon
```

### Container Fails to Start: "Network not found"

**Problem**: Docker network doesn't exist

**Solution**:
```bash
# Create network
docker network create docker-scrapalot_scrapalot-network

# Or use docker-compose to create it
cd /opt/scrapalot/scrapalot-chat/docker-scrapalot
docker compose up -d redis pgvector
```

### Health Check Fails: "Connection refused"

**Problem**: Backend not ready or crashed

**Solution**:
```bash
# Check container status
docker ps -a | grep scrapalot-backend

# Check logs
docker logs scrapalot-backend --tail 100

# Check if port is in use
sudo netstat -tlnp | grep 8091

# Check PostgreSQL connection
docker exec scrapalot-backend curl pgvector:5432 || echo "Cannot reach PostgreSQL"
```

### gRPC Fails: "Cannot connect to Python Chat"

**Problem**: Python backend not running or wrong address

**Solution**:
```bash
# Check Python backend is running
docker ps | grep scrapalot-chat

# Check gRPC port
docker exec scrapalot-chat netstat -tlnp | grep 9091

# Test gRPC connection from Backend
docker exec scrapalot-backend curl -v scrapalot-chat:9091
```

### CI/CD Fails: "Source code not found"

**Problem**: Wrong working directory in GitHub Actions

**Solution**:
```yaml
# CORRECT
- name: Build
  working-directory: /opt/scrapalot/scrapalot-backend
  run: ./gradlew build

# ❌ WRONG
- name: Build
  run: ./gradlew build  # No working-directory specified
```

---

## Deployment Checklist

Before deploying to production:

- [ ] Source code is in `/opt/scrapalot/scrapalot-backend/`
- [ ] Permissions are correct (`github-runner:scrapalot`, 775)
- [ ] Java 21 is installed
- [ ] Docker network exists (`docker-scrapalot_scrapalot-network`)
- [ ] PostgreSQL container is running (pgvector:5432)
- [ ] Redis container is running (redis:6379)
- [ ] Python Chat container is running (scrapalot-chat:8090)
- [ ] GitHub secrets are configured (JWT_SECRET, POSTGRES_PASSWORD, REDIS_PASSWORD)
- [ ] Workflow uses `working-directory: /opt/scrapalot/scrapalot-backend`
- [ ] Health endpoint responds: `http://localhost:8091/actuator/health`

---

## Additional Resources

**Related Documentation**:
- `README.md` - General backend overview
- `docs/README_ARCHITECTURE.md` - System architecture
- `docs/README_GRPC_ARCHITECTURE.md` - gRPC communication
- `docs/README_DEPLOYMENT_GUIDE.md` - General deployment guide
- `/opt/scrapalot/CLAUDE.md` - Workspace-wide guidance

**Container Logs**:
```bash
# Backend logs
docker logs -f scrapalot-backend

# All containers
docker compose -f /opt/scrapalot/scrapalot-chat/docker-scrapalot/docker-compose.yaml logs -f
```

**Container Management**:
```bash
# Restart backend
docker restart scrapalot-backend

# Stop all services
docker compose -f /opt/scrapalot/scrapalot-chat/docker-scrapalot/docker-compose.yaml down

# Start all services
docker compose -f /opt/scrapalot/scrapalot-chat/docker-scrapalot/docker-compose.yaml up -d
```

---

**For Gateway deployment**: See `/opt/scrapalot/scrapalot-gw/docs/README_CLOUD_DEPLOYMENT.md`
