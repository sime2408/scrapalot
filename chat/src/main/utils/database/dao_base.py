"""
Base DAO utilities for common database operations.

This module provides a reusable base DAO class that consolidates
common database operations shared across multiple DAO implementations.
"""

from typing import Any

from sqlalchemy.orm import Session

from src.main.models.sqlmodel_base import BaseModel
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class BaseDAO:
    """Base DAO class with common database operations."""

    def __init__(self, session: Session, model: type[BaseModel]):
        """
        Initialize the DAO with a database session and model.

        Args:
            session: SQLAlchemy database session
            model: SQLAlchemy model class
        """
        self.session = session
        self.model = model

    def get(self, _id: Any) -> BaseModel | None:
        """
        Get a single record by ID.

        Args:
            _id: Primary key value

        Returns:
            Model instance or None if not found
        """
        return self.session.query(self.model).get(_id)

    def get_by_id(self, _id: Any) -> BaseModel | None:
        """
        Alias for get() method for compatibility.

        Args:
            _id: Primary key value

        Returns:
            Model instance or None if not found
        """
        return self.get(_id)

    def get_all(self) -> list[BaseModel]:
        """
        Get all records.

        Returns:
            List of all model instances
        """
        return self.session.query(self.model).all()

    def create(self, **kwargs) -> BaseModel:
        """
        Create a new record.

        Args:
            **kwargs: Field values for the new record

        Returns:
            Created model instance
        """
        obj = self.model(**kwargs)
        self.session.add(obj)
        self.session.commit()
        self.session.refresh(obj)
        return obj

    def update(self, _id: Any, **kwargs) -> BaseModel | None:
        """
        Update an existing record.

        Args:
            _id: Primary key value
            **kwargs: Field values to update

        Returns:
            Updated model instance or None if not found
        """
        obj = self.get(_id)
        if obj:
            for key, value in kwargs.items():
                setattr(obj, key, value)
            self.session.commit()
            self.session.refresh(obj)
        return obj

    def delete(self, _id: Any) -> BaseModel | None:
        """
        Delete a record by ID.

        Args:
            _id: Primary key value

        Returns:
            Deleted model instance or None if not found
        """
        obj = self.get(_id)
        if obj:
            self.session.delete(obj)
            self.session.commit()
        return obj

    def get_or_create(self, **kwargs) -> BaseModel:
        """
        Get an existing record or create a new one.

        Args:
            **kwargs: Field values to search for or create with

        Returns:
            Existing or newly created model instance
        """
        obj = self.session.query(self.model).filter_by(**kwargs).first()
        if not obj:
            obj = self.create(**kwargs)
        return obj

    def get_all_by_user(self, user_id: Any) -> list[BaseModel]:
        """
        Get all records for a specific user.

        Args:
            user_id: User ID to filter by

        Returns:
            List of model instances for the user
        """
        # noinspection PyTypeChecker
        return self.session.query(self.model).filter_by(user_id=user_id).all()

    def get_by_name(self, name: str) -> BaseModel | None:
        """
        Get a record by name (assumes model has a name field).

        Args:
            name: Name to search for

        Returns:
            Model instance or None if not found
        """
        # Try common name field variations
        name_fields = ["name", "conversation_name", "title"]

        for field in name_fields:
            if hasattr(self.model, field):
                # noinspection PyTypeChecker
                return self.session.query(self.model).filter_by(**{field: name}).first()

        logger.warning("Model %s does not have a recognized name field", self.model.__name__)
        return None

    def get_one(self, **kwargs) -> BaseModel | None:
        """
        Get a single item by filtering with multiple criteria.

        Args:
            **kwargs: Filter criteria as key-value pairs

        Returns:
            A single model instance or None if not found
        """
        # noinspection PyTypeChecker
        return self.session.query(self.model).filter_by(**kwargs).first()

    def count(self, **kwargs) -> int:
        """
        Count records matching the given criteria.

        Args:
            **kwargs: Filter criteria as key-value pairs

        Returns:
            Number of matching records
        """
        query = self.session.query(self.model)
        if kwargs:
            query = query.filter_by(**kwargs)
        return query.count()

    def exists(self, **kwargs) -> bool:
        """
        Check if a record exists matching the given criteria.

        Args:
            **kwargs: Filter criteria as key-value pairs

        Returns:
            True if record exists, False otherwise
        """
        # noinspection PyTypeChecker
        return self.session.query(self.model).filter_by(**kwargs).first() is not None

    def bulk_create(self, records: list[dict]) -> list[BaseModel]:
        """
        Create multiple records in a single transaction.

        Args:
            records: List of dictionaries with field values

        Returns:
            List of created model instances
        """
        objects = [self.model(**record) for record in records]
        self.session.add_all(objects)
        self.session.commit()

        # Refresh all objects to get their IDs
        for obj in objects:
            self.session.refresh(obj)

        return objects

    def bulk_update(self, updates: list[dict]) -> int:
        """
        Update multiple records in a single transaction.

        Args:
            updates: List of dictionaries with 'id' and field values

        Returns:
            Number of updated records
        """
        updated_count = 0

        for update_data in updates:
            record_id = update_data.pop("id")
            obj = self.get(record_id)
            if obj:
                for key, value in update_data.items():
                    setattr(obj, key, value)
                updated_count += 1

        self.session.commit()
        return updated_count
