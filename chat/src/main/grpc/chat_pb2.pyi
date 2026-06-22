from src.main.grpc import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class TutorChatRequest(_message.Message):
    __slots__ = ("prompt", "user_id", "model_name", "provider_type", "collection_id", "language", "subscription_tier", "session_namespace", "assistant_message_id", "conversation_history", "is_repeat")
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_NAME_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_TYPE_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    SUBSCRIPTION_TIER_FIELD_NUMBER: _ClassVar[int]
    SESSION_NAMESPACE_FIELD_NUMBER: _ClassVar[int]
    ASSISTANT_MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_HISTORY_FIELD_NUMBER: _ClassVar[int]
    IS_REPEAT_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    user_id: str
    model_name: str
    provider_type: str
    collection_id: str
    language: str
    subscription_tier: str
    session_namespace: str
    assistant_message_id: str
    conversation_history: _containers.RepeatedCompositeFieldContainer[ConversationMessage]
    is_repeat: bool
    def __init__(self, prompt: _Optional[str] = ..., user_id: _Optional[str] = ..., model_name: _Optional[str] = ..., provider_type: _Optional[str] = ..., collection_id: _Optional[str] = ..., language: _Optional[str] = ..., subscription_tier: _Optional[str] = ..., session_namespace: _Optional[str] = ..., assistant_message_id: _Optional[str] = ..., conversation_history: _Optional[_Iterable[_Union[ConversationMessage, _Mapping]]] = ..., is_repeat: bool = ...) -> None: ...

class GetTutorProgressRequest(_message.Message):
    __slots__ = ("user_id", "collection_id")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    collection_id: str
    def __init__(self, user_id: _Optional[str] = ..., collection_id: _Optional[str] = ...) -> None: ...

class TutorLesson(_message.Message):
    __slots__ = ("lesson_ord", "title", "summary", "level", "completed")
    LESSON_ORD_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    LEVEL_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_FIELD_NUMBER: _ClassVar[int]
    lesson_ord: int
    title: str
    summary: str
    level: int
    completed: bool
    def __init__(self, lesson_ord: _Optional[int] = ..., title: _Optional[str] = ..., summary: _Optional[str] = ..., level: _Optional[int] = ..., completed: bool = ...) -> None: ...

class TutorProgressResponse(_message.Message):
    __slots__ = ("curriculum_ready", "curriculum_status", "current_lesson_ord", "current_state", "lesson_count", "lessons", "error")
    CURRICULUM_READY_FIELD_NUMBER: _ClassVar[int]
    CURRICULUM_STATUS_FIELD_NUMBER: _ClassVar[int]
    CURRENT_LESSON_ORD_FIELD_NUMBER: _ClassVar[int]
    CURRENT_STATE_FIELD_NUMBER: _ClassVar[int]
    LESSON_COUNT_FIELD_NUMBER: _ClassVar[int]
    LESSONS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    curriculum_ready: bool
    curriculum_status: str
    current_lesson_ord: int
    current_state: str
    lesson_count: int
    lessons: _containers.RepeatedCompositeFieldContainer[TutorLesson]
    error: str
    def __init__(self, curriculum_ready: bool = ..., curriculum_status: _Optional[str] = ..., current_lesson_ord: _Optional[int] = ..., current_state: _Optional[str] = ..., lesson_count: _Optional[int] = ..., lessons: _Optional[_Iterable[_Union[TutorLesson, _Mapping]]] = ..., error: _Optional[str] = ...) -> None: ...

class DirectLLMRequest(_message.Message):
    __slots__ = ("prompt", "user_id", "model_name", "provider_type", "language", "subscription_tier", "session_namespace", "conversation_history", "is_repeat", "attachments", "tutor_mode", "thought_partner_mode")
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_NAME_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_TYPE_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    SUBSCRIPTION_TIER_FIELD_NUMBER: _ClassVar[int]
    SESSION_NAMESPACE_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_HISTORY_FIELD_NUMBER: _ClassVar[int]
    IS_REPEAT_FIELD_NUMBER: _ClassVar[int]
    ATTACHMENTS_FIELD_NUMBER: _ClassVar[int]
    TUTOR_MODE_FIELD_NUMBER: _ClassVar[int]
    THOUGHT_PARTNER_MODE_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    user_id: str
    model_name: str
    provider_type: str
    language: str
    subscription_tier: str
    session_namespace: str
    conversation_history: _containers.RepeatedCompositeFieldContainer[ConversationMessage]
    is_repeat: bool
    attachments: _containers.RepeatedCompositeFieldContainer[ChatAttachment]
    tutor_mode: bool
    thought_partner_mode: bool
    def __init__(self, prompt: _Optional[str] = ..., user_id: _Optional[str] = ..., model_name: _Optional[str] = ..., provider_type: _Optional[str] = ..., language: _Optional[str] = ..., subscription_tier: _Optional[str] = ..., session_namespace: _Optional[str] = ..., conversation_history: _Optional[_Iterable[_Union[ConversationMessage, _Mapping]]] = ..., is_repeat: bool = ..., attachments: _Optional[_Iterable[_Union[ChatAttachment, _Mapping]]] = ..., tutor_mode: bool = ..., thought_partner_mode: bool = ...) -> None: ...

class RAGRequest(_message.Message):
    __slots__ = ("prompt", "user_id", "model_name", "provider_type", "collection_ids", "document_ids", "language", "subscription_tier", "similarity_threshold", "top_k", "session_namespace", "conversation_history", "is_repeat", "attachments", "saved_search_ids", "tutor_mode")
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_NAME_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_TYPE_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_IDS_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    SUBSCRIPTION_TIER_FIELD_NUMBER: _ClassVar[int]
    SIMILARITY_THRESHOLD_FIELD_NUMBER: _ClassVar[int]
    TOP_K_FIELD_NUMBER: _ClassVar[int]
    SESSION_NAMESPACE_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_HISTORY_FIELD_NUMBER: _ClassVar[int]
    IS_REPEAT_FIELD_NUMBER: _ClassVar[int]
    ATTACHMENTS_FIELD_NUMBER: _ClassVar[int]
    SAVED_SEARCH_IDS_FIELD_NUMBER: _ClassVar[int]
    TUTOR_MODE_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    user_id: str
    model_name: str
    provider_type: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    document_ids: _containers.RepeatedScalarFieldContainer[str]
    language: str
    subscription_tier: str
    similarity_threshold: float
    top_k: int
    session_namespace: str
    conversation_history: _containers.RepeatedCompositeFieldContainer[ConversationMessage]
    is_repeat: bool
    attachments: _containers.RepeatedCompositeFieldContainer[ChatAttachment]
    saved_search_ids: _containers.RepeatedScalarFieldContainer[str]
    tutor_mode: bool
    def __init__(self, prompt: _Optional[str] = ..., user_id: _Optional[str] = ..., model_name: _Optional[str] = ..., provider_type: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ..., document_ids: _Optional[_Iterable[str]] = ..., language: _Optional[str] = ..., subscription_tier: _Optional[str] = ..., similarity_threshold: _Optional[float] = ..., top_k: _Optional[int] = ..., session_namespace: _Optional[str] = ..., conversation_history: _Optional[_Iterable[_Union[ConversationMessage, _Mapping]]] = ..., is_repeat: bool = ..., attachments: _Optional[_Iterable[_Union[ChatAttachment, _Mapping]]] = ..., saved_search_ids: _Optional[_Iterable[str]] = ..., tutor_mode: bool = ...) -> None: ...

class DeepResearchRequest(_message.Message):
    __slots__ = ("prompt", "user_id", "model_name", "provider_type", "collection_ids", "document_ids", "language", "subscription_tier", "research_breadth", "research_depth", "session_namespace", "assistant_message_id", "session_id", "conversation_history", "is_repeat", "attachments", "saved_search_ids", "metadata")
    class MetadataEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_NAME_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_TYPE_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_IDS_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    SUBSCRIPTION_TIER_FIELD_NUMBER: _ClassVar[int]
    RESEARCH_BREADTH_FIELD_NUMBER: _ClassVar[int]
    RESEARCH_DEPTH_FIELD_NUMBER: _ClassVar[int]
    SESSION_NAMESPACE_FIELD_NUMBER: _ClassVar[int]
    ASSISTANT_MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_HISTORY_FIELD_NUMBER: _ClassVar[int]
    IS_REPEAT_FIELD_NUMBER: _ClassVar[int]
    ATTACHMENTS_FIELD_NUMBER: _ClassVar[int]
    SAVED_SEARCH_IDS_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    user_id: str
    model_name: str
    provider_type: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    document_ids: _containers.RepeatedScalarFieldContainer[str]
    language: str
    subscription_tier: str
    research_breadth: int
    research_depth: int
    session_namespace: str
    assistant_message_id: str
    session_id: str
    conversation_history: _containers.RepeatedCompositeFieldContainer[ConversationMessage]
    is_repeat: bool
    attachments: _containers.RepeatedCompositeFieldContainer[ChatAttachment]
    saved_search_ids: _containers.RepeatedScalarFieldContainer[str]
    metadata: _containers.ScalarMap[str, str]
    def __init__(self, prompt: _Optional[str] = ..., user_id: _Optional[str] = ..., model_name: _Optional[str] = ..., provider_type: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ..., document_ids: _Optional[_Iterable[str]] = ..., language: _Optional[str] = ..., subscription_tier: _Optional[str] = ..., research_breadth: _Optional[int] = ..., research_depth: _Optional[int] = ..., session_namespace: _Optional[str] = ..., assistant_message_id: _Optional[str] = ..., session_id: _Optional[str] = ..., conversation_history: _Optional[_Iterable[_Union[ConversationMessage, _Mapping]]] = ..., is_repeat: bool = ..., attachments: _Optional[_Iterable[_Union[ChatAttachment, _Mapping]]] = ..., saved_search_ids: _Optional[_Iterable[str]] = ..., metadata: _Optional[_Mapping[str, str]] = ...) -> None: ...

class WebSearchRequest(_message.Message):
    __slots__ = ("prompt", "user_id", "model_name", "provider_type", "language", "subscription_tier", "session_namespace", "assistant_message_id", "conversation_history", "is_repeat", "attachments", "tutor_mode")
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_NAME_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_TYPE_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    SUBSCRIPTION_TIER_FIELD_NUMBER: _ClassVar[int]
    SESSION_NAMESPACE_FIELD_NUMBER: _ClassVar[int]
    ASSISTANT_MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_HISTORY_FIELD_NUMBER: _ClassVar[int]
    IS_REPEAT_FIELD_NUMBER: _ClassVar[int]
    ATTACHMENTS_FIELD_NUMBER: _ClassVar[int]
    TUTOR_MODE_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    user_id: str
    model_name: str
    provider_type: str
    language: str
    subscription_tier: str
    session_namespace: str
    assistant_message_id: str
    conversation_history: _containers.RepeatedCompositeFieldContainer[ConversationMessage]
    is_repeat: bool
    attachments: _containers.RepeatedCompositeFieldContainer[ChatAttachment]
    tutor_mode: bool
    def __init__(self, prompt: _Optional[str] = ..., user_id: _Optional[str] = ..., model_name: _Optional[str] = ..., provider_type: _Optional[str] = ..., language: _Optional[str] = ..., subscription_tier: _Optional[str] = ..., session_namespace: _Optional[str] = ..., assistant_message_id: _Optional[str] = ..., conversation_history: _Optional[_Iterable[_Union[ConversationMessage, _Mapping]]] = ..., is_repeat: bool = ..., attachments: _Optional[_Iterable[_Union[ChatAttachment, _Mapping]]] = ..., tutor_mode: bool = ...) -> None: ...

class AgenticRAGRequest(_message.Message):
    __slots__ = ("prompt", "user_id", "model_name", "provider_type", "workspace_id", "collection_ids", "document_ids", "language", "subscription_tier", "source_preferences", "min_confidence_threshold", "max_sources", "session_namespace", "assistant_message_id", "conversation_history", "is_repeat", "attachments", "saved_search_ids", "tutor_mode")
    class SourcePreferencesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: float
        def __init__(self, key: _Optional[str] = ..., value: _Optional[float] = ...) -> None: ...
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_NAME_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_TYPE_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_IDS_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    SUBSCRIPTION_TIER_FIELD_NUMBER: _ClassVar[int]
    SOURCE_PREFERENCES_FIELD_NUMBER: _ClassVar[int]
    MIN_CONFIDENCE_THRESHOLD_FIELD_NUMBER: _ClassVar[int]
    MAX_SOURCES_FIELD_NUMBER: _ClassVar[int]
    SESSION_NAMESPACE_FIELD_NUMBER: _ClassVar[int]
    ASSISTANT_MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_HISTORY_FIELD_NUMBER: _ClassVar[int]
    IS_REPEAT_FIELD_NUMBER: _ClassVar[int]
    ATTACHMENTS_FIELD_NUMBER: _ClassVar[int]
    SAVED_SEARCH_IDS_FIELD_NUMBER: _ClassVar[int]
    TUTOR_MODE_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    user_id: str
    model_name: str
    provider_type: str
    workspace_id: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    document_ids: _containers.RepeatedScalarFieldContainer[str]
    language: str
    subscription_tier: str
    source_preferences: _containers.ScalarMap[str, float]
    min_confidence_threshold: float
    max_sources: int
    session_namespace: str
    assistant_message_id: str
    conversation_history: _containers.RepeatedCompositeFieldContainer[ConversationMessage]
    is_repeat: bool
    attachments: _containers.RepeatedCompositeFieldContainer[ChatAttachment]
    saved_search_ids: _containers.RepeatedScalarFieldContainer[str]
    tutor_mode: bool
    def __init__(self, prompt: _Optional[str] = ..., user_id: _Optional[str] = ..., model_name: _Optional[str] = ..., provider_type: _Optional[str] = ..., workspace_id: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ..., document_ids: _Optional[_Iterable[str]] = ..., language: _Optional[str] = ..., subscription_tier: _Optional[str] = ..., source_preferences: _Optional[_Mapping[str, float]] = ..., min_confidence_threshold: _Optional[float] = ..., max_sources: _Optional[int] = ..., session_namespace: _Optional[str] = ..., assistant_message_id: _Optional[str] = ..., conversation_history: _Optional[_Iterable[_Union[ConversationMessage, _Mapping]]] = ..., is_repeat: bool = ..., attachments: _Optional[_Iterable[_Union[ChatAttachment, _Mapping]]] = ..., saved_search_ids: _Optional[_Iterable[str]] = ..., tutor_mode: bool = ...) -> None: ...

class DocumentQARequest(_message.Message):
    __slots__ = ("prompt", "user_id", "model_name", "provider_type", "document_id", "language", "subscription_tier", "session_namespace", "assistant_message_id", "attachments")
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_NAME_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_TYPE_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    SUBSCRIPTION_TIER_FIELD_NUMBER: _ClassVar[int]
    SESSION_NAMESPACE_FIELD_NUMBER: _ClassVar[int]
    ASSISTANT_MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    ATTACHMENTS_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    user_id: str
    model_name: str
    provider_type: str
    document_id: str
    language: str
    subscription_tier: str
    session_namespace: str
    assistant_message_id: str
    attachments: _containers.RepeatedCompositeFieldContainer[ChatAttachment]
    def __init__(self, prompt: _Optional[str] = ..., user_id: _Optional[str] = ..., model_name: _Optional[str] = ..., provider_type: _Optional[str] = ..., document_id: _Optional[str] = ..., language: _Optional[str] = ..., subscription_tier: _Optional[str] = ..., session_namespace: _Optional[str] = ..., assistant_message_id: _Optional[str] = ..., attachments: _Optional[_Iterable[_Union[ChatAttachment, _Mapping]]] = ...) -> None: ...

class TitleRequest(_message.Message):
    __slots__ = ("user_message", "model_name", "provider_type", "user_id", "subscription_tier", "language")
    USER_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    MODEL_NAME_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_TYPE_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    SUBSCRIPTION_TIER_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    user_message: str
    model_name: str
    provider_type: str
    user_id: str
    subscription_tier: str
    language: str
    def __init__(self, user_message: _Optional[str] = ..., model_name: _Optional[str] = ..., provider_type: _Optional[str] = ..., user_id: _Optional[str] = ..., subscription_tier: _Optional[str] = ..., language: _Optional[str] = ...) -> None: ...

class TitleResponse(_message.Message):
    __slots__ = ("title", "success", "error")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    title: str
    success: bool
    error: str
    def __init__(self, title: _Optional[str] = ..., success: bool = ..., error: _Optional[str] = ...) -> None: ...

class ChatRequest(_message.Message):
    __slots__ = ("prompt", "session_id", "user_id", "workspace_id", "collection_ids", "document_ids", "model_id", "model_name", "provider_type", "language", "web_search_enabled", "deep_research_enabled", "research_breadth", "research_depth", "user_message_id", "similarity_threshold", "top_k", "agentic_rag_enabled", "source_preferences", "min_confidence_threshold", "max_sources")
    class SourcePreferencesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: float
        def __init__(self, key: _Optional[str] = ..., value: _Optional[float] = ...) -> None: ...
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_IDS_FIELD_NUMBER: _ClassVar[int]
    MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_NAME_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_TYPE_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    WEB_SEARCH_ENABLED_FIELD_NUMBER: _ClassVar[int]
    DEEP_RESEARCH_ENABLED_FIELD_NUMBER: _ClassVar[int]
    RESEARCH_BREADTH_FIELD_NUMBER: _ClassVar[int]
    RESEARCH_DEPTH_FIELD_NUMBER: _ClassVar[int]
    USER_MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    SIMILARITY_THRESHOLD_FIELD_NUMBER: _ClassVar[int]
    TOP_K_FIELD_NUMBER: _ClassVar[int]
    AGENTIC_RAG_ENABLED_FIELD_NUMBER: _ClassVar[int]
    SOURCE_PREFERENCES_FIELD_NUMBER: _ClassVar[int]
    MIN_CONFIDENCE_THRESHOLD_FIELD_NUMBER: _ClassVar[int]
    MAX_SOURCES_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    session_id: str
    user_id: str
    workspace_id: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    document_ids: _containers.RepeatedScalarFieldContainer[str]
    model_id: str
    model_name: str
    provider_type: str
    language: str
    web_search_enabled: bool
    deep_research_enabled: bool
    research_breadth: int
    research_depth: int
    user_message_id: str
    similarity_threshold: float
    top_k: int
    agentic_rag_enabled: bool
    source_preferences: _containers.ScalarMap[str, float]
    min_confidence_threshold: float
    max_sources: int
    def __init__(self, prompt: _Optional[str] = ..., session_id: _Optional[str] = ..., user_id: _Optional[str] = ..., workspace_id: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ..., document_ids: _Optional[_Iterable[str]] = ..., model_id: _Optional[str] = ..., model_name: _Optional[str] = ..., provider_type: _Optional[str] = ..., language: _Optional[str] = ..., web_search_enabled: bool = ..., deep_research_enabled: bool = ..., research_breadth: _Optional[int] = ..., research_depth: _Optional[int] = ..., user_message_id: _Optional[str] = ..., similarity_threshold: _Optional[float] = ..., top_k: _Optional[int] = ..., agentic_rag_enabled: bool = ..., source_preferences: _Optional[_Mapping[str, float]] = ..., min_confidence_threshold: _Optional[float] = ..., max_sources: _Optional[int] = ...) -> None: ...

class ChatAttachment(_message.Message):
    __slots__ = ("type", "filename", "content", "mime_type")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    FILENAME_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    MIME_TYPE_FIELD_NUMBER: _ClassVar[int]
    type: str
    filename: str
    content: str
    mime_type: str
    def __init__(self, type: _Optional[str] = ..., filename: _Optional[str] = ..., content: _Optional[str] = ..., mime_type: _Optional[str] = ...) -> None: ...

class ConversationMessage(_message.Message):
    __slots__ = ("role", "content", "created_at_epoch")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_EPOCH_FIELD_NUMBER: _ClassVar[int]
    role: str
    content: str
    created_at_epoch: int
    def __init__(self, role: _Optional[str] = ..., content: _Optional[str] = ..., created_at_epoch: _Optional[int] = ...) -> None: ...

class ChatResponsePacket(_message.Message):
    __slots__ = ("type", "index", "data", "timestamp")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    INDEX_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_FIELD_NUMBER: _ClassVar[int]
    type: str
    index: int
    data: str
    timestamp: _common_pb2.Timestamp
    def __init__(self, type: _Optional[str] = ..., index: _Optional[int] = ..., data: _Optional[str] = ..., timestamp: _Optional[_Union[_common_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class HealthCheckResponse(_message.Message):
    __slots__ = ("healthy", "version", "status", "services")
    class ServicesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    HEALTHY_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    SERVICES_FIELD_NUMBER: _ClassVar[int]
    healthy: bool
    version: str
    status: str
    services: _containers.ScalarMap[str, str]
    def __init__(self, healthy: bool = ..., version: _Optional[str] = ..., status: _Optional[str] = ..., services: _Optional[_Mapping[str, str]] = ...) -> None: ...
