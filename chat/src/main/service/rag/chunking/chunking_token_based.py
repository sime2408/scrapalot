"""
Token-based chunking strategy using LangChain's token-aware splitters.

This implementation provides precise token-based splitting using various tokenizers
including tiktoken (OpenAI), Hugging Face transformers, and others.
"""

from typing import Any

from langchain_text_splitters import (
    CharacterTextSplitter,
    RecursiveCharacterTextSplitter,
)

from src.main.service.rag.chunking.base_chunking import BaseChunkingStrategy
from src.main.utils.core.logger import get_logger
from src.main.utils.tokens.counting import count_tokens, get_chunk_statistics

logger = get_logger(__name__)


class TokenBasedChunkingStrategy(BaseChunkingStrategy):
    """
    Chunks text based on token count using LangChain's token-aware splitters.

    This strategy:
    1. Uses precise tokenizers (tiktoken, HuggingFace) for accurate token counting
    2. Ensures chunks fit within LLM context windows
    3. Supports various tokenization models (GPT-3.5, GPT-4, Claude, etc.)
    4. Provides token-level overlap control
    """

    def __init__(
        self,
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
        encoding_name: str = "cl100k_base",
        model_name: str | None = None,
        tokenizer_type: str = "tiktoken",
        splitter_type: str = "recursive",
        separators: list[str] | None = None,
        **kwargs,
    ):
        """
        Initialize the token-based chunking strategy.

        Args:
            chunk_size: Target size of chunks in tokens
            chunk_overlap: Amount of overlap between chunks in tokens
            encoding_name: tiktoken encoding name (cl100k_base for GPT-4, p50k_base for GPT-3.5)
            model_name: Specific model name for tokenizer (e.g., "gpt-4", "gpt-3.5-turbo")
            tokenizer_type: Type of tokenizer ("tiktoken", "huggingface")
            splitter_type: Type of splitter ("character", "recursive")
            separators: Custom separators for recursive splitting
            **kwargs: Additional parameters
        """
        super().__init__(chunk_size, chunk_overlap, **kwargs)

        self.encoding_name = encoding_name
        self.model_name = model_name
        self.tokenizer_type = tokenizer_type
        self.splitter_type = splitter_type
        self.separators = separators or ["\n\n", "\n", " ", ""]

        # Initialize tokenizer and splitter
        self._initialize_splitter()

    def _initialize_splitter(self):
        """Initialize the appropriate text splitter based on configuration."""
        try:
            if self.tokenizer_type == "tiktoken":
                self._initialize_tiktoken_splitter()
            elif self.tokenizer_type == "huggingface":
                self._initialize_huggingface_splitter()
            else:
                logger.warning(
                    "Unknown tokenizer type %s, defaulting to tiktoken",
                    self.tokenizer_type,
                )
                self._initialize_tiktoken_splitter()

        except Exception as e:
            logger.error("Error initializing token splitter: %s", str(e))
            # Fallback to basic character splitter
            self.text_splitter = CharacterTextSplitter(
                chunk_size=self.chunk_size * 4,  # Rough estimate: 1 token ≈ 4 characters
                chunk_overlap=self.chunk_overlap * 4,
            )

    def _initialize_tiktoken_splitter(self):
        """Initialize tiktoken-based splitter."""
        if self.splitter_type == "recursive":
            self.text_splitter = RecursiveCharacterTextSplitter.from_tiktoken_encoder(
                encoding_name=self.encoding_name,
                model_name=self.model_name,
                chunk_size=self.chunk_size,
                chunk_overlap=self.chunk_overlap,
                separators=self.separators,
            )
        else:
            self.text_splitter = CharacterTextSplitter.from_tiktoken_encoder(
                encoding_name=self.encoding_name,
                model_name=self.model_name,
                chunk_size=self.chunk_size,
                chunk_overlap=self.chunk_overlap,
            )

    def _initialize_huggingface_splitter(self):
        """Initialize Hugging Face tokenizer-based splitter."""
        try:
            from transformers import AutoTokenizer

            # Default to a common model if none specified
            model_name = self.model_name or "gpt2"
            tokenizer = AutoTokenizer.from_pretrained(model_name)

            if self.splitter_type == "recursive":
                self.text_splitter = RecursiveCharacterTextSplitter.from_huggingface_tokenizer(
                    tokenizer=tokenizer,
                    chunk_size=self.chunk_size,
                    chunk_overlap=self.chunk_overlap,
                    separators=self.separators,
                )
            else:
                self.text_splitter = CharacterTextSplitter.from_huggingface_tokenizer(
                    tokenizer=tokenizer,
                    chunk_size=self.chunk_size,
                    chunk_overlap=self.chunk_overlap,
                )

        except ImportError:
            logger.warning("transformers not available, falling back to tiktoken")
            self._initialize_tiktoken_splitter()
        except Exception as e:
            logger.error("Error initializing HuggingFace tokenizer: %s", str(e))
            self._initialize_tiktoken_splitter()

    def split_text(self, text: str) -> list[str]:
        """
        Split the input text into token-based chunks.

        Args:
            text: Input text to be chunked

        Returns:
            List of text chunks
        """
        if not text or not text.strip():
            logger.warning("Empty text provided to token-based chunking")
            return []

        try:
            chunks = self.text_splitter.split_text(text)

            # Log token statistics
            if hasattr(self, "_log_token_stats"):
                self._log_token_stats(text, chunks)

            logger.info("Token-based chunking created %d chunks", len(chunks))
            return chunks

        except Exception as e:
            logger.error("Error in token-based chunking: %s", str(e))
            return self._fallback_chunking(text)

    def _log_token_stats(self, original_text: str, chunks: list[str]):
        """Log token statistics for debugging using centralized utilities."""
        try:
            original_tokens = count_tokens(original_text, self.encoding_name)
            stats = get_chunk_statistics(chunks, self.encoding_name)

            logger.debug("Original text tokens: %d", original_tokens)
            logger.debug("Total chunks: %d", stats["total_chunks"])
            logger.debug("Average chunk tokens: %.1f", stats["avg_tokens"])
            logger.debug("Min/Max tokens: %d/%d", stats["min_tokens"], stats["max_tokens"])

        except Exception as e:
            logger.debug("Could not log token stats: %s", str(e))

    def _fallback_chunking(self, text: str) -> list[str]:
        """
        Fallback to simple character-based chunking.

        Args:
            text: Text to chunk

        Returns:
            List of text chunks
        """
        logger.info("Using fallback character-based chunking")

        # Rough estimate: 1 token ≈ 4 characters for English text
        char_chunk_size = self.chunk_size * 4
        char_overlap = self.chunk_overlap * 4

        chunks = []
        if len(text) <= char_chunk_size:
            chunks.append(text)
            return chunks

        for i in range(0, len(text), char_chunk_size - char_overlap):
            if i + char_chunk_size >= len(text):
                chunks.append(text[i:])
                break
            chunks.append(text[i : i + char_chunk_size])

        return chunks

    def get_token_count(self, text: str) -> int:
        """
        Get the token count for a given text using centralized utilities.

        Args:
            text: Text to count tokens for

        Returns:
            Number of tokens
        """
        return count_tokens(text, self.encoding_name)

    def get_metadata(self) -> dict[str, Any]:
        """
        Get metadata about the chunking strategy.

        Returns:
            Dictionary containing strategy metadata
        """
        metadata = super().get_metadata()
        metadata.update(
            {
                "encoding_name": self.encoding_name,
                "model_name": self.model_name,
                "tokenizer_type": self.tokenizer_type,
                "splitter_type": self.splitter_type,
                "separators": self.separators,
            }
        )
        return metadata


class GPTTokenChunkingStrategy(TokenBasedChunkingStrategy):
    """Specialized token chunking for OpenAI GPT models."""

    def __init__(self, model_name: str = "gpt-4", **kwargs):
        """
        Initialize GPT-specific token chunking.

        Args:
            model_name: GPT model name (gpt-4, gpt-3.5-turbo, etc.)
            **kwargs: Additional parameters
        """
        # Set appropriate encoding for different GPT models
        if "gpt-4" in model_name.lower():
            encoding_name = "cl100k_base"
        elif "gpt-3.5" in model_name.lower():
            encoding_name = "cl100k_base"  # Also uses cl100k_base
        else:
            encoding_name = "cl100k_base"  # Default for newer models

        super().__init__(encoding_name=encoding_name, model_name=model_name, tokenizer_type="tiktoken", **kwargs)


class ClaudeTokenChunkingStrategy(TokenBasedChunkingStrategy):
    """Specialized token chunking for Anthropic Claude models."""

    def __init__(self, **kwargs):
        """
        Initialize Claude-specific token chunking.

        Args:
            **kwargs: Additional parameters
        """
        # Claude uses a similar tokenization to GPT-4
        super().__init__(encoding_name="cl100k_base", model_name="claude", tokenizer_type="tiktoken", **kwargs)
