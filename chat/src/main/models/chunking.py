"""
Data models for chunking strategies.

This module contains dataclass definitions used by various chunking strategies
to represent intermediate data structures during the chunking process.
"""

from dataclasses import dataclass
from enum import Enum


class NarrativeElement(str, Enum):
    """Types of narrative elements in text."""

    EXPOSITION = "exposition"
    RISING_ACTION = "rising_action"
    CLIMAX = "climax"
    FALLING_ACTION = "falling_action"
    RESOLUTION = "resolution"
    DIALOGUE = "dialogue"
    DESCRIPTION = "description"
    TRANSITION = "transition"


class ChunkingMode(str, Enum):
    """Modes for agentic chunking strategy."""

    PROPOSITION = "proposition"
    BOUNDARY = "boundary"
    HYBRID = "hybrid"


@dataclass
class WindowSegment:
    """Represents a segment in the sliding window."""

    text: str
    start_position: int
    end_position: int
    word_count: int
    char_count: int


@dataclass
class NarrativeSegment:
    """Represents a segment with narrative properties."""

    text: str
    start_position: int
    end_position: int
    narrative_elements: list[NarrativeElement]
    temporal_markers: list[str]
    characters: list[str]
    importance_score: float
    cohesion_with_previous: float

    def __post_init__(self):
        if not self.narrative_elements:
            self.narrative_elements = []
        if not self.temporal_markers:
            self.temporal_markers = []
        if not self.characters:
            self.characters = []


@dataclass
class StructuralElement:
    """Represents a structural element in the document hierarchy."""

    level: int
    title: str
    content: str
    start_position: int
    end_position: int
    parent: "StructuralElement | None" = None
    children: list["StructuralElement"] = None
    # Section-to-page mapping
    page_range: list[int] | None = None  # [start_page, end_page]
    page_numbers: list[int] | None = None  # All pages this section spans

    def __post_init__(self):
        if self.children is None:
            self.children = []
        if self.page_numbers is None:
            self.page_numbers = []

    def add_page_number(self, page: int):
        """Add a page number to this structural element."""
        if self.page_numbers is None:
            self.page_numbers = []
        if page not in self.page_numbers:
            # noinspection PyUnresolvedReferences
            self.page_numbers.append(page)
            # noinspection PyUnresolvedReferences
            self.page_numbers.sort()
            # Update page range
            # noinspection PyTypeChecker
            page_nums: list[int] = self.page_numbers
            if len(page_nums) > 0:
                self.page_range = [min(page_nums), max(page_nums)]

    def get_page_range_str(self) -> str:
        """Get a formatted page range string."""
        if not self.page_range:
            return ""
        start, end = self.page_range
        if start == end:
            return f"p. {start}"
        else:
            return f"pp. {start}-{end}"


@dataclass
class Proposition:
    """Represents an atomic proposition extracted from text."""

    id: str
    text: str
    source_sentence: str
    confidence: float
    chunk_id: str | None = None
    topic_keywords: list[str] = None

    def __post_init__(self):
        if self.topic_keywords is None:
            self.topic_keywords = []


@dataclass
class ChunkGroup:
    """Represents a group of related propositions."""

    id: str
    title: str
    summary: str
    propositions: list[Proposition]
    coherence_score: float
    topic_keywords: list[str]

    def __post_init__(self):
        if not self.propositions:
            self.propositions = []
        if not self.topic_keywords:
            self.topic_keywords = []


@dataclass
class Concept:
    """Represents a domain concept or entity."""

    term: str
    aliases: list[str]
    frequency: int
    importance_score: float
    context_window: list[str]
    category: str

    def __post_init__(self):
        if not self.aliases:
            self.aliases = []
        if not self.context_window:
            self.context_window = []


@dataclass
class ConceptRelationship:
    """Represents a relationship between concepts."""

    concept1: str
    concept2: str
    relationship_type: str
    strength: float
    co_occurrence_count: int
