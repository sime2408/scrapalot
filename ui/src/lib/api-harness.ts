/**
 * Harness Comparison API client (admin UI tab).
 *
 * Wraps the two Kotlin REST endpoints that proxy to the Python gRPC
 * AdminService:
 *
 *   POST /admin/harness/run       — fire-and-forget; returns run_id
 *   GET  /admin/harness/{runId}   — poll status + summary
 *
 * The Python side persists rows in `harness_comparison_runs` /
 * `harness_comparison_results`; the markdown report is pre-rendered
 * by `harness_report.render_markdown` so the UI can show it as-is.
 */

import { apiClient } from './api';

const BASE = '/admin/harness';

export interface HarnessRunRequest {
  eval_set_id?: string;
  retrievers?: string[];
  delivery_modes?: string[];
  prompt_variants?: string[];
  sample_size?: number;
  max_concurrent?: number;
}

export interface HarnessRunResponse {
  run_id: string;
  status: string;
  message?: string;
}

export interface HarnessRetrieverStat {
  retriever: string;
  n: number;
  mean_relevance: number;
  mean_groundedness: number;
  mean_citation_accuracy: number;
  mean_latency_ms: number;
  mean_cost_usd: number;
  length_normalised_relevance: number;
}

export interface HarnessPairwiseResult {
  retriever_a: string;
  retriever_b: string;
  n: number;
  mean_diff_relevance: number;
  t_statistic: number;
  p_value: number;
  significant: boolean;
}

export interface HarnessSummary {
  retriever_stats?: HarnessRetrieverStat[];
  ranking_by_relevance?: string[];
  pairwise?: HarnessPairwiseResult[];
  bonferroni_alpha?: number;
  pareto_frontier?: string[];
  cell_count?: number;
  questions_seen?: number;
  concurrency_peak?: number;
}

export interface HarnessRunDetail {
  run_id: string;
  // queued | running | done | failed | blocked_deploy_window
  status: string;
  started_at?: string;
  completed_at?: string;
  config?: Record<string, unknown> | null;
  summary?: HarnessSummary | null;
  markdown_report?: string;
  error_message?: string;
  message?: string;
}

export async function startHarnessRun(req: HarnessRunRequest): Promise<HarnessRunResponse> {
  const response = await apiClient.post<HarnessRunResponse>(`${BASE}/run`, req);
  return response.data;
}

export async function fetchHarnessRun(runId: string): Promise<HarnessRunDetail> {
  const response = await apiClient.get<HarnessRunDetail>(`${BASE}/${runId}`);
  return response.data;
}
