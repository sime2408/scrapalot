"""
Semantic chunking strategy for text splitting based on content similarity.

This implementation provides both custom semantic chunking and LangChain's
SemanticChunker integration for advanced semantic text splitting based on
embedding similarity.
"""

from collections.abc import Callable
import re
from typing import Any, Literal

import numpy as np

# LangChain imports (optional)
try:
    from langchain_experimental.text_splitter import SemanticChunker
    from langchain_huggingface import HuggingFaceEmbeddings
    from langchain_openai import OpenAIEmbeddings

    LANGCHAIN_EXPERIMENTAL_AVAILABLE = True
except ImportError:
    SemanticChunker = None
    HuggingFaceEmbeddings = None
    OpenAIEmbeddings = None
    LANGCHAIN_EXPERIMENTAL_AVAILABLE = False

from src.main.service.rag.chunking.base_chunking import BaseChunkingStrategy
from src.main.utils.core.logger import get_logger
from src.main.utils.documents.utils import fallback_chunking_with_overlap

logger = get_logger(__name__)


class SemanticChunkingStrategy(BaseChunkingStrategy):
    """
    Advanced semantic chunking with both custom and LangChain implementations.

    This strategy provides:
    1. Custom semantic chunking: Splits text based on sentence similarity analysis
    2. LangChain SemanticChunker: Uses LangChain's experimental SemanticChunker
    3. Multiple embedding model support (OpenAI, HuggingFace, local, custom)
    4. Various breakpoint detection methods
    5. Enhanced semantic coherence
    """

    def __init__(
        self,
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
        method: str = "percentile",
        threshold: float = 90,
        embedding_fn: Callable | None = None,
        min_chunk_size: int = 50,
        max_chunk_size: int = 2000,
        use_langchain: bool = True,
        embedding_model: str = None,
        embedding_provider: str = "huggingface",
        breakpoint_threshold_type: Literal["percentile", "standard_deviation", "interquartile", "gradient"] = "percentile",
        breakpoint_threshold_amount: float | None = None,
        **kwargs,
    ):
        """
        Initialize the semantic chunking strategy.

        Args:
                chunk_size: Target size of chunks in characters (used as fallback)
                chunk_overlap: Amount of overlap between chunks (used as fallback)
                method: Method for finding breakpoints ("percentile", "standard_deviation", or "interquartile")
                threshold: Threshold value for the chosen method (e.g., 90 for 90th percentile)
                embedding_fn: Function to create embeddings from text (for custom implementation)
                min_chunk_size: Minimum chunk size to prevent too small chunks
                max_chunk_size: Maximum chunk size to prevent too large chunks
                use_langchain: Whether to use LangChain's SemanticChunker (if available)
                embedding_model: Model name for embeddings (LangChain mode)
                embedding_provider: Provider for embeddings ("openai", "huggingface", "local")
                breakpoint_threshold_type: LangChain breakpoint method ("percentile", "standard_deviation", etc.)
                breakpoint_threshold_amount: LangChain threshold value (auto-calculated if None)
                **kwargs: Additional parameters
        """
        super().__init__(chunk_size, chunk_overlap, **kwargs)

        # Original semantic chunking parameters
        self.method = method
        self.threshold = threshold
        self.embedding_fn = embedding_fn
        self.min_chunk_size = min_chunk_size
        self.max_chunk_size = max_chunk_size
        self._paragraph_boundaries = []

        # LangChain semantic chunking parameters
        self.use_langchain = use_langchain and LANGCHAIN_EXPERIMENTAL_AVAILABLE

        # Resolve embedding model using centralized resolver
        if not embedding_model:
            from src.main.utils.llm.embedding_resolver import EmbeddingModelResolver

            self.embedding_model = EmbeddingModelResolver.get_default_embedding_model()
        else:
            self.embedding_model = embedding_model

        self.embedding_provider = embedding_provider
        self.breakpoint_threshold_type = breakpoint_threshold_type
        self.breakpoint_threshold_amount = breakpoint_threshold_amount

        # Initialize LangChain components if requested and available
        self.langchain_embeddings = None
        self.semantic_chunker = None

        if self.use_langchain:
            self.langchain_embeddings = self._initialize_langchain_embeddings()
            self.semantic_chunker = self._initialize_semantic_chunker()
            if not self.semantic_chunker:
                logger.warning("LangChain SemanticChunker initialization failed, falling back to custom implementation")
                self.use_langchain = False

    def _initialize_langchain_embeddings(self):
        """Initialize the LangChain embedding model based on provider."""
        try:
            if self.embedding_provider == "openai":
                return self._initialize_openai_embeddings()
            elif self.embedding_provider == "huggingface":
                return self._initialize_huggingface_embeddings()
            elif self.embedding_provider == "local":
                return self._initialize_local_embeddings()
            else:
                logger.warning("Unknown embedding provider %s, defaulting to HuggingFace", self.embedding_provider)
                return self._initialize_huggingface_embeddings()

        except Exception as e:
            logger.error("Error initializing LangChain embeddings: %s", str(e))
            return None

    def _initialize_openai_embeddings(self):
        """Initialize OpenAI embeddings."""
        try:
            return OpenAIEmbeddings(model=self.embedding_model or "text-embedding-ada-002")
        except Exception as e:
            logger.error("Error initializing OpenAI embeddings: %s", str(e))
            return None

    def _initialize_huggingface_embeddings(self):
        """Initialize HuggingFace embeddings."""
        try:
            return HuggingFaceEmbeddings(
                model_name=self.embedding_model,
                model_kwargs={"device": "cpu"},  # Can be changed to 'cuda' if GPU available
                encode_kwargs={"normalize_embeddings": True},
            )
        except Exception as e:
            logger.error("Error initializing HuggingFace embeddings: %s", str(e))
            return None

    def _initialize_local_embeddings(self):
        """Initialize local embeddings (fallback or custom implementation)."""
        try:
            # For local embeddings, use HuggingFace with specific local model
            return HuggingFaceEmbeddings(
                model_name=self.embedding_model,
                model_kwargs={"device": "cpu", "trust_remote_code": False},
                encode_kwargs={"normalize_embeddings": True},
            )
        except Exception as e:
            logger.error("Error initializing local embeddings: %s", str(e))
            return None

    def _initialize_semantic_chunker(self):
        """Initialize the LangChain SemanticChunker."""
        if not LANGCHAIN_EXPERIMENTAL_AVAILABLE:
            logger.debug("langchain-experimental not available for SemanticChunker")
            return None

        if not self.langchain_embeddings:
            logger.debug("No LangChain embeddings available for SemanticChunker")
            return None

        try:
            # Determine breakpoint threshold amount if not provided
            if self.breakpoint_threshold_amount is None:
                if self.breakpoint_threshold_type == "percentile":
                    self.breakpoint_threshold_amount = 95  # 95th percentile
                elif self.breakpoint_threshold_type == "standard_deviation":
                    self.breakpoint_threshold_amount = 3  # 3 standard deviations
                elif self.breakpoint_threshold_type == "interquartile":
                    self.breakpoint_threshold_amount = 1.5  # 1.5 * IQR
                else:
                    self.breakpoint_threshold_amount = 95  # Default

            return SemanticChunker(
                embeddings=self.langchain_embeddings,
                breakpoint_threshold_type=self.breakpoint_threshold_type,
                breakpoint_threshold_amount=self.breakpoint_threshold_amount,
            )

        except Exception as e:
            logger.error("Error initializing SemanticChunker: %s", str(e))
            return None

    def split_text(self, text: str) -> list[str]:
        """
        Split the input text into chunks using semantic chunking.

        Uses LangChain SemanticChunker if available and configured, otherwise
        falls back to custom semantic chunking implementation.

        Args:
                text: Input text to be chunked

        Returns:
                List of text chunks
        """
        if not text or not text.strip():
            logger.warning("Empty text provided to semantic chunking")
            return []

        # Try LangChain SemanticChunker first if available and configured
        if self.use_langchain and self.semantic_chunker:
            try:
                chunks = self._langchain_semantic_split(text)
                if chunks:  # If LangChain chunking succeeded
                    logger.info("LangChain semantic chunking created %d chunks", len(chunks))
                    return chunks
            except Exception as e:
                logger.warning("LangChain semantic chunking failed: %s", str(e))

        # Fall back to custom semantic chunking implementation
        return self._custom_semantic_split(text)

    def _langchain_semantic_split(self, text: str) -> list[str]:
        """Use LangChain's SemanticChunker for text splitting."""
        try:
            # Use LangChain's SemanticChunker
            # noinspection PyUnresolvedReferences
            chunks = self.semantic_chunker.split_text(text)

            # Post-process chunks to enforce size constraints
            chunks = self._enforce_size_constraints(chunks)

            return chunks

        except Exception as e:
            logger.error("Error in LangChain semantic chunking: %s", str(e))
            return []

    def _custom_semantic_split(self, text: str) -> list[str]:
        """Use custom semantic chunking implementation."""
        # Check if embedding function is available
        if not self.embedding_fn:
            logger.warning("No embedding function provided for custom semantic chunking, falling back to sentence splitting")
            return self._fallback_chunking(text)

        try:
            # Split text into sentences
            sentences = self._split_into_sentences(text)
            if len(sentences) <= 1:
                logger.warning("Text has only one or zero sentences, using as a single chunk")
                return [text] if text else []

            # Generate embeddings for each sentence
            try:
                embeddings = [self.embedding_fn(sentence) for sentence in sentences]
            except Exception as e:
                logger.error("Error generating embeddings: %s", str(e))
                return self._fallback_chunking(text)

            # Compute similarity between consecutive sentences
            similarities = [self._cosine_similarity(embeddings[i], embeddings[i + 1]) for i in range(len(embeddings) - 1)]

            # Compute breakpoints based on similarity
            breakpoints = self._compute_breakpoints(similarities, self.method, self.threshold)

            # Split into chunks based on breakpoints
            chunks = self._split_into_chunks(sentences, breakpoints)

            # Post-process chunks to enforce size constraints
            chunks = self._enforce_size_constraints(chunks)

            logger.info("Custom semantic chunking created %d chunks", len(chunks))
            return chunks

        except Exception as e:
            logger.error("Error in custom semantic chunking: %s", str(e))
            return self._fallback_chunking(text)

    def _split_into_sentences(self, text: str) -> list[str]:
        """
        Split text into sentences with paragraph boundary awareness.

        For entity extraction, we want to preserve paragraph structure while
        maintaining sentence-level granularity for semantic analysis.
        """
        # First split by paragraphs to preserve natural content flow
        paragraphs = re.split(r"\n\s*\n", text.strip())

        all_sentences = []
        paragraph_boundaries = []  # Track where paragraphs start for boundary preservation

        for paragraph in paragraphs:
            if not paragraph.strip():
                continue

            # Mark the start of a new paragraph
            paragraph_start_idx = len(all_sentences)
            paragraph_boundaries.append(paragraph_start_idx)

            # Split paragraph into sentences
            # Use a more sophisticated sentence splitting pattern
            sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z])", paragraph.strip())

            # Clean up sentences and add to collection
            for sentence in sentences:
                sentence = sentence.strip()
                if sentence and len(sentence) > 10:  # Filter out very short fragments
                    all_sentences.append(sentence)

        # Store paragraph boundaries for later use in chunking
        self._paragraph_boundaries = paragraph_boundaries

        return all_sentences

    @staticmethod
    def _compute_breakpoints(similarities: list[float], method: str = "percentile", threshold: float = 90) -> list[int]:
        """
        Compute chunking breakpoints based on similarity drops.

        Args:
                similarities: List of similarity scores between sentences
                method: Method for finding breakpoints ("percentile", "standard_deviation", or "interquartile")
                threshold: Threshold value for the chosen method

        Returns:
                List of indices where chunk splits should occur
        """
        if not similarities:
            return []

        # Determine the threshold value based on the selected method
        threshold_value: float
        if method == "percentile":
            # Calculate the Xth percentile of the similarity scores (lower is more aggressive splitting)
            threshold_value = float(np.percentile(similarities, 100 - threshold))
        elif method == "standard_deviation":
            # Calculate the mean and standard deviation of the similarity scores
            mean = float(np.mean(similarities))
            std_dev = float(np.std(similarities))
            # Set the threshold value to mean minus X standard deviations
            threshold_value = mean - (threshold * std_dev)
        elif method == "interquartile":
            # Calculate the first and third quartiles (Q1 and Q3)
            q1, q3 = (float(v) for v in np.percentile(similarities, [25, 75]))
            # Set the threshold value using the IQR rule for outliers
            threshold_value = q1 - threshold * (q3 - q1)
        else:
            # Default to percentile method if an invalid method is provided
            logger.warning("Invalid method '%s', defaulting to percentile", method)
            threshold_value = float(np.percentile(similarities, 100 - threshold))

        # Identify indices where similarity drops below the threshold value
        breakpoints = [i for i, sim in enumerate(similarities) if sim < threshold_value]

        return breakpoints

    def _split_into_chunks(self, sentences: list[str], breakpoints: list[int]) -> list[str]:
        """
        Split sentences into semantic chunks based on breakpoints while respecting paragraph boundaries.

        For entity extraction, we want to preserve paragraph structure to maintain
        natural context flow for entities and relationships.

        Args:
                sentences: List of sentences
                breakpoints: Indices where chunking should occur

        Returns:
                List of text chunks that respect both semantic and paragraph boundaries
        """
        if not sentences:
            return []

        # Get paragraph boundaries if available
        paragraph_boundaries = getattr(self, "_paragraph_boundaries", [])

        # Combine semantic breakpoints with paragraph boundaries
        all_boundaries = sorted(set(breakpoints + paragraph_boundaries))

        chunks = []
        start = 0

        # Iterate through each boundary to create chunks
        for boundary in all_boundaries:
            if boundary > start:
                # Create chunk from the start to boundary
                chunk_sentences = sentences[start:boundary]
                if chunk_sentences:  # Only create non-empty chunks
                    chunk = self._join_sentences(chunk_sentences)
                    chunks.append(chunk)
                start = boundary

        # Add the remaining sentences as the last chunk if there are any
        if start < len(sentences):
            chunk_sentences = sentences[start:]
            if chunk_sentences:
                chunk = self._join_sentences(chunk_sentences)
                chunks.append(chunk)

        # Filter out very small chunks that don't provide meaningful context
        meaningful_chunks = []
        for chunk in chunks:
            if len(chunk.strip()) >= 50:  # Minimum meaningful chunk size
                meaningful_chunks.append(chunk)
            elif meaningful_chunks:
                # Merge very small chunks with the previous chunk to preserve context
                meaningful_chunks[-1] = meaningful_chunks[-1] + " " + chunk

        return meaningful_chunks

    @staticmethod
    def _join_sentences(sentences: list[str]) -> str:
        """
        Join sentences with proper spacing and punctuation.

        Args:
                sentences: List of sentences to join

        Returns:
                Joined text
        """
        if not sentences:
            return ""

        # Join sentences with a space, ensuring proper punctuation
        text = " ".join(sentences)

        # Add a period at the end if there's no sentence-ending punctuation
        if text and text[-1] not in ".!?":
            text += "."

        return text

    def _enforce_size_constraints(self, chunks: list[str]) -> list[str]:
        """
        Enforce minimum and maximum chunk size constraints.
        Merges chunks that are too small and splits chunks that are too large.

        Args:
                chunks: List of text chunks

        Returns:
                List of chunks meeting size constraints
        """
        if not chunks:
            return []

        # Use utility function for merging small chunks
        from src.main.utils.documents.utils import merge_small_chunks

        merged_chunks = merge_small_chunks(chunks, self.min_chunk_size)

        # Handle maximum size constraint by splitting large chunks
        result = []
        for chunk in merged_chunks:
            if len(chunk) > self.max_chunk_size:
                # Split large chunks
                sub_chunks = self._split_large_chunk(chunk)
                result.extend(sub_chunks)
            else:
                result.append(chunk)

        return result

    def _split_large_chunk(self, chunk: str) -> list[str]:
        """Split a chunk that's too large using centralized utility."""
        # noinspection PyUnresolvedReferences
        from src.main.utils.documents.utils import split_large_chunk_with_recursive_splitter

        return split_large_chunk_with_recursive_splitter(chunk, self.max_chunk_size, self.chunk_overlap)

    def _fallback_chunking(self, text: str) -> list[str]:
        """
        Fallback to simple sliding window chunking if semantic chunking fails.

        Args:
                text: Text to chunk

        Returns:
                List of text chunks
        """
        return fallback_chunking_with_overlap(text, self.chunk_size, self.chunk_overlap)

    @staticmethod
    def _cosine_similarity(vec1, vec2) -> float:
        """
        Calculate cosine similarity between two vectors.

        Args:
                vec1: First vector
                vec2: Second vector

        Returns:
                Cosine similarity score
        """
        # noinspection PyTypeChecker
        return float(np.dot(vec1, vec2) / (np.linalg.norm(vec1) * np.linalg.norm(vec2)))

    def get_metadata(self) -> dict[str, Any]:
        """
        Get metadata about the chunking strategy.

        Returns:
                Dictionary containing strategy metadata
        """
        metadata = super().get_metadata()
        metadata.update(
            {
                # Original parameters
                "method": self.method,
                "threshold": self.threshold,
                "min_chunk_size": self.min_chunk_size,
                "max_chunk_size": self.max_chunk_size,
                # LangChain parameters
                "use_langchain": self.use_langchain,
                "embedding_model": self.embedding_model,
                "embedding_provider": self.embedding_provider,
                "breakpoint_threshold_type": self.breakpoint_threshold_type,
                "breakpoint_threshold_amount": self.breakpoint_threshold_amount,
                "langchain_experimental_available": LANGCHAIN_EXPERIMENTAL_AVAILABLE,
            }
        )
        return metadata


# Convenience classes for easier usage
class OpenAISemanticChunkingStrategy(SemanticChunkingStrategy):
    """Specialized semantic chunking using OpenAI embeddings."""

    def __init__(self, model: str = "text-embedding-ada-002", **kwargs):
        """
        Initialize OpenAI-specific semantic chunking.

        Args:
                model: OpenAI embedding model name
                **kwargs: Additional parameters
        """
        super().__init__(use_langchain=True, embedding_model=model, embedding_provider="openai", **kwargs)


class HuggingFaceSemanticChunkingStrategy(SemanticChunkingStrategy):
    """Specialized semantic chunking using HuggingFace embeddings."""

    def __init__(self, model: str = "sentence-transformers/all-MiniLM-L6-v2", **kwargs):
        """
        Initialize HuggingFace-specific semantic chunking.

        Args:
                model: HuggingFace model name
                **kwargs: Additional parameters
        """
        super().__init__(use_langchain=True, embedding_model=model, embedding_provider="huggingface", **kwargs)
