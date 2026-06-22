"""Base connector interfaces for document ingestion."""

import abc
from collections.abc import Generator, Iterator
from typing import Any

from src.main.connectors.models import ConnectorCheckpoint, ConnectorFailure, Document

SecondsSinceUnixEpoch = float

GenerateDocumentsOutput = Iterator[list[Document]]


class BaseConnector(abc.ABC):
    """Base connector interface that all connectors must implement."""

    def __init__(self, connector_id: str | None = None, workspace_id: str | None = None, config: dict[str, Any] | None = None):
        self.connector_id = connector_id
        self.workspace_id = workspace_id
        self.config = config or {}
        self.credentials: dict[str, Any] | None = None

    @abc.abstractmethod
    def load_credentials(self, credentials: dict[str, Any]) -> dict[str, Any] | None:
        """Load and validate credentials. Return processed credentials or None."""
        raise NotImplementedError

    def validate_connector_settings(self) -> None:  # noqa: B027
        """
        Optional hook: override in subclasses that need to validate credentials
        or settings. Default is no-op (intentionally non-abstract: most
        connectors never need this, so we don't force every subclass to
        implement it).
        """

    def set_allow_images(self, value: bool) -> None:  # noqa: B027
        """
        Optional hook: override to toggle image downloading. Default is
        no-op (same rationale as validate_connector_settings).
        """


class LoadConnector(BaseConnector):
    """Connector that loads a complete state or from a save file."""

    @abc.abstractmethod
    def load_from_state(self) -> GenerateDocumentsOutput:
        """Load all documents from the current state."""
        raise NotImplementedError


class PollConnector(BaseConnector):
    """Connector that polls for changes within a time range."""

    @abc.abstractmethod
    def poll_source(self, start: SecondsSinceUnixEpoch, end: SecondsSinceUnixEpoch) -> GenerateDocumentsOutput:
        """Poll for documents changed between start and end time."""
        raise NotImplementedError


class CheckpointedConnector(BaseConnector):
    """Connector that supports resumable sync with checkpoints."""

    @abc.abstractmethod
    def load_from_checkpoint(
        self,
        start: SecondsSinceUnixEpoch,
        end: SecondsSinceUnixEpoch,
        checkpoint: ConnectorCheckpoint,
    ) -> Generator[Document | ConnectorFailure, None, ConnectorCheckpoint]:
        """
        Yields documents or failures. Returns a new checkpoint.

        Usage:
        ```
        checkpoint = yield from connector.load_from_checkpoint(start, end, checkpoint)
        ```
        """
        raise NotImplementedError

    @abc.abstractmethod
    def build_dummy_checkpoint(self) -> ConnectorCheckpoint:
        """Build an initial checkpoint for first-time sync."""
        raise NotImplementedError

    @abc.abstractmethod
    def validate_checkpoint_json(self, checkpoint_json: str) -> ConnectorCheckpoint:
        """Validate and parse checkpoint JSON."""
        raise NotImplementedError


class OAuthConnector(BaseConnector):
    """Connector that uses OAuth for authentication."""

    @classmethod
    @abc.abstractmethod
    def oauth_id(cls) -> str:
        """Return the OAuth provider ID (e.g., 'google_drive', 'notion')."""
        raise NotImplementedError

    @classmethod
    @abc.abstractmethod
    def oauth_authorization_url(
        cls,
        base_domain: str,
        state: str,
        additional_kwargs: dict[str, str],
    ) -> str:
        """Generate the OAuth authorization URL."""
        raise NotImplementedError

    @classmethod
    @abc.abstractmethod
    def oauth_code_to_token(
        cls,
        base_domain: str,
        code: str,
        additional_kwargs: dict[str, str],
    ) -> dict[str, Any]:
        """Exchange OAuth code for access token."""
        raise NotImplementedError


class EventConnector(BaseConnector):
    """Connector that handles event-driven updates (webhooks)."""

    @abc.abstractmethod
    def handle_event(self, event: Any) -> GenerateDocumentsOutput:
        """Handle an incoming event (e.g., webhook payload)."""
        raise NotImplementedError


class FileListingConnector(BaseConnector):
    """Connector that can list files before fetching them."""

    @abc.abstractmethod
    def list_files(self, checkpoint: ConnectorCheckpoint | None = None) -> Generator[dict[str, Any], None, ConnectorCheckpoint]:
        """
        List available files with metadata.

        Yields file metadata dicts with keys:
        - file_id: str
        - file_name: str
        - file_path: str | None
        - file_type: str | None
        - file_size: int | None
        - modified_time: datetime | None

        Returns a new checkpoint.
        """
        raise NotImplementedError

    @abc.abstractmethod
    def fetch_file(self, file_id: str) -> Document:
        """Fetch and process a single file by ID."""
        raise NotImplementedError


class CredentialsProvider(abc.ABC):
    """Provider for managing connector credentials with locking."""

    @abc.abstractmethod
    def __enter__(self):
        raise NotImplementedError

    @abc.abstractmethod
    def __exit__(self, exc_type, exc_value, traceback):
        raise NotImplementedError

    @abc.abstractmethod
    def get_credentials(self) -> dict[str, Any]:
        """Get the current credentials."""
        raise NotImplementedError

    @abc.abstractmethod
    def set_credentials(self, credential_json: dict[str, Any]) -> None:
        """Update the credentials (e.g., after token refresh)."""
        raise NotImplementedError

    @abc.abstractmethod
    def is_dynamic(self) -> bool:
        """If True, credentials may change during usage (requires locking)."""
        raise NotImplementedError
