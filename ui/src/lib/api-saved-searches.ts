import { api } from './api';

export interface SearchCondition {
  field:
    | 'title' | 'filename' | 'year' | 'author' | 'doi' | 'source_type' | 'processing_status' | 'tag'
    | 'created_at' | 'updated_at' | 'file_type' | 'page_count' | 'file_size' | 'collection_id'
    | 'has_summary' | 'graph_status' | 'savedSearch';
  operator:
    | 'contains' | 'equals' | 'gte' | 'lte' | 'exists' | 'not_exists'
    | 'isNot' | 'doesNotContain' | 'beginsWith'
    | 'isBefore' | 'isAfter' | 'isInTheLast'
    | 'isLessThan' | 'isGreaterThan';
  value: string;
}

export interface SearchCriteria {
  conditions: SearchCondition[];
  match: 'all' | 'any';
}

export interface SavedSearch {
  id: string;
  name: string;
  criteria: SearchCriteria;
  icon?: string | null;
  color?: string | null;
  sort_order?: number;
  is_pinned?: boolean;
  result_count?: number | null;
  last_evaluated_at?: string | null;
  created_at: string;
  updated_at?: string;
}

/** List all saved searches for the current workspace. */
export async function listSavedSearches(workspaceId: string): Promise<SavedSearch[]> {
  try {
    const response = await api.get('/saved-searches', { params: { workspace_id: workspaceId } });
    return response.data ?? [];
  } catch (err) {
    console.error('Failed to list saved searches:', err);
    return [];
  }
}

/** Create a new saved search. */
export async function createSavedSearch(
  workspaceId: string,
  name: string,
  criteria: SearchCriteria,
  color?: string,
): Promise<SavedSearch | null> {
  try {
    const response = await api.post('/saved-searches', {
      workspace_id: workspaceId,
      name,
      criteria_json: JSON.stringify(criteria),
      color,
    });
    return response.data?.search ?? response.data;
  } catch (err) {
    console.error('Failed to create saved search:', err);
    return null;
  }
}

/** Update an existing saved search. */
export async function updateSavedSearch(
  searchId: string,
  updates: {
    name?: string;
    criteria?: SearchCriteria;
    color?: string;
    is_pinned?: boolean;
  },
): Promise<SavedSearch | null> {
  try {
    const body: Record<string, unknown> = {};
    if (updates.name !== undefined) body.name = updates.name;
    if (updates.criteria !== undefined) body.criteria_json = JSON.stringify(updates.criteria);
    if (updates.color !== undefined) body.color = updates.color;
    if (updates.is_pinned !== undefined) body.is_pinned = updates.is_pinned;
    const response = await api.put('/saved-searches/' + searchId, body);
    return response.data?.search ?? response.data;
  } catch (err) {
    console.error('Failed to update saved search:', err);
    return null;
  }
}

/** Execute a saved search and get matching document IDs. */
export async function executeSavedSearch(searchId: string): Promise<string[]> {
  try {
    const response = await api.post('/saved-searches/' + searchId + '/execute');
    return response.data?.document_ids ?? [];
  } catch (err) {
    console.error('Failed to execute saved search:', err);
    return [];
  }
}

/** Preview search criteria — returns count of matching documents. */
export async function previewSavedSearch(workspaceId: string, criteria: SearchCriteria): Promise<number> {
  try {
    const response = await api.post('/saved-searches/preview', {
      workspace_id: workspaceId,
      criteria_json: JSON.stringify(criteria),
    });
    return response.data?.count ?? 0;
  } catch (err) {
    console.error('Failed to preview saved search:', err);
    return 0;
  }
}
