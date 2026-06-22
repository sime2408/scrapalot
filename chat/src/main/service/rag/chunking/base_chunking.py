"""
Base class for text chunking strategies.
"""

from abc import ABC, abstractmethod
from typing import Any

from src.main.utils.core.logger import get_logger
from src.main.utils.tokens.counting import (
    count_tokens,
    filter_chunks_by_token_count,
    get_tokenizer,
    split_text_by_tokens,
    validate_chunk_size,
)

logger = get_logger(__name__)


class BaseChunkingStrategy(ABC):
    """
    Base class for document chunking strategies.

    Chunking is a critical part of RAG systems. Research shows that different chunk
    sizes have significant impact on retrieval accuracy and answer quality:
    - Small chunks (128 tokens): Good for specific factual retrieval, less context
    - Medium chunks (256 tokens): Balanced for most queries, recommended default
    - Large chunks (512 tokens): Better for complex questions requiring more context
    - Very large chunks (1024+ tokens): High context but can introduce noise

    Overlap is also important for preserving context across chunk boundaries:
    - 20% of chunk size is generally a good rule of thumb
    - For 256 token chunks, ~50 - 64 tokens of overlap are recommended
    """

    def __init__(self, chunk_size: int = 256, chunk_overlap: int = 64, chunk_sizes_to_ignore: int = 20, encoding_name: str = "cl100k_base", **kwargs):
        """
        Initialize the chunking strategy with configurable parameters.

        Args:
                chunk_size: Size of each chunk in tokens. Default is 256 tokens (recommended balanced size)
                chunk_overlap: Overlap between chunks in tokens. Default is 64 tokens (25% of default chunk size)
                chunk_sizes_to_ignore: Minimum chunk length to keep (in tokens)
                encoding_name: Tokenizer encoding to use (cl100k_base for GPT-4, p50k_base for GPT-3, etc.)
                **kwargs: Additional parameters specific to the chunking strategy
        """
        # Validate and adjust chunk size/overlap parameters
        self.chunk_size, self.chunk_overlap = validate_chunk_size(chunk_size, chunk_overlap)
        self.chunk_sizes_to_ignore = chunk_sizes_to_ignore
        self.encoding_name = encoding_name
        self.config = kwargs

        # Get tokenizer from a centralized cache
        self._tokenizer = get_tokenizer(encoding_name)

        # Calculate max chunk size in tokens (3x target or 8000 tokens, whichever is smaller)
        # This prevents pathological cases while preserving natural boundaries
        self.max_chunk_size = min(self.chunk_size * 3, 8000)

        # Log the chunking configuration
        logger.info(
            "Initializing %s with chunk_size=%s tokens, chunk_overlap=%s tokens, chunk_sizes_to_ignore=%s tokens, max_chunk_size=%s tokens, encoding=%s",
            self.__class__.__name__,
            self.chunk_size,
            self.chunk_overlap,
            self.chunk_sizes_to_ignore,
            self.max_chunk_size,
            self.encoding_name,
        )

    def _create_document_chunks_with_strategy_metadata(
        self, document: dict[str, Any], strategy_name: str, **strategy_metadata
    ) -> list[dict[str, Any]]:
        """
        Shared utility method to create document chunks with metadata.

        This method removes duplication across chunking strategies by providing
        a common implementation for the split_document pattern.

        Args:
            document: The document to split
            strategy_name: Name of the chunking strategy
            **strategy_metadata: Additional metadata specific to the strategy

        Returns:
            A list of document chunks with metadata
        """
        # Extract text content from document
        text = document.get("content", "") or document.get("text", "")
        if not text:
            logger.warning("No content found in document for %s chunking", strategy_name)
            return []

        # Call the strategy-specific split_text method
        chunks = self.split_text(text)

        # Create document chunks with metadata using a utility function
        from src.main.utils.documents.utils import create_document_chunks_with_metadata

        return create_document_chunks_with_metadata(document=document, chunks=chunks, strategy_name=strategy_name, **strategy_metadata)

    def _enforce_max_size(self, chunks: list[str]) -> list[str]:
        """
        Enforce maximum chunk size constraint across all strategies.
        Splits chunks that exceed max_chunk_size (in tokens) at word boundaries.

        Args:
            chunks: List of text chunks

        Returns:
            List of chunks with enforced size limits
        """
        result = []
        for chunk in chunks:
            token_count = self.count_tokens(chunk)
            if token_count <= self.max_chunk_size:
                result.append(chunk)
            else:
                # Chunk exceeds max size - split by tokens
                logger.warning(
                    "Chunk exceeds max size (%s tokens > %s tokens), splitting by token boundaries",
                    token_count,
                    self.max_chunk_size,
                )
                result.extend(self.split_text_by_tokens(chunk, self.max_chunk_size, 0))
        return result

    def _force_split_by_words(self, text: str) -> list[str]:
        """
        Force split text at word boundaries when it exceeds max_chunk_size.
        This is a legacy method now using token-based splitting.

        Args:
            text: Text to split

        Returns:
            List of chunks, each <= max_chunk_size tokens
        """
        return self.split_text_by_tokens(text, self.max_chunk_size, 0)

    def count_tokens(self, text: str) -> int:
        """
        Count the number of tokens in a text string.

        Args:
            text: Text to count tokens for

        Returns:
            Number of tokens in the text
        """
        return count_tokens(text, self.encoding_name)

    def split_text_by_tokens(self, text: str, chunk_size: int | None = None, chunk_overlap: int | None = None) -> list[str]:
        """
        Split text by token count with overlap.

        Args:
            text: Text to split
            chunk_size: Target chunk size in tokens (uses self.chunk_size if None)
            chunk_overlap: Overlap size in tokens (uses self.chunk_overlap if None)

        Returns:
            List of text chunks split by token boundaries
        """
        chunk_size = int(chunk_size or self.chunk_size or 512)
        chunk_overlap = int(chunk_overlap or self.chunk_overlap or 0)
        # noinspection PyTypeChecker
        return split_text_by_tokens(text, chunk_size, chunk_overlap, self.encoding_name)

    def filter_chunks_by_token_count(self, chunks: list[str], min_tokens: int | None = None) -> list[str]:
        """
        Filter out chunks that are too small based on token count.

        Args:
            chunks: List of text chunks
            min_tokens: Minimum token count (uses self.chunk_sizes_to_ignore if None)

        Returns:
            Filtered list of chunks
        """
        min_tokens = int(min_tokens or self.chunk_sizes_to_ignore or 0)
        # noinspection PyTypeChecker
        return filter_chunks_by_token_count(chunks, min_tokens, self.encoding_name)

    @abstractmethod
    def split_text(self, text: str) -> list[str]:
        """
        Split text into chunks using the specific strategy.

        Args:
            text: Input text to be chunked

        Returns:
            List of text chunks
        """

    def get_metadata(self) -> dict[str, Any]:
        """
        Get metadata about the chunking strategy for debugging or tracking.

        Returns:
                Dictionary containing strategy metadata
        """
        return {
            "strategy": self.__class__.__name__,
            "chunk_size": self.chunk_size,
            "chunk_overlap": self.chunk_overlap,
            "chunk_sizes_to_ignore": self.chunk_sizes_to_ignore,
            **self.config,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]):
        """
        Create a chunking strategy from a configuration dictionary.

        Args:
                config: Dictionary containing configuration parameters

        Returns:
                An instance of the chunking strategy
        """
        return cls(**config)
