"""
Service layer for user settings management using pure key - value approach.

This service provides a clean interface for managing user settings stored
as key - value pairs in the database. Each setting is stored as a separate row.
"""

from typing import Any
from uuid import UUID

from sqlalchemy import and_
from sqlalchemy.orm import Session

from src.main.models.sqlmodel_models import UserSetting
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class UserSettingsService:
    """Service for managing user settings with pure key-value approach"""

    def __init__(self, db: Session):
        self.db = db

    def get_setting(self, user_id: str | UUID | None, setting_key: str) -> Any | None:
        """
        Get a single setting value by key for a user.

        Args:
                user_id: User ID (string, UUID, or None for system defaults)
                setting_key: The setting key to retrieve

        Returns:
                The setting value or None if not found
        """
        # Handle None user_id for system defaults (user_id IS NULL)
        if user_id is None:
            # noinspection PyTypeChecker
            setting = self.db.query(UserSetting).filter(and_(UserSetting.user_id.is_(None), UserSetting.setting_key == setting_key)).first()
        else:
            # noinspection PyTypeChecker
            setting = (
                self.db.query(UserSetting)
                # noinspection PyTypeChecker
                .filter(and_(UserSetting.user_id == str(user_id), UserSetting.setting_key == setting_key))
                .first()
            )

        return setting.setting_value if setting else None

    def set_setting(self, user_id: str | UUID, setting_key: str, setting_value: Any) -> UserSetting:
        """
        Set a setting value for a user (create or update).

        Args:
                user_id: User ID (string or UUID)
                setting_key: The setting key
                setting_value: The value to store

        Returns:
                The UserSetting instance
        """
        # Check if setting exists
        # noinspection PyTypeChecker
        setting = (
            self.db.query(UserSetting)
            # noinspection PyTypeChecker
            .filter(and_(UserSetting.user_id == str(user_id), UserSetting.setting_key == setting_key))
            .first()
        )

        if setting:
            # Update existing setting
            setting.setting_value = setting_value
            logger.debug("Updated setting %s for user %s", setting_key, user_id)
        else:
            # Create new setting
            setting = UserSetting(user_id=str(user_id), setting_key=setting_key, setting_value=setting_value)
            self.db.add(setting)
            logger.debug("Created new setting %s for user %s", setting_key, user_id)

        self.db.commit()
        self.db.refresh(setting)
        return setting

    def get_all_settings(self, user_id: str | UUID) -> dict[str, Any]:
        """
        Get all settings for a user as a dictionary.

        Args:
                user_id: User ID (string or UUID)

        Returns:
                Dictionary mapping setting keys to values
        """
        # noinspection PyTypeChecker
        settings = self.db.query(UserSetting).filter(UserSetting.user_id == str(user_id)).all()

        return {setting.setting_key: setting.setting_value for setting in settings}

    def set_multiple_settings(self, user_id: str | UUID, settings: dict[str, Any]) -> list[UserSetting]:
        """
        Set multiple settings for a user at once.

        Args:
                user_id: User ID (string or UUID)
                settings: Dictionary of setting key - value pairs

        Returns:
                List of UserSetting instances
        """
        result = []
        for key, value in settings.items():
            setting = self.set_setting(user_id, key, value)
            result.append(setting)
        return result

    def delete_setting(self, user_id: str | UUID, setting_key: str) -> bool:
        """
        Delete a setting for a user.

        Args:
                user_id: User ID (string or UUID)
                setting_key: The setting key to delete

        Returns:
                True if setting was deleted, False if not found
        """
        # noinspection PyTypeChecker
        setting = (
            self.db.query(UserSetting)
            # noinspection PyTypeChecker
            .filter(and_(UserSetting.user_id == str(user_id), UserSetting.setting_key == setting_key))
            .first()
        )

        if setting:
            self.db.delete(setting)
            self.db.commit()
            logger.debug("Deleted setting %s for user %s", setting_key, user_id)
            return True

        return False

    def get_settings_by_prefix(self, user_id: str | UUID, prefix: str) -> dict[str, Any]:
        """
        Get all settings that start with a given prefix.

        Args:
                user_id: User ID (string or UUID)
                prefix: The prefix to filter by

        Returns:
                Dictionary mapping setting keys to values
        """
        # noinspection PyTypeChecker
        settings = (
            self.db.query(UserSetting)
            # noinspection PyTypeChecker,PyUnresolvedReferences
            .filter(and_(UserSetting.user_id == str(user_id), UserSetting.setting_key.like(f"{prefix}%")))
            .all()
        )

        return {setting.setting_key: setting.setting_value for setting in settings}

    # Convenience methods for common setting groups

    def get_general_settings(self, user_id: str | UUID | None) -> dict[str, Any]:
        """Get general/UI settings for a user, with fallback to server defaults."""
        # First try to get user-specific settings (or system defaults if user_id is None)
        general_setting = self.get_setting(user_id, "settings_general")

        if general_setting:
            # noinspection PyTypeChecker
            return dict(general_setting)

        # If no user settings exist, fall back to server defaults
        from src.main.models.sqlmodel_settings import ServerSetting

        # noinspection PyTypeChecker
        server_default = (
            # noinspection PyTypeChecker
            self.db.query(ServerSetting).filter(ServerSetting.setting_key == "default_general_settings").first()
        )

        if server_default and server_default.setting_value:
            logger.info("Using server default general settings for user %s", user_id)
            return server_default.setting_value

        # Final fallback to empty dict
        logger.warning("No general settings found for user %s and no server defaults available", user_id)
        return {}

    def set_general_settings(self, user_id: str | UUID, settings: dict[str, Any]) -> UserSetting:
        """Set general/UI settings for a user."""
        return self.set_setting(user_id, "settings_general", settings)

    def get_model_settings(self, user_id: str | UUID, chat_id: str | None = None) -> dict[str, Any]:
        """Get model settings for a user, optionally chat-specific."""
        if chat_id:
            setting_key = f"model_settings:{chat_id}"
            chat_settings = self.get_setting(user_id, setting_key)
            if chat_settings:
                # noinspection PyTypeChecker
                return dict(chat_settings)

        # Fall back to general model settings
        return self.get_setting(user_id, "model_settings") or {}

    def set_model_settings(self, user_id: str | UUID, settings: dict[str, Any], chat_id: str | None = None) -> UserSetting:
        """Set model settings for a user, optionally chat-specific."""
        setting_key = "model_settings" if not chat_id else f"model_settings:{chat_id}"
        return self.set_setting(user_id, setting_key, settings)

    def get_embedding_settings(self, user_id: str | UUID) -> dict[str, Any]:
        """Get embedding settings for a user."""
        return self.get_setting(user_id, "document_embedding_settings") or {}

    def set_embedding_settings(self, user_id: str | UUID, settings: dict[str, Any]) -> UserSetting:
        """Set embedding settings for a user."""
        return self.set_setting(user_id, "document_embedding_settings", settings)

    def get_prompt_templates(self, user_id: str | UUID) -> dict[str, Any]:
        """Get prompt templates for a user."""
        return self.get_setting(user_id, "prompt_templates") or {"templates": []}

    def set_prompt_templates(self, user_id: str | UUID, templates: dict[str, Any]) -> UserSetting:
        """Set prompt templates for a user."""
        return self.set_setting(user_id, "prompt_templates", templates)


# Factory function for dependency injection


def get_user_settings_service(db: Session) -> UserSettingsService:
    """Factory function to create UserSettingsService instance."""
    return UserSettingsService(db)
