"""
Token utilities sub-package.

Groups tokenization, budget tracking, and usage reporting into one place.
Candidate for extraction as a standalone pip package (scrapalot-token-utils).

Modules:
    counting       - get_tokenizer, count_tokens, split_text_by_tokens (tiktoken-based)
    budget         - TokenBudget: context window budget tracker
    usage_tracker  - increment_token_usage: Redis Streams publisher to Kotlin backend
"""
