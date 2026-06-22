"""
Database utilities sub-package.

Groups session management, SQLModel helpers, and DAO base classes.
Consolidates the duplicate db_session context manager from background/db_utils.py.

Modules:
    db_utils           - Session context managers (get_db_session, db_session),
                         execute_db_operation, get_or_create_server_setting
    sqlmodel_utilities - SQLModelLLMUtils: type-safe model/provider queries via SQLModel
    dao_base           - BaseDAO: reusable SQLAlchemy CRUD base class
"""
