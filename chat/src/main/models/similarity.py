"""
Data models for similarity calculations and entity processing.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Any

from .enums import EntityType


class SimilarityMethod(Enum):
    """Methods for calculating similarity between entities"""

    EXACT = "exact"
    FUZZY = "fuzzy"
    SEMANTIC = "semantic"
    HYBRID = "hybrid"


@dataclass
class SimilarityResult:
    """Result of similarity comparison between two entities"""

    entity1_id: str
    entity2_id: str
    similarity_score: float
    method: SimilarityMethod
    metadata: dict[str, Any] | None = None


@dataclass
class EntityCluster:
    """A cluster of similar entities"""

    cluster_id: str
    entities: list[str]  # List of entity IDs
    centroid_entity_id: str
    cohesion_score: float
    metadata: dict[str, Any] | None = None


@dataclass
class ProcessingResult:
    """Result of entity processing operations"""

    total_entities: int
    processed_entities: int
    duplicates_removed: int
    clusters_formed: int
    processing_time: float
    metadata: dict[str, Any] | None = None


@dataclass
class ExtractedEntity:
    """Container for an extracted entity with metadata"""

    entity_type: EntityType
    name: str
    description: str
    confidence_score: float
    source_text: str
    position: int | None = None
    additional_properties: dict[str, Any] | None = None
