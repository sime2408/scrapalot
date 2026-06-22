// Re-export common API utilities and functions
export {
  API_BASE_URL,
  getAuthHeaders,
  streamChat,
  login,
  getCurrentUser,
  refreshToken,
  clearCache,
} from './api';

// Export provider management functions from api-settings
export {
  getModelProviders,
  createModelProvider,
  updateModelProvider,
} from './api-settings';

// Re-export types from the main api file
export type { AuthTokens } from '@/types';

// Import and re-export as namespaces for organized imports
import * as DocumentsAPI from './api-documents';
import * as CollectionsAPI from './api-collections';
import * as LLMInferenceAPI from './api-llm-inference';

// Re-export-specific document utilities that are used frequently
export {
  deleteDocument,
  getDocumentsByCollection,
  getSharedWebSocketConnection,
} from './api-documents';

// Re-export specific collection utilities that are used frequently
export { getCollections } from './api-collections';

// Re-export LLM inference API utilities
export { getModels } from './api-llm-inference';

// Re-export the API namespaces
export { DocumentsAPI, CollectionsAPI, LLMInferenceAPI };
