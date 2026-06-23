"""
PGVector Retriever Implementation

This module provides a retriever implementation using PostgreSQL with the pgvector extension
for efficient similarity search operations.
"""

import asyncio
import threading
from typing import Any
from uuid import UUID

from langchain_core.documents import Document

# Import directly from langchain_postgres.pgvector to avoid SQLColumnExpression issue
from langchain_postgres.vectorstores import PGVector
import numpy as np
from sqlalchemy import (
    Column,
    ForeignKey,
    String,
    UniqueConstraint,
    bindparam,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship

from src.main.service.retriever.retriever import Retriever
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# Hard cap on simultaneous per-collection asimilarity_search() calls. Without
# it, a workspace with 20+ collections + the cross-language path (which doubles
# the task count by also searching the EN translation) fan out 40+ concurrent
# `asimilarity_search` coroutines — each opens its own PG connection through
# LangChain's per-vectorstore engine. PostgreSQL's max_connections (100 by
# default) plus the workers/agents/other consumers stack up to "sorry, too
# many clients already" with all collection retrievals failing, which then
# cascades into LLM init failures ("System AI provider configuration not
# found in database") because the system_settings lookup can't get a
# connection either.
#
# Five lets a small handful run together so total wall time stays close to
# the per-collection latency, while leaving plenty of headroom for the rest
# of the app to hit the same pool. Higher values regress under load; lower
# values throw away parallelism for no gain.
COLLECTION_RETRIEVAL_CONCURRENCY = 5

_collection_retrieval_semaphore: asyncio.Semaphore | None = None


def _get_collection_retrieval_semaphore() -> asyncio.Semaphore:
    """Lazy-init the global concurrency limiter — must be created inside a
    running event loop, otherwise asyncio binds it to a closed/wrong loop."""
    global _collection_retrieval_semaphore
    if _collection_retrieval_semaphore is None:
        _collection_retrieval_semaphore = asyncio.Semaphore(COLLECTION_RETRIEVAL_CONCURRENCY)
    return _collection_retrieval_semaphore


async def _bounded_similarity_search(vectorstore, prompt: str, k: int) -> list[Document]:
    """Run a per-collection asimilarity_search under the global semaphore so
    no more than COLLECTION_RETRIEVAL_CONCURRENCY queries can be in-flight at
    once. The caller still does asyncio.gather over all collections — the
    semaphore just throttles them so the DB pool doesn't blow up."""
    sem = _get_collection_retrieval_semaphore()
    async with sem:
        return await vectorstore.asimilarity_search(prompt, k=k)


async def _bounded_similarity_search_with_filter(vectorstore, query: str, k: int, metadata_filter: dict) -> list[Document]:
    """Filter-aware sibling of _bounded_similarity_search for the metadata
    filter path. Same semaphore, same reasoning — keeps the in-flight
    asimilarity_search count bounded across every multi-collection caller."""
    sem = _get_collection_retrieval_semaphore()
    async with sem:
        return await vectorstore.asimilarity_search(query=query, k=k, filter=metadata_filter)


# Create a Base class for our models
Base = declarative_base()

# Use LangChain's default table names to ensure compatibility
COLLECTION_TABLE_NAME = "langchain_pg_collection"
EMBEDDING_TABLE_NAME = "langchain_pg_embedding"

# Shared async engine cache, keyed by connection string.
#
# Previously every retrieval path here called create_async_engine() directly
# (per collection, per dynamic lookup, per delete). Each call builds a fresh
# engine with its OWN QueuePool, and the engines were never disposed — the
# vectorstores hold a reference, so the pooled connections stay open forever.
# An agentic query that fans out across sub-queries × collections could spin up
# dozens of engines, leaking ~85 idle connections and exhausting Postgres
# (max_connections=100 → "too many clients already" for every service).
#
# All these engines point at the same database, so we share ONE engine per
# connection string with a bounded pool. Connections are returned to the pool
# after each `async with`, instead of accumulating. application_name is set so
# the leak (if any recurs) is attributable in pg_stat_activity. A threading.Lock
# guards creation (module-level global, per the project's async guidance — not
# contextvars).
_ASYNC_ENGINE_CACHE: dict[str, AsyncEngine] = {}
_ASYNC_ENGINE_LOCK = threading.Lock()


# Stopwords (English + question words) dropped before lexical term matching.
# Small on purpose — only the noise that would match every title/document.
_LEXICAL_STOPWORDS = frozenset(
    {
        "the",
        "and",
        "for",
        "with",
        "что",
        "what",
        "which",
        "who",
        "whom",
        "whose",
        "when",
        "where",
        "why",
        "how",
        "does",
        "did",
        "was",
        "were",
        "are",
        "is",
        "that",
        "this",
        "these",
        "those",
        "about",
        "into",
        "from",
        "out",
        "off",
        "talk",
        "talks",
        "talking",
        "book",
        "books",
        "tell",
        "tells",
        "really",
        "actually",
        "happen",
        "happened",
        "happens",
        "thing",
        "things",
        "some",
        "any",
        "all",
        "your",
        "their",
        "them",
        "they",
        "you",
        "там",
    }
)


def _extract_salient_terms(query: str, *, max_terms: int = 8) -> list[str]:
    """Pull the content-bearing words out of a query for lexical matching.

    Lowercases, splits on non-alphanumerics, drops short tokens (<4 chars) and
    stopwords/question words. Order-preserving, de-duplicated. Used to find
    documents whose title/content literally contains the query's key terms —
    the signal vector similarity misses for distinctive names ("Roswell") and
    titles ("Cover-Up").
    """
    import re as _re

    seen: set[str] = set()
    terms: list[str] = []
    for raw in _re.split(r"[^A-Za-z0-9]+", query or ""):
        tok = raw.lower()
        if len(tok) < 4 or tok in _LEXICAL_STOPWORDS or tok in seen:
            continue
        seen.add(tok)
        terms.append(tok)
        if len(terms) >= max_terms:
            break
    return terms


def get_shared_async_engine(connection_string: str) -> AsyncEngine:
    """Return a process-wide shared async engine for the given connection string.

    Reuses a single bounded pool instead of creating (and leaking) a new engine
    per call. Safe to share across asyncio tasks — SQLAlchemy async engines are
    designed for it.
    """
    engine = _ASYNC_ENGINE_CACHE.get(connection_string)
    if engine is not None:
        return engine
    with _ASYNC_ENGINE_LOCK:
        engine = _ASYNC_ENGINE_CACHE.get(connection_string)
        if engine is None:
            engine = create_async_engine(
                connection_string,
                # asyncpg: disable prepared-statement cache for pgbouncer/Supabase
                # compatibility; tag connections so they're identifiable.
                connect_args={
                    "prepared_statement_cache_size": 0,
                    "ssl": False,
                    "server_settings": {"application_name": "scrapalot-chat-pgvector"},
                },
                pool_size=5,
                max_overflow=10,
                pool_pre_ping=True,
                pool_recycle=1800,
            )
            _ASYNC_ENGINE_CACHE[connection_string] = engine
    return engine


class ScrapalotPGVector(PGVector):
    """
    Custom PGVector implementation that sanitizes metadata for asyncpg JSONB compatibility.

    Overrides add_embeddings to ensure all metadata values are JSON-serializable
    before passing to asyncpg, preventing "List argument must consist only of dictionaries" errors.
    """

    @staticmethod
    def _sanitize_metadata_for_json(metadata: dict) -> dict:
        """
        Convert non-JSON-serializable values to JSON-compatible types for asyncpg.

        Note: UUID and datetime objects are kept as-is because asyncpg can handle them natively.
        The main issue was nested dictionaries in lists, not primitive types.
        """
        from datetime import date, datetime
        import json

        sanitized = {}
        for key, value in metadata.items():
            # Keep UUID and datetime objects as-is - asyncpg handles them natively
            if isinstance(value, (UUID, datetime, date)):
                sanitized[key] = value
            elif isinstance(value, bytes):
                sanitized[key] = value.decode("utf-8", errors="replace")
            elif value is None:
                sanitized[key] = None
            elif isinstance(value, (str, int, float, bool)):
                sanitized[key] = value
            elif isinstance(value, (list, dict)):
                try:
                    json.dumps(value)
                    sanitized[key] = value
                except (TypeError, ValueError):
                    sanitized[key] = str(value)
            else:
                sanitized[key] = str(value)
        return sanitized

    async def add_embeddings(
        self,
        texts: list[str],
        embeddings: list[list[float]],
        metadatas: list[dict] | None = None,
        ids: list[str] | None = None,
        **kwargs: Any,
    ) -> list[str]:
        """
        Add embeddings to the vector store with metadata sanitization.

        Sanitizes metadata to ensure JSON compatibility, then delegates to parent class
        which handles the actual database insertion with proper schema awareness.
        """
        # Sanitize all metadata dictionaries for asyncpg JSONB compatibility
        if metadatas:
            sanitized_metadatas = [self._sanitize_metadata_for_json(meta) for meta in metadatas]
        else:
            sanitized_metadatas = None

        # Delegate to parent class which knows the correct schema
        return await super().add_embeddings(
            texts=texts,
            embeddings=embeddings,
            metadatas=sanitized_metadatas,
            ids=ids,
            **kwargs,
        )

    async def add_documents(self, documents, **kwargs):
        """
        Override to sanitize metadata and extract collection_id.

        Args:
            documents: List of Document objects
            **kwargs: Additional arguments (may include collection_ids)
        """
        # Sanitize metadata in all documents for asyncpg JSONB compatibility
        for doc in documents:
            if doc.metadata:
                doc.metadata = self._sanitize_metadata_for_json(doc.metadata)

        # Extract collection_id from kwargs or first document's metadata
        collection_ids = kwargs.get("collection_ids", [])

        if not collection_ids and documents:
            # Try to extract from first document's metadata
            first_doc_collection = documents[0].metadata.get("collection_id")
            if first_doc_collection:
                # Convert to UUID if it's a string
                if isinstance(first_doc_collection, str):
                    collection_ids = [UUID(first_doc_collection)]
                elif isinstance(first_doc_collection, UUID):
                    collection_ids = [first_doc_collection]

        # Call parent's add_documents but make sure collection_ids is passed through
        kwargs["collection_ids"] = collection_ids

        return await super().add_documents(documents, **kwargs)


class CollectionStore(Base):
    """Collection store with custom table name."""

    __tablename__ = COLLECTION_TABLE_NAME

    uuid = Column(PG_UUID, primary_key=True)
    name = Column(String, nullable=False)
    cmetadata = Column(JSONB, nullable=True)

    # Add a unique constraint on the name
    __table_args__ = (UniqueConstraint("name"),)

    # Define the relationship to EmbeddingStore
    embeddings = relationship(
        "EmbeddingStore",
        back_populates="collection",
        cascade="all, delete-orphan",
    )


class EmbeddingStore(Base):
    """Embedding store with custom table name. Matches LangChain postgres v0.0.16 schema."""

    __tablename__ = EMBEDDING_TABLE_NAME

    id = Column(String, primary_key=True)
    collection_id = Column(PG_UUID, ForeignKey(f"{COLLECTION_TABLE_NAME}.uuid"), nullable=False)
    embedding = Column(None, nullable=False)
    document = Column(String, nullable=False)
    cmetadata = Column(JSONB, nullable=True)

    # Define the relationship to CollectionStore
    collection = relationship("CollectionStore", back_populates="embeddings")


# noinspection SqlResolve


class PGVectorRetriever(Retriever):
    def __init__(self, config=None, **kwargs):
        # Add model_name and provider_type to config if provided in kwargs
        # Merge config with kwargs using base class utility method
        config = Retriever._merge_config_with_kwargs(config, **kwargs)

        super().__init__(config)
        self.vector_extension_available = None
        self.embeddings = None
        self.default_collection_name = None
        self.connection_string = None
        self.vectorstores = None
        self.default_collection_id = None
        self.collections_metadata: dict = {}
        self._create_vectorstore_func = None

        # Store additional parameters from kwargs
        self.embedding_model = kwargs.get("embedding_model")
        self.provider = kwargs.get("provider")
        self.emb_kwargs = kwargs.get("emb_kwargs", {})
        self.resolved_secrets = kwargs.get("resolved_secrets")
        self.base_connection_string = kwargs.get("base_connection_string")

    async def initialize_retriever(self, config: dict, **kwargs) -> None:
        """
        Initialize the PGVector retriever with the given configuration and parameters.

        Args:
                config: The application configuration dictionary
                **kwargs: Expected to contain:
                        - llm: Language model instance for reasoning and query processing
                        - resolved_secrets: Dictionary containing resolved secrets, including 'postgres_password'
                        - embedding_model: Optional explicit embedding model to use
                        - provider: Optional explicit provider to use for embeddings

        Raises:
                Exception: If initialization fails due to PostgreSQL connection or configuration issues
        """
        # Call parent class's initialize_retriever to set up common things like Hugging Face token
        await super().initialize_retriever(config, **kwargs)

        # Use instance variables from constructor if available, otherwise get from kwargs
        resolved_secrets = self.resolved_secrets or kwargs.get("resolved_secrets")
        embedding_model = self.embedding_model or kwargs.get("embedding_model")
        provider = self.provider or kwargs.get("provider")
        emb_kwargs = self.emb_kwargs or kwargs.get("emb_kwargs", {})

        if not resolved_secrets:
            raise ValueError("resolved_secrets is required")

        # Priority 1: Check for user's embedding model preference from settings
        user_id = kwargs.get("user_id")
        if user_id and not embedding_model:
            user_embedding_model = await self._get_user_embedding_model(str(user_id))
            if user_embedding_model:
                embedding_model = user_embedding_model
                provider = provider or "local"  # Assume local if not specified
                logger.info(
                    "👤 Using user's preferred embedding model: %s for user %s",
                    embedding_model,
                    user_id,
                )

        # Priority 2: If embedding_model and provider are explicitly provided, use them directly
        # This takes priority over any fallback logic to ensure per-type active models are used
        if embedding_model and provider:
            logger.info(
                "🏷 Using explicitly provided embedding model: %s (Provider: %s) for PGVector",
                embedding_model,
                provider,
            )
            # Skip fallback logic and use the provided model directly
        # Priority 3: Check if providers are configured via user settings
        elif not embedding_model:
            # Use the embedding model that was already detected by the base Retriever class
            # This respects the user's model provider configuration from the database
            if hasattr(self, "embeddings_model") and self.embeddings_model:
                # Use the already-configured embeddings model from the base class
                logger.info("Using pre - configured embeddings model from base retriever")
                embeddings = self.embeddings_model
                embedding_model = "configured_in_base_class"
                provider = "local"
            else:
                # Fallback: use local model based on hardware
                import torch

                from src.main.service.llm.llm_embedding_factory import EmbeddingFactory

                # Set provider to local for a fallback case
                provider = provider or "local"

                # Create embedding factory to get models from a database
                embedding_factory = EmbeddingFactory()

                # Check if GPU is available and get appropriate models
                # Use LLM manager to check for any GPU (CUDA, OpenCL, etc.), not just CUDA
                from src.main.service.llm.llm_manager import llm_manager

                gpu_available = llm_manager.device_type != "cpu" if hasattr(llm_manager, "device_type") else torch.cuda.is_available()

                if gpu_available:
                    # Try to get GPU-optimized embedding models from database
                    gpu_models = embedding_factory.get_embedding_models_from_database(provider)
                    gpu_model = None
                    if gpu_models:
                        # Prefer all-MiniLM-L6-v2 model to avoid MXBAI path issues
                        gpu_model = next(
                            (m for m in gpu_models if "all-minilm-l6-v2" in m.lower()),
                            gpu_models[0],
                        )

                    if gpu_model:
                        embedding_model = gpu_model
                    else:
                        logger.warning("No GPU-optimized embedding models found in database, using fallback")
                        embedding_model = embedding_factory.get_fallback_embedding_model()
                else:
                    # Get CPU-optimized embedding models from database
                    cpu_models = embedding_factory.get_embedding_models_from_database(provider)
                    cpu_model = None
                    if cpu_models:
                        # Prefer CPU-optimized models
                        cpu_model = next(
                            (m for m in cpu_models if "minilm" in m.lower() or "cpu" in m.lower()),
                            cpu_models[0],
                        )

                    if cpu_model:
                        embedding_model = cpu_model
                    else:
                        logger.warning("No CPU-optimized embedding models found in database, using fallback")
                        embedding_model = embedding_factory.get_fallback_embedding_model()

                # Get model namespace if available
                if embedding_model:
                    try:
                        model_info = await self.get_model_info_from_db(embedding_model)
                        if model_info and model_info.get("model_namespace"):
                            emb_kwargs["model_namespace"] = model_info["model_namespace"]
                            logger.info(
                                "Using namespace '%s' for model '%s' from database",
                                model_info["model_namespace"],
                                embedding_model,
                            )
                    except Exception as e:
                        logger.error("Error getting model info from database: %s", str(e))

                # If we still don't have an embedding model, use resolver with GPU awareness
                if not embedding_model:
                    from src.main.config.database import SessionLocal
                    from src.main.utils.llm.embedding_resolver import (
                        EmbeddingModelResolver,
                    )

                    db = SessionLocal()
                    try:
                        # Use resolver with auto hardware selection
                        embedding_model = EmbeddingModelResolver.resolve_embedding_model(
                            db=db,
                            use_fallback=True,
                            context="retriever_initialization",
                            auto_select_for_hardware=True,
                        )
                        provider = "local"
                        logger.info(
                            "Using resolved embedding model: %s (Provider: %s)",
                            embedding_model,
                            provider,
                        )
                    finally:
                        db.close()

        # Try to use globally cached embedding model first (preloaded at startup)
        if not hasattr(self, "embeddings_model") or not self.embeddings_model:
            from src.main.service.llm.embedding_cache import get_embedding_cache

            embedding_cache = get_embedding_cache()

            # Check if we have a cached embedding model from startup
            if embedding_cache.is_initialized():
                cached_model_name = embedding_cache.get_model_name()
                logger.info("Using globally cached embedding model: %s (no loading needed)", cached_model_name)
                self.embeddings_model = embedding_cache.get_embedding_model()
            else:
                # Fallback: create an embedding model if cache not initialized (shouldn't happen in production)
                logger.warning("Global embedding cache not initialized, loading model on-demand (this will cause delay)")
                logger.info(
                    "Creating embeddings model: %s (Provider: %s)",
                    embedding_model,
                    provider,
                )
                from src.main.service.llm.llm_factory import get_embeddings_model_async

                # Pass provider as model_namespace to ensure correct model loading
                # For local provider, this prevents downloading from HuggingFace
                if provider == "local":
                    emb_kwargs["model_namespace"] = "local"
                else:
                    # For other providers, pass the provider name as namespace
                    emb_kwargs["model_namespace"] = provider

                # Use async version to prevent h5py blocking the main thread
                logger.info("Loading embedding model asynchronously to prevent blocking main thread")
                self.embeddings_model = await get_embeddings_model_async(model_name=embedding_model, **emb_kwargs)
        else:
            logger.info("Using pre-configured embeddings model from base retriever")

        # Use the embedding model for the vector store
        embeddings = self.embeddings_model

        # Get PostgreSQL connection details
        pg_config = config.get("postgres", {})
        base_connection_string = self.base_connection_string or kwargs.get("base_connection_string")
        if not base_connection_string:
            # Use the async driver for PostgreSQL (fix: remove space in postgresql+asyncpg)
            # Note: config uses 'db' key, but fallback to 'database' for compatibility
            db_name = pg_config.get("db") or pg_config.get("database", "postgres")
            pg_password = (resolved_secrets or {}).get("postgres_password", "scrapalot")
            base_connection_string = (
                f"postgresql+asyncpg://{pg_config.get('user', 'postgres')}"
                f":{pg_password}"
                f"@{pg_config.get('host', 'localhost')}"
                f":{pg_config.get('port', 5432)}/{db_name}"
            )

        default_collection_name = pg_config.get("pgvector_collection", "Research Papers")

        # pgvector extension is checked at startup, so we assume it's available
        # If it's not available, the vectorstore creation will handle the error
        vector_extension_available = True

        async def create_vectorstore(collection_id_str, collection_display_name=None):
            """
            Create a vectorstore using the collection UUID.

            IMPORTANT: LangChain PGVector uses collection_name to create/find collections in langchain_pg_collection.
            We must pass the actual collection UUID so that:
            1. langchain_pg_collection.uuid = our collection UUID
            2. langchain_pg_collection.name = our collection UUID (LangChain's behavior)
            3. All embeddings reference the correct collection_id
            """
            # Reuse the shared, pooled engine instead of creating a new one per
            # collection (the old code leaked a pool per vectorstore).
            engine_async = get_shared_async_engine(base_connection_string)
            display_name = collection_display_name or f"Collection {collection_id_str}"
            logger.info(
                "Creating vectorstore for collection ID: %s (display: %s)",
                collection_id_str,
                display_name,
            )
            try:
                # Use collection UUID as collection_name so LangChain creates proper references
                # noinspection PyTypeChecker
                return ScrapalotPGVector(
                    connection=engine_async,
                    collection_name=collection_id_str,  # Use UUID for proper LangChain collection mapping
                    embeddings=embeddings,
                    create_extension=False,  # Don't try to create the extension - we've already checked
                    async_mode=True,  # Engine is create_async_engine — without this langchain_postgres routes asimilarity_search through a sync-only path that silently returns []
                )
            except Exception as ex:
                if not vector_extension_available:
                    logger.error(
                        "Failed to create vectorstore - pgvector extension is missing: %s",
                        str(ex),
                    )
                    # Return a test double implementation that doesn't use pgvector
                    return DummyVectorStore(collection_id_str, display_name)
                else:
                    raise

        # Store vectorstores (lazy-loaded) and collection metadata
        vector_stores = {}
        collections_metadata = {}

        # Get all collections with IDs and names
        try:
            engine = get_shared_async_engine(base_connection_string)
            async with engine.connect() as conn:
                # Get both ID and name from collections
                result = await conn.execute(text("SELECT collection_id, collection_name FROM collection_workspace_map"))
                # With SQLAlchemy 2.0 and asyncpg, fetchall() is synchronous, not async
                collections = result.fetchall()

                # Convert to list to ensure it's a proper Python list, not a database result proxy
                collections_list = list(collections) if collections else []

                if not collections_list:
                    logger.warning("No collections found in database. Will create vectorstores on-demand.")
                    self.default_collection_id = default_collection_name
                else:
                    logger.info(
                        "Found %d collections in database (vectorstores will be created on-demand)",
                        len(collections_list),
                    )
                    # Store collection metadata for lazy initialization
                    for collection in collections_list:
                        collection_id = str(collection[0])  # ID from database
                        collection_name = collection[1]  # Name from a database
                        collections_metadata[collection_id] = collection_name

                    # Use the first collection as default if we have collections
                    self.default_collection_id = str(collections_list[0][0])
        except Exception as e:
            logger.error("Error retrieving collections from database: %s", str(e))
            logger.warning("Will create vectorstores on-demand as fallback")
            self.default_collection_id = default_collection_name

        # Initialize instance properties
        self.vectorstores = vector_stores
        self.collections_metadata = collections_metadata
        self.connection_string = base_connection_string
        self.default_collection_name = default_collection_name
        self.embeddings = embeddings
        self.vector_extension_available = vector_extension_available
        self._create_vectorstore_func = create_vectorstore  # Store for lazy initialization

        logger.info(
            "PGVector initialized successfully (lazy-loading enabled for %d collections)",
            len(collections_metadata),
        )

    async def _ensure_vectorstore(self, collection_id: str) -> bool:
        """
        Ensure a vectorstore exists for the given collection ID (lazy initialization).

        Args:
                collection_id: The collection ID to ensure vectorstore for

        Returns:
                True if a vectorstore exists or was created, False otherwise
        """
        # If already created, return True
        if collection_id in self.vectorstores:
            return True

        # Check if we have metadata for this collection
        if collection_id in self.collections_metadata:
            collection_name = self.collections_metadata[collection_id]
            logger.info(
                "Creating vectorstore on-demand for collection ID: %s (display: %s)",
                collection_id,
                collection_name,
            )
            try:
                self.vectorstores[collection_id] = await self._create_vectorstore_func(collection_id, collection_name)
                return True
            except Exception as e:
                logger.error(
                    "Failed to create vectorstore for collection %s: %s",
                    collection_id,
                    str(e),
                )
                return False

        # Collection isn't found in cached metadata - try to fetch from database dynamically
        try:
            from sqlalchemy import text

            logger.info("Collection %s not in cache, querying database...", collection_id)
            engine = get_shared_async_engine(self.connection_string)
            async with engine.connect() as conn:
                result = await conn.execute(
                    text("SELECT collection_id, collection_name FROM collection_workspace_map WHERE collection_id = :collection_id"),
                    {"collection_id": collection_id},
                )
                row = result.fetchone()
                if row:
                    collection_name = row[1]
                    # Add to cache for future use
                    self.collections_metadata[collection_id] = collection_name
                    logger.info(
                        "Found collection in database: %s (name: %s), creating vectorstore",
                        collection_id,
                        collection_name,
                    )
                    try:
                        self.vectorstores[collection_id] = await self._create_vectorstore_func(collection_id, collection_name)
                        return True
                    except Exception as e:
                        logger.error(
                            "Failed to create vectorstore for collection %s: %s",
                            collection_id,
                            str(e),
                        )
                        return False
                else:
                    logger.warning("Collection %s not found in database", collection_id)
                    return False
        except Exception as e:
            logger.error("Error fetching collection %s from database: %s", collection_id, str(e))
            return False

    async def get_vectorstore(self):
        """
        Get the default vectorstore (with lazy initialization).

        Returns:
                The default PGVector instance
        """
        # Ensure the default vectorstore is created
        if self.default_collection_id:
            await self._ensure_vectorstore(self.default_collection_id)

        # Return the default vectorstore if available
        if self.default_collection_id and self.default_collection_id in self.vectorstores:
            return self.vectorstores[self.default_collection_id]
        elif self.vectorstores:
            # Return the first vectorstore if default not found
            first_key = next(iter(self.vectorstores))
            return self.vectorstores[first_key]
        else:
            return None

    async def get_embeddings(self, texts):
        """
        Get embeddings for a list of texts using the configured embedding model.

        Args:
                texts: List of text strings to embed

        Returns:
                List of embedding vectors
        """
        if not texts:
            return []

        try:
            # Use the embedding model to get vectors
            if hasattr(self.embeddings, "aembed_documents"):
                # Use async version if available
                return await self.embeddings.aembed_documents(texts)
            else:
                # Fall back to sync version
                return self.embeddings.embed_documents(texts)
        except Exception as e:
            logger.error("Error generating embeddings: %s", str(e))
            # Return empty embeddings as fallback
            return [np.zeros(1536) for _ in texts]  # Most models use 1536 dimensions

    async def process(
        self,
        prompt: str,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
    ) -> list[Document]:
        """
        Process a query and return relevant documents from multiple collections with reranking.

        Args:
                prompt: The query text
                collection_ids: Optional list of collection IDs to search in
                document_ids: Optional list of document IDs to restrict the search

        Returns:
                List of relevant Document objects, reranked by relevance
        """
        try:
            # Prepare a query and get collection IDs
            prompt, collection_id_strs = await self._prepare_query_and_collections(prompt, collection_ids)

            # Cross-language: the embeddings are English, so a non-English query
            # (e.g. Croatian) misses entirely against them. Translate to English
            # and search + rerank with the translation; the answer is still
            # generated in the user's language downstream. This is the strategy
            # retrieval path — similarity_search() already does this, but the RAG
            # strategies call process(), which previously skipped translation.
            try:
                from src.main.service.rag.cross_language import translate_query_if_needed

                _orig, _translated = await translate_query_if_needed(prompt)
                if _translated:
                    logger.info("Cross-language: retrieving with translated query: '%s' -> '%s'", prompt[:50], _translated[:50])
                    prompt = _translated
            except Exception as e:
                logger.debug("Cross-language translation failed (optional feature): %s", str(e))

            # Convert document_ids to strings if needed for filtering
            doc_id_strs = None
            if document_ids:
                doc_id_strs = [str(doc_id) for doc_id in document_ids]

            # Get the initial retrieval count from config (higher for small chunks)
            from src.main.utils.config.loader import resolved_config

            initial_k = resolved_config.get("rag", {}).get("vector_search", {}).get("initial_retrieval_k", 15)
            initial_k = int(initial_k)  # Ensure it's an integer

            # Retrieve from all collections in parallel
            tasks = []

            for collection_id_str in collection_id_strs:
                vectorstore = self.vectorstores[collection_id_str]

                # If document_ids are provided, use metadata filter
                if doc_id_strs:
                    task = self.similarity_search_with_metadata_filter(
                        query=prompt,
                        metadata_filter={"document_id": {"$in": doc_id_strs}},
                        collection_ids=collection_ids,
                        document_ids=document_ids,
                        k=initial_k,
                    )
                else:
                    # Standard similarity search with configured k value.
                    # Bounded by the global concurrency semaphore — see
                    # COLLECTION_RETRIEVAL_CONCURRENCY at module top for
                    # the "too many clients already" history.
                    task = _bounded_similarity_search(vectorstore, prompt, initial_k)

                tasks.append(task)

            # Process search results from all collections with initial higher k, then rerank to final k
            return await self._process_search_results(tasks, collection_id_strs, prompt, k=initial_k)

        except Exception as e:
            logger.error("Error during multi - collection processing: %s", str(e))
            return []

    async def add_documents(self, docs: list[Document], collection_ids: list[UUID] | None = None):
        """
        Add documents to the vector store with improved markdown handling and chunk quality filtering.

        Args:
                docs: List of LangChain Document objects to add
                collection_ids: Optional list of collection IDs to add the documents to
        """
        # If no collection_ids provided, use the default collection
        if not collection_ids:
            collection_id_str = self.default_collection_id
            vectorstore = self.vectorstores[collection_id_str]

            # Ensure collection_id is set in metadata (sanitization now handled by ScrapalotPGVector)
            for doc in docs:
                if "collection_id" not in doc.metadata:
                    doc.metadata["collection_id"] = str(collection_id_str)

            # Process chunks in batches to avoid overwhelming the embedding API
            batch_size = 10  # Keep batching for API calls
            for i in range(0, len(docs), batch_size):
                batch = docs[i : i + batch_size]
                try:
                    await vectorstore.add_documents(batch)
                    logger.info(
                        "Added batch %d of documents to vector store (default collection)",
                        i // batch_size + 1,
                    )
                except Exception as e:
                    logger.error(
                        "Error adding batch %d to vector store: %s",
                        i // batch_size + 1,
                        str(e),
                    )
        else:
            # Convert collection_ids to strings
            collection_id_strs = [str(cid) for cid in collection_ids]

            # Ensure vectorstores exist for all collection IDs
            for cid in collection_id_strs:
                await self._ensure_vectorstore(cid)

            # Filter to valid collection IDs (after ensuring they exist)
            valid_collection_ids = [cid for cid in collection_id_strs if cid in self.vectorstores]

            if not valid_collection_ids:
                logger.warning("No valid collection IDs found among embeddings: %s", collection_id_strs)
                # Ensure default collection exists before using it
                if self.default_collection_id:
                    await self._ensure_vectorstore(self.default_collection_id)
                    if self.default_collection_id in self.vectorstores:
                        valid_collection_ids = [self.default_collection_id]
                    else:
                        logger.error(
                            "Failed to create default collection vectorstore: %s",
                            self.default_collection_id,
                        )
                        return
                else:
                    logger.error("No default collection ID configured")
                    return

            # Add to each collection
            for collection_id_str in valid_collection_ids:
                vectorstore = self.vectorstores[collection_id_str]

                # Make a deep copy of the documents to avoid modifying the originals
                import copy

                collection_docs = copy.deepcopy(docs)

                # Update metadata for this collection (sanitization now handled by ScrapalotPGVector)
                for doc in collection_docs:
                    # Ensure collection_id is set
                    if "collection_id" not in doc.metadata or doc.metadata["collection_id"] != collection_id_str:
                        doc.metadata["collection_id"] = collection_id_str

                # Process chunks in batches
                batch_size = 10
                for i in range(0, len(collection_docs), batch_size):
                    batch = collection_docs[i : i + batch_size]
                    try:
                        await vectorstore.add_documents(batch)
                        logger.info(
                            "Added batch %d of documents to collection %s",
                            i // batch_size + 1,
                            collection_id_str,
                        )
                    except Exception as e:
                        logger.error(
                            "Error adding batch %d to collection %s: %s",
                            i // batch_size + 1,
                            collection_id_str,
                            str(e),
                        )

    async def get_all_documents(
        self,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
        limit: int | None = None,
    ) -> list[Document]:
        """
        Get documents from the database, optionally filtered by collection and document IDs.

        Args:
            collection_ids: Filter by these collection UUIDs (matches langchain_pg_collection.name)
            document_ids: Filter by these document UUIDs (matches cmetadata->>'document_id')
            limit: Maximum number of documents to return

        Returns:
            List of documents matching the filters
        """
        from src.main.config.database import AsyncSessionLocal

        all_documents = []

        try:
            async with AsyncSessionLocal() as session:
                conditions = []
                params: dict[str, Any] = {}

                if collection_ids:
                    # collection_ids from the UI map to langchain_pg_collection.name (stored as UUID string).
                    # Also include documents linked via the document_collections junction table
                    # so that multi-collection membership is respected.
                    collection_id_strings = [str(cid) for cid in collection_ids]
                    conditions.append(f"""
                        (
                            e.collection_id IN (
                                SELECT c.uuid FROM {COLLECTION_TABLE_NAME} c
                                WHERE c.name = ANY(:collection_names)
                            )
                            OR e.cmetadata->>'document_id' IN (
                                SELECT dc.document_id::text FROM document_collections dc
                                WHERE dc.collection_id::text = ANY(:collection_names)
                            )
                        )
                    """)
                    params["collection_names"] = collection_id_strings

                if document_ids:
                    doc_id_strings = [str(did) for did in document_ids]
                    conditions.append("e.cmetadata->>'document_id' = ANY(:document_ids)")
                    params["document_ids"] = doc_id_strings

                where_clause = ""
                if conditions:
                    where_clause = "WHERE " + " AND ".join(conditions)

                limit_clause = ""
                if limit:
                    limit_clause = f"LIMIT {int(limit)}"

                query = text(f"""
                    SELECT
                        e.document,
                        e.cmetadata
                    FROM {EMBEDDING_TABLE_NAME} e
                    {where_clause}
                    {limit_clause}
                """)

                result = await session.execute(query, params)
                rows = result.fetchall()

                for row in rows:
                    doc = Document(page_content=row.document, metadata=row.cmetadata or {})
                    all_documents.append(doc)

                logger.info(
                    "Retrieved %d documents from database (filters: collections=%s, docs=%s, limit=%s)",
                    len(all_documents),
                    len(collection_ids) if collection_ids else "all",
                    len(document_ids) if document_ids else "all",
                    limit,
                )

        except Exception as e:
            logger.error("Error retrieving all documents: %s", str(e))
            raise

        return all_documents

    @staticmethod
    async def _get_user_embedding_model(user_id: str) -> str | None:
        """
        Get user's preferred embedding model from user_settings table.

        Args:
                user_id: The user ID to look up settings for

        Returns:
                Embedding model name if found, None otherwise
        """
        if not user_id:
            return None

        try:
            from sqlalchemy import text

            from src.main.config.database import AsyncSessionLocal

            async with AsyncSessionLocal() as db:
                query = text("""
                    SELECT setting_value FROM user_settings
                    WHERE user_id = :user_id AND setting_key = 'document_embedding_settings'
                    LIMIT 1
                """)

                result = await db.execute(query, {"user_id": user_id})
                row = result.first()

                if row and row[0]:
                    import json

                    setting_value = row[0]

                    # Handle both string (SQLite) and dict (PostgreSQL) formats
                    if isinstance(setting_value, str):
                        setting_data = json.loads(setting_value)
                    elif isinstance(setting_value, dict):
                        setting_data = setting_value
                    else:
                        return None

                    embedding_model = setting_data.get("embedding_model")
                    if embedding_model:
                        logger.debug(
                            "Found user embedding model preference: %s for user %s",
                            embedding_model,
                            user_id,
                        )
                        return embedding_model

                return None
        except Exception as e:
            logger.warning("Could not retrieve user embedding model preference: %s", str(e))
            return None

    @staticmethod
    async def get_model_info_from_db(model_name: str) -> dict[str, Any] | None:
        """
        Get model information from the database based on model name.

        Args:
                model_name: The name of the model to look up

        Returns:
                Dictionary with model information if found, None otherwise
        """
        if not model_name:
            return None

        try:
            from src.main.config.database import AsyncSessionLocal

            # Create an async database session
            async with AsyncSessionLocal() as db:
                # Query the database to get model information
                query = """
                    SELECT model_name, model_type, model_namespace
                    FROM model_provider_models
                    WHERE model_name = :model_name
                    LIMIT 1
                """

                result = await db.execute(text(query), {"model_name": model_name})
                row = result.first()

                if row:
                    return {
                        "model_name": row[0],
                        "model_type": row[1],
                        "model_namespace": row[2],
                    }
                return None
        except Exception as e:
            logger.debug("Could not query database for model info: %s", str(e))
            return None

    async def close(self):
        for vectorstore in self.vectorstores.values():
            if hasattr(vectorstore, "close"):
                if asyncio.iscoroutinefunction(vectorstore.close):
                    await vectorstore.close()
                else:
                    vectorstore.close()

    async def _process_search_results(
        self, tasks: list, collection_id_strs: list[str], prompt: str, k: int = 10, defer_rerank: bool = False
    ) -> list[Document]:
        """
        Process search results from multiple collections and rerank them.

        When ``defer_rerank`` is True, the gathered documents are returned WITHOUT
        the cross-encoder rerank (and without the pagerank/augment passes). The
        hybrid caller then adds junction + lexical candidates and reranks the
        union ONCE — reranking here as well was wasted work: the first ranking
        was discarded by the second pass. On a CPU reranker under concurrent
        reprocess load each pass costs ~30s, so collapsing two passes into one
        roughly halves the retrieval wait.

        Args:
                tasks: List of async tasks to wait for
                collection_id_strs: List of collection ID strings for error reporting
                prompt: The query text for reranking
                k: Number of top documents to return after reranking

        Returns:
                List of reranked documents
        """

        # Wait for all tasks to complete
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Process results, filtering out any exceptions.
        #
        # When cross-language translation fires, the caller appends a SECOND
        # search pass per collection (the translated query), so `results` holds
        # 2 * len(collection_id_strs) entries — original passes first, then the
        # translated passes in the same collection order. Map each result index
        # back to its collection with modulo. Without this, the translated half
        # indexed `collection_id_strs[i]` out of range and raised IndexError,
        # which the outer handler swallowed into an empty list — i.e. EVERY
        # non-English query in the full-rerank (regular-chat) path silently
        # returned zero documents.
        all_documents = []
        n_collections = len(collection_id_strs)
        for i, result in enumerate(results):
            coll_id = collection_id_strs[i % n_collections] if n_collections else "unknown"
            if isinstance(result, Exception):
                logger.error(
                    "Error retrieving from collection %s: %s",
                    coll_id,
                    str(result),
                )
            else:
                # Add collection_id to metadata for tracking source
                for doc in result:
                    doc.metadata["source_collection_id"] = coll_id
                all_documents.extend(result)

        # Defer to the caller's single rerank over the full candidate set
        # (dense + junction + lexical). Returns merged docs unranked.
        if defer_rerank:
            return all_documents

        # Rerank documents using MMR algorithm
        reranked = await self._rerank_documents_with_mmr(prompt, all_documents, k=k)
        # PageRank boost and cross-collection bridge augmentation are
        # knowledge-graph features removed in the Community Edition — the basic
        # similarity + rerank result is returned as-is.
        return reranked

    async def _rerank_documents_with_mmr(self, query: str, all_documents: list[Document], k: int = 10) -> list[Document]:
        """
        Common method to rerank documents using cross-encoder reranker or MMR fallback.

        Args:
                query: The query text
                all_documents: List of documents to rerank
                k: Number of top documents to return

        Returns:
                List of reranked documents or original documents if reranking fails
        """
        if not all_documents:
            logger.warning("No documents found across specified collections")
            return []

        # Cross-encoder reranking (MMR fallback only if reranker fails).
        # Doc embeddings are NOT pre-computed here; they are computed lazily inside
        # rerank_documents only if the cross-encoder fails, avoiding wasted work
        # on the ~99% of requests where cross-encoding succeeds.
        from src.main.utils.config.loader import resolved_config

        skip_threshold = resolved_config.get("defaults", {}).get("reranker", {}).get("skip_threshold", 3)
        if len(all_documents) > skip_threshold:
            try:
                # Inject document_priority from DB into chunk metadata for weighting.
                await self._inject_document_priorities(all_documents)

                # The cross-encoder reranker_manager is removed in the Community
                # Edition. Degrade to the existing similarity-ordered candidate set,
                # capped per document and truncated to top-k.
                reranked_docs = self._cap_passages_per_document(all_documents[:k])
                logger.info("Returning %d documents (CE basic ordering, no cross-encoder rerank)", len(reranked_docs))
                return reranked_docs

            except Exception as e:
                logger.error("Error during reranking: %s. Returning documents without reranking.", str(e))
                return self._cap_passages_per_document(all_documents[:k])
        return self._cap_passages_per_document(all_documents)

    @staticmethod
    async def _inject_document_priorities(docs: list) -> None:
        """Inject document_priority from DB into chunk metadata for reranker weighting.

        Fetches priority values for unique document_ids in one query,
        then sets doc.metadata["document_priority"] on each chunk.
        """
        doc_ids = {doc.metadata.get("document_id") for doc in docs if doc.metadata.get("document_id")}
        if not doc_ids:
            return
        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            with SessionLocal() as db:
                rows = db.execute(
                    text("SELECT id::text, priority FROM documents WHERE id::text = ANY(:ids)"),
                    {"ids": list(doc_ids)},
                ).fetchall()
            priority_map = {str(row[0]): float(row[1]) for row in rows if row[1] != 1.0}
            if priority_map:
                for doc in docs:
                    did = doc.metadata.get("document_id")
                    if did and did in priority_map:
                        doc.metadata["document_priority"] = priority_map[did]
        except Exception as e:
            logger.debug("Could not inject document priorities: %s", str(e))

    @staticmethod
    def _cap_passages_per_document(docs: list, max_per_doc: int = 3) -> list:
        """Cap passages per source document to ensure answer diversity.

        Without this, a single large document can dominate retrieval results
        (e.g., 8 of 10 passages from the same book), biasing the answer.
        """
        from collections import Counter

        doc_counts: Counter = Counter()
        result = []
        for doc in docs:
            doc_id = doc.metadata.get("document_id", "unknown")
            if doc_counts[doc_id] < max_per_doc:
                result.append(doc)
                doc_counts[doc_id] += 1
        if len(result) < len(docs):
            logger.debug("Passage cap: %d → %d (max %d per doc)", len(docs), len(result), max_per_doc)
        return result

    @staticmethod
    def _mmr_rerank(query_embedding, doc_embeddings, docs, k=5, lambda_mult=0.5):
        """
        Rerank documents using Maximum Marginal Relevance.

        Args:
                query_embedding: Embedding of the query
                doc_embeddings: List of document embeddings
                docs: List of documents
                k: Number of documents to return (default=5)
                lambda_mult: Balance between relevance and diversity (0-1, higher means more relevance)

        Returns:
                List of reranked documents
        """
        if len(docs) <= k:
            return docs

        # Calculate similarity between query and documents
        similarities = []
        for doc_embedding in doc_embeddings:
            # noinspection PyTypeChecker
            sim = np.dot(query_embedding, doc_embedding) / (np.linalg.norm(query_embedding) * np.linalg.norm(doc_embedding))
            similarities.append(sim)

        # Sort documents by similarity
        doc_scores = list(zip(docs, doc_embeddings, similarities, strict=False))
        # Guard: zip truncates to the shortest input, so if doc_embeddings came
        # back empty (embedding step failed) while docs is non-empty, doc_scores
        # is empty and doc_scores[0] below would raise "list index out of range".
        # Degrade gracefully to the unranked top-k instead of crashing retrieval.
        if not doc_scores:
            logger.warning("MMR rerank got %d docs but no usable embeddings; returning unranked top-%d", len(docs), k)
            return docs[:k]
        doc_scores.sort(key=lambda x: x[2], reverse=True)

        # Initialize selected and remaining documents
        selected_docs = []
        selected_indices = []

        # Always include the most similar document
        selected_docs.append(doc_scores[0][0])
        selected_indices.append(0)

        # Select remaining documents using MMR
        while len(selected_docs) < k and len(selected_docs) < len(doc_scores):
            best_score = -np.inf
            best_idx = -1

            # For each remaining document
            for i, (_doc, doc_embedding, _) in enumerate(doc_scores):
                if i in selected_indices:
                    continue

                # Calculate similarity to query
                query_similarity = doc_scores[i][2]

                # Calculate maximum similarity to already selected documents
                max_similarity = 0
                for j in selected_indices:
                    # noinspection PyTypeChecker
                    similarity = np.dot(doc_embedding, doc_scores[j][1]) / (np.linalg.norm(doc_embedding) * np.linalg.norm(doc_scores[j][1]))
                    max_similarity = max(max_similarity, similarity)

                # Calculate MMR score
                mmr_score = lambda_mult * query_similarity - (1 - lambda_mult) * max_similarity

                if mmr_score > best_score:
                    best_score = mmr_score
                    best_idx = i

            # Add the document with the best MMR score
            if best_idx != -1:
                selected_docs.append(doc_scores[best_idx][0])
                selected_indices.append(best_idx)
            else:
                break

        return selected_docs

    async def similarity_search(
        self,
        prompt: str,
        k: int = 15,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
        skip_reranking: bool = False,
        include_lexical: bool = False,
    ) -> list[Document]:
        """
        Perform a similarity search across all collections.

        Searches both the native LangChain collection (via vectorstore) and documents
        linked through the document_collections junction table, ensuring multi-collection
        membership is respected.

        Args:
                prompt: The query text
                k: Maximum number of documents to return
                collection_ids: Optional list of collection IDs to search in
                document_ids: Optional list of document IDs to restrict the search
                skip_reranking: If True, skip the reranking step and return raw results
                include_lexical: If True, also run the title/content lexical rescue
                        (`_apply_lexical_rescue`) on the `skip_reranking` collection path.
                        The full-rerank path always runs it; this opt-in extends it to
                        the skip-rerank path so the voice discovery tools
                        (search_books_by_topic / search_collection) surface a book whose
                        title matches but whose chunks rank low — the cross-language
                        "Cover-Up at Roswell" case. Kept opt-in so EnhancedTriModal and
                        other skip_reranking callers stay on the cheaper dense-only path.

        Returns:
                List of relevant Document objects, reranked by relevance
        """
        try:
            # Prepare query and get collection IDs
            prompt, collection_id_strs = await self._prepare_query_and_collections(prompt, collection_ids)

            # Cross-language query translation: if user asks in HR, also search in EN
            translated_prompt = None
            original_prompt = prompt
            # noinspection PyBroadException
            try:
                from src.main.service.rag.cross_language import translate_query_if_needed

                prompt, translated_prompt = await translate_query_if_needed(prompt)
                if prompt is None:
                    prompt = original_prompt
            except Exception as e:
                logger.debug("Cross-language translation failed (optional feature): %s", e)
            prompt = prompt or original_prompt  # ensure prompt is always str after translation attempt

            # Convert document_ids to strings if needed for filtering
            doc_id_strs = None
            if document_ids:
                doc_id_strs = [str(doc_id) for doc_id in document_ids]

            # Doc-scoped fast path: bypass HNSW + langchain filter pipeline
            # entirely. With HNSW the global top `ef_search` neighbours rarely
            # contain enough doc-scoped chunks, so langchain's asimilarity_search
            # silently returns 0 for most queries against a small doc inside a
            # large collection. The CTE materialises the scoped subset first.
            if doc_id_strs:
                primary_docs = await self._doc_scoped_similarity_search(prompt, doc_id_strs, k)
                results_combined: list[Document] = list(primary_docs)
                if translated_prompt:
                    translated_docs = await self._doc_scoped_similarity_search(translated_prompt, doc_id_strs, k)
                    results_combined = self._merge_and_deduplicate(results_combined, translated_docs)
                return results_combined[:k]

            # Retrieve from all collections in parallel, but throttled through
            # the global concurrency semaphore so a 25-collection workspace
            # doesn't exhaust PostgreSQL's connection pool. See
            # COLLECTION_RETRIEVAL_CONCURRENCY at module top.
            tasks = []

            for collection_id_str in collection_id_strs:
                vectorstore = self.vectorstores[collection_id_str]
                task = asyncio.create_task(_bounded_similarity_search(vectorstore, prompt, k))
                tasks.append(task)

            # Cross-language: also search with translated query (parallel, no extra latency).
            # Same throttling applies — without it the EN copy doubles the
            # in-flight count and pushes us straight into pool exhaustion.
            if translated_prompt:
                for collection_id_str in collection_id_strs:
                    vectorstore = self.vectorstores[collection_id_str]
                    task = asyncio.create_task(_bounded_similarity_search(vectorstore, translated_prompt, k))
                    tasks.append(task)

            if skip_reranking:
                # Return raw pgvector results without cross-encoder reranking.
                # Used by EnhancedTriModal which fuses all modalities first and reranks once at the end.
                results = await asyncio.gather(*tasks, return_exceptions=True)
                raw_docs = []
                # `tasks` holds original + translated passes (2 per collection
                # when cross-language fired), so map index back with modulo —
                # same overflow guard as _process_search_results.
                n_collections = len(collection_id_strs)
                for i, result in enumerate(results):
                    if isinstance(result, Exception):
                        coll_id = collection_id_strs[i % n_collections] if n_collections else "unknown"
                        logger.error("Error retrieving from collection %s: %s", coll_id, str(result))
                    else:
                        raw_docs.extend(result)

                # Also fetch documents linked via the junction table
                # noinspection PyTypeChecker
                junction_docs = await self._fetch_junction_table_embeddings(
                    prompt,
                    collection_id_strs,
                    k,
                    doc_id_strs,
                )
                raw_docs = self._merge_and_deduplicate(raw_docs, junction_docs)

                # Opt-in lexical rescue for the skip-rerank collection path.
                # The voice discovery tools (search_books_by_topic /
                # search_collection) pass include_lexical=True so a book whose
                # title matches but whose chunks rank low — the cross-language
                # "Cover-Up at Roswell" at vector rank ~1849 case — is still
                # surfaced. Default-off keeps EnhancedTriModal on dense-only.
                if include_lexical:
                    raw_docs = await self._apply_lexical_rescue(raw_docs, translated_prompt or prompt, collection_id_strs, k)
                return raw_docs[:k]

            # Gather dense results WITHOUT reranking — we rerank once at the end
            # over the full candidate set (dense + junction + lexical). Reranking
            # here AND again after the hybrid passes was double cross-encoder work
            # (~30s/pass under CPU contention); the first ranking was discarded.
            vectorstore_docs = await self._process_search_results(tasks, collection_id_strs, prompt, k=k, defer_rerank=True)

            # Also fetch documents linked via the document_collections junction table.
            # This ensures documents added to a collection via multi-collection membership
            # are included even if their embeddings are stored under a different LangChain collection.
            # noinspection PyTypeChecker
            junction_docs = await self._fetch_junction_table_embeddings(
                prompt,
                collection_id_strs,
                k,
                doc_id_strs,
            )
            candidate_docs = vectorstore_docs
            if junction_docs:
                candidate_docs = self._merge_and_deduplicate(candidate_docs, junction_docs)

            # Lexical (hybrid) pass: surface documents whose title/content
            # literally matches the query's key terms but that vector similarity
            # ranked too low to retrieve (distinctive names, exact titles, and
            # cross-language queries where the embedding misaligns).
            candidate_docs = await self._apply_lexical_rescue(candidate_docs, translated_prompt or prompt, collection_id_strs, k)

            # Single cross-encoder rerank over the full candidate set. The dense
            # results were deferred (defer_rerank=True above), so this is the ONE
            # and only rerank pass for this path — no longer a wasted double pass.
            extra = len(candidate_docs) - len(vectorstore_docs)
            if extra > 0:
                logger.info("Hybrid retrieval added %d extra documents (junction + lexical)", extra)
            return await self._rerank_documents_with_mmr(prompt, candidate_docs, k=k)

        except Exception as e:
            logger.error("Error during multi - collection processing: %s", str(e))
            return []

    # noinspection PyMethodMayBeStatic
    async def _doc_scoped_similarity_search(
        self,
        query: str,
        doc_id_strs: list[str],
        k: int,
    ) -> list[Document]:
        """
        Cosine similarity over a document-scoped subset, bypassing the HNSW index.

        Background: pgvector's HNSW operator scan first walks the index for the
        global top `ef_search` neighbours, then applies WHERE post-hoc. When the
        scoped doc has only a few hundred chunks inside a 40k+ collection, the
        initial HNSW frontier almost never contains them — the query silently
        returns 0/1 rows for any prompt that isn't already a near-perfect match
        (e.g. "Sun Tzu" hits because the book mentions him on every page, but
        "five elements" misses entirely).

        Forcing a MATERIALIZED CTE makes the planner build the filtered subset
        first, then run a sequential cosine over it — fast for ≤ a few thousand
        chunks and produces the correct top-k ordering.
        """
        try:
            from src.main.config.database import AsyncSessionLocal

            # Embed the query once
            qvec = await self.embeddings.aembed_query(query)
            qvec_str = "[" + ",".join(str(x) for x in qvec) + "]"

            async with AsyncSessionLocal() as session:
                rows = (
                    await session.execute(
                        text(
                            f"""
                            WITH filtered AS MATERIALIZED (
                                SELECT id, embedding, document, cmetadata
                                FROM {EMBEDDING_TABLE_NAME}
                                WHERE cmetadata->>'document_id' = ANY(:dids)
                            )
                            SELECT id, document, cmetadata,
                                   embedding <=> CAST(:qvec AS vector) AS distance
                            FROM filtered
                            ORDER BY distance ASC
                            LIMIT :k
                            """
                        ),
                        {"dids": doc_id_strs, "qvec": qvec_str, "k": k},
                    )
                ).all()

            docs = [Document(page_content=r.document, metadata=r.cmetadata or {}) for r in rows]
            logger.info(
                "Doc-scoped CTE search: query=%r doc_ids=%d k=%d -> %d docs",
                query[:60],
                len(doc_id_strs),
                k,
                len(docs),
            )
            return docs
        except Exception as e:
            logger.error("Doc-scoped similarity search failed: %s", str(e))
            return []

    async def _apply_lexical_rescue(
        self,
        base_docs: list[Document],
        lexical_query: str,
        collection_id_strs: list[str],
        k: int,
    ) -> list[Document]:
        """Merge title/content lexical-match documents into base_docs.

        The lexical (hybrid) half of retrieval: find documents whose title or
        content literally matches the query's salient terms (distinctive names,
        exact titles, cross-language queries where the embedding misaligns),
        hydrate their best chunks via the scoped CTE search, and merge into
        base_docs. Match on the English query when a translation exists. Returns
        base_docs unchanged when there are no lexical candidates. Shared by the
        full-rerank path and the opt-in skip-rerank path so both surface the
        same title-matched books.
        """
        lexical_doc_ids = await self._lexical_doc_candidates(lexical_query, collection_id_strs)
        if not lexical_doc_ids:
            return base_docs
        lexical_docs = await self._doc_scoped_similarity_search(lexical_query, lexical_doc_ids, k)
        if not lexical_docs:
            return base_docs
        # Lexical docs go FIRST. A title match is the strongest signal that a
        # book is about the topic (especially across a large multi-collection
        # workspace where dense top-k is dominated by noise from unrelated
        # collections). On the skip-rerank path the merged list is truncated to
        # `[:k]`; if lexical came second it would be cut away — exactly the bug
        # where the 5 title-matched "alien abductions" books were found but
        # never surfaced because dense already filled k. On the full-rerank
        # path order is irrelevant (the cross-encoder reorders), so leading
        # with lexical is safe there too.
        return self._merge_and_deduplicate(lexical_docs, base_docs)

    async def _lexical_doc_candidates(
        self,
        query: str,
        collection_id_strs: list[str],
        doc_limit: int = 5,
    ) -> list[str]:
        """Find documents whose title or content literally contains the query's
        salient terms, returning their document_ids ranked by match strength.

        This is the lexical half of hybrid retrieval. Vector similarity alone
        misses a book whose relevance is obvious from its title/name — e.g. the
        English book "Cover-Up at Roswell" sits at vector rank ~1849 for a
        cross-language query, but its title matches the query terms exactly.
        Title is full-text matched (English stemming, so "covers" hits
        "Cover-Up"); content uses the trigram GIN index (`ix_documents_content_trgm`)
        so the ILIKE scan stays fast. Title rank is weighted above content hits.
        """
        terms = _extract_salient_terms(query)
        if not terms or not collection_id_strs:
            return []
        # OR-semantics tsquery so a title containing ANY key term matches; ranked
        # by how many it covers. plainto/websearch use AND, which is too strict.
        or_tsquery = " | ".join(terms)
        try:
            from src.main.config.database import AsyncSessionLocal

            async with AsyncSessionLocal() as session:
                rows = (
                    await session.execute(
                        text(
                            """
                            SELECT doc_id, max(tr) AS rank FROM (
                                SELECT d.id::text AS doc_id,
                                       ts_rank(to_tsvector('english', coalesce(d.title, '')),
                                               to_tsquery('english', :orq)) AS tr
                                FROM documents d
                                WHERE d.collection_id = ANY(CAST(:colls AS uuid[]))
                                  AND to_tsvector('english', coalesce(d.title, '')) @@ to_tsquery('english', :orq)
                                UNION ALL
                                SELECT d.id::text AS doc_id, 0.0 AS tr
                                FROM documents d
                                WHERE d.collection_id = ANY(CAST(:colls AS uuid[]))
                                  AND to_tsvector('english', coalesce(d.content, '')) @@ to_tsquery('english', :orq)
                            ) u
                            GROUP BY doc_id
                            ORDER BY rank DESC
                            LIMIT :doc_limit
                            """
                        ).bindparams(
                            # Bind the collection list as a SINGLE array, not an
                            # expanded IN-list — SQLAlchemy otherwise rewrites
                            # `:colls` into `(:colls_1, …)`, breaking CAST(... uuid[]).
                            #
                            # Title + content full-text, UNION'd so EACH arm uses its
                            # own access path (a plain OR forced a seq-scan because
                            # the planner can't combine the content GIN index with
                            # the un-indexed title condition). Content matching is
                            # served by the ix_documents_content_fts GIN index added
                            # 2026-06-17; without it the content arm seq-scanned the
                            # 1.2 GB TOASTed column and timed out. Title matches rank
                            # above content-only (which gets rank 0). ~80 ms.
                            bindparam("colls", expanding=False),
                        ),
                        {"orq": or_tsquery, "colls": collection_id_strs, "doc_limit": doc_limit},
                    )
                ).all()
            doc_ids = [r.doc_id for r in rows]
            logger.info(
                "Lexical doc match: terms=%s -> %d docs (collections=%d)",
                terms,
                len(doc_ids),
                len(collection_id_strs),
            )
            return doc_ids
        except Exception as e:
            # Log with %r — some driver errors (asyncpg) have an empty str(),
            # which previously printed "...failed (optional): " with nothing after
            # the colon, hiding the real SQL error for a long time.
            logger.warning("Lexical doc candidate search failed (optional): %r", e)
            return []

    async def keyword_search(
        self,
        query: str,
        k: int = 10,
        collection_ids: list | None = None,
        **kwargs,
    ) -> list[Document]:
        """Lexical (keyword) chunk search — the sparse half of hybrid retrieval.

        Two-step so it stays fast WITHOUT a full-text index on the 2.3M-row chunk
        table: (1) find keyword-matched DOCUMENTS via the indexed title+content
        full-text (``_lexical_doc_candidates``), then (2) full-text-match CHUNKS
        only within those few documents — filtered by the ``ix_lpe_doc_chunk``
        btree, so the tsvector scan runs over a few thousand chunks, not millions.
        Falls back to the matched documents' opening chunks when the terms hit
        only the title. Returns langchain ``Document`` chunks (with cmetadata) so
        the sparse_search tool can cite them. Wired via ``hasattr(retriever,
        "keyword_search")`` in rag_retrieval_tools.sparse_search.
        """
        terms = _extract_salient_terms(query)
        collection_id_strs = [str(c) for c in (collection_ids or [])]
        if not terms or not collection_id_strs:
            return []
        or_tsquery = " | ".join(terms)
        # Step 1 — keyword-matched documents (served by the FTS indexes).
        doc_ids = await self._lexical_doc_candidates(query, collection_id_strs, doc_limit=max(k, 8))
        if not doc_ids:
            return []
        try:
            from src.main.config.database import AsyncSessionLocal

            async with AsyncSessionLocal() as session:
                # Step 2 — chunks containing the terms, within the matched docs.
                rows = (
                    await session.execute(
                        text(
                            """
                            SELECT id, document, cmetadata,
                                   ts_rank(to_tsvector('english', document),
                                           to_tsquery('english', :orq)) AS rank
                            FROM langchain_pg_embedding
                            WHERE cmetadata->>'document_id' = ANY(:dids)
                              AND to_tsvector('english', document) @@ to_tsquery('english', :orq)
                            ORDER BY rank DESC
                            LIMIT :k
                            """
                        ).bindparams(bindparam("dids", expanding=False)),
                        {"orq": or_tsquery, "dids": doc_ids, "k": k},
                    )
                ).all()
                if not rows:
                    # Terms matched only the title — return the docs' opening chunks.
                    rows = (
                        await session.execute(
                            text(
                                """
                                SELECT id, document, cmetadata, 0.0 AS rank
                                FROM langchain_pg_embedding
                                WHERE cmetadata->>'document_id' = ANY(:dids)
                                ORDER BY (cmetadata->>'document_id'),
                                         (cmetadata->>'chunk_index')::int
                                LIMIT :k
                                """
                            ).bindparams(bindparam("dids", expanding=False)),
                            {"dids": doc_ids, "k": k},
                        )
                    ).all()

            docs = []
            for r in rows:
                md = dict(r.cmetadata or {})
                md["bm25_score"] = float(r.rank or 0.0)
                docs.append(Document(page_content=r.document, metadata=md))
            logger.info("keyword_search: query=%r -> %d chunks from %d matched docs", query[:60], len(docs), len(doc_ids))
            return docs
        except Exception as e:
            logger.warning("keyword_search failed: %r", e)
            return []

    async def _fetch_junction_table_embeddings(
        self,
        _query: str,
        collection_id_strs: list[str],
        k: int,
        doc_id_strs: list[str] | None = None,
    ) -> list[Document]:
        """
        Fetch embeddings for documents linked via the document_collections junction table.

        When a document belongs to multiple collections, its embeddings may be stored
        under a different LangChain collection than the one being searched. This method
        finds those embeddings by querying document_collections for document_ids belonging
        to the requested collections, then fetching matching embeddings regardless of which
        LangChain collection they are stored under.

        Args:
            _query: The query text (unused for now; results are merged and reranked by caller)
            collection_id_strs: Collection IDs being searched
            k: Maximum number of results to return
            doc_id_strs: Optional document ID filter (further restricts results)

        Returns:
            List of Document objects from junction-table-linked documents
        """
        try:
            from src.main.config.database import AsyncSessionLocal

            async with AsyncSessionLocal() as session:
                # Build the base query: find embeddings whose document_id is linked to
                # any of the requested collections via document_collections, but whose
                # LangChain collection_id does NOT match (those are already found by
                # the normal vectorstore search).
                params: dict[str, Any] = {
                    "collection_ids": collection_id_strs,
                }

                # Subquery: get document_ids from the junction table for the requested collections
                junction_subquery = """
                    SELECT dc.document_id::text
                    FROM document_collections dc
                    WHERE dc.collection_id::text = ANY(:collection_ids)
                """

                # Exclude embeddings already covered by the normal vectorstore path:
                # those whose LangChain collection name matches any of the requested collection IDs
                exclusion_clause = f"""
                    AND e.collection_id NOT IN (
                        SELECT c.uuid FROM {COLLECTION_TABLE_NAME} c
                        WHERE c.name = ANY(:collection_ids)
                    )
                """

                # Optional document_id filter
                doc_filter_clause = ""
                if doc_id_strs:
                    doc_filter_clause = "AND e.cmetadata->>'document_id' = ANY(:doc_ids)"
                    params["doc_ids"] = doc_id_strs

                sql = text(f"""
                    SELECT e.document, e.cmetadata
                    FROM {EMBEDDING_TABLE_NAME} e
                    WHERE e.cmetadata->>'document_id' IN ({junction_subquery})
                    {exclusion_clause}
                    {doc_filter_clause}
                    LIMIT :limit
                """)
                params["limit"] = k

                result = await session.execute(sql, params)
                rows = result.fetchall()

                if rows:
                    logger.info(
                        "Junction table query found %d additional embeddings for collections %s",
                        len(rows),
                        collection_id_strs,
                    )

                docs = []
                for row in rows:
                    metadata = row.cmetadata or {}
                    docs.append(Document(page_content=row.document, metadata=metadata))
                return docs

        except Exception as e:
            logger.warning("Junction table embedding lookup failed (non-fatal): %s", str(e))
            return []

    @staticmethod
    def _merge_and_deduplicate(
        primary: list[Document],
        secondary: list[Document],
    ) -> list[Document]:
        """
        Merge two document lists, deduplicating by embedding ID or content hash.

        Primary documents take precedence. Secondary documents are only added if
        they are not already present in the primary list.

        Args:
            primary: Primary document list (from vectorstore search)
            secondary: Secondary document list (from junction table query)

        Returns:
            Merged and deduplicated list with primary documents first
        """
        if not secondary:
            return primary

        # Build a set of seen identifiers from primary results
        seen = set()
        for doc in primary:
            # Use embedding chunk_id if available, otherwise fall back to content hash
            doc_key = doc.metadata.get("chunk_id") or doc.metadata.get("document_id", "") + ":" + str(hash(doc.page_content))
            seen.add(doc_key)

        merged = list(primary)
        for doc in secondary:
            doc_key = doc.metadata.get("chunk_id") or doc.metadata.get("document_id", "") + ":" + str(hash(doc.page_content))
            if doc_key not in seen:
                seen.add(doc_key)
                merged.append(doc)

        return merged

    async def similarity_search_with_metadata_filter(
        self,
        query: str,
        metadata_filter: dict[str, Any],
        k: int = 15,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
    ) -> list[Document]:
        """
        Perform a similarity search with metadata filtering.

        Args:
                query: The query text
                metadata_filter: A dictionary of metadata field / value pairs to filter by
                k: Number of results to return (default=15)
                collection_ids: Optional list of collection IDs to search in
                document_ids: Optional list of document IDs to search within

        Returns:
                List of Document objects that match both the query and metadata filter
        """
        try:
            # Prepare query and get collection IDs
            query, collection_id_strs = await self._prepare_query_and_collections(query, collection_ids)

            # If document_ids are provided, add them to the filter
            if document_ids and isinstance(metadata_filter, dict):
                # Convert UUIDs to strings
                doc_ids = [str(doc_id) if isinstance(doc_id, UUID) else doc_id for doc_id in document_ids]

                # Add to existing filter
                if "$and" in metadata_filter:
                    metadata_filter["$and"].append({"document_id": {"$in": doc_ids}})
                else:
                    metadata_filter = {"$and": [metadata_filter, {"document_id": {"$in": doc_ids}}]}

            # Log the filter being used
            logger.info("Performing similarity search with metadata filter: %s", metadata_filter)

            # Execute searches on all collections in parallel
            all_results = []
            tasks = []

            for collection_id_str in collection_id_strs:
                vectorstore = self.vectorstores[collection_id_str]
                # Throttled — see COLLECTION_RETRIEVAL_CONCURRENCY for the
                # pool-exhaustion history. Filter-aware variant of the helper.
                task = asyncio.create_task(_bounded_similarity_search_with_filter(vectorstore, query, k, metadata_filter))
                tasks.append(task)

            # Wait for all tasks to complete
            results_by_collection = await asyncio.gather(*tasks, return_exceptions=True)

            # Process results
            for i, result in enumerate(results_by_collection):
                if isinstance(result, Exception):
                    logger.error(
                        "Error searching collection %s: %s",
                        collection_id_strs[i],
                        str(result),
                    )
                    continue

                for doc in result:
                    if "collection_id" not in doc.metadata:
                        doc.metadata["collection_id"] = collection_id_strs[i]
                all_results.extend(result)

            # Rerank documents using MMR algorithm if we have multiple collections
            if all_results and len(collection_id_strs) > 1:
                return await self._rerank_documents_with_mmr(query, all_results, k=k)
            elif all_results:
                # If only one collection, just return top k
                return all_results[:k]
            else:
                logger.warning("No documents matched the metadata filter")
                return []
        except Exception as e:
            logger.error("Error during similarity search with metadata filter: %s", str(e))
            return []

    async def _prepare_query_and_collections(self, query: str, collection_ids: list[UUID] | None = None) -> tuple:
        """
        Prepare the query text and collection IDs for search operations (with lazy vectorstore initialization).

        Args:
                query: The query text to prepare
                collection_ids: Optional list of collection IDs to search in

        Returns:
                Tuple of (prepared_query, collection_id_strings)
        """
        # Check if the query is too long for the embedding model context window
        prepared_query = query
        if len(prepared_query) > 1600:  # Approximately 400 tokens
            logger.warning("Query exceeds recommended length for embedding. Truncating to first 1600 characters.")
            prepared_query = prepared_query[:1600]

        # Convert collection_ids to strings if provided
        # Expand parent collections to include all descendants
        collection_id_strs = []
        if collection_ids:
            expanded = set(collection_ids)
            # noinspection PyBroadException
            try:
                from src.main.config.database import SessionLocal
                from src.main.service.collection_workspace_cache import get_child_collection_ids

                with SessionLocal() as db:
                    for cid in list(collection_ids):
                        children = get_child_collection_ids(db, cid)
                        expanded.update(children)
            except Exception as e:
                logger.debug("Collection ID expansion failed (using original set): %s", e)
            collection_id_strs = [str(cid) for cid in expanded]
            # Ensure vectorstores exist for requested collections (lazy initialization)
            for cid in collection_id_strs:
                await self._ensure_vectorstore(cid)
            # Filter to only collections that have vectorstores
            collection_id_strs = [cid for cid in collection_id_strs if cid in self.vectorstores]

        # If no collections specified or none valid, use default
        if not collection_id_strs:
            await self._ensure_vectorstore(self.default_collection_id)
            collection_id_strs = [self.default_collection_id]

        return prepared_query, collection_id_strs

    def _matches_metadata_filter(self, metadata: dict[str, Any], filter_dict: dict[str, Any]) -> bool:
        """
        Check if metadata matches the given filter.
        Supports basic operators like $in and nested conditions.

        Args:
                metadata: Document metadata
                filter_dict: Filter specification

        Returns:
                True if metadata matches the filter
        """
        # Handle $and operator
        if "$and" in filter_dict:
            return all(self._matches_metadata_filter(metadata, subfilter) for subfilter in filter_dict["$and"])

        # Handle $or operator
        if "$or" in filter_dict:
            return any(self._matches_metadata_filter(metadata, subfilter) for subfilter in filter_dict["$or"])

        # Handle field-level filters
        for key, value in filter_dict.items():
            # Skip logical operators already handled
            if key in ["$and", "$or"]:
                continue

            # If a field doesn't exist in metadata, it doesn't match
            if key not in metadata:
                return False

            # Handle operators
            if isinstance(value, dict) and all(k.startswith("$") for k in value):
                for op, op_value in value.items():
                    if (op == "$eq" and metadata[key] != op_value) or (op != "$eq" and op == "$in" and metadata[key] not in op_value):
                        return False
                        # Add more operators as needed
            elif metadata[key] != value:
                return False

        return True

    # noinspection PyMethodOverriding
    async def delete_documents(self, document_ids: list[UUID] = None, collection_ids: list[UUID] | None = None) -> bool:  # type: ignore[override]
        """
        Delete documents from the vector store.

        Args:
                document_ids: List of document IDs to delete
                collection_ids: Optional list of collection IDs to delete from

        Returns:
                True if the documents were deleted successfully, False otherwise
        """
        if not document_ids:
            logger.warning("No document IDs provided for deletion")
            return False

        try:
            # Convert document_ids to strings
            doc_id_strings = [str(doc_id) for doc_id in document_ids]

            # Determine which collections to delete from
            if collection_ids:
                # Convert collection_ids to strings
                collection_id_strs = [str(cid) for cid in collection_ids]

                # Ensure vectorstores are initialized for these collections (lazy loading)
                for cid in collection_id_strs:
                    await self._ensure_vectorstore(cid)

                # Now filter to valid ones (after ensuring they exist)
                target_collections = [cid for cid in collection_id_strs if cid in self.vectorstores]

                if not target_collections:
                    # Vectorstores not available - try direct SQL deletion as fallback
                    logger.warning(
                        "No vectorstores available for collection IDs: %s. Attempting direct SQL deletion.",
                        collection_id_strs,
                    )
                    return await self._direct_sql_delete_embeddings(collection_id_strs, doc_id_strings)
            else:
                # If no collections specified, use all available collections
                target_collections = list(self.vectorstores.keys())

            # Track overall success
            overall_success = False

            # Delete from each target collection
            for collection_id_str in target_collections:
                vectorstore = self.vectorstores[collection_id_str]

                # Log the deletion attempt
                logger.info(
                    "Attempting to delete embeddings for document_ids: %s from collection: %s",
                    doc_id_strings,
                    collection_id_str,
                )

                success = False
                delete_filter = {"document_id": {"$in": doc_id_strings}}

                # Check if vectorstore is using async mode (ScrapalotPGVector uses async connections)
                is_async_mode = isinstance(vectorstore, ScrapalotPGVector)

                # --- Attempt 1: Try async delete first if in async mode ---
                if is_async_mode and hasattr(vectorstore, "adelete"):
                    try:
                        logger.debug(
                            "Attempting deletion using asynchronous vectorstore.adelete for collection %s...",
                            collection_id_str,
                        )
                        # adelete() may return None even on success, so we'll verify with direct SQL check
                        deleted = await vectorstore.adelete(
                            ids=None,  # Use filter instead of specific embedding IDs
                            filter=delete_filter,
                        )

                        # Since adelete() often returns None, we treat no exception as potential success
                        # We'll verify with direct SQL in the next step
                        logger.debug(
                            "Asynchronous vectorstore.adelete completed (returned: %s), will verify with direct SQL",
                            deleted,
                        )
                        # Don't mark as success yet - go straight to SQL verification

                    except Exception as e:
                        logger.debug(
                            "Asynchronous vectorstore.adelete failed for collection %s: %s. Will use direct SQL deletion.",
                            collection_id_str,
                            str(e),
                        )

                # --- Attempt 2: Try sync delete in thread (only if not in async mode) ---
                elif not is_async_mode and hasattr(vectorstore, "delete"):
                    try:
                        logger.debug(
                            "Attempting deletion using synchronous vectorstore.delete in thread for collection %s...",
                            collection_id_str,
                        )
                        # Run the synchronous delete method in a separate thread
                        await asyncio.to_thread(
                            vectorstore.delete,
                            ids=None,
                            filter=delete_filter,
                        )
                        logger.info(
                            "Synchronous vectorstore.delete completed for filter: %s in collection %s",
                            delete_filter,
                            collection_id_str,
                        )
                        success = True  # Assume success if no exception

                    except Exception as e:
                        logger.debug(
                            "Synchronous vectorstore.delete failed for collection %s: %s. Will use direct SQL deletion.",
                            collection_id_str,
                            str(e),
                        )

                # --- Attempt 3: Direct SQL Deletion (primary method for async mode, fallback for sync) ---
                if not success:
                    if is_async_mode:
                        logger.debug(
                            "Using direct SQL deletion for async mode collection %s (adelete returns None, using SQL for verification).",
                            collection_id_str,
                        )
                    else:
                        logger.warning(
                            "Standard deletion methods failed for collection %s. Attempting direct database deletion.",
                            collection_id_str,
                        )
                    try:
                        async_engine = get_shared_async_engine(self.connection_string)

                        # Main execution with connection
                        async with async_engine.begin() as conn:  # Use begin() for transaction support
                            # Step 1: Get collection UUID as string
                            collection_uuid_str = await self._get_collection_uuid(conn, collection_id_str)

                            if not collection_uuid_str:
                                logger.error(
                                    "Could not find collection UUID for name: %s",
                                    collection_id_str,
                                )
                                continue

                            # Step 2: Delete embeddings
                            deleted_count = await self._delete_embeddings(
                                conn,
                                collection_uuid_str,
                                doc_id_strings,
                                collection_id_str,
                            )

                            if deleted_count > 0:
                                logger.info(
                                    "Successfully deleted %d embeddings from collection %s",
                                    deleted_count,
                                    collection_id_str,
                                )
                                success = True
                            else:
                                logger.warning(
                                    "No embeddings were deleted from collection %s",
                                    collection_id_str,
                                )

                    except Exception as e:
                        logger.exception("Direct SQL deletion failed for collection %s: %s", collection_id_str, str(e))

                # Update overall success flag
                overall_success = overall_success or success

                if success:
                    logger.info(
                        "Successfully deleted documents from collection %s",
                        collection_id_str,
                    )
                else:
                    logger.warning(
                        "Failed to delete documents from collection %s",
                        collection_id_str,
                    )

            return overall_success

        except Exception as e:
            logger.exception("Error during document deletion: %s", str(e))
            return False

    async def _direct_sql_delete_embeddings(self, collection_id_strs: list[str], doc_id_strings: list[str]) -> bool:
        """
        Delete embeddings directly via SQL when vectorstores aren't available.

        This is a fallback method for when the collection exists in langchain tables
        but isn't in our collections_metadata (e.g., orphaned embeddings).

        Args:
            collection_id_strs: List of collection IDs (our collection UUIDs stored in langchain name column)
            doc_id_strings: List of document IDs to delete

        Returns:
            True if any embeddings were deleted, False otherwise
        """
        overall_success = False

        try:
            async_engine = get_shared_async_engine(self.connection_string)

            async with async_engine.begin() as conn:
                for collection_id_str in collection_id_strs:
                    logger.info(
                        "Attempting direct SQL deletion for collection: %s, documents: %s",
                        collection_id_str,
                        doc_id_strings,
                    )

                    # Get the LangChain collection UUID from the name column
                    collection_uuid_str = await self._get_collection_uuid(conn, collection_id_str)

                    if not collection_uuid_str:
                        logger.warning(
                            "Collection '%s' not found in %s table",
                            collection_id_str,
                            COLLECTION_TABLE_NAME,
                        )
                        continue

                    # Delete embeddings using the LangChain collection UUID
                    deleted_count = await self._delete_embeddings(
                        conn,
                        collection_uuid_str,
                        doc_id_strings,
                        collection_id_str,
                    )

                    if deleted_count > 0:
                        logger.info(
                            "Successfully deleted %d embeddings from collection %s via direct SQL",
                            deleted_count,
                            collection_id_str,
                        )
                        overall_success = True
                    else:
                        logger.warning(
                            "No embeddings found to delete for documents %s in collection %s",
                            doc_id_strings,
                            collection_id_str,
                        )

        except Exception as e:
            logger.exception("Direct SQL deletion failed: %s", str(e))

        return overall_success

    @staticmethod
    async def _get_collection_uuid(conn, collection_name):
        """
        Get collection UUID by name from the database.

        In LangChain's PGVector, our collection ID is stored in the 'name' column,
        and we need to get the 'uuid' column which is what langchain_pg_embedding references.

        Args:
                conn: SQLAlchemy connection
                collection_name: Name of the collection (our collection ID)

        Returns:
                String representation of the UUID or None if not found
        """
        try:
            query = f"SELECT uuid FROM {COLLECTION_TABLE_NAME} WHERE name = :name"
            result = await conn.execute(text(query), {"name": collection_name})

            # Use fetchone() instead of first() for async SQLAlchemy
            row = result.fetchone()

            if row is None:
                return None

            # Extract and convert to string immediately
            return str(row[0])
        except Exception as ex:
            logger.exception("Error fetching collection UUID: %s", str(ex))
            return None

    @staticmethod
    async def _delete_embeddings(conn, collection_uuid_str, doc_id_strings, collection_id_str):
        """
        Delete embeddings by document IDs from the database.

        Args:
                conn: SQLAlchemy connection
                collection_uuid_str: UUID of the collection as string (from langchain_pg_collection.uuid)
                doc_id_strings: List of document IDs as strings
                collection_id_str: Collection ID string for logging

        Returns:
                Number of deleted embeddings
        """
        try:
            query = f"""
                DELETE FROM {EMBEDDING_TABLE_NAME}
                WHERE collection_id::text = :collection_id
                AND cmetadata->>'document_id' = ANY(:doc_ids)
            """
            params = {"collection_id": collection_uuid_str, "doc_ids": doc_id_strings}
            result = await conn.execute(text(query), params)
            deleted_count = result.rowcount
            logger.info(
                "Deleted %d embeddings from collection %s",
                deleted_count,
                collection_id_str,
            )
            return deleted_count
        except Exception as e:
            logger.exception("Error deleting embeddings: %s", str(e))
            return 0

    @staticmethod
    async def _filter_documents(
        documents: list[Document],
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
    ) -> list[Document]:
        """
        Filter documents by collection_ids and document_ids.

        Args:
            documents: List of documents to filter
            collection_ids: Optional list of collection IDs to filter by
            document_ids: Optional list of document IDs to filter by

        Returns:
            Filtered list of documents
        """
        filtered_docs = documents

        # Filter by collection_ids if provided
        if collection_ids:
            # Convert UUIDs to strings for comparison
            collection_id_strs = [str(cid) for cid in collection_ids]
            filtered_docs = [doc for doc in filtered_docs if doc.metadata.get("collection_id") in collection_id_strs]

            if not filtered_docs:
                logger.warning("No documents found for collection_ids: %s", collection_ids)
                return []

        # Filter by document_ids if provided
        if document_ids:
            doc_id_strs = [str(doc_id) for doc_id in document_ids]
            filtered_docs = [doc for doc in filtered_docs if doc.metadata.get("document_id") in doc_id_strs]

            if not filtered_docs:
                logger.warning("No documents match the specified document_ids: %s", document_ids)
                return []

        return filtered_docs

    async def similarity_search_by_vector(
        self,
        embedding,
        k: int = 15,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
    ):
        """
        Optimized vector similarity search using pgvector's native vector operations.

        This overrides the base class method to avoid fetching all documents and
        computing similarities in Python. Instead, it uses PostgreSQL's pgvector
        extension for efficient similarity search directly in the database.

        Args:
            embedding: Query embedding vector
            k: Number of top results to return
            collection_ids: Optional list of collection IDs to filter by
            document_ids: Optional list of document IDs to filter by

        Returns:
            List of top k similar documents
        """
        try:
            if not collection_ids:
                logger.warning("No collection_ids provided for similarity_search_by_vector")
                return []

            # Convert embedding to list if it's a numpy array
            if hasattr(embedding, "tolist"):
                embedding_list = embedding.tolist()
            else:
                embedding_list = list(embedding)

            all_results = []
            collection_id_strs = [str(cid) for cid in collection_ids]

            # Search each collection's vectorstore
            for collection_id_str in collection_id_strs:
                # Ensure vectorstore exists (create on-demand if needed)
                if not await self._ensure_vectorstore(collection_id_str):
                    logger.warning("Collection %s not available for search", collection_id_str)
                    continue

                vectorstore = self.vectorstores[collection_id_str]

                # Use pgvector's native similarity search with the embedding vector
                if hasattr(vectorstore, "asimilarity_search_by_vector"):
                    results = await vectorstore.asimilarity_search_by_vector(
                        embedding=embedding_list,
                        k=k * 2,  # Get more results for filtering
                    )
                else:
                    # Fallback: use similarity search with a dummy query
                    # This is less efficient but still better than fetching all docs
                    logger.warning("Vectorstore doesn't support asimilarity_search_by_vector, using fallback")
                    results = await vectorstore.asimilarity_search("", k=k * 2)

                all_results.extend(results)

            # Filter by document_ids if provided
            if document_ids:
                doc_id_strs = [str(doc_id) for doc_id in document_ids]
                all_results = [doc for doc in all_results if doc.metadata.get("document_id") in doc_id_strs]

            # Return top k results
            return all_results[:k]

        except Exception as e:
            logger.error("Error in PGVector similarity_search_by_vector: %s", str(e))
            raise

    @classmethod
    async def create(cls, config: dict, *, base_connection_string: str) -> "PGVectorRetriever":
        """
        Legacy class method for backward compatibility. Will be deprecated in future versions.
        Use the factory method Retriever.create_retriever() instead.

        Args:
                config: The application configuration dictionary
                base_connection_string: PostgreSQL connection string

        Returns:
                A new instance of PGVectorRetriever
        """
        # Create an empty instance with just the config
        instance = cls(config=config)
        # Initialize it with the provided parameters
        await instance.initialize_retriever(config, base_connection_string=base_connection_string)
        return instance


class DummyVectorStore:
    """A test double vector store that can be used when pgvector is not available"""

    def __init__(self, collection_id, collection_name):
        self.collection_id = collection_id
        self.collection_name = collection_name
        logger.warning(
            "Using dummy vector store for collection %s - pgvector extension not available",
            collection_name,
        )

    @staticmethod
    async def asimilarity_search(_query, _k=4, **_kwargs):
        """Return empty results when vector search is not available."""
        logger.warning("Vector search requested but pgvector extension is not available")
        return []

    @staticmethod
    async def add_documents(documents, **_kwargs):
        """Do nothing when vector storage is not available."""
        logger.warning(
            "Attempted to add %d documents but pgvector extension is not available",
            len(documents),
        )
        return []

    @staticmethod
    async def delete(**_kwargs):
        """Do nothing when vector storage is not available."""
        logger.warning("Attempted to delete documents but pgvector extension is not available")
        return True
