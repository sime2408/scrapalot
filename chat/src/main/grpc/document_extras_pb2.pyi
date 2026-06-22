from typing import ClassVar as _ClassVar
from collections.abc import Iterable as _Iterable
from collections.abc import Mapping as _Mapping
from typing import Optional as _Optional
from typing import Union as _Union

from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from google.protobuf.internal import containers as _containers

DESCRIPTOR: _descriptor.FileDescriptor

class UploadDocumentRequest(_message.Message):
    __slots__ = ("collection_id", "user_id", "filename", "file_data", "auto_process", "store_file", "build_graph", "generate_summary")
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    FILENAME_FIELD_NUMBER: _ClassVar[int]
    FILE_DATA_FIELD_NUMBER: _ClassVar[int]
    AUTO_PROCESS_FIELD_NUMBER: _ClassVar[int]
    STORE_FILE_FIELD_NUMBER: _ClassVar[int]
    BUILD_GRAPH_FIELD_NUMBER: _ClassVar[int]
    GENERATE_SUMMARY_FIELD_NUMBER: _ClassVar[int]
    collection_id: str
    user_id: str
    filename: str
    file_data: bytes
    auto_process: bool
    store_file: bool
    build_graph: bool
    generate_summary: bool
    def __init__(
        self,
        collection_id: str | None = ...,
        user_id: str | None = ...,
        filename: str | None = ...,
        file_data: bytes | None = ...,
        auto_process: bool = ...,
        store_file: bool = ...,
        build_graph: bool = ...,
        generate_summary: bool = ...,
    ) -> None: ...

class UploadDocumentResponse(_message.Message):
    __slots__ = ("success", "document_id", "job_id", "message", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    document_id: str
    job_id: str
    message: str
    error: str
    def __init__(
        self,
        success: bool = ...,
        document_id: str | None = ...,
        job_id: str | None = ...,
        message: str | None = ...,
        error: str | None = ...,
    ) -> None: ...

class GetThumbnailRequest(_message.Message):
    __slots__ = ("document_id", "size", "user_id")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    SIZE_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    size: str
    user_id: str
    def __init__(self, document_id: str | None = ..., size: str | None = ..., user_id: str | None = ...) -> None: ...

class ThumbnailResponse(_message.Message):
    __slots__ = ("found", "image_data", "content_type", "file_path")
    FOUND_FIELD_NUMBER: _ClassVar[int]
    IMAGE_DATA_FIELD_NUMBER: _ClassVar[int]
    CONTENT_TYPE_FIELD_NUMBER: _ClassVar[int]
    FILE_PATH_FIELD_NUMBER: _ClassVar[int]
    found: bool
    image_data: bytes
    content_type: str
    file_path: str
    def __init__(self, found: bool = ..., image_data: bytes | None = ..., content_type: str | None = ..., file_path: str | None = ...) -> None: ...

class UploadCustomThumbnailRequest(_message.Message):
    __slots__ = ("document_id", "user_id", "image_data", "filename")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    IMAGE_DATA_FIELD_NUMBER: _ClassVar[int]
    FILENAME_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    user_id: str
    image_data: bytes
    filename: str
    def __init__(
        self, document_id: str | None = ..., user_id: str | None = ..., image_data: bytes | None = ..., filename: str | None = ...
    ) -> None: ...

class DeleteThumbnailRequest(_message.Message):
    __slots__ = ("document_id", "user_id")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    user_id: str
    def __init__(self, document_id: str | None = ..., user_id: str | None = ...) -> None: ...

class DocxPreviewRequest(_message.Message):
    __slots__ = ("document_id", "user_id")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    user_id: str
    def __init__(self, document_id: str | None = ..., user_id: str | None = ...) -> None: ...

class DocxPreviewResponse(_message.Message):
    __slots__ = ("success", "html", "metadata_json", "warnings_json", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    HTML_FIELD_NUMBER: _ClassVar[int]
    METADATA_JSON_FIELD_NUMBER: _ClassVar[int]
    WARNINGS_JSON_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    html: str
    metadata_json: str
    warnings_json: str
    error: str
    def __init__(
        self,
        success: bool = ...,
        html: str | None = ...,
        metadata_json: str | None = ...,
        warnings_json: str | None = ...,
        error: str | None = ...,
    ) -> None: ...

class GetDocumentFileRequest(_message.Message):
    __slots__ = ("document_id", "user_id")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    user_id: str
    def __init__(self, document_id: str | None = ..., user_id: str | None = ...) -> None: ...

class DocumentFileResponse(_message.Message):
    __slots__ = ("found", "file_data", "filename", "content_type", "file_path")
    FOUND_FIELD_NUMBER: _ClassVar[int]
    FILE_DATA_FIELD_NUMBER: _ClassVar[int]
    FILENAME_FIELD_NUMBER: _ClassVar[int]
    CONTENT_TYPE_FIELD_NUMBER: _ClassVar[int]
    FILE_PATH_FIELD_NUMBER: _ClassVar[int]
    found: bool
    file_data: bytes
    filename: str
    content_type: str
    file_path: str
    def __init__(
        self,
        found: bool = ...,
        file_data: bytes | None = ...,
        filename: str | None = ...,
        content_type: str | None = ...,
        file_path: str | None = ...,
    ) -> None: ...

class ListCollectionDocsRequest(_message.Message):
    __slots__ = ("collection_id", "user_id", "page", "page_size", "search")
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    SEARCH_FIELD_NUMBER: _ClassVar[int]
    collection_id: str
    user_id: str
    page: int
    page_size: int
    search: str
    def __init__(
        self,
        collection_id: str | None = ...,
        user_id: str | None = ...,
        page: int | None = ...,
        page_size: int | None = ...,
        search: str | None = ...,
    ) -> None: ...

class ListCollectionDocsResponse(_message.Message):
    __slots__ = ("documents_json", "has_more", "total")
    DOCUMENTS_JSON_FIELD_NUMBER: _ClassVar[int]
    HAS_MORE_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    documents_json: str
    has_more: bool
    total: int
    def __init__(self, documents_json: str | None = ..., has_more: bool = ..., total: int | None = ...) -> None: ...

class ReadingPositionRequest(_message.Message):
    __slots__ = ("document_id", "user_id")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    user_id: str
    def __init__(self, document_id: str | None = ..., user_id: str | None = ...) -> None: ...

class ReadingPositionResponse(_message.Message):
    __slots__ = ("found", "document_id", "page", "position_json")
    FOUND_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    POSITION_JSON_FIELD_NUMBER: _ClassVar[int]
    found: bool
    document_id: str
    page: int
    position_json: str
    def __init__(self, found: bool = ..., document_id: str | None = ..., page: int | None = ..., position_json: str | None = ...) -> None: ...

class SetReadingPositionRequest(_message.Message):
    __slots__ = ("document_id", "user_id", "page", "position_json")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    POSITION_JSON_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    user_id: str
    page: int
    position_json: str
    def __init__(self, document_id: str | None = ..., user_id: str | None = ..., page: int | None = ..., position_json: str | None = ...) -> None: ...

class GetBookSummaryRequest(_message.Message):
    __slots__ = ("document_id", "user_id")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    user_id: str
    def __init__(self, document_id: str | None = ..., user_id: str | None = ...) -> None: ...

class BookSummaryResponse(_message.Message):
    __slots__ = ("found", "summary_text")
    FOUND_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_TEXT_FIELD_NUMBER: _ClassVar[int]
    found: bool
    summary_text: str
    def __init__(self, found: bool = ..., summary_text: str | None = ...) -> None: ...

class GenerateBookSummaryRequest(_message.Message):
    __slots__ = ("document_id", "user_id")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    user_id: str
    def __init__(self, document_id: str | None = ..., user_id: str | None = ...) -> None: ...

class SummaryProgressPacket(_message.Message):
    __slots__ = ("type", "message", "progress", "summary_text")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    PROGRESS_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_TEXT_FIELD_NUMBER: _ClassVar[int]
    type: str
    message: str
    progress: float
    summary_text: str
    def __init__(self, type: str | None = ..., message: str | None = ..., progress: float | None = ..., summary_text: str | None = ...) -> None: ...

class GetDocumentByIdRequest(_message.Message):
    __slots__ = ("document_id",)
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    def __init__(self, document_id: str | None = ...) -> None: ...

class DocumentDetailResponse(_message.Message):
    __slots__ = (
        "found",
        "id",
        "title",
        "filename",
        "file_path",
        "file_size",
        "file_type",
        "page_count",
        "word_count",
        "processing_status",
        "processing_error",
        "processing_progress",
        "collection_id",
        "created_at",
        "updated_at",
        "has_thumbnail",
    )
    FOUND_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    FILENAME_FIELD_NUMBER: _ClassVar[int]
    FILE_PATH_FIELD_NUMBER: _ClassVar[int]
    FILE_SIZE_FIELD_NUMBER: _ClassVar[int]
    FILE_TYPE_FIELD_NUMBER: _ClassVar[int]
    PAGE_COUNT_FIELD_NUMBER: _ClassVar[int]
    WORD_COUNT_FIELD_NUMBER: _ClassVar[int]
    PROCESSING_STATUS_FIELD_NUMBER: _ClassVar[int]
    PROCESSING_ERROR_FIELD_NUMBER: _ClassVar[int]
    PROCESSING_PROGRESS_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    HAS_THUMBNAIL_FIELD_NUMBER: _ClassVar[int]
    found: bool
    id: str
    title: str
    filename: str
    file_path: str
    file_size: int
    file_type: str
    page_count: int
    word_count: int
    processing_status: str
    processing_error: str
    processing_progress: float
    collection_id: str
    created_at: str
    updated_at: str
    has_thumbnail: bool
    def __init__(
        self,
        found: bool = ...,
        id: str | None = ...,
        title: str | None = ...,
        filename: str | None = ...,
        file_path: str | None = ...,
        file_size: int | None = ...,
        file_type: str | None = ...,
        page_count: int | None = ...,
        word_count: int | None = ...,
        processing_status: str | None = ...,
        processing_error: str | None = ...,
        processing_progress: float | None = ...,
        collection_id: str | None = ...,
        created_at: str | None = ...,
        updated_at: str | None = ...,
        has_thumbnail: bool = ...,
    ) -> None: ...

class DeleteDocumentByIdRequest(_message.Message):
    __slots__ = ("document_id", "collection_id", "user_id")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    collection_id: str
    user_id: str
    def __init__(self, document_id: str | None = ..., collection_id: str | None = ..., user_id: str | None = ...) -> None: ...

class DeleteDocumentByIdResponse(_message.Message):
    __slots__ = ("success", "message", "deleted_embeddings_count")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    DELETED_EMBEDDINGS_COUNT_FIELD_NUMBER: _ClassVar[int]
    success: bool
    message: str
    deleted_embeddings_count: int
    def __init__(self, success: bool = ..., message: str | None = ..., deleted_embeddings_count: int | None = ...) -> None: ...

class GetStorageUsageRequest(_message.Message):
    __slots__ = ("collection_ids",)
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, collection_ids: _Iterable[str] | None = ...) -> None: ...

class StorageUsageResponse(_message.Message):
    __slots__ = ("document_count", "total_size_bytes", "documents", "disk_bytes", "db_content_bytes", "thumbnail_bytes")
    DOCUMENT_COUNT_FIELD_NUMBER: _ClassVar[int]
    TOTAL_SIZE_BYTES_FIELD_NUMBER: _ClassVar[int]
    DOCUMENTS_FIELD_NUMBER: _ClassVar[int]
    DISK_BYTES_FIELD_NUMBER: _ClassVar[int]
    DB_CONTENT_BYTES_FIELD_NUMBER: _ClassVar[int]
    THUMBNAIL_BYTES_FIELD_NUMBER: _ClassVar[int]
    document_count: int
    total_size_bytes: int
    documents: _containers.RepeatedCompositeFieldContainer[DocumentStorageItem]
    disk_bytes: int
    db_content_bytes: int
    thumbnail_bytes: int
    def __init__(
        self,
        document_count: int | None = ...,
        total_size_bytes: int | None = ...,
        documents: _Iterable[DocumentStorageItem | _Mapping] | None = ...,
        disk_bytes: int | None = ...,
        db_content_bytes: int | None = ...,
        thumbnail_bytes: int | None = ...,
    ) -> None: ...

class DocumentStorageItem(_message.Message):
    __slots__ = ("id", "filename", "file_size")
    ID_FIELD_NUMBER: _ClassVar[int]
    FILENAME_FIELD_NUMBER: _ClassVar[int]
    FILE_SIZE_FIELD_NUMBER: _ClassVar[int]
    id: str
    filename: str
    file_size: int
    def __init__(self, id: str | None = ..., filename: str | None = ..., file_size: int | None = ...) -> None: ...

class TranslateBookSummaryRequest(_message.Message):
    __slots__ = ("document_id", "target_language")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    TARGET_LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    target_language: str
    def __init__(self, document_id: str | None = ..., target_language: str | None = ...) -> None: ...

class TranslationPacket(_message.Message):
    __slots__ = ("type", "content")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    type: str
    content: str
    def __init__(self, type: str | None = ..., content: str | None = ...) -> None: ...

class RegisterMarkdownRequest(_message.Message):
    __slots__ = ("collection_id", "user_id", "filename", "title", "markdown_content", "metadata_json")
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    FILENAME_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    MARKDOWN_CONTENT_FIELD_NUMBER: _ClassVar[int]
    METADATA_JSON_FIELD_NUMBER: _ClassVar[int]
    collection_id: str
    user_id: str
    filename: str
    title: str
    markdown_content: str
    metadata_json: str
    def __init__(
        self,
        collection_id: str | None = ...,
        user_id: str | None = ...,
        filename: str | None = ...,
        title: str | None = ...,
        markdown_content: str | None = ...,
        metadata_json: str | None = ...,
    ) -> None: ...

class RegisterMarkdownResponse(_message.Message):
    __slots__ = ("success", "document_id", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    document_id: str
    error: str
    def __init__(self, success: bool = ..., document_id: str | None = ..., error: str | None = ...) -> None: ...

class MoveDocumentsRequest(_message.Message):
    __slots__ = ("document_ids", "target_collection_id", "user_id")
    DOCUMENT_IDS_FIELD_NUMBER: _ClassVar[int]
    TARGET_COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    document_ids: _containers.RepeatedScalarFieldContainer[str]
    target_collection_id: str
    user_id: str
    def __init__(self, document_ids: _Iterable[str] | None = ..., target_collection_id: str | None = ..., user_id: str | None = ...) -> None: ...

class MoveDocumentsResponse(_message.Message):
    __slots__ = ("success", "moved_count", "failed_count", "failed_document_ids", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    MOVED_COUNT_FIELD_NUMBER: _ClassVar[int]
    FAILED_COUNT_FIELD_NUMBER: _ClassVar[int]
    FAILED_DOCUMENT_IDS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    moved_count: int
    failed_count: int
    failed_document_ids: _containers.RepeatedScalarFieldContainer[str]
    message: str
    def __init__(
        self,
        success: bool = ...,
        moved_count: int | None = ...,
        failed_count: int | None = ...,
        failed_document_ids: _Iterable[str] | None = ...,
        message: str | None = ...,
    ) -> None: ...

class BatchDeleteDocumentsRequest(_message.Message):
    __slots__ = ("document_ids", "user_id")
    DOCUMENT_IDS_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    document_ids: _containers.RepeatedScalarFieldContainer[str]
    user_id: str
    def __init__(self, document_ids: _Iterable[str] | None = ..., user_id: str | None = ...) -> None: ...

class BatchDeleteDocumentsResponse(_message.Message):
    __slots__ = ("success", "deleted_count", "failed_count", "failed_document_ids")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    DELETED_COUNT_FIELD_NUMBER: _ClassVar[int]
    FAILED_COUNT_FIELD_NUMBER: _ClassVar[int]
    FAILED_DOCUMENT_IDS_FIELD_NUMBER: _ClassVar[int]
    success: bool
    deleted_count: int
    failed_count: int
    failed_document_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(
        self,
        success: bool = ...,
        deleted_count: int | None = ...,
        failed_count: int | None = ...,
        failed_document_ids: _Iterable[str] | None = ...,
    ) -> None: ...

class GetCollectionStatsRequest(_message.Message):
    __slots__ = ("collection_id",)
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    collection_id: str
    def __init__(self, collection_id: str | None = ...) -> None: ...

class CollectionStatsResponse(_message.Message):
    __slots__ = (
        "total_documents",
        "docs_stored_on_disk",
        "docs_memory_only",
        "docs_with_embeddings",
        "total_embedding_chunks",
        "graph_completed",
        "graph_entity_running",
        "graph_hierarchy_done",
        "graph_failed",
        "graph_pending",
        "docs_with_summaries",
        "total_summary_records",
        "docs_with_thumbnails",
    )
    TOTAL_DOCUMENTS_FIELD_NUMBER: _ClassVar[int]
    DOCS_STORED_ON_DISK_FIELD_NUMBER: _ClassVar[int]
    DOCS_MEMORY_ONLY_FIELD_NUMBER: _ClassVar[int]
    DOCS_WITH_EMBEDDINGS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_EMBEDDING_CHUNKS_FIELD_NUMBER: _ClassVar[int]
    GRAPH_COMPLETED_FIELD_NUMBER: _ClassVar[int]
    GRAPH_ENTITY_RUNNING_FIELD_NUMBER: _ClassVar[int]
    GRAPH_HIERARCHY_DONE_FIELD_NUMBER: _ClassVar[int]
    GRAPH_FAILED_FIELD_NUMBER: _ClassVar[int]
    GRAPH_PENDING_FIELD_NUMBER: _ClassVar[int]
    DOCS_WITH_SUMMARIES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_SUMMARY_RECORDS_FIELD_NUMBER: _ClassVar[int]
    DOCS_WITH_THUMBNAILS_FIELD_NUMBER: _ClassVar[int]
    total_documents: int
    docs_stored_on_disk: int
    docs_memory_only: int
    docs_with_embeddings: int
    total_embedding_chunks: int
    graph_completed: int
    graph_entity_running: int
    graph_hierarchy_done: int
    graph_failed: int
    graph_pending: int
    docs_with_summaries: int
    total_summary_records: int
    docs_with_thumbnails: int
    def __init__(
        self,
        total_documents: int | None = ...,
        docs_stored_on_disk: int | None = ...,
        docs_memory_only: int | None = ...,
        docs_with_embeddings: int | None = ...,
        total_embedding_chunks: int | None = ...,
        graph_completed: int | None = ...,
        graph_entity_running: int | None = ...,
        graph_hierarchy_done: int | None = ...,
        graph_failed: int | None = ...,
        graph_pending: int | None = ...,
        docs_with_summaries: int | None = ...,
        total_summary_records: int | None = ...,
        docs_with_thumbnails: int | None = ...,
    ) -> None: ...

class BuildDocumentGraphRequest(_message.Message):
    __slots__ = ("document_id", "collection_id", "user_id")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    collection_id: str
    user_id: str
    def __init__(self, document_id: str | None = ..., collection_id: str | None = ..., user_id: str | None = ...) -> None: ...

class RebuildDocumentEmbeddingsRequest(_message.Message):
    __slots__ = ("document_id", "collection_id", "user_id")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    collection_id: str
    user_id: str
    def __init__(self, document_id: str | None = ..., collection_id: str | None = ..., user_id: str | None = ...) -> None: ...
