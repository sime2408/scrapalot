"""
Centralized tokenization utilities for text chunking.

This module provides reusable tokenization functions used across all chunking strategies.
It ensures consistent token counting and text splitting throughout the RAG system.
"""

import tiktoken

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Global tokenizer cache to avoid reloading encodings
_TOKENIZER_CACHE = {}


def get_tokenizer(encoding_name: str = "cl100k_base") -> tiktoken.Encoding:
    """
    Get a cached tokenizer for the specified encoding.

    Args:
        encoding_name: Tokenizer encoding name. Common options:
            - "cl100k_base": GPT-4, GPT-3.5-turbo, text-embedding-ada-002
            - "p50k_base": GPT-3 (davinci, curie, babbage, ada)
            - "r50k_base": GPT-2
            - "o200k_base": GPT-4o models

    Returns:
        Tiktoken encoding instance

    Raises:
        ValueError: If encoding name is invalid
    """
    if encoding_name not in _TOKENIZER_CACHE:
        try:
            _TOKENIZER_CACHE[encoding_name] = tiktoken.get_encoding(encoding_name)
            logger.debug("Loaded tokenizer: %s", encoding_name)
        except Exception as e:
            logger.error("Failed to load tokenizer '%s': %s", encoding_name, e)
            # Fallback to cl100k_base if the requested encoding fails
            if encoding_name != "cl100k_base":
                logger.warning("Falling back to cl100k_base tokenizer")
                return get_tokenizer("cl100k_base")
            raise ValueError(f"Failed to load tokenizer '{encoding_name}': {e}") from e

    return _TOKENIZER_CACHE[encoding_name]


def count_tokens(text: str, encoding_name: str = "cl100k_base") -> int:
    """
    Count the number of tokens in a text string.

    Args:
        text: Text to count tokens for
        encoding_name: Tokenizer encoding to use

    Returns:
        Number of tokens in the text
    """
    if not text:
        return 0

    try:
        tokenizer = get_tokenizer(encoding_name)
        return len(tokenizer.encode(text))
    except Exception as e:
        logger.warning("Failed to count tokens using %s, using character approximation: %s", encoding_name, e)
        # Fallback: approximate 1 token = 4 characters
        return len(text) // 4


def split_text_by_tokens(
    text: str,
    chunk_size: int,
    chunk_overlap: int = 0,
    encoding_name: str = "cl100k_base",
) -> list[str]:
    """
    Split text by token count with optional overlap.

    This is the core token-based splitting function used by all chunking strategies.

    Args:
        text: Text to split
        chunk_size: Target chunk size in tokens
        chunk_overlap: Overlap size in tokens (default: 0)
        encoding_name: Tokenizer encoding to use

    Returns:
        List of text chunks split by token boundaries

    Example:
        >>> text = "This is a long document that needs to be split into chunks."
        >>> chunks = split_text_by_tokens(text, chunk_size=10, chunk_overlap=2)
        >>> # Returns chunks of ~10 tokens each with 2 tokens overlap
    """
    if not text:
        return []

    if chunk_overlap >= chunk_size:
        logger.warning("Chunk overlap (%s) >= chunk size (%s). Setting overlap to 20%% of chunk size.", chunk_overlap, chunk_size)
        chunk_overlap = int(chunk_size * 0.2)

    try:
        tokenizer = get_tokenizer(encoding_name)
        tokens = tokenizer.encode(text)

        if not tokens:
            return []

        chunks = []
        start_idx = 0

        while start_idx < len(tokens):
            # Get a chunk of tokens
            end_idx = min(start_idx + chunk_size, len(tokens))
            chunk_tokens = tokens[start_idx:end_idx]

            # Decode tokens back to text
            chunk_text = tokenizer.decode(chunk_tokens)
            if chunk_text.strip():
                chunks.append(chunk_text.strip())

            # Move the start position forward (with overlap)
            start_idx += chunk_size - chunk_overlap

            # Break if we're at the end
            if end_idx >= len(tokens):
                break

        logger.debug("Split %s tokens into %s chunks (size=%s, overlap=%s)", len(tokens), len(chunks), chunk_size, chunk_overlap)

        return chunks

    except Exception as e:
        logger.error("Failed to split text by tokens: %s, falling back to character-based splitting", e)
        # Fallback to character-based splitting with 4:1 ratio approximation
        approx_char_size = chunk_size * 4
        approx_char_overlap = chunk_overlap * 4
        return split_text_by_characters(text, approx_char_size, approx_char_overlap)


def split_text_by_characters(text: str, char_size: int, char_overlap: int = 0) -> list[str]:
    """
    Fallback character-based splitting when token splitting fails.

    This function preserves word boundaries when splitting.

    Args:
        text: Text to split
        char_size: Chunk size in characters
        char_overlap: Overlap size in characters

    Returns:
        List of text chunks split by character boundaries
    """
    if not text:
        return []

    if char_overlap >= char_size:
        logger.warning("Character overlap (%s) >= chunk size (%s). Setting overlap to 20%% of chunk size.", char_overlap, char_size)
        char_overlap = int(char_size * 0.2)

    chunks = []
    start = 0

    while start < len(text):
        end = min(start + char_size, len(text))

        # Try to break at word boundary
        if end < len(text):
            # Look for last space within last 20% of chunk
            search_start = max(start, end - int(char_size * 0.2))
            last_space = text.rfind(" ", search_start, end)
            if last_space > start:
                end = last_space + 1

        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        start += char_size - char_overlap

    return chunks


def filter_chunks_by_token_count(chunks: list[str], min_tokens: int, encoding_name: str = "cl100k_base") -> list[str]:
    """
    Filter out chunks that are too small based on token count.

    Args:
        chunks: List of text chunks
        min_tokens: Minimum token count threshold
        encoding_name: Tokenizer encoding to use

    Returns:
        Filtered list of chunks that meet the minimum token requirement
    """
    if not chunks:
        return []

    filtered = []
    filtered_count = 0

    for chunk in chunks:
        token_count = count_tokens(chunk, encoding_name)
        if token_count >= min_tokens:
            filtered.append(chunk)
        else:
            filtered_count += 1
            logger.debug("Filtered out chunk with %s tokens (< %s minimum)", token_count, min_tokens)

    if filtered_count > 0:
        logger.info("Filtered out %s chunks below %s token threshold", filtered_count, min_tokens)

    return filtered


def estimate_character_to_token_ratio(text: str, encoding_name: str = "cl100k_base") -> float:
    """
    Estimate the character-to-token ratio for a given text.

    This is useful for approximating token counts when exact tokenization is not available.

    Args:
        text: Sample text to analyze
        encoding_name: Tokenizer encoding to use

    Returns:
        Average characters per token (typically around 4.0)

    Example:
        >>> text = "This is a sample text for ratio estimation."
        >>> ratio = estimate_character_to_token_ratio(text)
        >>> # Returns ~4.0 (characters per token)
    """
    if not text:
        return 4.0  # Default ratio

    try:
        token_count = count_tokens(text, encoding_name)
        if token_count == 0:
            return 4.0
        return len(text) / token_count
    except Exception as e:
        logger.warning("Failed to estimate character-to-token ratio: %s", e)
        return 4.0  # Default fallback


def tokens_to_characters_approx(tokens: int, ratio: float = 4.0) -> int:
    """
    Approximate number of characters from token count.

    Args:
        tokens: Number of tokens
        ratio: Characters per token (default: 4.0)

    Returns:
        Approximate number of characters
    """
    return int(tokens * ratio)


def characters_to_tokens_approx(characters: int, ratio: float = 4.0) -> int:
    """
    Approximate number of tokens from character count.

    Args:
        characters: Number of characters
        ratio: Characters per token (default: 4.0)

    Returns:
        Approximate number of tokens
    """
    return int(characters / ratio)


def get_chunk_statistics(chunks: list[str], encoding_name: str = "cl100k_base") -> dict:
    """
    Calculate statistics about a list of chunks.

    Args:
        chunks: List of text chunks
        encoding_name: Tokenizer encoding to use

    Returns:
        Dictionary with statistics:
            - total_chunks: Number of chunks
            - total_tokens: Total token count
            - avg_tokens: Average tokens per chunk
            - min_tokens: Minimum tokens in a chunk
            - max_tokens: Maximum tokens in a chunk
            - total_chars: Total character count
            - avg_chars: Average characters per chunk
    """
    if not chunks:
        return {
            "total_chunks": 0,
            "total_tokens": 0,
            "avg_tokens": 0,
            "min_tokens": 0,
            "max_tokens": 0,
            "total_chars": 0,
            "avg_chars": 0,
        }

    token_counts = [count_tokens(chunk, encoding_name) for chunk in chunks]
    char_counts = [len(chunk) for chunk in chunks]

    return {
        "total_chunks": len(chunks),
        "total_tokens": sum(token_counts),
        "avg_tokens": sum(token_counts) / len(chunks),
        "min_tokens": min(token_counts),
        "max_tokens": max(token_counts),
        "total_chars": sum(char_counts),
        "avg_chars": sum(char_counts) / len(chunks),
    }


def validate_chunk_size(chunk_size: int, chunk_overlap: int) -> tuple[int, int]:
    """
    Validate and adjust chunk size and overlap parameters.

    Args:
        chunk_size: Target chunk size in tokens
        chunk_overlap: Overlap size in tokens

    Returns:
        Tuple of (validated_chunk_size, validated_overlap)
    """
    # Ensure positive values
    chunk_size = max(1, chunk_size)
    chunk_overlap = max(0, chunk_overlap)

    # Ensure overlap is less than chunk size
    if chunk_overlap >= chunk_size:
        logger.warning("Chunk overlap (%s) >= chunk size (%s). Adjusting overlap to 20%% of chunk size.", chunk_overlap, chunk_size)
        chunk_overlap = int(chunk_size * 0.2)

    return chunk_size, chunk_overlap


def clear_tokenizer_cache():
    """
    Clear the tokenizer cache.

    Useful for freeing memory or forcing tokenizer reload.
    """
    _TOKENIZER_CACHE.clear()
    logger.info("Tokenizer cache cleared")
