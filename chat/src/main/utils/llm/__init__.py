"""
LLM utilities sub-package.

Groups model management, provider configuration, agent setup, embedding
resolution, streaming, and usage tracking into a cohesive unit.
Candidate for extraction as a standalone pip package
(``scrapalot-llm-utils``).

Modules:
    model_utils        - Core LLM utilities: API key resolution, model
                         discovery, provider helpers
    agent_model_utils  - Pydantic AI agent model config
                         (``AgentModelConfig``, ``get_system_agent_model``)
    provider_utils     - ``model_providers`` / ``model_provider_models``
                         table queries
    pydantic_ai_utils  - LangChain → Pydantic AI model conversion
                         (``get_agentic_model_string``)
    model_name_utils   - Model name normalisation for display / file path /
                         comparison
    openai_retry       - OpenAI rate-limit detection and retry factory
    embedding_resolver - GPU/CPU-aware embedding model selection
    streaming          - Reasoning-aware streaming
                         (``handle_streaming_with_type``,
                         ``token_metrics_to_dict``)
    usage_tracker      - System-level (``llm_traces``) + user-level
                         (Redis Stream → Kotlin) LLM usage tracking
                         and ``estimate_cost`` / ``MODEL_PRICING``
"""
