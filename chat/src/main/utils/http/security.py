"""
Security utilities for FastAPI application.

This module provides security middleware, rate limiting, and malicious request detection.
"""

from collections import defaultdict
import re
import time
from typing import TYPE_CHECKING

from fastapi import Request
from starlette.responses import JSONResponse

if TYPE_CHECKING:
    from src.main.dto.user_context import UserContext

from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Rate limiting storage
request_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
blocked_ips: dict[str, float] = {}

# Cache for malicious patterns to avoid loading from config on every request
_cached_malicious_patterns: list[str] | None = None


def get_malicious_patterns() -> list[str]:
    """
    Get malicious patterns from configuration with caching.
    Returns a list of regex patterns to check against request paths.
    Patterns are loaded once and cached for performance.
    """
    global _cached_malicious_patterns

    # Return cached patterns if available
    if _cached_malicious_patterns is not None:
        return _cached_malicious_patterns

    try:
        security_config = resolved_config.get("security", {})
        patterns = security_config.get("malicious_patterns", [])

        # Cache the patterns for future requests
        _cached_malicious_patterns = patterns

        # Log only once when patterns are first loaded
        logger.info("🛡️ Loaded and cached %s malicious patterns from config", len(patterns))

        return patterns
    except Exception as e:
        logger.warning("Failed to load malicious patterns from config: %s", e)
        # Fallback to basic WordPress patterns if config fails
        fallback_patterns = [
            "/wp-admin/",
            "/wp-content/",
            "/wp-includes/",
            r"/wp-login\.php",
            r"/wp-config\.php",
            r"/xmlrpc\.php",
        ]

        # Cache the fallback patterns too
        _cached_malicious_patterns = fallback_patterns
        logger.info("🛡️ Using fallback patterns (%s patterns)", len(fallback_patterns))

        return fallback_patterns


def is_malicious_request(path: str) -> bool:
    """
    Check if a request path matches any malicious patterns from the configuration.

    Args:
        path: The request path to check

    Returns:
        True if the path matches a malicious pattern, False otherwise
    """
    try:
        patterns = get_malicious_patterns()
        path_lower = path.lower()

        for pattern in patterns:
            try:
                # Check if a pattern matches the path
                if re.search(pattern, path_lower):
                    logger.info("🚫 Malicious pattern detected: '%s' in path '%s'", pattern, path)
                    return True
            except re.error as e:
                logger.warning("Invalid regex pattern '%s': %s", pattern, e)
                # Fallback to simple string matching if regex fails
                if pattern.replace("\\", "") in path_lower:
                    logger.info("🚫 Malicious pattern detected (fallback): '%s' in path '%s'", pattern, path)
                    return True

        return False
    except Exception as e:
        logger.error("Error checking malicious patterns for path '%s': %s", path, e)
        # If pattern checking fails, allow the request to continue
        return False


async def security_middleware(request: Request, call_next):
    """
    Security middleware optimized for COST REDUCTION by immediately terminating
    requests to paths that don't belong to the scrapalot.app application.
    """
    # Get real client IP from X-Forwarded-For header (set by nginx proxy)
    # Falls back to direct connection IP if header not present
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        # X-Forwarded-For can contain multiple IPs: "client, proxy1, proxy2"
        # The first IP is the original client
        client_ip = forwarded_for.split(",")[0].strip()
    else:
        # noinspection PyUnresolvedReferences
        client_ip = request.client.host if request.client else "unknown"
    current_time = time.time()
    path = request.url.path.lower()

    # EXEMPT paths from malicious pattern checking
    # WebSocket connections handle their own authentication
    # API admin endpoints are protected by role-based auth
    exempt_paths = [
        "/ws",  # Socket.IO WebSocket
        "/stomp",  # STOMP WebSocket
        "/api/ws/notes",  # Note collaboration WebSocket
        "/api/v1/admin",  # Legitimate admin API endpoints (role-protected)
    ]

    # Check if the path starts with any exempt path
    if any(path.startswith(exempt_path) for exempt_path in exempt_paths):
        # Skip security middleware for WebSocket connections
        logger.debug("Bypassing security middleware for WebSocket path: %s", path)
        return await call_next(request)

    # IMMEDIATE TERMINATION: Check malicious patterns from configuration
    if is_malicious_request(request.url.path):
        # Log the blocked request with client IP
        logger.warning("🚫 SECURITY: Blocked malicious request from %s -> %s", client_ip, path)
        # Return 404 immediately - no further processing to save costs
        return JSONResponse(status_code=404, content={"detail": "Not Found"})

    # Get security configuration only for legitimate requests
    security_config = resolved_config.get("security", {})
    rate_config = security_config.get("rate_limiting", {})
    headers_config = security_config.get("headers", {})

    # Configuration values with defaults
    rate_limiting_enabled = rate_config.get("enabled", True)
    requests_per_minute = int(rate_config.get("requests_per_minute", 100))
    block_duration_minutes = int(rate_config.get("block_duration_minutes", 5))
    block_duration_seconds = block_duration_minutes * 60

    try:
        # EARLY TERMINATION: Check if IP is currently blocked (COST OPTIMIZATION)
        if client_ip in blocked_ips:
            if current_time - blocked_ips[client_ip] < block_duration_seconds:
                # Log with minimal overhead and terminate immediately
                logger.info("🚫 Blocked IP %s rejected early: %s", client_ip, path)
                # Return 404 immediately to avoid revealing the application structure and reduce processing
                return JSONResponse(status_code=404, content={"detail": "Not Found"})
            else:
                # Unblock IP after timeout
                del blocked_ips[client_ip]

        # Skip complex pattern matching - instant blocklist handles most attacks
        # Only do rate limiting for legitimate requests that passed the instant block
    except Exception as e:
        # Log any unexpected errors in malicious pattern detection
        logger.error("Error in malicious pattern detection for %s: %s", path, str(e))
        # Continue processing the request instead of failing

    # Rate limiting for legitimate requests (per minute) with safe type conversion
    if rate_limiting_enabled:
        minute_key = str(int(current_time // 60))
        try:
            current_count = request_counts[client_ip].get(minute_key, 0)
            # Ensure current_count is safely convertible to int
            if isinstance(current_count, str):
                # Try to convert string to int, fallback to 0 if invalid
                try:
                    current_count = int(current_count)
                except (ValueError, TypeError):
                    current_count = 0
            elif not isinstance(current_count, int):
                current_count = 0
            request_counts[client_ip][minute_key] = current_count + 1
        except (ValueError, TypeError) as e:
            logger.warning("Invalid rate limit count for IP %s, resetting counter: %s", client_ip, e)
            request_counts[client_ip][minute_key] = 1

        # Clean old entries (keep only last 5 minutes)
        current_minute = int(current_time // 60)
        for ip in list(request_counts.keys()):
            for minute in list(request_counts[ip].keys()):
                try:
                    minute_int = int(minute)
                    if current_minute - minute_int > 5:
                        del request_counts[ip][minute]
                except (ValueError, TypeError):
                    # Remove invalid minute keys
                    del request_counts[ip][minute]
            if not request_counts[ip]:
                del request_counts[ip]

        # Check rate limit with proper type safety
        try:
            current_requests_raw = request_counts[client_ip].get(minute_key, 0)
            # Ensure current_requests_raw is safely convertible to int
            if isinstance(current_requests_raw, str):
                # Try to convert string to int, fallback to 0 if invalid
                try:
                    current_requests = int(current_requests_raw)
                except (ValueError, TypeError):
                    current_requests = 0
            elif isinstance(current_requests_raw, int):
                current_requests = current_requests_raw
            else:
                current_requests = 0

            if current_requests > requests_per_minute:
                logger.warning("⚠️ Rate limit exceeded for IP %s: %s requests/min", client_ip, current_requests)
                blocked_ips[client_ip] = current_time
                return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})
        except (ValueError, TypeError) as e:
            # If we can't convert to int, reset the counter and allow the request
            logger.warning("Invalid request count for IP %s, resetting counter: %s", client_ip, e)
            request_counts[client_ip][minute_key] = 1

    # Process the request
    response = await call_next(request)

    # Add security headers from config
    if headers_config.get("x_content_type_options"):
        response.headers["X-Content-Type-Options"] = headers_config["x_content_type_options"]
    if headers_config.get("x_frame_options"):
        response.headers["X-Frame-Options"] = headers_config["x_frame_options"]
    if headers_config.get("x_xss_protection"):
        response.headers["X-XSS-Protection"] = headers_config["x_xss_protection"]
    if headers_config.get("referrer_policy"):
        response.headers["Referrer-Policy"] = headers_config["referrer_policy"]
    if headers_config.get("permissions_policy"):
        response.headers["Permissions-Policy"] = headers_config["permissions_policy"]

    # Hide server information if configured
    if headers_config.get("hide_server_header", True):
        if "Server" in response.headers:
            del response.headers["Server"]

    return response


async def log_authorization_header_middleware(request: Request, call_next):
    """Middleware to log and extract authorization headers for debugging."""
    target_path = "/llm-inference/download-progress-stream/"
    is_stream_path = request.url.path.startswith(target_path)

    # Exclude health check, polling, and system paths from auth logging to reduce noise
    health_paths = ["/health", "/websocket-test", "/favicon.ico"]
    polling_paths = ["/api/v1/jobs/active", "/api/v1/jobs/status"]
    is_health_path = any(request.url.path.startswith(path) for path in health_paths)
    is_polling_path = any(request.url.path.startswith(path) for path in polling_paths)

    auth_header = request.headers.get("Authorization")
    user_id = None

    if auth_header:
        # Log only the first part to avoid exposing full token in logs usually,
        # but for debugging this specific issue, let's log more (be careful in production)
        log_length = min(len(auth_header), 10)  # Log up to 10 chars for inspection

        # Extract user_id from a JWT token for logging purposes
        try:
            if auth_header.startswith("Bearer "):
                token = auth_header[7:]  # Remove 'Bearer ' prefix
                # noinspection PyPackageRequirements
                from jose import jwt

                from src.main.utils.auth.jwt import ALGORITHM, SECRET_KEY

                payload = jwt.decode(
                    token,
                    key=SECRET_KEY,
                    algorithms=[ALGORITHM],
                    options={
                        "verify_aud": False,
                        "verify_exp": False,
                    },  # Skip validation for logging
                )
                user_id = payload.get("sub")
                role = payload.get("role")

                # Store user_id and role in the request state
                request.state.user_id = user_id
                request.state.role = role

                # Fetch and cache subscription tier for this request
                # This avoids repeated database queries in downstream handlers
                try:
                    from src.main.config.database import SessionLocal
                    from src.main.utils.workspaces.quota import get_user_subscription_tier

                    db = SessionLocal()
                    try:
                        tier = get_user_subscription_tier(db, user_id or "")
                        request.state.subscription_tier = tier
                        # Reduced logging: only log on first fetch, not on cache hits
                        # logger.debug("Cached subscription tier '%s' for user %s", tier, user_id)
                    finally:
                        db.close()
                except Exception as tier_error:
                    logger.warning("Could not fetch subscription tier for user %s: %s", user_id, tier_error)
                    request.state.subscription_tier = "researcher"  # Default fallback

                # Also set context variable for async propagation
                from src.main.utils.core.logger import user_id_context

                user_id_context.set(user_id)

        except Exception as e3:
            logger.debug("Could not extract user_id from token for logging: %s", str(e3))

        # Only log auth headers for non-polling paths to reduce noise
        if not is_polling_path:
            logger.debug(
                "Received Authorization Header (path: %s, user_id: %s): %s...",
                request.url.path,
                user_id or "unknown",
                auth_header[:log_length],
            )
    else:
        # Only log 'No Authorization Header' if it's NOT a stream path, health path, or polling path
        if not is_stream_path and not is_health_path and not is_polling_path:
            logger.debug("No Authorization Header received (path: %s)", request.url.path)
        elif is_stream_path:
            # Log specifically that we are allowing the stream path without auth
            logger.debug(
                "Allowing stream path %s without Authorization Header.",
                request.url.path,
            )
        # Health and polling paths are silently allowed without logging

    # No actual blocking logic here, proceed
    response = await call_next(request)
    return response


async def get_user_context_from_request(request: Request) -> "UserContext | None":
    """
    Extract UserContext from request state (populated by security middleware).

    This function provides dependency injection for user context information,
    including user_id and subscription_tier, extracted from JWT during authentication.

    Args:
        request: FastAPI Request object

    Returns:
        UserContext with user_id and subscription_tier, or None if not authenticated

    Usage:
        @app.get("/endpoint")
        async def endpoint(user_ctx: UserContext = Depends(get_user_context_from_request)):
            # Use user_ctx.user_id and user_ctx.subscription_tier
            pass
    """
    from src.main.dto.user_context import UserContext

    # Check if user_id was set by middleware
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return None

    # Get subscription tier (will be cached in request state by middleware)
    subscription_tier = getattr(request.state, "subscription_tier", "researcher")

    # Extract role from JWT if available
    role = getattr(request.state, "role", None)

    # noinspection PyArgumentList
    return UserContext(
        user_id=user_id,
        role=role,
        subscription_tier=subscription_tier,
    )
