"""gRPC servicer for MCP integration operations.

Currently exposes TestConnection: connect to a remote MCP server (streamable
HTTP / SSE), list its tools, and return them so the UI can validate a server and
preview its tools before the user saves the integration. A failed connection is
a normal result (ok=False + error), not a gRPC error.
"""

import grpc

from src.main.grpc import mcp_pb2, mcp_pb2_grpc
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class McpServiceServicer(mcp_pb2_grpc.McpServiceServicer):
    """gRPC servicer for MCP server validation + tool discovery."""

    async def TestConnection(
        self,
        request: mcp_pb2.McpTestConnectionRequest,
        context: grpc.aio.ServicerContext,
    ) -> mcp_pb2.McpTestConnectionResponse:
        url = (request.url or "").strip()
        transport = (request.transport or "http").lower()
        headers: dict[str, str] = dict(request.headers) if request.headers else {}
        if request.auth_token:
            headers.setdefault("Authorization", f"Bearer {request.auth_token}")

        if not url:
            return mcp_pb2.McpTestConnectionResponse(ok=False, error="Server URL is required")

        try:
            from fastmcp import Client
            from fastmcp.client.transports import SSETransport, StreamableHttpTransport

            if transport == "sse":
                client_transport = SSETransport(url=url, headers=headers or None)
            else:
                client_transport = StreamableHttpTransport(url=url, headers=headers or None)

            async with Client(transport=client_transport) as client:
                tools = await client.list_tools()

            tool_infos = [mcp_pb2.McpToolInfo(name=t.name, description=(getattr(t, "description", "") or "")) for t in tools]
            logger.info("MCP TestConnection OK: %s (%d tools)", url, len(tool_infos))
            return mcp_pb2.McpTestConnectionResponse(ok=True, tools=tool_infos)
        except Exception as e:
            logger.warning("MCP TestConnection failed for %s: %s", url, e)
            return mcp_pb2.McpTestConnectionResponse(ok=False, error=str(e))
