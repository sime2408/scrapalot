"""
Backward compatibility shim.

User-level token usage publishing was merged into the consolidated
``src.main.utils.llm.usage_tracker`` so all LLM-cost paths (system-level
trace rows + user-level Redis Stream events) live in one place. This
module continues to re-export ``increment_token_usage`` from there so
existing call sites keep working.
"""

from src.main.utils.llm.usage_tracker import increment_token_usage  # noqa: F401
