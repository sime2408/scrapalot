"""
WebSocket manager for real-time updates and communication.
"""

# noinspection PyUnresolvedReferences
import asyncio
import enum
import json
import time
from typing import Any
import uuid

from src.main.utils.core.logger import get_logger, timing_decorator

logger = get_logger(__name__)

# Y.js collaboration limits and thresholds
MAX_YJS_STATE_WARNING = 5 * 1024 * 1024  # 5MB - warn and attempt compaction
MAX_YJS_STATE_CRITICAL = 10 * 1024 * 1024  # 10MB - disable Y.js, fallback to HTTP
MAX_CONCURRENT_COLLABORATIONS = 100  # Max simultaneous collaborative sessions
IDLE_DOCUMENT_TIMEOUT = 30 * 60  # 30 minutes - auto-cleanup idle documents


# --- y-protocols VarUint encoding/decoding (matches lib0 wire format) ---


def _read_var_uint(data: bytes, offset: int = 0) -> tuple:
    """Read a variable-length unsigned integer from bytes. Returns (value, bytes_consumed)."""
    result = 0
    shift = 0
    pos = offset
    while pos < len(data):
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if (byte & 0x80) == 0:
            return result, pos - offset
        shift += 7
    raise ValueError("Unexpected end of VarUint")


def _write_var_uint(value: int) -> bytes:
    """Write a variable-length unsigned integer to bytes."""
    result = bytearray()
    while value > 0x7F:
        result.append(0x80 | (value & 0x7F))
        value >>= 7
    result.append(value & 0x7F)
    return bytes(result)


def _read_var_uint8_array(data: bytes, offset: int = 0) -> tuple:
    """Read a VarUint-length-prefixed byte array. Returns (payload_bytes, total_bytes_consumed)."""
    length, consumed = _read_var_uint(data, offset)
    start = offset + consumed
    end = start + length
    if end > len(data):
        raise ValueError(f"VarUint8Array: expected {length} bytes but only {len(data) - start} available")
    return data[start:end], consumed + length


def _write_var_uint8_array(data: bytes) -> bytes:
    """Write a VarUint-length-prefixed byte array."""
    return _write_var_uint(len(data)) + data


# Handle missing socketio package gracefully
try:
    import socketio

    SOCKETIO_AVAILABLE = True
except ImportError:
    socketio = None
    SOCKETIO_AVAILABLE = False
    logger.error("python-socketio package not found. Please install it with 'pip install python-socketio'")

# Try importing fastapi WebSocket support
try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect

    FASTAPI_WEBSOCKET_AVAILABLE = True
except ImportError:
    FastAPI = None
    WebSocket = None
    WebSocketDisconnect = None
    FASTAPI_WEBSOCKET_AVAILABLE = False
    logger.error("FastAPI package not found or doesn't support WebSockets. Please install it with 'pip install fastapi'")

# Type hints for WebSocket (for workers without fastapi)
# Already imported above in try/except block


async def _send_stomp_frame(
    websocket: "WebSocket",
    headers: dict[str, str],
    body: str = "",
    command: str = "MESSAGE",
):
    """Send a STOMP frame."""
    # Build frame
    frame = [command]

    # Add headers
    for key, value in headers.items():
        frame.append(f"{key}:{value}")

    # Add a blank line separator
    frame.append("")

    # Add body and null terminator
    frame.append(f"{body}\0")

    # Send frame
    try:
        await websocket.send_text("\n".join(frame))
    except Exception as e:
        logger.error("Error sending STOMP frame: %s", str(e))


class WebSocketManager:
    """
    Manages WebSocket connections for real-time document processing updates.
    Singleton class to ensure only one WebSocket server is running.
    """

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialize()
        return cls._instance

    # NOTE: do NOT define __init__ here. Python calls __init__ on EVERY
    # WebSocketManager() construction, AFTER __new__ has already run
    # _initialize() (which builds self.stomp_app). An __init__ that reset
    # self.stomp_app = None silently clobbered the FastAPI sub-app on every
    # instantiation, so the "/stomp" mount was skipped and /stomp/ws returned
    # 403 at handshake. State is owned entirely by _initialize().

    @timing_decorator("WebSocketManager Initialization")
    def _initialize(self):
        """Initialize the Socket.IO server and connection tracking."""
        logger.info("Initializing WebSocketManager with Socket.IO")

        # Set up Socket.IO server
        self._initialize_socketio()

        # Set up STOMP WebSocket api_base using FastAPI
        self._initialize_stomp()

        # Track client connections by job_id
        self.job_clients: dict[str, set[str]] = {}

        # Throttling state for job updates
        self.last_update_time: dict[str, float] = {}  # Track last update time per job
        self.update_throttle_ms = 100  # Minimum time between updates (milliseconds)
        self.pending_updates: dict[str, dict[str, Any]] = {}  # Store pending updates
        self.scheduled_updates: dict[str, asyncio.Task] = {}  # Track scheduled update tasks

        logger.info("WebSocketManager initialized successfully")

    def _initialize_socketio(self):
        """Initialize Socket.IO server and event handlers."""
        if not SOCKETIO_AVAILABLE:
            logger.error("Cannot initialize Socket.IO server-python-socketio not installed")
            self.sio = None
            self.app = None
            return

        # Configure Socket.IO server with proper CORS settings
        # Allow all origins in development, specific domains in production
        import os

        environment = os.environ.get("ENVIRONMENT", "dev")

        if environment == "prod":
            # Production: restrict to specific domains + cloud development origins
            cors_allowed_origins = [
                "https://scrapalot.app",
                "https://www.scrapalot.app",
                "http://localhost:3000",  # Local UI development
                "http://127.0.0.1:3000",  # Alternative local UI
                "http://0.0.0.0:3000",  # Docker UI
            ]
        else:
            # Development: allow all origins for flexibility with dynamic ports
            cors_allowed_origins = "*"

        # noinspection PyUnresolvedReferences
        self.sio = socketio.AsyncServer(
            async_mode="asgi",
            cors_allowed_origins=cors_allowed_origins,
            logger=True,  # Enable Socket.IO's built-in logging
            engineio_logger=True,  # Enable Engine.IO logging for debugging
            ping_timeout=60,  # Increase timeouts for better connection stability
            ping_interval=25,
            # Authentication is completely disabled
            # No auth config needed as we handle everything manually
            allow_upgrades=True,  # Allow WebSocket protocol upgrades
            http_compression=True,
            max_http_buffer_size=10000000,  # 10MB buffer size
            async_handlers=True,
        )

        # Fallback ASGI app that properly rejects non-Socket.IO requests,
        # including WebSocket connections (Engine.IO's not_found sends HTTP
        # response on WebSocket scope which causes RuntimeError)
        async def _ws_fallback(scope, _receive, send):
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 4004})
            else:
                await send({"type": "http.response.start", "status": 404, "headers": []})
                await send({"type": "http.response.body", "body": b""})

        # Create an ASGI app with proper path handling.
        # socketio_path MUST include the "/ws" mount prefix: Starlette (>=0.35)
        # no longer strips the mount path from scope["path"] — a request to
        # "/ws/socket.io/" reaches this sub-app with the FULL path plus
        # root_path="/ws". Engine.IO matches scope["path"].startswith(socketio_path),
        # so a bare "/socket.io/" never matched and every handshake fell through
        # to _ws_fallback (HTTP 404 / WebSocket 403). The frontend connects to
        # path "/ws/socket.io/" (api-documents.ts), so this stays in sync.
        # noinspection PyUnresolvedReferences
        self.app = socketio.ASGIApp(
            self.sio,
            socketio_path="/ws/socket.io/",
            other_asgi_app=_ws_fallback,  # Properly reject non-matching requests
            static_files=None,
        )

        # Set up event handlers
        self._setup_socketio_event_handlers()

    def _initialize_stomp(self):
        """Initialize STOMP over WebSocket support."""
        if not FASTAPI_WEBSOCKET_AVAILABLE:
            logger.error("Cannot initialize STOMP WebSocket support-FastAPI WebSocket not available")
            self.stomp_app = None
            self.stomp_connections = {}
            self.stomp_subscriptions = {}
            self.stomp_users = {}
            return

        # Track STOMP connections
        self.stomp_connections: dict[str, WebSocket] = {}

        # Track STOMP subscriptions: topic -> Set[client_id]
        self.stomp_subscriptions: dict[str, set[str]] = {}

        # Track the authenticated user per STOMP client (client_id -> user_id),
        # set at CONNECT-time token validation. Used to reject cross-user topic
        # subscriptions (a client may only subscribe to its OWN /topic/user.<id>.*).
        self.stomp_users: dict[str, str] = {}

        # Track note collaboration connections: note_id -> {clients: Set[client_id], ydoc: YDoc}
        self.note_collaborators: dict[str, dict[str, Any]] = {}

        # Track note collaboration WebSocket connections: client_id -> WebSocket
        self.collaboration_connections: dict[str, WebSocket] = {}

        # Create FastAPI app for STOMP WebSocket api_base
        self.stomp_app = FastAPI()

        # NOTE: Do NOT add CORS middleware to STOMP app
        # CORS doesn't apply to WebSocket connections and can interfere with the upgrade handshake
        # The parent app's CORS middleware is sufficient for regular HTTP endpoints
        # WebSocket authentication is handled in the WebSocket handler itself

        # Add STOMP WebSocket endpoint
        @self.stomp_app.websocket("/ws")
        async def stomp_websocket_endpoint(websocket: "WebSocket"):
            logger.info("🔌 STOMP WebSocket endpoint reached! Client attempting connection...")
            # Handle authentication and connection
            await self.handle_stomp_connection(websocket)

        # Add note collaboration WebSocket endpoint
        @self.stomp_app.websocket("/ws/notes/{note_id}")
        async def note_collaboration_endpoint(websocket: "WebSocket", note_id: str):
            # Handle note collaboration connection
            await self._handle_note_collaboration(websocket, note_id)

        logger.info("STOMP over WebSocket support initialized successfully")

    async def handle_stomp_connection(self, websocket: "WebSocket"):
        """Handle a STOMP WebSocket connection with authentication."""
        client_id = str(uuid.uuid4())

        # CRITICAL: Must accept WebSocket connection FIRST before we can validate auth or close it
        # WebSocket subprotocol negotiation
        subprotocol = None
        # noinspection PyUnresolvedReferences
        if "sec-websocket-protocol" in websocket.headers:
            # Client requested subprotocol - accept the first STOMP version they support
            # noinspection PyUnresolvedReferences
            requested_protocols = websocket.headers["sec-websocket-protocol"].split(",")
            requested_protocols = [p.strip() for p in requested_protocols]

            # Accept the first STOMP protocol version (v12.stomp, v11.stomp, or v10.stomp)
            for protocol in requested_protocols:
                if protocol in ["v12.stomp", "v11.stomp", "v10.stomp"]:
                    subprotocol = protocol
                    break

        # Accept connection first (required before any other operations)
        try:
            if subprotocol:
                logger.info("Accepting STOMP connection with subprotocol: %s", subprotocol)
                # noinspection PyUnresolvedReferences
                await websocket.accept(subprotocol=subprotocol)
            else:
                logger.info("Accepting STOMP connection without subprotocol")
                # noinspection PyUnresolvedReferences
                await websocket.accept()
        except Exception as accept_error:
            logger.error("Error accepting WebSocket connection: %s", str(accept_error))
            return

        # Authenticate from the ?token= query param — the only credential a
        # browser can attach to the WS handshake (STOMP connectHeaders arrive
        # later, in the CONNECT frame). The gateway lets WS paths through
        # unauthenticated and prod nginx may bypass it entirely, so THIS is the
        # enforcement point. validate_token returns None for a missing / expired /
        # malformed token (it never raises). Reject anything that doesn't resolve
        # to a user, so a stranger can't open a socket and subscribe to another
        # user's /topic/user.<id>.* notifications.
        from src.main.utils.auth.jwt import validate_token

        # noinspection PyUnresolvedReferences
        query_params = dict(websocket.query_params)
        token = query_params.get("token")
        user = validate_token(token) if token else None
        if not user:
            logger.warning(
                "STOMP client %s rejected (%s) — closing",
                client_id,
                "no token" if not token else "invalid/expired token",
            )
            try:
                # noinspection PyUnresolvedReferences
                await websocket.close(code=1008)  # 1008 = policy violation
            except Exception as close_err:
                logger.debug("Error closing unauthenticated STOMP socket: %s", close_err)
            return
        self.stomp_users[client_id] = user.id
        logger.info("STOMP client %s authenticated as user %s", client_id, user.id)

        try:
            self.stomp_connections[client_id] = websocket
            logger.info(
                "🟢 STOMP client %s WebSocket connected (total connections: %d), waiting for CONNECT frame",
                client_id,
                len(self.stomp_connections),
            )

            # Background task for server heartbeats
            async def send_heartbeats():
                # Send heartbeats until the connection closes
                try:
                    while True:
                        await asyncio.sleep(4)  # Send heartbeat every 4 seconds
                        # noinspection PyUnresolvedReferences
                        await websocket.send_text("\n")
                        logger.debug("Sent server heartbeat to STOMP client %s", client_id)
                except (ConnectionError, WebSocketDisconnect):
                    # Connection closed - exit heartbeat loop
                    logger.debug("Heartbeat loop ended for STOMP client %s", client_id)

            heartbeat_task = asyncio.create_task(send_heartbeats())

            try:
                # Handle incoming STOMP frames
                while True:
                    try:
                        # noinspection PyUnresolvedReferences
                        data = await websocket.receive_text()

                        # Handle heartbeat (just newline)
                        if data.strip() == "":
                            logger.debug("Received client heartbeat from %s", client_id)
                            continue

                        await self._process_stomp_frame(client_id, websocket, data)
                    except WebSocketDisconnect as e:
                        logger.info(
                            "STOMP client %s disconnected normally (code: %s)",
                            client_id,
                            e.code,
                        )
                        break
                    except Exception as e:
                        logger.error(
                            "Error processing STOMP frame from %s: %s",
                            client_id,
                            str(e),
                        )
                        break
            finally:
                heartbeat_task.cancel()

        except WebSocketDisconnect as e:
            logger.info("STOMP client %s WebSocket disconnected (code: %s)", client_id, e.code)
        except Exception as e:
            logger.error("Error in STOMP connection %s: %s", client_id, str(e))
        finally:
            # Clean up connection
            if client_id in self.stomp_connections:
                del self.stomp_connections[client_id]
            self.stomp_users.pop(client_id, None)

            # Remove from all subscriptions
            logger.info("🧹 Cleaning up subscriptions for disconnecting client %s", client_id)
            removed_from = []
            for topic, subscribers in self.stomp_subscriptions.items():
                if client_id in subscribers:
                    removed_from.append(topic)
                subscribers.discard(client_id)

            if removed_from:
                logger.info("🧹 Removed client %s from subscriptions: %s", client_id, removed_from)

            logger.info("STOMP client %s disconnected", client_id)

    async def _process_stomp_frame(self, client_id: str, websocket: "WebSocket", frame_data: str):
        """Process an incoming STOMP frame."""
        try:
            lines = frame_data.strip().split("\n")
            if not lines:
                logger.debug("🔍 Client %s sent empty STOMP frame", client_id)
                return

            command = lines[0]
            headers = {}
            body = ""

            # Parse headers
            i = 1
            while i < len(lines) and lines[i]:
                if ":" in lines[i]:
                    key, value = lines[i].split(":", 1)
                    headers[key] = value
                i += 1

            # Parse body (after empty line)
            if i < len(lines):
                body = "\n".join(lines[i + 1 :])
                # Remove null terminator
                if body.endswith("\0"):
                    body = body[:-1]

            # DEBUG: Log every STOMP command received
            logger.debug("🔍 STOMP Frame from %s: command=%s, headers=%s", client_id, command, headers)

            # Handle different STOMP commands
            if command == "CONNECT" or command == "STOMP":
                # Client sent CONNECT frame, now send CONNECTED response
                logger.info(
                    "STOMP client %s sent %s frame, sending CONNECTED",
                    client_id,
                    command,
                )
                # noinspection PyTypeChecker
                await _send_stomp_frame(
                    websocket,
                    {
                        "version": "1.2",
                        "session": client_id,
                        "server": "scrapalot-chat/1.0",
                        "heart-beat": "4000,4000",
                    },
                    "",
                    "CONNECTED",
                )
            elif command == "SUBSCRIBE":
                destination = headers.get("destination", "")
                if destination:
                    # Own-topic guard: a client may only subscribe to its OWN
                    # user topics. /topic/user.<uid>.* must match the
                    # CONNECT-authenticated user; otherwise a client could read
                    # another user's job/workspace notifications. Non-user topics
                    # (job.*, broadcast) are unrestricted.
                    if destination.startswith("/topic/user."):
                        owner = destination[len("/topic/user.") :].split(".", 1)[0]
                        auth_user = self.stomp_users.get(client_id)
                        if owner != auth_user:
                            logger.warning(
                                "STOMP client %s (user %s) denied subscription to %s — not its own topic",
                                client_id,
                                auth_user,
                                destination,
                            )
                            return
                    if destination not in self.stomp_subscriptions:
                        self.stomp_subscriptions[destination] = set()
                    self.stomp_subscriptions[destination].add(client_id)
                    logger.debug(
                        "STOMP client %s subscribed to %s (total subscribers: %d)",
                        client_id,
                        destination,
                        len(self.stomp_subscriptions[destination]),
                    )
                    logger.debug("All subscriptions: %s", {dest: len(subs) for dest, subs in self.stomp_subscriptions.items()})
                else:
                    logger.warning("⚠️ SUBSCRIBE command without destination from client %s", client_id)
            elif command == "UNSUBSCRIBE":
                destination = headers.get("destination", "")
                if destination in self.stomp_subscriptions:
                    if client_id in self.stomp_subscriptions[destination]:
                        self.stomp_subscriptions[destination].discard(client_id)
                        logger.debug(
                            "STOMP client %s unsubscribed from %s (remaining: %d)",
                            client_id,
                            destination,
                            len(self.stomp_subscriptions[destination]),
                        )
                    else:
                        # Client wasn't subscribed, silently ignore (can happen during cleanup)
                        logger.debug("Client %s tried to unsubscribe from %s but was not subscribed", client_id, destination)
                else:
                    # Destination doesn't exist, silently ignore (can happen during cleanup)
                    logger.debug("Client %s tried to unsubscribe from non-existent destination %s", client_id, destination)
            elif command == "SEND":
                destination = headers.get("destination", "")
                logger.info(
                    "STOMP client %s sent message to %s: %s",
                    client_id,
                    destination,
                    body,
                )
            elif command == "DISCONNECT":
                if client_id in self.stomp_connections:
                    await self.stomp_connections[client_id].close()

        except Exception as e:
            logger.error("Error processing STOMP frame from %s: %s", client_id, str(e))

    async def _send_stomp_message(self, destination: str, message: dict[str, Any]):
        """Send a message to all subscribers of a STOMP destination."""
        logger.info("📤 Attempting to send STOMP message to destination %s", destination)
        logger.debug("📤 Message content: %s", message)

        # Log current subscription state
        logger.info("🔍 Current subscription state: %s", {dest: len(subs) for dest, subs in self.stomp_subscriptions.items()})
        logger.info("🔍 Active STOMP connections: %d", len(self.stomp_connections))

        # BUG FIX: Downgrade to DEBUG - this is expected behavior when no subscribers are connected
        # (e.g., user navigated away, background task completed, job finished before frontend subscribed)
        if destination not in self.stomp_subscriptions:
            logger.debug(
                "No subscribers for destination %s. Available destinations: %s",
                destination,
                list(self.stomp_subscriptions.keys()),
            )
            return

        # Convert a message to JSON
        try:
            # Custom JSON encoder to handle UUID objects and Enums
            def json_serializer(obj):
                if isinstance(obj, uuid.UUID):
                    return str(obj)
                if isinstance(obj, enum.Enum):
                    return obj.value
                raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")

            message_body = json.dumps(message, default=json_serializer)
        except Exception as e:
            logger.error("Error converting message to JSON: %s", str(e))
            return

        # Send it to all subscribers
        subscriber_count = len(self.stomp_subscriptions[destination])
        logger.info("Sending STOMP message to %d subscribers for destination %s", subscriber_count, destination)

        for client_id in self.stomp_subscriptions[destination]:
            if client_id in self.stomp_connections:
                websocket = self.stomp_connections[client_id]
                try:
                    await _send_stomp_frame(
                        websocket,
                        {
                            "destination": destination,
                            "content-type": "application/json",
                            "subscription": destination,
                            "message-id": f"{destination}-{time.time()}",
                        },
                        message_body,
                    )
                    logger.debug("Successfully sent STOMP message to client %s", client_id)
                except Exception as e:
                    logger.error(
                        "Error sending STOMP message to client %s: %s",
                        client_id,
                        str(e),
                    )

    def _setup_socketio_event_handlers(self):
        """Set up Socket.IO event handlers."""
        if not self.sio:
            return

        @self.sio.event
        async def connect(sid, _environ, _auth):
            """Handle client connection."""
            logger.info("Socket.IO client connected: %s", sid)
            # Authentication is handled by FastAPI middleware, so we just accept the connection
            return True

        @self.sio.event
        async def disconnect(sid):
            """Handle client disconnection."""
            logger.info("Socket.IO client disconnected: %s", sid)
            # Clean up any job subscriptions for this client
            for job_id, clients in list(self.job_clients.items()):
                if sid in clients:
                    clients.discard(sid)
                    logger.debug("Removed client %s from job %s", sid, job_id)
                    if not clients:
                        # Remove empty job client sets
                        del self.job_clients[job_id]

        @self.sio.event
        async def subscribe(sid, data):
            """Handle job subscription."""
            try:
                job_id = data.get("job_id")
                if not job_id:
                    logger.warning("Client %s sent subscribe without job_id", sid)
                    return {"success": False, "error": "job_id required"}

                # Add client to job subscribers
                if job_id not in self.job_clients:
                    self.job_clients[job_id] = set()
                self.job_clients[job_id].add(sid)

                logger.info("Client %s subscribed to job %s", sid, job_id)
                return {"success": True, "job_id": job_id}
            except Exception as e:
                logger.error("Error in subscribe handler: %s", e)
                return {"success": False, "error": str(e)}

        @self.sio.event
        async def unsubscribe(sid, data):
            """Handle job unsubscription."""
            try:
                job_id = data.get("job_id")
                if not job_id:
                    return {"success": False, "error": "job_id required"}

                # Remove client from job subscribers
                if job_id in self.job_clients:
                    self.job_clients[job_id].discard(sid)
                    if not self.job_clients[job_id]:
                        del self.job_clients[job_id]

                logger.info("Client %s unsubscribed from job %s", sid, job_id)
                return {"success": True, "job_id": job_id}
            except Exception as e:
                logger.error("Error in unsubscribe handler: %s", e)
                return {"success": False, "error": str(e)}

        @self.sio.event
        async def echo(sid, data):
            """Echo test endpoint for connection verification."""
            logger.debug("Echo from client %s: %s", sid, data)
            return {"server_processed": True, "echo": data}

    def get_app(self):
        """Returns the ASGI application for the WebSocket server."""
        # If Socket.IO is available, return the Socket.IO app
        if self.sio and self.app:
            return self.app

        # If STOMP over WebSocket is available, return STOMP app
        if FASTAPI_WEBSOCKET_AVAILABLE and self.stomp_app:
            return self.stomp_app

        # Fallback to minimal app

        async def minimal_app(send):
            await send(
                {
                    "type": "http.response.start",
                    "status": 500,
                    "headers": [
                        [b"content-type", b"text/plain"],
                    ],
                }
            )
            await send(
                {
                    "type": "http.response.body",
                    "body": b"WebSocket server not available - missing dependencies",
                }
            )

        return minimal_app

    async def _send_update(self, job_id: str, data: dict[str, Any]):
        """Send an update to all clients subscribed to a job."""
        # Send to Socket.IO clients
        if self.sio:
            for sid in self.job_clients.get(job_id, set()):
                try:
                    await self.sio.emit("job_update", data, room=sid)
                except Exception as e:
                    logger.error("Error sending Socket.IO update to client %s: %s", sid, str(e))

        # Send it to STOMP clients
        if FASTAPI_WEBSOCKET_AVAILABLE:
            # Send to job-specific topic (for job-specific subscriptions)
            topic = f"/topic/job.{job_id}"
            await self._send_stomp_message(topic, data)

            # ALSO send to user-wide topic if user_id is available
            user_id = data.get("user_id")
            if user_id:
                user_topic = f"/topic/user.{user_id}.jobs"
                logger.debug("📤 Sending job update to user topic: %s", user_topic)
                await self._send_stomp_message(user_topic, data)
            else:
                logger.warning("No user_id in job data for job %s, cannot send to user topic", job_id)

    async def _schedule_update(self, job_id: str, delay_ms: int):
        """Schedule an update to be sent after a delay."""
        try:
            # Wait for a specified delay
            await asyncio.sleep(delay_ms / 1000.0)

            # Send the pending update
            if job_id in self.pending_updates:
                data = self.pending_updates.pop(job_id)
                await self._send_update(job_id, data)

            # Clear the scheduled task
            if job_id in self.scheduled_updates:
                del self.scheduled_updates[job_id]
        except asyncio.CancelledError:
            logger.debug("Scheduled update for job %s was cancelled", job_id)
        except Exception as e:
            logger.error("Error in scheduled update for job %s: %s", job_id, str(e))

    async def send_job_update(self, job_id: str, data: dict[str, Any]):
        """
        Send a job update to all subscribed clients with throttling.
        Only sends the most recent update within the throttle window.
        Completion updates are never throttled.
        """
        logger.info(
            "📤 WebSocket: Received job update for %s - progress: %s%%, status: %s, message: %s",
            job_id,
            data.get("progress", "N/A"),
            data.get("status", "N/A"),
            data.get("message", "N/A"),
        )

        # Store this update as the most recent
        self.pending_updates[job_id] = data

        # Check if this is a completion update (never throttle these)
        is_completion = (
            data.get("progress", 0) >= 100
            or data.get("status") in ["completed", "failed", "cancelled", "COMPLETED", "FAILED", "CANCELLED"]
            or str(data.get("status", "")).lower() in ["completed", "failed", "cancelled"]
        )

        if is_completion:
            # Send completion updates immediately, regardless of throttling
            logger.info(
                "🎯 Sending completion update immediately for job %s: %s at %s%%",
                job_id,
                data.get("status"),
                data.get("progress"),
            )
            await self._send_update(job_id, data)

            # Remove from pending and cancel any scheduled updates
            if job_id in self.pending_updates:
                del self.pending_updates[job_id]
            if job_id in self.scheduled_updates:
                self.scheduled_updates[job_id].cancel()
                del self.scheduled_updates[job_id]

            # Update timestamp to prevent immediate follow-up updates
            self.last_update_time[job_id] = time.time() * 1000
            return

        # For non-completion updates, apply normal throttling
        now = time.time() * 1000  # milliseconds
        last_update = self.last_update_time.get(job_id, 0)
        time_since_last = now - last_update

        # Check if we should send immediately or schedule
        if time_since_last >= self.update_throttle_ms:
            # Send it immediately
            self.last_update_time[job_id] = now
            await self._send_update(job_id, data)

            # Remove from pending
            if job_id in self.pending_updates:
                del self.pending_updates[job_id]

            # Cancel any scheduled updates
            if job_id in self.scheduled_updates:
                self.scheduled_updates[job_id].cancel()
                del self.scheduled_updates[job_id]

        elif job_id not in self.scheduled_updates:
            # Schedule update for later
            delay = self.update_throttle_ms - time_since_last
            task = asyncio.create_task(self._schedule_update(job_id, int(delay)))

            # Store task for potential cancellation
            self.scheduled_updates[job_id] = task

            # Set up completion handling

            def on_task_done(t):
                try:
                    # Re-raise an exception if a task failed
                    exception = t.exception()
                    if exception:
                        logger.error("Scheduled update task failed: %s", str(exception))
                except asyncio.CancelledError:
                    logger.debug("Scheduled update task %s was cancelled", job_id)
                except Exception as e:
                    logger.error("Error handling task completion: %s", str(e))

            # Add completion callback
            task.add_done_callback(on_task_done)

    # Else: an update is already scheduled, and we've stored the latest data
    # That scheduled update will send the most recent data from pending_updates

    async def send_to_all(self, data):
        """Send a message to all connected clients."""
        # Send to Socket.IO clients
        if self.sio:
            await self.sio.emit("broadcast", data)

        # Send it to STOMP clients
        if FASTAPI_WEBSOCKET_AVAILABLE:
            await self._send_stomp_message("/topic/broadcast", data)

    async def send_workspace_notification(self, user_id: str, event_type: str, workspace_data: dict):
        """Send a workspace-related notification to a specific user."""
        message = {
            "type": "workspace_notification",
            "event_type": event_type,  # 'shared', 'unshared', 'updated', 'deleted'
            "workspace": workspace_data,
            "timestamp": time.time(),
        }

        # Send to Socket.IO clients
        if self.sio:
            await self.sio.emit("workspace_notification", message, room=f"user_{user_id}")

        # Send to STOMP clients subscribed to user-specific workspace topic
        if FASTAPI_WEBSOCKET_AVAILABLE:
            topic = f"/topic/user.{user_id}.workspaces"
            await self._send_stomp_message(topic, message)

    async def send_user_job_notification(self, user_id: str, event_type: str, job_data: dict):
        """
        Send a job lifecycle notification to a specific user.

        This eliminates the need for constant HTTP polling by notifying the frontend
        when jobs start, complete, fail, or are cancelled.

        Args:
            user_id: ID of the user to notify
            event_type: Type of job event ('job_started', 'job_completed', 'job_failed', 'job_cancelled')
            job_data: Job information (job_id, document_id, filename, status, etc.)
        """
        message = {
            "type": "job_notification",
            "event_type": event_type,  # 'job_started', 'job_completed', 'job_failed', 'job_cancelled'
            "job": job_data,
            "timestamp": time.time(),
        }

        logger.info(
            "📢 Sending job notification to user %s: %s (job_id: %s)",
            user_id,
            event_type,
            job_data.get("job_id", "unknown"),
        )

        # Send to Socket.IO clients
        if self.sio:
            await self.sio.emit("job_notification", message, room=f"user_{user_id}")

        # Send to STOMP clients subscribed to user-specific jobs topic
        if FASTAPI_WEBSOCKET_AVAILABLE:
            topic = f"/topic/user.{user_id}.jobs"
            await self._send_stomp_message(topic, message)

    async def _handle_note_collaboration(self, websocket: "WebSocket", note_id: str):
        """Handle a y-websocket protocol connection for collaborative editing with Yjs."""
        logger.info("🔵 _handle_note_collaboration CALLED for note_id: %s", note_id)
        client_id = str(uuid.uuid4())
        logger.info("Generated client_id: %s", client_id)

        # CRITICAL: Accept WebSocket connection FIRST before any validation or error handling
        # WebSocket must be accepted before sending close frames or error responses
        try:
            logger.info("🔵 Accepting WebSocket connection for note_id: %s", note_id)
            # noinspection PyUnresolvedReferences
            await websocket.accept()
            logger.info("WebSocket connection accepted for note_id: %s", note_id)
        except Exception as accept_error:
            logger.error("Failed to accept note collaboration WebSocket: %s", str(accept_error))
            return

        # Import jwt module
        try:
            import jwt

            from src.main.utils.auth.jwt import ALGORITHM, SECRET_KEY
        except ImportError as import_error:
            logger.error("Failed to import jwt module: %s", str(import_error))
            # noinspection PyUnresolvedReferences
            await websocket.close(code=1011, reason="Server configuration error")
            return

        # Authenticate the connection (after accepting)
        try:
            # noinspection PyUnresolvedReferences
            query_params = dict(websocket.query_params)
            token = query_params.get("token")

            if not token:
                # noinspection PyUnresolvedReferences
                auth_header = websocket.headers.get("authorization", "")
                if auth_header.startswith("Bearer "):
                    token = auth_header[7:]

            if token:
                try:
                    payload = jwt.decode(
                        token,
                        key=SECRET_KEY,
                        algorithms=[ALGORITHM],
                        options={"verify_aud": False, "verify_exp": True},
                    )
                    user_id = payload.get("sub")
                    if not user_id:
                        logger.warning("Invalid token for note collaboration - no user ID")
                        # noinspection PyUnresolvedReferences
                        await websocket.close(code=1008, reason="Invalid authentication token")
                        return
                    logger.info(
                        "Note collaboration client %s authenticated as user %s for note %s",
                        client_id,
                        user_id,
                        note_id,
                    )
                except jwt.ExpiredSignatureError:
                    logger.warning("Expired token for note collaboration")
                    # noinspection PyUnresolvedReferences
                    await websocket.close(code=1008, reason="Token expired")
                    return
                except Exception as auth_error:
                    logger.error(
                        "Authentication error for note collaboration: %s",
                        str(auth_error),
                    )
                    # noinspection PyUnresolvedReferences
                    await websocket.close(code=1008, reason="Authentication failed")
                    return
            else:
                logger.warning("No authentication token provided for note collaboration")
                # noinspection PyUnresolvedReferences
                await websocket.close(code=1008, reason="Authentication required")
                return
        except Exception as e:
            logger.error("Error during note collaboration authentication: %s", str(e))
            # noinspection PyUnresolvedReferences
            await websocket.close(code=1011, reason="Authentication error")
            return

        try:
            # Import y-py for Yjs CRDT support
            try:
                # noinspection PyPep8Naming
                import y_py as Y
            except ImportError:
                # noinspection PyPep8Naming
                Y = None
                logger.error("y-py library not installed. Install with: pip install y-py")
                # noinspection PyUnresolvedReferences
                await websocket.close(code=1011, reason="Server configuration error")
                return

            # Get or create Yjs document for this note
            if note_id not in self.note_collaborators:
                # Check if we're at the concurrent collaboration limit
                current_sessions = len(self.note_collaborators)
                if current_sessions >= MAX_CONCURRENT_COLLABORATIONS:
                    logger.warning(
                        "⚠️ Maximum concurrent collaborative sessions reached (%d/%d). Note %s will use read-only mode or HTTP polling fallback.",
                        current_sessions,
                        MAX_CONCURRENT_COLLABORATIONS,
                        note_id,
                    )
                    # Still allow connection but log warning
                    # TODO: Implement HTTP polling fallback for this case

                logger.info(
                    "🆕 Creating NEW Y.js document for note %s (session %d/%d)",
                    note_id,
                    current_sessions + 1,
                    MAX_CONCURRENT_COLLABORATIONS,
                )
                # Create a new Y.js document
                ydoc = Y.YDoc()

                # Track whether this Y.js document has actual content (restored from DB)
                # or is empty (needs to be populated by client)
                has_yjs_state = False

                # CRITICAL: Restore Y.js state from database if available
                # This ensures collaborative editing state persists across server restarts
                try:
                    from uuid import UUID

                    from src.main.config.database import get_sqlmodel_db_session
                    from src.main.models.python_only_models import YjsCollaborationState

                    # Load Y.js collaboration state from database
                    db = get_sqlmodel_db_session()
                    try:
                        # noinspection PyTypeChecker
                        yjs_record = (
                            db.query(YjsCollaborationState)
                            # noinspection PyTypeChecker
                            .filter(YjsCollaborationState.note_id == UUID(note_id))
                            .first()
                        )
                        if yjs_record and yjs_record.yjs_state:
                            state_size = len(yjs_record.yjs_state)

                            # Check if state is suspiciously small (corrupted/empty)
                            # Y.js documents with actual content are always > 4 bytes
                            if state_size <= 4:
                                logger.warning(
                                    "Y.js state in database is too small (%d bytes) - likely corrupted/empty. "
                                    "Clearing corrupted state from DB. Client will populate from HTML content.",
                                    state_size,
                                )
                                has_yjs_state = False
                                # Clear the corrupted state from database
                                yjs_record.yjs_state = None
                                db.commit()
                                logger.info("Cleared corrupted Y.js state from database for note %s", note_id)
                            else:
                                # State size is reasonable - restore it
                                try:
                                    Y.apply_update(ydoc, bytes(yjs_record.yjs_state))
                                    has_yjs_state = True  # Successfully restored from database
                                    logger.info("Restored Y.js state from database for note %s: %d bytes", note_id, state_size)

                                    # Check size thresholds for warnings and compaction
                                    if state_size > MAX_YJS_STATE_CRITICAL:
                                        logger.error(
                                            "CRITICAL: Y.js state for note %s is %d MB (> %d MB limit). "
                                            "Real-time collaboration will be DISABLED for this note. "
                                            "Users will use HTTP polling fallback. Content is preserved.",
                                            note_id,
                                            state_size / (1024 * 1024),
                                            MAX_YJS_STATE_CRITICAL / (1024 * 1024),
                                        )
                                    elif state_size > MAX_YJS_STATE_WARNING:
                                        logger.warning(
                                            "Y.js state for note %s is %d MB (> %d MB warning threshold). "
                                            "Consider compacting this document. Performance may degrade.",
                                            note_id,
                                            state_size / (1024 * 1024),
                                            MAX_YJS_STATE_WARNING / (1024 * 1024),
                                        )
                                        # Try to compact the Y.js state to reduce size
                                        try:
                                            compacted_state = Y.encode_state_as_update(ydoc)
                                            if len(compacted_state) < state_size:
                                                logger.info(
                                                    "Compacted Y.js state for note %s: %d bytes -> %d bytes (saved %d%%)",
                                                    note_id,
                                                    state_size,
                                                    len(compacted_state),
                                                    int(100 * (state_size - len(compacted_state)) / state_size),
                                                )
                                        except Exception as compact_error:
                                            logger.warning(
                                                "Failed to compact Y.js state for note %s: %s",
                                                note_id,
                                                str(compact_error),
                                            )

                                except Exception as restore_error:
                                    logger.exception(
                                        "Failed to restore Y.js state for note %s: %s. Will serve empty Y.js document (content still in database).",
                                        note_id,
                                        str(restore_error),
                                    )
                        else:
                            # No Y.js state record found - create empty document
                            # Notes are created via Kotlin backend (scrapalot_backend DB),
                            # but Y.js WebSocket collaboration runs on Python backend.
                            has_yjs_state = False
                            logger.info(
                                "No Y.js state found for note %s. Creating empty Y.js document for collaboration.",
                                note_id,
                            )
                    finally:
                        db.close()
                except Exception as init_error:
                    # If initialization fails, continue with empty document
                    # The client will sync its content during connection
                    has_yjs_state = False  # Error during init, treat as empty
                    logger.warning("Failed to initialize Y.js document from database for note %s: %s", note_id, str(init_error))

                self.note_collaborators[note_id] = {
                    "clients": set(),
                    "ydoc": ydoc,
                    "has_yjs_state": has_yjs_state,
                }  # Track if backend has content
            else:
                logger.info("♻️ REUSING existing Y.js document for note %s (already in memory)", note_id)

            ydoc = self.note_collaborators[note_id]["ydoc"]
            self.note_collaborators[note_id]["clients"].add(client_id)
            self.collaboration_connections[client_id] = websocket

            logger.info(
                "Client %s joined Yjs collaboration for note %s (total clients: %d)",
                client_id,
                note_id,
                len(self.note_collaborators[note_id]["clients"]),
            )

            # Don't send initial SyncStep1 - wait for a client to initiate sync
            # The client will send SyncStep1 first, then we respond with SyncStep2
            # This avoids sending empty/malformed state vectors for new documents
            logger.debug("Waiting for client %s to initiate sync", client_id)

            # Handle incoming y-websocket protocol messages
            while True:
                try:
                    # Receive binary data (y-websocket uses binary protocol)
                    # noinspection PyUnresolvedReferences
                    data = await websocket.receive_bytes()

                    if len(data) < 1:
                        continue

                    message_type = data[0]

                    if message_type == 0:  # Sync message
                        if len(data) < 2:
                            continue

                        sync_message_type = data[1]
                        message_content = data[2:]

                        if sync_message_type == 0:  # SyncStep1 - client sends state vector
                            try:
                                # Decode the VarUint8Array-encoded state vector from the client
                                # y-protocols format: writeVarUint8Array(stateVector)
                                try:
                                    state_vector, _ = _read_var_uint8_array(message_content)
                                except (ValueError, IndexError):
                                    # Fallback: treat entire content as raw state vector
                                    state_vector = message_content

                                logger.info(
                                    "📥 Received SyncStep1 from client %s: state_vector=%d bytes, hex=%s",
                                    client_id,
                                    len(state_vector),
                                    (state_vector[:20].hex() if len(state_vector) >= 20 else state_vector.hex() if state_vector else "(empty)"),
                                )

                                # Generate update based on client's state vector
                                try:
                                    if len(state_vector) == 0:
                                        update = Y.encode_state_as_update(ydoc)
                                    else:
                                        update = Y.encode_state_as_update(ydoc, state_vector)
                                except Exception as encode_error:
                                    logger.warning(
                                        "Failed to encode state update for client %s: %s, sending full state",
                                        client_id,
                                        str(encode_error),
                                    )
                                    # noinspection PyBroadException
                                    try:
                                        update = Y.encode_state_as_update(ydoc)
                                    except Exception:
                                        # Last resort: skip this sync
                                        logger.error(
                                            "Cannot encode any state for client %s",
                                            client_id,
                                        )
                                        continue

                                    logger.debug(
                                        "Generated update for client %s: %d bytes from state vector of %d bytes",
                                        client_id,
                                        len(update),
                                        len(state_vector),
                                    )

                                # Always send SyncStep2 even if backend Y.js document is empty.
                                # An empty update tells the client "server has nothing" and completes
                                # the sync handshake, allowing the client to send its content via
                                # SyncStep2 or Update messages. Skipping this breaks the y-websocket
                                # protocol and causes an infinite resync loop until the connection drops.

                                # Validate update size before sending
                                # noinspection PyPep8Naming
                                MAX_UPDATE_SIZE = 10 * 1024 * 1024  # 10MB limit
                                if len(update) > MAX_UPDATE_SIZE:
                                    logger.warning(
                                        "Update size %d bytes exceeds %d byte limit for client %s, sending full state instead",
                                        len(update),
                                        MAX_UPDATE_SIZE,
                                        client_id,
                                    )
                                    # Try to send full state instead
                                    # noinspection PyBroadException
                                    try:
                                        update = Y.encode_state_as_update(ydoc)
                                        if len(update) > MAX_UPDATE_SIZE:
                                            # Even full state is too large - close connection
                                            logger.error(
                                                "Document too large (%d bytes) for client %s, closing connection",
                                                len(update),
                                                client_id,
                                            )
                                            # noinspection PyUnresolvedReferences
                                            await websocket.close(code=1009, reason="Document too large")
                                            return
                                    except Exception:
                                        logger.error("Cannot encode state for oversized document, closing connection")
                                        # noinspection PyUnresolvedReferences
                                        await websocket.close(code=1011, reason="Failed to encode document")
                                        return

                                # Validate update is not suspiciously small (likely corrupted)
                                if len(update) == 0:
                                    logger.debug("Empty update for client %s, skipping SyncStep2", client_id)
                                    # Don't send empty updates - they cause "Unexpected end of array" errors
                                    # The client will retry if needed
                                    continue

                                # NOTE: Compression disabled - would require protocol changes on both client and server
                                # WebSocket already provides compression via permessage-deflate extension
                                # Yjs binary protocol is already efficient

                                # Calculate checksum for integrity verification (first 8 chars of SHA256)
                                import hashlib

                                update_hash = hashlib.sha256(update).hexdigest()[:8]
                                logger.info(
                                    "📤 Sending SyncStep2 to client %s: update=%d bytes, hash=%s, first_bytes=%s",
                                    client_id,
                                    len(update),
                                    update_hash,
                                    update[:20].hex() if len(update) >= 20 else update.hex(),
                                )

                                # Validate update before sending
                                if not isinstance(update, bytes):
                                    logger.error("Invalid update type for client %s: %s", client_id, type(update))
                                    continue

                                # Send SyncStep2 with the update (VarUint8Array-encoded per y-protocols)
                                try:
                                    sync_step2 = bytes([0, 1]) + _write_var_uint8_array(update)
                                    # noinspection PyUnresolvedReferences
                                    await websocket.send_bytes(sync_step2)
                                    logger.debug(
                                        "✓ Successfully sent SyncStep2 to client %s with update length: %d (total: %d bytes)",
                                        client_id,
                                        len(update),
                                        len(sync_step2),
                                    )
                                except Exception as send_error:
                                    logger.error(
                                        "❌ Failed to send SyncStep2 to client %s: %s",
                                        client_id,
                                        str(send_error),
                                    )
                                    # Close connection to force client reconnect and resync
                                    # noinspection PyUnresolvedReferences
                                    await websocket.close(code=1011, reason="Failed to send sync update")
                                    return
                            except Exception as e:
                                logger.error(
                                    "Error in SyncStep1 handling for client %s: %s",
                                    client_id,
                                    str(e),
                                )
                                # Don't send malformed updates - just skip this sync step
                                continue

                        elif sync_message_type == 1:  # SyncStep2 - client sends update
                            try:
                                # Decode the VarUint8Array-encoded update from the client
                                if len(message_content) == 0:
                                    logger.debug("Client %s sent empty SyncStep2 update, skipping", client_id)
                                    continue

                                try:
                                    update_data, _ = _read_var_uint8_array(message_content)
                                except (ValueError, IndexError):
                                    update_data = message_content

                                if len(update_data) > 10 * 1024 * 1024:  # 10MB limit
                                    logger.warning(
                                        "Client %s sent oversized update (%d bytes), rejecting",
                                        client_id,
                                        len(update_data),
                                    )
                                    # noinspection PyUnresolvedReferences
                                    await websocket.close(code=1009, reason="Update too large")
                                    return

                                # Apply the update to the document
                                Y.apply_update(ydoc, update_data)

                                # Mark that backend now has Y.js state (populated by client)
                                if not self.note_collaborators[note_id].get("has_yjs_state", False):
                                    self.note_collaborators[note_id]["has_yjs_state"] = True
                                    logger.info(
                                        "Backend Y.js state populated by client %s for note %s (%d bytes)",
                                        client_id,
                                        note_id,
                                        len(update_data),
                                    )

                                # Broadcast to other clients (raw update bytes, broadcast wraps them)
                                await self.broadcast_yjs_update(note_id, update_data, exclude_client=client_id)
                                logger.debug("✓ Applied SyncStep2 update from client %s (%d bytes)", client_id, len(update_data))
                            except Exception as e:
                                logger.warning(
                                    "Error applying update from client %s: %s - may indicate corrupted data",
                                    client_id,
                                    str(e),
                                )
                                continue

                        elif sync_message_type == 2:  # Update - incremental changes
                            try:
                                # Decode the VarUint8Array-encoded update from the client
                                if len(message_content) == 0:
                                    logger.debug("Client %s sent empty incremental update, skipping", client_id)
                                    continue

                                try:
                                    update_data, _ = _read_var_uint8_array(message_content)
                                except (ValueError, IndexError):
                                    update_data = message_content

                                if len(update_data) > 10 * 1024 * 1024:  # 10MB limit
                                    logger.warning(
                                        "Client %s sent oversized incremental update (%d bytes), rejecting",
                                        client_id,
                                        len(update_data),
                                    )
                                    # noinspection PyUnresolvedReferences
                                    await websocket.close(code=1009, reason="Update too large")
                                    return

                                # Apply the update
                                Y.apply_update(ydoc, update_data)

                                # Mark that backend now has Y.js state (if this is first update)
                                if not self.note_collaborators[note_id].get("has_yjs_state", False):
                                    self.note_collaborators[note_id]["has_yjs_state"] = True
                                    logger.debug("Backend Y.js state populated by incremental update from client %s", client_id)

                                # Broadcast to other clients (raw update bytes, broadcast wraps them)
                                await self.broadcast_yjs_update(note_id, update_data, exclude_client=client_id)
                                logger.debug(
                                    "✓ Applied incremental update from client %s (%d bytes)",
                                    client_id,
                                    len(update_data),
                                )
                            except Exception as e:
                                logger.warning(
                                    "Error applying incremental update from client %s: %s - may indicate corrupted data",
                                    client_id,
                                    str(e),
                                )
                                continue

                    elif message_type == 1:  # Awareness message (cursor positions, user info)
                        # Broadcast awareness updates to other clients
                        await self.broadcast_awareness(note_id, data, exclude_client=client_id)

                except WebSocketDisconnect:
                    break
                except Exception as e:
                    logger.error("Error processing Yjs message from %s: %s", client_id, str(e))
                    break

        except Exception as e:
            logger.error("Error in Yjs collaboration connection %s: %s", client_id, str(e))
        finally:
            # Clean up connection
            if note_id in self.note_collaborators:
                self.note_collaborators[note_id]["clients"].discard(client_id)
                remaining_clients = len(self.note_collaborators[note_id]["clients"])

                if not self.note_collaborators[note_id]["clients"]:
                    # No more clients - save Y.js state to database before cleanup
                    try:
                        # noinspection PyPep8Naming
                        import y_py as Y

                        ydoc = self.note_collaborators[note_id]["ydoc"]
                        yjs_state = Y.encode_state_as_update(ydoc)

                        logger.info("💾 Saving Y.js state to database for note %s: %d bytes", note_id, len(yjs_state))

                        # Save to database (only if note_id is a valid UUID)
                        from uuid import UUID

                        from src.main.config.database import get_sqlmodel_db_session
                        from src.main.models.python_only_models import YjsCollaborationState

                        # Validate UUID format before database query
                        try:
                            note_uuid = UUID(note_id)
                        except ValueError:
                            logger.warning("Skipping Y.js state save for non-UUID note_id: %s", note_id)
                            note_uuid = None

                        if note_uuid:
                            db = get_sqlmodel_db_session()
                            try:
                                # noinspection PyTypeChecker
                                yjs_record = (
                                    db.query(YjsCollaborationState)
                                    # noinspection PyTypeChecker
                                    .filter(YjsCollaborationState.note_id == note_uuid)
                                    .first()
                                )
                                if yjs_record:
                                    yjs_record.yjs_state = yjs_state
                                else:
                                    # Create new record if it doesn't exist
                                    yjs_record = YjsCollaborationState(
                                        note_id=note_uuid,
                                        yjs_state=yjs_state,
                                    )
                                    db.add(yjs_record)
                                db.commit()
                                logger.info("Y.js state saved to database for note %s", note_id)
                            finally:
                                db.close()
                    except Exception as save_error:
                        logger.exception("Failed to save Y.js state for note %s: %s", note_id, str(save_error))

                    # Clean up the in-memory document
                    logger.info("🗑️ Removing Y.js document from memory for note %s (no more clients)", note_id)
                    del self.note_collaborators[note_id]
                else:
                    logger.info("Client %s left note %s (%d clients remaining)", client_id, note_id, remaining_clients)

            if client_id in self.collaboration_connections:
                del self.collaboration_connections[client_id]

            logger.info("Client %s disconnected from note %s", client_id, note_id)

    async def broadcast_to_note(self, note_id: str, message: dict[str, Any], exclude_client: str = None):
        """Broadcast a JSON message to all collaborators of a note (legacy method)."""
        if note_id not in self.note_collaborators:
            return

        message_text = json.dumps(message)
        note_collab = self.note_collaborators[note_id]
        clients = note_collab.get("clients", set()) if isinstance(note_collab, dict) else note_collab

        for client_id in clients:
            if exclude_client and client_id == exclude_client:
                continue

            if client_id in self.collaboration_connections:
                websocket = self.collaboration_connections[client_id]
                try:
                    # noinspection PyUnresolvedReferences
                    await websocket.send_text(message_text)
                except Exception as e:
                    logger.error("Error broadcasting to client %s: %s", client_id, str(e))

    async def broadcast_yjs_update(self, note_id: str, update: bytes, exclude_client: str = None):
        """Broadcast a Yjs update to all collaborators of a note."""
        if note_id not in self.note_collaborators:
            return

        # Wrap update in y-websocket protocol message (type 0, subtype 2 = update)
        # with VarUint8Array encoding per y-protocols wire format
        message = bytes([0, 2]) + _write_var_uint8_array(update)
        clients = self.note_collaborators[note_id].get("clients", set())

        for client_id in clients:
            if exclude_client and client_id == exclude_client:
                continue

            if client_id in self.collaboration_connections:
                websocket = self.collaboration_connections[client_id]
                try:
                    # noinspection PyUnresolvedReferences
                    await websocket.send_bytes(message)
                except Exception as e:
                    logger.error(
                        "Error broadcasting Yjs update to client %s: %s",
                        client_id,
                        str(e),
                    )

    async def broadcast_awareness(self, note_id: str, awareness_data: bytes, exclude_client: str = None):
        """Broadcast awareness information (cursors, user presence) to all collaborators."""
        if note_id not in self.note_collaborators:
            return

        clients = self.note_collaborators[note_id].get("clients", set())

        for client_id in clients:
            if exclude_client and client_id == exclude_client:
                continue

            if client_id in self.collaboration_connections:
                websocket = self.collaboration_connections[client_id]
                try:
                    # noinspection PyUnresolvedReferences
                    await websocket.send_bytes(awareness_data)
                except Exception as e:
                    logger.error(
                        "Error broadcasting awareness to client %s: %s",
                        client_id,
                        str(e),
                    )

    async def send_note_update(self, note_id: str, update_data: dict[str, Any]):
        """Send a note update to all collaborators."""
        message = {
            "type": "note_update",
            "note_id": note_id,
            "data": update_data,
            "timestamp": time.time(),
        }
        await self.broadcast_to_note(note_id, message)


# Create a singleton instance
websocket_manager = WebSocketManager()
