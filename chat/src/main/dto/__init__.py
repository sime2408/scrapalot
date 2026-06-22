"""
DTO (Data Transfer Object) module for scrapalot-chat.

Contains all data transfer objects used throughout the application.
"""

from .graph import (
    CooccurrencePattern,
    CooccurrenceResult,
    ExtractedEntity,
    ExtractedRelationship,
    GraphPath,
    GraphPattern,
    GraphSyncResult,
    QueryResult,
    RelationshipDiscoveryResult,
    SearchResult,
    TriModalWeights,
    WindowAnalysis,
)

__all__ = [
    "CooccurrencePattern",
    "CooccurrenceResult",
    "ExtractedEntity",
    "ExtractedRelationship",
    "GraphPath",
    "GraphPattern",
    "GraphSyncResult",
    "QueryResult",
    "RelationshipDiscoveryResult",
    "SearchResult",
    "TriModalWeights",
    "WindowAnalysis",
]
