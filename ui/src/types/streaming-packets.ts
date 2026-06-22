/**
 * TypeScript definitions for streaming packets.
 * Must match backend: src/main/dto/streaming.py
 */

// Base packet interface
export interface BasePacket {
  type: string;
  timestamp: string;
}

// ============================================================================
// MESSAGE PACKETS
// ============================================================================

export interface MessageStartPacket extends BasePacket {
  type: 'message_start';
  content: string;
  documents?: Array<{
    id: string;
    title: string;
    url?: string;
  }>;
  model_info?: {
    model_name: string;
    provider_type: string;
  };
}

export interface MessageDeltaPacket extends BasePacket {
  type: 'message_delta';
  content: string;
}

// ============================================================================
// REASONING PACKETS
// ============================================================================

export interface ReasoningStartPacket extends BasePacket {
  type: 'reasoning_start';
}

export interface ReasoningDeltaPacket extends BasePacket {
  type: 'reasoning_delta';
  reasoning: string;
}

// The model's own-knowledge reflection on the sourced answer, rendered as a
// distinct "model insight" block below the answer.
export interface ModelInsightStartPacket extends BasePacket {
  type: 'model_insight_start';
}

export interface ModelInsightDeltaPacket extends BasePacket {
  type: 'model_insight_delta';
  content: string;
}

// ============================================================================
// CITATION PACKETS
// ============================================================================

export interface CitationStartPacket extends BasePacket {
  type: 'citation_start';
}

export type CitationStance = 'supporting' | 'contrasting' | 'mentioning';

export interface ChunkPositionJson {
  page: number | null;
  char_offset_start: number;
  char_offset_end: number;
  bbox: number[] | null;
}

export interface CitationInfoPacket extends BasePacket {
  type: 'citation_info';
  citation_num: number;
  document_id: string;
  document_title: string;
  page?: number;
  url?: string;
  score?: number;
  text?: string;
  chunk_index?: number;
  file_type?: string;
  authors?: string[];
  year?: number;
  formatted_citation?: string;
  chunk_position_json?: ChunkPositionJson;
  stance?: CitationStance;
  stance_confidence?: number;
  stance_rationale?: string;
  // Compact sentence-bounded excerpt (≤280 chars) rendered as a blockquote
  // under the citation card. `text` carries the longer chunk preview.
  citation_context?: string;
  // Bridge-mode metadata — present when the citation originates
  // from a cross-domain bridge chunk. UI renders a dedicated panel below
  // the assistant reply when any citation in the message has is_bridge=true.
  is_bridge?: boolean;
  source_collection_id?: string;
  bridge_anchors?: string[];
}

export interface StrategyTransparencyPacket extends BasePacket {
  type: 'strategy_transparency';
  sub_queries: string[];
  filters_applied: Record<string, string>;
  sources_queried: string[];
  strategy_name?: string;
  rationale?: string;
  /** Who actually ran retrieval (e.g. "agentic_tool_agent"); the strategy_name is
   *  the router's chosen approach/intent, not necessarily the executor. */
  executor?: string;
}

export interface CitationDeltaPacket extends BasePacket {
  type: 'citation_delta';
  citations: Citation[];
}

// ============================================================================
// STATUS & CONTROL PACKETS
// ============================================================================

export interface StatusPacket extends BasePacket {
  type: 'status';
  content: string; // This contains the status_code or custom message
  stage?: 'init' | 'retrieval' | 'generation' | 'processing' | 'research' | 'search' | 'fact_check'
    | 'initialization' | 'connecting' | 'initializing' | 'ready' | 'cancelled'
    | 'local_connection' | 'system_init' | 'remote_connection'
    | 'strategy_routing' | 'source_routing' | 'collection_discovery'
    | 'preparation' | 'document_qa';
}

export interface ErrorPacket extends BasePacket {
  type: 'error';
  content: string;
  error_code?: string;
  traceback?: string;
}

export interface StreamEndPacket extends BasePacket {
  type: 'stream_end';
  reason: 'completed' | 'error' | 'cancelled' | 'clarification_needed';
  total_tokens?: number;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  tokens_per_second?: number;
  cost_usd?: number;
  latency_ms?: number;
  provider?: string;
  model?: string;
}

export interface SectionEndPacket extends BasePacket {
  type: 'section_end';
}

// ============================================================================
// VOICE MODE STREAMING TRANSCRIPTION
// ============================================================================

export interface TranscriptionPartialPacket extends BasePacket {
  type: 'transcription_partial';
  session_id: string;
  /** Stable prefix of the transcript so far. Render at full opacity. */
  committed_text: string;
  /** Tail being refined; render dimmed so it feels less authoritative. */
  mutable_text: string;
  chunk_index: number;
  language?: string;
}

export interface TranscriptionFinalPacket extends BasePacket {
  type: 'transcription_final';
  session_id: string;
  text: string;
  chunk_index: number;
  language?: string;
  duration_s?: number;
}

export interface AudioDeltaPacket extends BasePacket {
  type: 'audio_delta';
  conversation_id: string;
  /** Base64-encoded raw provider output. UI hands it to a Web Audio
   *  AudioContext schedule queue for jitter-free playback. */
  audio_b64: string;
  mime_type: string;
  sentence_index: number;
  chunk_index: number;
  is_final_chunk: boolean;
}

// ============================================================================
// IMAGE / AUDIO ATTACHMENTS
// ============================================================================

export interface ImageAttachedPacket extends BasePacket {
  type: 'image_attached';
  message_id: string;
  /** Always 'image' for now; reserved for audio/video in 6.3 follow-ups. */
  kind: 'image' | 'audio' | 'video' | 'document';
  /**
   * Relative path under scrapalot_data/ — load via the standard
   * `/documents/file/<storage_path>` proxy.
   */
  storage_path: string;
  mime_type: string;
  width?: number;
  height?: number;
  prompt?: string;
  /** Provider may rewrite the prompt (DALL-E does silently) — surface it. */
  revised_prompt?: string;
  model_name?: string;
  idx: number;
  total: number;
  cost_cents?: number;
}

// ============================================================================
// TOOL PACKETS
// ============================================================================

export interface ToolStartPacket extends BasePacket {
  type: 'tool_start';
  tool_name: string;
  tool_params?: Record<string, unknown>;
}

export interface ToolDeltaPacket extends BasePacket {
  type: 'tool_delta';
  tool_name: string;
  content: string;
}

// ============================================================================
// RESEARCH PACKETS
// ============================================================================

export interface ResearchStartPacket extends BasePacket {
  type: 'research_start';
  search_type: 'web' | 'deep' | 'hybrid';
  research_id?: string | null;
}

export interface ResearchQueryPacket extends BasePacket {
  type: 'research_query';
  query: string;
  search_engine?: string;
}

export interface ResearchResultPacket extends BasePacket {
  type: 'research_result';
  title: string;
  url: string;
  snippet: string;
  relevance_score?: number;
}

// ============================================================================
// STEP 1: RESEARCH PLANNING PACKETS
// ============================================================================

export interface ResearchPlanPacket extends BasePacket {
  type: 'research_plan';
  plan_title: string;
  sections: Array<{
    id: string;
    title: string;
    priority: number;
    questions: string[];
    expected_sources: number;
  }>;
  methodology: string;
  estimated_duration: number;
  complexity_score: number;
  total_questions: number;
}

export interface PlanningProgressPacket extends BasePacket {
  type: 'planning_progress';
  stage: string;
  progress: number;
  message: string;
  current_section?: string;
}

export interface ResearchSectionPacket extends BasePacket {
  type: 'research_section';
  section_id: string;
  title: string;
  priority: number;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  progress: number;
  sources_found: number;
  research_questions: string[];
}

export interface ResearchThinkingPacket extends BasePacket {
  type: 'research_thinking';
  stage: string;
  content: string;
  confidence?: number;
}

// ============================================================================
// STEP 2: TASK DECOMPOSITION PACKETS
// ============================================================================

export interface TaskDecompositionPlanPacket extends BasePacket {
  type: 'task_decomposition_plan';
  total_tasks: number;
  parallel_groups: number;
  estimated_duration: number;
  critical_path_length: number;
}

export interface TaskExecutionPacket extends BasePacket {
  type: 'task_execution';
  task_id: string;
  task_title: string;
  status: string;
  agent_type: string;
  progress?: number;
}

export interface ParallelGroupPacket extends BasePacket {
  type: 'parallel_group';
  group_id: number;
  task_count: number;
  status: string;
  completion_percentage: number;
}

export interface QualityGatePacket extends BasePacket {
  type: 'quality_gate';
  gate_name: string;
  status: string;
  quality_metrics: Record<string, number>;
}

export interface TaskCoordinationPacket extends BasePacket {
  type: 'task_coordination';
  stage: string;
  active_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  overall_progress: number;
}

// ============================================================================
// STEP 3: MULTI-AGENT COORDINATION PACKETS
// ============================================================================

export interface CoordinationPlanPacket extends BasePacket {
  type: 'coordination_plan';
  total_agents: number;
  agent_types: string[];
  execution_phases: number;
  estimated_duration: number;
}

export interface AgentStatusPacket extends BasePacket {
  type: 'agent_status';
  agent_id: string;
  agent_type: string;
  status: string;
  current_task?: string;
  progress: number;
}

export interface InterAgentCommunicationPacket extends BasePacket {
  type: 'inter_agent_communication';
  sender_agent: string;
  recipient_agent: string;
  communication_type: string;
  summary: string;
}

export interface CoordinationQualityGatePacket extends BasePacket {
  type: 'coordination_quality_gate';
  phase_name: string;
  agents_validated: string[];
  quality_scores: Record<string, number>;
  gate_status: string;
}

export interface AgentPoolStatusPacket extends BasePacket {
  type: 'agent_pool_status';
  total_agents: number;
  active_agents: number;
  idle_agents: number;
  agent_type_distribution: Record<string, number>;
  resource_utilization: number;
}

// ============================================================================
// STEP 4: ENHANCED SEARCH PACKETS
// ============================================================================

export interface SearchStrategyPacket extends BasePacket {
  type: 'search_strategy';
  total_queries: number;
  providers_allocated: string[];
  expected_sources: number;
  strategy_type: string;
}

export interface SourceEvaluationPacket extends BasePacket {
  type: 'source_evaluation';
  source_url: string;
  credibility_score?: number;
  bias_score?: number;
  evaluation_status: string;
}

export interface SearchProgressPacket extends BasePacket {
  type: 'search_progress';
  provider: string;
  queries_completed: number;
  total_queries: number;
  sources_found: number;
  quality_score?: number;
}

export interface ContentExtractionPacket extends BasePacket {
  type: 'content_extraction';
  source_url: string;
  extraction_type: string;
  progress: number;
  data_extracted: Record<string, unknown>;
}

export interface SearchFusionPacket extends BasePacket {
  type: 'search_fusion';
  phase: string;
  original_sources: number;
  fused_results: number;
  deduplication_ratio?: number;
}

export interface ResultRankingPacket extends BasePacket {
  type: 'result_ranking';
  ranking_strategy: string;
  results_processed: number;
  average_relevance?: number;
  quality_threshold?: number;
}

// ============================================================================
// STEP 5: SYNTHESIS & QA PACKETS
// ============================================================================

export interface SynthesisStartPacket extends BasePacket {
  type: 'synthesis_start';
  status: string;
  total_sources: number;
  synthesis_style: string;
}

export interface SynthesisDeltaPacket extends BasePacket {
  type: 'synthesis_delta';
  content: string;
  progress: number;
  current_stage?: string;
}

export interface ValidationStartPacket extends BasePacket {
  type: 'validation_start';
  status: string;
  total_sources: number;
  validation_depth: string;
}

export interface ValidationResultPacket extends BasePacket {
  type: 'validation_result';
  overall_reliability: number;
  contradictions_found: Record<string, unknown>[];
  validation_summary: string;
  credibility_assessments?: Record<string, unknown>[];
}

export interface QualityCheckPacket extends BasePacket {
  type: 'quality_check';
  check_type: string;
  status: string;
  score?: number;
}

export interface QualityResultPacket extends BasePacket {
  type: 'quality_result';
  overall_score: number;
  quality_level: string;
  dimension_scores: Record<string, number>;
  improvement_suggestions?: string[];
}

export interface ResearchCitationPacket extends BasePacket {
  type: 'citation';
  citation_id: string;
  source_url: string;
  author?: string;
  title: string;
  formatted_citation: string;
}

export interface ReportGenerationPacket extends BasePacket {
  type: 'report_generation';
  stage: string;
  progress: number;
  current_section?: string;
  sections_completed?: number;
  total_sections?: number;
}

// ============================================================================
// INTENT ROUTING
// ============================================================================

export interface IntentRoutingPacket extends BasePacket {
  type: 'intent_routing';
  sources: string[];
  strategy_name: string;
  confidence: number;
  reasoning: string;
}

// ============================================================================
// RAG DEBUG INFO
// ============================================================================

export interface RagDebugInfoPacket extends BasePacket {
  type: 'rag_debug_info';
  system_prompt_preview: string;
  system_prompt_length: number;
  context_document_count: number;
  context_token_estimate: number;
  history_message_count: number;
  has_conversation_summary: boolean;
  context_window_size: number;
  strategy_name?: string;
  collection_names?: string[];
}

// ============================================================================
// FOLLOW-UP SUGGESTION PACKETS
// ============================================================================

export interface SuggestionPacket extends BasePacket {
  type: 'suggestions';
  questions: string[];
  document_id: string;
  document_title: string;
}

export interface ChartDataset {
  label: string;
  data: number[] | Array<{ x: number; y: number }> | Array<{ name: string; value: number }>;
  color?: string;
}

export interface ChartDataPacket extends BasePacket {
  type: 'chart_data';
  chart_type: 'bar' | 'line' | 'pie' | 'scatter';
  title: string;
  x_label: string;
  y_label: string;
  labels: string[];
  datasets: ChartDataset[];
}

// Leiden community build progress packets
export interface CommunityBuildStartedPacket extends BasePacket {
  type: 'community_build_started';
  collection_id: string;
  max_cluster_size: number;
}

export interface CommunityBuildProgressPacket extends BasePacket {
  type: 'community_build_progress';
  communities_done: number;
  communities_total: number;
  phase: 'leiden' | 'reports';
}

export interface CommunityReportGeneratedPacket extends BasePacket {
  type: 'community_report_generated';
  community_id: string;
  title: string;
  rating: number;
  level: number;
}

export interface CommunityBuildCompletePacket extends BasePacket {
  type: 'community_build_complete';
  communities_total: number;
  reports_written: number;
  sizes_by_level: Record<string, number>;
}

// ============================================================================
// CLARIFICATION & REPORT PACKETS (Deep Research v1)
// ============================================================================

export interface ClarificationQuestionsPacket extends BasePacket {
  type: 'clarification_questions';
  questions: Array<{ id: string; question: string; hint: string; category?: string; priority?: string; answer_options?: string[] }>;
  request_id: string;
  research_context: string;
}

export interface PlanPreviewSection {
  title: string;
  description: string;
  question_count: number;
  source_types: string[];
}

export interface PlanPreviewPacket extends BasePacket {
  type: 'plan_preview';
  plan_id: string;
  title: string;
  objective: string;
  methodology: string;
  sections: PlanPreviewSection[];
  total_questions: number;
  estimated_sources: number;
  source_types: string[];
  estimated_duration_minutes: number;
}

export interface ResearchReportPacket extends BasePacket {
  type: 'research_report';
  plan_id: string;
  title: string;
  executive_summary: string;
  full_report_markdown: string;
  quality_score?: number;
  total_sources: number;
  word_count: number;
}

export interface DiscoveryStartPacket extends BasePacket {
  type: 'discovery_start';
  status: string;
  total_sources: number;
}

export interface DiscoveryPacket extends BasePacket {
  type: 'discovery';
  discovery_index: number;
  title: string;
  claim: string;
  summary: string;
  evidence_count: number;
  confidence: number;
  category: string;
  novelty: string;
  sources: { url?: string; title?: string; doi?: string }[];
  tags: string[];
}

export interface DiscoveryCompletePacket extends BasePacket {
  type: 'discovery_complete';
  total_discoveries: number;
  average_confidence: number;
}

// ============================================================================
// PAPER GENERATION PACKETS (AI Scientist)
// ============================================================================

export interface PaperProgressPacket extends BasePacket {
  type: 'paper_progress';
  stage: string;
  progress: number;
  current_section?: string;
  sections_completed?: number;
  sections_total?: number;
}

export interface PaperCompletePacket extends BasePacket {
  type: 'paper_complete';
  paper_id: string;
  download_url: string;
  format: string;
  page_count?: number;
  word_count?: number;
}

export interface PaperErrorPacket extends BasePacket {
  type: 'paper_error';
  error: string;
  stage: string;
  recoverable: boolean;
}

// ============================================================================
// ITERATIVE RESEARCH PACKETS (AI Scientist)
// ============================================================================

export interface IterationStartPacket extends BasePacket {
  type: 'iteration_start';
  iteration: number;
  max_iterations: number;
  current_objective: string;
  evolving_objective: string;
}

export interface IterationCompletePacket extends BasePacket {
  type: 'iteration_complete';
  iteration: number;
  total_insights: number;
  has_hypothesis: boolean;
  will_continue: boolean;
}

export interface ReflectionCompletePacket extends BasePacket {
  type: 'reflection_complete';
  evolving_objective: string;
  current_objective: string;
  key_insights: string[];
  methodology: string;
  iteration: number;
}

export interface ContinuationDecisionPacket extends BasePacket {
  type: 'continuation_decision';
  should_continue: boolean;
  reasoning: string;
  confidence: string;
  trigger_reason: string | null;
  iteration: number;
}

export interface HypothesisPacket extends BasePacket {
  type: 'hypothesis';
  hypothesis: string;
  rationale: string;
  novelty_statement: string;
  experimental_design: string | null;
  iteration: number;
}

export interface IterationStatePacket extends BasePacket {
  type: 'iteration_state';
  objective: string;
  evolving_objective: string;
  current_objective: string;
  key_insights: string[];
  methodology: string;
  current_hypothesis: string | null;
  iteration_count: number;
  max_iterations: number;
  discoveries: Record<string, unknown>[];
}

// ============================================================================
// CONSCIOUSNESS COUNCIL PACKETS (Feature 4)
// ============================================================================

export interface CouncilStartPacket extends BasePacket {
  type: 'council_start';
  members: string[];          // e.g. ['empiricist','contrarian','futurist','ethicist']
  selection_reason: string;
}

export interface CouncilMemberPacket extends BasePacket {
  type: 'council_member';
  member_index: number;
  total_members: number;
  archetype: string;          // 'empiricist' | 'contrarian' | ...
  label: string;              // 'The Empiricist'
  emoji: string;              // '🔬'
  position: string;
  reasoning: string;
  key_risk: string;
  surprising_insight: string;
}

export interface CouncilTensionEdge {
  from: string;
  to: string;
  about: string;
}

export interface CouncilSynthesisPacket extends BasePacket {
  type: 'council_synthesis';
  convergence_points: string[];
  core_tension: string;
  blind_spot: string;
  recommended_path: string;
  confidence: 'high' | 'medium' | 'low' | string;
  question_to_sit_with: string;
  tension_edges: CouncilTensionEdge[];
}

// ============================================================================
// DEEP RESEARCH v2 PACKETS
// ============================================================================

export interface AgentPersonaPacket extends BasePacket {
  type: 'agent_persona';
  persona_name: string;
  persona_emoji: string;
  persona_prompt: string;
  domain: string;
}

export interface SourceCurationPacket extends BasePacket {
  type: 'source_curation';
  status: 'started' | 'completed';
  total_sources: number;
  curated_count: number;
  dropped_count: number;
  dropped_reasons: string[];
  average_relevance: number;
}

export interface ResearchCostPacket extends BasePacket {
  type: 'research_cost';
  phase: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  model: string;
  cumulative_cost_usd: number;
}

export interface ReviewFeedbackPacket extends BasePacket {
  type: 'review_feedback';
  round: number;
  accepted: boolean;
  feedback: string;
  quality_score: number;
  issues_found: number;
}

export interface RevisionPacket extends BasePacket {
  type: 'revision';
  round: number;
  sections_revised: number;
  revision_summary: string;
}

// ============================================================================
// ADAPTIVE MULTI-STEP RESEARCH PACKETS
// ============================================================================

export interface ResearchStepStartPacket extends BasePacket {
  type: 'research_step_start';
  step: number;
  max_steps: number;
  complexity: string;
  focus: string;
}

export interface ResearchStepCompletePacket extends BasePacket {
  type: 'research_step_complete';
  step: number;
  learnings_count: number;
  gaps_found: number;
  coverage_score: number;
  continuing: boolean;
}

export interface ResearchGapAnalysisPacket extends BasePacket {
  type: 'research_gap_analysis';
  step: number;
  gaps: string[];
  follow_up_queries: string[];
  coverage_score: number;
}

// ============================================================================
// DISCRIMINATED UNION
// ============================================================================

export type StreamPacketObj =
  // Core message packets
  | MessageStartPacket
  | MessageDeltaPacket
  | ReasoningStartPacket
  | ReasoningDeltaPacket
  | ModelInsightStartPacket
  | ModelInsightDeltaPacket
  | CitationStartPacket
  | CitationInfoPacket
  | CitationDeltaPacket
  | StrategyTransparencyPacket
  | StatusPacket
  | ErrorPacket
  | StreamEndPacket
  | SectionEndPacket
  | ImageAttachedPacket
  | TranscriptionPartialPacket
  | TranscriptionFinalPacket
  | AudioDeltaPacket
  | ToolStartPacket
  | ToolDeltaPacket
  // Research packets (basic)
  | ResearchStartPacket
  | ResearchQueryPacket
  | ResearchResultPacket
  // Step 1: Research Planning
  | ResearchPlanPacket
  | PlanningProgressPacket
  | ResearchSectionPacket
  | ResearchThinkingPacket
  // Step 2: Task Decomposition
  | TaskDecompositionPlanPacket
  | TaskExecutionPacket
  | ParallelGroupPacket
  | QualityGatePacket
  | TaskCoordinationPacket
  // Step 3: Multi-Agent Coordination
  | CoordinationPlanPacket
  | AgentStatusPacket
  | InterAgentCommunicationPacket
  | CoordinationQualityGatePacket
  | AgentPoolStatusPacket
  // Step 4: Enhanced Search
  | SearchStrategyPacket
  | SourceEvaluationPacket
  | SearchProgressPacket
  | ContentExtractionPacket
  | SearchFusionPacket
  | ResultRankingPacket
  // Step 5: Synthesis & QA
  | SynthesisStartPacket
  | SynthesisDeltaPacket
  | ValidationStartPacket
  | ValidationResultPacket
  | QualityCheckPacket
  | QualityResultPacket
  | ResearchCitationPacket
  | ReportGenerationPacket
  // Intent Routing
  | IntentRoutingPacket
  // RAG Debug Info
  | RagDebugInfoPacket
  // Clarification & Report (Deep Research v1)
  | ClarificationQuestionsPacket
  | PlanPreviewPacket
  | ResearchReportPacket
  | DiscoveryStartPacket
  | DiscoveryPacket
  | DiscoveryCompletePacket
  // Paper Generation
  | PaperProgressPacket
  | PaperCompletePacket
  | PaperErrorPacket
  // Deep Research v2
  | AgentPersonaPacket
  | SourceCurationPacket
  | ResearchCostPacket
  | ReviewFeedbackPacket
  | RevisionPacket
  | SuggestionPacket
  // Adaptive Multi-Step Research
  | ResearchStepStartPacket
  | ResearchStepCompletePacket
  | ResearchGapAnalysisPacket
  // Chart Data
  | ChartDataPacket
  // Consciousness Council (Feature 4)
  | CouncilStartPacket
  | CouncilMemberPacket
  | CouncilSynthesisPacket
  // Leiden community build progress
  | CommunityBuildStartedPacket
  | CommunityBuildProgressPacket
  | CommunityReportGeneratedPacket
  | CommunityBuildCompletePacket;

export interface StreamPacket {
  ind: number;
  obj: StreamPacketObj;
}

// ============================================================================
// CITATION TYPES
// ============================================================================

export interface Citation {
  id: number;
  source: string;
  page?: number;
  text: string;
  url?: string;
  title: string;
  score?: number;
  document_id?: string;
  chunk_position_json?: ChunkPositionJson;
}

export interface CitationMap {
  [citationNum: number]: Citation;
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

export function isMessageStart(packet: StreamPacket): packet is StreamPacket & { obj: MessageStartPacket } {
  return packet.obj.type === 'message_start';
}

export function isMessageDelta(packet: StreamPacket): packet is StreamPacket & { obj: MessageDeltaPacket } {
  return packet.obj.type === 'message_delta';
}

export function isReasoningStart(packet: StreamPacket): packet is StreamPacket & { obj: ReasoningStartPacket } {
  return packet.obj.type === 'reasoning_start';
}

export function isReasoningDelta(packet: StreamPacket): packet is StreamPacket & { obj: ReasoningDeltaPacket } {
  return packet.obj.type === 'reasoning_delta';
}

export function isModelInsightStart(packet: StreamPacket): packet is StreamPacket & { obj: ModelInsightStartPacket } {
  return packet.obj.type === 'model_insight_start';
}

export function isModelInsightDelta(packet: StreamPacket): packet is StreamPacket & { obj: ModelInsightDeltaPacket } {
  return packet.obj.type === 'model_insight_delta';
}

export function isCitationStart(packet: StreamPacket): packet is StreamPacket & { obj: CitationStartPacket } {
  return packet.obj.type === 'citation_start';
}

export function isCitationInfo(packet: StreamPacket): packet is StreamPacket & { obj: CitationInfoPacket } {
  return packet.obj.type === 'citation_info';
}

/**
 * Narrows a citation_info packet to one carrying chunk_position_json.
 * Used by the PDF viewer to decide whether the click should trigger a
 * transient highlight pulse on the target page.
 */
export function hasChunkPosition(
  packet: CitationInfoPacket
): packet is CitationInfoPacket & { chunk_position_json: ChunkPositionJson } {
  return (
    !!packet.chunk_position_json &&
    typeof packet.chunk_position_json.char_offset_start === 'number' &&
    typeof packet.chunk_position_json.char_offset_end === 'number'
  );
}

export function isCitationDelta(packet: StreamPacket): packet is StreamPacket & { obj: CitationDeltaPacket } {
  return packet.obj.type === 'citation_delta';
}

export function isStatus(packet: StreamPacket): packet is StreamPacket & { obj: StatusPacket } {
  return packet.obj.type === 'status';
}

export function isError(packet: StreamPacket): packet is StreamPacket & { obj: ErrorPacket } {
  return packet.obj.type === 'error';
}

export function isStreamEnd(packet: StreamPacket): packet is StreamPacket & { obj: StreamEndPacket } {
  return packet.obj.type === 'stream_end';
}

export function isSectionEnd(packet: StreamPacket): packet is StreamPacket & { obj: SectionEndPacket } {
  return packet.obj.type === 'section_end';
}

export function isImageAttached(packet: StreamPacket): packet is StreamPacket & { obj: ImageAttachedPacket } {
  return packet.obj.type === 'image_attached';
}

export function isTranscriptionPartial(packet: StreamPacket): packet is StreamPacket & { obj: TranscriptionPartialPacket } {
  return packet.obj.type === 'transcription_partial';
}

export function isTranscriptionFinal(packet: StreamPacket): packet is StreamPacket & { obj: TranscriptionFinalPacket } {
  return packet.obj.type === 'transcription_final';
}

export function isAudioDelta(packet: StreamPacket): packet is StreamPacket & { obj: AudioDeltaPacket } {
  return packet.obj.type === 'audio_delta';
}

export function isToolStart(packet: StreamPacket): packet is StreamPacket & { obj: ToolStartPacket } {
  return packet.obj.type === 'tool_start';
}

export function isToolDelta(packet: StreamPacket): packet is StreamPacket & { obj: ToolDeltaPacket } {
  return packet.obj.type === 'tool_delta';
}

export function isResearchStart(packet: StreamPacket): packet is StreamPacket & { obj: ResearchStartPacket } {
  return packet.obj.type === 'research_start';
}

export function isResearchQuery(packet: StreamPacket): packet is StreamPacket & { obj: ResearchQueryPacket } {
  return packet.obj.type === 'research_query';
}

export function isResearchResult(packet: StreamPacket): packet is StreamPacket & { obj: ResearchResultPacket } {
  return packet.obj.type === 'research_result';
}

// ============================================================================
// STEP 1: RESEARCH PLANNING TYPE GUARDS
// ============================================================================

export function isResearchPlan(packet: StreamPacket): packet is StreamPacket & { obj: ResearchPlanPacket } {
  return packet.obj.type === 'research_plan';
}

export function isPlanningProgress(packet: StreamPacket): packet is StreamPacket & { obj: PlanningProgressPacket } {
  return packet.obj.type === 'planning_progress';
}

export function isResearchSection(packet: StreamPacket): packet is StreamPacket & { obj: ResearchSectionPacket } {
  return packet.obj.type === 'research_section';
}

export function isResearchThinking(packet: StreamPacket): packet is StreamPacket & { obj: ResearchThinkingPacket } {
  return packet.obj.type === 'research_thinking';
}

// ============================================================================
// STEP 2: TASK DECOMPOSITION TYPE GUARDS
// ============================================================================

export function isTaskDecompositionPlan(packet: StreamPacket): packet is StreamPacket & { obj: TaskDecompositionPlanPacket } {
  return packet.obj.type === 'task_decomposition_plan';
}

export function isTaskExecution(packet: StreamPacket): packet is StreamPacket & { obj: TaskExecutionPacket } {
  return packet.obj.type === 'task_execution';
}

export function isParallelGroup(packet: StreamPacket): packet is StreamPacket & { obj: ParallelGroupPacket } {
  return packet.obj.type === 'parallel_group';
}

export function isQualityGate(packet: StreamPacket): packet is StreamPacket & { obj: QualityGatePacket } {
  return packet.obj.type === 'quality_gate';
}

export function isTaskCoordination(packet: StreamPacket): packet is StreamPacket & { obj: TaskCoordinationPacket } {
  return packet.obj.type === 'task_coordination';
}

// ============================================================================
// STEP 3: MULTI-AGENT COORDINATION TYPE GUARDS
// ============================================================================

export function isCoordinationPlan(packet: StreamPacket): packet is StreamPacket & { obj: CoordinationPlanPacket } {
  return packet.obj.type === 'coordination_plan';
}

export function isAgentStatus(packet: StreamPacket): packet is StreamPacket & { obj: AgentStatusPacket } {
  return packet.obj.type === 'agent_status';
}

export function isInterAgentCommunication(packet: StreamPacket): packet is StreamPacket & { obj: InterAgentCommunicationPacket } {
  return packet.obj.type === 'inter_agent_communication';
}

export function isCoordinationQualityGate(packet: StreamPacket): packet is StreamPacket & { obj: CoordinationQualityGatePacket } {
  return packet.obj.type === 'coordination_quality_gate';
}

export function isAgentPoolStatus(packet: StreamPacket): packet is StreamPacket & { obj: AgentPoolStatusPacket } {
  return packet.obj.type === 'agent_pool_status';
}

// ============================================================================
// STEP 4: ENHANCED SEARCH TYPE GUARDS
// ============================================================================

export function isSearchStrategy(packet: StreamPacket): packet is StreamPacket & { obj: SearchStrategyPacket } {
  return packet.obj.type === 'search_strategy';
}

export function isStrategyTransparency(packet: StreamPacket): packet is StreamPacket & { obj: StrategyTransparencyPacket } {
  return packet.obj.type === 'strategy_transparency';
}

export function isSourceEvaluation(packet: StreamPacket): packet is StreamPacket & { obj: SourceEvaluationPacket } {
  return packet.obj.type === 'source_evaluation';
}

export function isSearchProgress(packet: StreamPacket): packet is StreamPacket & { obj: SearchProgressPacket } {
  return packet.obj.type === 'search_progress';
}

export function isContentExtraction(packet: StreamPacket): packet is StreamPacket & { obj: ContentExtractionPacket } {
  return packet.obj.type === 'content_extraction';
}

export function isSearchFusion(packet: StreamPacket): packet is StreamPacket & { obj: SearchFusionPacket } {
  return packet.obj.type === 'search_fusion';
}

export function isResultRanking(packet: StreamPacket): packet is StreamPacket & { obj: ResultRankingPacket } {
  return packet.obj.type === 'result_ranking';
}

// ============================================================================
// STEP 5: SYNTHESIS & QA TYPE GUARDS
// ============================================================================

export function isSynthesisStart(packet: StreamPacket): packet is StreamPacket & { obj: SynthesisStartPacket } {
  return packet.obj.type === 'synthesis_start';
}

export function isSynthesisDelta(packet: StreamPacket): packet is StreamPacket & { obj: SynthesisDeltaPacket } {
  return packet.obj.type === 'synthesis_delta';
}

export function isValidationStart(packet: StreamPacket): packet is StreamPacket & { obj: ValidationStartPacket } {
  return packet.obj.type === 'validation_start';
}

export function isValidationResult(packet: StreamPacket): packet is StreamPacket & { obj: ValidationResultPacket } {
  return packet.obj.type === 'validation_result';
}

export function isQualityCheck(packet: StreamPacket): packet is StreamPacket & { obj: QualityCheckPacket } {
  return packet.obj.type === 'quality_check';
}

export function isQualityResult(packet: StreamPacket): packet is StreamPacket & { obj: QualityResultPacket } {
  return packet.obj.type === 'quality_result';
}

export function isResearchCitation(packet: StreamPacket): packet is StreamPacket & { obj: ResearchCitationPacket } {
  return packet.obj.type === 'citation';
}

export function isReportGeneration(packet: StreamPacket): packet is StreamPacket & { obj: ReportGenerationPacket } {
  return packet.obj.type === 'report_generation';
}

// Intent Routing
export function isIntentRouting(packet: StreamPacket): packet is StreamPacket & { obj: IntentRoutingPacket } {
  return packet.obj.type === 'intent_routing';
}

// RAG Debug Info
export function isRagDebugInfo(packet: StreamPacket): packet is StreamPacket & { obj: RagDebugInfoPacket } {
  return packet.obj.type === 'rag_debug_info';
}

// Clarification & Report (Deep Research v1)
export function isClarificationQuestions(packet: StreamPacket): packet is StreamPacket & { obj: ClarificationQuestionsPacket } {
  return packet.obj.type === 'clarification_questions';
}

export function isPlanPreview(packet: StreamPacket): packet is StreamPacket & { obj: PlanPreviewPacket } {
  return packet.obj.type === 'plan_preview';
}

export function isResearchReport(packet: StreamPacket): packet is StreamPacket & { obj: ResearchReportPacket } {
  return packet.obj.type === 'research_report';
}

export function isDiscoveryStart(packet: StreamPacket): packet is StreamPacket & { obj: DiscoveryStartPacket } {
  return packet.obj.type === 'discovery_start';
}

export function isDiscovery(packet: StreamPacket): packet is StreamPacket & { obj: DiscoveryPacket } {
  return packet.obj.type === 'discovery';
}

export function isDiscoveryComplete(packet: StreamPacket): packet is StreamPacket & { obj: DiscoveryCompletePacket } {
  return packet.obj.type === 'discovery_complete';
}

// Paper Generation Type Guards (AI Scientist)
export function isPaperProgress(packet: StreamPacket): packet is StreamPacket & { obj: PaperProgressPacket } {
  return packet.obj.type === 'paper_progress';
}

export function isPaperComplete(packet: StreamPacket): packet is StreamPacket & { obj: PaperCompletePacket } {
  return packet.obj.type === 'paper_complete';
}

export function isPaperError(packet: StreamPacket): packet is StreamPacket & { obj: PaperErrorPacket } {
  return packet.obj.type === 'paper_error';
}

// Iterative Research Type Guards (AI Scientist)
export function isIterationStart(packet: StreamPacket): packet is StreamPacket & { obj: IterationStartPacket } {
  return packet.obj.type === 'iteration_start';
}

export function isIterationComplete(packet: StreamPacket): packet is StreamPacket & { obj: IterationCompletePacket } {
  return packet.obj.type === 'iteration_complete';
}

export function isReflectionComplete(packet: StreamPacket): packet is StreamPacket & { obj: ReflectionCompletePacket } {
  return packet.obj.type === 'reflection_complete';
}

export function isContinuationDecision(packet: StreamPacket): packet is StreamPacket & { obj: ContinuationDecisionPacket } {
  return packet.obj.type === 'continuation_decision';
}

export function isHypothesis(packet: StreamPacket): packet is StreamPacket & { obj: HypothesisPacket } {
  return packet.obj.type === 'hypothesis';
}

export function isIterationState(packet: StreamPacket): packet is StreamPacket & { obj: IterationStatePacket } {
  return packet.obj.type === 'iteration_state';
}

// Deep Research v2 Type Guards
export function isAgentPersona(packet: StreamPacket): packet is StreamPacket & { obj: AgentPersonaPacket } {
  return packet.obj.type === 'agent_persona';
}

export function isSourceCuration(packet: StreamPacket): packet is StreamPacket & { obj: SourceCurationPacket } {
  return packet.obj.type === 'source_curation';
}

export function isResearchCost(packet: StreamPacket): packet is StreamPacket & { obj: ResearchCostPacket } {
  return packet.obj.type === 'research_cost';
}

export function isReviewFeedback(packet: StreamPacket): packet is StreamPacket & { obj: ReviewFeedbackPacket } {
  return packet.obj.type === 'review_feedback';
}

export function isRevision(packet: StreamPacket): packet is StreamPacket & { obj: RevisionPacket } {
  return packet.obj.type === 'revision';
}

// Adaptive Multi-Step Research
export function isResearchStepStart(packet: StreamPacket): packet is StreamPacket & { obj: ResearchStepStartPacket } {
  return packet.obj.type === 'research_step_start';
}

export function isResearchStepComplete(packet: StreamPacket): packet is StreamPacket & { obj: ResearchStepCompletePacket } {
  return packet.obj.type === 'research_step_complete';
}

export function isResearchGapAnalysis(packet: StreamPacket): packet is StreamPacket & { obj: ResearchGapAnalysisPacket } {
  return packet.obj.type === 'research_gap_analysis';
}

// Follow-up Suggestions
export function isSuggestion(packet: StreamPacket): packet is StreamPacket & { obj: SuggestionPacket } {
  return packet.obj.type === 'suggestions';
}

export function isChartData(packet: StreamPacket): packet is StreamPacket & { obj: ChartDataPacket } {
  return packet.obj.type === 'chart_data';
}

// Consciousness Council (Feature 4)
export function isCouncilStart(packet: StreamPacket): packet is StreamPacket & { obj: CouncilStartPacket } {
  return packet.obj.type === 'council_start';
}

export function isCouncilMember(packet: StreamPacket): packet is StreamPacket & { obj: CouncilMemberPacket } {
  return packet.obj.type === 'council_member';
}

export function isCouncilSynthesis(packet: StreamPacket): packet is StreamPacket & { obj: CouncilSynthesisPacket } {
  return packet.obj.type === 'council_synthesis';
}
