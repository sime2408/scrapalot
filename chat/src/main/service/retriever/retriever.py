from abc import ABC, abstractmethod
import re
from typing import TYPE_CHECKING, Any
from uuid import UUID

if TYPE_CHECKING:
    from src.main.service.retriever.retriever_pgvector import PGVectorRetriever

# In LangChain v1.x, retrievers moved to langchain-classic package
from langchain_classic.retrievers.document_compressors import LLMChainExtractor
from langchain_classic.retrievers.ensemble import EnsembleRetriever as LangchainEnsembleRetriever
from langchain_core.documents import Document
import numpy as np

from src.main.service.llm.llm_factory import get_embeddings_model, get_llm_model
from src.main.service.retriever.runnable_adapter import RunnableRetrieverAdapter
from src.main.utils.config.loader import get_model_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class Retriever(ABC):
    # Class-level model cache for sharing pre-warmed models across instances
    _shared_embeddings_model = None
    _shared_llm_model = None
    _shared_models_initialized = False

    # noinspection SqlResolve

    def __init__(self, config=None):
        self.config = config or {}

        # Defer all heavy initialization to avoid blocking startup
        # Models will be initialized when actually needed
        self.embeddings_model = None
        self.llm_model = None
        logger.info("Retriever base class initialized (models will be loaded on demand)")

        # Store a flag to track if models have been initialized
        self._models_initialized = False

    @staticmethod
    def _merge_config_with_kwargs(config: dict[str, Any] | None, **kwargs) -> dict[str, Any]:
        """
        Merge config dict with kwargs, extracting model_name and provider_type.

        This utility method reduces code duplication across retriever subclasses.

        Args:
            config: Base configuration dictionary
            **kwargs: Additional keyword arguments that may contain model_name or provider_type

        Returns:
            Merged configuration dictionary
        """
        merged: dict[str, Any] = config or {}
        if "model_name" in kwargs:
            merged["model_name"] = kwargs["model_name"]
        if "provider_type" in kwargs:
            merged["provider_type"] = kwargs["provider_type"]
        return merged

    async def _initialize_models_on_demand(self):
        """Initialize models on demand when they're actually needed."""
        if self._models_initialized:
            return

        # Check if we can use shared models that were pre-warmed
        if Retriever._shared_models_initialized:
            logger.info("📦 Using pre - warmed shared models for faster initialization")
            self.embeddings_model = Retriever._shared_embeddings_model
            self.llm_model = Retriever._shared_llm_model
            self._models_initialized = True
            return

        try:
            logger.info("🔄 Initializing retriever models on demand...")

            # Get the database session
            import torch

            from src.main.config.database import SessionLocal

            with SessionLocal() as db:
                # Try to use globally cached embedding model first (preloaded at startup)
                try:
                    from src.main.service.llm.embedding_cache import get_embedding_cache

                    embedding_cache = get_embedding_cache()

                    if embedding_cache.is_initialized():
                        # Use the cached embedding model (already hardware-optimized)
                        cached_model_name = embedding_cache.get_model_name()
                        logger.info("Using globally cached embedding model: %s (no loading needed)", cached_model_name)
                        self.embeddings_model = embedding_cache.get_embedding_model()
                    else:
                        # Fallback: load on-demand if cache not initialized (shouldn't happen in production)
                        logger.warning("Global embedding cache not initialized, loading model on-demand")
                        from src.main.utils.config.loader import resolved_config
                        from src.main.utils.gpu.devices import is_gpu_available

                        if is_gpu_available():
                            # Use GPU-optimized embedding model (supports NVIDIA, AMD, Intel, Apple)
                            embedding_model = resolved_config.get("defaults", {}).get("embedding", {}).get("embedding_model")
                            logger.info("GPU available, using embedding model from config: %s", embedding_model)
                        else:
                            # Use CPU-optimized embedding model
                            embedding_model = resolved_config.get("defaults", {}).get("embedding", {}).get("cpu_fallback_model")
                            logger.info("No GPU available, using CPU embedding model from config: %s", embedding_model)

                        self.embeddings_model = get_embeddings_model(model_name=embedding_model)
                except Exception as e:
                    logger.error("Failed to initialize embedding model: %s", str(e))
                    raise

                # Use the user's selected model from config if provided
                # Otherwise fall back to searching for a reasoning model
                model_name = self.config.get("model_name")
                provider_type = self.config.get("provider_type")

                if model_name and provider_type:
                    # Use the model specified in config (user's selected chat model)
                    logger.info("Using user-selected model from config: %s (Provider: %s)", model_name, provider_type)

                    kwargs = {}
                    if self.config.get("api_base"):
                        kwargs["base_url"] = self.config["api_base"]
                    if self.config.get("api_key"):
                        kwargs["api_key"] = self.config["api_key"]

                    self.llm_model = await get_llm_model(model_name=str(model_name), provider_type=str(provider_type), **kwargs)
                else:
                    # No model specified in config - fall back to default chat model
                    logger.warning("⚠️ No model specified in config. Falling back to default chat model from config.")
                    try:
                        model_config = await get_model_config(model_type="chat", db=db)
                        if model_config and model_config.get("model"):
                            self.llm_model = await get_llm_model(
                                model_name=model_config["model"],
                                provider_type=model_config.get("provider"),
                            )
                        else:
                            logger.error("🚨 CRITICAL: Could not load any chat model from config.")
                            self.llm_model = None
                    except Exception as e:
                        logger.exception("🚨 CRITICAL: Error loading fallback model: %s", str(e))
                        self.llm_model = None

            self._models_initialized = True

            # Store models in shared cache for other retriever instances
            if not Retriever._shared_models_initialized:
                Retriever._shared_embeddings_model = self.embeddings_model
                Retriever._shared_llm_model = self.llm_model
                Retriever._shared_models_initialized = True
                logger.info("💾 Cached models for sharing across retriever instances")

            logger.info("✔️ Retriever models initialized successfully on demand")

        except Exception as e:
            # Get default values from configuration
            logger.warning("Error setting up models from database: %s. Using defaults.", str(e))

            # Initialize embedding model
            model_config = await get_model_config(model_type="embeddings", db=db)
            self.embeddings_model = get_embeddings_model(model_name=model_config["model"])

            # Initialize LLM model based on hardware capabilities
            import torch

            fallback_model_type = "reasoning" if torch.cuda.is_available() else "chat"
            logger.info("Using %s model as final fallback", fallback_model_type)
            model_config = await get_model_config(model_type=fallback_model_type, db=db)
            self.llm_model = await get_llm_model(model_name=model_config["model"], provider_type=model_config["provider"])
            self._models_initialized = True

            # Store fallback models in shared cache too
            if not Retriever._shared_models_initialized:
                Retriever._shared_embeddings_model = self.embeddings_model
                Retriever._shared_llm_model = self.llm_model
                Retriever._shared_models_initialized = True
                logger.info("💾 Cached fallback models for sharing across retriever instances")

    @abstractmethod
    async def get_vectorstore(self):
        pass

    @abstractmethod
    async def get_all_documents(self) -> list[Document]:
        pass

    @abstractmethod
    async def process(
        self,
        prompt: str,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
    ) -> list[Document]:
        """
        Process a query and return relevant documents from one or more collections.

        Args:
                prompt: The query text to process
                collection_ids: Optional list of collection IDs to search within
                document_ids: Optional list of document IDs to search within

        Returns:
                List of relevant documents
        """

    @abstractmethod
    async def close(self):
        pass

    @abstractmethod
    async def similarity_search_with_metadata_filter(
        self,
        query: str,
        metadata_filter: dict[str, Any],
        k: int = 15,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
    ) -> list[Document]:
        """
        Search for documents similar to a query with additional metadata filtering.

        Args:
                query: The search query
                metadata_filter: A dictionary of metadata filters to apply. Supports advanced operators:
                        - Equality: {"field": value}
                        - Comparison: {"field": {"$gt": value}}, {"field": {"$lt": value}}, etc.
                        - Regex: {"field": {"$regex": pattern}}
                        - In: {"field": {"$in": [value1, value2, ...]}}
                        - Logical: {"$and": [filter1, filter2, ...]}, {"$or": [filter1, filter2, ...]}
                k: The number of documents to return
                collection_ids: Optional list of collection IDs to search within
                document_ids: Optional list of document IDs to search within

        Returns:
                List of documents that match both the semantic query and metadata filters
        """

    @abstractmethod
    async def add_documents(self, documents: list[Document], collection_ids: list[UUID] | None = None) -> None:
        """
        Add documents to the retriever's storage with the specified collection IDs.

        Args:
                documents: List of documents to add to the retriever
                collection_ids: Optional list of collection IDs to group documents

        Returns:
                None
        """

    @abstractmethod
    async def delete_documents(
        self,
        document_ids: list[UUID] = None,
        collection_ids: list[UUID] | None = None,
    ) -> None:
        """
        Delete documents from the retriever's storage based on document IDs or collection IDs.

        Args:
                document_ids: List of document IDs to delete
                collection_ids: Optional list of collection IDs to delete all documents from collections

        Returns:
                None
        """

    async def score_relevance(self, query: str, documents: list[Document]) -> list[tuple[Document, float]]:
        try:
            # Ensure models are initialized before use
            await self._initialize_models_on_demand()

            # Check if LLM model is available and properly initialized
            if not self.llm_model or not hasattr(self.llm_model, "ainvoke"):
                logger.debug("LLM model not available or doesn't support ainvoke, using default scores")
                return [(doc, 0.7) for doc in documents]

            scored_docs = []
            for doc in documents:
                prompt = f"""On a scale of 0 to 1, how relevant is the following document to the query?
Query: {query}
Document: {doc.page_content[:500]}
Relevance score:"""
                try:
                    # Use ainvoke like the rest of the codebase
                    from langchain_core.messages import HumanMessage

                    messages = [HumanMessage(content=prompt)]

                    # Call ainvoke with the messages
                    response = await self.llm_model.ainvoke(messages)

                    # Try to extract a numeric score from the response
                    score_text = response.content.strip() if hasattr(response, "content") else str(response).strip()
                    try:
                        score = float(score_text)
                        # Ensure the score is between 0 and 1
                        score = max(0.0, min(1.0, score))
                    except (ValueError, TypeError):
                        logger.debug(
                            "Could not parse score from LLM response: '%s'. Using default score of 0.7.",
                            score_text,
                        )
                        score = 0.7
                except Exception as e:
                    logger.debug(
                        "Error scoring document relevance: %s. Using default score of 0.7.",
                        str(e),
                    )
                    score = 0.7

                scored_docs.append((doc, score))

            return sorted(scored_docs, key=lambda x: x[1], reverse=True)
        except Exception as e:
            logger.error("Error in score_relevance: %s", str(e))
            # Return documents with a default score of 0.7 if scoring fails
            return [(doc, 0.7) for doc in documents]

    async def get_embeddings(self, texts: list[str]):
        try:
            # Ensure models are initialized before use
            await self._initialize_models_on_demand()
            return await self.embeddings_model.aembed_documents(texts)
        except Exception as e:
            logger.error("Error in get_embeddings: %s", str(e))
            raise

    async def similarity_search_by_vector(
        self,
        embedding,
        k: int = 15,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
    ):
        try:
            # Get all documents
            all_docs = await self.get_all_documents()

            # Filter documents by collection_ids and document_ids
            # noinspection PyUnresolvedReferences
            all_docs = await self._filter_documents(all_docs, collection_ids, document_ids)

            # If no documents after filtering, return an empty list
            if not all_docs:
                return []

            # Get embeddings for filtered documents
            all_embeddings = await self.get_embeddings([doc.page_content for doc in all_docs])

            # Calculate cosine similarity
            # noinspection PyTypeChecker
            similarities = [
                np.dot(embedding, doc_embedding) / (np.linalg.norm(embedding) * np.linalg.norm(doc_embedding)) for doc_embedding in all_embeddings
            ]

            # Get top k similar documents
            top_k_indices = np.argsort(similarities)[-k:][::-1]
            return [all_docs[i] for i in top_k_indices]  # type: ignore[index]
        except Exception as e:
            logger.error("Error in similarity_search_by_vector: %s", str(e))
            raise

    @staticmethod
    async def create_retriever(
        retriever_type: str, config: dict, **kwargs
    ) -> "Retriever | ScrapalotEnsembleRetriever | PGVectorRetriever | Neo4JRetriever":
        """
        Factory method to create and initialize a retriever of the specified type.

        Args:
                retriever_type: Type of retriever to create ('pgvector', 'neo4j', 'ensemble')
                config: The application configuration dictionary
                **kwargs: Additional parameters specific to each retriever type

        Returns:
                An initialized retriever instance

        Raises:
                ValueError: If retriever_type is not supported
                Exception: If initialization fails
        """
        # Add null check for retriever_type
        if not retriever_type:
            raise ValueError("retriever_type cannot be None or empty")

        if retriever_type.lower() == "pgvector":
            from src.main.service.retriever.retriever_pgvector import PGVectorRetriever

            # Pass kwargs to constructor, so they're available as instance variables
            retriever = PGVectorRetriever(config, **kwargs)
            await retriever.initialize_retriever(config, **kwargs)
            return retriever
        elif retriever_type.lower() == "neo4j":
            # Community Edition has no knowledge-graph / neo4j retriever.
            # Fall back to plain pgvector similarity retrieval.
            logger.warning("neo4j retriever is unavailable in this edition; falling back to pgvector")
            from src.main.service.retriever.retriever_pgvector import PGVectorRetriever

            retriever = PGVectorRetriever(config, **kwargs)
            await retriever.initialize_retriever(config, **kwargs)
            return retriever
        elif retriever_type.lower() == "ensemble":
            retriever = ScrapalotEnsembleRetriever(config)
            await retriever.initialize_retriever(config, **kwargs)
            return retriever
        else:
            raise ValueError(f"Unsupported retriever type: {retriever_type}")

    @abstractmethod
    async def initialize_retriever(self, config: dict, **kwargs) -> None:
        """
        Initialize the retriever with the given configuration and parameters.
        Each implementation should override this to initialize its specific resources.

        Args:
                config: The application configuration dictionary
                **kwargs: Additional keyword arguments specific to each retriever implementation

        Raises:
                Exception: If initialization fails due to configuration or connection issues.
        """
        # Set up Hugging Face token if available
        import os

        resolved_secrets = kwargs.get("resolved_secrets", {})

        # Get Hugging Face token from environment or secrets
        huggingface_token = os.environ.get("HUGGINGFACE_TOKEN", "")
        if not huggingface_token:
            huggingface_token = resolved_secrets.get("huggingface_token", "")

        # Add token to kwargs if available
        if huggingface_token:
            if "emb_kwargs" not in kwargs:
                kwargs["emb_kwargs"] = {}

            if "model_kwargs" not in kwargs["emb_kwargs"]:
                kwargs["emb_kwargs"]["model_kwargs"] = {}

            kwargs["emb_kwargs"]["model_kwargs"]["hf_token"] = huggingface_token
            kwargs["emb_kwargs"]["token"] = huggingface_token

            logger.info("Hugging Face token set up in base Retriever")

        # Note: Subclasses must call super().initialize_retriever(config, **kwargs)
        # at the beginning of their implementation


class ScrapalotEnsembleRetriever(Retriever):
    def __init__(self, langchain_ensemble_retriever=None, config=None):
        """
        Initialize a ScrapalotEnsembleRetriever instance.

        For two - phase initialization, only config is required initially, with the rest set
        in initialize_retriever. For direct initialization, langchain_ensemble_retriever
        should be provided.

        Args:
                langchain_ensemble_retriever: LangchainEnsembleRetriever instance
                config: Application configuration dictionary
        """
        super().__init__(config)
        self.langchain_ensemble_retriever = langchain_ensemble_retriever

    async def process(
        self,
        prompt: str,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
    ) -> list[Document]:
        """Process a query and return relevant compressed documents."""
        # Check if the ensemble retriever is initialized
        if not self.is_ready:
            logger.warning("Ensemble retriever not initialized, cannot process prompt")
            return []

        # Implement filtering by document_ids if provided
        if document_ids:
            logger.info("Filtering by document_ids: %s", document_ids)

        # Delegate to compress_documents for actual processing
        return await self.compress_documents(prompt, collection_ids=collection_ids, document_ids=document_ids)

    async def close(self):
        # Implement if needed or pass if no closing is required
        pass

    @property
    def is_ready(self) -> bool:
        """Check if the ensemble retriever is properly initialized."""
        return self.langchain_ensemble_retriever is not None

    async def get_all_documents(self) -> list[Document]:
        """Get all documents from all retrievers in the ensemble."""
        if not self.is_ready:
            logger.warning("Ensemble retriever not initialized")
            return []

        all_docs = []
        for retriever in self.langchain_ensemble_retriever.retrievers:
            if hasattr(retriever, "get_all_documents"):
                try:
                    docs = await retriever.get_all_documents()
                    all_docs.extend(docs)
                except Exception as e:
                    logger.error("Error getting documents from retriever %s: %s", type(retriever).__name__, str(e))
        return all_docs

    async def compress_documents(
        self,
        query: str,
        documents: list[Document] | None = None,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
    ) -> list[Document]:
        try:
            # Ensure models are initialized before use
            await self._initialize_models_on_demand()

            if not hasattr(self, "llm_model") or self.llm_model is None:
                logger.warning("LLM not available for document compression. Returning uncompressed documents.")
                # If no documents provided, and we have the process method, try to get documents
                if documents is None and hasattr(self, "process"):
                    try:
                        return await self.process(query, collection_ids, document_ids)
                    except Exception as e:
                        logger.error("Error getting documents: %s", str(e))
                        return []
                return documents or []

            # If no documents were provided, retrieve them first
            if documents is None:
                try:
                    # Check if ensemble retriever is initialized
                    if not self.is_ready:
                        logger.warning("Ensemble retriever not initialized, cannot retrieve documents")
                        return []

                    # Convert collection_ids to strings if needed
                    collection_id_strs = None
                    if collection_ids:
                        collection_id_strs = [str(cid) for cid in collection_ids]

                    # First, get all documents from the base retriever
                    all_docs = []
                    for retriever in self.langchain_ensemble_retriever.retrievers:
                        try:
                            # If the retriever supports collection_ids filtering directly
                            if hasattr(retriever, "aget_relevant_documents_for_collections"):
                                logger.info("Using collection - aware retrieval for %s", type(retriever).__name__)
                                relevant_docs = await retriever.aget_relevant_documents_for_collections(query, collection_ids=collection_id_strs)
                                all_docs.extend(relevant_docs)
                            # Check if the retriever has the async method
                            elif hasattr(retriever, "aget_relevant_documents"):
                                logger.info("Using async retrieval for %s", type(retriever).__name__)
                                relevant_docs = await retriever.aget_relevant_documents(query)
                                # Filter documents by collection_id in metadata if needed
                                if collection_id_strs:
                                    relevant_docs = [doc for doc in relevant_docs if doc.metadata.get("collection_id") in collection_id_strs]
                                all_docs.extend(relevant_docs)
                            # Fall back to a synchronous method wrapped with asyncio
                            elif hasattr(retriever, "get_relevant_documents"):
                                logger.info("Using sync retrieval for %s", type(retriever).__name__)
                                import asyncio

                                # Create a function to run the sync method in a thread

                                def run_sync():
                                    docs = retriever.get_relevant_documents(query)
                                    # Filter documents by collection_id in metadata if needed
                                    if collection_id_strs:
                                        docs = [doc for doc in docs if doc.metadata.get("collection_id") in collection_id_strs]
                                    return docs

                                # Run the sync method in a thread to avoid blocking
                                relevant_docs = await asyncio.to_thread(run_sync)
                                all_docs.extend(relevant_docs)
                            else:
                                logger.warning("Retriever %s does not have any relevant_documents method", type(retriever).__name__)
                        except Exception as e:
                            logger.error("Error getting documents from retriever %s: %s", type(retriever).__name__, str(e))

                    # Apply document_ids filtering if specified
                    if document_ids:
                        # Filter documents by document_id in metadata
                        documents = [doc for doc in all_docs if doc.metadata.get("document_id") in [str(doc_id) for doc_id in document_ids]]
                    else:
                        documents = all_docs
                except Exception as e:
                    logger.error("Error getting documents: %s", str(e))
                    return []

                # If still no documents after retrieval, return an empty list
                if not documents:
                    return []

            # Create a document compressor using the LLM
            compressor = LLMChainExtractor.from_llm(self.llm_model)

            try:
                # Directly compress the documents with the query context
                # This avoids needing to set up a full ContextualCompressionRetriever
                compressed_docs = await compressor.acompress_documents(documents, query, callbacks=None)

                # Score and filter the compressed documents by relevance
                if compressed_docs:
                    # Convert a sequence to list before passing to score_relevance
                    compressed_docs_list = list(compressed_docs)
                    scored_docs = await self.score_relevance(query, compressed_docs_list)

                    # Apply MMR reranking if we have more than one document
                    if len(scored_docs) > 1:
                        try:
                            # Extract documents and scores
                            reranked_docs = [doc for doc, _ in scored_docs if _ > 0.5]

                            # Get embeddings for reranking if we have documents to rerank
                            if len(reranked_docs) > 1:
                                # Get query embedding
                                query_embedding = await self.get_embeddings([query])
                                query_embedding = query_embedding[0]

                                # Get embeddings for filtered documents
                                doc_contents = [doc.page_content for doc in reranked_docs]
                                doc_embeddings = await self.get_embeddings(doc_contents)

                                # Apply MMR reranking for better diversity
                                mmr_docs = self._mmr_rerank(
                                    query_embedding=query_embedding,
                                    doc_embeddings=doc_embeddings,
                                    docs=reranked_docs,
                                    k=len(reranked_docs),
                                    lambda_mult=0.5,  # Balance between relevance and diversity
                                )

                                logger.info("Used MMR reranking on %s documents, returning top %s", len(reranked_docs), len(mmr_docs))
                                return mmr_docs

                        except Exception as e:
                            logger.warning("Error during MMR reranking: %s. Using score - based reranking instead.", str(e))

                    # If MMR reranking failed or wasn't applicable, return docs by score
                    return [doc for doc, score in scored_docs if score > 0.5]
                else:
                    # If compression returned no documents, use the original documents
                    logger.warning("Document compression returned no results. Using original documents.")
                    return documents
            except Exception as e:
                logger.warning("Error during document compression: %s. Returning uncompressed documents.", str(e))
                return documents
        except Exception as e:
            logger.error("Error in compress_documents: %s", str(e))
            return documents or []

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

    @staticmethod
    def _mmr_rerank(query_embedding, doc_embeddings, docs, k=5, lambda_mult=0.5):
        """
        Rerank documents using Maximum Marginal Relevance.

        Args:
                query_embedding: Embedding of the query
                doc_embeddings: List of document embeddings
                docs: List of documents
                k: Number of documents to return
                lambda_mult: Balance between relevance and diversity (0 - 1, higher means more relevance)

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
                max_similarity: float = 0.0
                for j in selected_indices:
                    # noinspection PyTypeChecker
                    similarity = float(np.dot(doc_embedding, doc_scores[j][1]) / (np.linalg.norm(doc_embedding) * np.linalg.norm(doc_scores[j][1])))
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

    async def similarity_search_with_metadata_filter(
        self,
        query: str,
        metadata_filter: dict[str, Any],
        k: int = 15,
        collection_ids: list[UUID] | None = None,
        document_ids: list[UUID] | None = None,
    ) -> list[Document]:
        """
        Enhanced filter documents based on metadata and then rank by semantic similarity.

        This implementation supports advanced filtering operators:
        - Equality: {"field": value}
        - Comparison: {"field": {"$gt": value}}, {"field": {"$lt": value}}, etc.
        - Regex: {"field": {"$regex": pattern}}
        - In: {"field": {"$in": [value1, value2, ...]}}
        - Logical: {"$and": [filter1, filter2, ...]}, {"$or": [filter1, filter2, ...]}

        Args:
                query: The search query
                metadata_filter: Advanced metadata filter dictionary
                k: Number of results to return
                collection_ids: Optional list of collections to search in
                document_ids: Optional document IDs to restrict search

        Returns:
                List of documents matching both metadata filters and ranked by semantic similarity
        """
        try:
            # Check if the ensemble retriever is initialized
            if not self.is_ready:
                logger.warning("Ensemble retriever not initialized, cannot search documents")
                return []

            # Get embeddings for the query
            query_embedding = await self.get_embeddings([query])

            # Get all documents
            all_docs = await self.get_all_documents()

            # Filter documents by collection_ids and document_ids
            # noinspection PyUnresolvedReferences
            all_docs = await self._filter_documents(all_docs, collection_ids, document_ids)

            # If no documents after filtering, return an empty list
            if not all_docs:
                return []

            # Filter by metadata using the enhanced matcher
            filtered_docs = []
            filtered_docs.extend(doc for doc in all_docs if self._matches_metadata_filter(doc.metadata, metadata_filter))
            if not filtered_docs:
                logger.warning("No documents match the metadata filter: %s", metadata_filter)
                return []

            # Get embeddings for filtered documents
            doc_embeddings = await self.get_embeddings([doc.page_content for doc in filtered_docs])

            # If we have multiple documents, apply MMR reranking
            if len(filtered_docs) > 1:
                try:
                    mmr_docs = self._mmr_rerank(
                        query_embedding=query_embedding[0],
                        doc_embeddings=doc_embeddings,
                        docs=filtered_docs,
                        k=k,
                        lambda_mult=0.5,  # Balance between relevance and diversity
                    )
                    logger.info("Applied MMR reranking to %s documents, returning top %s", len(filtered_docs), len(mmr_docs))
                    return mmr_docs
                except Exception as e:
                    logger.warning("Error during MMR reranking: %s. Falling back to standard similarity ranking.", str(e))

            # Standard similarity ranking as fallback
            # noinspection PyTypeChecker
            similarities = [
                np.dot(query_embedding[0], doc_embedding) / (np.linalg.norm(query_embedding[0]) * np.linalg.norm(doc_embedding))
                for doc_embedding in doc_embeddings
            ]

            # Get top k documents
            indices = np.argsort(similarities)[-k:][::-1]
            return [filtered_docs[i] for i in indices]  # type: ignore[index,return-value]

        except Exception as e:
            logger.error("Error in similarity_search_with_metadata_filter: %s", str(e))
            return []

    def _matches_metadata_filter(self, metadata: dict[str, Any], filter_dict: dict[str, Any]) -> bool:
        """
        Check if metadata matches the given filter dictionary.
        Supports advanced operators like $gt, $lt, $in, $regex, $and, $or.

        Args:
                metadata: Document metadata to check
                filter_dict: Filter dictionary with possible operators

        Returns:
                True if metadata matches the filter, False otherwise
        """
        # Handle logical operators first
        if "$and" in filter_dict:
            return all(self._matches_metadata_filter(metadata, subfilter) for subfilter in filter_dict["$and"])

        if "$or" in filter_dict:
            return any(self._matches_metadata_filter(metadata, subfilter) for subfilter in filter_dict["$or"])

        # Handle field-level filters
        for key, value in filter_dict.items():
            # Skip logical operators we've already handled
            if key in ["$and", "$or"]:
                continue

            # If the field doesn't exist in metadata, it doesn't match
            if key not in metadata:
                return False

            # Handle comparison operators
            if isinstance(value, dict) and all(k.startswith("$") for k in value):
                for op, op_value in value.items():
                    if not self._apply_operator(metadata[key], op, op_value):
                        return False
            # Direct equality comparison
            elif metadata[key] != value:
                return False

        return True

    @staticmethod
    def _apply_operator(field_value: Any, operator: str, compare_value: Any) -> bool:
        """
        Apply a comparison operator between a field value and a comparison value.

        Args:
                field_value: The value from the document metadata
                operator: The operator string (e.g., "$gt", "$lt", "$regex")
                compare_value: The value to compare against

        Returns:
                True if the comparison succeeds, False otherwise
        """
        if operator == "$eq":
            return field_value == compare_value
        elif operator == "$gt":
            return field_value > compare_value
        elif operator == "$lt":
            return field_value < compare_value
        elif operator == "$gte":
            return field_value >= compare_value
        elif operator == "$lte":
            return field_value <= compare_value
        elif operator == "$in":
            return field_value in compare_value
        elif operator == "$nin":
            return field_value not in compare_value
        elif operator == "$regex":
            try:
                pattern = re.compile(compare_value, re.IGNORECASE)
                return bool(pattern.search(str(field_value)))
            except (re.error, TypeError):
                logger.warning("Invalid regex pattern: %s", compare_value)
                return False
        else:
            logger.warning("Unsupported operator: %s", operator)
            return False

    async def get_vectorstore(self):
        """Return the vectorstore from the first retriever that has one, or None if none found."""
        if not self.is_ready:
            logger.warning("Ensemble retriever not initialized")
            return None

        for retriever in self.langchain_ensemble_retriever.retrievers:
            if hasattr(retriever, "get_vectorstore"):
                try:
                    return await retriever.get_vectorstore()
                except Exception as e:
                    logger.warning("Error getting vectorstore from retriever: %s", str(e))

        # If we couldn't find a vectorstore, log a warning and return None
        logger.warning("No vectorstore found in any of the ensemble retrievers")
        return None

    async def add_documents(self, documents: list[Document], collection_ids: list[UUID] | None = None) -> None:
        """
        Add documents to all retrievers in the ensemble that support adding documents.

        Args:
                documents: List of documents to add
                collection_ids: Optional collection IDs to group documents

        Returns:
                None
        """
        if not documents:
            logger.warning("No documents provided to add")
            return

        if not self.is_ready:
            logger.warning("Ensemble retriever not initialized, cannot add documents")
            return

        # Add collection_ids to document metadata if not already present
        if collection_ids:
            for doc in documents:
                if "collection_id" not in doc.metadata:
                    doc.metadata["collection_id"] = ",".join(str(cid) for cid in collection_ids)

        # Add documents to all retrievers that support it
        for retriever in self.langchain_ensemble_retriever.retrievers:
            if hasattr(retriever, "add_documents"):
                try:
                    await retriever.add_documents(documents, collection_ids)
                    logger.info("Added %s documents to retriever %s", len(documents), type(retriever).__name__)
                except Exception as e:
                    logger.error("Error adding documents to retriever %s: %s", type(retriever).__name__, str(e))

    async def delete_documents(
        self,
        document_ids: list[UUID] = None,
        collection_ids: list[UUID] | None = None,
    ) -> None:
        """
        Delete documents from all retrievers in the ensemble that support document deletion.

        Args:
                document_ids: List of document IDs to delete
                collection_ids: Optional list of collection IDs to delete all documents from collections

        Returns:
                None
        """
        if not document_ids and not collection_ids:
            logger.warning("No document_ids or collection_ids provided for deletion")
            return

        if not self.is_ready:
            logger.warning("Ensemble retriever not initialized, cannot delete documents")
            return

        # Log the document IDs being deleted
        doc_ids_str = ", ".join([str(doc_id) for doc_id in document_ids[:5]]) if document_ids else "None"
        if document_ids and len(document_ids) > 5:
            doc_ids_str += "... and %d more" % (len(document_ids) - 5)

        logger.info("Attempting to delete documents: [%s]", doc_ids_str)
        if collection_ids:
            coll_ids_str = ", ".join([str(cid) for cid in collection_ids[:3]])
            if len(collection_ids) > 3:
                coll_ids_str += "... and %d more" % (len(collection_ids) - 3)
            logger.info("From collections: [%s]", coll_ids_str)

        success = False
        attempted = 0
        succeeded = 0

        # Delete documents from all retrievers that support it
        for retriever in self.langchain_ensemble_retriever.retrievers:
            # Check if the retriever has a delete_documents method
            if hasattr(retriever, "delete_documents"):
                attempted += 1
                try:
                    # Try to call the delete_documents method
                    logger.debug(
                        "Calling delete_documents on retriever %s",
                        type(retriever).__name__,
                    )
                    result = await retriever.delete_documents(document_ids, collection_ids)

                    # Check if the deletion was successful (may return True/False or None)
                    if result is not False:  # Consider None or True as success
                        logger.info(
                            "Successfully deleted documents from retriever %s",
                            type(retriever).__name__,
                        )
                        success = True
                        succeeded += 1
                    else:
                        logger.warning("Deletion failed on retriever %s", type(retriever).__name__)
                except Exception as e:
                    logger.error(
                        "Error deleting documents from retriever %s: %s",
                        type(retriever).__name__,
                        str(e),
                    )
            else:
                # Check if it's a wrapped retriever that might have the method with a different name
                wrapped_retriever = None

                # Try to extract the wrapped retriever
                if hasattr(retriever, "retriever"):
                    wrapped_retriever = retriever.retriever
                elif hasattr(retriever, "_retriever"):
                    # noinspection PyProtectedMember
                    wrapped_retriever = retriever._retriever

                # Check if the wrapped retriever has delete_documents
                if wrapped_retriever and hasattr(wrapped_retriever, "delete_documents"):
                    attempted += 1
                    try:
                        logger.debug(
                            "Calling delete_documents on wrapped retriever %s",
                            type(wrapped_retriever).__name__,
                        )
                        result = await wrapped_retriever.delete_documents(document_ids, collection_ids)

                        if result is not False:
                            logger.info(
                                "Successfully deleted documents from wrapped retriever %s",
                                type(wrapped_retriever).__name__,
                            )
                            success = True
                            succeeded += 1
                        else:
                            logger.warning(
                                "Deletion failed on wrapped retriever %s",
                                type(wrapped_retriever).__name__,
                            )
                    except Exception as e:
                        logger.error(
                            "Error deleting documents from wrapped retriever %s: %s",
                            type(wrapped_retriever).__name__,
                            str(e),
                        )

        if not success:
            if attempted > 0:
                logger.warning(
                    "Document deletion attempted with %d retrievers but all failed",
                    attempted,
                )
            else:
                logger.warning("No retrievers supported document deletion")
        else:
            logger.info("Document deletion succeeded in %d/%d retrievers", succeeded, attempted)

    async def initialize_retriever(self, config: dict, **kwargs) -> None:
        """
        Initialize the ensemble retriever with the given retrievers and weights.

        Args:
                config: The application configuration dictionary (optional)
                **kwargs: Expected to contain:
                        - retrievers: List of retriever instances to ensemble
                        - weights: Optional list of weights for each retriever

        Raises:
                ValueError: If retrievers are not provided or weights length doesn't match retrievers
        """
        retrievers = kwargs.get("retrievers") or []
        weights = kwargs.get("weights")

        if not retrievers or any(not r for r in retrievers):
            raise ValueError("All retrievers must be valid (non - empty) objects")

        # noinspection PyTypeChecker
        if weights and len(weights) != len(retrievers):
            # noinspection PyTypeChecker
            raise ValueError(f"Number of weights ({len(weights)}) must match number of retrievers ({len(retrievers)})")

        # Wrap each retriever with our RunnableRetrieverAdapter to ensure LangChain compatibility
        adapted_retrievers = []
        for retriever in retrievers:
            # If the retriever is already a LangChain BaseRetriever or Runnable, use it directly
            if hasattr(retriever, "_get_relevant_documents") or hasattr(retriever, "invoke"):
                logger.info("Retriever %s is already LangChain compatible", type(retriever).__name__)
                adapted_retrievers.append(retriever)
            else:
                # Otherwise, wrap it with our adapter
                logger.info("Wrapping retriever %s with RunnableRetrieverAdapter", type(retriever).__name__)
                adapted_retrievers.append(RunnableRetrieverAdapter(retriever))

        self.langchain_ensemble_retriever = LangchainEnsembleRetriever(retrievers=adapted_retrievers, weights=weights or [1] * len(retrievers))
