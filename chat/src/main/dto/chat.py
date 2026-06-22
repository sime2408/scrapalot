from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ChatAttachmentDTO(BaseModel):
    type: str = ""  # "document", "image", "youtube"
    filename: str = ""
    content: str = ""  # extracted text, base64, or YouTube URL
    mime_type: str = ""


class ChatRequest(BaseModel):
    prompt: str
    session_id: str | None = None
    conversation_history: list[dict[str, str]] = []
    user_id: str | None = None
    workspace_id: UUID | None = None  # Current workspace for agentic collection discovery
    collection_ids: list[UUID] = []
    document_ids: list[UUID] = []
    model_id: str | None = None  # Database UUID or model identifier
    model_name: str | None = None  # Human-readable model name for LLM calls
    provider_type: str | None = None  # Provider type (e.g., 'openai', 'anthropic', 'local')
    language: str = "en"
    web_search_enabled: bool = False  # Enable web search functionality
    deep_research_enabled: bool = False  # Enable deep research functionality
    # When true, after the sourced answer a thinking-capable model adds an
    # own-knowledge "model insight" reflection (reasoning shown in the thinking
    # panel). Driven by the UI "thinking" toggle.
    deep_synthesis_enabled: bool = False
    research_breadth: int = 4  # Number of sources to explore (1-10, default: 4)
    research_depth: int = 2  # Depth of analysis per source (1-5, default: 2)
    user_message_id: UUID | None = None  # Existing user message ID to reuse (for repeat functionality)
    similarity_threshold: float | None = 0.5  # Similarity threshold for RAG retrieval (0.0-1.0, default: 0.5)
    top_k: int | None = 15  # Number of chunks to retrieve for RAG (1-30, default: 15)

    # Agentic RAG Configuration
    agentic_rag_enabled: bool = False  # Enable agentic RAG with tool-based retrieval
    source_preferences: dict[str, float] = Field(
        default_factory=lambda: {
            "collections": 0.6,  # Domain-specific document collections
            "web_search": 0.3,  # Current information from web
            "direct_llm": 0.1,  # General knowledge and reasoning
        },
        description="Relative importance weights for different knowledge sources (must sum to 1.0)",
    )
    min_confidence_threshold: float = Field(default=0.6, description="Minimum confidence threshold for including source results", ge=0.0, le=1.0)
    max_sources: int = Field(default=3, description="Maximum number of knowledge sources to combine", ge=1, le=5)

    is_repeat: bool = False  # True when user re-generates a previous message (summary may be stale)
    metadata: dict[str, str] | None = None  # gRPC metadata map (clarification answers, etc.)

    attachments: list[ChatAttachmentDTO] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)
