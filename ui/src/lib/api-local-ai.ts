import { api, apiUrls } from './api';

/**
 * Get local service status
 */
export async function getLocalServiceStatus() {
  try {
    const response = await api.get(`${apiUrls.llmInference}/status`);
    return response.data;
  } catch (error) {
    console.error('Error fetching local service status:', error);
    throw error;
  }
}

