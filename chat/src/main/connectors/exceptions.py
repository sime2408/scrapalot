"""Connector-related exceptions."""


class ConnectorError(Exception):
    """Base exception for connector errors."""


class ConnectorMissingCredentialError(ConnectorError):
    """Raised when connector credentials are missing or invalid."""

    def __init__(self, connector_name: str):
        connector_name = connector_name or "Unknown"
        super().__init__(f"{connector_name} connector missing credentials, was load_credentials called?")


class ConnectorValidationError(ConnectorError):
    """Raised when connector configuration is invalid."""


class ConnectorAuthError(ConnectorError):
    """Raised when connector authentication fails."""


class ConnectorRateLimitError(ConnectorError):
    """Raised when connector hits rate limit."""


class ConnectorNotFoundError(ConnectorError):
    """Raised when requested resource is not found."""


class ConnectorPermissionError(ConnectorError):
    """Raised when connector lacks permissions for an operation."""
