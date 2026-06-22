"""
Graph-related DTOs for relationship discovery and tri-modal fusion.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from src.main.models.enums import CooccurrenceLevel, QueryType, RelationshipType


@dataclass
class TriModalWeights:
    """Dynamic weights for trimodal fusion"""

    dense_weight: float
    sparse_weight: float
    graph_weight: float
    confidence: float


@dataclass
class SearchResult:
    """Result from a single search modality"""

    documents: list[Any]  # list[Document] - avoiding circular import
    confidence: float
    execution_time_ms: float
    source_modality: str
    graph_traversal_metadata: dict[str, Any] | None = None


@dataclass
class GraphPath:
    """Represents a path through the knowledge graph"""

    start_entity: str
    end_entity: str
    path_length: int
    path_nodes: list[dict[str, Any]]
    path_relationships: list[dict[str, Any]]
    total_weight: float
    confidence_score: float
    evidence_strength: float


@dataclass
class GraphPattern:
    """Template for graph pattern matching"""

    pattern_name: str
    cypher_template: str
    parameters: dict[str, Any]
    expected_results: int
    confidence_threshold: float


@dataclass
class QueryResult:
    """Result of a graph query"""

    query_type: QueryType
    entities: list[dict[str, Any]]
    relationships: list[dict[str, Any]]
    paths: list[GraphPath]
    subgraph: dict[str, Any]
    metadata: dict[str, Any]
    confidence_score: float
    execution_time_ms: float


@dataclass
class ExtractedEntity:
    """Represents an extracted entity from text"""

    name: str
    entity_type: str
    description: str
    confidence_score: float
    context: str
    chunk_id: str | None = None
    start_position: int | None = None
    end_position: int | None = None


@dataclass
class ExtractedRelationship:
    """A relationship extracted from text."""

    entity1: str
    entity2: str
    entity1_type: str
    entity2_type: str
    relationship_type: RelationshipType
    strength_score: float  # 0.0-1.0
    confidence_level: str  # "high", "medium", "low"
    evidence_chunks: list[str]
    relationship_context: str
    extraction_method: str
    source_text: str
    chunk_id: str
    document_id: str
    extracted_at: datetime


@dataclass
class RelationshipPrompt:
    """Template for relationship extraction prompts"""

    entity_types: list[str]
    relationship_types: list[str]
    prompt_template: str
    max_tokens: int
    temperature: float


@dataclass
class CooccurrencePattern:
    """Represents a co-occurrence pattern between entities"""

    entity1: str
    entity2: str
    frequency: int
    context_windows: list[str]
    significance_score: float
    confidence_score: float
    temporal_distribution: dict[str, int] | None = None


@dataclass
class RelationshipDiscoveryResult:
    """Result of a relationship discovery process"""

    document_id: str
    entities_extracted: int
    relationships_discovered: int
    cooccurrence_patterns: list[CooccurrencePattern]
    extracted_relationships: list[ExtractedRelationship]
    execution_time_ms: float
    status: str
    error_message: str | None = None


@dataclass
class GraphSyncResult:
    """Result of a graph synchronization operation."""

    entity_type: str
    entity_id: str
    workspace_id: str
    success: bool
    nodes_created: int = 0
    relationships_created: int = 0
    nodes_updated: int = 0
    relationships_updated: int = 0
    error_message: str | None = None


@dataclass
class CooccurrenceResult:
    """Result of co-occurrence analysis between two entities"""

    entity1: str
    entity2: str
    entity1_type: str
    entity2_type: str
    cooccurrence_count: int
    total_occurrences_entity1: int
    total_occurrences_entity2: int
    confidence_score: float
    evidence_chunks: list[str]
    analysis_level: CooccurrenceLevel
    statistical_significance: float


@dataclass
class WindowAnalysis:
    """Analysis results for a specific text window"""

    text: str
    entities: list[str]
    entity_types: dict[str, str]
    chunk_id: str
    document_id: str
    window_type: CooccurrenceLevel
