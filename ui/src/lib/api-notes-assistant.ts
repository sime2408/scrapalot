/**
 * Notes Research Assistant API Client
 *
 * AI Scientist - inline research, citation lookup, text transformation,
 * claim verification, translation, hypothesis generation, and outline generation.
 */

import { apiClient, authState } from '@/lib/api';
import i18n from '@/i18n';

/** Get active UI language code for LLM locale */
function getLocale(): string {
  return i18n.language?.split('-')[0] || 'en';
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CitationMetadata {
  title: string;
  authors: string[];
  year: string;
  publisher?: string;
  journal?: string;
  doi?: string;
  isbn?: string;
  url?: string;
  formatted_apa?: string;
}

export interface ResearchResult {
  source_title: string;
  snippet: string;
  source_type: 'book' | 'pdf' | 'epub' | 'web' | 'academic' | 'docx';
  relevance_score: number;
  chapter?: string;
  page?: string;
  document_id?: string;
  collection_id?: string;
  url?: string;
  doi?: string;
  citation?: CitationMetadata;
}

export interface EvidenceItem {
  snippet: string;
  source_title: string;
  source_type: string;
  citation?: CitationMetadata;
}

// GRADE evidence quality grade — mirrors backend ClaimVerdictWithQuality
// enum. Distinct from VerifyClaimResponse.confidence: confidence is
// confidence-in-verdict, grade is quality-of-underlying-evidence.
export type GradeLevel = 'high' | 'moderate' | 'low' | 'very_low';

export type GradeDowngrade =
  | 'risk_of_bias'
  | 'inconsistency'
  | 'indirectness'
  | 'imprecision'
  | 'publication_bias';

export type GradeUpgrade = 'large_effect' | 'dose_response' | 'confounders_reduce_effect';

export interface EvidenceQuality {
  grade: GradeLevel;
  rationale: string;
  downgrades: GradeDowngrade[];
  upgrades: GradeUpgrade[];
}

export type BiasCategory = 'cognitive' | 'selection' | 'measurement' | 'analysis' | 'confounding';

export interface BiasFlag {
  category: BiasCategory;
  name: string;
  description: string;
}

export type FallacyCategory =
  | 'causation'
  | 'generalization'
  | 'authority'
  | 'statistical'
  | 'structural'
  | 'science_specific';

export interface FallacyWarning {
  category: FallacyCategory;
  name: string;
  description: string;
}

export interface VerifyClaimResponse {
  verdict: 'supported' | 'partially_supported' | 'contradicted' | 'unverified';
  confidence: 'low' | 'medium' | 'high';
  supporting_evidence: EvidenceItem[];
  contradicting_evidence: EvidenceItem[];
  suggestion: string;
  // Feature 2 — GRADE + critical thinking. Kotlin may omit these until
  // its gRPC stubs are rebuilt against the new proto (8d14d9a); in that
  // window they arrive as undefined and the panel degrades gracefully
  // (no GRADE section rendered, existing verdict/confidence unchanged).
  evidence_quality?: EvidenceQuality;
  bias_flags?: BiasFlag[];
  fallacy_warnings?: FallacyWarning[];
}

export interface OutlineSection {
  title: string;
  description: string;
  level: number;
  covered_in_notes: boolean;
  source_count: number;
}

// ─── Feature 3 — ReviewDocument (structured peer review) ─────────────────────
// Matches the proto messages in scrapalot-backend/src/main/proto/notes_assistant.proto
// (ReviewDocumentResponse / ReviewStage / ReviewComment, commit 65b1bef).

export type ReviewSourceType = 'note' | 'deep_research' | 'paper' | 'unknown';

export type ReviewVerdict = 'accept' | 'minor_revisions' | 'major_revisions' | 'reject';

export type ReviewSeverity = 'critical' | 'important' | 'minor';

export type ReviewStageName =
  | 'initial'
  | 'sections'
  | 'methods'
  | 'reproducibility'
  | 'figures'
  | 'ethics'
  | 'writing';

export type ReviewStageHealth = 'ok' | 'concerns' | 'critical';

export interface ReviewComment {
  severity: ReviewSeverity;
  section_ref: string;
  issue: string;
  suggestion: string;
}

export interface ReviewStage {
  stage_number: number;           // 1..7 canonical slot
  stage_name: ReviewStageName;
  health: ReviewStageHealth;      // drives the scanner LED color
  stage_score: number;            // ScholarEval 1..5 rubric (0 = not assessed on fallback)
  summary: string;
  comments: ReviewComment[];
}

// Feature 2 + 3 — one extracted claim paired with its Feature 2
// VerifyClaim result (library + academic DB + Unpaywall + GRADE).
export interface ClaimVerification {
  claim_text: string;
  section_ref: string;
  verdict: 'supported' | 'partially_supported' | 'contradicted' | 'unverified';
  confidence: 'low' | 'medium' | 'high';
  evidence_quality: EvidenceQuality;   // reuses Feature 2 type
}

export interface ReviewDocumentResponse {
  verdict: ReviewVerdict;
  score: number;                        // 0..100 — aggregate of stage_scores × 20
  summary: string;
  overall_strengths: string[];
  overall_weaknesses: string[];
  stages: ReviewStage[];                // always length 7 in canonical order
  questions_for_authors: string[];
  latency_ms: number;                   // server wall-clock, used to calibrate scanner animation pacing
  claim_verifications?: ClaimVerification[]; // optional until Kotlin rebuild ships the field
}

// ─── API Functions ───────────────────────────────────────────────────────────

export async function inlineResearch(
  query: string,
  collectionIds: string[],
  options?: {
    max_library_results?: number;
    max_web_results?: number;
    include_web?: boolean;
  }
): Promise<{
  library_results: ResearchResult[];
  web_results: ResearchResult[];
  total_results: number;
  search_duration_ms: number;
}> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post('/notes/assistant/research', {
    query,
    collection_ids: collectionIds,
    max_library_results: options?.max_library_results ?? 5,
    max_web_results: options?.max_web_results ?? 3,
    include_web: options?.include_web ?? true,
  });
  return data;
}

export async function findCitation(
  claimText: string,
  collectionIds: string[],
  searchCrossref = true
): Promise<{
  library_citations: ResearchResult[];
  academic_citations: ResearchResult[];
}> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post('/notes/assistant/citation', {
    claim_text: claimText,
    collection_ids: collectionIds,
    search_crossref: searchCrossref,
  });
  return data;
}

export async function transformText(
  text: string,
  transformType: 'academic' | 'simplify' | 'expand' | 'title' | 'abstract' | 'highlights' | 'academic_esl',
  surroundingContext?: string,
  collectionIds?: string[]
): Promise<{
  original_text: string;
  transformed_text: string;
  transform_type: string;
}> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post('/notes/assistant/transform', {
    text,
    transform_type: transformType,
    surrounding_context: surroundingContext,
    collection_ids: collectionIds,
    locale: getLocale(),
  });
  return data;
}

export async function verifyClaim(
  claimText: string,
  collectionIds: string[],
  includeWeb = true
): Promise<VerifyClaimResponse> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post('/notes/assistant/verify', {
    claim_text: claimText,
    collection_ids: collectionIds,
    include_web: includeWeb,
    locale: getLocale(),
  });
  return data;
}

export async function translateText(
  text: string,
  targetLanguage: 'en' | 'hr'
): Promise<{
  original_text: string;
  translated_text: string;
  source_language: string;
  target_language: string;
}> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post('/notes/assistant/translate', {
    text,
    target_language: targetLanguage,
  });
  return data;
}

export async function generateHypothesis(
  context: string,
  collectionIds: string[]
): Promise<{
  hypothesis: string;
  rationale: string;
  experimental_design: string;
  competing_hypotheses?: Array<{
    id: string;
    hypothesis: string;
    rationale: string;
    experimental_design: string;
    distinguishing_prediction: string;
    quality: { testability: number; falsifiability: number; parsimony: number; explanatory_power: number; novelty: number };
  }>;
  research_question?: string;
  recommendation?: string;
}> {
  await authState.waitForAuthReady();
  // Try direct Python endpoint first (returns competing_hypotheses),
  // fall back to gRPC route if unavailable
  try {
    const directResp = await apiClient.post('/hypothesis', {
      context,
      collection_ids: collectionIds,
      locale: getLocale(),
    });
    if (directResp.data && directResp.data.competing_hypotheses) {
      return directResp.data;
    }
  } catch (e) {
    console.debug('Direct hypothesis endpoint unavailable, using gRPC route:', e);
  }
  const { data } = await apiClient.post('/notes/assistant/hypothesis', {
    context,
    collection_ids: collectionIds,
    locale: getLocale(),
  });
  return data;
}

// ─── What-If Oracle (Scenario Analysis) ─────────────────

export interface ScenarioBranch {
  branch_type: string;
  title: string;
  probability: number;
  confidence: number;
  timeframe: string;
  narrative: string;
  trigger_conditions: string[];
  consequences: string[];
}

export interface ScenarioSynthesis {
  robust_actions: string[];
  hedge_actions: string[];
  decision_triggers: string[];
  one_percent_insight: string;
}

export interface ScenarioAnalysisResult {
  scenario_question: string;
  branches: ScenarioBranch[];
  synthesis: ScenarioSynthesis;
  error?: string;
}

export async function generateScenarioAnalysis(
  context: string,
  collectionIds: string[]
): Promise<ScenarioAnalysisResult> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post('/notes/assistant/what-if', {
    context,
    collection_ids: collectionIds,
    locale: getLocale(),
  });
  return data;
}

/** 7.2 — outline template variants. Empty falls back to the legacy
 *  generic outline prompt server-side. */
export type OutlineTemplate = '' | 'imrad' | 'lit_review' | 'thesis' | 'grant';

export async function generateOutline(
  notesContent: string,
  collectionIds: string[],
  templateType: OutlineTemplate = ''
): Promise<{
  sections: OutlineSection[];
  formatted_outline: string;
}> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post('/notes/assistant/outline', {
    notes_content: notesContent,
    collection_ids: collectionIds,
    locale: getLocale(),
    template_type: templateType,
  });
  return data;
}

/**
 * Feature 3 — run a structured 7-stage peer review on a flat text blob.
 * Returns the full `ReviewDocumentResponse` once the backend finishes the
 * structured-output LLM call (~15-20 s wall-clock, observed). The frontend
 * animates the scanner LEDs in parallel based on the expected per-stage
 * pacing; when the response arrives, it jumps to the final state.
 */
export async function reviewDocument(
  content: string,
  sourceType: ReviewSourceType,
  sourceTitle: string
): Promise<ReviewDocumentResponse> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post('/notes/assistant/review', {
    content,
    source_type: sourceType,
    source_title: sourceTitle,
    locale: getLocale(),
  });
  return data;
}

// ─── Connect Dots (Bridging concepts) ─────────────────────

export interface CollectionCoverage {
  collection_id: string;
  collection_name: string;
  chunk_count: number;
  book_count: number;
}

export interface BridgingConcept {
  entity: string;
  total_chunks: number;
  total_books: number;
  collections: CollectionCoverage[];
}

export interface ConnectDotsResponse {
  success: boolean;
  entities_extracted: number;
  bridging_concepts: BridgingConcept[];
  /**
   * "ok" | "empty_note" | "no_entities_found"
   *   | "entity_extraction_failed" | "graph_query_failed"
   */
  message: string;
}

/**
 * G3b — surface entities in the note that also appear in the user's
 * collections OUTSIDE the active research context. Backend extracts the
 * entities from `noteText` and queries Neo4j for cross-collection
 * mentions, so the call can take 10–30 s on long notes (45 s gRPC
 * deadline on Kotlin side).
 */
export async function connectNoteDots(
  noteText: string,
  excludeCollectionIds: string[],
  topK: number = 8
): Promise<ConnectDotsResponse> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post('/notes/assistant/connect-dots', {
    note_text: noteText,
    exclude_collection_ids: excludeCollectionIds,
    top_k: topK,
  });
  return data;
}

// ─── Fact-check whole note ────────────────────────────────

export interface ClaimCheck {
  sentence_index: number;
  sentence: string;
  verdict: 'supported' | 'partially_supported' | 'contradicted' | 'unverified';
  confidence: 'low' | 'medium' | 'high';
  suggestion: string;
  evidence_quality: EvidenceQuality | null;
  bias_flags: BiasFlag[];
  fallacy_warnings: FallacyWarning[];
  char_offset: number;
  char_length: number;
}

export interface FactCheckWholeNoteResponse {
  success: boolean;
  total_sentences: number;
  candidates_classified: number;
  claims_verified: number;
  checks: ClaimCheck[];
  /** "ok" | "empty_note" | "no_claims_found" */
  message: string;
}

/**
 * G3c — sentence-level GRADE fact-check across the whole note. Up to
 * 10 claims verified in parallel server-side, so the call can take
 * 30–90 s. Kotlin sets a 120 s gRPC deadline; axios inherits the global
 * 60 s request timeout unless we override per-endpoint.
 */
export async function factCheckWholeNote(
  noteText: string,
  collectionIds: string[],
  includeWeb: boolean = true
): Promise<FactCheckWholeNoteResponse> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post(
    '/notes/assistant/fact-check-whole',
    {
      note_text: noteText,
      collection_ids: collectionIds,
      include_web: includeWeb,
      locale: getLocale(),
    },
    { timeout: 130000 }
  );
  return data;
}

// ─── 7.3 — Compose from Sources ───────────────────────────────────────────

export interface ComposedSource {
  source_number: number;
  document_id: string;
  collection_id: string;
  source_title: string;
  /** The chunk text actually used for grounding — surfaced in the
   *  dialog so the writer can verify a cite without leaving the
   *  editor. */
  chunk_text: string;
  chapter: string;
  page: string;
  citation: CitationMetadata | null;
}

export interface ComposeFromSourcesResponse {
  success: boolean;
  /** Markdown-ish prose with `[source-N]` markers in place. The
   *  caller rewrites markers to TipTap citation marks at insert
   *  time, mapping each marker to `sources[N-1].document_id`. */
  composed_text: string;
  sources: ComposedSource[];
  /** Machine-readable error code; empty when success=true. */
  error: string;
}

/**
 * 7.3 — RAG-grounded paragraph generation. Backend retrieves top-K
 * chunks across the picked collections then asks the LLM to write
 * `target_length` words tagging each substantive claim with
 * [source-N] markers.
 *
 * Single-shot for v1 (no streaming) — target lengths cap at ~1500
 * words which fits comfortably inside a buffered LLM call. Backend
 * deadline is 90 s; axios timeout overrides to 100 s for the same
 * reason factCheckWholeNote does.
 */
export async function composeFromSources(
  topicOrSection: string,
  collectionIds: string[],
  options?: {
    target_length?: 'short' | 'medium' | 'long';
    outline_section_anchor?: string;
    /** Up to ~4000 chars of text immediately BEFORE the caret. Drives
     *  the retrieval similarity search + the LLM continuation prompt. */
    text_before_cursor?: string;
    /** Up to ~4000 chars of text immediately AFTER the caret. Helps
     *  the model avoid repeating content that already follows. */
    text_after_cursor?: string;
  },
): Promise<ComposeFromSourcesResponse> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post(
    '/notes/assistant/compose-from-sources',
    {
      topic_or_section: topicOrSection,
      collection_ids: collectionIds,
      target_length: options?.target_length ?? 'medium',
      outline_section_anchor: options?.outline_section_anchor ?? '',
      text_before_cursor: options?.text_before_cursor ?? '',
      text_after_cursor: options?.text_after_cursor ?? '',
      language: getLocale(),
    },
    { timeout: 100000 },
  );
  return data;
}

// ─── 7.1 — AI Autocomplete (ghost text) ───────────────────────────────────

export interface GhostCompleteResponse {
  success: boolean;
  /** Empty string is a valid no-op (e.g. context too short, model
   *  returned nothing). Front-end shows nothing, no error toast. */
  suggestion: string;
  /** Machine-readable error code; "" when success=true. Special value
   *  "rate_limited" means the user has exceeded the 50/h cost-guard
   *  quota — UI shows a soft cooldown badge, not an error toast. */
  error: string;
  /** 7.1 cost guard — sliding-window quota counters. `quota_used`
   *  reflects autocomplete calls in the last hour for this user
   *  AFTER this call has been counted. `quota_limit` is the
   *  configured ceiling (currently 50/h). Both default to 0 if the
   *  backend chose not to track. */
  quota_used?: number;
  quota_limit?: number;
}

/**
 * 7.1 — Single short LLM continuation at the cursor. Designed for
 * inline ghost-text UX: caller debounces typing, decoration renders
 * suggestion at 0.4 opacity, Tab inserts and anything else dismisses.
 *
 * Backend deadline is 4 s; we set axios timeout slightly higher
 * (5 s) so a slow network round-trip doesn't pre-empt the server's
 * own timeout-and-fallback. Empty `suggestion` is normal — never
 * surface as an error.
 */
export async function ghostCompleteNote(
  textBeforeCursor: string,
  textAfterCursor: string,
  noteOutline: string = '',
): Promise<GhostCompleteResponse> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post(
    '/notes/assistant/ghost-complete',
    {
      text_before_cursor: textBeforeCursor,
      text_after_cursor: textAfterCursor,
      note_outline: noteOutline,
      language: getLocale(),
    },
    { timeout: 5000 },
  );
  return data;
}

// ─── 7.7 — Thought Partner ────────────────────────────────────────────────

export interface CritiqueWithQuestionsResponse {
  success: boolean;
  /** Pre-formatted markdown ready to drop into a TipTap callout block:
   *  "1. …\n2. …" — already escaped where needed. Empty when success=false. */
  formatted_questions: string;
  /** Same questions split apart for callers that want to render each as
   *  its own chip (e.g. drill-in buttons). */
  questions: string[];
  /** Machine-readable error code; "" when success=true. */
  error: string;
}

/**
 * 7.7 — Thought Partner. Returns 3-5 short questions that probe the
 * draft's reasoning. Single-shot, retrieval-free; safe to call against
 * an empty note (returns success=false, error='empty_note').
 */
export async function critiqueWithQuestions(
  noteText: string,
): Promise<CritiqueWithQuestionsResponse> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post('/notes/assistant/critique-with-questions', {
    note_text: noteText,
    language: getLocale(),
  });
  return data;
}
