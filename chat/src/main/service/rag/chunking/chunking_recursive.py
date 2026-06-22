"""
Recursive chunking strategy for text splitting.

This implementation uses LangChain's RecursiveCharacterTextSplitter to recursively
split text based on specified separators.
"""

from typing import Any

from langchain_text_splitters import RecursiveCharacterTextSplitter

from src.main.service.rag.chunking.base_chunking import BaseChunkingStrategy
from src.main.utils.core.logger import get_logger
from src.main.utils.documents.utils import fallback_chunking_with_overlap
from src.main.utils.tokens.counting import count_tokens

logger = get_logger(__name__)


class RecursiveChunkingStrategy(BaseChunkingStrategy):
    """
    Chunks text using a recursive character-based splitting approach.

    This strategy:
    1. Attempts to split text on various separators in order (e.g., "\n\n", "\n", " ", "")
    2. Recursively processes text until chunks are below the chunk_size limit
    3. Maintains chunk_overlap between chunks
    4. Handles various document types through appropriate separators

    Based on evaluation research:
    - 256 tokens is typically a good balance for most queries
    - Approximately 20% overlap (50-64 tokens for 256-token chunks) is effective
    - Small chunks (128 tokens) work well for factual queries
    - Larger chunks (512 tokens) are better for complex, context-heavy questions
    """

    def __init__(
        self,
        chunk_size: int = 256,
        chunk_overlap: int = 64,
        chunk_sizes_to_ignore: int = 20,
        separators: list[str] | None = None,
        keep_separator: bool = True,
        is_separator_regex: bool = False,
        **kwargs,
    ):
        """
        Initialize the recursive chunking strategy.

        Args:
            chunk_size: Target size of chunks in tokens (default: 256 tokens)
            chunk_overlap: Amount of overlap between chunks in tokens (default: 64 tokens)
            chunk_sizes_to_ignore: Ignore chunks smaller than this size in tokens (default: 20 tokens)
            separators: List of separators to use for splitting, in order of preference
                If None, defaults to ["\n\n", "\n", " ", ""]
            keep_separator: Whether to keep the separator with the chunk
            is_separator_regex: Whether the separators are regex patterns
            **kwargs: Additional parameters
        """
        super().__init__(chunk_size, chunk_overlap, chunk_sizes_to_ignore, **kwargs)

        # Default separators if none provided
        if separators is None:
            self.separators = ["\n\n", "\n", " ", ""]
        else:
            self.separators = separators

        self.keep_separator = keep_separator
        self.is_separator_regex = is_separator_regex

    def split_text(self, text: str) -> list[str]:
        """
        Split the input text into chunks using recursive character - based splitting.

        Args:
            text: Input text to be chunked

        Returns:
            List of text chunks
        """
        if not text or not text.strip():
            logger.warning("Empty text provided to recursive chunking")
            return []

        try:
            # Create the recursive character text splitter
            text_splitter = RecursiveCharacterTextSplitter(
                chunk_size=self.chunk_size,
                chunk_overlap=self.chunk_overlap,
                separators=self.separators,
                keep_separator=self.keep_separator,
                is_separator_regex=self.is_separator_regex,
            )

            # Split the text into chunks
            chunks = text_splitter.split_text(text)

            # Filter out empty or too small chunks (using token count)
            chunks = [chunk for chunk in chunks if chunk.strip() and count_tokens(chunk, self.encoding_name) >= self.chunk_sizes_to_ignore]

            # Enforce max chunk size to prevent pathological cases
            chunks = self._enforce_max_size(chunks)

            logger.info("Recursive chunking created %d chunks", len(chunks))
            return chunks

        except Exception as e:
            logger.error("Error in recursive chunking: %s", str(e))
            return self._fallback_chunking(text)

    def _fallback_chunking(self, text: str) -> list[str]:
        """
        Fallback to simple sliding window chunking if recursive chunking fails.

        Args:
            text: Text to chunk

        Returns:
            List of text chunks
        """
        chunks = fallback_chunking_with_overlap(text, self.chunk_size, self.chunk_overlap)

        # Filter out chunks that are too small (using token count)
        return [chunk for chunk in chunks if count_tokens(chunk, self.encoding_name) >= self.chunk_sizes_to_ignore]

    def get_metadata(self) -> dict[str, Any]:
        """
        Get metadata about the chunking strategy.

        Returns:
            Dictionary containing strategy metadata
        """
        metadata = super().get_metadata()
        metadata.update(
            {
                "separators": self.separators,
                "keep_separator": self.keep_separator,
                "is_separator_regex": self.is_separator_regex,
            }
        )
        return metadata
