"""
Token budget tracking for RAG context window enforcement.

Tracks accumulated tokens against a budget limit to prevent context window overflow.
Uses tiktoken via chunking_utils for accurate token counting.
"""

from src.main.utils.core.logger import get_logger
from src.main.utils.tokens.counting import count_tokens, get_tokenizer

logger = get_logger(__name__)


class TokenBudget:
    """Track accumulated tokens against a budget limit."""

    def __init__(self, max_tokens: int, reserve_tokens: int = 2000):
        """
        Args:
            max_tokens: Total context window budget
            reserve_tokens: Tokens reserved for system prompt + output
        """
        self.max_tokens = max_tokens
        self.reserve_tokens = reserve_tokens
        self.available = max_tokens - reserve_tokens
        self.used = 0

    @property
    def remaining(self) -> int:
        return max(0, self.available - self.used)

    @property
    def is_exhausted(self) -> bool:
        return self.used >= self.available

    @staticmethod
    def estimate(text: str) -> int:
        """Count tokens without adding to budget."""
        return count_tokens(text) if text else 0

    def can_fit(self, text: str) -> bool:
        """Check if text fits within remaining budget."""
        return self.estimate(text) <= self.remaining

    def add(self, text: str) -> int:
        """Add text to budget, return token count."""
        tokens = self.estimate(text)
        self.used += tokens
        return tokens

    def try_add(self, text: str) -> bool:
        """Add text only if it fits. Returns True if added."""
        tokens = self.estimate(text)
        if tokens <= self.remaining:
            self.used += tokens
            return True
        return False

    def truncate_to_fit(self, text: str) -> str:
        """Truncate text to fit remaining budget using binary search on tokens."""
        if not text:
            return ""
        if self.can_fit(text):
            self.add(text)
            return text
        if self.remaining <= 0:
            return ""
        try:
            tokenizer = get_tokenizer()
            tokens = tokenizer.encode(text)
            truncated_tokens = tokens[: self.remaining]
            result = tokenizer.decode(truncated_tokens)
            self.used += len(truncated_tokens)
            return result
        except Exception as e:
            logger.warning("Token truncation failed, using char approximation: %s", e)
            char_limit = self.remaining * 4
            result = text[:char_limit]
            self.used += self.remaining
            return result
