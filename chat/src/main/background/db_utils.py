# Backward compatibility shim — canonical location: src.main.utils.database.db_utils
# db_session() is now consolidated with get_db_session() in utils/database/db_utils.py
from src.main.utils.database.db_utils import db_session  # noqa: F401
