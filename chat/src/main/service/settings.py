from typing import Any

from sqlalchemy import and_
from sqlalchemy.orm import Session

from src.main.models.sqlmodel_models import UserSetting
from src.main.models.sqlmodel_settings import ServerSetting
from src.main.utils.core.logger import get_logger
from src.main.utils.rag.strategies import DEFAULT_RAG_STRATEGY

logger = get_logger(__name__)


async def get_user_settings(user_id: str, db: Session) -> dict[str, Any]:
    """
    Get user settings by user ID string.

    Args:
        user_id: User ID as string
        db: Database session

    Returns:
        Dictionary containing user settings with fallback to server defaults
    """
    # Fetch general settings (key-value pairs)
    # noinspection PyTypeChecker
    general_settings_db = db.query(UserSetting).filter(and_(UserSetting.user_id == user_id)).all()

    general_settings_dict = {}
    for setting in general_settings_db:
        # Extract the actual value if stored within a dict like {"value": ...}.
        # SOME settings carry per-setting flag siblings ALONGSIDE the wrapped
        # `value` block, e.g.:
        #
        #     {"value": {"splitter_type": "...", "chunk_size": 768, ...},
        #      "ocr_enabled": true}
        #
        # The old strip-only logic returned just `setting_value["value"]`,
        # silently dropping the `ocr_enabled` sibling (and any other top-level
        # flags). Downstream code that did
        # `user_settings["document_processing"]["ocr_enabled"]` always got
        # `None` → fell back to the default `False` → every scanned PDF
        # landed in `errorScannedPdfOcrDeferred` regardless of what the
        # admin UI showed. Now: when `value` is a dict, merge sibling
        # top-level keys into it (sibling-wins-only-if-absent so the
        # wrapped value retains priority).
        setting_value = setting.setting_value
        if isinstance(setting_value, dict) and "value" in setting_value:
            unwrapped = setting_value["value"]
            if isinstance(unwrapped, dict):
                for sibling_key, sibling_val in setting_value.items():
                    if sibling_key != "value" and sibling_key not in unwrapped:
                        unwrapped[sibling_key] = sibling_val
            general_settings_dict[setting.setting_key] = unwrapped
        else:
            general_settings_dict[setting.setting_key] = setting_value

    # Extract individual values from settings_general to avoid duplication
    settings_general = general_settings_dict.get("settings_general", {})

    # If no user-specific general settings exist, check for server defaults
    if not settings_general:
        # Try to get server default general settings
        # noinspection PyTypeChecker
        server_default = db.query(ServerSetting).filter(ServerSetting.setting_key == "default_general_settings").first()
        if server_default and server_default.setting_value:
            logger.info("Using server default general settings for user %s", user_id)
            settings_general = server_default.setting_value

    # Process settings_general if it exists
    if isinstance(settings_general, dict):
        # Extract all general settings as top-level keys for easier access
        for key, value in settings_general.items():
            if key not in general_settings_dict:
                general_settings_dict[key] = value

    # Remove the nested settings_general object since we've flattened it to the top-level keys
    general_settings_dict.pop("settings_general", None)

    # Set default RAG strategy if not present in either location
    if "rag_strategy" not in general_settings_dict:
        general_settings_dict["rag_strategy"] = DEFAULT_RAG_STRATEGY
        logger.info("User %s has no rag_strategy set, using default: %s", user_id, DEFAULT_RAG_STRATEGY)
    # Set default language if not present
    if "language" not in general_settings_dict:
        general_settings_dict["language"] = "en"

    return general_settings_dict
