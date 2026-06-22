"""
gRPC Server for Python CHAT Backend

Starts gRPC server on port 9091 and registers AI services.
Kotlin Backend calls these services for AI operations.
"""

import asyncio
from concurrent import futures
import signal

import grpc

from src.main.grpc import (
    admin_pb2_grpc,
    chat_pb2_grpc,
    collection_ai_pb2_grpc,
    connectors_pb2_grpc,
    desktop_pb2_grpc,
    document_extras_pb2_grpc,
    documents_pb2_grpc,
    external_books_pb2_grpc,
    inspection_pb2_grpc,
    jobs_pb2_grpc,
    llm_inference_pb2_grpc,
    mcp_pb2_grpc,
    notes_assistant_pb2_grpc,
    paper_pb2_grpc,
    research_pb2_grpc,
    settings_ai_pb2_grpc,
    stt_pb2_grpc,
    tts_pb2_grpc,
)
from src.main.grpc.services.admin_service import AdminServiceServicer
from src.main.grpc.services.chat_service import ChatServiceServicer
from src.main.grpc.services.collection_ai_service import CollectionAIServiceServicer
from src.main.grpc.services.connectors_service import ConnectorServiceServicer
from src.main.grpc.services.desktop_service import DesktopServiceServicer
from src.main.grpc.services.document_collection_service import DocumentCollectionServiceServicer
from src.main.grpc.services.document_extras_service import DocumentExtrasServiceServicer
from src.main.grpc.services.document_processing_service import DocumentProcessingServiceServicer
from src.main.grpc.services.external_books_service import ExternalBooksServiceServicer
from src.main.grpc.services.inspection_service import InspectionServiceServicer
from src.main.grpc.services.jobs_service import JobsServiceServicer
from src.main.grpc.services.llm_inference_service import LlmInferenceServiceServicer
from src.main.grpc.services.mcp_service import McpServiceServicer
from src.main.grpc.services.notes_assistant_service import NotesAssistantServiceServicer
from src.main.grpc.services.paper_service import PaperServiceServicer
from src.main.grpc.services.research_service import ResearchDataServiceServicer
from src.main.grpc.services.settings_ai_service import SettingsAIServiceServicer
from src.main.grpc.services.stt_service import SttServiceServicer
from src.main.grpc.services.tts_service import TtsServiceServicer
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class GrpcServer:
    """gRPC Server for AI services."""

    def __init__(self):
        """Initialize gRPC server."""
        self.server = None
        self._shutdown_event = asyncio.Event()

    async def start(self):
        """Start the gRPC server."""
        # Get config
        grpc_config = resolved_config.get("grpc", {}).get("server", {})
        port = int(grpc_config.get("port", 9091))
        address = grpc_config.get("address", "0.0.0.0")
        max_workers = int(grpc_config.get("max_workers", 10))

        # Create server with keepalive options to prevent connection drops during long streaming RPCs
        self.server = grpc.aio.server(
            futures.ThreadPoolExecutor(max_workers=max_workers),
            options=[
                ("grpc.max_send_message_length", 50 * 1024 * 1024),  # 50MB
                ("grpc.max_receive_message_length", 50 * 1024 * 1024),  # 50MB
                ("grpc.keepalive_time_ms", 30000),  # Send keepalive ping every 30s
                ("grpc.keepalive_timeout_ms", 10000),  # Wait 10s for pong response
                ("grpc.keepalive_permit_without_calls", True),  # Allow keepalive even without active RPCs
                (
                    "grpc.http2.min_recv_ping_interval_without_data_in_seconds",
                    10,
                ),  # Accept client pings every 10s (Kotlin sends every 30s)
                ("grpc.http2.max_pings_without_data", 0),  # Unlimited pings without data (no GOAWAY)
            ],
        )

        # Register services
        chat_pb2_grpc.add_ChatServiceServicer_to_server(ChatServiceServicer(), self.server)
        documents_pb2_grpc.add_DocumentProcessingServiceServicer_to_server(DocumentProcessingServiceServicer(), self.server)
        documents_pb2_grpc.add_DocumentCollectionServiceServicer_to_server(DocumentCollectionServiceServicer(), self.server)
        jobs_pb2_grpc.add_JobsServiceServicer_to_server(JobsServiceServicer(), self.server)
        admin_pb2_grpc.add_AdminServiceServicer_to_server(AdminServiceServicer(), self.server)
        tts_pb2_grpc.add_TtsServiceServicer_to_server(TtsServiceServicer(), self.server)
        stt_pb2_grpc.add_SttServiceServicer_to_server(SttServiceServicer(), self.server)
        research_pb2_grpc.add_ResearchDataServiceServicer_to_server(ResearchDataServiceServicer(), self.server)
        collection_ai_pb2_grpc.add_CollectionAIServiceServicer_to_server(CollectionAIServiceServicer(), self.server)
        settings_ai_pb2_grpc.add_SettingsAIServiceServicer_to_server(SettingsAIServiceServicer(), self.server)
        llm_inference_pb2_grpc.add_LlmInferenceServiceServicer_to_server(LlmInferenceServiceServicer(), self.server)
        document_extras_pb2_grpc.add_DocumentExtrasServiceServicer_to_server(DocumentExtrasServiceServicer(), self.server)
        external_books_pb2_grpc.add_ExternalBooksServiceServicer_to_server(ExternalBooksServiceServicer(), self.server)
        desktop_pb2_grpc.add_DesktopServiceServicer_to_server(DesktopServiceServicer(), self.server)
        connectors_pb2_grpc.add_ConnectorServiceServicer_to_server(ConnectorServiceServicer(), self.server)
        inspection_pb2_grpc.add_InspectionServiceServicer_to_server(InspectionServiceServicer(), self.server)
        notes_assistant_pb2_grpc.add_NotesAssistantServiceServicer_to_server(NotesAssistantServiceServicer(), self.server)
        paper_pb2_grpc.add_PaperServiceServicer_to_server(PaperServiceServicer(), self.server)
        mcp_pb2_grpc.add_McpServiceServicer_to_server(McpServiceServicer(), self.server)

        # Bind port
        listen_addr = f"{address}:{port}"
        self.server.add_insecure_port(listen_addr)

        # Start server
        await self.server.start()
        logger.info("gRPC server started on %s", listen_addr)
        logger.info(
            "Registered services: ChatService, DocumentProcessingService, DocumentCollectionService, JobsService, AdminService, TtsService, SttService, ResearchDataService, CollectionAIService, SettingsAIService, LlmInferenceService, DocumentExtrasService, ExternalBooksService, DesktopService, ConnectorService, InspectionService, NotesAssistantService"
        )

        # Mark gRPC as ready for the readiness probe
        try:
            from src.main.utils.startup.state import get_startup_state

            state = get_startup_state()
            state.start_task("grpc_server")
            state.complete_task("grpc_server")
            logger.info("Marked grpc_server as ready in startup state")
        except Exception as e:
            logger.warning("Failed to update startup state for gRPC: %s", e)

        # Setup signal handlers
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):

            def _make_shutdown_handler(s):
                def _handler():
                    asyncio.create_task(self.shutdown(s))

                return _handler

            # noinspection PyTypeChecker
            loop.add_signal_handler(sig, _make_shutdown_handler(sig))

        # Return control - server will stay active
        # wait_for_termination() should be called by the caller to keep server running

    async def shutdown(self, sig=None):
        """Gracefully shutdown the server."""
        if sig:
            logger.info("Received signal %s, shutting down gRPC server...", sig.name)
        else:
            logger.info("Shutting down gRPC server...")

        if self.server:
            await self.server.stop(grace=50)  # 50s grace (Docker stop_grace_period=90s)
            logger.info("gRPC server stopped")

        self._shutdown_event.set()

    async def wait_for_termination(self):
        """Wait for server termination."""
        if self.server:
            await self.server.wait_for_termination()


async def serve():
    """Main entry point for gRPC server."""
    server = GrpcServer()
    try:
        await server.start()
    except Exception as e:
        logger.exception("Error starting gRPC server: %s", str(e))
        await server.shutdown()


def run_grpc_server():
    """Run the gRPC server (sync wrapper for async serve)."""
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        logger.info("gRPC server interrupted by user")
    except Exception as e:
        logger.exception("Fatal error in gRPC server: %s", str(e))


if __name__ == "__main__":
    run_grpc_server()
