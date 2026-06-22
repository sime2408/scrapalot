"""
OpenAI API Retry Utilities

This module provides factory functions for creating ChatOpenAI instances with
appropriate retry configuration. The OpenAI SDK's built-in retry mechanism handles
exponential backoff with jitter for rate limit and transient errors.

Utility functions for classifying OpenAI API errors (rate limit vs quota exceeded)
are also provided for use by other modules that need custom error handling.
"""

from langchain_openai import ChatOpenAI
import openai

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def is_rate_limit_error(exception: Exception) -> bool:
    """
    Check if the exception is a rate limit error (429).

    Args:
        exception: The exception to check

    Returns:
        True if it's a rate limit error, False otherwise
    """
    if isinstance(exception, openai.RateLimitError):
        return True

    # Check for HTTP status code 429 in other exception types
    # noinspection PyUnresolvedReferences
    if hasattr(exception, "status_code") and exception.status_code == 429:
        return True

    # Check for 429 in error message
    error_msg = str(exception).lower()
    return "429" in error_msg or "too many requests" in error_msg or "rate limit" in error_msg


def is_quota_exceeded_error(exception: Exception) -> bool:
    """
    Check if the exception is a quota exceeded error (permanent issue).

    Args:
        exception: The exception to check

    Returns:
        True if it's a quota exceeded error, False otherwise
    """
    error_msg = str(exception).lower()
    quota_indicators = ["insufficient_quota", "quota exceeded", "credit", "billing", "insufficient credits"]

    return any(indicator in error_msg for indicator in quota_indicators)


def should_retry_openai_error(exception: Exception) -> bool:
    """
    Determine if an OpenAI API error should be retried.

    Args:
        exception: The exception to evaluate

    Returns:
        True if the error should be retried, False otherwise
    """
    # Don't retry quota/billing issues - these require manual intervention
    if is_quota_exceeded_error(exception):
        logger.warning("Quota exceeded error detected, will not retry: %s", str(exception))
        return False

    # Retry rate limit errors
    if is_rate_limit_error(exception):
        logger.info("Rate limit error detected, will retry with backoff: %s", str(exception))
        return True

    # Retry certain connection/timeout errors
    if isinstance(exception, (openai.APIConnectionError, openai.APITimeoutError)):
        logger.info("Connection/timeout error detected, will retry: %s", str(exception))
        return True

    # Don't retry other types of errors
    return False


def get_retry_after_delay(exception: Exception) -> float | None:
    """
    Extract Retry-After header value from OpenAI API error response.

    Args:
        exception: The exception containing response headers

    Returns:
        Delay in seconds from Retry-After header, or None if not present
    """
    try:
        if hasattr(exception, "response") and exception.response:
            headers = exception.response.headers
            retry_after = headers.get("Retry-After") or headers.get("retry-after")

            if retry_after:
                # Retry-After can be in seconds or HTTP-date format
                try:
                    return float(retry_after)
                except ValueError:
                    # HTTP-date format not handled for simplicity
                    logger.debug("Could not parse Retry-After header: %s", retry_after)

        # Check for retry-after-ms header (OpenAI specific)
        if hasattr(exception, "response") and exception.response:
            headers = exception.response.headers
            retry_after_ms = headers.get("retry-after-ms")
            if retry_after_ms:
                try:
                    return float(retry_after_ms) / 1000.0  # Convert ms to seconds
                except ValueError:
                    logger.debug("Could not parse retry-after-ms header: %s", retry_after_ms)

    except Exception as e:
        logger.debug("Error extracting Retry-After header: %s", str(e))

    return None


def create_openai_with_enhanced_retry(model_name: str, **kwargs) -> ChatOpenAI:
    """
    Create a ChatOpenAI instance with enhanced retry configuration.

    Returns a proper ChatOpenAI instance (which is a LangChain Runnable) so it can
    be used in LCEL chains (e.g., prompt | llm | parser). The OpenAI SDK's built-in
    retry mechanism handles exponential backoff with jitter automatically.

    Args:
        model_name: Name of the OpenAI model
        **kwargs: Additional arguments for ChatOpenAI

    Returns:
        ChatOpenAI instance with retry configuration
    """
    # Remove internal retry parameters to set our own
    clean_kwargs = {k: v for k, v in kwargs.items() if k not in ["max_retries", "timeout"]}

    # Configure retry parameters using the OpenAI SDK's built-in retry mechanism,
    # which supports exponential backoff with jitter for rate limit and transient errors
    enhanced_kwargs = {
        **clean_kwargs,
        "max_retries": 5,  # 5 retries with built-in exponential backoff
        "timeout": kwargs.get("timeout", 120.0),
    }

    logger.debug("Creating ChatOpenAI with enhanced retry logic (max_retries=5)")
    return ChatOpenAI(model=model_name, **enhanced_kwargs)
