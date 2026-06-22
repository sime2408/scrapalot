"""Simplified SharePoint/OneDrive connector for Scrapalot Chat.

Supports:
- Microsoft 365 authentication via client credentials
- File sync from SharePoint sites and OneDrive
- Basic document extraction
- Incremental sync with modification tracking

Note: This is a simplified implementation. Advanced features like
certificate auth, permission sync, and site pages are not included.
"""

from collections.abc import Generator
from datetime import UTC, datetime
import io
from typing import Any

import msal
from office365.graph_client import GraphClient
from office365.onedrive.driveitems.driveItem import DriveItem
from office365.runtime.auth.token_response import TokenResponse
from pydantic import BaseModel

from src.main.connectors.exceptions import (
    ConnectorAuthError,
    ConnectorError,
    ConnectorMissingCredentialError,
)
from src.main.connectors.factory import register_connector
from src.main.connectors.interfaces import (
    GenerateDocumentsOutput,
    LoadConnector,
    PollConnector,
    SecondsSinceUnixEpoch,
)
from src.main.connectors.models import (
    ConnectorSource,
    Document,
    DocumentMetadata,
    TextSection,
)
from src.main.utils.core.datetime_utils import parse_iso_datetime
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_BATCH_SIZE = 50
_MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB limit


class SiteInfo(BaseModel):
    """SharePoint site information."""

    url: str
    drive_name: str | None = None  # None = all drives
    folder_path: str | None = None  # None = all folders


@register_connector(ConnectorSource.ONEDRIVE)
class SharePointConnector(LoadConnector, PollConnector):
    """Simplified SharePoint/OneDrive connector.

    Arguments:
        connector_id: UUID of the connector
        workspace_id: UUID of the workspace
        config: Connector configuration
    """

    def __init__(
        self,
        connector_id: str,
        workspace_id: str,
        config: dict[str, Any],
    ) -> None:
        """Initialize with parameters."""
        super().__init__()
        self.connector_id = connector_id
        self.workspace_id = workspace_id
        self.config = config

        # Configuration
        self.sites = config.get("sites", [])  # List of site URLs
        self.batch_size = config.get("batch_size", _BATCH_SIZE)

        self.graph_client: GraphClient | None = None
        self.tenant_id: str | None = None

    def load_credentials(self, credentials: dict[str, Any]) -> dict[str, Any] | None:
        """Load and validate SharePoint credentials."""
        client_id = credentials.get("client_id")
        client_secret = credentials.get("client_secret")
        tenant_id = credentials.get("tenant_id")

        if not all([client_id, client_secret, tenant_id]):
            raise ConnectorMissingCredentialError("SharePoint requires client_id, client_secret, and tenant_id")

        _client_id = str(client_id)
        _client_secret = str(client_secret)
        _tenant_id = str(tenant_id)

        try:
            self.tenant_id = _tenant_id

            # Create MSAL app for authentication
            authority = f"https://login.microsoftonline.com/{_tenant_id}"
            msal_app = msal.ConfidentialClientApplication(
                client_id=_client_id,
                client_credential=_client_secret,
                authority=authority,
            )

            # Acquire token for Microsoft Graph
            token_result = msal_app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])

            if "access_token" not in token_result:
                error_desc = token_result.get("error_description", "Unknown error")
                raise ConnectorAuthError(f"Failed to acquire token: {error_desc}")

            # Create Graph client
            def token_provider():
                return TokenResponse.from_json(token_result)

            self.graph_client = GraphClient(token_provider)

            logger.info("Successfully authenticated with Microsoft Graph")
            return credentials

        except Exception as e:
            raise ConnectorAuthError(f"SharePoint authentication failed: {e}") from e

    @staticmethod
    def _parse_site_url(site_url: str) -> SiteInfo:
        """Parse site URL into components."""
        parts = site_url.strip().split("/")

        # Find /sites/ or /teams/ in URL
        site_type_index = None
        if "sites" in parts:
            site_type_index = parts.index("sites")
        elif "teams" in parts:
            site_type_index = parts.index("teams")

        if site_type_index is None:
            logger.warning("Invalid SharePoint URL: %s", site_url)
            return SiteInfo(url=site_url)

        # Extract base site URL
        base_url = "/".join(parts[: site_type_index + 2])
        remaining = parts[site_type_index + 2 :]

        drive_name = remaining[0] if remaining else None
        folder_path = "/".join(remaining[1:]) if len(remaining) > 1 else None

        return SiteInfo(url=base_url, drive_name=drive_name, folder_path=folder_path)

    def _get_drive_items(
        self,
        site_info: SiteInfo,
        modified_after: datetime | None = None,
    ) -> list[DriveItem]:
        """Get drive items from a SharePoint site."""
        if not self.graph_client:
            raise ConnectorMissingCredentialError("SharePoint")

        try:
            site = self.graph_client.sites.get_by_url(site_info.url)
            drives = site.drives.get().execute_query()

            all_items = []

            for drive in drives:
                # Filter by drive name if specified
                if site_info.drive_name and drive.name != site_info.drive_name:
                    continue

                logger.info("Processing drive: %s", drive.name)

                try:
                    # Get root folder
                    root = drive.root

                    # Navigate to subfolder if specified
                    if site_info.folder_path:
                        for folder_part in site_info.folder_path.split("/"):
                            root = root.get_by_path(folder_part)

                    # Get all files recursively
                    files = root.get_files(recursive=True).execute_query()

                    for file_item in files:
                        # Filter by modification time if specified
                        if modified_after and file_item.last_modified_datetime:
                            file_modified = parse_iso_datetime(file_item.last_modified_datetime)
                            if file_modified < modified_after:
                                continue

                        # Check file size
                        if hasattr(file_item, "size") and file_item.size:
                            if file_item.size > _MAX_FILE_SIZE:
                                logger.warning("Skipping large file: %s (%s bytes)", file_item.name, file_item.size)
                                continue

                        all_items.append(file_item)

                except Exception as e:
                    logger.warning("Error processing drive %s: %s", drive.name, e)
                    continue

            logger.info("Found %s files in site: %s", len(all_items), site_info.url)
            return all_items

        except Exception as e:
            raise ConnectorError(f"Error fetching drive items: {e}") from e

    @staticmethod
    def _download_file_content(drive_item: DriveItem) -> bytes:
        """Download file content from SharePoint."""
        try:
            # Download file to memory
            content = io.BytesIO()
            drive_item.download(content).execute_query()
            return content.getvalue()
        except Exception as e:
            raise ConnectorError(f"Error downloading file {drive_item.name}: {e}") from e

    @staticmethod
    def _extract_text_from_file(file_content: bytes, file_name: str) -> str:
        """Extract text from file content (simplified)."""
        # For now, just handle text files
        # In production, you'd use file processing libraries
        if file_name.endswith((".txt", ".md")):
            try:
                return file_content.decode("utf-8")
            except UnicodeDecodeError:
                return file_content.decode("utf-8", errors="ignore")

        # For other files, return placeholder
        return f"[Content from {file_name} - full text extraction not implemented in simplified version]"

    def _drive_item_to_document(self, drive_item: DriveItem) -> Document:
        """Convert SharePoint drive item to Document."""
        try:
            file_name = drive_item.name or ""

            # Download and extract content
            file_content = self._download_file_content(drive_item)
            text_content = self._extract_text_from_file(file_content, file_name)

            # Get modification time
            modified_at = None
            raw_dt = drive_item.last_modified_datetime
            if raw_dt is not None:
                if isinstance(raw_dt, str):
                    modified_at = parse_iso_datetime(raw_dt)
                else:
                    modified_at = raw_dt if raw_dt.tzinfo is not None else raw_dt.replace(tzinfo=UTC)

            # Build web URL
            web_url = drive_item.web_url if hasattr(drive_item, "web_url") else ""

            return Document(
                id=drive_item.id or "",
                sections=[TextSection(text=text_content, link=web_url)],
                source=ConnectorSource.ONEDRIVE,
                semantic_identifier=file_name,
                doc_updated_at=modified_at,
                metadata=DocumentMetadata(
                    connector_id=self.connector_id,
                    workspace_id=self.workspace_id,
                    file_name=file_name,
                    file_id=drive_item.id or "",
                    file_type=file_name.split(".")[-1] if "." in file_name else None,
                    file_size=drive_item.size if hasattr(drive_item, "size") else None,
                    last_modified=modified_at,
                ),
            )

        except Exception as e:
            logger.exception("Error converting drive item %s: %s", drive_item.name, e)
            raise

    def _process_site(
        self,
        site_url: str,
        modified_after: datetime | None = None,
    ) -> Generator[list[Document], None, None]:
        """Process all files from a SharePoint site."""
        site_info = self._parse_site_url(site_url)

        if not site_info.url:
            logger.warning("Invalid site URL: %s", site_url)
            return

        logger.info("Processing site: %s", site_info.url)

        # Get all drive items
        drive_items = self._get_drive_items(site_info, modified_after)

        # Process in batches
        documents = []
        for drive_item in drive_items:
            try:
                doc = self._drive_item_to_document(drive_item)
                documents.append(doc)

                # Yield batch when ready
                if len(documents) >= self.batch_size:
                    yield documents
                    documents = []

            except Exception as e:
                logger.exception("Error processing file %s: %s", drive_item.name, e)
                continue

        # Yield remaining documents
        if documents:
            yield documents

    def load_from_state(self) -> GenerateDocumentsOutput:
        """Load all files from configured SharePoint sites."""
        if not self.graph_client:
            raise ConnectorMissingCredentialError("SharePoint")

        logger.info("Starting SharePoint connector load_from_state")

        # If no sites specified, try to get user's OneDrive
        if not self.sites:
            logger.info("No sites configured, attempting to access user's OneDrive")
            # This would require Graph API call to get user's drive
            # For simplified version, just log warning
            logger.warning("Please configure site URLs in connector settings")
            return

        for site_url in self.sites:
            try:
                yield from self._process_site(site_url)
            except Exception as e:
                logger.exception("Error processing site %s: %s", site_url, e)
                continue

        logger.info("Completed SharePoint connector load_from_state")

    def poll_source(
        self,
        start: SecondsSinceUnixEpoch,
        end: SecondsSinceUnixEpoch,
    ) -> GenerateDocumentsOutput:
        """Poll for files modified between start and end time."""
        if not self.graph_client:
            raise ConnectorMissingCredentialError("SharePoint")

        logger.info("Starting SharePoint connector poll_source from %s to %s", start, end)

        modified_after = datetime.fromtimestamp(start, tz=UTC)

        if not self.sites:
            logger.warning("Please configure site URLs in connector settings")
            return

        for site_url in self.sites:
            try:
                yield from self._process_site(site_url, modified_after)
            except Exception as e:
                logger.exception("Error polling site %s: %s", site_url, e)
                continue

        logger.info("Completed SharePoint connector poll_source")
