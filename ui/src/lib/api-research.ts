import { apiClient } from './api';

/**
 * Research Plan interface
 */
export interface ResearchPlan {
  id: string;
  session_id: string;
  message_id: string;
  query: string;
  methodology: string;
  sections: Record<string, unknown>;
  complexity_score: number;
  status: string;
  progress: number;
  error_message?: string;
  created_at: string;
  updated_at: string;
  discoveries?: Array<{
    title: string;
    claim: string;
    summary: string;
    evidence_count?: number;
    confidence: number;
    category: string;
    novelty_assessment?: string;
    sources?: Array<{ url?: string; title?: string; doi?: string }>;
    tags?: string[];
  }>;
}

/**
 * Research Synthesis interface
 */
export interface ResearchSynthesis {
  id: string;
  plan_id: string;
  title: string;
  executive_summary?: string;
  main_content?: string;
  sections: Record<string, unknown>;
  conclusions: string[];
  limitations: string[];
  recommendations: string[];
  citations: Array<{ id: string; title: string; url?: string }>;
  bibliography: Array<{ entry: string }>;
  quality_score: number;
  quality_dimensions: Record<string, number>;
  word_count: number;
  total_sources_used: number;
  created_at: string;
}

/**
 * Research Source interface
 */
export interface ResearchSource {
  id: string;
  url: string;
  title?: string;
  domain?: string;
  source_type?: string;
  content_snippet?: string;
  credibility_score: number;
  used_in_synthesis: boolean;
  citation_count: number;
}

/**
 * Full Research Response including plan, synthesis, and sources
 */
export interface FullResearchResponse {
  plan: ResearchPlan;
  synthesis?: ResearchSynthesis;
  sources: ResearchSource[];
}

/**
 * Gets complete research data by plan ID
 * @param planId UUID of the research plan
 * @returns Full research data including plan, synthesis, and sources
 */
export const getResearchByPlanId = async (
  planId: string
): Promise<FullResearchResponse | null> => {
  try {
    const response = await apiClient.get(`/research/by-plan/${planId}`);

    if (response.status === 200) {
      return response.data;
    }

    return null;
  } catch (error) {
    console.error('Error fetching research by plan ID:', error);
    return null;
  }
};

/**
 * Gets all research plans for a session
 * @param sessionId UUID of the chat session
 * @returns Array of research plans for the session
 */
export const getSessionResearchPlans = async (
  sessionId: string
): Promise<ResearchPlan[]> => {
  try {
    const response = await apiClient.get(`/research/session/${sessionId}`);

    if (response.status === 200) {
      return response.data;
    }

    return [];
  } catch (error) {
    console.error('Error fetching session research plans:', error);
    return [];
  }
};

/**
 * Research Template interface
 */
export interface ResearchTemplate {
  id: string;
  name: string;
  description: string;
  template_type: string;
  methodology: string;
  depth: number;
  breadth: number;
  source_types: string[];
  output_format: string;
  clarification_categories: string[];
  tone: string;
  max_iterations: number;
  is_default: boolean;
  citation_style: string;
  quality_standards: Record<string, number>;
}


/**
 * Get all system research templates
 */
export const getResearchTemplates = async (): Promise<ResearchTemplate[]> => {
  const response = await apiClient.get('/research/templates');
  return response.data.templates || [];
};

export interface ActiveResearch {
  found: boolean;
  research_id?: string;
  status?: string;
  progress?: number;
  current_phase?: string;
  started_at?: string;
  query?: string;
}

/**
 * Check whether the user has a deep-research run currently active.
 *
 * Scoped to the given chat session, but the backend ALSO falls back to a
 * user-scoped lookup (across all of the user's sessions) when the session has
 * nothing running — so a second device / browser logged in as the same user
 * still sees the in-progress run. Pass an empty `sessionId` when no session is
 * in the URL (e.g. /dashboard root) to get the pure user-scoped result.
 *
 * Also used on mount to decide whether to keep the persisted panel + chat
 * loading state alive after a Chrome refresh.
 */
export const getActiveResearch = async (sessionId?: string): Promise<ActiveResearch> => {
  const response = await apiClient.get('/research/active', { params: { session_id: sessionId ?? '' } });
  return response.data;
};

/**
 * Cooperative cancel: backend sets a Redis flag the orchestrator polls at
 * every phase boundary. The running research will emit a `research_cancelled`
 * status packet and a `stream_end` with reason="cancelled" shortly after.
 */
export const cancelActiveResearch = async (researchId: string): Promise<{ cancelled: boolean; previous_status?: string | null }> => {
  const response = await apiClient.post('/research/cancel', { research_id: researchId });
  return response.data;
};
