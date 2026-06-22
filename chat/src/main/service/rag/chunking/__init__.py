"""
RAG Chunking Module

This module provides various text chunking strategies for RAG applications,
including basic strategies and advanced strategies for domain-specific and
unstructured texts. Enhanced with LangChain integration for improved performance.
"""

import logging
from typing import Any

# Import chunking strategies. (CE) Advanced chunkers (agentic, concept_aware,
# contextual_retrieval, hierarchical, late_chunking, narrative_structure,
# proposition, two_phase, topic_based) are a hosted-only feature and removed here.
from .base_chunking import BaseChunkingStrategy
from .chunking_enhanced_markdown import EnhancedMarkdownChunkingStrategy
from .chunking_recursive import RecursiveChunkingStrategy
from .chunking_semantic import SemanticChunkingStrategy
from .chunking_sliding_window import SlidingWindowChunkingStrategy


# LangChain-enhanced strategies
try:
    from .chunking_document_structure import (
        CodeChunkingStrategy,
        DocumentStructureChunkingStrategy,
        HTMLChunkingStrategy,
    )
    from .chunking_document_structure import MarkdownChunkingStrategy as LangChainMarkdownChunkingStrategy
    from .chunking_semantic import HuggingFaceSemanticChunkingStrategy, OpenAISemanticChunkingStrategy
    from .chunking_token_based import ClaudeTokenChunkingStrategy, GPTTokenChunkingStrategy, TokenBasedChunkingStrategy

    LANGCHAIN_STRATEGIES_AVAILABLE = True
except ImportError as e:
    CodeChunkingStrategy = None
    DocumentStructureChunkingStrategy = None
    HTMLChunkingStrategy = None
    LangChainMarkdownChunkingStrategy = None
    HuggingFaceSemanticChunkingStrategy = None
    OpenAISemanticChunkingStrategy = None
    ClaudeTokenChunkingStrategy = None
    GPTTokenChunkingStrategy = None
    TokenBasedChunkingStrategy = None
    logging.warning("Some LangChain-enhanced strategies not available: %s", str(e))
    LANGCHAIN_STRATEGIES_AVAILABLE = False

# Export all strategies
# noinspection PyUnresolvedReferences
__all__ = [
    # Base
    "BaseChunkingStrategy",
    "EnhancedMarkdownChunkingStrategy",
    "RecursiveChunkingStrategy",
    # Basic strategies
    "SemanticChunkingStrategy",
    "SlidingWindowChunkingStrategy",
    "get_available_strategies",
    # Factory functions
    "get_chunking_strategy",
    "get_langchain_strategies",
    "get_strategies_for_domain",
    "get_strategy_recommendations",
]

# Add LangChain strategies to exports if available
if LANGCHAIN_STRATEGIES_AVAILABLE:
    __all__.extend(
        [
            "ClaudeTokenChunkingStrategy",
            "CodeChunkingStrategy",
            "DocumentStructureChunkingStrategy",
            "GPTTokenChunkingStrategy",
            "HTMLChunkingStrategy",
            "HuggingFaceSemanticChunkingStrategy",
            "LangChainMarkdownChunkingStrategy",
            "OpenAISemanticChunkingStrategy",
            "TokenBasedChunkingStrategy",
        ]
    )


def get_chunking_strategy(strategy_name: str, chunk_size: int = 1000, chunk_overlap: int = 200, **kwargs) -> BaseChunkingStrategy:
    """
    Factory function to get a chunking strategy by name.

    Args:
        strategy_name: Name of the chunking strategy
        chunk_size: Size of each chunk
        chunk_overlap: Overlap between chunks
        **kwargs: Additional strategy-specific parameters

    Returns:
        Instance of the requested chunking strategy

    Raises:
        ValueError: If strategy_name is not recognized
    """
    strategies = {
        # Basic strategies (CE). Advanced/agentic chunkers are hosted-only.
        "semantic": SemanticChunkingStrategy,
        "markdown": EnhancedMarkdownChunkingStrategy,  # Map to enhanced_markdown for compatibility
        "recursive": RecursiveChunkingStrategy,
        "enhanced_markdown": EnhancedMarkdownChunkingStrategy,
        "sliding_window": SlidingWindowChunkingStrategy,
    }

    # Add LangChain strategies if available
    if LANGCHAIN_STRATEGIES_AVAILABLE:
        langchain_strategies = {
            # Token-based strategies
            "token_based": TokenBasedChunkingStrategy,
            "gpt_token": GPTTokenChunkingStrategy,
            "claude_token": ClaudeTokenChunkingStrategy,
            # Enhanced semantic strategies
            "openai_semantic": OpenAISemanticChunkingStrategy,
            "huggingface_semantic": HuggingFaceSemanticChunkingStrategy,
            # Document structure strategies
            "document_structure": DocumentStructureChunkingStrategy,
            "langchain_markdown": LangChainMarkdownChunkingStrategy,
            "html": HTMLChunkingStrategy,
            "code": CodeChunkingStrategy,
        }
        strategies.update(langchain_strategies)

    if strategy_name not in strategies:
        available = list(strategies.keys())
        raise ValueError(f"Unknown strategy '{strategy_name}'. Available: {available}")

    strategy_class = strategies[strategy_name]

    # Handle lazy-loaded strategies that might return None
    if strategy_class is None:
        raise ValueError(f"Strategy '{strategy_name}' is not available due to missing dependencies")

    return strategy_class(chunk_size=chunk_size, chunk_overlap=chunk_overlap, **kwargs)


def get_available_strategies() -> dict[str, dict[str, Any]]:
    """
    Get information about all available chunking strategies.

    Returns:
        Dictionary with strategy names as keys and metadata as values
    """
    strategies = {
        # Basic strategies
        "semantic": {
            "name": "Semantic Chunking",
            "description": "Splits text based on semantic similarity between sentences",
            "best_for": "General text where semantic coherence is important",
            "category": "basic",
            "complexity": "medium",
            "domains": ["general", "narrative", "academic"],
        },
        # Simple markdown removed - redirects to enhanced_markdown
        "markdown": {
            "name": "Enhanced Markdown Chunking (Alias)",
            "description": "Advanced markdown processing with metadata extraction (redirects to enhanced_markdown)",
            "best_for": "Markdown documents - automatically uses enhanced_markdown",
            "category": "basic",
            "complexity": "medium",
            "domains": ["documentation", "technical"],
        },
        "recursive": {
            "name": "Recursive Character Chunking",
            "description": "Recursively splits text using hierarchical separators",
            "best_for": "General text processing with natural language structure",
            "category": "basic",
            "complexity": "low",
            "domains": ["general", "mixed"],
        },
        "enhanced_markdown": {
            "name": "Enhanced Markdown Chunking",
            "description": "Advanced markdown processing with metadata extraction",
            "best_for": "Complex markdown documents with rich formatting",
            "category": "basic",
            "complexity": "medium",
            "domains": ["technical", "documentation"],
        },
        "proposition": {
            "name": "Proposition Chunking",
            "description": "Splits text into atomic, factual propositions",
            "best_for": "Knowledge extraction and fact-based retrieval",
            "category": "basic",
            "complexity": "medium",
            "domains": ["academic", "factual", "knowledge-base"],
        },
        # Advanced strategies
        "hierarchical": {
            "name": "Hierarchical Chunking",
            "description": "Preserves document hierarchy and nested structure (chapters, sections, subsections)",
            "best_for": "Academic papers, books, technical manuals with clear structure",
            "category": "advanced",
            "complexity": "high",
            "domains": ["academic", "technical", "legal"],
        },
        "topic_based": {
            "name": "Topic-Based Chunking",
            "description": "Groups content by thematic coherence using topic modeling (LDA, clustering)",
            "best_for": "Multi-topic documents, thematic organization",
            "category": "advanced",
            "complexity": "high",
            "domains": ["research", "multi-topic", "analysis"],
        },
        "sliding_window": {
            "name": "Sliding Window Chunking",
            "description": "Creates overlapping chunks with configurable overlap for enhanced context preservation",
            "best_for": "Complex narratives, maintaining context across boundaries",
            "category": "advanced",
            "complexity": "medium",
            "domains": ["narrative", "context-sensitive"],
        },
        "agentic": {
            "name": "Agentic Chunking",
            "description": "Uses LLM-powered intelligent analysis for boundary detection and proposition grouping",
            "best_for": "Complex academic texts, domain-specific content requiring intelligent analysis",
            "category": "advanced",
            "complexity": "very_high",
            "domains": ["academic", "specialized", "complex"],
            "requires_llm": True,
        },
        "concept_aware": {
            "name": "Concept-Aware Chunking",
            "description": "Preserves domain-specific terminology, concepts, and their relationships",
            "best_for": "Specialized domains (psychology, science, spirituality, occult, metaphysics)",
            "category": "advanced",
            "complexity": "high",
            "domains": ["psychology", "science", "spirituality", "history", "occult", "metaphysics"],
        },
        "narrative_structure": {
            "name": "Narrative Structure Chunking",
            "description": "Maintains story flow, temporal sequences, and narrative coherence",
            "best_for": "Historical texts, spiritual narratives, story-based content",
            "category": "advanced",
            "complexity": "high",
            "domains": ["historical", "spiritual", "narrative", "biographical"],
        },
        "contextual_retrieval": {
            "name": "Contextual Retrieval Chunking",
            "description": "Anthropic's approach with context-enhanced chunk headers",
            "best_for": "High-precision retrieval with 35-49% improvement in accuracy",
            "category": "advanced",
            "complexity": "high",
            "domains": ["precision", "high-accuracy", "research"],
        },
        "late_chunking": {
            "name": "Late Chunking",
            "description": "Jina AI's approach - embed full document then chunk for enhanced context",
            "best_for": "Maximum context preservation and semantic coherence",
            "category": "advanced",
            "complexity": "high",
            "domains": ["semantic", "context-heavy", "research"],
        },
        "two_phase": {
            "name": "Two-Phase Intelligent Chunking",
            "description": "Step 1: Header-aware splitting with boundary detection. Step 2: Size optimization with smart merging",
            "best_for": "Complex documents requiring both structure preservation and optimal chunk sizes",
            "category": "advanced",
            "complexity": "high",
            "domains": ["technical", "academic", "structured", "mixed-format"],
            "features": ["boundary_detection", "smart_merging", "size_optimization", "structure_preservation"],
        },
    }

    # Add LangChain strategies if available
    if LANGCHAIN_STRATEGIES_AVAILABLE:
        langchain_strategies = {
            # Token-based strategies
            "token_based": {
                "name": "Token-Based Chunking",
                "description": "Precise token-aware chunking using various tokenizers (tiktoken, HuggingFace)",
                "best_for": "LLM-optimized chunking with exact token control",
                "category": "langchain",
                "complexity": "medium",
                "domains": ["llm-optimized", "api-constrained"],
                "supports_models": ["GPT-4", "GPT-3.5", "Claude", "custom"],
            },
            "gpt_token": {
                "name": "GPT Token Chunking",
                "description": "Optimized token chunking for OpenAI GPT models",
                "best_for": "OpenAI API integration with precise token control",
                "category": "langchain",
                "complexity": "medium",
                "domains": ["openai-optimized"],
                "supports_models": ["GPT-4", "GPT-3.5-turbo"],
            },
            "claude_token": {
                "name": "Claude Token Chunking",
                "description": "Optimized token chunking for Anthropic Claude models",
                "best_for": "Claude API integration with precise token control",
                "category": "langchain",
                "complexity": "medium",
                "domains": ["claude-optimized"],
                "supports_models": ["Claude-3", "Claude-2"],
            },
            "openai_semantic": {
                "name": "OpenAI Semantic Chunking",
                "description": "Semantic chunking optimized for OpenAI embeddings",
                "best_for": "High-quality semantic chunking with OpenAI's embedding models",
                "category": "langchain",
                "complexity": "high",
                "domains": ["openai-semantic"],
                "supports_embeddings": ["text-embedding-ada-002", "text-embedding-3-small"],
            },
            "huggingface_semantic": {
                "name": "HuggingFace Semantic Chunking",
                "description": "Semantic chunking using HuggingFace embedding models",
                "best_for": "Open-source semantic chunking with various embedding models",
                "category": "langchain",
                "complexity": "high",
                "domains": ["open-source", "cost-effective"],
                "supports_embeddings": ["sentence-transformers", "all-MiniLM", "custom"],
            },
            "document_structure": {
                "name": "Document Structure Chunking",
                "description": "Auto-detects document type and uses appropriate structure-aware splitting",
                "best_for": "Mixed document types with automatic format detection",
                "category": "langchain",
                "complexity": "medium",
                "domains": ["mixed-format", "auto-detection"],
                "supports_formats": ["Markdown", "HTML", "Code", "Plain text"],
            },
            "langchain_markdown": {
                "name": "LangChain Markdown Chunking",
                "description": "Advanced Markdown chunking preserving headers and structure",
                "best_for": "Complex Markdown documents with hierarchical structure",
                "category": "langchain",
                "complexity": "medium",
                "domains": ["documentation", "technical-writing"],
            },
            "html": {
                "name": "HTML Structure Chunking",
                "description": "HTML-aware chunking preserving tags and semantic structure",
                "best_for": "Web pages and HTML documents",
                "category": "langchain",
                "complexity": "medium",
                "domains": ["web-content", "html-documents"],
            },
            "code": {
                "name": "Code Structure Chunking",
                "description": "Language-aware code chunking preserving functions and classes",
                "best_for": "Source code and programming documentation",
                "category": "langchain",
                "complexity": "medium",
                "domains": ["code-analysis", "programming"],
                "supports_languages": ["Python", "JavaScript", "Java", "C++", "many others"],
            },
        }
        strategies.update(langchain_strategies)

    return strategies


def get_strategies_for_domain(domain: str) -> list[str]:
    """
    Get recommended chunking strategies for a specific domain.

    Args:
        domain: Domain name (e.g., "psychology", "spirituality", "code")

    Returns:
        List of recommended strategy names, ordered by preference
    """
    domain_mappings = {
        # Academic and research domains
        "psychology": ["concept_aware", "huggingface_semantic", "agentic", "semantic", "proposition"],
        "spirituality": ["concept_aware", "narrative_structure", "huggingface_semantic", "agentic", "semantic"],
        "science": ["concept_aware", "hierarchical", "huggingface_semantic", "agentic", "proposition"],
        "history": ["narrative_structure", "concept_aware", "hierarchical", "huggingface_semantic"],
        "occult": ["concept_aware", "huggingface_semantic", "agentic", "semantic", "proposition"],
        "metaphysics": ["concept_aware", "agentic", "hierarchical", "huggingface_semantic", "semantic"],
        "philosophy": ["concept_aware", "hierarchical", "huggingface_semantic", "agentic"],
        # Document type domains
        "academic": ["hierarchical", "two_phase", "agentic", "concept_aware", "huggingface_semantic", "proposition"],
        "technical": ["two_phase", "document_structure", "hierarchical", "langchain_markdown", "enhanced_markdown"],
        "narrative": ["narrative_structure", "sliding_window", "huggingface_semantic", "semantic"],
        "multi_topic": ["topic_based", "hierarchical", "huggingface_semantic", "semantic"],
        "documentation": ["two_phase", "document_structure", "langchain_markdown", "hierarchical", "enhanced_markdown"],
        # Content type domains
        "code": ["code", "document_structure", "hierarchical"],
        "web": ["html", "document_structure", "enhanced_markdown"],
        "markdown": ["langchain_markdown", "enhanced_markdown", "document_structure"],
        "mixed": ["two_phase", "document_structure", "recursive", "huggingface_semantic"],
        "structured": ["two_phase", "hierarchical", "document_structure", "enhanced_markdown"],
        # LLM-optimized domains
        "openai": ["gpt_token", "openai_semantic", "token_based"],
        "claude": ["claude_token", "token_based", "huggingface_semantic"],
        "api_optimized": ["token_based", "gpt_token", "claude_token"],
        # General domains
        "general": ["recursive", "huggingface_semantic", "semantic", "enhanced_markdown"],
        "default": ["recursive", "semantic", "enhanced_markdown"],
    }

    # Filter strategies based on availability
    strategies = domain_mappings.get(domain.lower(), domain_mappings["default"])

    if not LANGCHAIN_STRATEGIES_AVAILABLE:
        # Filter out LangChain strategies if not available
        langchain_strategies = {
            "token_based",
            "gpt_token",
            "claude_token",
            "huggingface_semantic",
            "openai_semantic",
            "document_structure",
            "langchain_markdown",
            "html",
            "code",
        }
        strategies = [s for s in strategies if s not in langchain_strategies]

    return strategies


def get_strategy_recommendations(
    text_length: int,
    content_type: str = "general",
    domain: str = None,
    _structure_level: str = "medium",
    model_target: str = None,
    embedding_preference: str = None,
) -> dict[str, Any]:
    """
    Get intelligent strategy recommendations based on text characteristics.

    Args:
        text_length: Length of text in characters
        content_type: Type of content ("academic", "narrative", "technical", etc.)
        domain: Subject domain (psychology, spirituality, etc.)
        _structure_level: Document structure level ("low", "medium", "high")
        model_target: Target LLM model ("gpt-4", "claude", etc.)
        embedding_preference: Preferred embedding provider ("openai", "huggingface", etc.)

    Returns:
        Dictionary with recommendations and reasoning
    """
    recommendations = {"primary": None, "alternatives": [], "reasoning": "", "configuration": {}}

    # Model-specific recommendations
    if model_target:
        if "gpt" in model_target.lower():
            if LANGCHAIN_STRATEGIES_AVAILABLE:
                # noinspection PyUnresolvedReferences
                recommendations["primary"] = "gpt_token"
                # noinspection PyUnresolvedReferences
                recommendations["configuration"]["model_name"] = model_target
            else:
                # noinspection PyUnresolvedReferences
                recommendations["primary"] = "recursive"
        elif "claude" in model_target.lower():
            if LANGCHAIN_STRATEGIES_AVAILABLE:
                # noinspection PyUnresolvedReferences
                recommendations["primary"] = "claude_token"
                # noinspection PyUnresolvedReferences
                recommendations["configuration"]["model_name"] = model_target
            else:
                # noinspection PyUnresolvedReferences
                recommendations["primary"] = "recursive"

    # Embedding-specific recommendations
    elif embedding_preference:
        if embedding_preference == "openai" and LANGCHAIN_STRATEGIES_AVAILABLE:
            recommendations["primary"] = "openai_semantic"
        elif embedding_preference == "huggingface" and LANGCHAIN_STRATEGIES_AVAILABLE:
            recommendations["primary"] = "huggingface_semantic"
        else:
            recommendations["primary"] = "semantic"

    # Domain-specific recommendations
    elif domain:
        domain_strategies = get_strategies_for_domain(domain)
        if domain_strategies:
            recommendations["primary"] = domain_strategies[0]
            recommendations["alternatives"] = domain_strategies[1:3]

    # Content type recommendations
    elif content_type:
        if content_type == "code" and LANGCHAIN_STRATEGIES_AVAILABLE:
            recommendations["primary"] = "code"
        elif content_type == "html" and LANGCHAIN_STRATEGIES_AVAILABLE:
            recommendations["primary"] = "html"
        elif content_type == "markdown":
            if LANGCHAIN_STRATEGIES_AVAILABLE:
                recommendations["primary"] = "langchain_markdown"
            else:
                recommendations["primary"] = "enhanced_markdown"
        elif content_type == "academic":
            recommendations["primary"] = "hierarchical"
        elif content_type == "narrative":
            recommendations["primary"] = "narrative_structure"
        else:
            if LANGCHAIN_STRATEGIES_AVAILABLE:
                recommendations["primary"] = "document_structure"
            else:
                recommendations["primary"] = "recursive"

    # Fallback to general recommendations
    if not recommendations["primary"]:
        if LANGCHAIN_STRATEGIES_AVAILABLE:
            recommendations["primary"] = "huggingface_semantic"
        else:
            recommendations["primary"] = "semantic"

    # Add alternatives if not set
    if not recommendations["alternatives"]:
        all_strategies = ["recursive", "semantic", "enhanced_markdown"]
        if LANGCHAIN_STRATEGIES_AVAILABLE:
            all_strategies = ["huggingface_semantic", "token_based", "document_structure", *all_strategies]

        # noinspection PyUnresolvedReferences
        recommendations["alternatives"] = [s for s in all_strategies if s != recommendations["primary"]][:3]

    # Adjust chunk size based on text length
    if text_length < 2000:
        # noinspection PyUnresolvedReferences
        recommendations["configuration"]["chunk_size"] = 500
        # noinspection PyUnresolvedReferences
        recommendations["configuration"]["chunk_overlap"] = 100
    elif text_length < 10000:
        # noinspection PyUnresolvedReferences
        recommendations["configuration"]["chunk_size"] = 1000
        # noinspection PyUnresolvedReferences
        recommendations["configuration"]["chunk_overlap"] = 200
    else:
        # noinspection PyUnresolvedReferences
        recommendations["configuration"]["chunk_size"] = 1500
        # noinspection PyUnresolvedReferences
        recommendations["configuration"]["chunk_overlap"] = 300

    # Build reasoning
    reasoning_parts = []
    if model_target:
        reasoning_parts.append(f"Optimized for {model_target}")
    if domain:
        reasoning_parts.append(f"Domain-specific strategy for {domain}")
    if content_type != "general":
        reasoning_parts.append(f"Content type: {content_type}")
    if text_length:
        reasoning_parts.append(f"Text length: {text_length} characters")

    if not reasoning_parts:
        reasoning_parts.append("General-purpose recommendation")

    recommendations["reasoning"] = "; ".join(reasoning_parts)

    return recommendations


def get_langchain_strategies() -> dict[str, bool]:
    """
    Get information about LangChain strategy availability.

    Returns:
        Dictionary indicating which LangChain features are available
    """
    return {
        "langchain_available": LANGCHAIN_STRATEGIES_AVAILABLE,
        "token_strategies": LANGCHAIN_STRATEGIES_AVAILABLE,
        "semantic_strategies": LANGCHAIN_STRATEGIES_AVAILABLE,
        "structure_strategies": LANGCHAIN_STRATEGIES_AVAILABLE,
        "experimental_features": LANGCHAIN_STRATEGIES_AVAILABLE,
    }
