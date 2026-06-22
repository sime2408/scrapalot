from typing import ClassVar as _ClassVar
from collections.abc import Iterable as _Iterable
from collections.abc import Mapping as _Mapping
from typing import Optional as _Optional
from typing import Union as _Union

from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from google.protobuf.internal import containers as _containers

DESCRIPTOR: _descriptor.FileDescriptor

class Timestamp(_message.Message):
    __slots__ = ("seconds", "nanos")
    SECONDS_FIELD_NUMBER: _ClassVar[int]
    NANOS_FIELD_NUMBER: _ClassVar[int]
    seconds: int
    nanos: int
    def __init__(self, seconds: int | None = ..., nanos: int | None = ...) -> None: ...

class UUID(_message.Message):
    __slots__ = ("value",)
    VALUE_FIELD_NUMBER: _ClassVar[int]
    value: str
    def __init__(self, value: str | None = ...) -> None: ...

class PageRequest(_message.Message):
    __slots__ = ("page", "size", "sort_by", "sort_direction")
    PAGE_FIELD_NUMBER: _ClassVar[int]
    SIZE_FIELD_NUMBER: _ClassVar[int]
    SORT_BY_FIELD_NUMBER: _ClassVar[int]
    SORT_DIRECTION_FIELD_NUMBER: _ClassVar[int]
    page: int
    size: int
    sort_by: str
    sort_direction: str
    def __init__(self, page: int | None = ..., size: int | None = ..., sort_by: str | None = ..., sort_direction: str | None = ...) -> None: ...

class PageResponse(_message.Message):
    __slots__ = ("total_pages", "total_elements", "current_page", "page_size", "has_next", "has_previous")
    TOTAL_PAGES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_ELEMENTS_FIELD_NUMBER: _ClassVar[int]
    CURRENT_PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    HAS_NEXT_FIELD_NUMBER: _ClassVar[int]
    HAS_PREVIOUS_FIELD_NUMBER: _ClassVar[int]
    total_pages: int
    total_elements: int
    current_page: int
    page_size: int
    has_next: bool
    has_previous: bool
    def __init__(
        self,
        total_pages: int | None = ...,
        total_elements: int | None = ...,
        current_page: int | None = ...,
        page_size: int | None = ...,
        has_next: bool = ...,
        has_previous: bool = ...,
    ) -> None: ...

class Empty(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class StatusResponse(_message.Message):
    __slots__ = ("success", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    message: str
    def __init__(self, success: bool = ..., message: str | None = ...) -> None: ...

class ErrorDetail(_message.Message):
    __slots__ = ("field", "message", "code")
    FIELD_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    CODE_FIELD_NUMBER: _ClassVar[int]
    field: str
    message: str
    code: str
    def __init__(self, field: str | None = ..., message: str | None = ..., code: str | None = ...) -> None: ...

class ErrorResponse(_message.Message):
    __slots__ = ("error", "message", "status_code", "details", "timestamp")
    ERROR_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    STATUS_CODE_FIELD_NUMBER: _ClassVar[int]
    DETAILS_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_FIELD_NUMBER: _ClassVar[int]
    error: str
    message: str
    status_code: int
    details: _containers.RepeatedCompositeFieldContainer[ErrorDetail]
    timestamp: Timestamp
    def __init__(
        self,
        error: str | None = ...,
        message: str | None = ...,
        status_code: int | None = ...,
        details: _Iterable[ErrorDetail | _Mapping] | None = ...,
        timestamp: Timestamp | _Mapping | None = ...,
    ) -> None: ...
