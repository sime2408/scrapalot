# API Layer Architecture

**Last Updated**: March 2026

Frontend API layer with centralized auth, caching, deduplication, and real-time WebSocket support.

## Overview

```
Component → API Module → apiClient (Axios) → Gateway (port 8080) → Backend Services
                ↓
         authState.waitForAuthReady()
                ↓
         Request Interceptor (dedup, cache, timeout)
                ↓
         Response Interceptor (error handling, token refresh)
```

**IMPORTANT**: ALL API calls go through the Gateway (port 8080). No direct calls to Python (8090) or Kotlin (8091) backends.

## Core Files

| File | Size | Purpose |
|------|------|---------|
| `src/lib/api.ts` | 57KB (1,722 lines) | Base client, auth, streaming |
| `src/lib/stomp-service.ts` | 374 lines | WebSocket/STOMP singleton |
| `src/lib/api-documents.ts` | 39KB | Document processing tracker |
| `src/lib/api-llm-inference.ts` | 45KB | LLM provider models, inference |
| `src/lib/api-settings.ts` | 37KB | User settings, system config |

## API Modules (32 Files)

| Module | Purpose |
|--------|---------|
| `api.ts` | Base client, auth, `streamChat()`, request/response interceptors |
| `api-admin.ts` | Admin operations, user management |
| `api-annotations.ts` | Document annotations CRUD |
| `api-collections.ts` | Collection management, pagination |
| `api-connectors.ts` | External service connectors |
| `api-document-inspector.ts` | RAG tracing, LLM trace analysis |
| `api-document-relations.ts` | Document relationship management |
| `api-documents.ts` | Document uploads, processing tracker, job management |
| `api-duplicates.ts` | Duplicate document detection |
| `api-external-books.ts` | External book sources (Library Genesis, etc.) |
| `api-invitation.ts` | User invitation management |
| `api-llm-inference.ts` | LLM provider models, inference, model fetching |
| `api-local-ai.ts` | Local LLM inference endpoints |
| `api-messages.ts` | Message CRUD operations, history |
| `api-metadata.ts` | Document metadata extraction |
| `api-notes.ts` | Notes/document editing, autosave |
| `api-research.ts` | Deep research endpoints, plan loading |
| `api-saved-searches.ts` | Saved search queries |
| `api-session-folders.ts` | Session folder organization |
| `api-session-shares.ts` | Session sharing |
| `api-sessions.ts` | Session/conversation management, CRUD |
| `api-settings.ts` | User settings, model config, system preferences |
| `api-storage.ts` | Storage quota and usage tracking |
| `api-stripe.ts` | Stripe payment integration |
| `api-stt.ts` | Speech-to-text |
| `api-subscriptions.ts` | Billing and subscription management |
| `api-tags.ts` | Document tagging |
| `api-tts.ts` | Text-to-speech (Edge-TTS) |
| `api-users.ts` | User profile, authentication, registration |
| `api-utils.ts` | Caching utilities, cache key generation |
| `api-workspace.ts` | Workspace management, team collaboration |
| `api-workspace-chat.ts` | Workspace-level chat |

**Total**: 32 API modules

## Auth State Pattern

```typescript
import { authState } from '@/lib/api';

// REQUIRED before any API call
await authState.waitForAuthReady(5000);
const response = await apiClient.get('/endpoint');
```

### authState Object

```typescript
export const authState = {
  authReady: boolean;
  authReadyPromise: Promise<void> | null;
  authReadyResolve: (() => void) | null;

  setAuthReady(ready: boolean): void;
  async waitForAuthReady(timeoutMs = 2000): Promise<boolean>;
}
```

## Endpoint Timeouts

```typescript
const ENDPOINT_TIMEOUTS = {
  '/documents/upload': 300000,        // 5 minutes
  '/documents/upload_async': 300000,  // 5 minutes
  '/documents/process': 300000,       // 5 minutes
  '/jobs/': 180000,                   // 3 minutes
  '/chat/': 120000,                   // 2 minutes
  '/settings/': 90000,                // 1.5 minutes
  'default': 60000                    // 1 minute
};
```

## Request Deduplication

- **Window**: 5 seconds
- **Scope**: GET requests only
- **Key**: `{method}:{url}:{params}`
- **Behavior**: Returns existing promise for duplicates

```typescript
// Concurrent calls to same endpoint share one request
const [a, b] = await Promise.all([
  apiClient.get('/sessions'),
  apiClient.get('/sessions'),  // Returns same promise
]);
```

## Response Caching

```typescript
const CACHE_TTL = 60000;  // 1 minute

// Exclusions (never cached):
// - /users/token
// - /login
// - /service-logs
// - Binary data (ArrayBuffer, Blob)
```

### Cache Clearing

```typescript
import { clearCache } from '@/lib/api';

clearCache('/sessions');  // Clear specific pattern
clearCache();             // Clear all
```

## Error Handling

| Status | Behavior |
|--------|----------|
| 401 | Token refresh with retry |
| 403 | Forbidden error |
| 503 | Redirect to login |
| Timeout | Toast notification |
| Connection | Retry dialog |

## Streaming Chat

```typescript
import { streamChat } from '@/lib/api';

const { reader, cancel } = await streamChat(
  request,
  onChunk: (data) => { /* handle chunk */ },
  onError: (error) => { /* handle error */ },
  onEnd: () => { /* cleanup */ },
  timeout: 60000,
  signal?: AbortSignal
);

// Later
cancel();  // Abort stream
```

## STOMP WebSocket Service

### Connection

```typescript
import stompService from '@/lib/stomp-service';  // Singleton!

await stompService.connect();
```

### WebSocket URLs

| Environment | URL |
|-------------|-----|
| Production | `wss://api.scrapalot.app/stomp-direct/ws` |
| Localhost | `ws://localhost:8090/stomp-direct/ws` |

### Subscriptions

```typescript
// Job updates
const unsubscribe = stompService.subscribeToJobUpdates(jobId, (message) => {
  console.log(message.progress, message.status);
});

// User jobs
stompService.subscribeToUserJobs(userId, callback);

// Workspace notifications
stompService.subscribeToWorkspaceNotifications(userId, callback);
```

### Topic Format

- `/topic/job.{jobId}` - Individual job
- `/topic/user.{userId}.jobs` - All user jobs

### Connection Features

- Heartbeat: 4000ms incoming/outgoing
- Reconnection: Exponential backoff (max 5 attempts)
- Auto-resubscribe on reconnection

## Document Processing Tracker

Advanced job tracking with multiple transport fallbacks:

```typescript
import { DocumentProcessingTracker } from '@/lib/api-documents';

const tracker = new DocumentProcessingTracker({
  jobId: response.job_id,
  onProgress: (progress, message, status) => {
    setProgress(progress);  // 0-100
    setMessage(message);
  },
  onComplete: () => { /* refresh UI */ },
  onError: (error) => { /* handle error */ }
});

// Later
tracker.abort();
```

### Tracking Strategies (Priority Order)

1. **STOMP** - Real-time via `/topic/job.{jobId}`
2. **Polling** - 500ms-2000ms adaptive intervals

## Caching Utilities

```typescript
import {
  generateCacheKey,
  checkCacheValidity,
  setCacheData,
  invalidateCache
} from '@/lib/api-utils';

const cacheKey = generateCacheKey('sessions', { page, pageSize });
const cached = checkCacheValidity<Session[]>(cacheKey);
if (cached) return cached;

const response = await apiClient.get('/sessions', { params });
setCacheData(cacheKey, response.data, API_CONFIG.CACHE_TTL);
```

### Cache Configuration

```typescript
const API_CONFIG = {
  DEFAULT_TIMEOUT: 60000,        // 60 seconds
  CACHE_TTL: 300000,             // 5 minutes
  FRESH_CACHE_THRESHOLD: 30000,  // 30 seconds
  SHORT_CACHE_TTL: 60000,        // 1 minute
};
```

## Token Storage

**Priority Order**:
1. `sessionStorage` (current session only)
2. `localStorage` (persistent/remembered logins)

```typescript
// Login with remember me
await login(username, password, true);  // Stores in localStorage
await login(username, password, false); // Stores in sessionStorage only
```

## Critical Patterns

### Auth Check (Required)

```typescript
// ALWAYS before API calls
await authState.waitForAuthReady(5000);
const response = await apiClient.get('/endpoint');
```

### Error Recovery

```typescript
try {
  const response = await apiClient.get(url);
  return response.data;
} catch (error) {
  if (error.response?.status === 404) {
    return null;  // Graceful handling
  }
  throw error;
}
```

### Graceful Degradation

- Returns empty arrays/objects instead of throwing
- Prevents component crashes from API errors
- Sensible defaults for settings endpoints

## Common Gotchas

1. **STOMP Singleton**: Use default export `import stompService from '@/lib/stomp-service'`
2. **Auth First**: ALWAYS `await authState.waitForAuthReady()` before API calls
3. **React Query**: Configured but NOT used - use direct axios
4. **Sessions vs Conversations**: Backend uses "sessions", frontend historically "conversations"

---

*See backend docs: `scrapalot-chat/docs/README_WEBSOCKET_ARCHITECTURE.md`*
