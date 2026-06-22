# WebSocket Integration Guide

**Version**: 1.1.0
**Last Updated**: March 2026

## Overview

**⚠️ NEW ARCHITECTURE**: WebSockets go through **Kotlin Backend ONLY** (not Python).

Flow: `UI → Gateway → Kotlin BE WebSocket`

Kotlin Backend provides real-time communication using WebSockets with STOMP protocol. This enables:
- Real-time notifications
- Document processing progress updates (from Python via Redis → Kotlin → WebSocket)
- Entity updates (workspaces, collections, documents, notes)
- User-specific and workspace-wide broadcasts

**Python CHAT does NOT expose WebSockets** - it publishes events to Redis, Kotlin forwards to users via WebSocket.

## Architecture

### Components

1. **WebSocketConfig** - STOMP endpoint and message broker configuration
2. **NotificationService** - Service for sending real-time messages
3. **WebSocketEventListener** - Connection lifecycle logging
4. **Message Models** - Type-safe notification messages

### Endpoints

**STOMP Endpoints** (registered in `WebSocketConfig.kt`, each with and without SockJS):
- `/stomp-direct/ws` - direct STOMP connection
- `/stomp-backend/ws` - backend-routed STOMP
- `/stomp/ws` - default STOMP
- Example SockJS fallback: `http://localhost:8091/stomp-direct/ws`
- Example native WebSocket: `ws://localhost:8091/stomp-direct/ws`

**Message Brokers**:
- `/topic/*` - Broadcast to all subscribers
- `/queue/*` - User-specific messages
- `/app/*` - Client-to-server (application destination prefix)
- `/user/*` - User destination prefix (e.g. `/user/queue/notifications` via `convertAndSendToUser`)

## Frontend Integration (React)

### Installation

```bash
npm install @stomp/stompjs sockjs-client
```

### Basic Connection

```typescript
import { Client } from '@stomp/stompjs';
import SockJS from 'sockjs-client';

const client = new Client({
  webSocketFactory: () => new SockJS('http://localhost:8091/stomp-direct/ws'),
  connectHeaders: {
    Authorization: `Bearer ${accessToken}`
  },
  debug: (str) => console.log('STOMP:', str),
  onConnect: (frame) => {
    console.log('Connected:', frame);
  },
  onStompError: (frame) => {
    console.error('STOMP error:', frame);
  }
});

client.activate();
```

### Subscribe to User Notifications

```typescript
// Subscribe to user-specific notifications
client.subscribe(`/user/queue/notifications`, (message) => {
  const notification = JSON.parse(message.body);
  console.log('Notification:', notification);

  // Handle notification
  switch (notification.type) {
    case 'DOCUMENT_PROCESSING_COMPLETED':
      // Refresh document list
      break;
    case 'NOTE_SHARED':
      // Show notification
      break;
  }
});
```

### Subscribe to Document Processing Updates

```typescript
client.subscribe(`/user/queue/document-processing`, (message) => {
  const update = JSON.parse(message.body);

  // Update progress bar
  setDocumentProgress(prev => ({
    ...prev,
    [update.documentId]: {
      fileName: update.fileName,
      status: update.status,
      progress: update.progress,
      message: update.message,
      error: update.error
    }
  }));
});
```

### Subscribe to Workspace Updates

```typescript
client.subscribe(`/topic/workspace/${workspaceId}/updates`, (message) => {
  const update = JSON.parse(message.body);

  // Handle entity updates
  if (update.entityType === 'collection' && update.action === 'created') {
    // Refresh collections list
  }
});
```

### Disconnect

```typescript
client.deactivate();
```

## Backend Usage

### Send Notification to User

```kotlin
@Service
class DocumentService(
    private val notificationService: NotificationService
) {

    fun processDocument(documentId: UUID, userId: UUID) {
        // Start processing
        notificationService.sendDocumentProcessingUpdate(
            userId = userId,
            documentId = documentId,
            fileName = "document.pdf",
            status = "processing",
            progress = 0
        )

        // ... processing logic ...

        // Update progress
        notificationService.sendDocumentProcessingUpdate(
            userId = userId,
            documentId = documentId,
            fileName = "document.pdf",
            status = "processing",
            progress = 50
        )

        // Complete
        notificationService.sendDocumentProcessingUpdate(
            userId = userId,
            documentId = documentId,
            fileName = "document.pdf",
            status = "completed",
            progress = 100,
            message = "Processing completed successfully"
        )
    }
}
```

### Send Entity Update to Workspace

```kotlin
@Service
class CollectionService(
    private val notificationService: NotificationService
) {

    fun createCollection(request: CreateCollectionRequest, userId: UUID): Collection {
        val collection = collectionRepository.save(/* ... */)

        // Notify workspace members
        notificationService.sendEntityUpdate(
            workspaceId = collection.workspaceId,
            entityType = "collection",
            entityId = collection.id!!,
            action = "created",
            userId = userId,
            data = mapOf(
                "name" to collection.name,
                "description" to collection.description
            )
        )

        return collection
    }
}
```

### Broadcast System Notification

```kotlin
notificationService.broadcast(
    NotificationMessage(
        type = NotificationType.SYSTEM_NOTIFICATION,
        title = "System Maintenance",
        message = "Scheduled maintenance in 30 minutes",
        data = mapOf("maintenanceTime" to "2025-12-08T02:00:00Z")
    )
)
```

## Message Types

### NotificationType Enum

```kotlin
enum class NotificationType {
    DOCUMENT_PROCESSING_STARTED,
    DOCUMENT_PROCESSING_PROGRESS,
    DOCUMENT_PROCESSING_COMPLETED,
    DOCUMENT_PROCESSING_FAILED,
    COLLECTION_UPDATED,
    WORKSPACE_UPDATED,
    NOTE_UPDATED,
    NOTE_SHARED,
    COMMENT_ADDED,
    SYSTEM_NOTIFICATION
}
```

### NotificationMessage

```kotlin
data class NotificationMessage(
    val id: UUID,
    val type: NotificationType,
    val title: String,
    val message: String,
    val data: Map<String, Any>?,
    val timestamp: Instant,
    val userId: UUID?,
    val workspaceId: UUID?
)
```

### DocumentProcessingNotification

```kotlin
data class DocumentProcessingNotification(
    val documentId: UUID,
    val fileName: String,
    val status: String,        // "processing", "completed", "failed"
    val progress: Int,          // 0-100
    val message: String?,
    val error: String?
)
```

### EntityUpdateNotification

```kotlin
data class EntityUpdateNotification(
    val entityType: String,     // "workspace", "collection", "document", "note"
    val entityId: UUID,
    val action: String,         // "created", "updated", "deleted"
    val userId: UUID,
    val data: Map<String, Any>?
)
```

## Subscription Patterns

### User-Specific Subscriptions

```
/user/queue/notifications          - General notifications
/user/queue/document-processing   - Document processing updates
/user/queue/messages              - Direct messages
```

### Workspace Subscriptions

```
/topic/workspace/{workspaceId}              - General workspace messages
/topic/workspace/{workspaceId}/updates      - Entity updates
/topic/workspace/{workspaceId}/chat         - Workspace chat
```

### Global Subscriptions

```
/topic/notifications              - System-wide announcements
/topic/status                     - Service status updates
```

## React Hook Example

```typescript
import { useEffect, useState } from 'react';
import { Client } from '@stomp/stompjs';
import SockJS from 'sockjs-client';

export function useWebSocket(userId: string, accessToken: string) {
  const [client, setClient] = useState<Client | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const stompClient = new Client({
      webSocketFactory: () => new SockJS('http://localhost:8091/stomp-direct/ws'),
      connectHeaders: {
        Authorization: `Bearer ${accessToken}`
      },
      onConnect: () => {
        setConnected(true);

        // Subscribe to user notifications
        stompClient.subscribe(`/user/queue/notifications`, (message) => {
          const notification = JSON.parse(message.body);
          // Handle notification (e.g., show toast)
        });

        // Subscribe to document processing
        stompClient.subscribe(`/user/queue/document-processing`, (message) => {
          const update = JSON.parse(message.body);
          // Update UI with progress
        });
      },
      onDisconnect: () => {
        setConnected(false);
      }
    });

    stompClient.activate();
    setClient(stompClient);

    return () => {
      stompClient.deactivate();
    };
  }, [userId, accessToken]);

  return { client, connected };
}
```

## Configuration

### CORS for WebSocket

WebSocket endpoints are configured to allow:
- `http://localhost:*` (development)
- `https://*.scrapalot.app` (production)

Update `WebSocketConfig.kt` to modify allowed origins.

### Message Size Limits

Configure in `application.yaml`:

```yaml
websocket:
  message-size-limit: 65536          # 64KB
  send-buffer-size-limit: 524288     # 512KB
  send-time-limit: 20000             # 20 seconds
```

## Testing

### Using wscat (CLI tool)

```bash
npm install -g wscat
wscat -c ws://localhost:8091/stomp-direct/ws
```

### Browser Console

```javascript
const socket = new SockJS('http://localhost:8091/stomp-direct/ws');
const stompClient = Stomp.over(socket);

stompClient.connect(
  { Authorization: 'Bearer YOUR_TOKEN' },
  (frame) => {
    console.log('Connected:', frame);

    stompClient.subscribe('/user/queue/notifications', (message) => {
      console.log('Notification:', JSON.parse(message.body));
    });
  },
  (error) => {
    console.error('Error:', error);
  }
);
```

## Best Practices

1. **Authentication**: Always include JWT token in connection headers
2. **Reconnection**: Implement automatic reconnection with exponential backoff
3. **Heartbeat**: Configure STOMP heartbeat to detect connection issues
4. **Subscription Cleanup**: Unsubscribe when components unmount
5. **Error Handling**: Handle connection errors gracefully
6. **Message Validation**: Validate message format on client side
7. **Rate Limiting**: Implement client-side rate limiting for sending messages

## Troubleshooting

**Connection Refused**:
- Check if server is running on port 8091
- Verify CORS configuration
- Ensure JWT token is valid

**Messages Not Received**:
- Verify subscription destination matches server endpoints
- Check message broker configuration
- Review server logs for errors

**Reconnection Issues**:
- Implement exponential backoff
- Check heartbeat configuration
- Monitor network connectivity

## Production Considerations

1. **Load Balancing**: Use sticky sessions or Redis for multi-instance deployments
2. **Message Broker**: Consider external message broker (RabbitMQ, Redis) for scaling
3. **Monitoring**: Track WebSocket connections and message throughput
4. **Security**: Implement rate limiting and message size validation
5. **Heartbeat**: Configure appropriate heartbeat intervals
