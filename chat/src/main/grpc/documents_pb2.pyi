from typing import ClassVar as _ClassVar
from typing import Optional as _Optional

from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message

DESCRIPTOR: _descriptor.FileDescriptor

class ProcessDocumentRequest(_message.Message):
    __slots__ = ("document_id", "user_id", "collection_id", "file_path")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    FILE_PATH_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    user_id: str
    collection_id: str
    file_path: str
    def __init__(
        self, document_id: str | None = ..., user_id: str | None = ..., collection_id: str | None = ..., file_path: str | None = ...
    ) -> None: ...

class ProcessPendingRequest(_message.Message):
    __slots__ = ("collection_id", "user_id", "workspace_id")
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    collection_id: str
    user_id: str
    workspace_id: str
    def __init__(self, collection_id: str | None = ..., user_id: str | None = ..., workspace_id: str | None = ...) -> None: ...

class CancelProcessingRequest(_message.Message):
    __slots__ = ("job_id", "user_id")
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    job_id: str
    user_id: str
    def __init__(self, job_id: str | None = ..., user_id: str | None = ...) -> None: ...

class CancelProcessingResponse(_message.Message):
    __slots__ = ("success", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    message: str
    def __init__(self, success: bool = ..., message: str | None = ...) -> None: ...

class ProcessingStatusRequest(_message.Message):
    __slots__ = ("job_id", "user_id")
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    job_id: str
    user_id: str
    def __init__(self, job_id: str | None = ..., user_id: str | None = ...) -> None: ...

class ProcessingStatusResponse(_message.Message):
    __slots__ = ("job_id", "status", "progress", "message", "error")
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    PROGRESS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    job_id: str
    status: str
    progress: float
    message: str
    error: str
    def __init__(
        self,
        job_id: str | None = ...,
        status: str | None = ...,
        progress: float | None = ...,
        message: str | None = ...,
        error: str | None = ...,
    ) -> None: ...

class ReprocessDocumentRequest(_message.Message):
    __slots__ = ("document_id", "user_id", "collection_id")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    user_id: str
    collection_id: str
    def __init__(self, document_id: str | None = ..., user_id: str | None = ..., collection_id: str | None = ...) -> None: ...

class CleanupEmbeddingsRequest(_message.Message):
    __slots__ = ("collection_id", "user_id")
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    collection_id: str
    user_id: str
    def __init__(self, collection_id: str | None = ..., user_id: str | None = ...) -> None: ...

class CleanupEmbeddingsResponse(_message.Message):
    __slots__ = ("success", "message", "deleted_count")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    DELETED_COUNT_FIELD_NUMBER: _ClassVar[int]
    success: bool
    message: str
    deleted_count: int
    def __init__(self, success: bool = ..., message: str | None = ..., deleted_count: int | None = ...) -> None: ...

class ProcessingStatusChunk(_message.Message):
    __slots__ = ("job_id", "status", "progress", "message", "packet_json")
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    PROGRESS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    PACKET_JSON_FIELD_NUMBER: _ClassVar[int]
    job_id: str
    status: str
    progress: float
    message: str
    packet_json: str
    def __init__(
        self,
        job_id: str | None = ...,
        status: str | None = ...,
        progress: float | None = ...,
        message: str | None = ...,
        packet_json: str | None = ...,
    ) -> None: ...
