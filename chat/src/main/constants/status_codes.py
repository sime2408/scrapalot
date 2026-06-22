"""
Status codes for frontend-backend alignment.

These codes map to translation keys in the frontend i18n system.
Translation path: chat.status.{status_code}

Status codes are used for streaming progress updates and should be
translation keys, NOT English sentences.
"""

from enum import Enum


class StatusCode(str, Enum):
    """
    Status codes that align with frontend translation keys.

    Frontend translation path: chat.status.{status_code}

    Usage:
        yield emitter.emit_status(StatusCode.INITIALIZING.value, stage="initialization")
    """

    # === Document Retrieval ===
    RETRIEVING_DOCUMENTS = "retrieving_documents"
    PROCESSING_CONTEXT = "processing_context"

    # === Response Generation ===
    GENERATING_RESPONSE = "generating_response"
    PROCESSING_RESULTS = "processing_results"

    # === Query Processing ===
    REWRITING_QUERY = "rewriting_query"
    QUERY_REWRITE_FAILED = "query_rewrite_failed"
    RERANKING_DOCUMENTS = "reranking_documents"
    GENERATING_QUERY_TRANSFORMATIONS = "generating_query_transformations"
    QUERY_TRANSFORMATION_FAILED = "query_transformation_failed"

    # === Routing ===
    ANALYZING_QUERY = "analyzingQuery"
    STRATEGY_ROUTING = "strategy_routing"
    SOURCE_ROUTING = "source_routing"

    # === Initialization ===
    INITIALIZING = "initializing"

    # === Web Search ===
    WEB_SEARCH_STARTING = "webSearchStarting"

    # === Deep Research ===
    DEEP_RESEARCH_STARTING = "deepResearchStarting"

    # === Document Q&A (unprocessed documents) ===
    DOCUMENT_QA_NOT_INDEXED = "documentQaNotIndexed"
    DOCUMENT_QA_EXTRACTING_TEXT = "documentQaExtractingText"
    DOCUMENT_QA_ANALYZING_DOCUMENT = "documentQaAnalyzingDocument"
    DOCUMENT_QA_SEARCHING_PAGES = "documentQaSearchingPages"
    DOCUMENT_QA_FOUND_SECTIONS = "documentQaFoundSections"
    DOCUMENT_QA_GENERATING_ANSWER = "documentQaGeneratingAnswer"
    DOCUMENT_QA_USING_EXISTING_SUMMARY = "documentQaUsingExistingSummary"

    # === Model Operations ===
    MODEL_LOADING = "modelLoading"
    MODEL_INITIALIZING = "modelInitializing"
    MODEL_READY = "modelReady"

    # === Connection Status ===
    CONNECTING_LOCAL_AI = "connecting_local_ai"
    INITIALIZING_SYSTEM_AI = "initializing_system_ai"
    CONNECTING_AI_PROVIDER = "connecting_ai_provider"

    # === Request States ===
    REQUEST_CANCELLED = "requestCancelled"

    # === Agentic RAG / Intelligent Routing ===
    ANALYZING_COLLECTIONS = "analyzing_collections"
    SELECTED_COLLECTIONS = "selected_collections"
    COLLECTION_DISCOVERY = "collection_discovery"
    SHARED_INTENT_ANALYSIS = "shared_intent_analysis"
    INTELLIGENT_ROUTING = "intelligent_routing"
    INTENT_ANALYSIS = "intent_analysis"
    CONTEXT_ENHANCEMENT = "context_enhancement"

    # === Retrieval Status ===
    RETRIEVAL = "retrieval"

    # === Document Processing ===
    PREPARATION = "preparation"
    CONNECTING = "connecting"
    LOCAL_CONNECTION = "local_connection"
    SYSTEM_INIT = "system_init"
    REMOTE_CONNECTION = "remote_connection"

    # === Document QA ===
    DOCUMENT_QA = "document_qa"

    # === Cancelled ===
    CANCELLED = "cancelled"

    # === Ready ===
    READY = "ready"


class StructuredStatusCode:
    """
    Factory for structured status codes with data.

    These are used for status messages that contain additional data
    in the format: "status_key:data1,data2,..."

    Example:
        # Instead of: "shared_intent_analysis:factual,HyDE"
        # Use: StructuredStatusCode.shared_intent_analysis("factual", "HyDE")
    """

    @staticmethod
    def shared_intent_analysis(intent_type: str, strategy_name: str) -> str:
        """Intent analysis result with intent type and strategy."""
        return f"shared_intent_analysis:{intent_type},{strategy_name}"

    @staticmethod
    def intelligent_routing(*sources: str) -> str:
        """Intelligent routing with source types and mode."""
        return f"intelligent_routing:{','.join(sources)}"

    @staticmethod
    def intent_analysis(intent_type: str, complexity: int, strategy_name: str) -> str:
        """Intent analysis with type, complexity, and strategy."""
        return f"intent_analysis:{intent_type},{complexity},{strategy_name}"

    @staticmethod
    def retrieving_documents(strategy_name: str) -> str:
        """Retrieving documents with the strategy name."""
        return f"retrieving_documents:{strategy_name}"

    @staticmethod
    def analyzing_collections(count: int) -> str:
        """Analyzing collections with count."""
        return f"analyzing_collections:{count}"

    @staticmethod
    def selected_collections(count: int) -> str:
        """Selected collections with count."""
        return f"selected_collections:{count}"

    @staticmethod
    def context_enhancement(message: str) -> str:
        """Context enhancement status with a message."""
        return f"context_enhancement:{message}"


def get_status_message_key(status_code: StatusCode) -> str:
    """Get the full translation key for a status code."""
    return f"chat.status.{status_code.value}"
