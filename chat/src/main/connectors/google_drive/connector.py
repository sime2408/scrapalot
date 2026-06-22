"""Google Drive connector for Scrapalot Chat.

Supports:
- OAuth authentication
- File and folder listing
- Document fetching and parsing
- Google Docs, Sheets, Slides export
- PDF, DOCX, TXT file download
"""

from collections.abc import Generator
from datetime import UTC, datetime
import io
import os
from typing import Any

try:
    import pdfplumber
except ImportError:
    pdfplumber = None  # type: ignore[assignment]

# noinspection PyUnresolvedReferences
from google.auth.transport.requests import Request

# noinspection PyUnresolvedReferences
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

from src.main.connectors.exceptions import (
    ConnectorAuthError,
    ConnectorError,
    ConnectorMissingCredentialError,
)
from src.main.connectors.factory import register_connector
from src.main.connectors.interfaces import FileListingConnector, OAuthConnector
from src.main.connectors.models import (
    ConnectorCheckpoint,
    ConnectorSource,
    Document,
    DocumentMetadata,
    TextSection,
)
from src.main.utils.core.datetime_utils import parse_iso_datetime
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# Google Drive MIME types
GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document"
GOOGLE_SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet"
GOOGLE_SLIDE_MIME_TYPE = "application/vnd.google-apps.presentation"
GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"

# Export formats
EXPORT_FORMATS = {
    GOOGLE_DOC_MIME_TYPE: ("application/pdf", "pdf"),
    GOOGLE_SHEET_MIME_TYPE: ("application/pdf", "pdf"),
    GOOGLE_SLIDE_MIME_TYPE: ("application/pdf", "pdf"),
}


@register_connector(ConnectorSource.GOOGLE_DRIVE)
class GoogleDriveConnector(FileListingConnector, OAuthConnector):
    """Google Drive connector with OAuth and file listing support."""

    def __init__(self, connector_id: str, workspace_id: str, config: dict[str, Any]):
        super().__init__()
        self.connector_id = connector_id
        self.workspace_id = workspace_id
        self.config = config
        self.service = None
        self.creds: Credentials | None = None

        # Configuration
        self.folder_ids = config.get("folder_ids", [])  # Specific folders to sync
        self.include_shared = config.get("include_shared", True)
        self.file_types = config.get("file_types", [])  # Filter by file types

    def load_credentials(self, credentials: dict[str, Any]) -> dict[str, Any] | None:
        """Load OAuth credentials and initialize Google Drive service."""
        try:
            # Extract token data
            token = credentials.get("access_token")
            refresh_token = credentials.get("refresh_token")
            token_uri = credentials.get("token_uri", "https://oauth2.googleapis.com/token")
            client_id = credentials.get("client_id") or os.getenv("GOOGLE_OAUTH_CLIENT_ID")
            client_secret = credentials.get("client_secret") or os.getenv("GOOGLE_OAUTH_CLIENT_SECRET")

            if not token:
                raise ConnectorMissingCredentialError("Google Drive")

            # Create credential object
            self.creds = Credentials(
                token=token,
                refresh_token=refresh_token,
                token_uri=token_uri,
                client_id=client_id,
                client_secret=client_secret,
            )

            # Refresh token if expired
            if self.creds.expired and self.creds.refresh_token:
                logger.info("🔄 Refreshing Google Drive access token...")
                self.creds.refresh(Request())

                # Return updated credentials
                return {
                    "access_token": self.creds.token,
                    "refresh_token": self.creds.refresh_token,
                    "token_uri": self.creds.token_uri,
                    "expiry": self.creds.expiry.isoformat() if self.creds.expiry else None,
                }

            # Build Drive service
            self.service = build("drive", "v3", credentials=self.creds)
            logger.info("Google Drive service initialized")

            return None  # No credential updates needed

        except Exception as e:
            logger.error("❌ Failed to load Google Drive credentials: %s", str(e))
            raise ConnectorAuthError(f"Failed to authenticate with Google Drive: {e!s}") from e

    def list_files(self, checkpoint: ConnectorCheckpoint | None = None) -> Generator[dict[str, Any], None, ConnectorCheckpoint]:
        """List files from Google Drive."""
        if not self.service:
            raise ConnectorMissingCredentialError("Google Drive")

        logger.info("📋 Listing Google Drive files...")

        page_token = checkpoint.page_token if checkpoint else None
        all_files_processed = []

        try:
            while True:
                # Build query
                query_parts = []

                # Filter by folders if specified
                if self.folder_ids:
                    folder_queries = [f"'{folder_id}' in parents" for folder_id in self.folder_ids]
                    query_parts.append(f"({' or '.join(folder_queries)})")

                # Include shared files if enabled
                if not self.include_shared:
                    query_parts.append("'me' in owners")

                # Exclude folders and trashed files
                query_parts.append(f"mimeType != '{GOOGLE_FOLDER_MIME_TYPE}'")
                query_parts.append("trashed = false")

                query = " and ".join(query_parts) if query_parts else None

                # Call Drive API
                results = (
                    self.service.files()
                    .list(
                        q=query,
                        pageSize=100,
                        pageToken=page_token,
                        fields="nextPageToken, files(id, name, mimeType, size, modifiedTime, parents, webViewLink)",
                        supportsAllDrives=True,
                        includeItemsFromAllDrives=True,
                    )
                    .execute()
                )

                files = results.get("files", [])
                logger.info("📄 Found %s files in this page", len(files))

                # Yield file metadata
                for file in files:
                    file_metadata = {
                        "file_id": file["id"],
                        "file_name": file["name"],
                        "file_path": self._get_file_path(file),
                        "file_type": file.get("mimeType"),
                        "file_size": int(file.get("size", 0)) if file.get("size") else None,
                        "modified_time": (parse_iso_datetime(file["modifiedTime"]) if "modifiedTime" in file else None),
                        "extra": {
                            "web_view_link": file.get("webViewLink"),
                            "parents": file.get("parents", []),
                        },
                    }
                    yield file_metadata
                    all_files_processed.append(file["id"])

                # Check for more pages
                page_token = results.get("nextPageToken")
                if not page_token:
                    break

            # Return final checkpoint
            return ConnectorCheckpoint(
                page_token=None,
                last_sync_time=datetime.now(UTC),
                processed_files=all_files_processed,
                has_more=False,
            )

        except Exception as e:
            logger.exception("❌ Error listing Google Drive files: %s", str(e))
            raise ConnectorError(f"Failed to list Google Drive files: {e!s}") from e

    def fetch_file(self, file_id: str) -> Document:
        """Fetch and parse a single file from Google Drive."""
        if not self.service:
            raise ConnectorMissingCredentialError("Google Drive")

        logger.info("📥 Fetching Google Drive file: %s", file_id)

        try:
            # Get file metadata
            file_metadata = (
                self.service.files()
                .get(
                    fileId=file_id,
                    fields="id, name, mimeType, size, modifiedTime, parents, webViewLink",
                    supportsAllDrives=True,
                )
                .execute()
            )

            mime_type = file_metadata.get("mimeType")
            file_name = file_metadata["name"]

            # Download or export file content
            if mime_type in EXPORT_FORMATS:
                # Google Workspace file - export as PDF
                export_mime_type, extension = EXPORT_FORMATS[mime_type]
                content = self._export_google_file(file_id, export_mime_type)
                file_name_with_ext = f"{file_name}.{extension}"
            else:
                # Regular file - download directly
                content = self._download_file(file_id)
                file_name_with_ext = file_name

            # Parse content based on file type
            text_content = self._parse_file_content(content, mime_type, file_name)

            # Create document metadata
            metadata = DocumentMetadata(
                source=ConnectorSource.GOOGLE_DRIVE,
                connector_id=self.connector_id,
                workspace_id=self.workspace_id,
                file_id=file_id,
                file_name=file_name_with_ext,
                file_path=self._get_file_path(file_metadata),
                file_type=mime_type,
                file_size=int(file_metadata.get("size", 0)) if file_metadata.get("size") else len(content),
                last_modified=(parse_iso_datetime(file_metadata["modifiedTime"]) if "modifiedTime" in file_metadata else None),
                extra={
                    "web_view_link": file_metadata.get("webViewLink"),
                    "parents": file_metadata.get("parents", []),
                },
            )

            # Create document
            document = Document(
                id=f"gdrive_{file_id}",
                sections=[TextSection(text=text_content)] if text_content else [],
                source=ConnectorSource.GOOGLE_DRIVE,
                semantic_identifier=file_name,
                metadata=metadata,
                title=file_name,
                doc_updated_at=metadata.last_modified,
            )

            logger.info("Fetched Google Drive file: %s", file_name)
            return document

        except Exception as e:
            logger.exception("❌ Failed to fetch Google Drive file %s: %s", file_id, str(e))
            raise ConnectorError(f"Failed to fetch file: {e!s}") from e

    def _download_file(self, file_id: str) -> bytes:
        """Download a file from Google Drive."""
        request = self.service.files().get_media(fileId=file_id, supportsAllDrives=True)
        file_buffer = io.BytesIO()
        downloader = MediaIoBaseDownload(file_buffer, request)

        done = False
        while not done:
            status, done = downloader.next_chunk()
            if status:
                logger.debug("Download progress: %s%", int(status.progress() * 100))

        return file_buffer.getvalue()

    def _export_google_file(self, file_id: str, mime_type: str) -> bytes:
        """Export a Google Workspace file."""
        request = self.service.files().export_media(fileId=file_id, mimeType=mime_type)
        file_buffer = io.BytesIO()
        downloader = MediaIoBaseDownload(file_buffer, request)

        done = False
        while not done:
            status, done = downloader.next_chunk()
            if status:
                logger.debug("Export progress: %s%", int(status.progress() * 100))

        return file_buffer.getvalue()

    @staticmethod
    def _parse_file_content(content: bytes, mime_type: str, filename: str) -> str:
        """Parse file content to extract text."""
        try:
            # Text files
            if mime_type.startswith("text/"):
                return content.decode("utf-8")

            # PDF files - require pdfplumber
            if mime_type == "application/pdf":
                if pdfplumber is not None:
                    with pdfplumber.open(io.BytesIO(content)) as pdf:  # type: ignore[union-attr]
                        return "\n".join([page.extract_text() or "" for page in pdf.pages])
                else:
                    logger.warning("⚠️ pdfplumber not available, skipping PDF parsing")
                    return f"[PDF file: {filename}]"

            # TODO: Add more parsers for DOCX, XLSX, etc.

            return f"[Unsupported file type: {mime_type}]"

        except Exception as e:
            logger.error("❌ Failed to parse file content: %s", str(e))
            return f"[Error parsing file: {e!s}]"

    @staticmethod
    def _get_file_path(file_metadata: dict[str, Any]) -> str:
        """Get the full path of a file by traversing parent folders."""
        # TODO: Implement folder hierarchy traversal
        # For now, just return the file name
        return f"/{file_metadata['name']}"

    @classmethod
    def oauth_id(cls) -> str:
        """Return OAuth provider ID."""
        return "google_drive"

    @classmethod
    def oauth_authorization_url(
        cls,
        base_domain: str,
        state: str,
        additional_kwargs: dict[str, str],
    ) -> str:
        """Generate OAuth authorization URL."""
        # Get client ID from user-provided credentials or fall back to environment
        client_id = additional_kwargs.get("client_id") or os.getenv("GOOGLE_OAUTH_CLIENT_ID")
        redirect_uri = f"{base_domain}/api/v1/connectors/google-drive/oauth/callback"
        scopes = [
            "https://www.googleapis.com/auth/drive.readonly",
            "https://www.googleapis.com/auth/drive.metadata.readonly",
        ]

        return (
            f"https://accounts.google.com/o/oauth2/v2/auth?"
            f"client_id={client_id}&"
            f"redirect_uri={redirect_uri}&"
            f"response_type=code&"
            f"scope={' '.join(scopes)}&"
            f"state={state}&"
            f"access_type=offline&"
            f"prompt=consent"
        )

    @classmethod
    def oauth_code_to_token(
        cls,
        base_domain: str,
        code: str,
        additional_kwargs: dict[str, str],
    ) -> dict[str, Any]:
        """Exchange OAuth code for an access token."""
        import requests

        # Get credentials from user-provided values or fall back to environment
        client_id = additional_kwargs.get("client_id") or os.getenv("GOOGLE_OAUTH_CLIENT_ID")
        client_secret = additional_kwargs.get("client_secret") or os.getenv("GOOGLE_OAUTH_CLIENT_SECRET")
        redirect_uri = f"{base_domain}/api/v1/connectors/google-drive/oauth/callback"

        response = requests.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )

        if response.status_code != 200:
            raise ConnectorAuthError(f"Failed to exchange OAuth code: {response.text}")

        token_data = response.json()

        return {
            "access_token": token_data["access_token"],
            "refresh_token": token_data.get("refresh_token"),
            "token_uri": "https://oauth2.googleapis.com/token",
            "client_id": client_id,
            "client_secret": client_secret,
            "expiry": None,  # Will be set when token is used
        }
