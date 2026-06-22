"""Connector factory for instantiating connector instances.

Registry pattern for managing available connectors.
"""

from typing import Any

from src.main.connectors.exceptions import ConnectorError
from src.main.connectors.interfaces import BaseConnector
from src.main.connectors.models import ConnectorSource
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Connector registry: maps ConnectorSource to connector class
_CONNECTOR_REGISTRY: dict[ConnectorSource, type[BaseConnector]] = {}


def register_connector(source: ConnectorSource):
    """Decorator to register a connector class."""

    def decorator(cls: type[BaseConnector]):
        _CONNECTOR_REGISTRY[source] = cls
        logger.debug("Registered connector: %s -> %s", source.value, cls.__name__)
        return cls

    return decorator


def get_connector_class(source: ConnectorSource) -> type[BaseConnector]:
    """Get the connector class for a given source."""
    if source not in _CONNECTOR_REGISTRY:
        raise ConnectorError(f"Connector not found for source: {source.value}")
    return _CONNECTOR_REGISTRY[source]


def get_connector_instance(
    source: ConnectorSource | str,
    connector_id: str,
    workspace_id: str,
    credentials: dict[str, Any] | None = None,
    config: dict[str, Any] | None = None,
) -> BaseConnector:
    """
    Create a connector instance.

    Args:
        source: ConnectorSource enum or string (e.g., "google_drive")
        connector_id: UUID of the connector
        workspace_id: UUID of the workspace
        credentials: Connector credentials (OAuth tokens, API keys, etc.)
        config: Connector-specific configuration

    Returns:
        Instantiated connector ready to use

    Raises:
        ConnectorError: If a connector is not found or initialization fails
    """
    # Convert string to ConnectorSource if needed
    if isinstance(source, str):
        try:
            connector_source = ConnectorSource(source)
        except ValueError:
            raise ConnectorError(f"Invalid connector source: {source}") from None
    else:
        # noinspection PyUnreachableCode
        connector_source = source

    # Get connector class
    connector_class = get_connector_class(connector_source)

    # Instantiate connector
    try:
        connector = connector_class(connector_id=connector_id, workspace_id=workspace_id, config=config or {})

        # Load credentials if provided
        if credentials:
            connector.load_credentials(credentials)

        logger.info("Connector instance created: %s (id=%s)", connector_source.value, connector_id)
        return connector

    except Exception as e:
        logger.exception("❌ Failed to create connector instance: %s", str(e))
        raise ConnectorError(f"Failed to initialize connector: {e!s}") from e


def list_available_connectors() -> dict[str, dict[str, Any]]:
    """
    List all available connectors with metadata.

    Returns:
        Dict mapping source name to connector metadata:
        {
            "google_drive": {
                "name": "Google Drive",
                "description": "Connect to Google Drive files and folders",
                "requires_oauth": True,
                "supports_auto_sync": True
            },
            ...
        }
    """
    connectors = {}

    for source, connector_class in _CONNECTOR_REGISTRY.items():
        connectors[source.value] = {
            "name": _get_connector_display_name(source),
            "description": connector_class.__doc__ or "",
            "requires_oauth": hasattr(connector_class, "oauth_id"),
            "supports_auto_sync": True,  # All connectors support auto-sync
            "class": connector_class.__name__,
        }

    return connectors


def _get_connector_display_name(source: ConnectorSource) -> str:
    """Get a human-readable display name for a connector source."""
    display_names = {
        # Cloud Storage
        ConnectorSource.GOOGLE_DRIVE: "Google Drive",
        ConnectorSource.DROPBOX: "Dropbox",
        ConnectorSource.ONEDRIVE: "OneDrive",
        # Productivity & Collaboration
        ConnectorSource.NOTION: "Notion",
        ConnectorSource.CONFLUENCE: "Confluence",
        ConnectorSource.SLACK: "Slack",
        # Note-taking
        ConnectorSource.ONENOTE: "OneNote",
        # Academic / Research
        ConnectorSource.ZOTERO: "Zotero",
        # Other
        ConnectorSource.FILE: "File Upload",
        ConnectorSource.WEB: "Web Scraper",
        ConnectorSource.YOUTUBE: "YouTube",
        ConnectorSource.MCP: "MCP (Model Context Protocol)",
    }
    return display_names.get(source, source.value.replace("_", " ").title())


# Import and register connectors
# This happens at module load time to populate the registry.
# Each import runs in its own try/except so a missing optional dependency
# (e.g., google-api-python-client for Google Drive) degrades gracefully —
# the affected connector is skipped and the rest still register.
def _register_all_connectors():
    """Import and register all available connectors."""
    try:
        import src.main.connectors.google_drive.connector

        logger.debug("Google Drive connector loaded")
    except ImportError as e:
        logger.warning("⚠️ Google Drive connector not available: %s", e)

    try:
        import src.main.connectors.dropbox.connector

        logger.debug("Dropbox connector loaded")
    except ImportError as e:
        logger.warning("⚠️ Dropbox connector not available: %s", e)

    try:
        # SharePoint/OneDrive — the sharepoint package registers as ConnectorSource.ONEDRIVE
        import src.main.connectors.sharepoint.connector

        logger.debug("OneDrive connector loaded")
    except ImportError as e:
        logger.warning("⚠️ OneDrive connector not available: %s", e)

    try:
        import src.main.connectors.notion.connector

        logger.debug("Notion connector loaded")
    except ImportError as e:
        logger.warning("⚠️ Notion connector not available: %s", e)

    try:
        import src.main.connectors.confluence.connector

        logger.debug("Confluence connector loaded")
    except ImportError as e:
        logger.warning("⚠️ Confluence connector not available: %s", e)

    try:
        import src.main.connectors.slack.connector

        logger.debug("Slack connector loaded")
    except ImportError as e:
        logger.warning("⚠️ Slack connector not available: %s", e)

    try:
        import src.main.connectors.zotero.connector  # noqa: F401

        logger.debug("Zotero connector loaded")
    except ImportError as e:
        logger.warning("⚠️ Zotero connector not available: %s", e)

    logger.info("📋 Registered %s connectors", len(_CONNECTOR_REGISTRY))


# Auto-register all connectors on module import
_register_all_connectors()
