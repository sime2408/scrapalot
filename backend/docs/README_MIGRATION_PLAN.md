# User Data Migration Plan

> **COMPLETED** -- This is a historical document. The Python-to-Kotlin migration was completed in Q1 2026.

**Status**: COMPLETED
**Last Updated**: March 2026
**Author**: System Architecture Team

---

## ⚠️ IMPORTANT: New Architecture Vision

**This migration plan has been superseded by a more comprehensive PRD:**

👉 **[README_MIGRATION_PRD_USER_ABSTRACTION.md](./README_MIGRATION_PRD_USER_ABSTRACTION.md)**

The new PRD defines **complete separation** of concerns:
- **Kotlin (BE)**: OWNS all user data, auth, business logic
- **Python (CHAT)**: PURE AI/ML service, NO user awareness

**Flow**: `UI → GW → BE → gRPC → CHAT` (NOT direct UI → CHAT)

---

## Executive Summary

This document outlines the migration to the new **UI → Gateway → Kotlin BE → gRPC → Python CHAT** architecture. The goal is complete separation of concerns:

- **Gateway (scrapalot-gw)**: Entry point, intelligent routing
- **Kotlin Backend**: ALL user data, auth, business logic, REST API, gRPC server
- **Python CHAT**: PURE AI/ML service (NO user awareness, gRPC client only)

---

## Current State (Phase 1 - Gateway Routing)

### Completed (Phase 0 - Foundation)
- Kotlin Backend created with gRPC server (port 9090)
- Gateway created (scrapalot-gw)
- Redis pub/sub configured
- Database separation (`scrapalot_backend` vs `scrapalot`)
- Most user tables migrated to Kotlin

### Completed (Phase 1 - 100% Complete)
- Gateway routes all user-facing endpoints to Kotlin BE
- Chat endpoint migrated to Kotlin (HTTP proxy to Python, will be gRPC in Phase 2)
- Session management fully migrated to Kotlin
- Message management fully migrated to Kotlin
- All REST controllers use Spring Security @AuthenticationPrincipal pattern
- Null-safety with .orThrow() extension pattern

### 📊 Still in Python Database (To be removed in Phase 3)
- `users`, `workspaces`, `workspace_users`, `collections` (already in Kotlin)
- `sessions`, `messages` (migrated to Kotlin in Phase 1)
- `jobs` (moving to Kotlin in Phase 2)
- `user_settings`, `system_settings` (already in Kotlin)
- `user_subscriptions`, `user_token_usage` (moving to Kotlin in Phase 2)

### Python Database KEEPS (AI/ML Data)
- `documents`, `document_chunks`, `document_embeddings`
- `research_plans`, `research_tasks`, `research_sources`
- `langchain_pg_*`, Vector data

---

## Migration Phases

See **[README_MIGRATION_PRD_USER_ABSTRACTION.md](./README_MIGRATION_PRD_USER_ABSTRACTION.md)** for complete details.

### Phase 0: Foundation (Completed)
- Kotlin Backend with gRPC server
- Gateway infrastructure
- Redis pub/sub
- Database separation

### Phase 1: Gateway Routing (100% Complete)
**Duration**: 2 weeks
**Status**: Complete (February 6, 2026)

**Goals**:
- ALL user-facing endpoints route through Gateway → Kotlin
- Chat endpoint in Kotlin (HTTP proxy to Python, gRPC in Phase 2)
- Session management in Kotlin
- No direct UI → Python communication

**Achievements**:
- Gateway routes auth, users, workspaces to Kotlin
- Implemented ChatController in Kotlin (HTTP streaming to Python)
- Migrated SessionController to Kotlin (CRUD operations)
- Migrated MessageController to Kotlin (CRUD operations)
- Updated Gateway routing for /sessions, /messages, /chat endpoints
- Applied Spring Security @AuthenticationPrincipal pattern across all controllers
- Implemented null-safety with .orThrow() extension pattern

---

### Phase 2.5: gRPC AI Services Implementation ✅ (Complete)
**Status**: Delivered Q1 2026 (final cutover April 2026)

**Final Delivery**:
- **27 proto definitions** at `src/main/proto/`
- **19 Kotlin gRPC clients** calling Python gRPC server on port 9091
- All Kotlin → Python communication runs over gRPC; Python REST routes removed
- **50 REST controllers** in Kotlin (full CRUD API)
- **42 business services**
- **37 domain entities**
- **69 Liquibase migrations** (current head: `129-owner-superadmin.yaml`)
- ChatService runs gRPC-only — HTTP fallback removed after Q1 2026 stabilization
- Integration coverage and performance benchmarking signed off as part of cutover

---

### Phase 3: Database Cleanup 🔄 (Partially done)
**Duration**: 1 week
**Status**: In progress — Kotlin-side drop changesets already exist (`070-drop-python-owned-tables.yaml`,
`080-drop-documents-tables.yaml`). Remaining work is the Python (Alembic) side; verify against scrapalot-chat.

**Goals**:
- DROP all user tables from Python database
- Python database reduced by 60%+
- Python only keeps AI/ML data

**Key Tasks**:
- [x] Kotlin Liquibase drop changesets (070, 080)
- [ ] Python Alembic migration to DROP remaining tables
- [ ] Verify Python code doesn't reference user tables
- [ ] Run migration in production

---

### Phase 4: Python API Simplification 🎯 (Future)
**Duration**: 1 week
**Status**: Not Started

**Goals**:
- Remove FastAPI completely
- Python exposes ONLY gRPC services
- Simplified Python startup

---

### Phase 5: Production Deploy 🎯 (Future)
**Duration**: 1 week
**Status**: Not Started

**Goals**:
- Deploy complete architecture
- Monitor and stabilize
- Rollback plan ready

---

## Database Migration Tools

### Kotlin Backend (scrapalot-backend)
- **Tool**: Liquibase
- **Location**: `src/main/resources/db/changelog/`
- **Format**: YAML changesets
- **Naming**: `001-create-sessions-table.yaml`, `002-add-job-status-enum.yaml`

### Python Backend (scrapalot-chat)
- **Tool**: Alembic
- **Location**: `alembic/versions/`
- **Format**: Python migration scripts
- **Command**: `alembic revision --autogenerate -m "Drop sessions table"`

---

## Critical Requirements

### 1. Zero Downtime
- All migrations must support rolling deployments
- gRPC bridge must handle both old and new schemas during transition
- Feature flags for gradual rollout

### 2. Data Integrity
- **No data loss**: All data must be migrated or explicitly archived
- **Referential integrity**: Application-level validation via gRPC
- **Eventual consistency**: Redis pub/sub for cross-service synchronization

### 3. Rollback Plan
- Each phase has a documented rollback procedure
- Database snapshots before major migrations
- Blue-green deployment strategy

---

## Communication Plan

### Redis Pub/Sub Channels
- `scrapalot:events:session.created` - New session created in Kotlin
- `scrapalot:events:job.updated` - Job status change from Python
- `scrapalot:events:message.created` - New chat message

### gRPC Services
> Illustrative design sketch — these names never shipped. Sessions and messages are REST controllers
> (`SessionController`, message endpoints), not gRPC services. Actual job-tracking proto is `JobsService`
> (`jobs.proto`): `GetActiveJobs`, `GetJobStatus`, `CancelJob`.
- `JobsService` - Job tracking (GetActiveJobs / GetJobStatus / CancelJob)

---

## Success Metrics

### Performance
- [ ] Python backend startup time < 5 seconds (no user data loading)
- [ ] gRPC call latency < 50ms (p99)
- [ ] Zero data loss during migration

### Architecture
- [ ] Python database size reduced by 60%+ (user data removed)
- [ ] Clear service boundaries (Kotlin = business, Python = AI)
- [ ] No direct database access between services (gRPC only)

---

## Next Steps (Phase 2 - Gateway/Backend First)

**⚠️ Priority: Complete Gateway and Kotlin Backend work BEFORE Python implementation**

### Immediate (Gateway/Backend):
1. **Configure gRPC client in Kotlin**:
   - Add protobuf-gradle-plugin to build.gradle.kts
   - Generate gRPC client stubs from ai_service.proto
   - Create GrpcClientConfig.kt for Python CHAT connection

2. **Update ChatController**:
   - Replace WebClient HTTP proxy with gRPC client
   - Implement fallback to HTTP if gRPC unavailable
   - Handle streaming ChatResponsePacket messages

3. **Define additional proto files**:
   - document_service.proto (document operations)
   - job_service.proto (job tracking)

4. **Test end-to-end flow**:
   - UI → Gateway → Kotlin → gRPC (with HTTP fallback)
   - Verify streaming works correctly
   - Load testing with realistic chat workload

### Later (Python Implementation):
5. **Implement Python gRPC server** (DEFERRED):
   - Convert FastAPI chat endpoint to gRPC AIService
   - Implement streaming with PacketEmitter
   - Remove REST controllers

6. **Database cleanup** (Phase 3):
   - Remove user tables from Python database
   - Keep only AI/ML data in Python

---

## Related Documents

- [README_ARCHITECTURE.md](./README_ARCHITECTURE.md) - System architecture overview
- [README_GRPC_ARCHITECTURE.md](./README_GRPC_ARCHITECTURE.md) - Inter-service communication
- [README_DEPLOYMENT_GUIDE.md](./README_DEPLOYMENT_GUIDE.md) - Deployment procedures

---

**Status**: COMPLETED - Migration finished Q1 2026
