from src.main.grpc import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class TriggerAutofixRequest(_message.Message):
    __slots__ = ("user_id", "error_log", "error_context", "pr_body", "target_repo")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    ERROR_LOG_FIELD_NUMBER: _ClassVar[int]
    ERROR_CONTEXT_FIELD_NUMBER: _ClassVar[int]
    PR_BODY_FIELD_NUMBER: _ClassVar[int]
    TARGET_REPO_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    error_log: str
    error_context: str
    pr_body: str
    target_repo: str
    def __init__(self, user_id: _Optional[str] = ..., error_log: _Optional[str] = ..., error_context: _Optional[str] = ..., pr_body: _Optional[str] = ..., target_repo: _Optional[str] = ...) -> None: ...

class TriggerAutofixResponse(_message.Message):
    __slots__ = ("success", "message", "branch_name")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    BRANCH_NAME_FIELD_NUMBER: _ClassVar[int]
    success: bool
    message: str
    branch_name: str
    def __init__(self, success: bool = ..., message: _Optional[str] = ..., branch_name: _Optional[str] = ...) -> None: ...

class GetDebugLogsRequest(_message.Message):
    __slots__ = ("user_id", "container_name", "tail_lines")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    CONTAINER_NAME_FIELD_NUMBER: _ClassVar[int]
    TAIL_LINES_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    container_name: str
    tail_lines: int
    def __init__(self, user_id: _Optional[str] = ..., container_name: _Optional[str] = ..., tail_lines: _Optional[int] = ...) -> None: ...

class GetDebugLogsResponse(_message.Message):
    __slots__ = ("success", "logs", "error_context", "warning_context")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    LOGS_FIELD_NUMBER: _ClassVar[int]
    ERROR_CONTEXT_FIELD_NUMBER: _ClassVar[int]
    WARNING_CONTEXT_FIELD_NUMBER: _ClassVar[int]
    success: bool
    logs: str
    error_context: str
    warning_context: str
    def __init__(self, success: bool = ..., logs: _Optional[str] = ..., error_context: _Optional[str] = ..., warning_context: _Optional[str] = ...) -> None: ...

class RebuildGraphRequest(_message.Message):
    __slots__ = ("user_id", "collection_id", "limit")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    collection_id: str
    limit: int
    def __init__(self, user_id: _Optional[str] = ..., collection_id: _Optional[str] = ..., limit: _Optional[int] = ...) -> None: ...

class RebuildGraphResponse(_message.Message):
    __slots__ = ("success", "message", "documents_processed", "entities_extracted")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    DOCUMENTS_PROCESSED_FIELD_NUMBER: _ClassVar[int]
    ENTITIES_EXTRACTED_FIELD_NUMBER: _ClassVar[int]
    success: bool
    message: str
    documents_processed: int
    entities_extracted: int
    def __init__(self, success: bool = ..., message: _Optional[str] = ..., documents_processed: _Optional[int] = ..., entities_extracted: _Optional[int] = ...) -> None: ...

class RebuildCrossBookRequest(_message.Message):
    __slots__ = ("user_id", "collection_id")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    collection_id: str
    def __init__(self, user_id: _Optional[str] = ..., collection_id: _Optional[str] = ...) -> None: ...

class RebuildCrossBookResponse(_message.Message):
    __slots__ = ("success", "message", "relationships_created", "books_processed")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    RELATIONSHIPS_CREATED_FIELD_NUMBER: _ClassVar[int]
    BOOKS_PROCESSED_FIELD_NUMBER: _ClassVar[int]
    success: bool
    message: str
    relationships_created: int
    books_processed: int
    def __init__(self, success: bool = ..., message: _Optional[str] = ..., relationships_created: _Optional[int] = ..., books_processed: _Optional[int] = ...) -> None: ...

class GraphHealthCheckRequest(_message.Message):
    __slots__ = ("user_id",)
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    def __init__(self, user_id: _Optional[str] = ...) -> None: ...

class GraphHealthCheckFinding(_message.Message):
    __slots__ = ("severity", "category", "metric", "message", "sample")
    SEVERITY_FIELD_NUMBER: _ClassVar[int]
    CATEGORY_FIELD_NUMBER: _ClassVar[int]
    METRIC_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    SAMPLE_FIELD_NUMBER: _ClassVar[int]
    severity: str
    category: str
    metric: str
    message: str
    sample: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, severity: _Optional[str] = ..., category: _Optional[str] = ..., metric: _Optional[str] = ..., message: _Optional[str] = ..., sample: _Optional[_Iterable[str]] = ...) -> None: ...

class GraphHealthCheckResponse(_message.Message):
    __slots__ = ("success", "critical_count", "warning_count", "info_count", "findings", "stats_json")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    CRITICAL_COUNT_FIELD_NUMBER: _ClassVar[int]
    WARNING_COUNT_FIELD_NUMBER: _ClassVar[int]
    INFO_COUNT_FIELD_NUMBER: _ClassVar[int]
    FINDINGS_FIELD_NUMBER: _ClassVar[int]
    STATS_JSON_FIELD_NUMBER: _ClassVar[int]
    success: bool
    critical_count: int
    warning_count: int
    info_count: int
    findings: _containers.RepeatedCompositeFieldContainer[GraphHealthCheckFinding]
    stats_json: str
    def __init__(self, success: bool = ..., critical_count: _Optional[int] = ..., warning_count: _Optional[int] = ..., info_count: _Optional[int] = ..., findings: _Optional[_Iterable[_Union[GraphHealthCheckFinding, _Mapping]]] = ..., stats_json: _Optional[str] = ...) -> None: ...

class SweepGraphOrphansRequest(_message.Message):
    __slots__ = ("user_id", "dry_run", "purge_empty_workspaces")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    DRY_RUN_FIELD_NUMBER: _ClassVar[int]
    PURGE_EMPTY_WORKSPACES_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    dry_run: bool
    purge_empty_workspaces: bool
    def __init__(self, user_id: _Optional[str] = ..., dry_run: bool = ..., purge_empty_workspaces: bool = ...) -> None: ...

class SweepGraphOrphansResponse(_message.Message):
    __slots__ = ("success", "orphan_chunks_deleted", "orphan_sections_deleted", "orphan_chapters_deleted", "orphan_books_deleted", "empty_workspaces_deleted", "total_deleted", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ORPHAN_CHUNKS_DELETED_FIELD_NUMBER: _ClassVar[int]
    ORPHAN_SECTIONS_DELETED_FIELD_NUMBER: _ClassVar[int]
    ORPHAN_CHAPTERS_DELETED_FIELD_NUMBER: _ClassVar[int]
    ORPHAN_BOOKS_DELETED_FIELD_NUMBER: _ClassVar[int]
    EMPTY_WORKSPACES_DELETED_FIELD_NUMBER: _ClassVar[int]
    TOTAL_DELETED_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    orphan_chunks_deleted: int
    orphan_sections_deleted: int
    orphan_chapters_deleted: int
    orphan_books_deleted: int
    empty_workspaces_deleted: int
    total_deleted: int
    message: str
    def __init__(self, success: bool = ..., orphan_chunks_deleted: _Optional[int] = ..., orphan_sections_deleted: _Optional[int] = ..., orphan_chapters_deleted: _Optional[int] = ..., orphan_books_deleted: _Optional[int] = ..., empty_workspaces_deleted: _Optional[int] = ..., total_deleted: _Optional[int] = ..., message: _Optional[str] = ...) -> None: ...

class MergeDuplicateEntitiesRequest(_message.Message):
    __slots__ = ("user_id", "dry_run", "batch_size")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    DRY_RUN_FIELD_NUMBER: _ClassVar[int]
    BATCH_SIZE_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    dry_run: bool
    batch_size: int
    def __init__(self, user_id: _Optional[str] = ..., dry_run: bool = ..., batch_size: _Optional[int] = ...) -> None: ...

class MergeDuplicateEntitiesResponse(_message.Message):
    __slots__ = ("success", "groups_merged", "duplicate_nodes_removed", "edges_redirected", "message", "sample_groups_json")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    GROUPS_MERGED_FIELD_NUMBER: _ClassVar[int]
    DUPLICATE_NODES_REMOVED_FIELD_NUMBER: _ClassVar[int]
    EDGES_REDIRECTED_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    SAMPLE_GROUPS_JSON_FIELD_NUMBER: _ClassVar[int]
    success: bool
    groups_merged: int
    duplicate_nodes_removed: int
    edges_redirected: int
    message: str
    sample_groups_json: str
    def __init__(self, success: bool = ..., groups_merged: _Optional[int] = ..., duplicate_nodes_removed: _Optional[int] = ..., edges_redirected: _Optional[int] = ..., message: _Optional[str] = ..., sample_groups_json: _Optional[str] = ...) -> None: ...

class CleanupMissingFileDocsRequest(_message.Message):
    __slots__ = ("user_id", "dry_run")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    DRY_RUN_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    dry_run: bool
    def __init__(self, user_id: _Optional[str] = ..., dry_run: bool = ...) -> None: ...

class CleanupMissingFileDocsResponse(_message.Message):
    __slots__ = ("success", "docs_processed", "pg_embeddings_deleted", "neo4j_nodes_deleted", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    DOCS_PROCESSED_FIELD_NUMBER: _ClassVar[int]
    PG_EMBEDDINGS_DELETED_FIELD_NUMBER: _ClassVar[int]
    NEO4J_NODES_DELETED_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    docs_processed: int
    pg_embeddings_deleted: int
    neo4j_nodes_deleted: int
    message: str
    def __init__(self, success: bool = ..., docs_processed: _Optional[int] = ..., pg_embeddings_deleted: _Optional[int] = ..., neo4j_nodes_deleted: _Optional[int] = ..., message: _Optional[str] = ...) -> None: ...

class GraphAuditRequest(_message.Message):
    __slots__ = ("user_id",)
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    def __init__(self, user_id: _Optional[str] = ...) -> None: ...

class GraphAuditResponse(_message.Message):
    __slots__ = ("success", "measured_at", "audit_json", "markdown_report")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    MEASURED_AT_FIELD_NUMBER: _ClassVar[int]
    AUDIT_JSON_FIELD_NUMBER: _ClassVar[int]
    MARKDOWN_REPORT_FIELD_NUMBER: _ClassVar[int]
    success: bool
    measured_at: str
    audit_json: str
    markdown_report: str
    def __init__(self, success: bool = ..., measured_at: _Optional[str] = ..., audit_json: _Optional[str] = ..., markdown_report: _Optional[str] = ...) -> None: ...

class SweepOrphanEntitiesRequest(_message.Message):
    __slots__ = ("user_id", "dry_run", "created_before_days", "limit")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    DRY_RUN_FIELD_NUMBER: _ClassVar[int]
    CREATED_BEFORE_DAYS_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    dry_run: bool
    created_before_days: int
    limit: int
    def __init__(self, user_id: _Optional[str] = ..., dry_run: bool = ..., created_before_days: _Optional[int] = ..., limit: _Optional[int] = ...) -> None: ...

class SweepOrphanEntitiesResponse(_message.Message):
    __slots__ = ("success", "candidates", "deleted", "created_before_days", "sample_names", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    CANDIDATES_FIELD_NUMBER: _ClassVar[int]
    DELETED_FIELD_NUMBER: _ClassVar[int]
    CREATED_BEFORE_DAYS_FIELD_NUMBER: _ClassVar[int]
    SAMPLE_NAMES_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    candidates: int
    deleted: int
    created_before_days: int
    sample_names: _containers.RepeatedScalarFieldContainer[str]
    message: str
    def __init__(self, success: bool = ..., candidates: _Optional[int] = ..., deleted: _Optional[int] = ..., created_before_days: _Optional[int] = ..., sample_names: _Optional[_Iterable[str]] = ..., message: _Optional[str] = ...) -> None: ...

class EvaluateGraphUtilityRequest(_message.Message):
    __slots__ = ("user_id", "eval_set_path", "configurations_json", "top_k")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    EVAL_SET_PATH_FIELD_NUMBER: _ClassVar[int]
    CONFIGURATIONS_JSON_FIELD_NUMBER: _ClassVar[int]
    TOP_K_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    eval_set_path: str
    configurations_json: str
    top_k: int
    def __init__(self, user_id: _Optional[str] = ..., eval_set_path: _Optional[str] = ..., configurations_json: _Optional[str] = ..., top_k: _Optional[int] = ...) -> None: ...

class EvaluateGraphUtilityResponse(_message.Message):
    __slots__ = ("success", "started_at", "finished_at", "run_json", "markdown_report", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    FINISHED_AT_FIELD_NUMBER: _ClassVar[int]
    RUN_JSON_FIELD_NUMBER: _ClassVar[int]
    MARKDOWN_REPORT_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    started_at: str
    finished_at: str
    run_json: str
    markdown_report: str
    message: str
    def __init__(self, success: bool = ..., started_at: _Optional[str] = ..., finished_at: _Optional[str] = ..., run_json: _Optional[str] = ..., markdown_report: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class RecomputeEntityIdfRequest(_message.Message):
    __slots__ = ("user_id", "dry_run")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    DRY_RUN_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    dry_run: bool
    def __init__(self, user_id: _Optional[str] = ..., dry_run: bool = ...) -> None: ...

class RecomputeEntityIdfResponse(_message.Message):
    __slots__ = ("success", "total_documents", "total_entities", "updated", "skipped_no_mentions", "p50_idf", "p95_idf", "max_idf", "min_idf", "sample_rare_entities_json", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_DOCUMENTS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_ENTITIES_FIELD_NUMBER: _ClassVar[int]
    UPDATED_FIELD_NUMBER: _ClassVar[int]
    SKIPPED_NO_MENTIONS_FIELD_NUMBER: _ClassVar[int]
    P50_IDF_FIELD_NUMBER: _ClassVar[int]
    P95_IDF_FIELD_NUMBER: _ClassVar[int]
    MAX_IDF_FIELD_NUMBER: _ClassVar[int]
    MIN_IDF_FIELD_NUMBER: _ClassVar[int]
    SAMPLE_RARE_ENTITIES_JSON_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    total_documents: int
    total_entities: int
    updated: int
    skipped_no_mentions: int
    p50_idf: float
    p95_idf: float
    max_idf: float
    min_idf: float
    sample_rare_entities_json: str
    message: str
    def __init__(self, success: bool = ..., total_documents: _Optional[int] = ..., total_entities: _Optional[int] = ..., updated: _Optional[int] = ..., skipped_no_mentions: _Optional[int] = ..., p50_idf: _Optional[float] = ..., p95_idf: _Optional[float] = ..., max_idf: _Optional[float] = ..., min_idf: _Optional[float] = ..., sample_rare_entities_json: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class GetEntityExtractionMetricsRequest(_message.Message):
    __slots__ = ("user_id", "window_days", "top_documents_limit")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    WINDOW_DAYS_FIELD_NUMBER: _ClassVar[int]
    TOP_DOCUMENTS_LIMIT_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    window_days: int
    top_documents_limit: int
    def __init__(self, user_id: _Optional[str] = ..., window_days: _Optional[int] = ..., top_documents_limit: _Optional[int] = ...) -> None: ...

class GetEntityExtractionMetricsResponse(_message.Message):
    __slots__ = ("success", "summary_json", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_JSON_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    summary_json: str
    message: str
    def __init__(self, success: bool = ..., summary_json: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class RecomputeCooccurrenceWeightsRequest(_message.Message):
    __slots__ = ("user_id",)
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    def __init__(self, user_id: _Optional[str] = ...) -> None: ...

class RelinkDocumentCooccurrenceRequest(_message.Message):
    __slots__ = ("user_id", "collection_id", "min_cooccurrence")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    MIN_COOCCURRENCE_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    collection_id: str
    min_cooccurrence: int
    def __init__(self, user_id: _Optional[str] = ..., collection_id: _Optional[str] = ..., min_cooccurrence: _Optional[int] = ...) -> None: ...

class RelinkDocumentCooccurrenceResponse(_message.Message):
    __slots__ = ("success", "documents_processed", "cooccurrence_edges_created", "chunk_entity_links_added", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    DOCUMENTS_PROCESSED_FIELD_NUMBER: _ClassVar[int]
    COOCCURRENCE_EDGES_CREATED_FIELD_NUMBER: _ClassVar[int]
    CHUNK_ENTITY_LINKS_ADDED_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    documents_processed: int
    cooccurrence_edges_created: int
    chunk_entity_links_added: int
    message: str
    def __init__(self, success: bool = ..., documents_processed: _Optional[int] = ..., cooccurrence_edges_created: _Optional[int] = ..., chunk_entity_links_added: _Optional[int] = ..., message: _Optional[str] = ...) -> None: ...

class RecomputeCooccurrenceWeightsResponse(_message.Message):
    __slots__ = ("success", "total_edges", "updated", "skipped", "p50_weighted", "p95_weighted", "max_weighted", "max_chunk_count", "max_document_count", "sample_top_edges_json", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_EDGES_FIELD_NUMBER: _ClassVar[int]
    UPDATED_FIELD_NUMBER: _ClassVar[int]
    SKIPPED_FIELD_NUMBER: _ClassVar[int]
    P50_WEIGHTED_FIELD_NUMBER: _ClassVar[int]
    P95_WEIGHTED_FIELD_NUMBER: _ClassVar[int]
    MAX_WEIGHTED_FIELD_NUMBER: _ClassVar[int]
    MAX_CHUNK_COUNT_FIELD_NUMBER: _ClassVar[int]
    MAX_DOCUMENT_COUNT_FIELD_NUMBER: _ClassVar[int]
    SAMPLE_TOP_EDGES_JSON_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    total_edges: int
    updated: int
    skipped: int
    p50_weighted: float
    p95_weighted: float
    max_weighted: float
    max_chunk_count: int
    max_document_count: int
    sample_top_edges_json: str
    message: str
    def __init__(self, success: bool = ..., total_edges: _Optional[int] = ..., updated: _Optional[int] = ..., skipped: _Optional[int] = ..., p50_weighted: _Optional[float] = ..., p95_weighted: _Optional[float] = ..., max_weighted: _Optional[float] = ..., max_chunk_count: _Optional[int] = ..., max_document_count: _Optional[int] = ..., sample_top_edges_json: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class PruneCooccurrenceEdgesRequest(_message.Message):
    __slots__ = ("user_id", "dry_run", "percentile")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    DRY_RUN_FIELD_NUMBER: _ClassVar[int]
    PERCENTILE_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    dry_run: bool
    percentile: float
    def __init__(self, user_id: _Optional[str] = ..., dry_run: bool = ..., percentile: _Optional[float] = ...) -> None: ...

class PruneCooccurrenceEdgesResponse(_message.Message):
    __slots__ = ("success", "dry_run", "threshold_percentile", "threshold_value", "total_edges_before", "edges_deleted", "snapshot_key_prefix", "sample_pruned_json", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    DRY_RUN_FIELD_NUMBER: _ClassVar[int]
    THRESHOLD_PERCENTILE_FIELD_NUMBER: _ClassVar[int]
    THRESHOLD_VALUE_FIELD_NUMBER: _ClassVar[int]
    TOTAL_EDGES_BEFORE_FIELD_NUMBER: _ClassVar[int]
    EDGES_DELETED_FIELD_NUMBER: _ClassVar[int]
    SNAPSHOT_KEY_PREFIX_FIELD_NUMBER: _ClassVar[int]
    SAMPLE_PRUNED_JSON_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    dry_run: bool
    threshold_percentile: float
    threshold_value: float
    total_edges_before: int
    edges_deleted: int
    snapshot_key_prefix: str
    sample_pruned_json: str
    message: str
    def __init__(self, success: bool = ..., dry_run: bool = ..., threshold_percentile: _Optional[float] = ..., threshold_value: _Optional[float] = ..., total_edges_before: _Optional[int] = ..., edges_deleted: _Optional[int] = ..., snapshot_key_prefix: _Optional[str] = ..., sample_pruned_json: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class RecomputePageRankRequest(_message.Message):
    __slots__ = ("user_id", "collection_id")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    collection_id: str
    def __init__(self, user_id: _Optional[str] = ..., collection_id: _Optional[str] = ...) -> None: ...

class RecomputePageRankResponse(_message.Message):
    __slots__ = ("success", "collections_processed", "books_scored", "books_considered", "edges_projected", "longest_duration_ms", "results_json", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    COLLECTIONS_PROCESSED_FIELD_NUMBER: _ClassVar[int]
    BOOKS_SCORED_FIELD_NUMBER: _ClassVar[int]
    BOOKS_CONSIDERED_FIELD_NUMBER: _ClassVar[int]
    EDGES_PROJECTED_FIELD_NUMBER: _ClassVar[int]
    LONGEST_DURATION_MS_FIELD_NUMBER: _ClassVar[int]
    RESULTS_JSON_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    collections_processed: int
    books_scored: int
    books_considered: int
    edges_projected: int
    longest_duration_ms: int
    results_json: str
    message: str
    def __init__(self, success: bool = ..., collections_processed: _Optional[int] = ..., books_scored: _Optional[int] = ..., books_considered: _Optional[int] = ..., edges_projected: _Optional[int] = ..., longest_duration_ms: _Optional[int] = ..., results_json: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class ClassifyTypedRelationshipsRequest(_message.Message):
    __slots__ = ("user_id", "document_id", "max_pairs", "min_weight", "min_confidence")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    MAX_PAIRS_FIELD_NUMBER: _ClassVar[int]
    MIN_WEIGHT_FIELD_NUMBER: _ClassVar[int]
    MIN_CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    document_id: str
    max_pairs: int
    min_weight: float
    min_confidence: float
    def __init__(self, user_id: _Optional[str] = ..., document_id: _Optional[str] = ..., max_pairs: _Optional[int] = ..., min_weight: _Optional[float] = ..., min_confidence: _Optional[float] = ...) -> None: ...

class ClassifyTypedRelationshipsResponse(_message.Message):
    __slots__ = ("success", "document_id", "pair_count", "llm_calls", "skipped_low_confidence", "skipped_none", "persisted_by_type_json", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    PAIR_COUNT_FIELD_NUMBER: _ClassVar[int]
    LLM_CALLS_FIELD_NUMBER: _ClassVar[int]
    SKIPPED_LOW_CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    SKIPPED_NONE_FIELD_NUMBER: _ClassVar[int]
    PERSISTED_BY_TYPE_JSON_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    document_id: str
    pair_count: int
    llm_calls: int
    skipped_low_confidence: int
    skipped_none: int
    persisted_by_type_json: str
    message: str
    def __init__(self, success: bool = ..., document_id: _Optional[str] = ..., pair_count: _Optional[int] = ..., llm_calls: _Optional[int] = ..., skipped_low_confidence: _Optional[int] = ..., skipped_none: _Optional[int] = ..., persisted_by_type_json: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class RecomputeCollectionFingerprintsRequest(_message.Message):
    __slots__ = ("user_id", "collection_id")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    collection_id: str
    def __init__(self, user_id: _Optional[str] = ..., collection_id: _Optional[str] = ...) -> None: ...

class RecomputeCollectionFingerprintsResponse(_message.Message):
    __slots__ = ("success", "collections_processed", "with_centroid", "fingerprints_json", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    COLLECTIONS_PROCESSED_FIELD_NUMBER: _ClassVar[int]
    WITH_CENTROID_FIELD_NUMBER: _ClassVar[int]
    FINGERPRINTS_JSON_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    collections_processed: int
    with_centroid: int
    fingerprints_json: str
    message: str
    def __init__(self, success: bool = ..., collections_processed: _Optional[int] = ..., with_centroid: _Optional[int] = ..., fingerprints_json: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class DetectCollectionBridgeRequest(_message.Message):
    __slots__ = ("user_id", "collection_ids")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, user_id: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ...) -> None: ...

class DetectCollectionBridgeResponse(_message.Message):
    __slots__ = ("success", "mode", "verdict_json", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    MODE_FIELD_NUMBER: _ClassVar[int]
    VERDICT_JSON_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    mode: str
    verdict_json: str
    message: str
    def __init__(self, success: bool = ..., mode: _Optional[str] = ..., verdict_json: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class BuildCommunitiesRequest(_message.Message):
    __slots__ = ("user_id", "collection_id", "max_cluster_size", "generate_reports", "parallelism")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    MAX_CLUSTER_SIZE_FIELD_NUMBER: _ClassVar[int]
    GENERATE_REPORTS_FIELD_NUMBER: _ClassVar[int]
    PARALLELISM_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    collection_id: str
    max_cluster_size: int
    generate_reports: bool
    parallelism: int
    def __init__(self, user_id: _Optional[str] = ..., collection_id: _Optional[str] = ..., max_cluster_size: _Optional[int] = ..., generate_reports: bool = ..., parallelism: _Optional[int] = ...) -> None: ...

class BuildCommunitiesResponse(_message.Message):
    __slots__ = ("success", "communities_total", "reports_written", "sizes_by_level_json", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    COMMUNITIES_TOTAL_FIELD_NUMBER: _ClassVar[int]
    REPORTS_WRITTEN_FIELD_NUMBER: _ClassVar[int]
    SIZES_BY_LEVEL_JSON_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    communities_total: int
    reports_written: int
    sizes_by_level_json: str
    message: str
    def __init__(self, success: bool = ..., communities_total: _Optional[int] = ..., reports_written: _Optional[int] = ..., sizes_by_level_json: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class GetCommunityHierarchyRequest(_message.Message):
    __slots__ = ("user_id", "collection_id")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    collection_id: str
    def __init__(self, user_id: _Optional[str] = ..., collection_id: _Optional[str] = ...) -> None: ...

class CommunitySummary(_message.Message):
    __slots__ = ("community_id", "level", "size", "weight", "title", "rating", "parent_community_id")
    COMMUNITY_ID_FIELD_NUMBER: _ClassVar[int]
    LEVEL_FIELD_NUMBER: _ClassVar[int]
    SIZE_FIELD_NUMBER: _ClassVar[int]
    WEIGHT_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    RATING_FIELD_NUMBER: _ClassVar[int]
    PARENT_COMMUNITY_ID_FIELD_NUMBER: _ClassVar[int]
    community_id: str
    level: int
    size: int
    weight: float
    title: str
    rating: float
    parent_community_id: str
    def __init__(self, community_id: _Optional[str] = ..., level: _Optional[int] = ..., size: _Optional[int] = ..., weight: _Optional[float] = ..., title: _Optional[str] = ..., rating: _Optional[float] = ..., parent_community_id: _Optional[str] = ...) -> None: ...

class GetCommunityHierarchyResponse(_message.Message):
    __slots__ = ("success", "communities", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    COMMUNITIES_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    communities: _containers.RepeatedCompositeFieldContainer[CommunitySummary]
    message: str
    def __init__(self, success: bool = ..., communities: _Optional[_Iterable[_Union[CommunitySummary, _Mapping]]] = ..., message: _Optional[str] = ...) -> None: ...

class GetCommunityReportRequest(_message.Message):
    __slots__ = ("user_id", "community_id")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COMMUNITY_ID_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    community_id: str
    def __init__(self, user_id: _Optional[str] = ..., community_id: _Optional[str] = ...) -> None: ...

class Finding(_message.Message):
    __slots__ = ("summary", "explanation")
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    EXPLANATION_FIELD_NUMBER: _ClassVar[int]
    summary: str
    explanation: str
    def __init__(self, summary: _Optional[str] = ..., explanation: _Optional[str] = ...) -> None: ...

class GetCommunityReportResponse(_message.Message):
    __slots__ = ("success", "community_id", "title", "summary", "rating", "rating_explanation", "findings", "member_entity_ids", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    COMMUNITY_ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    RATING_FIELD_NUMBER: _ClassVar[int]
    RATING_EXPLANATION_FIELD_NUMBER: _ClassVar[int]
    FINDINGS_FIELD_NUMBER: _ClassVar[int]
    MEMBER_ENTITY_IDS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    community_id: str
    title: str
    summary: str
    rating: float
    rating_explanation: str
    findings: _containers.RepeatedCompositeFieldContainer[Finding]
    member_entity_ids: _containers.RepeatedScalarFieldContainer[str]
    message: str
    def __init__(self, success: bool = ..., community_id: _Optional[str] = ..., title: _Optional[str] = ..., summary: _Optional[str] = ..., rating: _Optional[float] = ..., rating_explanation: _Optional[str] = ..., findings: _Optional[_Iterable[_Union[Finding, _Mapping]]] = ..., member_entity_ids: _Optional[_Iterable[str]] = ..., message: _Optional[str] = ...) -> None: ...
