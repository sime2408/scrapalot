"""
User context data transfer objects for dependency injection.

This module provides user context information extracted from JWT tokens
and passed through FastAPI dependency injection to avoid repeated database queries.
"""

from pydantic import BaseModel, ConfigDict, Field


class UserContext(BaseModel):
    """
    User context information extracted from JWT and enriched with subscription data.

    This is passed via dependency injection to endpoints to provide:
    - User identification (user_id)
    - Subscription tier for quota enforcement
    - Role for authorization

    Avoids repeated database queries by extracting/caching this information
    during JWT verification.
    """

    user_id: str = Field(..., description="User UUID from JWT 'sub' claim")
    role: str | None = Field(None, description="User role from JWT (e.g., 'ADMIN', 'USER')")
    subscription_tier: str = Field(
        default="researcher",
        description="Subscription tier ('researcher', 'professional', 'enterprise')",
    )
    email: str | None = Field(None, description="User email from JWT")

    model_config = ConfigDict(
        frozen=False,  # Allow modification for tier enrichment
        json_schema_extra={
            "example": {
                "user_id": "2a060a41-a301-41f3-b79f-456194d5b748",
                "role": "USER",
                "subscription_tier": "professional",
                "email": "user@example.com",
            }
        },
    )
