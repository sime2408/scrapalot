"""
Evaluation DTOs for Data Inspector.

Pydantic models for document quality assessment, chunk inspection,
graph integrity analysis, RAG trace evaluation, and LLM judge results.
"""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field

# =============================================================================
# DOCUMENT EVALUATION SCORES
# =============================================================================


class ParseQualityScore(BaseModel):
    """Structural analysis of parsed document content."""

    heading_count: int = 0
    list_count: int = 0
    table_count: int = 0
    code_block_count: int = 0
    image_ref_count: int = 0
    total_chunks: int = 0
    structure_score: float = Field(default=0.0, ge=0.0, le=1.0)


class ChunkSizeStats(BaseModel):
    """Statistical distribution of chunk sizes."""

    mean: float = 0.0
    std: float = 0.0
    min: int = 0
    max: int = 0
    median: float = 0.0


class ChunkQualityScore(BaseModel):
    """Quality assessment of document chunking."""

    total_chunks: int = 0
    size_distribution: ChunkSizeStats = Field(default_factory=ChunkSizeStats)
    metadata_completeness: float = Field(default=0.0, ge=0.0, le=1.0)
    micro_chunk_ratio: float = Field(default=0.0, ge=0.0, le=1.0)
    empty_chunk_count: int = 0


class EmbeddingCoverage(BaseModel):
    """Embedding density and coverage statistics."""

    total_embeddings: int = 0
    zero_embedding_docs: int = 0
    embedding_density: float = Field(default=0.0, ge=0.0)
    pages_without_embeddings: int = 0


class GraphIntegrityScore(BaseModel):
    """Neo4j graph hierarchy completeness check."""

    hierarchy_completeness: float = Field(default=0.0, ge=0.0, le=1.0)
    orphan_count: int = 0
    entity_coverage: float = Field(default=0.0, ge=0.0, le=1.0)
    relationship_density: float = Field(default=0.0, ge=0.0)
    total_nodes: int = 0
    total_relationships: int = 0


class CrossDocumentEntityAnalysis(BaseModel):
    """Cross-document entity overlap analysis from Neo4j."""

    shared_entity_count: int = 0
    entities_by_type: dict[str, int] = Field(default_factory=dict)
    cross_doc_relationship_count: int = 0
    top_shared_entities: list[dict[str, Any]] = Field(default_factory=list)


# =============================================================================
# AGGREGATED EVALUATION RESULTS
# =============================================================================


class DocumentEvaluationResult(BaseModel):
    """Aggregated evaluation for a single document."""

    document_id: UUID
    document_title: str
    collection_id: UUID
    parse_quality: ParseQualityScore = Field(default_factory=ParseQualityScore)
    chunk_quality: ChunkQualityScore = Field(default_factory=ChunkQualityScore)
    embedding_coverage: EmbeddingCoverage = Field(default_factory=EmbeddingCoverage)
    graph_integrity: GraphIntegrityScore = Field(default_factory=GraphIntegrityScore)
    overall_score: float = Field(default=0.0, ge=0.0, le=1.0)
    evaluated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class CollectionEvaluationResult(BaseModel):
    """Aggregated evaluation across all documents in a collection."""

    collection_id: UUID
    document_count: int = 0
    avg_parse_quality: float = Field(default=0.0, ge=0.0, le=1.0)
    avg_chunk_quality: float = Field(default=0.0, ge=0.0, le=1.0)
    avg_embedding_coverage: float = Field(default=0.0, ge=0.0)
    avg_graph_integrity: float = Field(default=0.0, ge=0.0, le=1.0)
    overall_score: float = Field(default=0.0, ge=0.0, le=1.0)
    failed_documents: list[str] = Field(default_factory=list)
    cross_document_entities: CrossDocumentEntityAnalysis = Field(default_factory=CrossDocumentEntityAnalysis)
    evaluated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


# =============================================================================
# CHUNK INSPECTION
# =============================================================================


class ChunkInspectionItem(BaseModel):
    """Single chunk detail for inspection view."""

    chunk_index: int
    text: str
    size: int
    metadata: dict[str, Any] = Field(default_factory=dict)
    embedding_id: str | None = None
    has_embedding: bool = True
    section_heading: str | None = None
    chapter_title: str | None = None
    page_number: int | None = None


class ChunkInspectionResult(BaseModel):
    """Paginated chunk inspection response."""

    document_id: UUID
    total_chunks: int
    page: int
    page_size: int
    chunks: list[ChunkInspectionItem] = Field(default_factory=list)


# =============================================================================
# GRAPH SUBGRAPH (Cytoscape format)
# =============================================================================


class CytoscapeNodeData(BaseModel):
    """Node data in Cytoscape.js format."""

    id: str
    label: str
    node_type: str
    properties: dict[str, Any] = Field(default_factory=dict)


class CytoscapeEdgeData(BaseModel):
    """Edge data in Cytoscape.js format."""

    id: str
    source: str
    target: str
    label: str
    properties: dict[str, Any] = Field(default_factory=dict)


class GraphSubgraphResult(BaseModel):
    """Graph subgraph in Cytoscape.js-compatible format."""

    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)
    total_nodes: int = 0
    total_edges: int = 0
    truncated: bool = False


class NodeNeighborNode(BaseModel):
    """A neighbor node with metadata."""

    neo_id: str
    labels: list[str] = Field(default_factory=list)
    properties: dict[str, Any] = Field(default_factory=dict)
    neighbor_count: int = 0


class NodeNeighborEdge(BaseModel):
    """An edge connecting the center node to a neighbor."""

    rel_id: str
    rel_type: str
    source: str
    target: str
    properties: dict[str, Any] = Field(default_factory=dict)


class NodeNeighborsResult(BaseModel):
    """Result of progressive node neighbor expansion."""

    nodes: list[NodeNeighborNode] = Field(default_factory=list)
    edges: list[NodeNeighborEdge] = Field(default_factory=list)
    total_neighbor_count: int = 0
    returned_count: int = 0


class GraphStatsResult(BaseModel):
    """Overall graph statistics."""

    total_nodes: int = 0
    total_edges: int = 0
    node_counts_by_type: dict[str, int] = Field(default_factory=dict)
    edge_counts_by_type: dict[str, int] = Field(default_factory=dict)
    avg_degree: float = 0.0
    connected_components: int = 0


class EntityRelationshipResult(BaseModel):
    """Entity search and relationship traversal result."""

    entities: list[dict[str, Any]] = Field(default_factory=list)
    relationships: list[dict[str, Any]] = Field(default_factory=list)
    total_entities: int = 0
    total_relationships: int = 0


# =============================================================================
# RAG EVALUATION TRACES
# =============================================================================


class RAGTraceEntry(BaseModel):
    """Single RAG routing trace entry."""

    id: UUID
    session_id: UUID
    user_id: UUID
    query: str
    selected_strategy: str
    selected_orchestrator: str | None = None
    strategy_type: str
    mode: str
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str | None = None
    alternative_strategies: list[dict[str, Any]] = Field(default_factory=list)
    query_characteristics: dict[str, Any] = Field(default_factory=dict)
    latency_ms: int | None = None
    token_count: int | None = None
    graph_traversal_stats: dict[str, Any] | None = None
    routing_tier: int | None = None
    routing_tier_name: str | None = None
    created_at: datetime


class RAGTracesResult(BaseModel):
    """Paginated RAG traces response."""

    traces: list[RAGTraceEntry] = Field(default_factory=list)
    total: int = 0
    page: int = 1
    page_size: int = 50


class RAGStrategyDistribution(BaseModel):
    """Strategy usage distribution statistics."""

    strategy_name: str
    count: int = 0
    avg_latency_ms: float = 0.0
    avg_tokens: float = 0.0
    avg_confidence: float = 0.0


class RAGStrategyDistributionResult(BaseModel):
    """Full strategy distribution response."""

    distributions: list[RAGStrategyDistribution] = Field(default_factory=list)
    total_traces: int = 0
    from_date: datetime | None = None
    to_date: datetime | None = None


# =============================================================================
# LLM JUDGE EVALUATION
# =============================================================================


class LLMJudgeResult(BaseModel):
    """LLM-based quality evaluation of a single RAG response."""

    trace_id: UUID | None = None
    faithfulness_score: float = Field(default=0.0, ge=0.0, le=1.0)
    context_relevance_score: float = Field(default=0.0, ge=0.0, le=1.0)
    completeness_score: float = Field(default=0.0, ge=0.0, le=1.0)
    overall_score: float = Field(default=0.0, ge=0.0, le=1.0)
    reasoning: str = ""


class LLMEvaluationProgress(BaseModel):
    """Progress update during LLM evaluation run."""

    completed: int = 0
    total: int = 0
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    current_result: LLMJudgeResult | None = None
    status: str = "running"
    avg_faithfulness: float = 0.0
    avg_context_relevance: float = 0.0
    avg_completeness: float = 0.0
