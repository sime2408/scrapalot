from typing import ClassVar as _ClassVar
from collections.abc import Iterable as _Iterable
from collections.abc import Mapping as _Mapping
from typing import Optional as _Optional
from typing import Union as _Union

from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from google.protobuf.internal import containers as _containers

DESCRIPTOR: _descriptor.FileDescriptor

class DocEvalRequest(_message.Message):
    __slots__ = ("document_id",)
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    def __init__(self, document_id: str | None = ...) -> None: ...

class ParseQuality(_message.Message):
    __slots__ = ("heading_count", "list_count", "table_count", "code_block_count", "image_ref_count", "total_chunks", "structure_score")
    HEADING_COUNT_FIELD_NUMBER: _ClassVar[int]
    LIST_COUNT_FIELD_NUMBER: _ClassVar[int]
    TABLE_COUNT_FIELD_NUMBER: _ClassVar[int]
    CODE_BLOCK_COUNT_FIELD_NUMBER: _ClassVar[int]
    IMAGE_REF_COUNT_FIELD_NUMBER: _ClassVar[int]
    TOTAL_CHUNKS_FIELD_NUMBER: _ClassVar[int]
    STRUCTURE_SCORE_FIELD_NUMBER: _ClassVar[int]
    heading_count: int
    list_count: int
    table_count: int
    code_block_count: int
    image_ref_count: int
    total_chunks: int
    structure_score: float
    def __init__(
        self,
        heading_count: int | None = ...,
        list_count: int | None = ...,
        table_count: int | None = ...,
        code_block_count: int | None = ...,
        image_ref_count: int | None = ...,
        total_chunks: int | None = ...,
        structure_score: float | None = ...,
    ) -> None: ...

class ChunkSizeStats(_message.Message):
    __slots__ = ("mean", "std", "min", "max", "median")
    MEAN_FIELD_NUMBER: _ClassVar[int]
    STD_FIELD_NUMBER: _ClassVar[int]
    MIN_FIELD_NUMBER: _ClassVar[int]
    MAX_FIELD_NUMBER: _ClassVar[int]
    MEDIAN_FIELD_NUMBER: _ClassVar[int]
    mean: float
    std: float
    min: int
    max: int
    median: float
    def __init__(
        self,
        mean: float | None = ...,
        std: float | None = ...,
        min: int | None = ...,
        max: int | None = ...,
        median: float | None = ...,
    ) -> None: ...

class ChunkQuality(_message.Message):
    __slots__ = ("total_chunks", "size_distribution", "metadata_completeness", "micro_chunk_ratio", "empty_chunk_count")
    TOTAL_CHUNKS_FIELD_NUMBER: _ClassVar[int]
    SIZE_DISTRIBUTION_FIELD_NUMBER: _ClassVar[int]
    METADATA_COMPLETENESS_FIELD_NUMBER: _ClassVar[int]
    MICRO_CHUNK_RATIO_FIELD_NUMBER: _ClassVar[int]
    EMPTY_CHUNK_COUNT_FIELD_NUMBER: _ClassVar[int]
    total_chunks: int
    size_distribution: ChunkSizeStats
    metadata_completeness: float
    micro_chunk_ratio: float
    empty_chunk_count: int
    def __init__(
        self,
        total_chunks: int | None = ...,
        size_distribution: ChunkSizeStats | _Mapping | None = ...,
        metadata_completeness: float | None = ...,
        micro_chunk_ratio: float | None = ...,
        empty_chunk_count: int | None = ...,
    ) -> None: ...

class EmbeddingCoverage(_message.Message):
    __slots__ = ("total_embeddings", "zero_embedding_docs", "embedding_density", "pages_without_embeddings")
    TOTAL_EMBEDDINGS_FIELD_NUMBER: _ClassVar[int]
    ZERO_EMBEDDING_DOCS_FIELD_NUMBER: _ClassVar[int]
    EMBEDDING_DENSITY_FIELD_NUMBER: _ClassVar[int]
    PAGES_WITHOUT_EMBEDDINGS_FIELD_NUMBER: _ClassVar[int]
    total_embeddings: int
    zero_embedding_docs: int
    embedding_density: float
    pages_without_embeddings: int
    def __init__(
        self,
        total_embeddings: int | None = ...,
        zero_embedding_docs: int | None = ...,
        embedding_density: float | None = ...,
        pages_without_embeddings: int | None = ...,
    ) -> None: ...

class GraphIntegrity(_message.Message):
    __slots__ = ("hierarchy_completeness", "orphan_count", "entity_coverage", "relationship_density", "total_nodes", "total_relationships")
    HIERARCHY_COMPLETENESS_FIELD_NUMBER: _ClassVar[int]
    ORPHAN_COUNT_FIELD_NUMBER: _ClassVar[int]
    ENTITY_COVERAGE_FIELD_NUMBER: _ClassVar[int]
    RELATIONSHIP_DENSITY_FIELD_NUMBER: _ClassVar[int]
    TOTAL_NODES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_RELATIONSHIPS_FIELD_NUMBER: _ClassVar[int]
    hierarchy_completeness: float
    orphan_count: int
    entity_coverage: float
    relationship_density: float
    total_nodes: int
    total_relationships: int
    def __init__(
        self,
        hierarchy_completeness: float | None = ...,
        orphan_count: int | None = ...,
        entity_coverage: float | None = ...,
        relationship_density: float | None = ...,
        total_nodes: int | None = ...,
        total_relationships: int | None = ...,
    ) -> None: ...

class DocEvalResponse(_message.Message):
    __slots__ = (
        "success",
        "document_id",
        "document_title",
        "collection_id",
        "parse_quality",
        "chunk_quality",
        "embedding_coverage",
        "graph_integrity",
        "overall_score",
        "evaluated_at",
        "error",
        "processing_stats_json",
    )
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_TITLE_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    PARSE_QUALITY_FIELD_NUMBER: _ClassVar[int]
    CHUNK_QUALITY_FIELD_NUMBER: _ClassVar[int]
    EMBEDDING_COVERAGE_FIELD_NUMBER: _ClassVar[int]
    GRAPH_INTEGRITY_FIELD_NUMBER: _ClassVar[int]
    OVERALL_SCORE_FIELD_NUMBER: _ClassVar[int]
    EVALUATED_AT_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    PROCESSING_STATS_JSON_FIELD_NUMBER: _ClassVar[int]
    success: bool
    document_id: str
    document_title: str
    collection_id: str
    parse_quality: ParseQuality
    chunk_quality: ChunkQuality
    embedding_coverage: EmbeddingCoverage
    graph_integrity: GraphIntegrity
    overall_score: float
    evaluated_at: str
    error: str
    processing_stats_json: str
    def __init__(
        self,
        success: bool = ...,
        document_id: str | None = ...,
        document_title: str | None = ...,
        collection_id: str | None = ...,
        parse_quality: ParseQuality | _Mapping | None = ...,
        chunk_quality: ChunkQuality | _Mapping | None = ...,
        embedding_coverage: EmbeddingCoverage | _Mapping | None = ...,
        graph_integrity: GraphIntegrity | _Mapping | None = ...,
        overall_score: float | None = ...,
        evaluated_at: str | None = ...,
        error: str | None = ...,
        processing_stats_json: str | None = ...,
    ) -> None: ...

class CollectionEvalRequest(_message.Message):
    __slots__ = ("collection_id",)
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    collection_id: str
    def __init__(self, collection_id: str | None = ...) -> None: ...

class CrossDocumentEntities(_message.Message):
    __slots__ = ("shared_entity_count", "entities_by_type", "cross_doc_relationship_count", "top_shared_entities_json")
    class EntitiesByTypeEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: int
        def __init__(self, key: str | None = ..., value: int | None = ...) -> None: ...

    SHARED_ENTITY_COUNT_FIELD_NUMBER: _ClassVar[int]
    ENTITIES_BY_TYPE_FIELD_NUMBER: _ClassVar[int]
    CROSS_DOC_RELATIONSHIP_COUNT_FIELD_NUMBER: _ClassVar[int]
    TOP_SHARED_ENTITIES_JSON_FIELD_NUMBER: _ClassVar[int]
    shared_entity_count: int
    entities_by_type: _containers.ScalarMap[str, int]
    cross_doc_relationship_count: int
    top_shared_entities_json: str
    def __init__(
        self,
        shared_entity_count: int | None = ...,
        entities_by_type: _Mapping[str, int] | None = ...,
        cross_doc_relationship_count: int | None = ...,
        top_shared_entities_json: str | None = ...,
    ) -> None: ...

class CollectionEvalResponse(_message.Message):
    __slots__ = (
        "success",
        "collection_id",
        "document_count",
        "avg_parse_quality",
        "avg_chunk_quality",
        "avg_embedding_coverage",
        "avg_graph_integrity",
        "overall_score",
        "failed_documents",
        "cross_document_entities",
        "evaluated_at",
        "error",
    )
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_COUNT_FIELD_NUMBER: _ClassVar[int]
    AVG_PARSE_QUALITY_FIELD_NUMBER: _ClassVar[int]
    AVG_CHUNK_QUALITY_FIELD_NUMBER: _ClassVar[int]
    AVG_EMBEDDING_COVERAGE_FIELD_NUMBER: _ClassVar[int]
    AVG_GRAPH_INTEGRITY_FIELD_NUMBER: _ClassVar[int]
    OVERALL_SCORE_FIELD_NUMBER: _ClassVar[int]
    FAILED_DOCUMENTS_FIELD_NUMBER: _ClassVar[int]
    CROSS_DOCUMENT_ENTITIES_FIELD_NUMBER: _ClassVar[int]
    EVALUATED_AT_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    collection_id: str
    document_count: int
    avg_parse_quality: float
    avg_chunk_quality: float
    avg_embedding_coverage: float
    avg_graph_integrity: float
    overall_score: float
    failed_documents: _containers.RepeatedScalarFieldContainer[str]
    cross_document_entities: CrossDocumentEntities
    evaluated_at: str
    error: str
    def __init__(
        self,
        success: bool = ...,
        collection_id: str | None = ...,
        document_count: int | None = ...,
        avg_parse_quality: float | None = ...,
        avg_chunk_quality: float | None = ...,
        avg_embedding_coverage: float | None = ...,
        avg_graph_integrity: float | None = ...,
        overall_score: float | None = ...,
        failed_documents: _Iterable[str] | None = ...,
        cross_document_entities: CrossDocumentEntities | _Mapping | None = ...,
        evaluated_at: str | None = ...,
        error: str | None = ...,
    ) -> None: ...

class ChunkInspectionRequest(_message.Message):
    __slots__ = ("document_id", "page", "page_size")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    page: int
    page_size: int
    def __init__(self, document_id: str | None = ..., page: int | None = ..., page_size: int | None = ...) -> None: ...

class ChunkItem(_message.Message):
    __slots__ = ("chunk_index", "text", "size", "metadata_json", "embedding_id", "has_embedding", "section_heading", "chapter_title", "page_number")
    CHUNK_INDEX_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    SIZE_FIELD_NUMBER: _ClassVar[int]
    METADATA_JSON_FIELD_NUMBER: _ClassVar[int]
    EMBEDDING_ID_FIELD_NUMBER: _ClassVar[int]
    HAS_EMBEDDING_FIELD_NUMBER: _ClassVar[int]
    SECTION_HEADING_FIELD_NUMBER: _ClassVar[int]
    CHAPTER_TITLE_FIELD_NUMBER: _ClassVar[int]
    PAGE_NUMBER_FIELD_NUMBER: _ClassVar[int]
    chunk_index: int
    text: str
    size: int
    metadata_json: str
    embedding_id: str
    has_embedding: bool
    section_heading: str
    chapter_title: str
    page_number: int
    def __init__(
        self,
        chunk_index: int | None = ...,
        text: str | None = ...,
        size: int | None = ...,
        metadata_json: str | None = ...,
        embedding_id: str | None = ...,
        has_embedding: bool = ...,
        section_heading: str | None = ...,
        chapter_title: str | None = ...,
        page_number: int | None = ...,
    ) -> None: ...

class ChunkInspectionResponse(_message.Message):
    __slots__ = ("success", "document_id", "total_chunks", "page", "page_size", "chunks", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    TOTAL_CHUNKS_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    CHUNKS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    document_id: str
    total_chunks: int
    page: int
    page_size: int
    chunks: _containers.RepeatedCompositeFieldContainer[ChunkItem]
    error: str
    def __init__(
        self,
        success: bool = ...,
        document_id: str | None = ...,
        total_chunks: int | None = ...,
        page: int | None = ...,
        page_size: int | None = ...,
        chunks: _Iterable[ChunkItem | _Mapping] | None = ...,
        error: str | None = ...,
    ) -> None: ...

class SubgraphRequest(_message.Message):
    __slots__ = ("workspace_id", "collection_id", "document_id", "depth", "max_nodes")
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    DEPTH_FIELD_NUMBER: _ClassVar[int]
    MAX_NODES_FIELD_NUMBER: _ClassVar[int]
    workspace_id: str
    collection_id: str
    document_id: str
    depth: int
    max_nodes: int
    def __init__(
        self,
        workspace_id: str | None = ...,
        collection_id: str | None = ...,
        document_id: str | None = ...,
        depth: int | None = ...,
        max_nodes: int | None = ...,
    ) -> None: ...

class SubgraphResponse(_message.Message):
    __slots__ = ("success", "nodes_json", "edges_json", "total_nodes", "total_edges", "truncated", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    NODES_JSON_FIELD_NUMBER: _ClassVar[int]
    EDGES_JSON_FIELD_NUMBER: _ClassVar[int]
    TOTAL_NODES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_EDGES_FIELD_NUMBER: _ClassVar[int]
    TRUNCATED_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    nodes_json: str
    edges_json: str
    total_nodes: int
    total_edges: int
    truncated: bool
    error: str
    def __init__(
        self,
        success: bool = ...,
        nodes_json: str | None = ...,
        edges_json: str | None = ...,
        total_nodes: int | None = ...,
        total_edges: int | None = ...,
        truncated: bool = ...,
        error: str | None = ...,
    ) -> None: ...

class NodeNeighborsRequest(_message.Message):
    __slots__ = ("node_element_id", "exclude_node_ids", "max_neighbors")
    NODE_ELEMENT_ID_FIELD_NUMBER: _ClassVar[int]
    EXCLUDE_NODE_IDS_FIELD_NUMBER: _ClassVar[int]
    MAX_NEIGHBORS_FIELD_NUMBER: _ClassVar[int]
    node_element_id: str
    exclude_node_ids: _containers.RepeatedScalarFieldContainer[str]
    max_neighbors: int
    def __init__(self, node_element_id: str | None = ..., exclude_node_ids: _Iterable[str] | None = ..., max_neighbors: int | None = ...) -> None: ...

class NeighborNode(_message.Message):
    __slots__ = ("neo_id", "labels", "properties_json", "neighbor_count")
    NEO_ID_FIELD_NUMBER: _ClassVar[int]
    LABELS_FIELD_NUMBER: _ClassVar[int]
    PROPERTIES_JSON_FIELD_NUMBER: _ClassVar[int]
    NEIGHBOR_COUNT_FIELD_NUMBER: _ClassVar[int]
    neo_id: str
    labels: _containers.RepeatedScalarFieldContainer[str]
    properties_json: str
    neighbor_count: int
    def __init__(
        self,
        neo_id: str | None = ...,
        labels: _Iterable[str] | None = ...,
        properties_json: str | None = ...,
        neighbor_count: int | None = ...,
    ) -> None: ...

class NeighborEdge(_message.Message):
    __slots__ = ("rel_id", "rel_type", "source", "target", "properties_json")
    REL_ID_FIELD_NUMBER: _ClassVar[int]
    REL_TYPE_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    TARGET_FIELD_NUMBER: _ClassVar[int]
    PROPERTIES_JSON_FIELD_NUMBER: _ClassVar[int]
    rel_id: str
    rel_type: str
    source: str
    target: str
    properties_json: str
    def __init__(
        self,
        rel_id: str | None = ...,
        rel_type: str | None = ...,
        source: str | None = ...,
        target: str | None = ...,
        properties_json: str | None = ...,
    ) -> None: ...

class NodeNeighborsResponse(_message.Message):
    __slots__ = ("success", "nodes", "edges", "total_neighbor_count", "returned_count", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    NODES_FIELD_NUMBER: _ClassVar[int]
    EDGES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_NEIGHBOR_COUNT_FIELD_NUMBER: _ClassVar[int]
    RETURNED_COUNT_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    nodes: _containers.RepeatedCompositeFieldContainer[NeighborNode]
    edges: _containers.RepeatedCompositeFieldContainer[NeighborEdge]
    total_neighbor_count: int
    returned_count: int
    error: str
    def __init__(
        self,
        success: bool = ...,
        nodes: _Iterable[NeighborNode | _Mapping] | None = ...,
        edges: _Iterable[NeighborEdge | _Mapping] | None = ...,
        total_neighbor_count: int | None = ...,
        returned_count: int | None = ...,
        error: str | None = ...,
    ) -> None: ...

class GraphStatsRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class GraphStatsResponse(_message.Message):
    __slots__ = ("success", "total_nodes", "total_edges", "node_counts_by_type", "edge_counts_by_type", "avg_degree", "error")
    class NodeCountsByTypeEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: int
        def __init__(self, key: str | None = ..., value: int | None = ...) -> None: ...

    class EdgeCountsByTypeEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: int
        def __init__(self, key: str | None = ..., value: int | None = ...) -> None: ...

    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_NODES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_EDGES_FIELD_NUMBER: _ClassVar[int]
    NODE_COUNTS_BY_TYPE_FIELD_NUMBER: _ClassVar[int]
    EDGE_COUNTS_BY_TYPE_FIELD_NUMBER: _ClassVar[int]
    AVG_DEGREE_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    total_nodes: int
    total_edges: int
    node_counts_by_type: _containers.ScalarMap[str, int]
    edge_counts_by_type: _containers.ScalarMap[str, int]
    avg_degree: float
    error: str
    def __init__(
        self,
        success: bool = ...,
        total_nodes: int | None = ...,
        total_edges: int | None = ...,
        node_counts_by_type: _Mapping[str, int] | None = ...,
        edge_counts_by_type: _Mapping[str, int] | None = ...,
        avg_degree: float | None = ...,
        error: str | None = ...,
    ) -> None: ...

class EntityRelRequest(_message.Message):
    __slots__ = ("query", "entity_type", "limit")
    QUERY_FIELD_NUMBER: _ClassVar[int]
    ENTITY_TYPE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    query: str
    entity_type: str
    limit: int
    def __init__(self, query: str | None = ..., entity_type: str | None = ..., limit: int | None = ...) -> None: ...

class EntityRelResponse(_message.Message):
    __slots__ = ("success", "entities_json", "relationships_json", "total_entities", "total_relationships", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ENTITIES_JSON_FIELD_NUMBER: _ClassVar[int]
    RELATIONSHIPS_JSON_FIELD_NUMBER: _ClassVar[int]
    TOTAL_ENTITIES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_RELATIONSHIPS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    entities_json: str
    relationships_json: str
    total_entities: int
    total_relationships: int
    error: str
    def __init__(
        self,
        success: bool = ...,
        entities_json: str | None = ...,
        relationships_json: str | None = ...,
        total_entities: int | None = ...,
        total_relationships: int | None = ...,
        error: str | None = ...,
    ) -> None: ...

class RAGTracesRequest(_message.Message):
    __slots__ = ("limit", "page", "strategy_filter", "mode_filter", "from_date", "to_date", "user_id")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    STRATEGY_FILTER_FIELD_NUMBER: _ClassVar[int]
    MODE_FILTER_FIELD_NUMBER: _ClassVar[int]
    FROM_DATE_FIELD_NUMBER: _ClassVar[int]
    TO_DATE_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    limit: int
    page: int
    strategy_filter: str
    mode_filter: str
    from_date: str
    to_date: str
    user_id: str
    def __init__(
        self,
        limit: int | None = ...,
        page: int | None = ...,
        strategy_filter: str | None = ...,
        mode_filter: str | None = ...,
        from_date: str | None = ...,
        to_date: str | None = ...,
        user_id: str | None = ...,
    ) -> None: ...

class RAGTraceItem(_message.Message):
    __slots__ = (
        "id",
        "session_id",
        "user_id",
        "query",
        "selected_strategy",
        "selected_orchestrator",
        "strategy_type",
        "mode",
        "confidence",
        "reasoning",
        "alternative_strategies_json",
        "query_characteristics_json",
        "latency_ms",
        "token_count",
        "created_at",
        "graph_traversal_stats_json",
    )
    ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    QUERY_FIELD_NUMBER: _ClassVar[int]
    SELECTED_STRATEGY_FIELD_NUMBER: _ClassVar[int]
    SELECTED_ORCHESTRATOR_FIELD_NUMBER: _ClassVar[int]
    STRATEGY_TYPE_FIELD_NUMBER: _ClassVar[int]
    MODE_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    REASONING_FIELD_NUMBER: _ClassVar[int]
    ALTERNATIVE_STRATEGIES_JSON_FIELD_NUMBER: _ClassVar[int]
    QUERY_CHARACTERISTICS_JSON_FIELD_NUMBER: _ClassVar[int]
    LATENCY_MS_FIELD_NUMBER: _ClassVar[int]
    TOKEN_COUNT_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    GRAPH_TRAVERSAL_STATS_JSON_FIELD_NUMBER: _ClassVar[int]
    id: str
    session_id: str
    user_id: str
    query: str
    selected_strategy: str
    selected_orchestrator: str
    strategy_type: str
    mode: str
    confidence: float
    reasoning: str
    alternative_strategies_json: str
    query_characteristics_json: str
    latency_ms: int
    token_count: int
    created_at: str
    graph_traversal_stats_json: str
    def __init__(
        self,
        id: str | None = ...,
        session_id: str | None = ...,
        user_id: str | None = ...,
        query: str | None = ...,
        selected_strategy: str | None = ...,
        selected_orchestrator: str | None = ...,
        strategy_type: str | None = ...,
        mode: str | None = ...,
        confidence: float | None = ...,
        reasoning: str | None = ...,
        alternative_strategies_json: str | None = ...,
        query_characteristics_json: str | None = ...,
        latency_ms: int | None = ...,
        token_count: int | None = ...,
        created_at: str | None = ...,
        graph_traversal_stats_json: str | None = ...,
    ) -> None: ...

class RAGTracesResponse(_message.Message):
    __slots__ = ("success", "traces", "total", "page", "page_size", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    TRACES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    traces: _containers.RepeatedCompositeFieldContainer[RAGTraceItem]
    total: int
    page: int
    page_size: int
    error: str
    def __init__(
        self,
        success: bool = ...,
        traces: _Iterable[RAGTraceItem | _Mapping] | None = ...,
        total: int | None = ...,
        page: int | None = ...,
        page_size: int | None = ...,
        error: str | None = ...,
    ) -> None: ...

class StrategyDistRequest(_message.Message):
    __slots__ = ("from_date", "to_date")
    FROM_DATE_FIELD_NUMBER: _ClassVar[int]
    TO_DATE_FIELD_NUMBER: _ClassVar[int]
    from_date: str
    to_date: str
    def __init__(self, from_date: str | None = ..., to_date: str | None = ...) -> None: ...

class StrategyDistItem(_message.Message):
    __slots__ = ("strategy_name", "count", "avg_latency_ms", "avg_tokens", "avg_confidence")
    STRATEGY_NAME_FIELD_NUMBER: _ClassVar[int]
    COUNT_FIELD_NUMBER: _ClassVar[int]
    AVG_LATENCY_MS_FIELD_NUMBER: _ClassVar[int]
    AVG_TOKENS_FIELD_NUMBER: _ClassVar[int]
    AVG_CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    strategy_name: str
    count: int
    avg_latency_ms: float
    avg_tokens: float
    avg_confidence: float
    def __init__(
        self,
        strategy_name: str | None = ...,
        count: int | None = ...,
        avg_latency_ms: float | None = ...,
        avg_tokens: float | None = ...,
        avg_confidence: float | None = ...,
    ) -> None: ...

class StrategyDistResponse(_message.Message):
    __slots__ = ("success", "distributions", "total_traces", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    DISTRIBUTIONS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TRACES_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    distributions: _containers.RepeatedCompositeFieldContainer[StrategyDistItem]
    total_traces: int
    error: str
    def __init__(
        self,
        success: bool = ...,
        distributions: _Iterable[StrategyDistItem | _Mapping] | None = ...,
        total_traces: int | None = ...,
        error: str | None = ...,
    ) -> None: ...

class LLMTracesRequest(_message.Message):
    __slots__ = ("limit", "page", "chat_mode_filter", "provider_filter", "model_filter", "from_date", "to_date", "user_id")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    CHAT_MODE_FILTER_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FILTER_FIELD_NUMBER: _ClassVar[int]
    MODEL_FILTER_FIELD_NUMBER: _ClassVar[int]
    FROM_DATE_FIELD_NUMBER: _ClassVar[int]
    TO_DATE_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    limit: int
    page: int
    chat_mode_filter: str
    provider_filter: str
    model_filter: str
    from_date: str
    to_date: str
    user_id: str
    def __init__(
        self,
        limit: int | None = ...,
        page: int | None = ...,
        chat_mode_filter: str | None = ...,
        provider_filter: str | None = ...,
        model_filter: str | None = ...,
        from_date: str | None = ...,
        to_date: str | None = ...,
        user_id: str | None = ...,
    ) -> None: ...

class LLMTraceItem(_message.Message):
    __slots__ = (
        "id",
        "session_id",
        "user_id",
        "workspace_id",
        "assistant_message_id",
        "query",
        "chat_mode",
        "collection_ids_json",
        "document_ids_json",
        "top_k",
        "similarity_threshold",
        "strategy_name",
        "strategy_type",
        "agentic_routing",
        "retrieved_chunks_json",
        "retrieved_chunk_count",
        "system_prompt_length",
        "context_token_estimate",
        "history_message_count",
        "has_conversation_summary",
        "provider",
        "model",
        "input_tokens",
        "output_tokens",
        "total_tokens",
        "cost_usd",
        "latency_ms",
        "duration_ms",
        "response_preview",
        "source_analysis_json",
        "created_at",
    )
    ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    ASSISTANT_MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    QUERY_FIELD_NUMBER: _ClassVar[int]
    CHAT_MODE_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_JSON_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_IDS_JSON_FIELD_NUMBER: _ClassVar[int]
    TOP_K_FIELD_NUMBER: _ClassVar[int]
    SIMILARITY_THRESHOLD_FIELD_NUMBER: _ClassVar[int]
    STRATEGY_NAME_FIELD_NUMBER: _ClassVar[int]
    STRATEGY_TYPE_FIELD_NUMBER: _ClassVar[int]
    AGENTIC_ROUTING_FIELD_NUMBER: _ClassVar[int]
    RETRIEVED_CHUNKS_JSON_FIELD_NUMBER: _ClassVar[int]
    RETRIEVED_CHUNK_COUNT_FIELD_NUMBER: _ClassVar[int]
    SYSTEM_PROMPT_LENGTH_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_TOKEN_ESTIMATE_FIELD_NUMBER: _ClassVar[int]
    HISTORY_MESSAGE_COUNT_FIELD_NUMBER: _ClassVar[int]
    HAS_CONVERSATION_SUMMARY_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TOKENS_FIELD_NUMBER: _ClassVar[int]
    COST_USD_FIELD_NUMBER: _ClassVar[int]
    LATENCY_MS_FIELD_NUMBER: _ClassVar[int]
    DURATION_MS_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_PREVIEW_FIELD_NUMBER: _ClassVar[int]
    SOURCE_ANALYSIS_JSON_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    session_id: str
    user_id: str
    workspace_id: str
    assistant_message_id: str
    query: str
    chat_mode: str
    collection_ids_json: str
    document_ids_json: str
    top_k: int
    similarity_threshold: float
    strategy_name: str
    strategy_type: str
    agentic_routing: bool
    retrieved_chunks_json: str
    retrieved_chunk_count: int
    system_prompt_length: int
    context_token_estimate: int
    history_message_count: int
    has_conversation_summary: bool
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost_usd: float
    latency_ms: int
    duration_ms: int
    response_preview: str
    source_analysis_json: str
    created_at: str
    def __init__(
        self,
        id: str | None = ...,
        session_id: str | None = ...,
        user_id: str | None = ...,
        workspace_id: str | None = ...,
        assistant_message_id: str | None = ...,
        query: str | None = ...,
        chat_mode: str | None = ...,
        collection_ids_json: str | None = ...,
        document_ids_json: str | None = ...,
        top_k: int | None = ...,
        similarity_threshold: float | None = ...,
        strategy_name: str | None = ...,
        strategy_type: str | None = ...,
        agentic_routing: bool = ...,
        retrieved_chunks_json: str | None = ...,
        retrieved_chunk_count: int | None = ...,
        system_prompt_length: int | None = ...,
        context_token_estimate: int | None = ...,
        history_message_count: int | None = ...,
        has_conversation_summary: bool = ...,
        provider: str | None = ...,
        model: str | None = ...,
        input_tokens: int | None = ...,
        output_tokens: int | None = ...,
        total_tokens: int | None = ...,
        cost_usd: float | None = ...,
        latency_ms: int | None = ...,
        duration_ms: int | None = ...,
        response_preview: str | None = ...,
        source_analysis_json: str | None = ...,
        created_at: str | None = ...,
    ) -> None: ...

class LLMTracesResponse(_message.Message):
    __slots__ = ("success", "traces", "total", "page", "page_size", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    TRACES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    traces: _containers.RepeatedCompositeFieldContainer[LLMTraceItem]
    total: int
    page: int
    page_size: int
    error: str
    def __init__(
        self,
        success: bool = ...,
        traces: _Iterable[LLMTraceItem | _Mapping] | None = ...,
        total: int | None = ...,
        page: int | None = ...,
        page_size: int | None = ...,
        error: str | None = ...,
    ) -> None: ...

class LLMTraceSummaryRequest(_message.Message):
    __slots__ = ("from_date", "to_date")
    FROM_DATE_FIELD_NUMBER: _ClassVar[int]
    TO_DATE_FIELD_NUMBER: _ClassVar[int]
    from_date: str
    to_date: str
    def __init__(self, from_date: str | None = ..., to_date: str | None = ...) -> None: ...

class LLMTraceSummaryResponse(_message.Message):
    __slots__ = (
        "success",
        "total_traces",
        "total_cost_usd",
        "total_tokens",
        "avg_latency_ms",
        "provider_distribution_json",
        "chat_mode_distribution_json",
        "model_distribution_json",
        "error",
    )
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TRACES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_COST_USD_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TOKENS_FIELD_NUMBER: _ClassVar[int]
    AVG_LATENCY_MS_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_DISTRIBUTION_JSON_FIELD_NUMBER: _ClassVar[int]
    CHAT_MODE_DISTRIBUTION_JSON_FIELD_NUMBER: _ClassVar[int]
    MODEL_DISTRIBUTION_JSON_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    total_traces: int
    total_cost_usd: float
    total_tokens: int
    avg_latency_ms: float
    provider_distribution_json: str
    chat_mode_distribution_json: str
    model_distribution_json: str
    error: str
    def __init__(
        self,
        success: bool = ...,
        total_traces: int | None = ...,
        total_cost_usd: float | None = ...,
        total_tokens: int | None = ...,
        avg_latency_ms: float | None = ...,
        provider_distribution_json: str | None = ...,
        chat_mode_distribution_json: str | None = ...,
        model_distribution_json: str | None = ...,
        error: str | None = ...,
    ) -> None: ...

class LLMEvalRequest(_message.Message):
    __slots__ = ("sample_size",)
    SAMPLE_SIZE_FIELD_NUMBER: _ClassVar[int]
    sample_size: int
    def __init__(self, sample_size: int | None = ...) -> None: ...

class LLMJudgeScore(_message.Message):
    __slots__ = ("trace_id", "faithfulness_score", "context_relevance_score", "completeness_score", "overall_score", "reasoning")
    TRACE_ID_FIELD_NUMBER: _ClassVar[int]
    FAITHFULNESS_SCORE_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_RELEVANCE_SCORE_FIELD_NUMBER: _ClassVar[int]
    COMPLETENESS_SCORE_FIELD_NUMBER: _ClassVar[int]
    OVERALL_SCORE_FIELD_NUMBER: _ClassVar[int]
    REASONING_FIELD_NUMBER: _ClassVar[int]
    trace_id: str
    faithfulness_score: float
    context_relevance_score: float
    completeness_score: float
    overall_score: float
    reasoning: str
    def __init__(
        self,
        trace_id: str | None = ...,
        faithfulness_score: float | None = ...,
        context_relevance_score: float | None = ...,
        completeness_score: float | None = ...,
        overall_score: float | None = ...,
        reasoning: str | None = ...,
    ) -> None: ...

class LLMEvalProgress(_message.Message):
    __slots__ = ("completed", "total", "progress", "current_result", "status", "avg_faithfulness", "avg_context_relevance", "avg_completeness")
    COMPLETED_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    PROGRESS_FIELD_NUMBER: _ClassVar[int]
    CURRENT_RESULT_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    AVG_FAITHFULNESS_FIELD_NUMBER: _ClassVar[int]
    AVG_CONTEXT_RELEVANCE_FIELD_NUMBER: _ClassVar[int]
    AVG_COMPLETENESS_FIELD_NUMBER: _ClassVar[int]
    completed: int
    total: int
    progress: float
    current_result: LLMJudgeScore
    status: str
    avg_faithfulness: float
    avg_context_relevance: float
    avg_completeness: float
    def __init__(
        self,
        completed: int | None = ...,
        total: int | None = ...,
        progress: float | None = ...,
        current_result: LLMJudgeScore | _Mapping | None = ...,
        status: str | None = ...,
        avg_faithfulness: float | None = ...,
        avg_context_relevance: float | None = ...,
        avg_completeness: float | None = ...,
    ) -> None: ...

class RelatedBooksRequest(_message.Message):
    __slots__ = ("book_id", "document_id", "limit")
    BOOK_ID_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    book_id: str
    document_id: str
    limit: int
    def __init__(self, book_id: str | None = ..., document_id: str | None = ..., limit: int | None = ...) -> None: ...

class SharedEntityInfo(_message.Message):
    __slots__ = ("name", "entity_type", "confidence")
    NAME_FIELD_NUMBER: _ClassVar[int]
    ENTITY_TYPE_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    name: str
    entity_type: str
    confidence: float
    def __init__(self, name: str | None = ..., entity_type: str | None = ..., confidence: float | None = ...) -> None: ...

class RelatedBookItem(_message.Message):
    __slots__ = ("book_id", "document_id", "title", "filename", "shared_entity_count", "entity_types", "shared_entities")
    BOOK_ID_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    FILENAME_FIELD_NUMBER: _ClassVar[int]
    SHARED_ENTITY_COUNT_FIELD_NUMBER: _ClassVar[int]
    ENTITY_TYPES_FIELD_NUMBER: _ClassVar[int]
    SHARED_ENTITIES_FIELD_NUMBER: _ClassVar[int]
    book_id: str
    document_id: str
    title: str
    filename: str
    shared_entity_count: int
    entity_types: _containers.RepeatedScalarFieldContainer[str]
    shared_entities: _containers.RepeatedCompositeFieldContainer[SharedEntityInfo]
    def __init__(
        self,
        book_id: str | None = ...,
        document_id: str | None = ...,
        title: str | None = ...,
        filename: str | None = ...,
        shared_entity_count: int | None = ...,
        entity_types: _Iterable[str] | None = ...,
        shared_entities: _Iterable[SharedEntityInfo | _Mapping] | None = ...,
    ) -> None: ...

class RelatedBooksResponse(_message.Message):
    __slots__ = ("success", "related_books", "total_count", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    RELATED_BOOKS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_COUNT_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    related_books: _containers.RepeatedCompositeFieldContainer[RelatedBookItem]
    total_count: int
    error: str
    def __init__(
        self,
        success: bool = ...,
        related_books: _Iterable[RelatedBookItem | _Mapping] | None = ...,
        total_count: int | None = ...,
        error: str | None = ...,
    ) -> None: ...

class CrossBookGraphRequest(_message.Message):
    __slots__ = ("collection_id", "limit")
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    collection_id: str
    limit: int
    def __init__(self, collection_id: str | None = ..., limit: int | None = ...) -> None: ...

class CrossBookGraphNode(_message.Message):
    __slots__ = ("id", "title", "document_id", "filename", "collection_id", "entity_count", "chapter_count")
    ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    FILENAME_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    ENTITY_COUNT_FIELD_NUMBER: _ClassVar[int]
    CHAPTER_COUNT_FIELD_NUMBER: _ClassVar[int]
    id: str
    title: str
    document_id: str
    filename: str
    collection_id: str
    entity_count: int
    chapter_count: int
    def __init__(
        self,
        id: str | None = ...,
        title: str | None = ...,
        document_id: str | None = ...,
        filename: str | None = ...,
        collection_id: str | None = ...,
        entity_count: int | None = ...,
        chapter_count: int | None = ...,
    ) -> None: ...

class CrossBookGraphEdge(_message.Message):
    __slots__ = ("source", "target", "shared_entity_count", "entity_types", "top_entities")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    TARGET_FIELD_NUMBER: _ClassVar[int]
    SHARED_ENTITY_COUNT_FIELD_NUMBER: _ClassVar[int]
    ENTITY_TYPES_FIELD_NUMBER: _ClassVar[int]
    TOP_ENTITIES_FIELD_NUMBER: _ClassVar[int]
    source: str
    target: str
    shared_entity_count: int
    entity_types: _containers.RepeatedScalarFieldContainer[str]
    top_entities: _containers.RepeatedScalarFieldContainer[str]
    def __init__(
        self,
        source: str | None = ...,
        target: str | None = ...,
        shared_entity_count: int | None = ...,
        entity_types: _Iterable[str] | None = ...,
        top_entities: _Iterable[str] | None = ...,
    ) -> None: ...

class CrossBookGraphResponse(_message.Message):
    __slots__ = ("success", "nodes", "edges", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    NODES_FIELD_NUMBER: _ClassVar[int]
    EDGES_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    nodes: _containers.RepeatedCompositeFieldContainer[CrossBookGraphNode]
    edges: _containers.RepeatedCompositeFieldContainer[CrossBookGraphEdge]
    error: str
    def __init__(
        self,
        success: bool = ...,
        nodes: _Iterable[CrossBookGraphNode | _Mapping] | None = ...,
        edges: _Iterable[CrossBookGraphEdge | _Mapping] | None = ...,
        error: str | None = ...,
    ) -> None: ...

class GraphSyncStatusRequest(_message.Message):
    __slots__ = ("collection_id", "status_filter", "limit", "page")
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FILTER_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    collection_id: str
    status_filter: str
    limit: int
    page: int
    def __init__(self, collection_id: str | None = ..., status_filter: str | None = ..., limit: int | None = ..., page: int | None = ...) -> None: ...

class GraphSyncStatusItem(_message.Message):
    __slots__ = (
        "document_id",
        "collection_id",
        "status",
        "chunks_expected",
        "chunks_created",
        "entities_extracted",
        "error_message",
        "started_at",
        "completed_at",
        "updated_at",
        "document_title",
    )
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    CHUNKS_EXPECTED_FIELD_NUMBER: _ClassVar[int]
    CHUNKS_CREATED_FIELD_NUMBER: _ClassVar[int]
    ENTITIES_EXTRACTED_FIELD_NUMBER: _ClassVar[int]
    ERROR_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_TITLE_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    collection_id: str
    status: str
    chunks_expected: int
    chunks_created: int
    entities_extracted: int
    error_message: str
    started_at: str
    completed_at: str
    updated_at: str
    document_title: str
    def __init__(
        self,
        document_id: str | None = ...,
        collection_id: str | None = ...,
        status: str | None = ...,
        chunks_expected: int | None = ...,
        chunks_created: int | None = ...,
        entities_extracted: int | None = ...,
        error_message: str | None = ...,
        started_at: str | None = ...,
        completed_at: str | None = ...,
        updated_at: str | None = ...,
        document_title: str | None = ...,
    ) -> None: ...

class GraphSyncSummary(_message.Message):
    __slots__ = (
        "total_documents",
        "pending_count",
        "hierarchy_done_count",
        "entity_running_count",
        "completed_count",
        "failed_count",
        "total_entities_extracted",
        "total_chunks",
        "avg_entities_per_doc",
        "latest_completed_at",
    )
    TOTAL_DOCUMENTS_FIELD_NUMBER: _ClassVar[int]
    PENDING_COUNT_FIELD_NUMBER: _ClassVar[int]
    HIERARCHY_DONE_COUNT_FIELD_NUMBER: _ClassVar[int]
    ENTITY_RUNNING_COUNT_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_COUNT_FIELD_NUMBER: _ClassVar[int]
    FAILED_COUNT_FIELD_NUMBER: _ClassVar[int]
    TOTAL_ENTITIES_EXTRACTED_FIELD_NUMBER: _ClassVar[int]
    TOTAL_CHUNKS_FIELD_NUMBER: _ClassVar[int]
    AVG_ENTITIES_PER_DOC_FIELD_NUMBER: _ClassVar[int]
    LATEST_COMPLETED_AT_FIELD_NUMBER: _ClassVar[int]
    total_documents: int
    pending_count: int
    hierarchy_done_count: int
    entity_running_count: int
    completed_count: int
    failed_count: int
    total_entities_extracted: int
    total_chunks: int
    avg_entities_per_doc: float
    latest_completed_at: str
    def __init__(
        self,
        total_documents: int | None = ...,
        pending_count: int | None = ...,
        hierarchy_done_count: int | None = ...,
        entity_running_count: int | None = ...,
        completed_count: int | None = ...,
        failed_count: int | None = ...,
        total_entities_extracted: int | None = ...,
        total_chunks: int | None = ...,
        avg_entities_per_doc: float | None = ...,
        latest_completed_at: str | None = ...,
    ) -> None: ...

class GraphSyncStatusResponse(_message.Message):
    __slots__ = ("success", "items", "summary", "total", "page", "page_size", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    items: _containers.RepeatedCompositeFieldContainer[GraphSyncStatusItem]
    summary: GraphSyncSummary
    total: int
    page: int
    page_size: int
    error: str
    def __init__(
        self,
        success: bool = ...,
        items: _Iterable[GraphSyncStatusItem | _Mapping] | None = ...,
        summary: GraphSyncSummary | _Mapping | None = ...,
        total: int | None = ...,
        page: int | None = ...,
        page_size: int | None = ...,
        error: str | None = ...,
    ) -> None: ...

class GraphQualityAuditRequest(_message.Message):
    __slots__ = ("collection_id",)
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    collection_id: str
    def __init__(self, collection_id: str | None = ...) -> None: ...

class GraphQualityAuditResponse(_message.Message):
    __slots__ = (
        "success",
        "error",
        "overall_score",
        "coverage",
        "hierarchy",
        "entity_health",
        "relationship_health",
        "chunk_alignment",
        "collections",
        "cross_book_health",
    )
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    OVERALL_SCORE_FIELD_NUMBER: _ClassVar[int]
    COVERAGE_FIELD_NUMBER: _ClassVar[int]
    HIERARCHY_FIELD_NUMBER: _ClassVar[int]
    ENTITY_HEALTH_FIELD_NUMBER: _ClassVar[int]
    RELATIONSHIP_HEALTH_FIELD_NUMBER: _ClassVar[int]
    CHUNK_ALIGNMENT_FIELD_NUMBER: _ClassVar[int]
    COLLECTIONS_FIELD_NUMBER: _ClassVar[int]
    CROSS_BOOK_HEALTH_FIELD_NUMBER: _ClassVar[int]
    success: bool
    error: str
    overall_score: float
    coverage: CoverageStats
    hierarchy: HierarchyIntegrity
    entity_health: EntityHealth
    relationship_health: RelationshipHealth
    chunk_alignment: ChunkAlignment
    collections: _containers.RepeatedCompositeFieldContainer[CollectionAuditItem]
    cross_book_health: CrossBookHealth
    def __init__(
        self,
        success: bool = ...,
        error: str | None = ...,
        overall_score: float | None = ...,
        coverage: CoverageStats | _Mapping | None = ...,
        hierarchy: HierarchyIntegrity | _Mapping | None = ...,
        entity_health: EntityHealth | _Mapping | None = ...,
        relationship_health: RelationshipHealth | _Mapping | None = ...,
        chunk_alignment: ChunkAlignment | _Mapping | None = ...,
        collections: _Iterable[CollectionAuditItem | _Mapping] | None = ...,
        cross_book_health: CrossBookHealth | _Mapping | None = ...,
    ) -> None: ...

class CoverageStats(_message.Message):
    __slots__ = ("pg_documents", "neo4j_books", "missing_in_graph", "coverage_pct", "sync_completed", "sync_running", "sync_failed", "sync_pending")
    PG_DOCUMENTS_FIELD_NUMBER: _ClassVar[int]
    NEO4J_BOOKS_FIELD_NUMBER: _ClassVar[int]
    MISSING_IN_GRAPH_FIELD_NUMBER: _ClassVar[int]
    COVERAGE_PCT_FIELD_NUMBER: _ClassVar[int]
    SYNC_COMPLETED_FIELD_NUMBER: _ClassVar[int]
    SYNC_RUNNING_FIELD_NUMBER: _ClassVar[int]
    SYNC_FAILED_FIELD_NUMBER: _ClassVar[int]
    SYNC_PENDING_FIELD_NUMBER: _ClassVar[int]
    pg_documents: int
    neo4j_books: int
    missing_in_graph: int
    coverage_pct: float
    sync_completed: int
    sync_running: int
    sync_failed: int
    sync_pending: int
    def __init__(
        self,
        pg_documents: int | None = ...,
        neo4j_books: int | None = ...,
        missing_in_graph: int | None = ...,
        coverage_pct: float | None = ...,
        sync_completed: int | None = ...,
        sync_running: int | None = ...,
        sync_failed: int | None = ...,
        sync_pending: int | None = ...,
    ) -> None: ...

class HierarchyIntegrity(_message.Message):
    __slots__ = (
        "total_books",
        "total_chapters",
        "total_sections",
        "total_chunks",
        "orphan_chunks",
        "orphan_sections",
        "orphan_chapters",
        "books_without_chapters",
        "integrity_score",
    )
    TOTAL_BOOKS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_CHAPTERS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_SECTIONS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_CHUNKS_FIELD_NUMBER: _ClassVar[int]
    ORPHAN_CHUNKS_FIELD_NUMBER: _ClassVar[int]
    ORPHAN_SECTIONS_FIELD_NUMBER: _ClassVar[int]
    ORPHAN_CHAPTERS_FIELD_NUMBER: _ClassVar[int]
    BOOKS_WITHOUT_CHAPTERS_FIELD_NUMBER: _ClassVar[int]
    INTEGRITY_SCORE_FIELD_NUMBER: _ClassVar[int]
    total_books: int
    total_chapters: int
    total_sections: int
    total_chunks: int
    orphan_chunks: int
    orphan_sections: int
    orphan_chapters: int
    books_without_chapters: int
    integrity_score: float
    def __init__(
        self,
        total_books: int | None = ...,
        total_chapters: int | None = ...,
        total_sections: int | None = ...,
        total_chunks: int | None = ...,
        orphan_chunks: int | None = ...,
        orphan_sections: int | None = ...,
        orphan_chapters: int | None = ...,
        books_without_chapters: int | None = ...,
        integrity_score: float | None = ...,
    ) -> None: ...

class EntityHealth(_message.Message):
    __slots__ = ("total_entities", "entities_with_mentions", "orphaned_entities", "health_pct", "by_type")
    TOTAL_ENTITIES_FIELD_NUMBER: _ClassVar[int]
    ENTITIES_WITH_MENTIONS_FIELD_NUMBER: _ClassVar[int]
    ORPHANED_ENTITIES_FIELD_NUMBER: _ClassVar[int]
    HEALTH_PCT_FIELD_NUMBER: _ClassVar[int]
    BY_TYPE_FIELD_NUMBER: _ClassVar[int]
    total_entities: int
    entities_with_mentions: int
    orphaned_entities: int
    health_pct: float
    by_type: _containers.RepeatedCompositeFieldContainer[EntityTypeBreakdown]
    def __init__(
        self,
        total_entities: int | None = ...,
        entities_with_mentions: int | None = ...,
        orphaned_entities: int | None = ...,
        health_pct: float | None = ...,
        by_type: _Iterable[EntityTypeBreakdown | _Mapping] | None = ...,
    ) -> None: ...

class EntityTypeBreakdown(_message.Message):
    __slots__ = ("entity_type", "total", "with_mentions", "orphaned")
    ENTITY_TYPE_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    WITH_MENTIONS_FIELD_NUMBER: _ClassVar[int]
    ORPHANED_FIELD_NUMBER: _ClassVar[int]
    entity_type: str
    total: int
    with_mentions: int
    orphaned: int
    def __init__(
        self, entity_type: str | None = ..., total: int | None = ..., with_mentions: int | None = ..., orphaned: int | None = ...
    ) -> None: ...

class RelationshipHealth(_message.Message):
    __slots__ = (
        "total_co_occurs",
        "valid_co_occurs",
        "stale_co_occurs",
        "co_occurs_health_pct",
        "total_shared_entity",
        "total_mentions",
        "total_contains",
    )
    TOTAL_CO_OCCURS_FIELD_NUMBER: _ClassVar[int]
    VALID_CO_OCCURS_FIELD_NUMBER: _ClassVar[int]
    STALE_CO_OCCURS_FIELD_NUMBER: _ClassVar[int]
    CO_OCCURS_HEALTH_PCT_FIELD_NUMBER: _ClassVar[int]
    TOTAL_SHARED_ENTITY_FIELD_NUMBER: _ClassVar[int]
    TOTAL_MENTIONS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_CONTAINS_FIELD_NUMBER: _ClassVar[int]
    total_co_occurs: int
    valid_co_occurs: int
    stale_co_occurs: int
    co_occurs_health_pct: float
    total_shared_entity: int
    total_mentions: int
    total_contains: int
    def __init__(
        self,
        total_co_occurs: int | None = ...,
        valid_co_occurs: int | None = ...,
        stale_co_occurs: int | None = ...,
        co_occurs_health_pct: float | None = ...,
        total_shared_entity: int | None = ...,
        total_mentions: int | None = ...,
        total_contains: int | None = ...,
    ) -> None: ...

class ChunkAlignment(_message.Message):
    __slots__ = ("neo4j_chunks", "pg_embeddings", "matched", "neo4j_only", "pg_only", "alignment_pct")
    NEO4J_CHUNKS_FIELD_NUMBER: _ClassVar[int]
    PG_EMBEDDINGS_FIELD_NUMBER: _ClassVar[int]
    MATCHED_FIELD_NUMBER: _ClassVar[int]
    NEO4J_ONLY_FIELD_NUMBER: _ClassVar[int]
    PG_ONLY_FIELD_NUMBER: _ClassVar[int]
    ALIGNMENT_PCT_FIELD_NUMBER: _ClassVar[int]
    neo4j_chunks: int
    pg_embeddings: int
    matched: int
    neo4j_only: int
    pg_only: int
    alignment_pct: float
    def __init__(
        self,
        neo4j_chunks: int | None = ...,
        pg_embeddings: int | None = ...,
        matched: int | None = ...,
        neo4j_only: int | None = ...,
        pg_only: int | None = ...,
        alignment_pct: float | None = ...,
    ) -> None: ...

class CrossBookHealth(_message.Message):
    __slots__ = (
        "total_shared_links",
        "cross_collection_links",
        "within_collection_links",
        "connected_books",
        "disconnected_books",
        "avg_shared_per_pair",
        "connectivity_pct",
    )
    TOTAL_SHARED_LINKS_FIELD_NUMBER: _ClassVar[int]
    CROSS_COLLECTION_LINKS_FIELD_NUMBER: _ClassVar[int]
    WITHIN_COLLECTION_LINKS_FIELD_NUMBER: _ClassVar[int]
    CONNECTED_BOOKS_FIELD_NUMBER: _ClassVar[int]
    DISCONNECTED_BOOKS_FIELD_NUMBER: _ClassVar[int]
    AVG_SHARED_PER_PAIR_FIELD_NUMBER: _ClassVar[int]
    CONNECTIVITY_PCT_FIELD_NUMBER: _ClassVar[int]
    total_shared_links: int
    cross_collection_links: int
    within_collection_links: int
    connected_books: int
    disconnected_books: int
    avg_shared_per_pair: float
    connectivity_pct: float
    def __init__(
        self,
        total_shared_links: int | None = ...,
        cross_collection_links: int | None = ...,
        within_collection_links: int | None = ...,
        connected_books: int | None = ...,
        disconnected_books: int | None = ...,
        avg_shared_per_pair: float | None = ...,
        connectivity_pct: float | None = ...,
    ) -> None: ...

class CollectionAuditItem(_message.Message):
    __slots__ = ("collection_id", "collection_name", "pg_documents", "neo4j_books", "coverage_pct", "total_entities", "total_chunks")
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_NAME_FIELD_NUMBER: _ClassVar[int]
    PG_DOCUMENTS_FIELD_NUMBER: _ClassVar[int]
    NEO4J_BOOKS_FIELD_NUMBER: _ClassVar[int]
    COVERAGE_PCT_FIELD_NUMBER: _ClassVar[int]
    TOTAL_ENTITIES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_CHUNKS_FIELD_NUMBER: _ClassVar[int]
    collection_id: str
    collection_name: str
    pg_documents: int
    neo4j_books: int
    coverage_pct: float
    total_entities: int
    total_chunks: int
    def __init__(
        self,
        collection_id: str | None = ...,
        collection_name: str | None = ...,
        pg_documents: int | None = ...,
        neo4j_books: int | None = ...,
        coverage_pct: float | None = ...,
        total_entities: int | None = ...,
        total_chunks: int | None = ...,
    ) -> None: ...

class AgentCostAnalysisRequest(_message.Message):
    __slots__ = ("from_date", "to_date")
    FROM_DATE_FIELD_NUMBER: _ClassVar[int]
    TO_DATE_FIELD_NUMBER: _ClassVar[int]
    from_date: str
    to_date: str
    def __init__(self, from_date: str | None = ..., to_date: str | None = ...) -> None: ...

class AgentCostItem(_message.Message):
    __slots__ = ("agent_type", "call_count", "total_cost_usd", "total_input_tokens", "total_output_tokens", "total_tokens", "avg_latency_ms", "model")
    AGENT_TYPE_FIELD_NUMBER: _ClassVar[int]
    CALL_COUNT_FIELD_NUMBER: _ClassVar[int]
    TOTAL_COST_USD_FIELD_NUMBER: _ClassVar[int]
    TOTAL_INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_OUTPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TOKENS_FIELD_NUMBER: _ClassVar[int]
    AVG_LATENCY_MS_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    agent_type: str
    call_count: int
    total_cost_usd: float
    total_input_tokens: int
    total_output_tokens: int
    total_tokens: int
    avg_latency_ms: float
    model: str
    def __init__(
        self,
        agent_type: str | None = ...,
        call_count: int | None = ...,
        total_cost_usd: float | None = ...,
        total_input_tokens: int | None = ...,
        total_output_tokens: int | None = ...,
        total_tokens: int | None = ...,
        avg_latency_ms: float | None = ...,
        model: str | None = ...,
    ) -> None: ...

class DailyCostItem(_message.Message):
    __slots__ = ("date", "cost_usd", "tokens", "calls")
    DATE_FIELD_NUMBER: _ClassVar[int]
    COST_USD_FIELD_NUMBER: _ClassVar[int]
    TOKENS_FIELD_NUMBER: _ClassVar[int]
    CALLS_FIELD_NUMBER: _ClassVar[int]
    date: str
    cost_usd: float
    tokens: int
    calls: int
    def __init__(self, date: str | None = ..., cost_usd: float | None = ..., tokens: int | None = ..., calls: int | None = ...) -> None: ...

class AgentCostAnalysisResponse(_message.Message):
    __slots__ = (
        "success",
        "error",
        "total_cost_usd",
        "total_tokens",
        "total_calls",
        "user_cost_usd",
        "system_cost_usd",
        "agent_breakdown",
        "daily_costs",
        "model_costs",
    )
    class ModelCostsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: float
        def __init__(self, key: str | None = ..., value: float | None = ...) -> None: ...

    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    TOTAL_COST_USD_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TOKENS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_CALLS_FIELD_NUMBER: _ClassVar[int]
    USER_COST_USD_FIELD_NUMBER: _ClassVar[int]
    SYSTEM_COST_USD_FIELD_NUMBER: _ClassVar[int]
    AGENT_BREAKDOWN_FIELD_NUMBER: _ClassVar[int]
    DAILY_COSTS_FIELD_NUMBER: _ClassVar[int]
    MODEL_COSTS_FIELD_NUMBER: _ClassVar[int]
    success: bool
    error: str
    total_cost_usd: float
    total_tokens: int
    total_calls: int
    user_cost_usd: float
    system_cost_usd: float
    agent_breakdown: _containers.RepeatedCompositeFieldContainer[AgentCostItem]
    daily_costs: _containers.RepeatedCompositeFieldContainer[DailyCostItem]
    model_costs: _containers.ScalarMap[str, float]
    def __init__(
        self,
        success: bool = ...,
        error: str | None = ...,
        total_cost_usd: float | None = ...,
        total_tokens: int | None = ...,
        total_calls: int | None = ...,
        user_cost_usd: float | None = ...,
        system_cost_usd: float | None = ...,
        agent_breakdown: _Iterable[AgentCostItem | _Mapping] | None = ...,
        daily_costs: _Iterable[DailyCostItem | _Mapping] | None = ...,
        model_costs: _Mapping[str, float] | None = ...,
    ) -> None: ...

class CleanupOrphanedTracesRequest(_message.Message):
    __slots__ = ("valid_session_ids",)
    VALID_SESSION_IDS_FIELD_NUMBER: _ClassVar[int]
    valid_session_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, valid_session_ids: _Iterable[str] | None = ...) -> None: ...

class CleanupOrphanedTracesResponse(_message.Message):
    __slots__ = ("success", "rag_traces_deleted", "llm_traces_deleted", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    RAG_TRACES_DELETED_FIELD_NUMBER: _ClassVar[int]
    LLM_TRACES_DELETED_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    rag_traces_deleted: int
    llm_traces_deleted: int
    error: str
    def __init__(
        self, success: bool = ..., rag_traces_deleted: int | None = ..., llm_traces_deleted: int | None = ..., error: str | None = ...
    ) -> None: ...
