"""gRPC service for connector operations (OAuth, sync, available connectors)."""

from datetime import UTC
import json

import grpc

from src.main.grpc import connectors_pb2, connectors_pb2_grpc
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# noinspection PyUnresolvedReferences
class ConnectorServiceServicer(connectors_pb2_grpc.ConnectorServiceServicer):
    """gRPC servicer for connector AI/integration operations."""

    async def ListAvailable(self, request, context):
        """List available connector types."""
        try:
            from src.main.connectors.factory import list_available_connectors

            connectors = list_available_connectors()
            return connectors_pb2.AvailableConnectorsResponse(connectors_json=json.dumps(connectors))

        except Exception as e:
            logger.exception("gRPC ListAvailable failed: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return connectors_pb2.AvailableConnectorsResponse()

    async def OAuthAuthorize(self, request, context):
        """Initiate OAuth flow for a connector."""
        try:
            from src.main.connectors.factory import get_connector_class

            connector_class = get_connector_class(request.connector_type)
            if not connector_class:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details(f"Unknown connector type: {request.connector_type}")
                return connectors_pb2.OAuthAuthorizeResponse()

            # Get OAuth authorization URL
            connector = connector_class()
            auth_result = await connector.get_auth_url(
                workspace_id=request.workspace_id,
                redirect_uri=request.redirect_uri,
                user_id=request.user_id,
            )

            return connectors_pb2.OAuthAuthorizeResponse(
                auth_url=auth_result.get("auth_url", ""),
                state=auth_result.get("state", ""),
                connector_type=request.connector_type,
            )

        except Exception as e:
            logger.exception("gRPC OAuthAuthorize failed: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return connectors_pb2.OAuthAuthorizeResponse()

    async def OAuthCallback(self, request, context):
        """Handle OAuth callback."""
        try:
            # Decode state to get connector type and workspace info
            import base64

            from src.main.config.database import get_sqlmodel_session
            from src.main.connectors.factory import get_connector_class
            from src.main.models.sqlmodel_connectors import ConnectorCredential

            # noinspection PyBroadException
            try:
                state_data = json.loads(base64.b64decode(request.state).decode())
            except Exception:
                context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
                context.set_details("Invalid OAuth state")
                return connectors_pb2.OAuthCallbackResponse(success=False, message="Invalid OAuth state")

            connector_type = state_data.get("connector_type")
            workspace_id = state_data.get("workspace_id")

            connector_class = get_connector_class(connector_type)
            if not connector_class:
                context.set_code(grpc.StatusCode.NOT_FOUND)
                context.set_details(f"Unknown connector type: {connector_type}")
                return connectors_pb2.OAuthCallbackResponse(success=False, message=f"Unknown connector type: {connector_type}")

            connector = connector_class()
            token_result = await connector.exchange_code(
                code=request.code,
                state=request.state,
            )

            if not token_result.get("success"):
                return connectors_pb2.OAuthCallbackResponse(
                    success=False,
                    message=token_result.get("error", "OAuth token exchange failed"),
                )

            # Store credentials
            with get_sqlmodel_session() as db:
                from datetime import datetime
                import uuid as uuid_mod

                credential = ConnectorCredential(
                    id=str(uuid_mod.uuid4()),
                    connector_type=connector_type,
                    workspace_id=workspace_id,
                    user_id=request.user_id,
                    credentials=json.dumps(token_result.get("credentials", {})),
                    created_at=datetime.now(UTC),
                    updated_at=datetime.now(UTC),
                )
                db.add(credential)
                db.commit()

                return connectors_pb2.OAuthCallbackResponse(
                    success=True,
                    credential_id=credential.id,
                    connector_type=connector_type,
                    message="OAuth authorization successful",
                )

        except Exception as e:
            logger.exception("gRPC OAuthCallback failed: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return connectors_pb2.OAuthCallbackResponse(success=False, message=str(e))

    async def SyncDestination(self, request, context):
        """Trigger sync for a connector destination."""
        try:
            import asyncio

            from src.main.background.tasks.connector_sync import sync_connector_destination

            result = await asyncio.to_thread(
                sync_connector_destination,
                connector_id=request.connector_id,
                destination_id=request.destination_id,
                user_id=request.user_id,
            )

            return connectors_pb2.SyncDestinationResponse(
                success=result.get("success", False),
                job_id="",
                message=result.get("error") or "Sync completed",
            )

        except Exception as e:
            logger.exception("gRPC SyncDestination failed: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return connectors_pb2.SyncDestinationResponse(success=False, message=str(e))

    async def ListFileSyncs(self, request, context):
        """List file syncs for a connector (Python owns connector_file_syncs table)."""
        try:
            from sqlmodel import select

            from src.main.config.database import get_sqlmodel_session
            from src.main.models.sqlmodel_connectors import ConnectorFileSync

            with get_sqlmodel_session() as db:
                stmt = select(ConnectorFileSync).where(ConnectorFileSync.connector_id == request.connector_id)
                if request.status:
                    stmt = stmt.where(ConnectorFileSync.sync_status == request.status)

                limit = request.limit if request.limit > 0 else 100
                offset = request.offset if request.offset > 0 else 0
                stmt = stmt.offset(offset).limit(limit)

                file_syncs = db.exec(stmt).all()

                entries = []
                for fs in file_syncs:
                    entries.append(
                        connectors_pb2.FileSyncEntry(
                            id=str(fs.id),
                            connector_id=str(fs.connector_id),
                            document_id=str(fs.document_id) if fs.document_id else "",
                            external_file_id=fs.external_file_id or "",
                            external_file_path=fs.external_file_path or "",
                            file_name=fs.file_name or "",
                            file_size=fs.file_size or 0,
                            file_type=fs.file_type or "",
                            sync_status=fs.sync_status or "",
                            sync_error=fs.sync_error if hasattr(fs, "sync_error") and fs.sync_error else "",
                            last_sync_attempt=fs.last_sync_attempt or "",
                            last_successful_sync=fs.last_successful_sync or "",
                            retry_count=fs.retry_count if hasattr(fs, "retry_count") and fs.retry_count else 0,
                            created_at=str(fs.created_at) if fs.created_at else "",
                            updated_at=str(fs.updated_at) if fs.updated_at else "",
                        )
                    )

                return connectors_pb2.ListFileSyncsResponse(file_syncs=entries)

        except Exception as e:
            logger.exception("gRPC ListFileSyncs failed: %s", str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return connectors_pb2.ListFileSyncsResponse()
