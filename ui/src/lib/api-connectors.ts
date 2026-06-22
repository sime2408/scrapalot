/**
 * Connectors API client for managing external data source connectors.
 * Workspace-level connectors with flexible sync destinations.
 * Backend: src/main/controllers/workspace_connectors.py
 */

import { API_BASE_URL } from './api';

// ==================== Enums ====================

export enum SyncStatus {
  PENDING = 'pending',
  SYNCING = 'syncing',
  SYNCED = 'synced',
  FAILED = 'failed',
}

export enum DestinationType {
  WORKSPACE = 'workspace',
  COLLECTION = 'collection',
}

// ==================== Types ====================

/** Available connector types with metadata */
export interface AvailableConnector {
  name: string;
  description: string;
  requires_oauth: boolean;
  supports_auto_sync: boolean;
  class: string;
}

/** Connector configuration */
export interface ConnectorCreate {
  name: string;
  source: string;
  workspace_id: string;
  credential_id?: string;
  connector_specific_config?: Record<string, unknown>;
}

export interface ConnectorUpdate {
  name?: string;
  enabled?: boolean;
  connector_specific_config?: Record<string, unknown>;
}

/** Connector response from API */
export interface Connector {
  id: string;
  name: string;
  source: string;
  workspace_id: string;
  user_id: string;
  enabled: boolean;
  last_sync_at?: string;
  documents_synced: number;
  credential_id?: string;
  connector_specific_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Sync destination configuration */
export interface SyncDestinationCreate {
  destination_type: DestinationType;
  destination_id?: string;
  sync_enabled: boolean;
  auto_sync: boolean;
  sync_frequency_minutes?: number;
}

export interface SyncDestination {
  id: string;
  connector_id: string;
  destination_type: string;
  destination_id?: string;
  sync_enabled: boolean;
  auto_sync: boolean;
  sync_frequency_minutes?: number;
  last_synced_at?: string;
  next_sync_at?: string;
  created_at: string;
}

/** File sync status */
export interface FileSync {
  id: string;
  sync_destination_id: string;
  file_id: string;
  file_name: string;
  file_path?: string;
  file_type?: string;
  file_size?: number;
  sync_status: SyncStatus;
  error_message?: string;
  document_id?: string;
  last_synced_at?: string;
}

/** OAuth flow */
export interface OAuthStateCreate {
  source: string;
  workspace_id: string;
  redirect_uri?: string;
  name?: string;
  client_id?: string;
  client_secret?: string;
}

export interface OAuthStateResponse {
  authorization_url: string;
  state: string;
}

export interface OAuthCallbackRequest {
  code: string;
  state: string;
}

export interface OAuthCallbackResponse {
  success: boolean;
  credential_id: string;
  workspace_id: string;
  source: string;
}

/** Sync trigger response */
export interface SyncTriggerResponse {
  success: boolean;
  message: string;
  task_id: string;
  connector_id: string;
  destination_id: string;
}

// ==================== API Functions ====================

/**
 * Create a new connector
 */
export async function createConnector(
  workspaceId: string,
  data: ConnectorCreate
): Promise<Connector> {
  const response = await fetch(`${API_BASE_URL}/workspaces/${workspaceId}/connectors`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Failed to create connector: ${response.statusText}`);
  }

  return response.json();
}

/**
 * List connectors for a workspace
 */
export async function listWorkspaceConnectors(workspaceId: string): Promise<Connector[]> {
  const response = await fetch(`${API_BASE_URL}/workspaces/${workspaceId}/connectors`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list connectors: ${response.statusText}`);
  }

  const data = await response.json();
  
  // Handle both array and object responses
  if (Array.isArray(data)) {
    return data;
  }
  
  // If the response is an object with a connectors property
  if (data && Array.isArray(data.connectors)) {
    return data.connectors;
  }
  
  // If no connectors found, return empty array
  return [];
}


/**
 * Delete a connector
 */
export async function deleteConnector(connectorId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/connectors/${connectorId}`, {
    method: 'DELETE',
    headers: {
      Authorization: getAuthHeader(),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete connector: ${response.statusText}`);
  }
}

// ==================== Sync Destinations ====================

/**
 * List sync destinations for a connector
 */
export async function listSyncDestinations(connectorId: string): Promise<SyncDestination[]> {
  const response = await fetch(`${API_BASE_URL}/connectors/${connectorId}/destinations`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list sync destinations: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Trigger manual sync for a destination
 */
export async function triggerSync(
  connectorId: string,
  destinationId: string,
  force: boolean = false
): Promise<SyncTriggerResponse> {
  const params = new URLSearchParams();
  if (force) params.append('force', 'true');

  const url = `${API_BASE_URL}/connectors/${connectorId}/destinations/${destinationId}/sync${
    params.toString() ? `?${params.toString()}` : ''
  }`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to trigger sync: ${response.statusText}`);
  }

  return response.json();
}

// ==================== OAuth ====================

/**
 * Initiate OAuth flow
 */
export async function initiateOAuth(data: OAuthStateCreate): Promise<OAuthStateResponse> {
  const response = await fetch(`${API_BASE_URL}/connectors/oauth/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || `Failed to initiate OAuth: ${response.statusText}`);
  }

  return response.json();
}

// ==================== Helper ====================

/**
 * Get authorization header from stored tokens
 */
function getAuthHeader(): string {
  try {
    // Try localStorage first
    const authTokens = localStorage.getItem('auth_tokens');
    if (authTokens) {
      const tokens = JSON.parse(authTokens);
      if (tokens.access_token) {
        return `Bearer ${tokens.access_token}`;
      }
    }

    // Try sessionStorage
    const sessionTokens = sessionStorage.getItem('auth_tokens');
    if (sessionTokens) {
      const tokens = JSON.parse(sessionTokens);
      if (tokens.access_token) {
        return `Bearer ${tokens.access_token}`;
      }
    }
  } catch (error) {
    console.error('Error getting auth header:', error);
  }

  return '';
}
