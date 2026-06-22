"""
Base repository class using SQLModel for type-safe database operations.

This module provides a modern, type-safe alternative to raw SQL queries
using SQLModel's Pydantic integration and SQLAlchemy 2.0 features.
"""

from typing import Any, Generic, TypeVar
from uuid import UUID

from sqlalchemy import asc, desc
from sqlalchemy.exc import IntegrityError, NoResultFound
from sqlmodel import Session, SQLModel, func, select, text

from src.main.config.database import get_sqlmodel_session
from src.main.utils.core.logger import get_logger

T = TypeVar("T", bound=SQLModel)

logger = get_logger(__name__)


class BaseRepository(Generic[T]):
    """
    Generic base repository providing common database operations using SQLModel.

    This class replaces manual SQL queries with type-safe SQLModel operations
    while maintaining compatibility with existing patterns.
    """

    def __init__(self, model: type[T], session: Session = None):
        """
        Initialize repository with a SQLModel class.

        Args:
            model: The SQLModel class for this repository
            session: Optional SQLModel session (will create one if not provided)
        """
        self.model = model
        self._session = session

    @property
    def session(self) -> Session:
        """Get or create a SQLModel session"""
        if self._session is None:
            self._session = get_sqlmodel_session()
        return self._session

    def create(self, obj: T) -> T:
        """
        Create a new record in the database.

        Args:
            obj: SQLModel instance to create

        Returns:
            The created instance with updated fields (id, timestamps, etc.)
        """
        try:
            self.session.add(obj)
            self.session.commit()
            self.session.refresh(obj)
            # noinspection PyUnresolvedReferences
            logger.debug("Created %s with id %s", self.model.__name__, obj.id)
            return obj
        except IntegrityError as e:
            self.session.rollback()
            logger.error("Failed to create %s: %s", self.model.__name__, str(e))
            raise
        except Exception as e:
            self.session.rollback()
            logger.error("Unexpected error creating %s: %s", self.model.__name__, str(e))
            raise

    def get_by_id(self, record_id: UUID) -> T | None:
        """
        Get a record by its ID.

        Args:
            record_id: UUID of the record

        Returns:
            The record if found, None otherwise
        """
        try:
            # noinspection PyUnresolvedReferences
            statement = select(self.model).where(self.model.id == record_id)
            result = self.session.exec(statement).first()
            return result
        except Exception as e:
            logger.error("Error fetching %s by id %s: %s", self.model.__name__, record_id, str(e))
            return None

    def get_by_id_or_raise(self, record_id: UUID) -> T:
        """
        Get a record by its ID or raise an exception if not found.

        Args:
            record_id: UUID of the record

        Returns:
            The record

        Raises:
            NoResultFound: If no record found with the given ID
        """
        result = self.get_by_id(record_id)
        if result is None:
            raise NoResultFound(f"No {self.model.__name__} found with id {record_id}")
        return result

    def get_all(self, limit: int | None = None, offset: int | None = None) -> list[T]:
        """
        Get all records with optional pagination.

        Args:
            limit: Maximum number of records to return
            offset: Number of records to skip

        Returns:
            List of records
        """
        try:
            statement = select(self.model)

            if offset is not None:
                statement = statement.offset(offset)
            if limit is not None:
                statement = statement.limit(limit)

            results = self.session.exec(statement).all()
            return list(results)
        except Exception as e:
            logger.error("Error fetching all %s: %s", self.model.__name__, str(e))
            return []

    def get_by_field(self, field: str, value: Any, single: bool = True) -> T | None | list[T]:
        """
        Get records by a specific field value.

        Args:
            field: Field name to filter by
            value: Value to match
            single: If True, return single record; if False, return list

        Returns:
            Single record (if single=True) or list of records
        """
        try:
            field_attr = getattr(self.model, field)
            statement = select(self.model).where(field_attr == value)

            if single:
                result = self.session.exec(statement).first()
                return result
            else:
                results = self.session.exec(statement).all()
                return list(results)
        except Exception as e:
            logger.error("Error fetching %s by %s=%s: %s", self.model.__name__, field, value, str(e))
            return None if single else []

    def update(self, record_id: UUID, **kwargs) -> T | None:
        """
        Update a record by ID with the provided fields.

        Args:
            record_id: UUID of the record to update
            **kwargs: Field names and values to update

        Returns:
            The updated record if found and updated, None otherwise
        """
        try:
            obj = self.get_by_id(record_id)
            if obj is None:
                logger.warning("Cannot update %s with id %s: not found", self.model.__name__, record_id)
                return None

            for field, value in kwargs.items():
                if hasattr(obj, field):
                    setattr(obj, field, value)
                else:
                    logger.warning("Field %s does not exist on %s", field, self.model.__name__)

            self.session.add(obj)
            self.session.commit()
            self.session.refresh(obj)
            logger.debug("Updated %s with id %s", self.model.__name__, record_id)
            return obj
        except Exception as e:
            self.session.rollback()
            logger.error("Error updating %s with id %s: %s", self.model.__name__, record_id, str(e))
            return None

    def delete(self, record_id: UUID) -> bool:
        """
        Delete a record by ID.

        Args:
            record_id: UUID of the record to delete

        Returns:
            True if deleted, False if not found or error occurred
        """
        try:
            obj = self.get_by_id(record_id)
            if obj is None:
                logger.warning("Cannot delete %s with id %s: not found", self.model.__name__, record_id)
                return False

            self.session.delete(obj)
            self.session.commit()
            logger.debug("Deleted %s with id %s", self.model.__name__, record_id)
            return True
        except Exception as e:
            self.session.rollback()
            logger.error("Error deleting %s with id %s: %s", self.model.__name__, record_id, str(e))
            return False

    def count(self, **filters) -> int:
        """
        Count records with optional filters.

        Args:
            **filters: Field names and values to filter by

        Returns:
            Number of matching records
        """
        try:
            # noinspection PyUnresolvedReferences
            statement = select(func.count(self.model.id))

            for field, value in filters.items():
                if hasattr(self.model, field):
                    field_attr = getattr(self.model, field)
                    statement = statement.where(field_attr == value)

            result = self.session.exec(statement).one()
            return result
        except Exception as e:
            logger.error("Error counting %s: %s", self.model.__name__, str(e))
            return 0

    def exists(self, record_id: UUID) -> bool:
        """
        Check if a record exists by ID.

        Args:
            record_id: UUID of the record

        Returns:
            True if exists, False otherwise
        """
        try:
            # noinspection PyUnresolvedReferences
            statement = select(func.count(self.model.id)).where(self.model.id == record_id)
            result = self.session.exec(statement).one()
            return result > 0
        except Exception as e:
            logger.error("Error checking existence of %s with id %s: %s", self.model.__name__, record_id, str(e))
            return False

    def find_by_criteria(
        self,
        criteria: dict[str, Any],
        limit: int | None = None,
        offset: int | None = None,
        order_by: str | None = None,
        order_desc: bool = False,
    ) -> list[T]:
        """
        Find records by multiple criteria with sorting and pagination.

        Args:
            criteria: Dictionary of field names and values to match
            limit: Maximum number of records to return
            offset: Number of records to skip
            order_by: Field name to order by
            order_desc: If True, order descending; if False, ascending

        Returns:
            List of matching records
        """
        try:
            statement = select(self.model)

            # Apply criteria
            for field, value in criteria.items():
                if hasattr(self.model, field):
                    field_attr = getattr(self.model, field)
                    if isinstance(value, list):
                        statement = statement.where(field_attr.in_(value))
                    else:
                        statement = statement.where(field_attr == value)

            # Apply ordering
            if order_by and hasattr(self.model, order_by):
                order_field = getattr(self.model, order_by)
                if order_desc:
                    statement = statement.order_by(desc(order_field))
                else:
                    statement = statement.order_by(asc(order_field))

            # Apply pagination
            if offset is not None:
                statement = statement.offset(offset)
            if limit is not None:
                statement = statement.limit(limit)

            results = self.session.exec(statement).all()
            return list(results)
        except Exception as e:
            logger.error("Error finding %s by criteria: %s", self.model.__name__, str(e))
            return []

    def execute_raw_sql(self, sql: str, params: dict[str, Any] | None = None) -> Any:
        """
        Execute raw SQL for complex queries not easily expressed in SQLModel.

        Args:
            sql: Raw SQL query
            params: Optional parameters for the query

        Returns:
            Query result
        """
        try:
            statement = text(sql)
            result = self.session.exec(statement, params=params or {})
            return result
        except Exception as e:
            logger.error("Error executing raw SQL: %s", str(e))
            raise

    def bulk_create(self, objects: list[T]) -> list[T]:
        """
        Create multiple records in a single transaction.

        Args:
            objects: List of SQLModel instances to create

        Returns:
            List of created instances
        """
        try:
            self.session.add_all(objects)
            self.session.commit()
            for obj in objects:
                self.session.refresh(obj)
            logger.debug("Bulk created %d %s records", len(objects), self.model.__name__)
            return objects
        except Exception as e:
            self.session.rollback()
            logger.error("Error bulk creating %s: %s", self.model.__name__, str(e))
            raise

    def bulk_update(self, updates: list[dict[str, Any]]) -> int:
        """
        Update multiple records in a single transaction.
        Each update dict must contain 'id' field and the fields to update.

        Args:
            updates: List of dictionaries with 'id' and fields to update

        Returns:
            Number of records updated
        """
        try:
            updated_count = 0
            for update_data in updates:
                record_id = update_data.pop("id", None)
                if record_id:
                    obj = self.get_by_id(record_id)
                    if obj:
                        for field, value in update_data.items():
                            if hasattr(obj, field):
                                setattr(obj, field, value)
                        self.session.add(obj)
                        updated_count += 1

            self.session.commit()
            logger.debug("Bulk updated %d %s records", updated_count, self.model.__name__)
            return updated_count
        except Exception as e:
            self.session.rollback()
            logger.error("Error bulk updating %s: %s", self.model.__name__, str(e))
            return 0

    def close(self):
        """Close the database session"""
        if self._session:
            self._session.close()

    def __enter__(self):
        """Context manager entry"""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit"""
        self.close()
