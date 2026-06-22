"""
Streaming packet types for chat responses.
"""

from datetime import UTC, datetime
from typing import Any, Literal, Union, cast

from pydantic import BaseModel, ConfigDict, Field


class BasePacket(BaseModel):
    """Base class for all streaming packets"""

    type: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))


# ============================================================================
# MESSAGE PACKETS - Core chat content
# ============================================================================


class MessageStartPacket(BasePacket):
    """Signals the start of an assistant message"""

    type: Literal["message_start"] = "message_start"
    content: str = ""
    documents: list[dict] | None = None  # Retrieved documents
    model_info: dict | None = None  # Model name, provider


class MessageDeltaPacket(BasePacket):
    """Incremental message content chunk"""

    type: Literal["message_delta"] = "message_delta"
    content: str


# ============================================================================
# REASONING PACKETS - Thinking process visibility
# ============================================================================


class ReasoningStartPacket(BasePacket):
    """Signals the start of a reasoning section"""

    type: Literal["reasoning_start"] = "reasoning_start"


class ReasoningDeltaPacket(BasePacket):
    """Incremental reasoning content (e.g., <think> tags)"""

    type: Literal["reasoning_delta"] = "reasoning_delta"
    reasoning: str


# ============================================================================
# MODEL INSIGHT PACKETS - The LLM's own-knowledge reflection on retrieved sources
# ============================================================================


class ModelInsightStartPacket(BasePacket):
    """Signals the start of the model-knowledge insight block, rendered below the
    sourced answer as a distinct '💡 model insight' section."""

    type: Literal["model_insight_start"] = "model_insight_start"


class ModelInsightDeltaPacket(BasePacket):
    """Incremental model-knowledge insight content."""

    type: Literal["model_insight_delta"] = "model_insight_delta"
    content: str


# ============================================================================
# CITATION PACKETS - Source attribution
# ============================================================================


class CitationStartPacket(BasePacket):
    """Signals the start of citation information"""

    type: Literal["citation_start"] = "citation_start"


class CitationInfoPacket(BasePacket):
    """Individual citation information"""

    type: Literal["citation_info"] = "citation_info"
    citation_num: int
    document_id: str
    document_title: str
    page: int | None = None
    url: str | None = None
    score: float | None = None
    text: str | None = None
    chunk_index: int | None = None
    file_type: str | None = None  # "pdf", "epub", "docx"
    authors: list[str] | None = None
    year: int | None = None
    formatted_citation: str | None = None  # APA-formatted citation string
    # Smart Citations (Scite integration) — optional, populated post-synthesis
    stance: Literal["supporting", "contrasting", "mentioning"] | None = None
    stance_confidence: float | None = None  # 0.0 - 1.0
    stance_rationale: str | None = None  # Short LLM rationale for the classification
    # Short sentence-bounded excerpt (≤280 chars) of the cited passage,
    # intended for the blockquote under the citation card. `text` is the
    # longer chunk preview (up to 800 chars); this field is the trimmed-down
    # version so the UI renders a clean quote without re-truncating.
    citation_context: str | None = None
    # Bridge-mode metadata — populated when the citation originates
    # from a cross-domain bridge chunk. UI uses these to render a dedicated
    # "Bridge Concepts" panel below the assistant reply.
    is_bridge: bool = False
    source_collection_id: str | None = None
    bridge_anchors: list[str] | None = None
    # Position payload propagated from chunk metadata. The PDF viewer uses
    # `page` to scroll, then text-searches `chunk_text` inside the page to
    # draw a transient highlight. `bbox` is the page-level union (best
    # effort) so the viewer can clamp the search to roughly the right
    # region. None when the chunk is from a non-PDF source or pre-dates
    # position propagation.
    chunk_position_json: dict | None = None


class StrategyTransparencyPacket(BasePacket):
    """Transparency packet: sub-queries and filters the agent actually ran.

    Emitted once, early in the stream, so the UI can render a collapsible
    "Search Strategy" panel that shows how the answer was constructed.
    Academic users use this for methodological defensibility when quoting
    answers in systematic reviews.

    Name `strategy_transparency` is intentionally distinct from the existing
    deep-research `search_strategy` packet (enhanced search) which
    carries different fields (total_queries / providers_allocated).
    """

    type: Literal["strategy_transparency"] = "strategy_transparency"
    sub_queries: list[str] = []
    filters_applied: dict[str, str] = {}
    sources_queried: list[str] = []  # e.g. ["documents", "web", "academic"]
    strategy_name: str | None = None  # the router's chosen APPROACH (intent), not the executor
    rationale: str | None = None
    # WHO actually ran retrieval. In the agentic path the named strategy is a
    # routing-intent label — the unified tool-agent (dense_search/grep/cat) does the
    # real work, the strategy's execute() is not invoked. Make that explicit so the
    # panel doesn't imply the strategy class itself executed.
    executor: str | None = None  # stable token, e.g. "agentic_tool_agent"


class CitationDeltaPacket(BasePacket):
    """Batch of citations"""

    type: Literal["citation_delta"] = "citation_delta"
    citations: list[dict]  # List of citation objects


class GraphExpansionPacket(BasePacket):
    """
    Observability — emitted by entity-expanded retrieval once per
    query. Surfaces the adaptive expansion policy's decisions so an engineer
    can answer "why did THIS chunk get pulled in?" without reading service
    logs.

    Consumed by the admin RAG Tracing dashboard (new tab).
    """

    type: Literal["graph_expansion"] = "graph_expansion"
    # Query type the policy used to pick hop depth + IDF threshold.
    query_type: str | None = None
    # Hop depth actually applied (0 = expansion skipped).
    hop_depth: int = 0
    # IDF percentile threshold that gated anchor selection.
    idf_percentile_threshold: float | None = None
    idf_value_threshold: float | None = None
    # Entities the policy accepted as anchors (canonical_name + IDF, top 10).
    anchors_used: list[dict] = []
    # Number of entities rejected because their IDF was below threshold.
    anchors_rejected_by_rarity: int = 0
    # Chunks the expansion pulled in and accepted into the final fusion.
    chunks_added: int = 0
    # Chunks the expansion produced but the budget cap discarded.
    chunks_rejected_by_budget: int = 0
    # Documents rejected because they shared too few rare anchors with the
    # pgvector-seed set.
    docs_rejected_by_related_gate: int = 0
    # Total budget ceiling applied (absolute chunk count).
    expansion_budget: int = 0


# ============================================================================
# STATUS & CONTROL PACKETS
# ============================================================================


class StatusPacket(BasePacket):
    """Status updates during processing"""

    type: Literal["status"] = "status"
    content: str
    stage: str | None = None  # e.g., "retrieving", "generating", "processing"


class ErrorPacket(BasePacket):
    """Error information"""

    type: Literal["error"] = "error"
    content: str
    error_code: str | None = None
    traceback: str | None = None


class TranscriptionPartialPacket(BasePacket):
    """Partial transcript while the user is still speaking.

    Emitted whenever the STT pipeline has a refined hypothesis. The split
    between ``committed_text`` (stable prefix) and ``mutable_text`` (tail
    that may still change) lets the UI fade the unstable tail so users see
    visible progress without their mid-sentence words flickering.
    """

    type: Literal["transcription_partial"] = "transcription_partial"
    session_id: str
    committed_text: str
    mutable_text: str
    chunk_index: int
    language: str | None = None


class AudioDeltaPacket(BasePacket):
    """One streamed audio chunk produced by the TTS pipeline.

    The orchestrator (M3) sentence-buffers LLM tokens and feeds each
    sentence to the streaming TTS provider; this packet carries each chunk
    of synthesised audio back to the client as soon as it lands so the
    assistant starts speaking before the full response is generated.

    ``audio`` is base64-encoded raw provider output (MP3 for Edge-TTS,
    OGG/Opus for some Google voices, etc.) — the UI feeds it to a
    Web Audio AudioContext schedule queue for jitter-free playback.
    """

    type: Literal["audio_delta"] = "audio_delta"
    conversation_id: str
    audio_b64: str
    mime_type: str = "audio/mpeg"
    sentence_index: int = 0
    chunk_index: int = 0
    is_final_chunk: bool = False


class TranscriptionFinalPacket(BasePacket):
    """Final transcript when the user finishes speaking (VAD speech-end).

    Carries the consolidated ``text`` so the conversation orchestrator can
    feed it straight into the LLM without merging committed + mutable.
    """

    type: Literal["transcription_final"] = "transcription_final"
    session_id: str
    text: str
    chunk_index: int
    language: str | None = None
    duration_s: float | None = None


class ImageAttachedPacket(BasePacket):
    """One generated image has been persisted under scrapalot_data and is ready
    to render. Emitted once per image (idx + total tell the UI when to drop the
    placeholder card and how many tiles to expect).

    ``storage_path`` is the relative path stored in
    ``chat_message_attachments.storage_path``; the UI loads it through the
    standard ``/documents/file/<path>`` proxy. ``revised_prompt`` is the
    upstream-rewritten prompt (DALL-E silently rewrites) — surfacing it lets
    the user offer a "regenerate with my exact wording" affordance.
    """

    type: Literal["image_attached"] = "image_attached"
    message_id: str
    kind: Literal["image", "audio", "video", "document"] = "image"
    storage_path: str
    mime_type: str
    width: int | None = None
    height: int | None = None
    prompt: str | None = None
    revised_prompt: str | None = None
    model_name: str | None = None
    idx: int = 0
    total: int = 1
    cost_cents: int | None = None


class StreamEndPacket(BasePacket):
    """Signals the end of the stream"""

    type: Literal["stream_end"] = "stream_end"
    reason: Literal["completed", "error", "cancelled", "clarification_needed", "plan_preview_ready", "background_job_dispatched"] = "completed"
    total_tokens: int | None = None
    duration_ms: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    tokens_per_second: float | None = None
    cost_usd: float | None = None
    latency_ms: float | None = None
    provider: str | None = None
    model: str | None = None


class SectionEndPacket(BasePacket):
    """Signals the end of a logical section"""

    type: Literal["section_end"] = "section_end"


# ============================================================================
# TOOL PACKETS - External tool execution
# ============================================================================


class ToolStartPacket(BasePacket):
    """Signals the start of a tool execution"""

    type: Literal["tool_start"] = "tool_start"
    tool_name: str
    tool_params: dict | None = None


class ToolDeltaPacket(BasePacket):
    """Tool execution progress"""

    type: Literal["tool_delta"] = "tool_delta"
    tool_name: str
    content: str


class ToolArtifactPacket(BasePacket):
    """
    File-artifact tool delivery.

    Instead of inlining the full tool result into the LLM context, the tool
    stashes the payload in the in-memory `ArtifactStore` and emits this
    packet. The LLM decides — based on `summary` alone — whether the result
    is worth fetching via the `read_artifact` tool. Empty / "0 hits" results
    can be skipped without ever loading the JSON into context, which is the
    paper's noise-robustness mechanism.
    """

    type: Literal["tool_artifact"] = "tool_artifact"
    artifact_id: str
    tool_name: str
    summary: str
    size_bytes: int
    expires_at: datetime


# ============================================================================
# RESEARCH PACKETS - Deep research & web search
# ============================================================================


class ResearchStartPacket(BasePacket):
    """Signals the start of research/web search"""

    type: Literal["research_start"] = "research_start"
    search_type: Literal["web", "deep", "hybrid"]
    research_id: str | None = None


class ResearchQueryPacket(BasePacket):
    """Search query being executed"""

    type: Literal["research_query"] = "research_query"
    query: str
    search_engine: str | None = None


class ResearchResultPacket(BasePacket):
    """Research result found"""

    type: Literal["research_result"] = "research_result"
    title: str
    url: str
    snippet: str
    relevance_score: float | None = None


class ResearchPlanPacket(BasePacket):
    """Research plan generated by planning agent"""

    type: Literal["research_plan"] = "research_plan"
    plan_title: str
    sections: list[dict] = Field(default_factory=list)  # Simplified section data for UI
    methodology: str
    estimated_duration: int  # minutes
    complexity_score: float
    total_questions: int


class PlanningProgressPacket(BasePacket):
    """Progress updates during research plan generation"""

    type: Literal["planning_progress"] = "planning_progress"
    stage: str  # "analyzing_query", "selecting_methodology", "structuring_plan", "validating_plan"
    progress: float = Field(ge=0.0, le=1.0)  # 0.0-1.0
    message: str = ""
    current_section: str | None = None


class ResearchSectionPacket(BasePacket):
    """Individual research section being processed"""

    type: Literal["research_section"] = "research_section"
    section_id: str
    title: str
    priority: int
    status: str  # "pending", "in_progress", "completed", "error"
    progress: float = Field(ge=0.0, le=1.0, default=0.0)
    sources_found: int = 0
    research_questions: list[str] = Field(default_factory=list)


class ResearchThinkingPacket(BasePacket):
    """Agent thinking/reasoning during research planning"""

    type: Literal["research_thinking"] = "research_thinking"
    stage: str
    content: str
    confidence: float | None = None


# ============================================================================
# TASK EXECUTION PACKETS - task decomposition and coordination
# ============================================================================


class TaskDecompositionPlanPacket(BasePacket):
    """Task decomposition plan generated from research plan"""

    type: Literal["task_decomposition_plan"] = "task_decomposition_plan"
    total_tasks: int
    parallel_groups: int
    estimated_duration: int  # minutes
    critical_path_length: int


class TaskExecutionPacket(BasePacket):
    """Individual task execution status"""

    type: Literal["task_execution"] = "task_execution"
    task_id: str
    task_title: str
    status: str  # "started", "completed", "failed"
    agent_type: str
    progress: float | None = None  # 0.0-1.0


class ParallelGroupPacket(BasePacket):
    """Parallel task group execution status"""

    type: Literal["parallel_group"] = "parallel_group"
    group_id: int
    task_count: int
    status: str  # "starting", "in_progress", "completed"
    completion_percentage: float


class QualityGatePacket(BasePacket):
    """Quality gate validation results"""

    type: Literal["quality_gate"] = "quality_gate"
    gate_name: str
    status: str  # "checking", "passed", "failed"
    quality_metrics: dict[str, float] = Field(default_factory=dict)


class TaskCoordinationPacket(BasePacket):
    """Overall coordination progress and metrics"""

    type: Literal["task_coordination"] = "task_coordination"
    stage: str  # "initializing", "executing", "validating", "completed"
    active_tasks: int
    completed_tasks: int
    failed_tasks: int
    overall_progress: float  # 0.0-1.0


# ============================================================================
# ENHANCED SEARCH PACKETS
# ============================================================================


class SearchStrategyPacket(BasePacket):
    """Search strategy generation and optimization"""

    type: Literal["search_strategy"] = "search_strategy"
    total_queries: int
    providers_allocated: list[str]
    expected_sources: int
    strategy_type: str


class SourceEvaluationPacket(BasePacket):
    """Source credibility and quality evaluation"""

    type: Literal["source_evaluation"] = "source_evaluation"
    source_url: str
    credibility_score: float | None = None
    bias_score: float | None = None
    evaluation_status: str  # "evaluating", "completed", "rejected"


class SearchProgressPacket(BasePacket):
    """Search execution progress across providers"""

    type: Literal["search_progress"] = "search_progress"
    provider: str
    queries_completed: int
    total_queries: int
    sources_found: int
    quality_score: float | None = None


class ContentExtractionPacket(BasePacket):
    """Content extraction and processing status"""

    type: Literal["content_extraction"] = "content_extraction"
    source_url: str
    extraction_type: str  # "full_content", "structured_data", "citations"
    progress: float = Field(ge=0.0, le=1.0, default=0.0)
    data_extracted: dict[str, Any] = Field(default_factory=dict)


class SearchFusionPacket(BasePacket):
    """Multi-provider result fusion and deduplication"""

    type: Literal["search_fusion"] = "search_fusion"
    phase: str  # "deduplication", "ranking", "optimization"
    original_sources: int
    fused_results: int
    deduplication_ratio: float | None = None


class ResultRankingPacket(BasePacket):
    """Result ranking and relevance scoring"""

    type: Literal["result_ranking"] = "result_ranking"
    ranking_strategy: str
    results_processed: int
    average_relevance: float | None = None
    quality_threshold: float | None = None


# ============================================================================
# MULTI-AGENT COORDINATION PACKETS - coordination system
# ============================================================================


class CoordinationPlanPacket(BasePacket):
    """Multi-agent coordination plan initialization"""

    type: Literal["coordination_plan"] = "coordination_plan"
    total_agents: int
    agent_types: list[str]
    execution_phases: int
    estimated_duration: int  # minutes


class AgentStatusPacket(BasePacket):
    """Individual agent status and progress updates"""

    type: Literal["agent_status"] = "agent_status"
    agent_id: str
    agent_type: str
    status: str  # "idle", "assigned", "working", "completed", "error"
    current_task: str | None = None
    progress: float = Field(ge=0.0, le=1.0, default=0.0)


class InterAgentCommunicationPacket(BasePacket):
    """Inter-agent communication and information sharing"""

    type: Literal["inter_agent_communication"] = "inter_agent_communication"
    sender_agent: str
    recipient_agent: str
    communication_type: str  # "task_result", "resource_request", "coordination_update"
    summary: str


class CoordinationQualityGatePacket(BasePacket):
    """Quality gates for multi-agent coordination validation"""

    type: Literal["coordination_quality_gate"] = "coordination_quality_gate"
    phase_name: str
    agents_validated: list[str]
    quality_scores: dict[str, float] = Field(default_factory=dict)
    gate_status: str  # "passed", "failed", "requires_attention"


class AgentPoolStatusPacket(BasePacket):
    """Agent pool management and resource utilization"""

    type: Literal["agent_pool_status"] = "agent_pool_status"
    total_agents: int
    active_agents: int
    idle_agents: int
    agent_type_distribution: dict[str, int] = Field(default_factory=dict)
    resource_utilization: float = Field(ge=0.0, le=1.0, default=0.0)


# ============================================================================
# SYNTHESIS & QUALITY ASSURANCE PACKETS
# ============================================================================


class SynthesisStartPacket(BasePacket):
    """Signals the start of research synthesis process"""

    type: Literal["synthesis_start"] = "synthesis_start"
    status: str
    total_sources: int
    synthesis_style: str


class SynthesisDeltaPacket(BasePacket):
    """Incremental synthesis progress updates"""

    type: Literal["synthesis_delta"] = "synthesis_delta"
    content: str
    progress: float = Field(ge=0.0, le=1.0)


class ValidationStartPacket(BasePacket):
    """Signals the start of cross-source validation"""

    type: Literal["validation_start"] = "validation_start"
    status: str
    total_sources: int
    validation_depth: str


class ValidationResultPacket(BasePacket):
    """Cross-source validation results"""

    type: Literal["validation_result"] = "validation_result"
    reliability_score: float = Field(ge=0.0, le=1.0)
    contradictions_count: int
    high_credibility_sources: int
    validation_summary: str


class QualityCheckPacket(BasePacket):
    """Quality assurance check progress"""

    type: Literal["quality_check"] = "quality_check"
    status: str
    quality_standard: str
    dimensions_to_assess: int


class QualityResultPacket(BasePacket):
    """Final quality assessment results"""

    type: Literal["quality_result"] = "quality_result"
    overall_score: float = Field(ge=0.0, le=1.0)
    quality_level: str
    academic_readiness: bool
    gates_passed: int
    total_gates: int


class CitationPacket(BasePacket):
    """Citation generation progress and results"""

    type: Literal["citation"] = "citation"
    citation_style: str
    sources_processed: int
    total_sources: int
    bibliography_ready: bool = False


class ReportGenerationPacket(BasePacket):
    """Final report generation progress"""

    type: Literal["report_generation"] = "report_generation"
    stage: str  # "formatting", "citations", "quality_check", "finalization"
    progress: float = Field(ge=0.0, le=1.0)
    current_section: str | None = None


# ============================================================================
# CONTEXT EXPANSION PACKETS
# ============================================================================


class ContextExpansionPacket(BasePacket):
    """Context expansion decision and strategy selection"""

    type: Literal["context_expansion"] = "context_expansion"
    expansion_level: str  # "none", "conservative", "moderate", "comprehensive"
    triggers: list[str] = Field(default_factory=list)  # Detected triggers
    search_strategy: str  # "chunk_only", "hybrid_summary", "summary_first"
    complexity_score: float = Field(ge=0.0, le=1.0)
    reasoning: str


class ChapterReadStartPacket(BasePacket):
    """Signals start of full chapter reading"""

    type: Literal["chapter_read_start"] = "chapter_read_start"
    document_id: str
    chapter_number: str
    chapter_title: str
    total_sections: int


class ChapterReadProgressPacket(BasePacket):
    """Progress while reading full chapter"""

    type: Literal["chapter_read_progress"] = "chapter_read_progress"
    sections_read: int
    total_sections: int
    progress: float = Field(ge=0.0, le=1.0)


# ============================================================================
# INTENT ROUTING PACKETS
# ============================================================================


class IntentRoutingPacket(BasePacket):
    """Intent-based routing decision showing sources and strategy selection."""

    type: Literal["intent_routing"] = "intent_routing"
    sources: list[str] = Field(description="Selected sources: documents, web, llm")
    strategy_name: str
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str


# ============================================================================
# CLARIFICATION & REPORT PACKETS (Deep Research v1)
# ============================================================================


class ClarificationQuestionsPacket(BasePacket):
    """Emitted when LLM generates clarification questions before research."""

    type: Literal["clarification_questions"] = "clarification_questions"
    questions: list[dict] = Field(default_factory=list)  # [{id, question, hint, category, priority}]
    request_id: str = ""
    research_context: str = ""


class PlanPreviewSection(BaseModel):
    """A single section in a research plan preview."""

    title: str = ""
    description: str = ""
    question_count: int = 0
    source_types: list[str] = Field(default_factory=list)


class PlanPreviewPacket(BasePacket):
    """Emitted after clarification answers to show the research plan before execution starts."""

    type: Literal["plan_preview"] = "plan_preview"
    plan_id: str = ""
    title: str = ""
    objective: str = ""
    methodology: str = ""
    sections: list[PlanPreviewSection] = Field(default_factory=list)
    total_questions: int = 0
    estimated_sources: int = 0
    source_types: list[str] = Field(default_factory=list)
    estimated_duration_minutes: int = 5


class ResearchReportPacket(BasePacket):
    """Final research report in markdown, emitted before stream_end."""

    type: Literal["research_report"] = "research_report"
    plan_id: str = ""
    title: str = ""
    executive_summary: str = ""
    full_report_markdown: str = ""
    quality_score: float | None = None
    total_sources: int = 0
    word_count: int = 0


class DiscoveryStartPacket(BasePacket):
    """Emitted when discovery extraction begins."""

    type: Literal["discovery_start"] = "discovery_start"
    status: str = "extracting_discoveries"
    total_sources: int = 0


class DiscoveryPacket(BasePacket):
    """A single structured research finding."""

    type: Literal["discovery"] = "discovery"
    discovery_index: int = 0
    title: str = ""
    claim: str = ""
    summary: str = ""
    evidence_count: int = 0
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    category: str = "finding"
    novelty: str = ""
    sources: list[dict] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)


class DiscoveryCompletePacket(BasePacket):
    """Emitted when all discoveries have been extracted."""

    type: Literal["discovery_complete"] = "discovery_complete"
    total_discoveries: int = 0
    average_confidence: float = Field(default=0.0, ge=0.0, le=1.0)


# ============================================================================
# PAPER GENERATION PACKETS (AI Scientist)
# ============================================================================


class PaperProgressPacket(BasePacket):
    """Progress update during paper generation."""

    type: Literal["paper_progress"] = "paper_progress"
    stage: str = ""  # collecting_sources, fetching_bibliography, generating_sections, assembling, validating, converting, storing
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    current_section: str | None = None
    sections_completed: int | None = None
    sections_total: int | None = None


class PaperCompletePacket(BasePacket):
    """Paper generation completed."""

    type: Literal["paper_complete"] = "paper_complete"
    paper_id: str = ""
    download_url: str = ""
    format: str = "pdf"
    page_count: int | None = None
    word_count: int | None = None


class PaperErrorPacket(BasePacket):
    """Paper generation failed."""

    type: Literal["paper_error"] = "paper_error"
    error: str = ""
    stage: str = ""
    recoverable: bool = False


# ============================================================================
# ITERATIVE RESEARCH PACKETS — Research iteration lifecycle (AI Scientist)
# ============================================================================


class IterationStartPacket(BasePacket):
    """Signals the start of a new research iteration."""

    type: Literal["iteration_start"] = "iteration_start"
    iteration: int = 1
    max_iterations: int = 3
    current_objective: str = ""
    evolving_objective: str = ""


class IterationCompletePacket(BasePacket):
    """Signals the completion of a research iteration."""

    type: Literal["iteration_complete"] = "iteration_complete"
    iteration: int = 1
    total_insights: int = 0
    has_hypothesis: bool = False
    will_continue: bool = False


class ReflectionCompletePacket(BasePacket):
    """Emitted after the reflection agent updates research state."""

    type: Literal["reflection_complete"] = "reflection_complete"
    evolving_objective: str = ""
    current_objective: str = ""
    key_insights: list[str] = Field(default_factory=list)
    methodology: str = ""
    iteration: int = 1


class ContinuationDecisionPacket(BasePacket):
    """Emitted when the continue/stop agent makes its decision."""

    type: Literal["continuation_decision"] = "continuation_decision"
    should_continue: bool = False
    reasoning: str = ""
    confidence: str = "medium"
    trigger_reason: str | None = None
    iteration: int = 1


class HypothesisPacket(BasePacket):
    """Emitted when a hypothesis is generated or refined."""

    type: Literal["hypothesis"] = "hypothesis"
    hypothesis: str = ""
    rationale: str = ""
    novelty_statement: str = ""
    experimental_design: str | None = None
    iteration: int = 1


class IterationStatePacket(BasePacket):
    """Full state snapshot for UI state recovery."""

    type: Literal["iteration_state"] = "iteration_state"
    objective: str = ""
    evolving_objective: str = ""
    current_objective: str = ""
    key_insights: list[str] = Field(default_factory=list)
    methodology: str = ""
    current_hypothesis: str | None = None
    iteration_count: int = 0
    max_iterations: int = 3
    discoveries: list[dict] = Field(default_factory=list)


# ============================================================================
# CONSCIOUSNESS COUNCIL PACKETS (Feature 4 — multi-perspective deliberation)
# ============================================================================


class CouncilStartPacket(BasePacket):
    """Emitted when the council is convened. Lists selected archetypes."""

    type: Literal["council_start"] = "council_start"
    members: list[str] = Field(
        default_factory=list,
        description="Archetype ids in table order, e.g. ['empiricist','contrarian',...]",
    )
    selection_reason: str = ""


class CouncilMemberPacket(BasePacket):
    """Emitted once per archetype, in deliberation order."""

    type: Literal["council_member"] = "council_member"
    member_index: int = 0
    total_members: int = 0
    archetype: str = ""
    label: str = ""  # e.g. "The Empiricist"
    emoji: str = ""  # e.g. "🔬"
    position: str = ""
    reasoning: str = ""
    key_risk: str = ""
    surprising_insight: str = ""


class CouncilSynthesisPacket(BasePacket):
    """Emitted after all members speak — convergence, tension, path forward."""

    type: Literal["council_synthesis"] = "council_synthesis"
    convergence_points: list[str] = Field(default_factory=list)
    core_tension: str = ""
    blind_spot: str = ""
    recommended_path: str = ""
    confidence: str = "medium"  # high | medium | low
    question_to_sit_with: str = ""
    # Tension edges between disagreeing archetypes — rendered as glow lines in UI.
    # Each entry: {"from": "empiricist", "to": "futurist", "about": "short label"}
    tension_edges: list[dict] = Field(default_factory=list)


# ============================================================================
# DEEP RESEARCH v2 PACKETS — Agent Persona, Source Curation, Cost Tracking
# ============================================================================


class AgentPersonaPacket(BasePacket):
    """Emitted when LLM selects a domain-specific research persona."""

    type: Literal["agent_persona"] = "agent_persona"
    persona_name: str = ""  # e.g., "Medical Research Analyst"
    persona_emoji: str = ""  # e.g., "🏥"
    persona_prompt: str = ""  # Role prompt for the agent
    domain: str = ""  # Detected domain


class SourceCurationPacket(BasePacket):
    """Emitted when source curation filters/ranks research results."""

    type: Literal["source_curation"] = "source_curation"
    status: str = "started"  # started | completed
    total_sources: int = 0
    curated_count: int = 0
    dropped_count: int = 0
    dropped_reasons: list[str] = Field(default_factory=list)
    average_relevance: float = 0.0


class ResearchCostPacket(BasePacket):
    """Emitted to report API cost per research phase."""

    type: Literal["research_cost"] = "research_cost"
    phase: str = ""  # planning | decomposition | coordination | search | synthesis | total
    input_tokens: int = 0
    output_tokens: int = 0
    estimated_cost_usd: float = 0.0
    model: str = ""
    cumulative_cost_usd: float = 0.0


class ReviewFeedbackPacket(BasePacket):
    """Emitted when reviewer agent provides quality feedback on synthesis draft."""

    type: Literal["review_feedback"] = "review_feedback"
    round: int = 1  # Review round (1 or 2)
    accepted: bool = False  # True if draft passes review
    feedback: str = ""  # Review feedback (empty if accepted)
    quality_score: float = 0.0  # Reviewer's quality assessment (0-1)
    issues_found: int = 0


class RevisionPacket(BasePacket):
    """Emitted when reviser agent revises the synthesis draft."""

    type: Literal["revision"] = "revision"
    round: int = 1  # Revision round
    sections_revised: int = 0
    revision_summary: str = ""  # What changed


# ============================================================================
# ADAPTIVE MULTI-STEP RESEARCH PACKETS
# ============================================================================


class ResearchStepStartPacket(BasePacket):
    """Emitted when an adaptive research step begins."""

    type: Literal["research_step_start"] = "research_step_start"
    step: int = 1  # Current step (1-3)
    max_steps: int = 1  # Total steps allowed for this query
    complexity: str = ""  # "trivial" / "moderate" / "complex"
    focus: str = ""  # "initial_search" / "targeted_followup" / "deep_gap_fill"


class ResearchStepCompletePacket(BasePacket):
    """Emitted when an adaptive research step finishes."""

    type: Literal["research_step_complete"] = "research_step_complete"
    step: int = 1
    learnings_count: int = 0  # Total accumulated learnings so far
    gaps_found: int = 0  # Gaps identified by gap analysis
    coverage_score: float = 0.0  # 0-1, how well the query is covered
    continuing: bool = False  # Whether the next step will run


class ResearchGapAnalysisPacket(BasePacket):
    """Emitted between research steps with gap analysis results."""

    type: Literal["research_gap_analysis"] = "research_gap_analysis"
    step: int = 1  # Step that was just completed
    gaps: list[str] = Field(default_factory=list)  # Identified knowledge gaps
    follow_up_queries: list[str] = Field(default_factory=list)  # Queries to fill gaps
    coverage_score: float = 0.0  # 0-1, overall coverage assessment


# ============================================================================
# RAG DEBUG INFO PACKETS
# ============================================================================


class RagDebugInfoPacket(BasePacket):
    """RAG debug information for trace/diagnostics UI."""

    type: Literal["rag_debug_info"] = "rag_debug_info"
    system_prompt_preview: str = ""
    system_prompt_length: int = 0
    context_document_count: int = 0
    context_token_estimate: int = 0
    history_message_count: int = 0
    has_conversation_summary: bool = False
    context_window_size: int = 0
    strategy_name: str | None = None
    collection_names: list[str] = Field(default_factory=list)


# ============================================================================
# FOLLOW-UP SUGGESTION PACKETS
# ============================================================================


class SuggestionPacket(BasePacket):
    """Follow-up question suggestions based on document summaries."""

    type: Literal["suggestions"] = "suggestions"
    questions: list[str] = Field(default_factory=list)
    document_id: str = ""
    document_title: str = ""


class ChartDataPacket(BasePacket):
    """Structured chart data for frontend rendering via Recharts."""

    type: Literal["chart_data"] = "chart_data"
    chart_type: Literal["bar", "line", "pie", "scatter"] = "bar"
    title: str = ""
    x_label: str = ""
    y_label: str = ""
    # X-axis category labels (for bar/line charts)
    labels: list[str] = Field(default_factory=list)
    # Each dataset: {"label": str, "data": list[float|int], "color": str (optional)}
    # For pie: data items are {"name": str, "value": float}
    # For scatter: data items are {"x": float, "y": float}
    datasets: list[dict] = Field(default_factory=list)


# ============================================================================
# Leiden community build progress
# ============================================================================


class CommunityBuildStartedPacket(BasePacket):
    """Emitted once at the start of a community build."""

    type: Literal["community_build_started"] = "community_build_started"
    collection_id: str
    max_cluster_size: int = 12


class CommunityBuildProgressPacket(BasePacket):
    """Per-community heartbeat — drives the admin progress UI."""

    type: Literal["community_build_progress"] = "community_build_progress"
    communities_done: int = 0
    communities_total: int = 0
    phase: Literal["leiden", "reports"] = "leiden"


class CommunityReportGeneratedPacket(BasePacket):
    """One LLM-generated report landed on the graph."""

    type: Literal["community_report_generated"] = "community_report_generated"
    community_id: str
    title: str = ""
    rating: float = 0.0
    level: int = 0


class CommunityBuildCompletePacket(BasePacket):
    """Final summary at the end of a build."""

    type: Literal["community_build_complete"] = "community_build_complete"
    communities_total: int = 0
    reports_written: int = 0
    sizes_by_level: dict[int, int] = Field(default_factory=dict)


# ============================================================================
# Multimodal element processing — drives upload-time progress UI for
# "Processing 12 figures... 7/12" style indicators. One packet per
# element transition (started -> described -> indexed) plus a per-document
# summary at the end.
# ============================================================================


class MultimodalElementStartedPacket(BasePacket):
    """One element pulled off the pending queue and dispatched to its agent."""

    type: Literal["multimodal_element_started"] = "multimodal_element_started"
    document_id: str
    element_id: str
    element_type: Literal["image", "table", "equation"]
    page_idx: int | None = None
    element_index: int = 0


class MultimodalElementDescribedPacket(BasePacket):
    """Agent returned a structured description for one element."""

    type: Literal["multimodal_element_described"] = "multimodal_element_described"
    document_id: str
    element_id: str
    element_type: Literal["image", "table", "equation"]
    entity_name: str | None = None
    entity_subtype: str | None = None
    succeeded: bool = True
    error: str | None = None


class MultimodalElementIndexedPacket(BasePacket):
    """Element fully indexed (pgvector chunk + Neo4j entity if available)."""

    type: Literal["multimodal_element_indexed"] = "multimodal_element_indexed"
    document_id: str
    element_id: str
    element_type: Literal["image", "table", "equation"]
    neo4j_entity_id: str | None = None


# ============================================================================
# PACKET UNION - All possible streaming packet types
# ============================================================================

# 60+ packet types — flat Union reads more cleanly than chained `|` spanning
# 90 lines. ruff UP007 would widen this to `A | B | C | ... | Z`.
StreamPacket = Union[  # noqa: UP007
    MessageStartPacket,
    MessageDeltaPacket,
    ReasoningStartPacket,
    ReasoningDeltaPacket,
    ModelInsightStartPacket,
    ModelInsightDeltaPacket,
    CitationStartPacket,
    CitationInfoPacket,
    CitationDeltaPacket,
    StatusPacket,
    ErrorPacket,
    StreamEndPacket,
    SectionEndPacket,
    ToolStartPacket,
    ToolDeltaPacket,
    ToolArtifactPacket,
    ResearchStartPacket,
    ResearchQueryPacket,
    ResearchResultPacket,
    ResearchPlanPacket,
    PlanningProgressPacket,
    ResearchSectionPacket,
    ResearchThinkingPacket,
    TaskDecompositionPlanPacket,
    TaskExecutionPacket,
    ParallelGroupPacket,
    QualityGatePacket,
    TaskCoordinationPacket,
    # Strategy Transparency (competitive analysis — search-strategy sidebar)
    StrategyTransparencyPacket,
    # Enhanced Search Packets
    SearchStrategyPacket,
    SourceEvaluationPacket,
    SearchProgressPacket,
    ContentExtractionPacket,
    SearchFusionPacket,
    ResultRankingPacket,
    # Multi-Agent Coordination Packets
    CoordinationPlanPacket,
    AgentStatusPacket,
    InterAgentCommunicationPacket,
    CoordinationQualityGatePacket,
    AgentPoolStatusPacket,
    # Synthesis & Quality Assurance Packets
    SynthesisStartPacket,
    SynthesisDeltaPacket,
    ValidationStartPacket,
    ValidationResultPacket,
    QualityCheckPacket,
    QualityResultPacket,
    CitationPacket,
    ReportGenerationPacket,
    # Context Expansion Packets
    ContextExpansionPacket,
    ChapterReadStartPacket,
    ChapterReadProgressPacket,
    # Intent Routing
    IntentRoutingPacket,
    # RAG Debug Info
    RagDebugInfoPacket,
    # Clarification & Report (Deep Research v1)
    ClarificationQuestionsPacket,
    PlanPreviewPacket,
    ResearchReportPacket,
    DiscoveryStartPacket,
    DiscoveryPacket,
    DiscoveryCompletePacket,
    # Deep Research v2 Packets
    AgentPersonaPacket,
    SourceCurationPacket,
    ResearchCostPacket,
    ReviewFeedbackPacket,
    RevisionPacket,
    # Follow-up Suggestions
    SuggestionPacket,
    # Adaptive Multi-Step Research
    ResearchStepStartPacket,
    ResearchStepCompletePacket,
    ResearchGapAnalysisPacket,
    # Chart Data
    ChartDataPacket,
    # Iterative Research (AI Scientist)
    IterationStartPacket,
    IterationCompletePacket,
    ReflectionCompletePacket,
    ContinuationDecisionPacket,
    HypothesisPacket,
    IterationStatePacket,
    # Consciousness Council (Feature 4)
    CouncilStartPacket,
    CouncilMemberPacket,
    CouncilSynthesisPacket,
    # Leiden community build progress
    CommunityBuildStartedPacket,
    CommunityBuildProgressPacket,
    CommunityReportGeneratedPacket,
    CommunityBuildCompletePacket,
    # Multimodal element processing
    MultimodalElementStartedPacket,
    MultimodalElementDescribedPacket,
    MultimodalElementIndexedPacket,
    # Image generation attachments
    ImageAttachedPacket,
    # Voice mode streaming transcription
    TranscriptionPartialPacket,
    TranscriptionFinalPacket,
    AudioDeltaPacket,
]


# ============================================================================
# PACKET WRAPPER - Adds ordering and metadata
# ============================================================================


class Packet(BaseModel):
    """Wrapper for streaming packets with ordering"""

    ind: int  # Packet index/sequence number
    obj: StreamPacket = Field(..., discriminator="type")

    model_config = ConfigDict(use_enum_values=True)


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================


def create_packet(packet_type: type[BasePacket], ind: int, **kwargs) -> str:
    """Helper to create and serialize a packet"""
    packet_obj = cast(StreamPacket, packet_type(**kwargs))
    packet = Packet(ind=ind, obj=packet_obj)
    return packet.model_dump_json() + "\n"


def parse_packet(json_str: str) -> Packet:
    """Parse a JSON string into a Packet"""
    return Packet.model_validate_json(json_str)
