import enum


class JobStatus(enum.Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ModelType(enum.Enum):
    NORMAL = "NORMAL"
    EMBEDDING = "EMBEDDING"
    VISION = "VISION"
    AUDIO = "AUDIO"


class ProviderStatus(enum.Enum):
    ACTIVE = "active"
    DISABLED = "disabled"


class EntityType(enum.Enum):
    """Supported entity types for extraction"""

    CONCEPT = "concept"
    PERSON = "person"
    PLACE = "place"
    EVENT = "event"
    TERM = "term"
    QUOTE = "quote"
    IMAGE = "image"
    TABLE = "table"
    EQUATION = "equation"


class MultimodalElementType(enum.Enum):
    """Types of non-text elements extracted from documents"""

    IMAGE = "image"
    TABLE = "table"
    EQUATION = "equation"


class QueryComplexity(enum.Enum):
    """Classification of query complexity for dynamic weighting"""

    SIMPLE_FACTUAL = "simple_factual"
    CONCEPTUAL = "conceptual"
    RELATIONAL = "relational"
    CROSS_DOMAIN = "cross_domain"
    COMPLEX_SYNTHESIS = "complex_synthesis"


class TraversalAlgorithm(enum.Enum):
    """Graph traversal algorithms"""

    BFS = "breadth_first"
    DFS = "depth_first"
    SHORTEST_PATH = "shortest_path"
    WEIGHTED_PATH = "weighted_path"
    RELATIONSHIP_WEIGHTED = "relationship_weighted"


class QueryType(enum.Enum):
    """Types of graph queries"""

    ENTITY_NEIGHBORHOOD = "entity_neighborhood"
    RELATIONSHIP_PATH = "relationship_path"
    CONCEPT_CLUSTER = "concept_cluster"
    INFLUENCE_NETWORK = "influence_network"
    SEMANTIC_SIMILARITY = "semantic_similarity"
    CROSS_DOCUMENT = "cross_document"
    PATTERN_MATCH = "pattern_match"


class RelationshipType(enum.Enum):
    """Types of relationships between entities"""

    INFLUENCES = "INFLUENCES"
    DERIVES_FROM = "DERIVES_FROM"
    BUILDS_ON = "BUILDS_ON"
    CONTRADICTS = "CONTRADICTS"
    SUPPORTS = "SUPPORTS"
    CRITIQUES = "CRITIQUES"
    EXTENDS = "EXTENDS"
    SIMPLIFIES = "SIMPLIFIES"
    APPLIES = "APPLIES"
    EXEMPLIFIES = "EXEMPLIFIES"
    GENERALIZES = "GENERALIZES"
    RELATED_TO = "RELATED_TO"
    SIMILAR_TO = "SIMILAR_TO"
    PART_OF = "PART_OF"


class CooccurrenceLevel(enum.Enum):
    """Analysis levels for entity co-occurrence"""

    SENTENCE = "sentence"
    PARAGRAPH = "paragraph"
    SECTION = "section"
    DOCUMENT = "document"
    CROSS_DOCUMENT = "cross_document"


class ExtractionMethod(enum.Enum):
    """Methods used for relationship extraction"""

    LLM = "llm"
    COOCCURRENCE = "cooccurrence"
    MANUAL = "manual"
    HYBRID = "hybrid"
