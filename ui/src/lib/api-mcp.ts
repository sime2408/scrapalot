/**
 * MCP integrations API client.
 *
 * Per-user MCP (Model Context Protocol) server integrations. When enabled, a
 * server's remote tools are injected into the user's chat agent. Backed by the
 * Kotlin controller at /api/v1/mcp-servers (snake_case JSON).
 */

import { apiClient, authState, clearCache } from './api';

/** The GET /mcp-servers response is cached for 60s by the axios interceptor;
 * bust it after every mutation so the next read reflects the change. */
const MCP_CACHE_KEY = '/mcp-servers';

export type McpTransport = 'http' | 'sse';

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  url: string;
  /** The auth token itself is never returned — only whether one is stored. */
  has_auth_token: boolean;
  headers: Record<string, string> | null;
  enabled: boolean;
  tool_prefix: string | null;
  description: string | null;
  cached_tools: Array<Record<string, unknown>> | null;
  last_connected_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface McpServerCreate {
  name: string;
  transport: McpTransport;
  url: string;
  auth_token?: string | null;
  headers?: Record<string, string> | null;
  enabled?: boolean;
  tool_prefix?: string | null;
  description?: string | null;
}

/** Partial update. Omit auth_token to keep the existing one; send "" to clear it. */
export interface McpServerUpdate {
  name?: string;
  transport?: McpTransport;
  url?: string;
  auth_token?: string | null;
  headers?: Record<string, string> | null;
  enabled?: boolean;
  tool_prefix?: string | null;
  description?: string | null;
}

export async function listMcpServers(): Promise<McpServer[]> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.get<McpServer[]>('/mcp-servers');
  return Array.isArray(data) ? data : [];
}

export async function createMcpServer(payload: McpServerCreate): Promise<McpServer> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post<McpServer>('/mcp-servers', payload);
  clearCache(MCP_CACHE_KEY);
  return data;
}

export async function updateMcpServer(
  id: string,
  payload: McpServerUpdate
): Promise<McpServer> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.put<McpServer>(`/mcp-servers/${id}`, payload);
  clearCache(MCP_CACHE_KEY);
  return data;
}

export async function deleteMcpServer(id: string): Promise<void> {
  await authState.waitForAuthReady();
  await apiClient.delete(`/mcp-servers/${id}`);
  clearCache(MCP_CACHE_KEY);
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpTestResult {
  ok: boolean;
  error: string;
  tools: McpToolInfo[];
}

/** Validate a remote MCP server and list its tools before saving. */
export async function testMcpConnection(payload: {
  transport: McpTransport;
  url: string;
  auth_token?: string | null;
  headers?: Record<string, string> | null;
  /** Test a saved server with its stored token (when no new token is provided). */
  server_id?: string | null;
}): Promise<McpTestResult> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post<McpTestResult>('/mcp-servers/test', payload);
  return data;
}
