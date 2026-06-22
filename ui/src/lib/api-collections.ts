import { DocumentCollection } from '@/types';
import { apiClient, clearCache } from './api';

/**
 * Sort options for collections
 */
export type CollectionSortBy = 'name' | 'created_at';
export type CollectionSortOrder = 'asc' | 'desc';

/**
 * Response interface for paginated collections
 */
export interface CollectionsResponse {
  collections: DocumentCollection[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    has_more: boolean;
  };
}

/**
 * Get all collections for the current user or a specific workspace with pagination
 * @param workspaceId Optional workspace ID to filter collections
 * @param page Page number (default: 1)
 * @param limit Number of items per page (default: 20)
 * @param sortBy Field to sort by - 'name' or 'created_at' (default: 'name')
 * @param sortOrder Sort direction - 'asc' or 'desc' (default: 'asc')
 * @returns CollectionsResponse with collections and pagination info
 */
export async function getCollections(
  workspaceId?: string,
  page: number = 1,
  limit: number = 20,
  sortBy: CollectionSortBy = 'name',
  sortOrder: CollectionSortOrder = 'asc'
): Promise<CollectionsResponse> {
  try {
    // Build query parameters
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
      sort_by: sortBy,
      sort_order: sortOrder,
    });

    // If workspaceId provided, use workspace-specific api_base
    const api_base = workspaceId
      ? `/collections/workspace/${workspaceId}?${params}`
      : `/collections/?${params}`;

    const response = await apiClient.get(api_base);

    // Handle different response structures
    if (response.data && typeof response.data === 'object') {
      // Check if it's the new paginated format
      if ('collections' in response.data && 'pagination' in response.data) {
        return response.data as CollectionsResponse;
      }

      // Handle legacy format - if response has only collections property
      if ('collections' in response.data) {
        return {
          collections: response.data.collections,
          pagination: {
            page: 1,
            limit: response.data.collections.length,
            total: response.data.collections.length,
            has_more: false,
          },
        };
      }
    }

    // Handle legacy array format
    if (Array.isArray(response.data)) {
      return {
        collections: response.data,
        pagination: {
          page: 1,
          limit: response.data.length,
          total: response.data.length,
          has_more: false,
        },
      };
    }

    // If no valid format found, return empty result
    console.warn('Could not find collections in response:', response.data);
    return {
      collections: [],
      pagination: {
        page: 1,
        limit: 0,
        total: 0,
        has_more: false,
      },
    };
  } catch (error) {
    console.error('Error fetching collections:', error);
    throw error;
  }
}

/**
 * Check if a collection name already exists in the workspace
 * @param name Collection name to check
 * @param workspaceId Workspace ID to check within
 * @param excludeCollectionId Optional collection ID to exclude from check (for updates)
 * @returns Promise<boolean> true if name exists, false otherwise
 */
export async function checkCollectionNameExists(
  name: string,
  workspaceId: string,
  excludeCollectionId?: string
): Promise<boolean> {
  try {
    const response = await getCollections(workspaceId);
    const collections = response.collections;
    
    return collections.some(collection => 
      collection.name.toLowerCase() === name.toLowerCase() && 
      collection.id !== excludeCollectionId
    );
  } catch (error) {
    console.error('Error checking collection name:', error);
    // If we can't check, assume it doesn't exist to allow the backend to handle validation
    return false;
  }
}

/**
 * Create a new collection (knowledge stack)
 * @param data Object containing name, workspace_id, and optional description
 * @returns Promise<DocumentCollection>
 */
export async function createCollection(data: {
  name: string;
  workspace_id: string;
  description?: string;
  parentCollectionId?: string;
  // 0=none, 1=light, 2=full; null/undefined = inherit from parent.
  graphTier?: number | null;
}): Promise<DocumentCollection> {
  // Check for duplicate names before creating
  const nameExists = await checkCollectionNameExists(data.name, data.workspace_id);
  if (nameExists) {
    throw new Error(`A collection with the name '${data.name}' already exists in this workspace`);
  }

  try {
    // Send JSON as the Kotlin backend expects @RequestBody (snake_case due to global Jackson config).
    // graph_tier: send the number (0 is valid → use ?? not ||) or null (inherit).
    const response = await apiClient.post('/collections', {
      name: data.name,
      workspace_id: data.workspace_id,
      description: data.description || null,
      parent_collection_id: data.parentCollectionId || null,
      graph_tier: data.graphTier ?? null,
    });

    return response.data;
  } catch (error) {
    console.error('Error creating collection:', error);
    throw error;
  }
}

/**
 * Update an existing collection (knowledge stack)
 * @param collectionId ID of the collection to update
 * @param data Object containing name and optional description
 * @param workspaceId Workspace ID for duplicate name checking
 * @returns Promise<DocumentCollection>
 */
export async function updateCollection(
  collectionId: string,
  data: { name: string; description?: string; customInstructions?: string | null; graphTier?: number | null },
  workspaceId: string
): Promise<DocumentCollection> {
  // Check for duplicate names before updating (excluding current collection)
  const nameExists = await checkCollectionNameExists(data.name, workspaceId, collectionId);
  if (nameExists) {
    throw new Error(`A collection with the name '${data.name}' already exists in this workspace`);
  }

  try {
    // Three states for custom_instructions: undefined = field absent
    // (no change), "" = explicit wipe, "string" = replace. The backend
    // distinguishes the first two via the controller's explicitClear
    // branch. JSON.stringify drops undefined keys so the wire payload
    // matches.
    const payload: Record<string, unknown> = {
      name: data.name,
      description: data.description,
    };
    if (data.customInstructions !== undefined) {
      payload.custom_instructions = data.customInstructions ?? '';
    }
    // graph_tier: undefined = no change; null = reset to inherit (wire -1);
    // 0/1/2 = set explicit tier. Mirrors the Kotlin UpdateCollectionRequest contract.
    if (data.graphTier !== undefined) {
      payload.graph_tier = data.graphTier === null ? -1 : data.graphTier;
    }

    const response = await apiClient.put(`/collections/${collectionId}`, payload);

    // The 60-second response cache (api.ts) keeps GET /collections* in
    // memory across the app. Without busting it after a mutation, a
    // refresh inside the cache window serves the pre-mutation rows
    // (no custom_instructions) and the next reload of the dialog
    // shows an empty textarea. Match the pattern used by upload-side
    // invalidation in api.ts:392-398.
    clearCache('/collections/');

    return response.data;
  } catch (error) {
    console.error('Error updating collection:', error);
    throw error;
  }
}

/**
 * generate the AI-tailored "Custom Instructions"
 * baseline for a collection. The Python service auto-fills the
 * collection's description first if it has none yet, so the user
 * gets a one-click experience even on a fresh empty collection.
 *
 * Returns: { customInstructions, descriptionUsed, descriptionGenerated }
 *  - customInstructions: prose to drop into the textarea
 *  - descriptionUsed: the description the model used as input
 *  - descriptionGenerated: true when descriptionUsed was generated
 *    inline (caller should persist it back via updateCollection)
 */
export async function generateCollectionCustomInstructions(
  collectionId: string,
  language?: string,
): Promise<{
  customInstructions: string;
  descriptionUsed: string;
  descriptionGenerated: boolean;
}> {
  try {
    const url = language
      ? `/collections/${collectionId}/generate-custom-instructions?language=${encodeURIComponent(language)}`
      : `/collections/${collectionId}/generate-custom-instructions`;
    const response = await apiClient.post(url);
    if (response.data?.error) {
      throw new Error(String(response.data.error));
    }
    return {
      customInstructions: response.data.custom_instructions ?? '',
      descriptionUsed: response.data.description_used ?? '',
      descriptionGenerated: Boolean(response.data.description_generated),
    };
  } catch (error) {
    console.error('Error generating collection custom instructions:', error);
    throw error;
  }
}

/**
 * Generate an AI-powered description based only on collection name
 * @param collectionName Name of the collection
 * @returns Promise<string> Generated description
 */
export async function generateCollectionDescriptionFromName(
  collectionName: string
): Promise<string> {
  try {
    const formData = new FormData();
    formData.append('collection_name', collectionName);

    const response = await apiClient.post('/collections/generate-description-from-name', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data.description;
  } catch (error) {
    console.error('Error generating collection description from name:', error);
    throw error;
  }
}

/**
 * Generate an AI-powered description for a collection
 * @param collectionId ID of the collection
 * @returns Promise<string> Generated description
 */
export async function generateCollectionDescription(
  collectionId: string,
  existingDescription?: string
): Promise<string> {
  try {
    // Send the current editor text so the backend refines it (merging in book
    // summaries) rather than overwriting a possibly hand-written description.
    const response = await apiClient.post(`/collections/${collectionId}/generate-description`, {
      existing_description: existingDescription ?? '',
    });
    return response.data.description;
  } catch (error) {
    console.error('Error generating collection description:', error);
    throw error;
  }
}

/**
 * Move collection to a new parent (or root)
 * @param collectionId ID of the collection to move
 * @param parentCollectionId Target parent ID, or null to move to root
 */
export async function moveCollection(
  collectionId: string,
  parentCollectionId: string | null
): Promise<DocumentCollection> {
  const response = await apiClient.post(`/collections/${collectionId}/move`, {
    parent_collection_id: parentCollectionId,
  });
  return response.data;
}
