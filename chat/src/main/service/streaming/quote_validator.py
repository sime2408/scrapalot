"""
Quote Validator for streaming citation system.
Validates quotes against source documents using fuzzy matching.
"""

from difflib import SequenceMatcher

from langchain_core.documents import Document

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class QuoteValidator:
    """
    Validates quotes against source documents using fuzzy string matching.

    Features:
    - Fuzzy matching with configurable threshold
    - Handles minor variations (punctuation, whitespace, case)
    - Returns match score and best matching document
    - Supports partial quote matching
    """

    def __init__(
        self,
        context_docs: list[Document],
        min_match_threshold: float = 0.85,
        min_quote_length: int = 20,
        case_sensitive: bool = False,
    ):
        """
        Initialize the quote validator.

        Args:
            context_docs: List of source documents to validate against
            min_match_threshold: Minimum similarity score (0-1) to consider a match
            min_quote_length: Minimum quote length to validate (shorter quotes skipped)
            case_sensitive: Whether to perform case-sensitive matching
        """
        self.context_docs = context_docs
        self.min_match_threshold = min_match_threshold
        self.min_quote_length = min_quote_length
        self.case_sensitive = case_sensitive

        # Preprocess documents for faster matching
        self._preprocessed_docs = self._preprocess_documents()

        logger.debug("QuoteValidator initialized with %d documents, threshold=%.2f", len(context_docs), min_match_threshold)

    def _preprocess_documents(self) -> list[str]:
        """
        Preprocess documents for matching.

        Returns:
            List of preprocessed document contents
        """
        preprocessed = []
        for doc in self.context_docs:
            content = doc.page_content
            if not self.case_sensitive:
                content = content.lower()
            # Normalize whitespace
            content = " ".join(content.split())
            preprocessed.append(content)
        return preprocessed

    def _normalize_quote(self, quote: str) -> str:
        """
        Normalize a quote for matching.

        Args:
            quote: The quote to normalize

        Returns:
            Normalized quote string
        """
        if not self.case_sensitive:
            quote = quote.lower()
        # Normalize whitespace
        quote = " ".join(quote.split())
        # Strip any combination of straight and curly quote marks from the ends.
        # The multi-char strip is intentional: each char is a distinct quote
        # style ("', ', “, ”), each independently stripped.
        quote = quote.strip('"\'""')  # noqa: B005
        return quote

    @staticmethod
    def _calculate_similarity(quote: str, text: str) -> float:
        """
        Calculate similarity between quote and text using SequenceMatcher.

        Args:
            quote: The quote to match
            text: The text to match against

        Returns:
            Similarity score between 0 and 1
        """
        # Try exact substring match first (fastest)
        if quote in text:
            return 1.0

        # Use SequenceMatcher for fuzzy matching
        matcher = SequenceMatcher(None, quote, text)

        # Find the best matching block
        match = matcher.find_longest_match(0, len(quote), 0, len(text))

        if match.size == 0:
            return 0.0

        # Calculate ratio based on the longest match
        ratio = match.size / len(quote)

        # Also consider overall similarity
        overall_ratio = matcher.ratio()

        # Return the better of the two scores
        return max(ratio, overall_ratio)

    def validate_quote(self, quote: str, citation_num: int | None = None) -> tuple[bool, float, int | None]:
        """
        Validate a quote against source documents.

        Args:
            quote: The quote to validate
            citation_num: Optional 1-based citation number (e.g., [1], [2]) to check specific document

        Returns:
            Tuple of (is_valid, match_score, document_index)
            - is_valid: Whether quote passes threshold
            - match_score: Best similarity score found (0-1)
            - document_index: 0-based index of best matching document (None if no match)
        """
        # Skip validation for very short quotes
        if len(quote) < self.min_quote_length:
            logger.debug("Quote too short (%d chars), skipping validation", len(quote))
            return True, 1.0, None

        normalized_quote = self._normalize_quote(quote)

        # If citation number provided, convert from 1-based to 0-based index
        if citation_num is not None:
            doc_idx = citation_num - 1  # Convert 1-based citation to 0-based index

            if 0 <= doc_idx < len(self._preprocessed_docs):
                score = self._calculate_similarity(normalized_quote, self._preprocessed_docs[doc_idx])

                is_valid = score >= self.min_match_threshold

                logger.debug(
                    "Quote validation for citation [%d] (doc_idx=%d): score=%.2f, valid=%s",
                    citation_num,
                    doc_idx,
                    score,
                    is_valid,
                )

                return is_valid, score, doc_idx if is_valid else None

        # Otherwise, check all documents and find best match
        best_score = 0.0
        best_doc_idx = None

        for idx, doc_content in enumerate(self._preprocessed_docs):
            score = self._calculate_similarity(normalized_quote, doc_content)

            if score > best_score:
                best_score = score
                best_doc_idx = idx

                # Early exit if we found a perfect match
                if score == 1.0:
                    break

        is_valid = best_score >= self.min_match_threshold

        logger.debug("Quote validation: best_score=%.2f, valid=%s, doc_idx=%s", best_score, is_valid, best_doc_idx)

        return is_valid, best_score, best_doc_idx if is_valid else None

    def validate_quote_batch(self, quotes: list[tuple[str, int | None]]) -> list[tuple[bool, float, int | None]]:
        """
        Validate multiple quotes in batch.

        Args:
            quotes: List of (quote, citation_num) tuples

        Returns:
            List of validation results (is_valid, score, doc_idx)
        """
        results = []
        for quote, citation_num in quotes:
            result = self.validate_quote(quote, citation_num)
            results.append(result)

        # Log batch statistics
        valid_count = sum(1 for r in results if r[0])
        avg_score = sum(r[1] for r in results) / len(results) if results else 0.0

        logger.info("Batch validation: %d/%d valid, avg_score=%.2f", valid_count, len(results), avg_score)

        return results

    def get_quote_context(self, quote: str, doc_idx: int, context_chars: int = 100) -> str | None:
        """
        Get surrounding context for a quote in a document.

        Args:
            quote: The quote to find
            doc_idx: Document index
            context_chars: Number of characters of context on each side

        Returns:
            Context string with quote highlighted, or None if not found
        """
        if doc_idx < 0 or doc_idx >= len(self.context_docs):
            return None

        content = self.context_docs[doc_idx].page_content

        # Try exact match first (case-insensitive if configured)
        search_content = content if self.case_sensitive else content.lower()
        search_quote = quote if self.case_sensitive else quote.lower()

        pos = search_content.find(search_quote)

        if pos == -1:
            # Try with normalized whitespace
            pass

            # Normalize whitespace in both strings
            normalized_content = " ".join(content.split())
            normalized_quote = " ".join(quote.split())

            search_normalized_content = normalized_content if self.case_sensitive else normalized_content.lower()
            search_normalized_quote = normalized_quote if self.case_sensitive else normalized_quote.lower()

            pos = search_normalized_content.find(search_normalized_quote)

            if pos == -1:
                return None

            # Use normalized content for extraction
            start = max(0, pos - context_chars)
            end = min(len(normalized_content), pos + len(search_normalized_quote) + context_chars)
            context = normalized_content[start:end]

            # Add ellipsis if truncated (use normalized_content length)
            if start > 0:
                context = "..." + context
            if end < len(normalized_content):
                context = context + "..."
        else:
            # Use original content for extraction
            start = max(0, pos - context_chars)
            end = min(len(content), pos + len(search_quote) + context_chars)
            context = content[start:end]

            # Add ellipsis if truncated (use original content length)
            if start > 0:
                context = "..." + context
            if end < len(content):
                context = context + "..."

        return context
