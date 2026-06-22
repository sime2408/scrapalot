"""
Error codes for frontend-backend alignment.

These codes map to translation keys in the frontend i18n system.
Translation path: general.errors.{error_code}

For status codes, see status_codes.py
"""

from enum import Enum


class ErrorCode(str, Enum):
    """
    Error codes that align with frontend translation keys.

    Frontend translation path: general.errors.{error_code}
    Example: ErrorCode.WEB_SEARCH_DISABLED -> general.errors.webSearchDisabled
    """

    # General errors
    FAILED = "failed"
    LOAD_FAILED = "loadFailed"
    SAVE_FAILED = "saveFailed"
    DELETE_FAILED = "deleteFailed"
    UPDATE_FAILED = "updateFailed"
    CREATE_FAILED = "createFailed"
    PROCESS_FAILED = "processFailed"

    # Network errors
    REQUEST_TIMEOUT = "requestTimeout"
    NETWORK_ERROR = "networkError"
    CONNECTION_ERROR = "connectionError"
    SYSTEM_ERROR = "system_error"

    # Web search specific errors
    WEB_SEARCH_DISABLED = "webSearchDisabled"
    WEB_SEARCH_NOT_ENABLED_REQUEST = "webSearchNotEnabledRequest"
    WEB_SEARCH_PROVIDER_ERROR = "webSearchProviderError"
    WEB_SEARCH_AGENT_ERROR = "webSearchAgentError"
    WEB_SEARCH_PROCESSING_ERROR = "webSearchProcessingError"

    # Authentication errors
    AUTHENTICATION_FAILED = "authenticationFailed"
    AUTHENTICATION_REQUIRED = "authenticationRequired"
    SESSION_EXPIRED = "sessionExpired"

    # Permission errors
    PERMISSION_DENIED = "permissionDenied"
    WORKSPACE_ACCESS_DENIED = "workspaceAccessDenied"

    # Resource errors
    RESOURCE_NOT_FOUND = "resourceNotFound"
    RESOURCE_UNAVAILABLE = "resourceUnavailable"

    # Validation errors
    INVALID_INPUT = "invalidInput"
    INVALID_CONFIGURATION = "invalidConfiguration"

    # Service errors
    SERVICE_UNAVAILABLE = "serviceUnavailable"
    BACKEND_UNAVAILABLE = "backendUnavailable"

    # Deep research
    RESEARCH_ALREADY_ACTIVE = "researchAlreadyActive"


def get_error_message_key(error_code: ErrorCode) -> str:
    """Get the full translation key for an error code."""
    return f"general.errors.{error_code.value}"
