"""
Centralized utility for default user settings configuration.
This module provides consistent default settings across the application.
"""

from typing import Any


def get_default_general_settings() -> dict[str, Any]:
    """
    Get the default general settings configuration.

    These settings match the structure in settings.tsx saveGeneralSettingsStable function
    and are used both in user creation and database migrations.

    Returns:
        Dict containing default general settings
    """
    return {
        "auto_title_generate": True,  # Corresponds to "LOCAL" in frontend
        "rendering_engine": "new",
        "thinking_tokens": True,
        "rendering_modules": ["MARKDOWN", "GITHUB_MARKDOWN", "CODE_HIGHLIGHTING", "COLLAPSE_TAGS"],
        "links_in_chat": True,
        "proxy": "",
        "theme": "system",
        "theme_accent": "blue",
        "font_style": "sans",
        "theme_code": "github-dark",
        "font_size": "14",
        "rag_strategy": "EnhancedTriModalOrchestrator",
        "language": "en",
    }


def get_default_workspace_name() -> str:
    """Get the default workspace name for new users."""
    return "My Workspace"


def get_default_collection_name() -> str:
    """Get the default collection name for new users."""
    return "General"
