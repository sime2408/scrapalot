"""
Service Decorator Module - Provides Spring Boot-like service annotations for Python

This module provides:
- @service decorator for marking service classes
- Transaction management
- Database exception handling
- Singleton pattern implementation
- Automatic dependency injection for database sessions
- @autowired decorator for injecting dependencies
"""

import functools
import inspect
import traceback
from typing import Any, TypeVar

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from src.main.config.database import SessionLocal
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Type variable for generic service classes
T = TypeVar("T")

# Registry to store singleton instances
_service_registry: dict[str, Any] = {}

# Registry to store autowired dependencies
_autowired_registry: dict[str, dict[str, Any]] = {}


def service(cls: type[T]) -> type[T]:
    """
    Service decorator for creating Spring Boot-like service classes.

    This decorator:
    1. Makes the class singleton
    2. Provides transaction management
    3. Handles database exceptions
    4. Automatically injects database sessions when needed

    Usage:
            @service
            class MyService:
                    def __init__(self, db: Session = None):
                            self.db = db

                    Def some_method(self, arg1, arg2):
                            # Method implementation
                            pass

    Args:
            cls: The class to decorate

    Returns:
            The decorated class with singleton and transaction management capabilities
    """
    original_init = cls.__init__

    @functools.wraps(original_init)
    def new_init(self, *args, **kwargs):
        # Store the database session if provided
        self._db = kwargs.get("db")

        # Call the original __init__ method
        original_init(self, *args, **kwargs)

    cls.__init__ = new_init

    # Add class methods for transaction management
    def get_db_session(self) -> Session:
        """Get the current database session or create a new one"""
        if hasattr(self, "_db") and self._db is not None:
            return self._db
        return SessionLocal()

    def close_db_session(_self, db: Session, created_in_method: bool = True):
        """Close the database session if it was created in the method"""
        if created_in_method and db is not None:
            db.close()

    def transactional(wrapped_method):
        """
        Method decorator for transaction management.

        Automatically:
        1. Create a database session if not provided
        2. Commits to success
        3. Rolls back on exception
        4. Closes the session if it was created in the method
        """

        @functools.wraps(wrapped_method)
        def wrapper(self, *args, **kwargs):
            # Check if a db session was provided in the method call
            db_in_kwargs = "db" in kwargs and kwargs["db"] is not None

            # Get or create a database session
            created_in_method = False
            if not db_in_kwargs:
                kwargs["db"] = self.get_db_session()
                created_in_method = True

            db = kwargs["db"]

            try:
                # Execute the method
                result = wrapped_method(self, *args, **kwargs)

                # Commit the transaction if we created the session
                if created_in_method:
                    db.commit()

                return result
            except SQLAlchemyError as e:
                # Roll back on database errors
                if created_in_method:
                    db.rollback()
                logger.error("Database error in %s.%s: %s", cls.__name__, wrapped_method.__name__, str(e))
                logger.debug(traceback.format_exc())
                raise
            except Exception as e:
                # Roll back on any other exceptions
                if created_in_method:
                    db.rollback()
                logger.error("Error in %s.%s: %s", cls.__name__, wrapped_method.__name__, str(e))
                logger.debug(traceback.format_exc())
                raise
            finally:
                # Close the session if we created it
                self.close_db_session(db, created_in_method)

        return wrapper

    # Add the methods to the class
    cls.get_db_session = get_db_session
    cls.close_db_session = close_db_session
    cls.transactional = transactional

    # Add a class method to get the singleton instance
    # noinspection PyDecorator
    @classmethod
    def get_instance(_klass, db: Session = None) -> T:
        """
        Get the singleton instance of the service.

        Args:
                _klass: The class itself (classmethod implicit argument, unused — outer cls is used)
                db: Optional database session to use

        Returns:
                The singleton instance of the service
        """
        class_name = cls.__name__

        # Create a new instance if it doesn't exist
        if class_name not in _service_registry:
            _service_registry[class_name] = cls(db=db)
            logger.debug("Created new singleton instance of %s", class_name)
        elif db is not None:
            # Update the database session if provided
            # noinspection PyProtectedMember
            _service_registry[class_name]._db = db

        return _service_registry[class_name]

    # Add the get_instance method to the class
    cls.get_instance = get_instance

    # Automatically apply the transactional decorator to public methods
    for name, method in inspect.getmembers(cls, inspect.isfunction):
        # Skip private methods, special methods, and the methods we just added
        if not name.startswith("_") and name not in ["get_db_session", "close_db_session", "get_instance"]:
            # Replace the method with the decorated version
            setattr(cls, name, transactional(method))

    logger.debug("Registered service: %s", cls.__name__)
    return cls


def async_service(cls: type[T]) -> type[T]:
    """
    Async service decorator for creating Spring Boot-like service classes with async support.

    This decorator:
    1. Makes the class a singleton
    2. Provides async transaction management
    3. Handles database exceptions
    4. Automatically injects database sessions when needed

    Usage:
            @async_service
            class MyAsyncService:
                    def __init__(self, db=None):
                            self.db = db

                    async def some_method(self, arg1, arg2):
                            # Async method implementation
                            pass

    Args:
            cls: The class to decorate

    Returns:
            The decorated class with singleton and async transaction management capabilities
    """
    original_init = cls.__init__

    @functools.wraps(original_init)
    def new_init(self, *args, **kwargs):
        # Store the database session if provided
        self._db = kwargs.get("db")

        # Call the original __init__ method
        original_init(self, *args, **kwargs)

    cls.__init__ = new_init

    # Add class methods for async transaction management
    async def get_async_db_session(self):
        """Get the current async database session or create a new one"""
        if hasattr(self, "_db") and self._db is not None:
            return self._db

        # Import here to avoid circular imports
        from src.main.config.database import AsyncSessionLocal

        if AsyncSessionLocal is None:
            raise RuntimeError("AsyncSessionLocal is not initialized. Check database configuration.")

        return AsyncSessionLocal()

    async def close_async_db_session(_self, db, created_in_method=True):
        """Close the async database session if it was created in the method"""
        if created_in_method and db is not None:
            await db.close()

    def async_transactional(wrapped_method):
        """
        Method decorator for async transaction management.

        Automatically:
        1. Creates an async database session if not provided
        2. Commits on success
        3. Rolls back on exception
        4. Closes the session if it was created in the method
        """

        @functools.wraps(wrapped_method)
        async def wrapper(self, *args, **kwargs):
            # Check if a db session was provided in the method call
            db_in_kwargs = "db" in kwargs and kwargs["db"] is not None

            # Get or create a database session
            created_in_method = False
            if not db_in_kwargs:
                kwargs["db"] = await self.get_async_db_session()
                created_in_method = True

            db = kwargs["db"]

            try:
                # Execute the method
                result = await wrapped_method(self, *args, **kwargs)

                # Commit the transaction if we created the session
                if created_in_method:
                    await db.commit()

                return result
            except SQLAlchemyError as e:
                # Roll back on database errors
                if created_in_method:
                    await db.rollback()
                logger.error("Database error in %s.%s: %s", cls.__name__, wrapped_method.__name__, str(e))
                logger.debug(traceback.format_exc())
                raise
            except Exception as e:
                # Roll back on any other exceptions
                if created_in_method:
                    await db.rollback()
                logger.error("Error in %s.%s: %s", cls.__name__, wrapped_method.__name__, str(e))
                logger.debug(traceback.format_exc())
                raise
            finally:
                # Close the session if we created it
                await self.close_async_db_session(db, created_in_method)

        return wrapper

    # Add the methods to the class
    cls.get_async_db_session = get_async_db_session
    cls.close_async_db_session = close_async_db_session
    cls.async_transactional = async_transactional

    # Add a class method to get the singleton instance
    # noinspection PyDecorator
    @classmethod
    def get_instance(_klass, db=None) -> T:
        """
        Get the singleton instance of the service.

        Args:
                _klass: The class itself (classmethod implicit argument, unused — outer cls is used)
                db: Optional database session to use

        Returns:
                The singleton instance of the service
        """
        class_name = cls.__name__

        # Create a new instance if it doesn't exist
        if class_name not in _service_registry:
            _service_registry[class_name] = cls(db=db)
            logger.debug("Created new singleton instance of %s", class_name)
        elif db is not None:
            # Update the database session if provided
            # noinspection PyProtectedMember
            _service_registry[class_name]._db = db

        return _service_registry[class_name]

    # Add the get_instance method to the class
    cls.get_instance = get_instance

    # Automatically apply the async_transactional decorator to public async methods
    for name, method in inspect.getmembers(cls, inspect.isfunction):
        # Skip private methods, special methods, and the methods we just added
        if not name.startswith("_") and name not in ["get_async_db_session", "close_async_db_session", "get_instance"]:
            # Check if the method is async
            if inspect.iscoroutinefunction(method):
                # Replace the method with the decorated version
                setattr(cls, name, async_transactional(method))

    logger.debug("Registered async service: %s", cls.__name__)
    return cls


def autowired(cls_or_field_name: Any = None) -> Any:
    """
    Decorator to inject service dependencies into a class.

    This decorator can be used in two ways:
    1. As a class decorator: @autowired
    2. As a field decorator: @autowired('service_name')

    When used as a class decorator, it will scan the class for fields
    annotated with @autowired and inject the corresponding services.

    When used as a field decorator, it will inject the specified service
    into the field when the class is instantiated.

    Args:
            cls_or_field_name: Either the class to decorate or the name of the service to inject

    Returns:
            The decorated class or a field decorator function
    """
    # If used as @autowired without parentheses (class decorator)
    if inspect.isclass(cls_or_field_name):
        cls = cls_or_field_name
        # Register the class in the autowired registry
        if cls.__name__ not in _autowired_registry:
            _autowired_registry[cls.__name__] = {}

        # Store original __init__
        original_init = cls.__init__

        @functools.wraps(original_init)
        def __init__(self, *args, **kwargs):
            # Inject all autowired dependencies
            for field_name, svc_name in _autowired_registry[cls.__name__].items():
                if svc_name in _service_registry:
                    setattr(self, field_name, _service_registry[svc_name])
                else:
                    logger.warning("Service '%s' not found in registry for field '%s' in %s", svc_name, field_name, cls.__name__)

            # Call original __init__
            original_init(self, *args, **kwargs)

        # Replace __init__
        cls.__init__ = __init__
        return cls

    # If used as @autowired('service_name') (field decorator)
    service_name = cls_or_field_name

    def field_decorator(decorated_cls, field_name, _):
        # Register the field in the autowired registry
        if decorated_cls.__name__ not in _autowired_registry:
            _autowired_registry[decorated_cls.__name__] = {}

        # Store the service name for this field
        _autowired_registry[decorated_cls.__name__][field_name] = service_name or field_name

        # Return a property that gets the service from the registry
        @property
        def getter(_self):
            svc = _service_registry.get(service_name or field_name)
            if svc is None:
                logger.warning(
                    "Service '%s' not found in registry for field '%s' in %s", service_name or field_name, field_name, decorated_cls.__name__
                )
            return svc

        return getter

    return field_decorator
