/**
 * Agent profiles API client (read-only v1).
 */
import { apiClient } from '@/lib/api';

export interface AgentProfile {
  id: string;
  workspace_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  system_prompt: string;
  rag_strategy: string | null;
  citation_style: string | null;
  tool_allowlist: string | null;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export async function listAgentProfiles(workspaceId?: string): Promise<AgentProfile[]> {
  try {
    const url = workspaceId
      ? `/agent-profiles?workspace_id=${encodeURIComponent(workspaceId)}`
      : '/agent-profiles';
    const { data } = await apiClient.get(url);
    return (data?.profiles as AgentProfile[]) || [];
  } catch (err) {
    console.warn('[agent-profiles] list failed:', err);
    return [];
  }
}
