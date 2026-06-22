"""
RAG strategy registry — Community Edition.

The hosted product ships 30+ strategies and 9 orchestrators with agentic routing.
The Community Edition exposes a small, dependency-light set: dense vector search plus
sparse (BM25) and regex/grep lexical retrieval. There are no orchestrators and no
agentic routing in CE — selection is direct.
"""

from src.main.service.rag.rag_regex_grep import RAGRegexGrep
from src.main.service.rag.rag_similarity_search import RAGSimilaritySearch
from src.main.service.rag.rag_sparse_search import RAGSparseSearch

# Strategy metadata (name + human description) — used by the settings/info surfaces.
RAG_INDIVIDUAL_STRATEGIES = [
    {
        "name": "RAGSimilaritySearch",
        "display_name": "Similarity Search",
        "description": "Dense vector similarity search over your document embeddings (pgvector).",
    },
    {
        "name": "RAGSparseSearch",
        "display_name": "Sparse (BM25)",
        "description": "Lexical BM25 keyword search — strong for exact terms and rare tokens.",
    },
    {
        "name": "RAGRegexGrep",
        "display_name": "Regex / Grep",
        "description": "Fast literal/regex grep over document text for precise term lookups.",
    },
]

# No orchestrators in the Community Edition.
RAG_ORCHESTRATORS: list[dict] = []
RAG_STRATEGIES = RAG_INDIVIDUAL_STRATEGIES + RAG_ORCHESTRATORS

DEFAULT_RAG_STRATEGY = "RAGSimilaritySearch"
DEFAULT_RAG_ORCHESTRATOR = None  # CE has no orchestrators

RAG_INDIVIDUAL_STRATEGY_CLASSES = {
    "RAGSimilaritySearch": RAGSimilaritySearch,
    "RAGSparseSearch": RAGSparseSearch,
    "RAGRegexGrep": RAGRegexGrep,
}
RAG_ORCHESTRATOR_CLASSES: dict = {}
RAG_STRATEGY_CLASSES = {**RAG_INDIVIDUAL_STRATEGY_CLASSES, **RAG_ORCHESTRATOR_CLASSES}

# Kept for API compatibility with callers that referenced the orchestrator registry.
rag_orchestrator_registry = RAG_ORCHESTRATOR_CLASSES


def get_rag_strategies():
    """Return metadata for all Community Edition RAG strategies."""
    return RAG_STRATEGIES


def get_rag_strategy_class(strategy_name: str):
    """Return the strategy class for a name, or the default (similarity) if unknown."""
    return RAG_STRATEGY_CLASSES.get(strategy_name, RAGSimilaritySearch)
