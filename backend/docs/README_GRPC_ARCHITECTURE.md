# gRPC & Redis Architecture - Complete Guide

**Version**: 3.0.0
**Last Updated**: March 2026
**Status**: Migration COMPLETE

Complete guide to gRPC and Redis communication architecture in Scrapalot's microservices system.

> **⚠️ Naming correction (doc-sync 2026-06):** Earlier revisions of this document described a single
> `AIService` / `ai_service.proto` and a `document_service.proto`. **Those names never shipped.** The
> real protos are `chat.proto` (`ChatService`, 12 RPCs), `documents.proto` (`DocumentProcessingService`),
> `jobs.proto` (`JobsService`), `settings_service.proto` (`SettingsService`) + `settings_ai.proto`
> (`SettingsAIService`), etc. — **27 proto files** in total. Kotlin holds **19 gRPC clients** calling
> Python's gRPC server on **9091**, and Kotlin **also runs 8 `@GrpcService` server implementations on
> 9090** (Auth, Workspace, Collection, Notes, Settings, Subscription, Annotation, Events) that Python
> calls — so the "Python no longer calls Kotlin via gRPC" claim below is **incorrect**. Treat any
> `AIService`/`ai_service.proto` reference in the legacy sections as illustrative only.

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Architecture Vision](#architecture-vision)
3. [Architecture Diagrams](#architecture-diagrams)
4. [Communication Patterns](#communication-patterns)
5. [gRPC Service Definitions](#grpc-service-definitions)
6. [Redis Event Channels](#redis-event-channels)
7. [Configuration](#configuration)
8. [Implementation Status](#implementation-status)
9. [Implementation Examples](#implementation-examples)
10. [Testing](#testing)
11. [Production Considerations](#production-considerations)
12. [Troubleshooting](#troubleshooting)
13. [Summary](#summary)

---

## Overview

This document describes the communication architecture in Scrapalot's **Gateway-Based Microservices Architecture**:

**Service Stack:**
- **API Gateway** (scrapalot-gw:8080) - Single entry point, routes to Kotlin or Python
- **Kotlin Backend** (scrapalot-backend:8091) - User management, auth, business logic, 19 gRPC clients
- **Python CHAT** (scrapalot-chat:8090/9091) - PURE AI/ML service, gRPC SERVER (port 9091)

**Communication Channels:**
1. **REST API** - UI → Gateway → Kotlin Backend
2. **gRPC** (port 9091) - Kotlin → Python for AI/ML requests
3. **Redis Streams SAGA** - Event-driven bidirectional communication with guaranteed delivery

---

## Architecture Vision

### ⚠️ CRITICAL: Separation of Concerns

**Python CHAT is PURE AI/ML service:**
- ❌ NO user tables in database
- ❌ NO authentication logic
- ❌ NO permission checks
- ❌ NO direct queries to user/workspace/collection tables
- RECEIVES user IDs (userId, workspaceId, collectionIds) as gRPC parameters
- USES user IDs for logging, analytics, per-user caching
- TRUSTS Kotlin's authorization (never re-validates permissions)
- ONLY performs AI/ML operations (RAG, embeddings, LLM inference)

**Kotlin Backend OWNS:**
- ALL user data (users, workspaces, collections, sessions, messages)
- ALL authentication and authorization
- ALL business logic
- 19 gRPC clients calling Python gRPC server (port 9091)

**Data Flow:**
```
User → Gateway → Kotlin BE → gRPC → Python CHAT
                    ↓                    ↓
              scrapalot_backend    scrapalot (AI/ML only)
```

---

## Architecture Diagrams

### System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         React UI (port 3000)                     │
└────────────┬────────────────────────────────────────────────────┘
             │
             │ HTTPS
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway (scrapalot-gw)                    │
│                          Routes traffic:                         │
│         /api/v1/auth, /api/v1/users, etc. → Kotlin BE          │
│         /api/v1/chat, /llm-inference → Python CHAT             │
└────────────┬────────────────────────────────────┬───────────────┘
             │                                    │
             │ HTTP                               │ HTTP
             │                                    │
             ▼                                    ▼
┌─────────────────────────────┐        ┌──────────────────────────┐
│   Kotlin BE (port 8091)     │        │  Python CHAT (8090)      │
│  - Auth, Users, Workspaces  │◄──────►│  - RAG Strategies        │
│  - Collections, Documents   │  gRPC  │  - LLM Integration       │
│  - Notes, Settings          │  9091  │  - Document Processing   │
│  - Business Logic           │        │  - Vector Embeddings     │
│  - 19 gRPC CLIENTS          │        │  - gRPC SERVER (9091)    │
│  - OWNS user data           │        │  - NO user awareness     │
└──────────┬──────────────────┘        └──────────┬───────────────┘
           │                                      │
           │      Redis Streams SAGA (6379)      │
           │      Guaranteed Delivery Sync       │
           └──────────────┬──────────────────────┘
                          │
                          ▼
                  ┌──────────────┐
                  │    Redis     │
                  │  (Events)    │
                  └──────────────┘
```

### Port Allocation

| Service | Port | Protocol | Purpose |
|---------|------|----------|---------|
| API Gateway | 8080 | HTTPS | Single entry point |
| Kotlin Backend | 8091 | HTTP | REST API + WebSocket |
| Kotlin Backend | 9090 | gRPC | gRPC server (Python calls) |
| Python CHAT | 8090 | HTTP | Temporary REST API (will be removed) |
| Python CHAT | 9091 | gRPC | gRPC server (Kotlin calls) |
| Redis | 6379 | Redis | Streams SAGA + Caching |
| PostgreSQL (Kotlin) | 5432 | PostgreSQL | User data (scrapalot_backend) |
| PostgreSQL (Python) | 5432 | PostgreSQL | AI/ML data (scrapalot) |
| Neo4j | 7687 | Bolt | Knowledge graph |

---

## Communication Patterns

### 1. UI → Gateway → Kotlin Backend (REST API)

**Primary interface for user operations:**

```
UI calls Gateway which routes to Kotlin BE:
- POST /api/v1/auth/login         → Kotlin (8091)
- GET  /api/v1/users              → Kotlin (8091)
- GET  /api/v1/workspaces         → Kotlin (8091)
- POST /api/v1/collections        → Kotlin (8091)
- POST /api/v1/documents          → Kotlin (8091)
- POST /api/v1/notes              → Kotlin (8091)
- GET  /api/v1/settings           → Kotlin (8091)

Kotlin Backend handles:
- Authentication/Authorization
- User permission checks
- Business logic
- Database persistence (PostgreSQL scrapalot_backend)
- WebSocket notifications
```

**When Kotlin needs AI/ML work:**
- Uses gRPC to call Python CHAT services
- Sends task description WITHOUT user context
- Example: "Process this document content with chunking strategy X"

---

### 2. Kotlin → Python (gRPC for AI/ML Tasks)

**Kotlin calls Python via gRPC for AI/ML operations:**

```kotlin
// Example: Kotlin needs document processed
import grpc
from scrapalot.grpc import ai_service_pb2, ai_service_pb2_grpc

channel = grpc.insecure_channel('localhost:9090')
stub = ai_service_pb2_grpc.AIServiceStub(channel)

// Send AI task WITHOUT user ID
request = ai_service_pb2.ProcessDocumentRequest(
    document_id = str(document_id),
    content = document_content,
    chunking_strategy = "contextual_retrieval",
    embedding_model = "text-embedding-3-large"
    // ❌ NO user_id, NO workspace_id
)
response = stub.ProcessDocument(request)
```

**Use Cases:**
- RAG query execution (query text, strategy, model)
- Document processing (content, chunking strategy)
- Embedding generation (text, model)
- LLM inference (prompt, model, settings)

**What Python NEVER receives:**
- ❌ User IDs, usernames, emails
- ❌ Workspace/collection metadata
- ❌ Permission information
- ❌ Authentication tokens

---

### 3. Bidirectional Events (Redis Streams SAGA)

**Event-driven communication for asynchronous operations:**

#### Kotlin → Python (via Redis)

```kotlin
// Kotlin publishes AI task event
redisEventPublisher.publishAITask(
    type = EventType.PROCESS_DOCUMENT,
    documentId = documentId,
    payload = mapOf(
        "content" to content,
        "chunking_strategy" to "contextual_retrieval",
        "embedding_model" to "text-embedding-3-large"
        // ❌ NO user info
    )
)
```

```python
# Python subscribes to AI task events
pubsub = redis_client.pubsub()
pubsub.subscribe('scrapalot:events:ai-tasks')

for message in pubsub.listen():
    event = json.loads(message['data'])
    if event['type'] == 'PROCESS_DOCUMENT':
        # Process document WITHOUT knowing about users
        process_document(event['documentId'], event['payload'])
```

#### Python → Kotlin (via Redis)

```python
# Python publishes processing progress
redis_client.publish('scrapalot:events:ai-results', json.dumps({
    'id': str(uuid.uuid4()),
    'type': 'DOCUMENT_PROCESSING_PROGRESS',
    'source': 'python',
    'timestamp': datetime.now().isoformat(),
    'documentId': str(document_id),
    'payload': {
        'status': 'processing',
        'progress': 50,
        'chunks_processed': 10,
        'total_chunks': 20
    }
    # ❌ NO user_id
}))
```

```kotlin
// Kotlin listens and forwards via WebSocket
@Service
class AIResultListener(
    private val notificationService: NotificationService,
    private val documentService: DocumentService
) {
    @RedisMessageListener(channel = "scrapalot:events:ai-results")
    fun onAIResult(message: String) {
        val event = objectMapper.readValue(message, Event::class.java)
        if (event.type == EventType.DOCUMENT_PROCESSING_PROGRESS) {
            // Lookup user from document
            val document = documentService.getDocument(event.documentId!!)
            // Forward to user via WebSocket
            notificationService.sendDocumentProcessingUpdate(
                userId = document.userId,
                documentId = event.documentId!!,
                progress = event.payload["progress"] as Int
            )
        }
    }
}
```

---

## gRPC Service Definitions

### Proto Files Location

All proto files located in: `src/main/proto/`

### Kotlin gRPC Server (port 9090)

**ACTIVE — Kotlin runs 8 `@GrpcService` server implementations on port 9090** that Python calls:
`AuthServiceImpl`, `WorkspaceServiceImpl`, `CollectionServiceImpl`, `NotesServiceImpl`,
`SettingsServiceImpl`, `SubscriptionServiceImpl`, `AnnotationServiceImpl`, `EventsServiceImpl`.

For the Kotlin → Python direction, Python also receives all necessary context as parameters from Kotlin
when Kotlin calls Python gRPC services (Python never queries Kotlin's user tables directly).

**Example:**
```kotlin
// Kotlin sends user context to Python via gRPC parameters
val chatRequest = ChatRequest.newBuilder()
    .setPrompt(request.query)
    .setUserId(userId.toString())           // User context
    .setWorkspaceId(workspaceId.toString()) // Workspace context
    .addAllCollectionIds(collectionIds.map { it.toString() })
    .addAllDocumentIds(documentIds.map { it.toString() })
    .build()

// Python receives and uses these IDs for logging/caching
// Python NEVER queries user/workspace/collection tables
```

### Python gRPC Server (port 9091)

**Kotlin calls these services:**

#### 1. **`chat.proto`** - AI Chat Generation Service

**Service:** `ChatService`

**Methods (12 RPCs):**
- `GenerateDirectLLM`, `GenerateRAG`, `GenerateDeepResearch`, `GenerateWebSearch`, `GenerateAgenticRAG`, `GenerateDocumentQA` - streaming generators returning `stream ChatResponsePacket`
- `GenerateChat(ChatRequest) returns (stream ChatResponsePacket)` - generic streaming entrypoint
- `GenerateChatTutor`, `GenerateImage` - streaming; `GetTutorProgress`, `GenerateTitle`, `HealthCheck` - unary

**ChatRequest fields (1:1 mapping of Python ChatRequest DTO):**
```protobuf
message ChatRequest {
  // Required
  string prompt = 1;

  // User context (sent by Kotlin, NOT queried by Python)
  optional string user_id = 2;
  optional string session_id = 3;
  optional string workspace_id = 4;
  repeated string collection_ids = 5;
  repeated string document_ids = 6;

  // Model configuration
  optional string model_id = 7;
  optional string model_name = 8;
  optional string provider_type = 9;

  // Settings
  string language = 10;
  bool web_search_enabled = 11;
  bool deep_research_enabled = 12;
  int32 research_breadth = 13;
  int32 research_depth = 14;

  // RAG configuration
  optional string user_message_id = 15;
  optional float similarity_threshold = 16;
  optional int32 top_k = 17;

  // Agentic RAG
  bool agentic_rag_enabled = 18;
  map<string, float> source_preferences = 19;
  float min_confidence_threshold = 20;
  int32 max_sources = 21;
}

message ChatResponsePacket {
  string type = 1;                          // PacketEmitter packet type
  int32 index = 2;                          // packet ordinal
  string data = 3;                          // full JSON packet payload
  scrapalot.common.Timestamp timestamp = 4; // emission time
}
```

#### 2. **`documents.proto`** - Document Processing Service

**Service:** `DocumentProcessingService`

**Methods:**
- `ProcessDocument(ProcessDocumentRequest) returns (stream ProcessingStatusChunk)` - Process single document
- `ProcessPendingDocuments(ProcessPendingRequest) returns (stream ProcessingStatusChunk)` - Process collection
- `CancelProcessing(CancelProcessingRequest) returns (CancelProcessingResponse)` - Cancel job
- `GetProcessingStatus(ProcessingStatusRequest) returns (ProcessingStatusResponse)` - Query status
- `ReprocessDocument(ReprocessDocumentRequest) returns (stream ProcessingStatusChunk)` - Reprocess document
- `CleanupEmbeddings(CleanupEmbeddingsRequest) returns (CleanupEmbeddingsResponse)` - Cleanup embeddings

**Key message types:**
```protobuf
message ProcessDocumentRequest {
  string document_id = 1;
  string user_id = 2;
  string collection_id = 3;
  string file_path = 4;      // Absolute path on server
}

message ProcessingStatusChunk {
  string job_id = 1;
  string status = 2;         // pending, processing, completed, failed
  float progress = 3;        // 0.0-100.0
  string message = 4;
  optional string packet_json = 5;
}
```

#### 3. **`settings_service.proto`** - Settings Service (+ `settings_ai.proto` for providers)

**Service:** `SettingsService` (settings_service.proto)

**Methods:**
- `GetUserSetting`, `GetAllUserSettings`, `SetUserSetting`, `SetUserSettings`, `DeleteUserSetting` - user settings
- `GetServerSetting`, `GetAllServerSettings`, `SetServerSetting`, `DeleteServerSetting` - server settings
- `GetSelectedWorkspace`, `GetDocumentProcessingSettings`, `GetRAGSettings` - derived config

Model-provider RPCs (`ListProviders`, `ListModels`, …) live in **`settings_ai.proto`** as `SettingsAIService`, not here.

**Key message types:**
```protobuf
message SystemSettingsResponse {
  map<string, string> settings = 1;
}

message ModelProviderResponse {
  string provider_id = 1;
  string provider_type = 2;   // openai, anthropic, local, ollama
  string provider_name = 3;
  optional string api_key = 4;
  optional string api_base = 5;
  bool is_active = 6;
  map<string, string> config = 7;
}
```

**Python gRPC Client (REMOVED):**
- ❌ Python NEVER calls Kotlin gRPC
- ❌ Python NEVER queries user/workspace/collection tables
- Python receives ALL context via gRPC parameters from Kotlin

---

## Redis Event Channels

### Channel Structure

```
scrapalot:events:all           # All events (broadcast)
scrapalot:events:ai-tasks      # AI/ML task requests (Kotlin → Python)
scrapalot:events:ai-results    # AI/ML task results (Python → Kotlin)
scrapalot:events:documents     # Document-specific events
scrapalot:events:collections   # Collection-specific events
scrapalot:events:workspaces    # Workspace-specific events
scrapalot:events:notes         # Note-specific events
```

### Event Types

**AI Task Events (Kotlin → Python):**
- `PROCESS_DOCUMENT` - New document to process
- `EXECUTE_RAG_QUERY` - RAG query to execute
- `GENERATE_EMBEDDING` - Generate embeddings
- `RUN_LLM_INFERENCE` - Run LLM inference

**AI Result Events (Python → Kotlin):**
- `DOCUMENT_PROCESSING_PROGRESS` - Processing update
- `DOCUMENT_PROCESSING_COMPLETED` - Processing done
- `DOCUMENT_PROCESSING_FAILED` - Processing error
- `RAG_QUERY_COMPLETED` - Query finished
- `EMBEDDING_COMPLETED` - Embeddings generated

**Business Events (Kotlin → Python cwm sync):**
- `COLLECTION_CREATED` - New collection → Python upserts `collection_workspace_map`
- `COLLECTION_UPDATED` - Collection renamed → Python upserts `collection_workspace_map`
- `COLLECTION_DELETED` - Collection removed → Python deletes from `collection_workspace_map`
- `WORKSPACE_UPDATED` - Workspace renamed → Python updates workspace_name in all mapped collections
- `WORKSPACE_DELETED` - Workspace removed → Python deletes all mapped collections

**Business Events (Kotlin only):**
- `DOCUMENT_UPLOADED` - New document uploaded
- `WORKSPACE_CREATED` - New workspace
- `WORKSPACE_SHARED` - User added

**Token Usage Events (Python → Kotlin):**
- `TOKEN_USAGE_RECORDED` - Token usage from LLM call → Kotlin persists to `user_token_usage`

**Sync Infrastructure:**
- Snapshot key: `scrapalot:sync:collection_workspace_snapshot` (Kotlin writes full mapping, Python reads on startup)
- DLQ: `scrapalot:dlq:cwm_sync` (failed Python events with retry exhausted, max 1000)
- Pattern: Events deferred until after `@Transactional` commit using `runAfterCommit()`

---

## Configuration

### Kotlin Backend (application.yaml)

```yaml
# gRPC Server (Python calls Kotlin)
grpc:
  server:
    port: 9090
    address: 0.0.0.0
    max-inbound-message-size: 10MB
    enable-reflection: true

# gRPC Client (Kotlin calls Python)
grpc:
  client:
    python-chat:
      address: dns:///scrapalot-chat:9091
      negotiationType: PLAINTEXT
      enableKeepAlive: true
      keepAliveTime: 30s
      maxInboundMessageSize: 10MB

# Redis
redis:
  enabled: true
  host: redis
  port: 6379
  password: ${REDIS_PASSWORD}
  database: 1  # Kotlin uses DB 1, Python uses DB 0
```

### Python CHAT (config.yaml)

```yaml
# gRPC Server (Kotlin calls Python)
grpc:
  server:
    port: 9091
    address: "0.0.0.0"
    max_workers: 10

# gRPC Client (Python calls Backend)
grpc:
  backend_host: scrapalot-backend
  backend_port: 9090
  timeout: 30
  max_retries: 3

# Redis
redis:
  host: redis
  port: 6379
  password: ${REDIS_PASSWORD}
  db: 0  # Python uses DB 0, Kotlin uses DB 1
```

### Environment Variables

**Kotlin Backend (.env):**
```bash
# gRPC Server
GRPC_SERVER_PORT=9090
GRPC_SERVER_ADDRESS=0.0.0.0

# gRPC Client
GRPC_PYTHON_CHAT_ADDRESS=dns:///scrapalot-chat:9091

# Redis
REDIS_ENABLED=true
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=your_password
REDIS_DATABASE=1
```

**Python CHAT (.env):**
```bash
# gRPC Server
GRPC_SERVER_PORT=9091

# gRPC Client
GRPC_CLIENT_BACKEND_HOST=scrapalot-backend
GRPC_CLIENT_BACKEND_PORT=9090

# Redis
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=your_password
REDIS_DB=0
```

---

## Implementation Status

### Overview

**Current Phase**: Migration COMPLETE (Q1 2026)

**Completion Status:**
- Phase 0: Foundation (100%)
- Phase 1: Gateway Routing (100%)
- Phase 2: gRPC Client/Server (100%)
- Phase 2.5: gRPC Bridge Refactoring (100%)
- Phase 3: Database Cleanup (100%)
- Phase 4: Python API Simplification (100%)
- Phase 5: Production Deploy (100%)

---

### Phase 0: Foundation (100% Complete)

**Status**: Completed

**Achievements:**

**1. Dependencies & Build Configuration**

File: `build.gradle.kts`

Added dependencies:
- gRPC Server Spring Boot Starter (3.1.0.RELEASE)
- gRPC Client Spring Boot Starter (3.1.0.RELEASE)
- gRPC Kotlin Stub (1.4.1)
- gRPC Protobuf (1.62.2)
- Protocol Buffers Kotlin (3.25.3)
- Spring Data Redis
- Lettuce Core (Redis client)

Configured protobuf plugin:
- Proto compilation for Java, Kotlin, and gRPC
- Source set configuration for generated code
- Build task integration

**2. Proto Definitions (27 proto files)**

Location: `src/main/proto/`

Representative protos (full list of 27 in `README_ARCHITECTURE.md`):

1. **`common.proto`** - Shared types
2. **`auth_service.proto`** - Authentication
3. **`workspace_service.proto`** - Workspaces
4. **`collection_service.proto`** - Collections
5. **`documents.proto`** - Document processing (`DocumentProcessingService`, `DocumentCollectionService`)
6. **`settings_service.proto`** / **`settings_ai.proto`** - Settings + AI settings/model providers
7. **`chat.proto`** - AI/ML operations (`ChatService`, 12 RPCs)

**3. Configuration**

Files:
- `config/GrpcConfig.kt` - gRPC server + client configuration
- `config/RedisConfig.kt` - Redis connection and Streams SAGA
- `application.yaml` - gRPC and Redis settings
- `.env.example` - Environment variable documentation

**4. Redis Event Publisher**

File: `service/RedisEventPublisher.kt`

Features:
- Event publishing to Redis channels
- Specialized methods for AI task events
- Type-safe Event and EventType classes
- 7 dedicated channels
- JSON serialization with Jackson

**5. Documentation**

Files:
- `docs/README_GRPC_ARCHITECTURE.md` - This file
- `docs/README_ARCHITECTURE.md` - System architecture
- `docs/README_MIGRATION_PRD_USER_ABSTRACTION.md` - Migration plan

---

### Phase 1: Gateway Routing (100% Complete)

**Status**: Completed (February 6, 2026)

**Achievements:**

**Gateway Configuration:**
- Gateway routes ALL endpoints to Kotlin BE
- User authentication through Kotlin
- Workspace/Collection management through Kotlin
- Document upload through Kotlin

**Session & Message Migration:**
- Sessions migrated to Kotlin BE
  - `SessionController`, `SessionService`, `Session` entity
- Messages migrated to Kotlin BE
  - `MessageController`, `MessageService`, `Message` entity
- Chat endpoint routing
  - `ChatController` proxies to Python via HTTP (temporary)

**Technical Details:**
- Created: `Session.kt`, `Message.kt` domain entities
- Created: `SessionRepository.kt`, `MessageRepository.kt`
- Created: `SessionService.kt`, `MessageService.kt`
- Created: `SessionController.kt`, `MessageController.kt`, `ChatController.kt`
- Created: `NotFoundException.kt` exception class
- Updated: Gateway routing for `/sessions`, `/messages`, `/chat` → Kotlin
- Dependencies: WebFlux for HTTP streaming, Hypersistence Utils for JSONB

**Security Pattern:**
- Spring Security `@AuthenticationPrincipal` pattern implemented
- Null-safety with `.orThrow()` extension pattern

**Database:**
- Tables `sessions` and `messages` already existed (migrations 005, 006)
- No new migrations needed

---

### Phase 2: gRPC Client/Server (100% Complete)

**Status**: Completed (February 6, 2026)

#### Kotlin gRPC Client ✅

**1. Proto Definitions**
- `ai_service.proto` - AI/ML service contract
  - `AIService` with `GenerateChat`, `ListAvailableModels`, `HealthCheck` RPCs
  - `ChatRequest` message (matches Python dto/chat.py)
  - `ChatResponsePacket` for streaming (matches Python PacketEmitter format)
  - `ListModelsRequest/Response`, `ModelInfo`, `HealthCheckResponse`

**2. gRPC Client Configuration**

Dependencies (`build.gradle.kts`):
- `grpc-client-spring-boot-starter:3.1.0.RELEASE`
- Protobuf plugin generates client stubs from ai_service.proto

Configuration (`application.yaml`):
```yaml
grpc:
  client:
    python-chat:
      address: dns:///scrapalot-chat:9091
      negotiationType: PLAINTEXT
      enableKeepAlive: true
      keepAliveTime: 30s
      maxInboundMessageSize: 10MB
```

Bean (`GrpcConfig.kt`):
- `aiServiceStub()` bean - `AIServiceCoroutineStub` for Kotlin coroutines
- Injected via `@GrpcClient("python-chat")`

**3. ChatService Implementation**

File: `service/ChatService.kt`

Features:
- `generateChatGrpc()` - gRPC streaming method
- `generateChatHttp()` - HTTP fallback (legacy Python REST API)
- `generateChatWithFallback()` - Automatic fallback: gRPC → HTTP
- `toGrpcRequest()` - Mapper extension: Kotlin DTO → gRPC proto

Fallback Logic:
```kotlin
try {
    // Try gRPC first
    val grpcFlow = generateChatGrpc(request)
    return grpcFlow.map { packet ->
        jacksonObjectMapper().writeValueAsString(packet)
    }.asFlux()
} catch (e: Exception) {
    logger.warn { "gRPC failed, falling back to HTTP" }
    return generateChatHttp(requestBodyJson)
}
```

**4. ChatController Migration**

File: `controller/ChatController.kt`

Changes:
- Replaced direct WebClient with ChatService injection
- Uses `chatService.generateChatWithFallback()`
- Converts Kotlin DTO → gRPC request via `toGrpcRequest()`
- Maintains HTTP streaming response format (NDJSON)

Flow:
```
POST /api/v1/chat/completions   (the OpenAI-compatible shim)
  ↓
OpenAICompatibleController → OpenAICompatibleService
  ↓
ChatService.generateChat()
  ↓
ChatGrpcClient → Python:9091
```

**5. End-to-End Testing**

Results:
- Gateway routing: `8080 → 8091` (confirmed)
- Backend health: UP (19s startup)
- gRPC server: RUNNING (port 9090, 11 services registered)
- Chat endpoint: HTTP 401/403 (auth required - routing confirmed)
- Python backend: HEALTHY (16.6h uptime)

Verified Flow:
```
UI → Gateway:8080 → Backend:8091 → ChatService
                           ↓
                    [gRPC client ready] ✅
                    [HTTP fallback active] ✅
```

**6. Build & Deployment**

CI/CD:
- 3 build attempts (fixed Flow→Flux conversion, proto nullability)
- Final deployment: SUCCESS
- Docker container: HEALTHY
- Production verified: All services UP

#### Python gRPC Server ✅

**1. Proto Generation**
- Copied `ai_service.proto` from Kotlin backend to Python project
- Generated Python stubs: `ai_service_pb2.py`, `ai_service_pb2_grpc.py`
- Fixed relative imports for module compatibility

**2. Server Implementation**

File: `src/main/service/grpc/ai_service_impl.py`

Features:
- `AIServiceImpl` class implementing `AIServiceServicer`
- `GenerateChat()` - Streaming RPC with async generator handling
- `ListAvailableModels()` - Model listing RPC
- `HealthCheck()` - Health check RPC
- Pydantic ChatRequest ↔ Proto ChatRequest conversion
- Async/await handling with event loop management

**3. Server Startup**

File: `run_service.py`

Features:
- `start_grpc_server_thread()` - Background thread for gRPC server
- Automatic startup with FastAPI server
- Graceful shutdown handling
- Port 9091 configuration

**4. Streaming Implementation**

```python
# Word-by-word streaming (test implementation)
for word in response_text.split():
    yield ai_service_pb2.ChatResponsePacket(
        type="message_delta",
        index=packet_index,
        data=json.dumps({"content": word + " "}),
    )
    await asyncio.sleep(0.05)  # Simulate streaming delay
```

**5. Docker Networking**
- Both containers in same Docker network: `docker-scrapalot_scrapalot-network`
- Internal communication: `scrapalot-backend` → `scrapalot-chat:9091`
- No external port mapping required

**6. End-to-End Testing**

Results:
```bash
# Python gRPC Server Test
🚀 Sending gRPC request: user=test-user-123
📦 Receiving 15+ streaming packets:
   [0] type=message_start
   [1-13] type=message_delta (word-by-word)
   [14] type=stream_end
gRPC test completed successfully!

# Network Connectivity
🔗 scrapalot-backend → scrapalot-chat:9091 (172.28.1.4:9091)
Port 9091 open
gRPC connection successful

# Gateway Routing
🌐 Frontend → Gateway:8080 → Backend:8091 → Python:9091
Request reaches backend (401 Unauthorized - auth required, as expected)
```

Test Results:
- Direct gRPC call: Working with streaming
- Docker networking: Backend can reach Python:9091
- Kotlin Backend health: UP
- Gateway routing: Functional (auth required for full E2E)

---

### Phase 2.5: gRPC AI Services Implementation (100% Complete)

**Status**: Completed (Q1 2026)

**Why the Plan Changed:**

Original plan required refactoring ALL Python controllers to use gRPC bridges (4+ weeks, high risk).

**NEW APPROACH (Revised February 7, 2026):**
- Python controllers STAY UNCHANGED (backward compatibility)
- ADD gRPC AI services alongside existing controllers
- Kotlin calls Python gRPC services (NOT Python REST controllers)
- User context (userId, workspaceId, collectionIds) sent as gRPC parameters
- Delete Python controllers ONLY after full UI testing confirms Kotlin works

**Scope:**
- Implement Python gRPC server for AI/ML operations
- Kotlin gRPC client calls Python AI services
- Python receives user IDs as parameters (no database access needed)
- NO changes to existing Python controllers

**Estimated Duration:** 3-4 weeks

**Key Tasks:**

**Week 1: gRPC Proto Definitions**
1. Create `scrapalot-backend/src/main/proto/`:
   - `ai_service.proto` - RAG queries, chat generation
   - `document_service.proto` - Document processing, embeddings
   - `settings_service.proto` - Model provider management
   - `common.proto` - Shared types (UUID, Timestamp, etc.)

2. Example proto messages:
   ```protobuf
   message ChatRequest {
     string query = 1;
     string user_id = 2;                  // User UUID (for logging/caching)
     string workspace_id = 3;             // Workspace UUID
     repeated string collection_ids = 4;  // Collection UUIDs
     repeated string document_ids = 5;    // Document UUIDs for RAG
     string rag_strategy = 6;
     string llm_model = 7;
     int32 top_k = 8;
   }
   ```

**Week 2: Python gRPC Server**
1. Implement `scrapalot-chat/src/main/grpc/ai_service_server.py`:
   ```python
   class AIServiceServicer(ai_service_pb2_grpc.AIServiceServicer):
       def GenerateChat(self, request, context):
           # Use request.user_id for logging/caching
           # Use request.document_ids for RAG retrieval
           # Stream response chunks
           for chunk in generate_rag_response(request):
               yield ChatResponsePacket(content=chunk)
   ```

2. Start gRPC server on port 9091 (alongside FastAPI on 8090)
3. NO changes to existing controllers (they continue working)

**Week 3: Kotlin gRPC Client**
1. Implement `ChatService.kt`:
   ```kotlin
   @Service
   class ChatService(
       private val aiServiceStub: AIServiceCoroutineStub
   ) {
       suspend fun generateChat(request: ChatRequest): Flow<String> {
           val grpcRequest = request.toGrpcRequest()
           return aiServiceStub.generateChat(grpcRequest)
               .map { it.content }
       }
   }
   ```

2. Update Kotlin controllers to use new services
3. Test Kotlin → gRPC → Python flow

**Week 4: Integration Testing**
1. Test end-to-end: UI → Gateway → Kotlin → gRPC → Python
2. Verify user context flows correctly
3. Performance testing (gRPC vs REST comparison)
4. Load testing (concurrent users)

**Success Criteria:**
- Python gRPC server running on port 9091
- Kotlin gRPC client can call Python AI services
- User context (userId, workspaceId, etc.) flows through gRPC
- Existing Python controllers still work (dual path)
- Gateway can route to EITHER Kotlin (new) OR Python (old)

**Benefits of New Approach:**
- Lower risk (Python controllers unchanged)
- Faster implementation (3-4 weeks vs 4+ weeks)
- Dual path allows gradual migration
- Easy rollback (fallback to Python controllers)
- Can test Kotlin controllers one-by-one

---

### Phase 3: Python Controller Deletion (100% Complete)

**Status**: Completed (Q1 2026) — All Python REST controllers removed, Python is pure gRPC + health.

**NEW APPROACH (Revised February 7, 2026):**
- Delete Python controllers ONLY after full UI verification
- Drop user tables from Python database
- Python becomes PURE gRPC service (no REST API)

**Scope:**
- Delete Python controllers one-by-one after confirming Kotlin works via UI
- Remove unused Python dependencies
- DROP user tables from Python database (`scrapalot`)
- Update Gateway routing to remove Python fallbacks
- Python exposes ONLY gRPC services

**Estimated Duration:** 2-3 weeks

**Key Tasks:**

**Week 1: UI Testing & Validation**
1. Test EVERY feature via UI using Kotlin controllers:
   - Authentication (login, logout, token refresh)
   - Users (profile, settings, preferences)
   - Workspaces (create, update, delete, sharing)
   - Collections (CRUD, permissions)
   - Documents (upload, metadata, reading positions)
   - Notes (CRUD, collaboration, versions)
   - Settings (user/system settings)
   - Chat (RAG queries, streaming, citations)
   - Sessions & Messages (history, retrieval)
   - Subscriptions (plans, billing)

2. Performance comparison (Kotlin vs Python)
3. Load testing (concurrent users)
4. User acceptance testing

**Week 2: Controller Deletion**
1. Delete Python controllers one-by-one:
   ```bash
   # After confirming auth.py functionality via UI:
   rm scrapalot-chat/src/main/controllers/auth.py

   # After confirming users.py functionality via UI:
   rm scrapalot-chat/src/main/controllers/users.py

   # Repeat for: workspaces.py, collections.py, notes.py,
   # settings.py, sessions.py, messages.py, subscriptions.py
   ```

2. Update Gateway routing (remove Python fallbacks):
   ```yaml
   # Remove these routes from scrapalot-gw/application.yml:
   - id: api-v1-fallback  # DELETE (no more Python REST)
   ```

3. Remove unused dependencies from `requirements.txt`

**Week 3: Database Cleanup**
1. Run Alembic migration 019 (drop user tables):
   ```bash
   docker exec scrapalot-chat alembic upgrade head
   ```

2. Verify Python works WITHOUT user tables:
   ```bash
   # Should NOT error - Python uses gRPC for user context
   curl http://scrapalot-chat:8090/health
   ```

3. Monitor Python logs for any user table references

**Progress:**

**Completed:**
- **Analyzed Python database schema** (February 6, 2026)
  - Confirmed users, workspaces, collections, sessions, messages exist in Kotlin DB
  - Identified FK constraints that need to be dropped
  - Categorized tables: DROP vs KEEP

- **Created Alembic migration 019** (February 6, 2026)
  - File: `alembic/versions/019_phase_3_remove_user_tables_migrated_to_kotlin.py`
  - Drops FK constraints from remaining tables (documents, connectors, model_providers)
  - Drops 20+ tables: users, workspaces, collections, sessions, messages, notes, jobs, settings
  - Keeps AI/ML data: documents, embeddings, research_*, langchain_pg_*, connectors
  - Uses CASCADE for automatic FK dependency handling
  - Includes detailed logging and emergency rollback procedure

- **Static analysis completed** (February 6, 2026)
  - Report: `scrapalot-chat/docs/PHASE_3_STATIC_ANALYSIS_REPORT.md`
  - **CRITICAL FINDINGS:**
    - 8 SQLModel definitions for user-related tables (MUST REMOVE)
    - 17 controllers with direct User/Workspace/Collection imports
    - 44 direct database queries to tables that will be dropped
    - gRPC bridge pattern NOT implemented
  - **CONCLUSION: Migration BLOCKED**

**Tables to DROP** (now in Kotlin @ `scrapalot_backend`):
```
users, workspaces, workspace_users, collections
sessions, messages, chat_conversations, session_documents
notes, note_versions, note_shares, note_comments
user_settings, system_settings, server_settings
jobs, task_progress
api_keys, user_subscriptions, subscription_plans, user_token_usage
stripe_webhook_events
```

**Tables to KEEP** (AI/ML data only):
```
documents, document_chunks, document_embeddings, document_summaries, reading_positions
research_plans, research_tasks, research_sources, research_synthesis, research_templates
langchain_pg_collection, langchain_pg_embedding
connectors, connector_credentials, connector_file_syncs, connector_sync_jobs, connector_sync_destinations, connector_oauth_states
model_providers, model_provider_models
graph_sync_status
alembic_version
```

**Migration completed in Q1 2026.** All user tables dropped from Python database, all REST controllers removed, Python serves only gRPC + health + Y.js WebSocket.

---

### Phase 4: Python API Simplification (100% Complete)

**Status**: Completed (Q1 2026)

**Scope:**
- Remove FastAPI completely
- Python exposes ONLY gRPC services
- Simplify Python startup (no REST API initialization)

**Estimated Duration:** 1 week

**Prerequisites:**
- Phase 3 must be complete
- All Kotlin → Python communication via gRPC
- No REST endpoints left in Python

---

### Phase 5: Production Deploy (100% Complete)

**Status**: Completed (Q1 2026)

**Scope:**
- Deploy complete architecture to production
- Monitor performance and stability
- Rollback plan ready

**Estimated Duration:** 1 week

**Prerequisites:**
- All previous phases complete
- Full end-to-end testing passed
- Load testing completed
- Monitoring and alerting configured

---

## Implementation Examples

### Example 1: User Asks AI Question

**Complete flow through architecture:**

**1. UI sends chat query to Gateway:**
```typescript
const response = await axios.post('https://api.scrapalot.app/api/v1/chat', {
  query: "Explain photosynthesis",
  session_id: sessionId
});
```

**2. Gateway routes to Kotlin BE:**
```
Gateway → scrapalot-backend:8091/api/v1/chat
```

**3. Kotlin validates user and calls Python via gRPC:**
```kotlin
@PostMapping("/chat")
fun chat(@RequestBody request: ChatRequest, principal: Principal): ChatResponse {
    // Kotlin validates user
    val user = userService.getUserByPrincipal(principal)

    // Kotlin calls Python via gRPC WITHOUT user context
    val ragResult = aiServiceClient.executeRAGQuery(
        queryText = request.query,
        ragStrategy = "adaptive",
        llmModel = "gpt-4o",
        documentIds = request.document_ids  // Just document IDs, no user info
    )

    // Kotlin saves message in its database
    messageService.saveMessage(user.id, request.session_id, ragResult)

    return ChatResponse(answer = ragResult.answer)
}
```

**4. Python executes RAG without knowing user:**
```python
def execute_rag_query(request: RAGQueryRequest) -> RAGQueryResponse:
    # Python has NO idea which user this is for
    # Just executes AI/ML task
    chunks = vector_search(request.query_text, request.document_ids)
    answer = llm_inference(request.query_text, chunks, request.llm_model)

    return RAGQueryResponse(answer=answer, chunks=chunks)
```

---

### Example 2: Document Upload Flow

**1. UI uploads document to Gateway:**
```typescript
const formData = new FormData();
formData.append('file', file);
formData.append('collectionId', collectionId);

const response = await axios.post('/api/v1/documents', formData);
```

**2. Gateway routes to Kotlin:**
```
Gateway → scrapalot-backend:8091/api/v1/documents
```

**3. Kotlin saves metadata and publishes event:**
```kotlin
@PostMapping("/documents")
fun uploadDocument(@RequestParam file: MultipartFile): DocumentResponse {
    // Save file and metadata in Kotlin's database
    val document = documentService.saveDocument(file, collectionId, userId)

    // Publish AI task event to Redis (NO user info)
    redisEventPublisher.publishAITask(
        type = EventType.PROCESS_DOCUMENT,
        documentId = document.id!!,
        payload = mapOf(
            "content" to fileContent,
            "chunking_strategy" to "contextual_retrieval"
        )
    )

    return documentMapper.toDocumentResponse(document)
}
```

**4. Python listens and processes:**
```python
def on_process_document(event: dict):
    document_id = UUID(event['documentId'])
    content = event['payload']['content']

    # Process document WITHOUT knowing user
    chunks = chunk_document(content, strategy='contextual_retrieval')
    embeddings = generate_embeddings(chunks)
    store_in_vector_db(document_id, chunks, embeddings)

    # Publish completion (NO user_id)
    publish_processing_complete(document_id)
```

**5. Kotlin receives completion and notifies user:**
```kotlin
@RedisMessageListener(channel = "scrapalot:events:ai-results")
fun onAIResult(message: String) {
    val event = parseEvent(message)
    if (event.type == EventType.DOCUMENT_PROCESSING_COMPLETED) {
        // Lookup document to get user
        val document = documentService.getDocument(event.documentId!!)

        // Notify user via WebSocket
        notificationService.sendDocumentProcessingUpdate(
            userId = document.userId,
            documentId = event.documentId!!,
            status = "completed"
        )
    }
}
```

---

## Testing

### Test Kotlin gRPC Server

**1. Start Kotlin Backend:**
```bash
cd scrapalot-backend
./gradlew bootRun --args='--spring.profiles.active=dev'
```

**2. Verify gRPC is running:**
```bash
# Check port 9090 is listening
netstat -an | grep 9090

# List gRPC services (requires grpcurl)
grpcurl -plaintext localhost:9090 list
```

**Expected output:**
```
grpc.reflection.v1alpha.ServerReflection
scrapalot.workspace.WorkspaceService
scrapalot.collection.CollectionService
scrapalot.document.DocumentService
scrapalot.settings.SettingsService
```

**3. Call a gRPC service:**
```bash
grpcurl -plaintext -d '{"document_id": "123e4567-e89b-12d3-a456-426614174000"}' \
  localhost:9090 scrapalot.document.DocumentService/GetDocumentContent
```

---

### Test Python gRPC Server

**1. Test GenerateChat RPC:**
```bash
cd scrapalot-chat

# Python test script
python -c "
import grpc
from src.main.service.grpc import ai_service_pb2, ai_service_pb2_grpc

channel = grpc.insecure_channel('localhost:9091')
stub = ai_service_pb2_grpc.AIServiceStub(channel)

request = ai_service_pb2.ChatRequest(
    user_id='test-user',
    query='Hello, how are you?',
    session_id='test-session'
)

for response in stub.GenerateChat(request):
    print(f'Packet: {response.type} - {response.data}')
"
```

**2. Verify Health Check:**
```bash
grpcurl -plaintext localhost:9091 scrapalot.ai.AIService/HealthCheck
```

---

### Test Redis Streams SAGA

**1. Subscribe to AI tasks:**
```bash
redis-cli SUBSCRIBE scrapalot:events:ai-tasks
```

**2. Publish test event from Kotlin:**
```kotlin
redisEventPublisher.publishAITask(
    type = EventType.PROCESS_DOCUMENT,
    documentId = UUID.randomUUID(),
    payload = mapOf("test" to "event")
)
```

**3. Verify event received** in redis-cli subscriber

**4. Subscribe to AI results:**
```bash
redis-cli SUBSCRIBE scrapalot:events:ai-results
```

**5. Publish test result from Python:**
```python
redis_client.publish('scrapalot:events:ai-results', json.dumps({
    'type': 'DOCUMENT_PROCESSING_COMPLETED',
    'documentId': str(uuid.uuid4())
}))
```

---

### Test Gateway Routing

```bash
# Test auth endpoint (should go to Kotlin)
curl https://api.scrapalot.app/api/v1/auth/login

# Test workspace endpoint (should go to Kotlin)
curl -H "Authorization: Bearer TOKEN" https://api.scrapalot.app/api/v1/workspaces

# Test chat endpoint (Kotlin → Python gRPC)
curl -H "Authorization: Bearer TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"query":"Hello","session_id":"123"}' \
     https://api.scrapalot.app/api/v1/chat
```

---

### Test Docker Networking

```bash
# Test Backend → Python connectivity
docker exec scrapalot-backend nc -zv scrapalot-chat 9091

# Expected: Connection to scrapalot-chat 9091 port [tcp/*] succeeded!

# Test Python → Backend connectivity
docker exec scrapalot-chat nc -zv scrapalot-backend 9090

# Expected: Connection to scrapalot-backend 9090 port [tcp/*] succeeded!
```

---

## Production Considerations

### 1. gRPC Security

**Enable TLS in production:**

```yaml
# Kotlin Backend
grpc:
  server:
    security:
      enabled: true
      certificate-chain: classpath:certs/server.crt
      private-key: classpath:certs/server.key
```

**Generate certificates:**
```bash
# Self-signed for development
openssl req -x509 -newkey rsa:4096 -keyout server.key -out server.crt -days 365 -nodes

# Production: Use Let's Encrypt or corporate CA
```

---

### 2. Redis Security

**Use password and TLS:**

```yaml
redis:
  password: ${REDIS_PASSWORD}
  ssl: true
  ssl-bundle-name: redis-ssl
```

**Redis ACL (Access Control Lists):**
```bash
# Create separate users for Kotlin and Python
redis-cli ACL SETUSER kotlin-backend on >password ~scrapalot:events:* +@all
redis-cli ACL SETUSER python-chat on >password ~scrapalot:events:* +@all
```

---

### 3. Load Balancing

**Gateway load balancing:**
- Gateway can route to multiple Kotlin instances
- Session affinity for WebSocket connections
- Health checks every 30s

**gRPC load balancing:**
- Use gRPC client-side load balancing
- Or deploy behind Envoy/Linkerd
- Round-robin or least-request strategies

**Redis high availability:**
- Use Redis Sentinel for failover
- Or Redis Cluster for sharding
- Monitor replication lag

---

### 4. Monitoring

**Metrics to track:**

**gRPC Metrics:**
- Request rate (requests/sec)
- Latency (p50, p95, p99)
- Error rate (%)
- Active connections

**Redis Metrics:**
- Streams SAGA message rate
- Event processing latency
- Queue length
- Memory usage

**Gateway Metrics:**
- Request rate by backend
- Backend health status
- Circuit breaker state

**Prometheus Configuration:**
```yaml
# scrape_configs
- job_name: 'kotlin-backend'
  static_configs:
    - targets: ['scrapalot-backend:8091']
  metrics_path: '/actuator/prometheus'

- job_name: 'python-chat'
  static_configs:
    - targets: ['scrapalot-chat:8090']
  metrics_path: '/metrics'
```

---

### 5. Circuit Breakers

**Implement circuit breakers for gRPC calls:**

```kotlin
@Service
class ResilientChatService(
    private val aiServiceStub: AIServiceCoroutineStub
) {
    private val circuitBreaker = CircuitBreaker.of(
        "python-chat-service",
        CircuitBreakerConfig.custom()
            .failureRateThreshold(50.0)
            .waitDurationInOpenState(Duration.ofSeconds(60))
            .slidingWindowSize(10)
            .build()
    )

    suspend fun generateChat(request: ChatRequest): Flow<ChatResponse> {
        return circuitBreaker.executeFlowFunction {
            aiServiceStub.generateChat(request)
        }
    }
}
```

---

## Troubleshooting

### gRPC Connection Issues

**Problem**: Python cannot connect to Kotlin gRPC server

**Solutions**:
1. Check firewall allows port 9090
   ```bash
   sudo ufw allow 9090/tcp
   ```

2. Verify gRPC server is running:
   ```bash
   netstat -an | grep 9090
   docker logs scrapalot-backend | grep -i grpc
   ```

3. Check gRPC reflection is enabled:
   ```bash
   grpcurl -plaintext localhost:9090 list
   ```

4. Test from Python container:
   ```bash
   docker exec scrapalot-chat nc -zv scrapalot-backend 9090
   ```

5. Check Docker network:
   ```bash
   docker network inspect docker-scrapalot_scrapalot-network
   ```

---

### Redis Streams SAGA Not Working

**Problem**: Events not received

**Solutions**:
1. Check Redis is running:
   ```bash
   redis-cli ping
   docker ps | grep redis
   ```

2. Verify connection:
   ```bash
   redis-cli MONITOR
   ```

3. Check channel subscription:
   ```bash
   redis-cli PUBSUB CHANNELS "scrapalot:*"
   ```

4. Verify Redis password:
   ```bash
   docker exec redis redis-cli -a $REDIS_PASSWORD ping
   ```

5. Check Redis database:
   ```bash
   # Kotlin uses DB 1
   docker exec redis redis-cli -a $REDIS_PASSWORD -n 1 INFO

   # Python uses DB 0
   docker exec redis redis-cli -a $REDIS_PASSWORD -n 0 INFO
   ```

---

### Gateway Routing Issues

**Problem**: Requests going to wrong backend

**Solutions**:
1. Check Gateway routing configuration:
   ```bash
   docker logs scrapalot-gw | grep -i route
   ```

2. Verify backend health endpoints:
   ```bash
   curl http://scrapalot-backend:8091/actuator/health
   curl http://scrapalot-chat:8090/health
   ```

3. Test direct backend access (bypass Gateway):
   ```bash
   curl -H "Authorization: Bearer TOKEN" http://localhost:8091/api/v1/workspaces
   ```

4. Review Gateway logs:
   ```bash
   docker logs scrapalot-gw -f
   ```

---

### Kotlin gRPC Client Issues

**Problem**: Kotlin cannot call Python gRPC server

**Solutions**:
1. Check Python gRPC server is running:
   ```bash
   docker logs scrapalot-chat | grep -i "grpc server"
   docker exec scrapalot-chat netstat -tuln | grep 9091
   ```

2. Verify gRPC client configuration:
   ```bash
   docker exec scrapalot-backend env | grep GRPC
   ```

3. Test connectivity:
   ```bash
   docker exec scrapalot-backend nc -zv scrapalot-chat 9091
   ```

4. Check for errors in Kotlin logs:
   ```bash
   docker logs scrapalot-backend | grep -i "grpc\|python-chat"
   ```

5. Verify proto files are in sync:
   ```bash
   # Compare proto files
   diff scrapalot-backend/src/main/proto/ai_service.proto \
        scrapalot-chat/src/main/grpc/proto/ai_service.proto
   ```

---

### Python gRPC Server Issues

**Problem**: Python gRPC server not responding

**Solutions**:
1. Check server startup:
   ```bash
   docker logs scrapalot-chat | grep "gRPC server"
   ```

2. Verify port 9091 is listening:
   ```bash
   docker exec scrapalot-chat netstat -tuln | grep 9091
   ```

3. Test locally from Python container:
   ```bash
   docker exec -it scrapalot-chat python
   >>> import grpc
   >>> channel = grpc.insecure_channel('localhost:9091')
   >>> channel._channel.check_connectivity_state(True)
   ```

4. Check for gRPC errors:
   ```bash
   docker logs scrapalot-chat | grep -i "grpc\|error"
   ```

---

## Summary

### Architecture Benefits

**New Architecture Advantages:**
- **Clear Separation**: Kotlin (business) vs Python (AI/ML)
- **Gateway Entry Point**: Single API entry for all clients
- **No User Leakage**: Python never sees user data
- **Flexible Communication**: gRPC (sync) + Redis (async)
- **Real-time Updates**: Redis Streams SAGA + WebSocket to UI
- **Type Safety**: Protocol Buffers for gRPC
- **Scalability**: Independent scaling of services
- **Security**: User auth/authz handled by Kotlin only

### Data Flow

```
UI → Gateway → Kotlin BE (user data) → gRPC → Python CHAT (AI/ML)
                    ↓                                ↓
              scrapalot_backend                scrapalot
              (users, auth, etc.)          (vectors, embeddings)
```

### Implementation Status Summary

**What's Ready:**

**Phase 0 - Foundation** (100%)
- Kotlin Backend with gRPC server on port 9090
- Gateway routing infrastructure
- 7 gRPC services with proto definitions
- Redis Streams SAGA event system
- Event publisher with 7 dedicated channels
- Comprehensive documentation

**Phase 1 - Gateway Routing** (100%)
- ALL user-facing endpoints route through Gateway → Kotlin
- Chat endpoint migrated to Kotlin (gRPC to Python)
- Session management fully migrated to Kotlin
- Message management fully migrated to Kotlin
- Spring Security authentication pattern implemented

**Phase 2 - gRPC Client/Server** (100%)
- Kotlin gRPC client configured (`AIServiceCoroutineStub`)
- `ChatService` with gRPC + HTTP fallback
- `ChatController` uses ChatService
- Python gRPC server implemented (AIService)
- `GenerateChat` RPC with streaming support
- Docker networking configured
- End-to-end testing completed

**All Phases Completed (Q1 2026):**

- Phase 2.5: gRPC bridge refactoring — 19 gRPC clients in Kotlin, Python REST removed
- Phase 3: Database cleanup — user tables dropped from Python, Alembic migration executed
- Phase 4: Python API simplification — Python serves gRPC (9091) + health + Y.js WebSocket only
- Phase 5: Production deploy — live on Hetzner CX33

### Current Architecture

- UI → Gateway → Kotlin for ALL user operations
- Kotlin → Python via gRPC streaming (19 clients, port 9091)
- Cross-service sync via Redis Streams SAGA (guaranteed delivery)
- Python gRPC server operational on port 9091
- Python focuses on RAG/LLM ONLY (pure AI/ML service)

---

## Related Documentation

- [System Architecture](./README_ARCHITECTURE.md) - Complete system overview
- [Migration PRD](./README_MIGRATION_PRD_USER_ABSTRACTION.md) - Migration plan
- [Deployment Guide](./README_DEPLOYMENT_GUIDE.md) - Deployment procedures
- [Nginx Routing](../../scrapalot-gw/docs/README_NGINX_ROUTING.md) - Gateway-based routing
- [WebSocket Integration](./README_WEBSOCKET_INTEGRATION.md) - WebSocket setup

---

**Version**: 3.0.0
**Last Updated**: March 2026
**Status**: Migration COMPLETE - All phases delivered Q1 2026
