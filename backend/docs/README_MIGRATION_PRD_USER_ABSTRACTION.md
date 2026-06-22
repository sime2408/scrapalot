# Migration PRD: Complete User Abstraction Separation

**Status**: COMPLETED
**Priority**: 🔴 Critical
**Completed**: Q1 2026
**Owner**: System Architecture Team
**Last Updated**: March 2026

> **⚠️ Reconciliation note (doc-sync 2026-06):** The phase bodies below still carry the original
> planning markers ("IN PROGRESS", "Planning", unchecked boxes, "40% Done") that contradict the
> **COMPLETED** header. The code is well past them: Kotlin already serves `/documents/*`, `/sessions/*`,
> and `/settings/*` (`DocumentController`, `SessionController`, `SettingsController`); subscriptions and
> token usage live in Kotlin (`UserSubscription`, `UserTokenUsage`, `SubscriptionsController`,
> migrations `060`/`081`/`084`/`127`); and Python-owned-table drop changesets exist (`070`, `080`).
> The Kotlin → Python migration is gRPC-only with no Python REST. Also note the gRPC service/message
> names sketched below (`AIService`, `DocumentService`, `JobService`, `RAGQueryRequest`,
> `UpdateJobStatusRequest`) **never shipped** — the real protos are `ChatService` (chat.proto),
> `DocumentProcessingService` (documents.proto), and `JobsService` (jobs.proto). Treat the phase
> bodies as historical planning text.

---

## Executive Summary

This PRD outlines the complete architectural separation of **user management** (Kotlin) from **AI operations** (Python). The goal is to eliminate all user-related data and logic from the Python backend, making it a pure AI/ML service.

### Vision Statement

> **"Python backend should NEVER know about users, workspaces, or permissions. It only processes AI tasks sent from Kotlin backend."**

---

## Current State (❌ Problem)

### Current Architecture (WRONG)
```
┌────────────┐
│ UI (React) │
└──────┬─────┘
       │ REST
       ↓
┌──────────────┐
│ Gateway (GW) │
└──────┬───────┘
       │ REST
       ├──────────────┬──────────────┐
       ↓              ↓              ↓
┌─────────────┐  ┌──────────┐  ┌─────────────┐
│ Kotlin (BE) │  │Python(CHAT)│  │Python(CHAT) │
│ NEW APIs    │  │ OLD APIs   │  │ Auth/Users │
│ (migrating) │  │ (legacy)   │  │ ❌ BAD     │
└─────────────┘  └──────────┘  └─────────────┘
       ↓              ↓              ↑
   PostgreSQL    PostgreSQL    ❌ Direct DB
   (BE db)       (CHAT db)        Access
                      ↑
                 ❌ Has users, workspaces, collections tables
                 ❌ Has auth logic, permissions
                 ❌ Knows about user context
```

### Problems
1. **Dual Responsibility**: Python handles BOTH AI and user management
2. **Database Duplication**: User data exists in BOTH databases
3. **Security Risk**: Python has direct access to user data
4. **Tight Coupling**: UI talks to BOTH backends
5. **Complexity**: Two auth systems, two permission layers

---

## Target State (Solution)

### Target Architecture (CORRECT)
```
┌────────────┐
│ UI (React) │
└──────┬─────┘
       │ REST
       ↓
┌──────────────┐
│ Gateway (GW) │
└──────┬───────┘
       │ REST (ALL requests go here)
       ↓
┌─────────────────────────────────────────┐
│ Kotlin Backend (BE)                      │
│ Port: 8091                               │
│ OWNS: Users, Auth, Business Logic    │
├─────────────────────────────────────────┤
│ • User management (CRUD, OAuth)         │
│ • Workspace/Collection management       │
│ • Authentication (JWT, sessions)        │
│ • Authorization (permissions, RLS)      │
│ • Settings, Subscriptions, API keys     │
│ • Document metadata, Chat sessions      │
│ • Makes AI requests to Python        │
└──────┬──────────────────────────────────┘
       │ gRPC (when AI needed)
       ↓
┌─────────────────────────────────────────┐
│ Python Backend (CHAT)                    │
│ Port: 8090                               │
│ ⚡ ONLY: AI/ML Operations               │
├─────────────────────────────────────────┤
│ • RAG strategies (18 strategies)        │
│ • LLM inference (OpenAI, Anthropic...)  │
│ • Document processing (OCR, chunking)   │
│ • Embeddings, Vector search (pgvector)  │
│ • Knowledge graph (Neo4j)               │
│ • Deep research (5-phase system)        │
│ ❌ NO users, auth, permissions          │
│ ❌ NO workspace/collection awareness    │
└──────┬──────────────────────────────────┘
       │ gRPC (AI results)
       ↑
```

---

## Architecture Principles

### 1. Single Source of Truth
- **Kotlin (BE)**: OWNS all user-related data
- **Python (CHAT)**: OWNS all AI/ML models and processing

### 2. Request Flow (Normal: UI → AI)
```
User clicks "Ask AI" in UI
       ↓
[1] UI → Gateway → Kotlin BE
    • Validates JWT token
    • Checks workspace permissions
    • Loads user settings (RAG strategy, model, etc.)
    • Prepares AI request context
       ↓
[2] Kotlin BE → gRPC → Python CHAT
    • Sends: query, settings, document_ids
    • ❌ Does NOT send: user_id, workspace_id (Python doesn't care)
    • Python processes AI request (RAG, LLM)
       ↓
[3] Python CHAT → gRPC → Kotlin BE
    • Returns: AI response, citations, tokens_used
    • Kotlin stores message in database
       ↓
[4] Kotlin BE → Gateway → UI
    • Returns AI response to user
```

### 3. Rare Flow (Python → Kotlin)
```
Python finishes async job (document processing)
       ↓
[1] Python CHAT → gRPC → Kotlin BE
    • Sends: job_id, status, result
    • ❌ Does NOT send: user context
       ↓
[2] Kotlin BE
    • Updates job status in database
    • Publishes event to Redis
    • Sends WebSocket notification to UI
```

### 4. Data Ownership

| Data Type | Owner | Other Service |
|-----------|-------|---------------|
| Users, Auth | Kotlin | Python ❌ NEVER |
| Workspaces | Kotlin | Python ❌ NEVER |
| Collections | Kotlin | Python ❌ NEVER |
| Documents metadata | Kotlin | Python ❌ NEVER |
| Settings | Kotlin | Python reads via gRPC |
| Sessions | Kotlin | Python ❌ NEVER |
| Messages | Kotlin | Python creates via gRPC |
| Jobs | Kotlin | Python updates via gRPC |
| **AI Models** | Python | Kotlin ❌ NEVER |
| **Embeddings** | Python | Kotlin ❌ NEVER |
| **Vector DB** | Python | Kotlin ❌ NEVER |
| **Neo4j Graph** | Python | Kotlin ❌ NEVER |

---

## Migration Phases

### Phase 0: Foundation (DONE)
**Status**: Complete
**Duration**: Completed Dec 2025

- Kotlin backend created with Spring Boot
- gRPC proto definitions (6 services)
- Redis pub/sub architecture
- Database separation (scrapalot_backend vs scrapalot)
- Users table migrated to Kotlin

### Phase 1: Gateway Routing ✅ (COMPLETE)
**Status**: Complete
**Target**: Feb 15, 2026
**Duration**: 2 weeks

**Goal**: All UI traffic goes through Gateway → Kotlin

**Tasks**:
- [x] Gateway routes `/workspaces/*` → Kotlin ✅
- [x] Gateway routes `/collections/*` → Kotlin ✅
- [x] Gateway routes `/users/token/*` → Kotlin ✅
- [x] Gateway routes `/documents/*` → Kotlin ✅ (`DocumentController`)
- [x] Gateway routes `/sessions/*` → Kotlin ✅ (`SessionController`)
- [x] Gateway routes `/settings/*` → Kotlin ✅ (`SettingsController`)
- [x] Deprecate Python REST endpoints ✅ (Python is gRPC-only)
- [x] UI uses ONLY Gateway URLs ✅

**Success Criteria**:
- Zero UI requests go directly to Python
- Python REST API can be disabled (only gRPC)

### Phase 2: Python Controllers → gRPC Bridges 🎯 (NEXT)
**Status**: Planning
**Target**: March 1, 2026
**Duration**: 3 weeks

**Goal**: Python code uses ONLY gRPC, NO direct DB access to user tables

**Current State**:
```python
# ❌ WRONG (Python has direct access):
from src.main.models.sqlmodel_models import User, Workspace, Collection
user = db.query(User).filter(User.id == user_id).first()
workspace = db.query(Workspace).filter(...).first()
```

**Target State**:
```python
# CORRECT (Python uses gRPC):
from src.main.service.bridge.factory import get_auth_bridge
auth_bridge = get_auth_bridge()
user_context = auth_bridge.validate_token(token)  # Returns minimal context
# Python NEVER sees full User object, only what BE sends
```

**Files to Refactor** (18 controllers):
```
src/main/controllers/
├─ chat.py              → Use gRPC for user context, settings
├─ documents.py         → Use gRPC for workspace/collection
├─ sessions.py          → Use gRPC for collection metadata
├─ external_books.py    → Use gRPC for collection
├─ workspace_connectors → DELETE (move to Kotlin)
├─ users.py             → DELETE (move to Kotlin)
├─ desktop.py           → Use gRPC for workspace
└─ ... (11 more)
```

**Success Criteria**:
- Zero `db.query(User|Workspace|Collection)` in Python
- All user context comes from gRPC
- Python tests pass with NO user tables

### Phase 3: Database Cleanup 🗑️
**Status**: Planning
**Target**: March 15, 2026
**Duration**: 1 week

**Goal**: Drop ALL user-related tables from Python database

**Tables to DROP**:
```sql
-- User management (already migrated)
DROP TABLE users CASCADE;

-- Workspace management (migrate to Kotlin)
DROP TABLE workspaces CASCADE;
DROP TABLE workspace_users CASCADE;

-- Collection management (migrate to Kotlin)
DROP TABLE collections CASCADE;

-- Session management (migrate to Kotlin)
DROP TABLE sessions CASCADE;
DROP TABLE chat_sessions CASCADE;
DROP TABLE messages CASCADE;

-- Settings (migrate to Kotlin)
DROP TABLE user_settings CASCADE;
DROP TABLE system_settings CASCADE;

-- Jobs (migrate to Kotlin)
DROP TABLE jobs CASCADE;
```

**Tables to KEEP in Python**:
```sql
-- AI/ML data only:
documents              (raw content, processed text)
document_chunks        (chunked text for RAG)
document_embeddings    (vector embeddings)
research_plans         (deep research data)
research_tasks
research_sources
langchain_pg_*         (LangChain internal)
alembic_version        (migration tracking)
```

**Alembic Migration**:
```bash
# Create migration
alembic revision -m "Phase 3: Drop all user tables - Python is AI-only"

# Migration script:
def upgrade():
    op.drop_table('users')
    op.drop_table('workspaces')
    op.drop_table('workspace_users')
    op.drop_table('collections')
    op.drop_table('sessions')
    op.drop_table('chat_sessions')
    op.drop_table('messages')
    op.drop_table('user_settings')
    op.drop_table('system_settings')
    op.drop_table('jobs')

def downgrade():
    raise Exception("Cannot rollback - use backup database")
```

**Success Criteria**:
- Python database size reduced by 70%+
- Only AI/ML tables remain
- Python startup time < 3 seconds

### Phase 4: Python API Simplification 🔧
**Status**: Planning
**Target**: April 1, 2026
**Duration**: 2 weeks

**Goal**: Convert Python from REST API to pure gRPC service

**Changes**:
1. **Remove FastAPI REST endpoints**:
   - Keep ONLY gRPC server
   - Remove all `@router.post|get|put|delete`
   - Remove all authentication decorators

2. **Create gRPC-only services**:
   ```kotlin
   // Kotlin calls Python for AI:
   service AIService {
     rpc ProcessRAGQuery(RAGRequest) returns (RAGResponse);
     rpc ProcessDocument(DocumentRequest) returns (stream ProcessingProgress);
     rpc GenerateEmbeddings(EmbeddingsRequest) returns (EmbeddingsResponse);
     rpc DeepResearch(ResearchRequest) returns (stream ResearchProgress);
   }
   ```

3. **Simplify Python architecture**:
   ```
   BEFORE (complex):
   FastAPI controllers → Services → DB (users + AI)

   AFTER (simple):
   gRPC server → AI Services → DB (AI only)
   ```

**Success Criteria**:
- Python has NO REST API (only gRPC)
- Python has NO auth/permissions logic
- Python codebase reduced by 40%+

### Phase 5: Production Deployment 🚀
**Status**: Planning
**Target**: April 15, 2026
**Duration**: 1 week

**Deployment Strategy**:
1. **Blue-Green Deployment**:
   - Deploy new architecture to "green" environment
   - Run both old and new in parallel for 1 week
   - Monitor metrics, compare performance
   - Switch traffic to "green"
   - Keep "blue" as rollback option

2. **Database Migration**:
   - Backup BOTH databases before migration
   - Migrate user tables from Python → Kotlin
   - Verify data integrity
   - Drop tables from Python database
   - Archive old data for 90 days

3. **Monitoring**:
   - gRPC latency < 50ms (p99)
   - Python startup time < 3 seconds
   - Zero data loss
   - Zero downtime

**Success Criteria**:
- Production running on new architecture
- All metrics green for 7 days
- Zero rollbacks needed

---

## gRPC API Contracts

### 1. AI Query (Kotlin → Python)
```protobuf
service AIService {
  // Main RAG query
  rpc ProcessRAGQuery(RAGQueryRequest) returns (stream RAGQueryResponse);
}

message RAGQueryRequest {
  string query_text = 1;

  // Settings (from Kotlin user_settings)
  string rag_strategy = 2;
  string llm_model = 3;
  int32 top_k = 4;
  float temperature = 5;

  // Document context (IDs only, not full objects)
  repeated string document_ids = 6;

  // ❌ NO user_id, workspace_id, permissions
  //    Python doesn't need to know WHO is asking
}

message RAGQueryResponse {
  oneof response {
    string answer_delta = 1;      // Streaming answer
    Citation citation = 2;        // Source citation
    Reasoning reasoning = 3;      // Chain-of-thought
    TokenUsage token_usage = 4;   // LLM usage stats
  }
}
```

### 2. Document Processing (Kotlin → Python)
```protobuf
service DocumentService {
  rpc ProcessDocument(ProcessDocumentRequest) returns (stream ProcessingProgress);
}

message ProcessDocumentRequest {
  string document_id = 1;         // Document ID (Kotlin generated)
  string file_path = 2;           // Path to uploaded file
  string chunking_strategy = 3;   // From user settings
  string embedding_model = 4;     // From user settings

  // ❌ NO user_id, workspace_id
}

message ProcessingProgress {
  string document_id = 1;
  string stage = 2;              // parsing, chunking, embedding, indexing
  float progress = 3;            // 0.0 - 1.0
  string status = 4;             // success, error
  string error_message = 5;
}
```

### 3. Job Status Update (Python → Kotlin)
```protobuf
service JobService {
  rpc UpdateJobStatus(UpdateJobStatusRequest) returns (UpdateJobStatusResponse);
}

message UpdateJobStatusRequest {
  string job_id = 1;             // Job ID (Kotlin generated)
  string status = 2;             // processing, completed, failed
  float progress = 3;
  string result_json = 4;        // Processing result
  string error = 5;
}
```

---

## Success Metrics

### Performance
- [ ] Python startup time < 3 seconds (was 194s before optimization)
- [ ] gRPC call latency < 50ms (p99)
- [ ] RAG query latency unchanged (< 2s for simple, < 10s for complex)
- [ ] Zero performance degradation

### Architecture
- [ ] Python database size reduced by 70%+
- [ ] Python codebase reduced by 40%+
- [ ] Zero direct DB access to user tables
- [ ] Zero REST API in Python (only gRPC)

### Security
- [ ] Python has zero access to user data
- [ ] All auth/permissions in Kotlin
- [ ] JWT validation only in Kotlin
- [ ] Audit trail for all gRPC calls

### Reliability
- [ ] Zero data loss during migration
- [ ] Zero downtime deployment
- [ ] Rollback plan tested and working
- [ ] 99.9% uptime maintained

---

## Rollback Plan

### If Migration Fails

**Phase 1-2 Rollback** (Easy):
1. Revert Gateway routing to Python
2. Keep both databases running
3. Python continues working as before
4. Zero data loss (no tables dropped yet)

**Phase 3-4 Rollback** (Requires Backup):
1. Restore Python database from backup
2. Revert Gateway routing
3. Redeploy old Python code
4. **Data loss risk**: Any new data in Kotlin needs manual merge

**Phase 5 Rollback** (Emergency Only):
1. Blue-green switch back to "blue" environment
2. Restore both databases from backup
3. Redeploy old architecture
4. Incident post-mortem required

---

## Risk Mitigation

### Risk 1: Data Loss
**Mitigation**:
- Daily backups of BOTH databases
- Blue-green deployment (old system stays running)
- Data validation scripts before/after migration
- 90-day archive of migrated data

### Risk 2: Performance Degradation
**Mitigation**:
- Load testing before production deployment
- Monitor gRPC latency continuously
- Connection pooling for gRPC
- Circuit breakers for failures

### Risk 3: gRPC Communication Failure
**Mitigation**:
- Health checks on gRPC endpoints
- Retry logic with exponential backoff
- Fallback to local mode (emergency)
- Monitoring and alerts

### Risk 4: Breaking Changes
**Mitigation**:
- Comprehensive integration tests
- UI tests for all workflows
- Beta testing with internal users
- Feature flags for gradual rollout

---

## Timeline

| Phase | Start Date | End Date | Duration | Status |
|-------|-----------|----------|----------|--------|
| Phase 0: Foundation | Nov 2025 | Dec 2025 | 1 month | ✅ Done |
| Phase 1: Gateway Routing | Feb 1 | Feb 15 | 2 weeks | ✅ Done |
| Phase 2: gRPC Bridges | Feb 16 | Mar 1 | 2 weeks | ✅ Done |
| Phase 3: DB Cleanup | Mar 2 | Mar 15 | 2 weeks | 🔄 Kotlin drops done; Python Alembic side pending |
| Phase 4: API Simplification | Mar 16 | Apr 1 | 2 weeks | ✅ Done (Python gRPC-only) |
| Phase 5: Production Deploy | Apr 2 | Apr 15 | 2 weeks | ✅ Done |
| **Total** | **Feb 1** | **Apr 15** | **10 weeks** | **~95% Done** |

---

## Next Steps

### Immediate Actions (Week of Feb 6, 2026)

1. **Complete Gateway Routing** (Phase 1):
   - [ ] Route `/documents/*` to Kotlin
   - [ ] Route `/sessions/*` to Kotlin
   - [ ] Route `/settings/*` to Kotlin
   - [ ] Test all UI workflows through Gateway

2. **Start Phase 2 Planning**:
   - [ ] Audit all Python controllers for direct DB access
   - [ ] Create refactoring checklist (18 controllers)
   - [ ] Write integration tests for gRPC bridges
   - [ ] Document gRPC API contracts

3. **Communication**:
   - [ ] Share PRD with team
   - [ ] Schedule architecture review
   - [ ] Create JIRA tickets for each phase
   - [ ] Set up monitoring dashboards

---

## Related Documents

- [README_MIGRATION_PLAN.md](./README_MIGRATION_PLAN.md) - Original migration plan (to be updated)
- [README_GRPC_ARCHITECTURE.md](./README_GRPC_ARCHITECTURE.md) - gRPC implementation details
- [README_GRPC_ARCHITECTURE.md](./README_GRPC_ARCHITECTURE.md) - Architecture guide
- [README_ARCHITECTURE.md](./README_ARCHITECTURE.md) - System architecture

---

**Status**: COMPLETED - Q1 2026
**Last Updated**: March 2026
