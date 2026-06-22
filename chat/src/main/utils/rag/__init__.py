"""
RAG utilities sub-package.

Groups strategy definitions, routing, prompt templates, fallback handling,
and research provider base classes into a cohesive unit.
Candidate for extraction as a standalone pip package (scrapalot-rag-utils).

Modules:
    strategies       - RAG strategy and orchestrator registries + class maps
    strategy_service - RAGStrategyService: streaming strategy selection / routing
    fallback_utils   - fallback_to_standard_search: shared RAG fallback logic
    prompt_utils     - Shared RAG prompt templates (chat + simple variants)
    research_utils   - Shared helpers for research provider result conversion
    provider_base    - ResearchProviderBase ABC + ResearchProviderError
"""
