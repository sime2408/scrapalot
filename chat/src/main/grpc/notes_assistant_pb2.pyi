from src.main.grpc import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class CitationMetadata(_message.Message):
    __slots__ = ("title", "authors", "year", "publisher", "journal", "doi", "isbn", "url", "formatted_apa")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    AUTHORS_FIELD_NUMBER: _ClassVar[int]
    YEAR_FIELD_NUMBER: _ClassVar[int]
    PUBLISHER_FIELD_NUMBER: _ClassVar[int]
    JOURNAL_FIELD_NUMBER: _ClassVar[int]
    DOI_FIELD_NUMBER: _ClassVar[int]
    ISBN_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    FORMATTED_APA_FIELD_NUMBER: _ClassVar[int]
    title: str
    authors: _containers.RepeatedScalarFieldContainer[str]
    year: str
    publisher: str
    journal: str
    doi: str
    isbn: str
    url: str
    formatted_apa: str
    def __init__(self, title: _Optional[str] = ..., authors: _Optional[_Iterable[str]] = ..., year: _Optional[str] = ..., publisher: _Optional[str] = ..., journal: _Optional[str] = ..., doi: _Optional[str] = ..., isbn: _Optional[str] = ..., url: _Optional[str] = ..., formatted_apa: _Optional[str] = ...) -> None: ...

class ResearchResult(_message.Message):
    __slots__ = ("source_title", "snippet", "source_type", "relevance_score", "chapter", "page", "document_id", "collection_id", "url", "doi", "citation", "oa_pdf_url", "oa_status")
    SOURCE_TITLE_FIELD_NUMBER: _ClassVar[int]
    SNIPPET_FIELD_NUMBER: _ClassVar[int]
    SOURCE_TYPE_FIELD_NUMBER: _ClassVar[int]
    RELEVANCE_SCORE_FIELD_NUMBER: _ClassVar[int]
    CHAPTER_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    DOI_FIELD_NUMBER: _ClassVar[int]
    CITATION_FIELD_NUMBER: _ClassVar[int]
    OA_PDF_URL_FIELD_NUMBER: _ClassVar[int]
    OA_STATUS_FIELD_NUMBER: _ClassVar[int]
    source_title: str
    snippet: str
    source_type: str
    relevance_score: float
    chapter: str
    page: str
    document_id: str
    collection_id: str
    url: str
    doi: str
    citation: CitationMetadata
    oa_pdf_url: str
    oa_status: str
    def __init__(self, source_title: _Optional[str] = ..., snippet: _Optional[str] = ..., source_type: _Optional[str] = ..., relevance_score: _Optional[float] = ..., chapter: _Optional[str] = ..., page: _Optional[str] = ..., document_id: _Optional[str] = ..., collection_id: _Optional[str] = ..., url: _Optional[str] = ..., doi: _Optional[str] = ..., citation: _Optional[_Union[CitationMetadata, _Mapping]] = ..., oa_pdf_url: _Optional[str] = ..., oa_status: _Optional[str] = ...) -> None: ...

class EvidenceItem(_message.Message):
    __slots__ = ("snippet", "source_title", "source_type", "citation")
    SNIPPET_FIELD_NUMBER: _ClassVar[int]
    SOURCE_TITLE_FIELD_NUMBER: _ClassVar[int]
    SOURCE_TYPE_FIELD_NUMBER: _ClassVar[int]
    CITATION_FIELD_NUMBER: _ClassVar[int]
    snippet: str
    source_title: str
    source_type: str
    citation: CitationMetadata
    def __init__(self, snippet: _Optional[str] = ..., source_title: _Optional[str] = ..., source_type: _Optional[str] = ..., citation: _Optional[_Union[CitationMetadata, _Mapping]] = ...) -> None: ...

class InlineResearchRequest(_message.Message):
    __slots__ = ("query", "user_id", "collection_ids", "max_library_results", "max_web_results", "include_web")
    QUERY_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    MAX_LIBRARY_RESULTS_FIELD_NUMBER: _ClassVar[int]
    MAX_WEB_RESULTS_FIELD_NUMBER: _ClassVar[int]
    INCLUDE_WEB_FIELD_NUMBER: _ClassVar[int]
    query: str
    user_id: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    max_library_results: int
    max_web_results: int
    include_web: bool
    def __init__(self, query: _Optional[str] = ..., user_id: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ..., max_library_results: _Optional[int] = ..., max_web_results: _Optional[int] = ..., include_web: bool = ...) -> None: ...

class InlineResearchResponse(_message.Message):
    __slots__ = ("library_results", "web_results", "total_results", "search_duration_ms")
    LIBRARY_RESULTS_FIELD_NUMBER: _ClassVar[int]
    WEB_RESULTS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_RESULTS_FIELD_NUMBER: _ClassVar[int]
    SEARCH_DURATION_MS_FIELD_NUMBER: _ClassVar[int]
    library_results: _containers.RepeatedCompositeFieldContainer[ResearchResult]
    web_results: _containers.RepeatedCompositeFieldContainer[ResearchResult]
    total_results: int
    search_duration_ms: float
    def __init__(self, library_results: _Optional[_Iterable[_Union[ResearchResult, _Mapping]]] = ..., web_results: _Optional[_Iterable[_Union[ResearchResult, _Mapping]]] = ..., total_results: _Optional[int] = ..., search_duration_ms: _Optional[float] = ...) -> None: ...

class FindCitationRequest(_message.Message):
    __slots__ = ("claim_text", "user_id", "collection_ids", "search_crossref", "max_results", "disable_openalex", "disable_semantic_scholar", "disable_oa_enrichment")
    CLAIM_TEXT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    SEARCH_CROSSREF_FIELD_NUMBER: _ClassVar[int]
    MAX_RESULTS_FIELD_NUMBER: _ClassVar[int]
    DISABLE_OPENALEX_FIELD_NUMBER: _ClassVar[int]
    DISABLE_SEMANTIC_SCHOLAR_FIELD_NUMBER: _ClassVar[int]
    DISABLE_OA_ENRICHMENT_FIELD_NUMBER: _ClassVar[int]
    claim_text: str
    user_id: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    search_crossref: bool
    max_results: int
    disable_openalex: bool
    disable_semantic_scholar: bool
    disable_oa_enrichment: bool
    def __init__(self, claim_text: _Optional[str] = ..., user_id: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ..., search_crossref: bool = ..., max_results: _Optional[int] = ..., disable_openalex: bool = ..., disable_semantic_scholar: bool = ..., disable_oa_enrichment: bool = ...) -> None: ...

class FindCitationResponse(_message.Message):
    __slots__ = ("library_citations", "academic_citations")
    LIBRARY_CITATIONS_FIELD_NUMBER: _ClassVar[int]
    ACADEMIC_CITATIONS_FIELD_NUMBER: _ClassVar[int]
    library_citations: _containers.RepeatedCompositeFieldContainer[ResearchResult]
    academic_citations: _containers.RepeatedCompositeFieldContainer[ResearchResult]
    def __init__(self, library_citations: _Optional[_Iterable[_Union[ResearchResult, _Mapping]]] = ..., academic_citations: _Optional[_Iterable[_Union[ResearchResult, _Mapping]]] = ...) -> None: ...

class TransformTextRequest(_message.Message):
    __slots__ = ("text", "user_id", "transform_type", "surrounding_context", "collection_ids", "locale")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    TRANSFORM_TYPE_FIELD_NUMBER: _ClassVar[int]
    SURROUNDING_CONTEXT_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    LOCALE_FIELD_NUMBER: _ClassVar[int]
    text: str
    user_id: str
    transform_type: str
    surrounding_context: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    locale: str
    def __init__(self, text: _Optional[str] = ..., user_id: _Optional[str] = ..., transform_type: _Optional[str] = ..., surrounding_context: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ..., locale: _Optional[str] = ...) -> None: ...

class TransformTextResponse(_message.Message):
    __slots__ = ("original_text", "transformed_text", "transform_type")
    ORIGINAL_TEXT_FIELD_NUMBER: _ClassVar[int]
    TRANSFORMED_TEXT_FIELD_NUMBER: _ClassVar[int]
    TRANSFORM_TYPE_FIELD_NUMBER: _ClassVar[int]
    original_text: str
    transformed_text: str
    transform_type: str
    def __init__(self, original_text: _Optional[str] = ..., transformed_text: _Optional[str] = ..., transform_type: _Optional[str] = ...) -> None: ...

class VerifyClaimRequest(_message.Message):
    __slots__ = ("claim_text", "user_id", "collection_ids", "include_web", "locale")
    CLAIM_TEXT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    INCLUDE_WEB_FIELD_NUMBER: _ClassVar[int]
    LOCALE_FIELD_NUMBER: _ClassVar[int]
    claim_text: str
    user_id: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    include_web: bool
    locale: str
    def __init__(self, claim_text: _Optional[str] = ..., user_id: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ..., include_web: bool = ..., locale: _Optional[str] = ...) -> None: ...

class VerifyClaimResponse(_message.Message):
    __slots__ = ("verdict", "confidence", "supporting_evidence", "contradicting_evidence", "suggestion", "evidence_quality", "bias_flags", "fallacy_warnings")
    VERDICT_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    SUPPORTING_EVIDENCE_FIELD_NUMBER: _ClassVar[int]
    CONTRADICTING_EVIDENCE_FIELD_NUMBER: _ClassVar[int]
    SUGGESTION_FIELD_NUMBER: _ClassVar[int]
    EVIDENCE_QUALITY_FIELD_NUMBER: _ClassVar[int]
    BIAS_FLAGS_FIELD_NUMBER: _ClassVar[int]
    FALLACY_WARNINGS_FIELD_NUMBER: _ClassVar[int]
    verdict: str
    confidence: str
    supporting_evidence: _containers.RepeatedCompositeFieldContainer[EvidenceItem]
    contradicting_evidence: _containers.RepeatedCompositeFieldContainer[EvidenceItem]
    suggestion: str
    evidence_quality: EvidenceQuality
    bias_flags: _containers.RepeatedCompositeFieldContainer[BiasFlag]
    fallacy_warnings: _containers.RepeatedCompositeFieldContainer[FallacyWarning]
    def __init__(self, verdict: _Optional[str] = ..., confidence: _Optional[str] = ..., supporting_evidence: _Optional[_Iterable[_Union[EvidenceItem, _Mapping]]] = ..., contradicting_evidence: _Optional[_Iterable[_Union[EvidenceItem, _Mapping]]] = ..., suggestion: _Optional[str] = ..., evidence_quality: _Optional[_Union[EvidenceQuality, _Mapping]] = ..., bias_flags: _Optional[_Iterable[_Union[BiasFlag, _Mapping]]] = ..., fallacy_warnings: _Optional[_Iterable[_Union[FallacyWarning, _Mapping]]] = ...) -> None: ...

class EvidenceQuality(_message.Message):
    __slots__ = ("grade", "rationale", "downgrades", "upgrades")
    GRADE_FIELD_NUMBER: _ClassVar[int]
    RATIONALE_FIELD_NUMBER: _ClassVar[int]
    DOWNGRADES_FIELD_NUMBER: _ClassVar[int]
    UPGRADES_FIELD_NUMBER: _ClassVar[int]
    grade: str
    rationale: str
    downgrades: _containers.RepeatedScalarFieldContainer[str]
    upgrades: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, grade: _Optional[str] = ..., rationale: _Optional[str] = ..., downgrades: _Optional[_Iterable[str]] = ..., upgrades: _Optional[_Iterable[str]] = ...) -> None: ...

class BiasFlag(_message.Message):
    __slots__ = ("category", "name", "description")
    CATEGORY_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    category: str
    name: str
    description: str
    def __init__(self, category: _Optional[str] = ..., name: _Optional[str] = ..., description: _Optional[str] = ...) -> None: ...

class FallacyWarning(_message.Message):
    __slots__ = ("category", "name", "description")
    CATEGORY_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    category: str
    name: str
    description: str
    def __init__(self, category: _Optional[str] = ..., name: _Optional[str] = ..., description: _Optional[str] = ...) -> None: ...

class TranslateTextRequest(_message.Message):
    __slots__ = ("text", "user_id", "target_language")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    TARGET_LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    text: str
    user_id: str
    target_language: str
    def __init__(self, text: _Optional[str] = ..., user_id: _Optional[str] = ..., target_language: _Optional[str] = ...) -> None: ...

class TranslateTextResponse(_message.Message):
    __slots__ = ("original_text", "translated_text", "source_language", "target_language")
    ORIGINAL_TEXT_FIELD_NUMBER: _ClassVar[int]
    TRANSLATED_TEXT_FIELD_NUMBER: _ClassVar[int]
    SOURCE_LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    TARGET_LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    original_text: str
    translated_text: str
    source_language: str
    target_language: str
    def __init__(self, original_text: _Optional[str] = ..., translated_text: _Optional[str] = ..., source_language: _Optional[str] = ..., target_language: _Optional[str] = ...) -> None: ...

class GenerateHypothesisRequest(_message.Message):
    __slots__ = ("context", "user_id", "collection_ids", "locale")
    CONTEXT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    LOCALE_FIELD_NUMBER: _ClassVar[int]
    context: str
    user_id: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    locale: str
    def __init__(self, context: _Optional[str] = ..., user_id: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ..., locale: _Optional[str] = ...) -> None: ...

class GenerateHypothesisResponse(_message.Message):
    __slots__ = ("hypothesis", "rationale", "experimental_design", "competing_hypotheses_json", "research_question", "recommendation")
    HYPOTHESIS_FIELD_NUMBER: _ClassVar[int]
    RATIONALE_FIELD_NUMBER: _ClassVar[int]
    EXPERIMENTAL_DESIGN_FIELD_NUMBER: _ClassVar[int]
    COMPETING_HYPOTHESES_JSON_FIELD_NUMBER: _ClassVar[int]
    RESEARCH_QUESTION_FIELD_NUMBER: _ClassVar[int]
    RECOMMENDATION_FIELD_NUMBER: _ClassVar[int]
    hypothesis: str
    rationale: str
    experimental_design: str
    competing_hypotheses_json: str
    research_question: str
    recommendation: str
    def __init__(self, hypothesis: _Optional[str] = ..., rationale: _Optional[str] = ..., experimental_design: _Optional[str] = ..., competing_hypotheses_json: _Optional[str] = ..., research_question: _Optional[str] = ..., recommendation: _Optional[str] = ...) -> None: ...

class GenerateOutlineRequest(_message.Message):
    __slots__ = ("notes_content", "user_id", "collection_ids", "locale", "template_type")
    NOTES_CONTENT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    LOCALE_FIELD_NUMBER: _ClassVar[int]
    TEMPLATE_TYPE_FIELD_NUMBER: _ClassVar[int]
    notes_content: str
    user_id: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    locale: str
    template_type: str
    def __init__(self, notes_content: _Optional[str] = ..., user_id: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ..., locale: _Optional[str] = ..., template_type: _Optional[str] = ...) -> None: ...

class GenerateOutlineResponse(_message.Message):
    __slots__ = ("sections", "formatted_outline")
    SECTIONS_FIELD_NUMBER: _ClassVar[int]
    FORMATTED_OUTLINE_FIELD_NUMBER: _ClassVar[int]
    sections: _containers.RepeatedCompositeFieldContainer[OutlineSection]
    formatted_outline: str
    def __init__(self, sections: _Optional[_Iterable[_Union[OutlineSection, _Mapping]]] = ..., formatted_outline: _Optional[str] = ...) -> None: ...

class OutlineSection(_message.Message):
    __slots__ = ("title", "description", "level", "covered_in_notes", "source_count")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    LEVEL_FIELD_NUMBER: _ClassVar[int]
    COVERED_IN_NOTES_FIELD_NUMBER: _ClassVar[int]
    SOURCE_COUNT_FIELD_NUMBER: _ClassVar[int]
    title: str
    description: str
    level: int
    covered_in_notes: bool
    source_count: int
    def __init__(self, title: _Optional[str] = ..., description: _Optional[str] = ..., level: _Optional[int] = ..., covered_in_notes: bool = ..., source_count: _Optional[int] = ...) -> None: ...

class ReviewDocumentRequest(_message.Message):
    __slots__ = ("content", "user_id", "source_type", "source_title", "locale")
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_TYPE_FIELD_NUMBER: _ClassVar[int]
    SOURCE_TITLE_FIELD_NUMBER: _ClassVar[int]
    LOCALE_FIELD_NUMBER: _ClassVar[int]
    content: str
    user_id: str
    source_type: str
    source_title: str
    locale: str
    def __init__(self, content: _Optional[str] = ..., user_id: _Optional[str] = ..., source_type: _Optional[str] = ..., source_title: _Optional[str] = ..., locale: _Optional[str] = ...) -> None: ...

class ReviewDocumentResponse(_message.Message):
    __slots__ = ("verdict", "score", "summary", "overall_strengths", "overall_weaknesses", "stages", "questions_for_authors", "latency_ms", "claim_verifications")
    VERDICT_FIELD_NUMBER: _ClassVar[int]
    SCORE_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    OVERALL_STRENGTHS_FIELD_NUMBER: _ClassVar[int]
    OVERALL_WEAKNESSES_FIELD_NUMBER: _ClassVar[int]
    STAGES_FIELD_NUMBER: _ClassVar[int]
    QUESTIONS_FOR_AUTHORS_FIELD_NUMBER: _ClassVar[int]
    LATENCY_MS_FIELD_NUMBER: _ClassVar[int]
    CLAIM_VERIFICATIONS_FIELD_NUMBER: _ClassVar[int]
    verdict: str
    score: int
    summary: str
    overall_strengths: _containers.RepeatedScalarFieldContainer[str]
    overall_weaknesses: _containers.RepeatedScalarFieldContainer[str]
    stages: _containers.RepeatedCompositeFieldContainer[ReviewStage]
    questions_for_authors: _containers.RepeatedScalarFieldContainer[str]
    latency_ms: int
    claim_verifications: _containers.RepeatedCompositeFieldContainer[ClaimVerification]
    def __init__(self, verdict: _Optional[str] = ..., score: _Optional[int] = ..., summary: _Optional[str] = ..., overall_strengths: _Optional[_Iterable[str]] = ..., overall_weaknesses: _Optional[_Iterable[str]] = ..., stages: _Optional[_Iterable[_Union[ReviewStage, _Mapping]]] = ..., questions_for_authors: _Optional[_Iterable[str]] = ..., latency_ms: _Optional[int] = ..., claim_verifications: _Optional[_Iterable[_Union[ClaimVerification, _Mapping]]] = ...) -> None: ...

class ReviewStage(_message.Message):
    __slots__ = ("stage_number", "stage_name", "health", "summary", "comments", "stage_score")
    STAGE_NUMBER_FIELD_NUMBER: _ClassVar[int]
    STAGE_NAME_FIELD_NUMBER: _ClassVar[int]
    HEALTH_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    COMMENTS_FIELD_NUMBER: _ClassVar[int]
    STAGE_SCORE_FIELD_NUMBER: _ClassVar[int]
    stage_number: int
    stage_name: str
    health: str
    summary: str
    comments: _containers.RepeatedCompositeFieldContainer[ReviewComment]
    stage_score: int
    def __init__(self, stage_number: _Optional[int] = ..., stage_name: _Optional[str] = ..., health: _Optional[str] = ..., summary: _Optional[str] = ..., comments: _Optional[_Iterable[_Union[ReviewComment, _Mapping]]] = ..., stage_score: _Optional[int] = ...) -> None: ...

class ReviewComment(_message.Message):
    __slots__ = ("severity", "section_ref", "issue", "suggestion")
    SEVERITY_FIELD_NUMBER: _ClassVar[int]
    SECTION_REF_FIELD_NUMBER: _ClassVar[int]
    ISSUE_FIELD_NUMBER: _ClassVar[int]
    SUGGESTION_FIELD_NUMBER: _ClassVar[int]
    severity: str
    section_ref: str
    issue: str
    suggestion: str
    def __init__(self, severity: _Optional[str] = ..., section_ref: _Optional[str] = ..., issue: _Optional[str] = ..., suggestion: _Optional[str] = ...) -> None: ...

class ClaimVerification(_message.Message):
    __slots__ = ("claim_text", "verdict", "confidence", "evidence_quality", "section_ref")
    CLAIM_TEXT_FIELD_NUMBER: _ClassVar[int]
    VERDICT_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    EVIDENCE_QUALITY_FIELD_NUMBER: _ClassVar[int]
    SECTION_REF_FIELD_NUMBER: _ClassVar[int]
    claim_text: str
    verdict: str
    confidence: str
    evidence_quality: EvidenceQuality
    section_ref: str
    def __init__(self, claim_text: _Optional[str] = ..., verdict: _Optional[str] = ..., confidence: _Optional[str] = ..., evidence_quality: _Optional[_Union[EvidenceQuality, _Mapping]] = ..., section_ref: _Optional[str] = ...) -> None: ...

class ConnectDotsRequest(_message.Message):
    __slots__ = ("user_id", "note_text", "exclude_collection_ids", "top_k")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    NOTE_TEXT_FIELD_NUMBER: _ClassVar[int]
    EXCLUDE_COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    TOP_K_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    note_text: str
    exclude_collection_ids: _containers.RepeatedScalarFieldContainer[str]
    top_k: int
    def __init__(self, user_id: _Optional[str] = ..., note_text: _Optional[str] = ..., exclude_collection_ids: _Optional[_Iterable[str]] = ..., top_k: _Optional[int] = ...) -> None: ...

class CollectionCoverage(_message.Message):
    __slots__ = ("collection_id", "collection_name", "chunk_count", "book_count")
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_NAME_FIELD_NUMBER: _ClassVar[int]
    CHUNK_COUNT_FIELD_NUMBER: _ClassVar[int]
    BOOK_COUNT_FIELD_NUMBER: _ClassVar[int]
    collection_id: str
    collection_name: str
    chunk_count: int
    book_count: int
    def __init__(self, collection_id: _Optional[str] = ..., collection_name: _Optional[str] = ..., chunk_count: _Optional[int] = ..., book_count: _Optional[int] = ...) -> None: ...

class BridgingConcept(_message.Message):
    __slots__ = ("entity", "total_chunks", "total_books", "collections")
    ENTITY_FIELD_NUMBER: _ClassVar[int]
    TOTAL_CHUNKS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_BOOKS_FIELD_NUMBER: _ClassVar[int]
    COLLECTIONS_FIELD_NUMBER: _ClassVar[int]
    entity: str
    total_chunks: int
    total_books: int
    collections: _containers.RepeatedCompositeFieldContainer[CollectionCoverage]
    def __init__(self, entity: _Optional[str] = ..., total_chunks: _Optional[int] = ..., total_books: _Optional[int] = ..., collections: _Optional[_Iterable[_Union[CollectionCoverage, _Mapping]]] = ...) -> None: ...

class ConnectDotsResponse(_message.Message):
    __slots__ = ("success", "entities_extracted", "bridging_concepts", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ENTITIES_EXTRACTED_FIELD_NUMBER: _ClassVar[int]
    BRIDGING_CONCEPTS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    entities_extracted: int
    bridging_concepts: _containers.RepeatedCompositeFieldContainer[BridgingConcept]
    message: str
    def __init__(self, success: bool = ..., entities_extracted: _Optional[int] = ..., bridging_concepts: _Optional[_Iterable[_Union[BridgingConcept, _Mapping]]] = ..., message: _Optional[str] = ...) -> None: ...

class FactCheckWholeNoteRequest(_message.Message):
    __slots__ = ("user_id", "note_text", "collection_ids", "include_web", "locale")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    NOTE_TEXT_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    INCLUDE_WEB_FIELD_NUMBER: _ClassVar[int]
    LOCALE_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    note_text: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    include_web: bool
    locale: str
    def __init__(self, user_id: _Optional[str] = ..., note_text: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ..., include_web: bool = ..., locale: _Optional[str] = ...) -> None: ...

class ClaimCheck(_message.Message):
    __slots__ = ("sentence_index", "sentence", "verdict", "confidence", "suggestion", "evidence_quality", "bias_flags", "fallacy_warnings", "char_offset", "char_length")
    SENTENCE_INDEX_FIELD_NUMBER: _ClassVar[int]
    SENTENCE_FIELD_NUMBER: _ClassVar[int]
    VERDICT_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    SUGGESTION_FIELD_NUMBER: _ClassVar[int]
    EVIDENCE_QUALITY_FIELD_NUMBER: _ClassVar[int]
    BIAS_FLAGS_FIELD_NUMBER: _ClassVar[int]
    FALLACY_WARNINGS_FIELD_NUMBER: _ClassVar[int]
    CHAR_OFFSET_FIELD_NUMBER: _ClassVar[int]
    CHAR_LENGTH_FIELD_NUMBER: _ClassVar[int]
    sentence_index: int
    sentence: str
    verdict: str
    confidence: str
    suggestion: str
    evidence_quality: EvidenceQuality
    bias_flags: _containers.RepeatedCompositeFieldContainer[BiasFlag]
    fallacy_warnings: _containers.RepeatedCompositeFieldContainer[FallacyWarning]
    char_offset: int
    char_length: int
    def __init__(self, sentence_index: _Optional[int] = ..., sentence: _Optional[str] = ..., verdict: _Optional[str] = ..., confidence: _Optional[str] = ..., suggestion: _Optional[str] = ..., evidence_quality: _Optional[_Union[EvidenceQuality, _Mapping]] = ..., bias_flags: _Optional[_Iterable[_Union[BiasFlag, _Mapping]]] = ..., fallacy_warnings: _Optional[_Iterable[_Union[FallacyWarning, _Mapping]]] = ..., char_offset: _Optional[int] = ..., char_length: _Optional[int] = ...) -> None: ...

class FactCheckWholeNoteResponse(_message.Message):
    __slots__ = ("success", "total_sentences", "candidates_classified", "claims_verified", "checks", "message")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_SENTENCES_FIELD_NUMBER: _ClassVar[int]
    CANDIDATES_CLASSIFIED_FIELD_NUMBER: _ClassVar[int]
    CLAIMS_VERIFIED_FIELD_NUMBER: _ClassVar[int]
    CHECKS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    success: bool
    total_sentences: int
    candidates_classified: int
    claims_verified: int
    checks: _containers.RepeatedCompositeFieldContainer[ClaimCheck]
    message: str
    def __init__(self, success: bool = ..., total_sentences: _Optional[int] = ..., candidates_classified: _Optional[int] = ..., claims_verified: _Optional[int] = ..., checks: _Optional[_Iterable[_Union[ClaimCheck, _Mapping]]] = ..., message: _Optional[str] = ...) -> None: ...

class ScenarioAnalysisRequest(_message.Message):
    __slots__ = ("context", "user_id", "collection_ids", "locale")
    CONTEXT_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    LOCALE_FIELD_NUMBER: _ClassVar[int]
    context: str
    user_id: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    locale: str
    def __init__(self, context: _Optional[str] = ..., user_id: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ..., locale: _Optional[str] = ...) -> None: ...

class ScenarioBranch(_message.Message):
    __slots__ = ("branch_type", "title", "probability", "confidence", "timeframe", "narrative", "trigger_conditions", "consequences")
    BRANCH_TYPE_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    PROBABILITY_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    TIMEFRAME_FIELD_NUMBER: _ClassVar[int]
    NARRATIVE_FIELD_NUMBER: _ClassVar[int]
    TRIGGER_CONDITIONS_FIELD_NUMBER: _ClassVar[int]
    CONSEQUENCES_FIELD_NUMBER: _ClassVar[int]
    branch_type: str
    title: str
    probability: float
    confidence: float
    timeframe: str
    narrative: str
    trigger_conditions: _containers.RepeatedScalarFieldContainer[str]
    consequences: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, branch_type: _Optional[str] = ..., title: _Optional[str] = ..., probability: _Optional[float] = ..., confidence: _Optional[float] = ..., timeframe: _Optional[str] = ..., narrative: _Optional[str] = ..., trigger_conditions: _Optional[_Iterable[str]] = ..., consequences: _Optional[_Iterable[str]] = ...) -> None: ...

class ScenarioSynthesis(_message.Message):
    __slots__ = ("robust_actions", "hedge_actions", "decision_triggers", "one_percent_insight")
    ROBUST_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    HEDGE_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    DECISION_TRIGGERS_FIELD_NUMBER: _ClassVar[int]
    ONE_PERCENT_INSIGHT_FIELD_NUMBER: _ClassVar[int]
    robust_actions: _containers.RepeatedScalarFieldContainer[str]
    hedge_actions: _containers.RepeatedScalarFieldContainer[str]
    decision_triggers: _containers.RepeatedScalarFieldContainer[str]
    one_percent_insight: str
    def __init__(self, robust_actions: _Optional[_Iterable[str]] = ..., hedge_actions: _Optional[_Iterable[str]] = ..., decision_triggers: _Optional[_Iterable[str]] = ..., one_percent_insight: _Optional[str] = ...) -> None: ...

class ScenarioAnalysisResponse(_message.Message):
    __slots__ = ("scenario_question", "branches", "synthesis", "error")
    SCENARIO_QUESTION_FIELD_NUMBER: _ClassVar[int]
    BRANCHES_FIELD_NUMBER: _ClassVar[int]
    SYNTHESIS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    scenario_question: str
    branches: _containers.RepeatedCompositeFieldContainer[ScenarioBranch]
    synthesis: ScenarioSynthesis
    error: str
    def __init__(self, scenario_question: _Optional[str] = ..., branches: _Optional[_Iterable[_Union[ScenarioBranch, _Mapping]]] = ..., synthesis: _Optional[_Union[ScenarioSynthesis, _Mapping]] = ..., error: _Optional[str] = ...) -> None: ...

class CritiqueWithQuestionsRequest(_message.Message):
    __slots__ = ("user_id", "note_text", "language")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    NOTE_TEXT_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    note_text: str
    language: str
    def __init__(self, user_id: _Optional[str] = ..., note_text: _Optional[str] = ..., language: _Optional[str] = ...) -> None: ...

class CritiqueWithQuestionsResponse(_message.Message):
    __slots__ = ("success", "formatted_questions", "questions", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    FORMATTED_QUESTIONS_FIELD_NUMBER: _ClassVar[int]
    QUESTIONS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    formatted_questions: str
    questions: _containers.RepeatedScalarFieldContainer[str]
    error: str
    def __init__(self, success: bool = ..., formatted_questions: _Optional[str] = ..., questions: _Optional[_Iterable[str]] = ..., error: _Optional[str] = ...) -> None: ...

class GhostCompleteNoteRequest(_message.Message):
    __slots__ = ("user_id", "text_before_cursor", "text_after_cursor", "note_outline", "language")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_BEFORE_CURSOR_FIELD_NUMBER: _ClassVar[int]
    TEXT_AFTER_CURSOR_FIELD_NUMBER: _ClassVar[int]
    NOTE_OUTLINE_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    text_before_cursor: str
    text_after_cursor: str
    note_outline: str
    language: str
    def __init__(self, user_id: _Optional[str] = ..., text_before_cursor: _Optional[str] = ..., text_after_cursor: _Optional[str] = ..., note_outline: _Optional[str] = ..., language: _Optional[str] = ...) -> None: ...

class GhostCompleteNoteResponse(_message.Message):
    __slots__ = ("success", "suggestion", "error", "quota_used", "quota_limit")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    SUGGESTION_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    QUOTA_USED_FIELD_NUMBER: _ClassVar[int]
    QUOTA_LIMIT_FIELD_NUMBER: _ClassVar[int]
    success: bool
    suggestion: str
    error: str
    quota_used: int
    quota_limit: int
    def __init__(self, success: bool = ..., suggestion: _Optional[str] = ..., error: _Optional[str] = ..., quota_used: _Optional[int] = ..., quota_limit: _Optional[int] = ...) -> None: ...

class ComposeFromSourcesRequest(_message.Message):
    __slots__ = ("user_id", "topic_or_section", "collection_ids", "target_length", "language", "outline_section_anchor", "text_before_cursor", "text_after_cursor")
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    TOPIC_OR_SECTION_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_IDS_FIELD_NUMBER: _ClassVar[int]
    TARGET_LENGTH_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    OUTLINE_SECTION_ANCHOR_FIELD_NUMBER: _ClassVar[int]
    TEXT_BEFORE_CURSOR_FIELD_NUMBER: _ClassVar[int]
    TEXT_AFTER_CURSOR_FIELD_NUMBER: _ClassVar[int]
    user_id: str
    topic_or_section: str
    collection_ids: _containers.RepeatedScalarFieldContainer[str]
    target_length: str
    language: str
    outline_section_anchor: str
    text_before_cursor: str
    text_after_cursor: str
    def __init__(self, user_id: _Optional[str] = ..., topic_or_section: _Optional[str] = ..., collection_ids: _Optional[_Iterable[str]] = ..., target_length: _Optional[str] = ..., language: _Optional[str] = ..., outline_section_anchor: _Optional[str] = ..., text_before_cursor: _Optional[str] = ..., text_after_cursor: _Optional[str] = ...) -> None: ...

class ComposedSource(_message.Message):
    __slots__ = ("source_number", "document_id", "collection_id", "source_title", "chunk_text", "chapter", "page", "citation")
    SOURCE_NUMBER_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    COLLECTION_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_TITLE_FIELD_NUMBER: _ClassVar[int]
    CHUNK_TEXT_FIELD_NUMBER: _ClassVar[int]
    CHAPTER_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    CITATION_FIELD_NUMBER: _ClassVar[int]
    source_number: int
    document_id: str
    collection_id: str
    source_title: str
    chunk_text: str
    chapter: str
    page: str
    citation: CitationMetadata
    def __init__(self, source_number: _Optional[int] = ..., document_id: _Optional[str] = ..., collection_id: _Optional[str] = ..., source_title: _Optional[str] = ..., chunk_text: _Optional[str] = ..., chapter: _Optional[str] = ..., page: _Optional[str] = ..., citation: _Optional[_Union[CitationMetadata, _Mapping]] = ...) -> None: ...

class ComposeFromSourcesResponse(_message.Message):
    __slots__ = ("success", "composed_text", "sources", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    COMPOSED_TEXT_FIELD_NUMBER: _ClassVar[int]
    SOURCES_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    composed_text: str
    sources: _containers.RepeatedCompositeFieldContainer[ComposedSource]
    error: str
    def __init__(self, success: bool = ..., composed_text: _Optional[str] = ..., sources: _Optional[_Iterable[_Union[ComposedSource, _Mapping]]] = ..., error: _Optional[str] = ...) -> None: ...
