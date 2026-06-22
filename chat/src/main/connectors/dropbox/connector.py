"""Dropbox connector for Scrapalot Chat.

Supports:
- OAuth 2.0 authentication
- Access token authentication (legacy)
- Load all files from Dropbox
- Poll for updated files
- Recursive folder traversal
- Shared link generation
"""

from datetime import UTC
from io import BytesIO
import os
from typing import Any

from dropbox import Dropbox  # type: ignore[import-untyped]
from dropbox.exceptions import ApiError, AuthError  # type: ignore[import-untyped]
from dropbox.files import FileMetadata, FolderMetadata  # type: ignore[import-untyped]

from src.main.connectors.exceptions import (
    ConnectorAuthError,
    ConnectorMissingCredentialError,
    ConnectorValidationError,
)
from src.main.connectors.factory import register_connector
from src.main.connectors.interfaces import (
    GenerateDocumentsOutput,
    LoadConnector,
    OAuthConnector,
    PollConnector,
    SecondsSinceUnixEpoch,
)
from src.main.connectors.models import (
    ConnectorSource,
    Document,
    DocumentMetadata,
    TextSection,
)
from src.main.utils.core.logger import get_logger
from src.main.utils.files.extraction import extract_file_text

logger = get_logger(__name__)


@register_connector(ConnectorSource.DROPBOX)
class DropboxConnector(LoadConnector, PollConnector, OAuthConnector):
    """Dropbox connector for syncing files from Dropbox to Scrapalot.

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
        self.batch_size = config.get("batch_size", 50)
        self.root_path = config.get("root_path", "")  # Root folder to sync from

        # Dropbox client
        self.dropbox_client: Dropbox | None = None

    def load_credentials(self, credentials: dict[str, Any]) -> dict[str, Any] | None:
        """Load the Dropbox access token and initialize the client.

        Supports both OAuth tokens and legacy access tokens.
        """
        # Try OAuth token first (new method)
        access_token = credentials.get("access_token")

        # Fall back to legacy access token
        if not access_token:
            access_token = credentials.get("dropbox_access_token")

        if not access_token:
            raise ConnectorMissingCredentialError("Dropbox")

        self.dropbox_client = Dropbox(str(access_token))
        logger.info("Dropbox client initialized")
        return None

    def _download_file(self, path: str) -> bytes:
        """Download a single file from Dropbox."""
        if self.dropbox_client is None:
            raise ConnectorMissingCredentialError("Dropbox")

        _, resp = self.dropbox_client.files_download(path)
        return resp.content

    def _get_shared_link(self, path: str) -> str:
        """Create a shared link for a file in Dropbox."""
        if self.dropbox_client is None:
            raise ConnectorMissingCredentialError("Dropbox")

        try:
            # Check if a shared link already exists
            shared_links = self.dropbox_client.sharing_list_shared_links(path=path)
            if shared_links.links:
                return shared_links.links[0].url

            # Create a new shared link
            link_metadata = self.dropbox_client.sharing_create_shared_link_with_settings(path)
            return link_metadata.url
        except ApiError as err:
            logger.exception("Failed to create a shared link for %s: %s", path, err)
            return ""

    def _yield_files_recursive(
        self,
        path: str,
        start: SecondsSinceUnixEpoch | None,
        end: SecondsSinceUnixEpoch | None,
    ) -> GenerateDocumentsOutput:
        """Yield files in batches from a specified Dropbox folder, including subfolders."""
        if self.dropbox_client is None:
            raise ConnectorMissingCredentialError("Dropbox")

        result = self.dropbox_client.files_list_folder(
            path,
            limit=self.batch_size,
            recursive=False,
            include_non_downloadable_files=False,
        )

        while True:
            batch: list[Document] = []

            for entry in result.entries:
                if isinstance(entry, FileMetadata):
                    modified_time = entry.client_modified
                    if modified_time.tzinfo is None:
                        # If no timezone info, assume it is UTC
                        modified_time = modified_time.replace(tzinfo=UTC)
                    else:
                        # If not in UTC, translate it
                        modified_time = modified_time.astimezone(UTC)

                    time_as_seconds = int(modified_time.timestamp())
                    if start and time_as_seconds < start:
                        continue
                    if end and time_as_seconds > end:
                        continue

                    try:
                        # Download file
                        downloaded_file = self._download_file(entry.path_display)
                        link = self._get_shared_link(entry.path_display)

                        # Extract text content
                        text = extract_file_text(
                            BytesIO(downloaded_file),
                            file_name=entry.name,
                            break_on_unprocessable=False,
                        )

                        # Create metadata
                        metadata = DocumentMetadata(
                            source=ConnectorSource.DROPBOX,
                            connector_id=self.connector_id,
                            workspace_id=self.workspace_id,
                            file_id=entry.id,
                            file_name=entry.name,
                            file_path=entry.path_display,
                            file_type=entry.content_hash,  # Using content_hash as type identifier
                            file_size=entry.size,
                            last_modified=modified_time,
                            extra={"link": link},
                        )

                        batch.append(
                            Document(
                                id=f"dropbox:{entry.id}",
                                sections=[TextSection(link=link, text=text)],
                                source=ConnectorSource.DROPBOX,
                                semantic_identifier=entry.name,
                                metadata=metadata,
                                title=entry.name,
                                doc_updated_at=modified_time,
                            )
                        )
                    except Exception as e:
                        logger.exception("Error processing file %s: %s", entry.path_display, e)

                elif isinstance(entry, FolderMetadata):
                    # Recursively process subfolders
                    yield from self._yield_files_recursive(entry.path_lower, start, end)

            if batch:
                yield batch

            if not result.has_more:
                break

            result = self.dropbox_client.files_list_folder_continue(result.cursor)

    def load_from_state(self) -> GenerateDocumentsOutput:
        """Load all files from Dropbox."""
        return self.poll_source(None, None)

    def poll_source(self, start: SecondsSinceUnixEpoch | None, end: SecondsSinceUnixEpoch | None) -> GenerateDocumentsOutput:
        """Poll for files updated within a time range."""
        if self.dropbox_client is None:
            raise ConnectorMissingCredentialError("Dropbox")

        yield from self._yield_files_recursive(self.root_path, start, end)

    def validate_connector_settings(self) -> None:
        """Validate Dropbox connector settings and credentials."""
        if self.dropbox_client is None:
            raise ConnectorMissingCredentialError("Dropbox credentials not loaded.")

        try:
            # Try to list files to validate credentials
            self.dropbox_client.files_list_folder(path=self.root_path, limit=1)
            logger.info("Dropbox connector validation successful")
        except AuthError as e:
            logger.exception("Failed to validate Dropbox credentials")
            raise ConnectorAuthError(f"Dropbox credential is invalid: {e.error}") from e
        except ApiError as e:
            if e.error is not None and "insufficient_permissions" in str(e.error).lower():
                raise ConnectorAuthError("Your Dropbox token does not have sufficient permissions.") from e
            raise ConnectorValidationError(f"Unexpected Dropbox error during validation: {e.user_message_text or e}") from e
        except Exception as e:
            raise ConnectorValidationError(f"Unexpected error during Dropbox settings validation: {e}") from e

    @classmethod
    def oauth_id(cls) -> str:
        """Return OAuth provider ID."""
        return "dropbox"

    @classmethod
    def oauth_authorization_url(
        cls,
        base_domain: str,
        state: str,
        additional_kwargs: dict[str, str],
    ) -> str:
        """Generate OAuth authorization URL for Dropbox.

        Dropbox OAuth 2.0 flow:
        https://www.dropbox.com/developers/documentation/http/documentation#oauth2-authorize
        """
        # Get app key from user-provided credentials or fall back to environment
        app_key = additional_kwargs.get("client_id") or os.getenv("DROPBOX_APP_KEY")
        redirect_uri = f"{base_domain}/api/v1/connectors/dropbox/oauth/callback"

        # Dropbox OAuth scopes
        # files.metadata.read - View metadata for files and folders
        # files.content.read - View content of files
        # sharing.read - View shared links
        scopes = [
            "files.metadata.read",
            "files.content.read",
            "sharing.read",
        ]

        return (
            f"https://www.dropbox.com/oauth2/authorize?"
            f"client_id={app_key}&"
            f"redirect_uri={redirect_uri}&"
            f"response_type=code&"
            f"state={state}&"
            f"token_access_type=offline&"
            f"scope={' '.join(scopes)}"
        )

    @classmethod
    def oauth_code_to_token(
        cls,
        base_domain: str,
        code: str,
        additional_kwargs: dict[str, str],
    ) -> dict[str, Any]:
        """Exchange OAuth code for an access token.

        Dropbox token endpoint:
        https://www.dropbox.com/developers/documentation/http/documentation#oauth2-token
        """
        import requests

        # Get credentials from user-provided values or fall back to environment
        app_key = additional_kwargs.get("client_id") or os.getenv("DROPBOX_APP_KEY")
        app_secret = additional_kwargs.get("client_secret") or os.getenv("DROPBOX_APP_SECRET")
        redirect_uri = f"{base_domain}/api/v1/connectors/dropbox/oauth/callback"

        response = requests.post(
            "https://api.dropboxapi.com/oauth2/token",
            data={
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            },
            auth=(app_key or "", app_secret or ""),
        )

        if response.status_code != 200:
            raise ConnectorAuthError(f"Failed to exchange OAuth code: {response.text}")

        token_data = response.json()

        return {
            "access_token": token_data["access_token"],
            "refresh_token": token_data.get("refresh_token"),
            "token_type": token_data.get("token_type", "bearer"),
            "expires_in": token_data.get("expires_in"),
            "scope": token_data.get("scope"),
            "account_id": token_data.get("account_id"),
            "uid": token_data.get("uid"),
        }
