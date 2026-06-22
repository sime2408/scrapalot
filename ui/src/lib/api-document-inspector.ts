/**
 * Data Inspector API Client
 * API functions for document evaluation, graph inspection, and RAG trace monitoring.
 */

import i18n from '@/i18n';
import { apiClient, authState } from './api';

/**
 * Convert API errors into user-friendly messages instead of raw HTTP status codes.
 */
export function formatApiError(err: unknown, fallback?: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const response = (err as { response?: { status?: number } }).response;
    const status = response?.status;
    if (status === 500) return i18n.t('admin.errors.serverError');
    if (status === 502 || status === 503) return i18n.t('admin.errors.serviceUnavailable');
    if (status === 504) return i18n.t('admin.errors.timeout');
    if (status === 401 || status === 403) return i18n.t('admin.errors.unauthorized');
  }
  if (err instanceof Error) {
    if (err.message.includes('timeout')) return i18n.t('admin.errors.timeout');
    if (err.message.includes('Network Error')) return i18n.t('admin.errors.networkError');
    return err.message;
  }
  return fallback ?? String(err);
}

// =========================================================================
// Types
// =========================================================================

export interface ParseQuality {
  heading_count: number;
  list_count: number;
  table_count: number;
  code_block_count: number;
  image_ref_count: number;
  total_chunks: number;
  structure_score: number;
}

export interface ChunkSizeStats {
  mean: number;
  std: number;
  min: number;
  max: number;
  median: number;
}

export interface ChunkQuality {
  total_chunks: number;
  size_distribution: ChunkSizeStats;
  metadata_completeness: number;
  micro_chunk_ratio: number;
  empty_chunk_count: number;
}

export interface EmbeddingCoverage {
  total_embeddings: number;
  zero_embedding_docs: number;
  embedding_density: number;
  pages_without_embeddings: number;
}

export interface GraphIntegrity {
  hierarchy_completeness: number;
  orphan_count: number;
  entity_coverage: number;
  relationship_density: number;
  total_nodes: number;
  total_relationships: number;
}

export interface DocumentEvaluation {
  document_id: string;
  document_title: string;
  collection_id: string;
  parse_quality: ParseQuality;
  chunk_quality: ChunkQuality;
  embedding_coverage: EmbeddingCoverage;
  graph_integrity: GraphIntegrity;
  overall_score: number;
  evaluated_at: string;
  processing_stats: ProcessingStats | null;
}

export interface ProcessingStats {
  total_duration_seconds: number | null;
  parse_duration_seconds: number | null;
  chunk_duration_seconds: number | null;
  embed_duration_seconds: number | null;
  graph_duration_seconds: number | null;
  chunk_count: number;
  embedding_count: number;
  entity_count: number;
  page_count: number;
  word_count: number;
  processor_used: string;
  source: string;
  chunking_strategy: string;
  embedding_model: string;
  ocr_detected: boolean;
}

export interface GraphTraversalStats {
  nodes_visited: number;
  relationships_traversed: number;
  query_entities_extracted: string[];
  matched_nodes: Array<{ name: string; labels?: string[]; relevance: number }>;
  relationship_types: string[];
  dense_results_count: number;
  sparse_results_count: number;
  graph_results_count: number;
  modality_weights: { dense: number; sparse: number; graph: number };
  execution_time_ms: number;
  fusion_confidence: number;
}

export interface CollectionEvaluation {
  collection_id: string;
  document_count: number;
  avg_parse_quality: number;
  avg_chunk_quality: number;
  avg_embedding_coverage: number;
  avg_graph_integrity: number;
  overall_score: number;
  failed_documents: string[];
  cross_document_entities: {
    shared_entity_count: number;
    entities_by_type: Record<string, number>;
    cross_doc_relationship_count: number;
    top_shared_entities: Array<{ name: string; type: string; document_count: number }>;
  };
  evaluated_at: string;
}

export interface ChunkItem {
  chunk_index: number;
  text: string;
  size: number;
  metadata: Record<string, unknown>;
  embedding_id: string;
  has_embedding: boolean;
  section_heading: string;
  chapter_title: string;
  page_number: number;
}

export interface ChunkInspectionResult {
  document_id: string;
  total_chunks: number;
  page: number;
  page_size: number;
  chunks: ChunkItem[];
}

export interface GraphSubgraph {
  nodes: Array<{ data: { id: string; label: string; node_type: string; properties: Record<string, unknown> } }>;
  edges: Array<{ data: { id: string; source: string; target: string; label: string } }>;
  total_nodes: number;
  total_edges: number;
  truncated: boolean;
}

export interface GraphStats {
  total_nodes: number;
  total_edges: number;
  node_counts_by_type: Record<string, number>;
  edge_counts_by_type: Record<string, number>;
  avg_degree: number;
}

export interface EntityRelationships {
  entities: Array<{ id: string; name: string; labels: string[]; properties: Record<string, unknown> }>;
  relationships: Array<{ type: string; source: string; target: string }>;
  total_entities: number;
  total_relationships: number;
}

export interface NodeNeighborNode {
  neo_id: string;
  labels: string[];
  properties: Record<string, unknown>;
  neighbor_count: number;
}

export interface NodeNeighborEdge {
  rel_id: string;
  rel_type: string;
  source: string;
  target: string;
  properties: Record<string, unknown>;
}

export interface NodeNeighborsResult {
  nodes: NodeNeighborNode[];
  edges: NodeNeighborEdge[];
  total_neighbor_count: number;
  returned_count: number;
}

export interface RAGTrace {
  id: string;
  session_id: string;
  user_id: string;
  query: string;
  selected_strategy: string;
  selected_orchestrator: string;
  strategy_type: string;
  mode: string;
  confidence: number;
  reasoning: string;
  alternative_strategies: unknown[];
  query_characteristics: Record<string, unknown>;
  latency_ms: number;
  token_count: number;
  graph_traversal_stats: GraphTraversalStats | null;
  routing_tier: number | null;
  routing_tier_name: string | null;
  created_at: string;
}

export interface RAGTracesResult {
  traces: RAGTrace[];
  total: number;
  page: number;
  page_size: number;
}

export interface StrategyDistribution {
  strategy_name: string;
  count: number;
  avg_latency_ms: number;
  avg_tokens: number;
  avg_confidence: number;
}

export interface StrategyDistributionResult {
  distributions: StrategyDistribution[];
  total_traces: number;
}

export interface LLMEvalProgress {
  completed: number;
  total: number;
  progress: number;
  status: string;
  avg_faithfulness: number;
  avg_context_relevance: number;
  avg_completeness: number;
  current_result?: {
    trace_id: string;
    faithfulness_score: number;
    context_relevance_score: number;
    completeness_score: number;
    overall_score: number;
    reasoning: string;
  };
}

// =========================================================================
// Graph Quality Audit Types
// =========================================================================

export interface CoverageStats {
  pg_documents: number;
  neo4j_books: number;
  missing_in_graph: number;
  coverage_pct: number;
  sync_completed: number;
  sync_running: number;
  sync_failed: number;
  sync_pending: number;
}

export interface HierarchyIntegrity {
  total_books: number;
  total_chapters: number;
  total_sections: number;
  total_chunks: number;
  orphan_chunks: number;
  orphan_sections: number;
  orphan_chapters: number;
  books_without_chapters: number;
  integrity_score: number;
}

export interface EntityTypeBreakdown {
  entity_type: string;
  total: number;
  with_mentions: number;
  orphaned: number;
}

export interface EntityHealth {
  total_entities: number;
  entities_with_mentions: number;
  orphaned_entities: number;
  health_pct: number;
  by_type: EntityTypeBreakdown[];
}

export interface RelationshipHealth {
  total_co_occurs: number;
  valid_co_occurs: number;
  stale_co_occurs: number;
  co_occurs_health_pct: number;
  total_shared_entity: number;
  total_mentions: number;
  total_contains: number;
}

export interface ChunkAlignment {
  neo4j_chunks: number;
  pg_embeddings: number;
  matched: number;
  neo4j_only: number;
  pg_only: number;
  alignment_pct: number;
}

export interface CollectionAuditItem {
  collection_id: string;
  collection_name: string;
  pg_documents: number;
  neo4j_books: number;
  coverage_pct: number;
  total_entities: number;
  total_chunks: number;
}

export interface CrossBookHealth {
  total_shared_links: number;
  cross_collection_links: number;
  within_collection_links: number;
  connected_books: number;
  disconnected_books: number;
  avg_shared_per_pair: number;
  connectivity_pct: number;
}

export interface GraphQualityAudit {
  overall_score: number;
  coverage: CoverageStats;
  hierarchy: HierarchyIntegrity;
  entity_health: EntityHealth;
  relationship_health: RelationshipHealth;
  chunk_alignment: ChunkAlignment;
  collections: CollectionAuditItem[];
  cross_book_health: CrossBookHealth;
}

// =========================================================================
// Agent Cost Analysis Types
// =========================================================================

export interface AgentCostItem {
  agent_type: string;
  call_count: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  avg_latency_ms: number;
  model: string;
}

export interface DailyCostItem {
  date: string;
  cost_usd: number;
  tokens: number;
  calls: number;
}

export interface AgentCostAnalysis {
  total_cost_usd: number;
  total_tokens: number;
  total_calls: number;
  user_cost_usd: number;
  system_cost_usd: number;
  agent_breakdown: AgentCostItem[];
  daily_costs: DailyCostItem[];
  model_costs: Record<string, number>;
}

// =========================================================================
// LLM Trace Types (llm_traces table — full execution data)
// =========================================================================

export interface RetrievedChunk {
  document_id: string;
  collection_id: string;
  score: number | null;
  content_preview: string;
  source: string;
  page: number | null;
  chunk_index: number;
}

export interface LLMTrace {
  id: string;
  session_id: string;
  user_id: string;
  workspace_id: string | null;
  assistant_message_id: string | null;
  query: string;
  chat_mode: string;
  collection_ids: string[];
  document_ids: string[];
  top_k: number;
  similarity_threshold: number;
  strategy_name: string | null;
  strategy_type: string | null;
  agentic_routing: boolean;
  retrieved_chunks: RetrievedChunk[];
  retrieved_chunk_count: number;
  system_prompt_length: number;
  context_token_estimate: number;
  history_message_count: number;
  has_conversation_summary: boolean;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  latency_ms: number;
  duration_ms: number;
  response_preview: string | null;
  source_analysis: Record<string, unknown> | null;
  routing_tier: number | null;
  routing_tier_name: string | null;
  created_at: string;
}

export interface LLMTracesResult {
  traces: LLMTrace[];
  total: number;
  page: number;
  page_size: number;
}

export interface LLMTraceSummary {
  total_traces: number;
  total_cost_usd: number;
  total_tokens: number;
  avg_latency_ms: number;
  provider_distribution: Record<string, number>;
  chat_mode_distribution: Record<string, number>;
  model_distribution: Record<string, number>;
}

// =========================================================================
// Cross-Book Entity Relationship Types
// =========================================================================

export interface SharedEntityInfo {
  name: string;
  type: string;
  mention_count_a: number;
  mention_count_b: number;
}

export interface RelatedBook {
  book_id: string;
  book_title: string;
  document_id: string;
  shared_entity_count: number;
  entity_types: string[];
  top_entities: string[];
  shared_entities: SharedEntityInfo[];
}

export interface RelatedBooksResult {
  book_id: string;
  book_title: string;
  related_books: RelatedBook[];
  total_related: number;
}

export interface CrossBookGraphNode {
  id: string;
  label: string;
  document_id: string;
  entity_count: number;
  chapter_count: number;
}

export interface CrossBookGraphEdge {
  source: string;
  target: string;
  shared_entity_count: number;
  entity_types: string[];
  top_entities: string[];
}

export interface CrossBookGraphResult {
  nodes: CrossBookGraphNode[];
  edges: CrossBookGraphEdge[];
  total_books: number;
  total_relationships: number;
}

// =========================================================================
// Graph Sync Status Types (Entity Extraction Progress)
// =========================================================================

export interface GraphSyncStatusItem {
  document_id: string;
  collection_id: string;
  status: 'pending' | 'hierarchy_done' | 'entity_running' | 'completed' | 'failed';
  chunks_expected: number;
  chunks_created: number;
  entities_extracted: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
  document_title: string | null;
}

export interface GraphSyncSummary {
  total_documents: number;
  pending_count: number;
  hierarchy_done_count: number;
  entity_running_count: number;
  completed_count: number;
  failed_count: number;
  total_entities_extracted: number;
  total_chunks: number;
  avg_entities_per_doc: number;
  latest_completed_at: string | null;
}

export interface GraphSyncStatusResult {
  items: GraphSyncStatusItem[];
  summary: GraphSyncSummary;
  total: number;
  page: number;
  page_size: number;
}

// =========================================================================
// API Functions
// =========================================================================

const BASE = '/admin/inspector';

export async function getDocumentEvaluation(documentId: string): Promise<DocumentEvaluation> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<DocumentEvaluation>(`${BASE}/document/${documentId}/evaluation`);
  return response.data;
}

export async function getCollectionEvaluation(
  collectionId: string,
  signal?: AbortSignal,
): Promise<CollectionEvaluation> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<CollectionEvaluation>(
    `${BASE}/collection/${collectionId}/evaluation`,
    { signal },
  );
  return response.data;
}

export async function getChunkInspection(documentId: string, page = 1, pageSize = 20): Promise<ChunkInspectionResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<ChunkInspectionResult>(
    `${BASE}/document/${documentId}/chunks`,
    { params: { page, pageSize } }
  );
  return response.data;
}

// Cache-awareness markers added to graph-tier responses when the backend
// served the payload from Redis (stale-while-revalidate). UI uses these to
// show a "refreshing…" indicator. Never blocking — ALWAYS return data.
export interface CacheMarkers {
  cached_at?: string;  // ISO — when the cached payload was produced
  stale?: boolean;     // true → backend kicked off a background refresh
}

export async function getGraphSubgraph(params: {
  workspaceId?: string;
  collectionId?: string;
  documentId?: string;
  depth?: number;
  maxNodes?: number;
}, signal?: AbortSignal): Promise<GraphSubgraph & CacheMarkers> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<GraphSubgraph & CacheMarkers>(`${BASE}/graph/subgraph`, { params, signal });
  return response.data;
}

export async function getGraphStats(signal?: AbortSignal): Promise<GraphStats & CacheMarkers> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<GraphStats & CacheMarkers>(`${BASE}/graph/stats`, { signal });
  return response.data;
}

export interface KnowledgeGaps {
  orphan_entities: { name: string; type: string }[];
  dead_end_entities: { name: string; type: string; connections: number }[];
  isolated_books: { title: string; id: string }[];
  low_density_sections: { title: string; chunks: number }[];
  cross_doc_lonely_entities: { name: string; type: string; doc_count: number }[];
  summary: {
    orphan_entities: number;
    dead_end_entities: number;
    isolated_books: number;
    low_density_sections: number;
    cross_doc_lonely_entities: number;
    total_issues: number;
  } | null;
}

export async function getKnowledgeGaps(signal?: AbortSignal): Promise<KnowledgeGaps & CacheMarkers> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<KnowledgeGaps & CacheMarkers>(`${BASE}/graph/knowledge-gaps`, { signal });
  return response.data;
}

export async function getNodeNeighbors(params: {
  nodeElementId: string;
  excludeNodeIds?: string[];
  maxNeighbors?: number;
}): Promise<NodeNeighborsResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.post<NodeNeighborsResult>(`${BASE}/graph/node-neighbors`, params);
  return response.data;
}

export async function getEntityRelationships(params?: {
  query?: string;
  type?: string;
  limit?: number;
}): Promise<EntityRelationships> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<EntityRelationships>(`${BASE}/graph/entities`, { params });
  return response.data;
}

export async function getRAGTraces(params?: {
  limit?: number;
  page?: number;
  strategy?: string;
  mode?: string;
  from?: string;
  to?: string;
  userId?: string;
}, signal?: AbortSignal): Promise<RAGTracesResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<RAGTracesResult>(`${BASE}/rag/traces`, { params, signal });
  return response.data;
}

export async function getStrategyDistribution(params?: {
  from?: string;
  to?: string;
}, signal?: AbortSignal): Promise<StrategyDistributionResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<StrategyDistributionResult>(`${BASE}/rag/distribution`, { params, signal });
  return response.data;
}

export async function getLLMTraces(params?: {
  limit?: number;
  page?: number;
  chatMode?: string;
  provider?: string;
  model?: string;
  from?: string;
  to?: string;
  userId?: string;
}, signal?: AbortSignal): Promise<LLMTracesResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<LLMTracesResult>(`${BASE}/llm/traces`, { params, signal });
  return response.data;
}

export async function getLLMTraceSummary(params?: {
  from?: string;
  to?: string;
}, signal?: AbortSignal): Promise<LLMTraceSummary> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<LLMTraceSummary>(`${BASE}/llm/summary`, { params, signal });
  return response.data;
}

export async function getRelatedBooks(params: {
  documentId?: string;
  bookId?: string;
  limit?: number;
}): Promise<RelatedBooksResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<RelatedBooksResult>(`${BASE}/graph/related-books`, { params });
  return response.data;
}

export async function getCrossBookGraph(params: {
  collectionId?: string;
  limit?: number;
}, signal?: AbortSignal): Promise<CrossBookGraphResult & CacheMarkers> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<CrossBookGraphResult & CacheMarkers>(`${BASE}/graph/cross-book`, { params, signal });
  return response.data;
}

export async function getGraphSyncStatus(params?: {
  collectionId?: string;
  status?: string;
  limit?: number;
  page?: number;
}, signal?: AbortSignal): Promise<GraphSyncStatusResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<GraphSyncStatusResult>(`${BASE}/graph/sync-status`, { params, signal });
  return response.data;
}

export async function getGraphQualityAudit(collectionId?: string, signal?: AbortSignal): Promise<GraphQualityAudit & CacheMarkers> {
  await authState.waitForAuthReady();
  const params = collectionId ? { collectionId } : {};
  const response = await apiClient.get<GraphQualityAudit & CacheMarkers>(`${BASE}/graph/quality-audit`, { params, signal });
  return response.data;
}

export async function rebuildGraph(collectionId?: string): Promise<{ success: boolean; message: string; documents_processed: number; entities_extracted: number }> {
  await authState.waitForAuthReady();
  const response = await apiClient.post('/admin/rebuild-graph', { collectionId: collectionId || undefined });
  return response.data;
}

export async function rebuildCrossBookRelationships(collectionId?: string): Promise<{ success: boolean; message: string; relationships_created: number; books_processed: number }> {
  await authState.waitForAuthReady();
  const response = await apiClient.post('/admin/rebuild-cross-book-relationships', { collectionId });
  return response.data;
}

// ---------- Graph Housekeeping ----------

export interface GraphHealthFinding {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  metric: string;
  message: string;
  sample: string[];
}

export interface GraphHealthCheckResult {
  critical_count: number;
  warning_count: number;
  info_count: number;
  findings: GraphHealthFinding[];
  stats: Record<string, unknown>;
}

export async function runGraphHealthCheck(): Promise<GraphHealthCheckResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.post<GraphHealthCheckResult>(`${BASE}/graph/health-check`, {});
  return response.data;
}

export interface SweepGraphOrphansResult {
  orphan_chunks_deleted: number;
  orphan_sections_deleted: number;
  orphan_chapters_deleted: number;
  orphan_books_deleted: number;
  empty_workspaces_deleted: number;
  total_deleted: number;
  message: string;
}

export async function sweepGraphOrphans(
  dryRun: boolean,
  purgeEmptyWorkspaces: boolean,
): Promise<SweepGraphOrphansResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.post<SweepGraphOrphansResult>(
    `${BASE}/graph/sweep-orphans`,
    { dryRun, purgeEmptyWorkspaces },
  );
  return response.data;
}

export interface MergeDuplicateGroupPreview {
  canonical_name: string;
  primary_id?: string;
  merge_count: number;
  labels?: string[];
}

export interface MergeDuplicateEntitiesResult {
  groups_merged: number;
  duplicate_nodes_removed: number;
  edges_redirected: number;
  message: string;
  // P02 — populated only when dryRun=true; the duplicate-groups the
  // backend would merge if you ran without dry_run. Empty in live runs.
  sample_groups?: MergeDuplicateGroupPreview[];
}

export async function mergeDuplicateEntities(
  dryRun: boolean,
  batchSize: number = 500,
): Promise<MergeDuplicateEntitiesResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.post<MergeDuplicateEntitiesResult>(
    `${BASE}/graph/merge-duplicates`,
    { dryRun, batchSize },
  );
  return response.data;
}

export interface CleanupMissingFileDocsResult {
  docs_processed: number;
  pg_embeddings_deleted: number;
  neo4j_nodes_deleted: number;
  message: string;
}

export async function cleanupMissingFileDocs(
  dryRun: boolean,
): Promise<CleanupMissingFileDocsResult> {
  await authState.waitForAuthReady();
  const response = await apiClient.post<CleanupMissingFileDocsResult>(
    `${BASE}/graph/cleanup-missing-files`,
    { dryRun },
  );
  return response.data;
}

export async function getAgentCostAnalysis(params?: {
  from?: string;
  to?: string;
}, signal?: AbortSignal): Promise<AgentCostAnalysis> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<AgentCostAnalysis>(`${BASE}/llm/agent-costs`, { params, signal });
  return response.data;
}


export async function cleanupOrphanedTraces(): Promise<{ rag_traces_deleted: number; llm_traces_deleted: number }> {
  await authState.waitForAuthReady();
  const response = await apiClient.post(`${BASE}/traces/cleanup-orphaned`);
  return response.data;
}

// ──────────────────────────────────────────────────────────────────────
// Entity Extraction Metrics
// Per-phase aggregates (spaCy / LLM / Neo4j / co-occurrence) and the top
// most expensive documents over the trailing window. Returned by
// `summarize_recent` in extraction_metrics_service.py via the gRPC
// AdminService.GetEntityExtractionMetrics → Kotlin REST proxy.
// ──────────────────────────────────────────────────────────────────────

export interface ExtractionPhaseStat {
  phase: string;
  runs: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  chunks_processed: number;
  llm_calls: number;
  llm_skipped: number;
  tokens_in: number;
  tokens_out: number;
  cost_cents: number;
}

export interface ExtractionDocStat {
  document_id: string;
  total_ms: number;
  llm_calls: number;
  llm_skipped: number;
  tokens_in: number;
  tokens_out: number;
  cost_cents: number;
  latest_at: string | null;
}

export interface ExtractionMetricsTotals {
  window_days: number;
  total_runs: number;
  total_cost_cents: number;
  total_llm_calls: number;
  total_llm_skipped: number;
  llm_skip_ratio: number;
}

export interface ExtractionMetricsSummary {
  totals?: ExtractionMetricsTotals;
  per_phase: ExtractionPhaseStat[];
  // Backend field name is `per_document_top` (top-N documents sorted by
  // total extraction time over the window). Previously this TS interface
  // used `per_document` which silently returned an empty table.
  per_document_top: ExtractionDocStat[];
}

export interface ExtractionMetricsResponse {
  summary: ExtractionMetricsSummary;
  message?: string;
}

export async function getEntityExtractionMetrics(
  windowDays: number = 7,
  topDocumentsLimit: number = 100,
  signal?: AbortSignal,
): Promise<ExtractionMetricsResponse & { summary: ExtractionMetricsSummary & CacheMarkers }> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<ExtractionMetricsResponse & { summary: ExtractionMetricsSummary & CacheMarkers }>(
    `${BASE}/graph/extraction-metrics`,
    { params: { windowDays, topDocumentsLimit }, signal },
  );
  return response.data;
}

// ──────────────────────────────────────────────────────────────────────
// Edge Provenance
// Returns type, weight, typed-relationship metadata, and source chunks
// for a single graph edge identified by Neo4j elementId. Powers the
// graph-explorer's edge inspector modal.
// ──────────────────────────────────────────────────────────────────────

export interface EdgeSourceChunk {
  chunk_id: string;
  document_id: string;
  document_title: string;
  text_preview: string;
  chunk_index: number;
}

export interface EdgeProvenance {
  rel_type: string;
  source_node_id: string;
  target_node_id: string;
  source_node_name: string;
  target_node_name: string;
  chunk_cooccurrence_count: number;
  document_cooccurrence_count: number;
  document_weighted_score: number;
  confidence: number;
  classifier_rationale: string;
  source_chunks: EdgeSourceChunk[];
  properties: Record<string, unknown>;
}

export async function getEdgeProvenance(relElementId: string): Promise<EdgeProvenance> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<EdgeProvenance>(
    `${BASE}/graph/edge-provenance`,
    { params: { rel_element_id: relElementId } },
  );
  return response.data;
}
