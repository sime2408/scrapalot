/**
 * Podcast / NotebookLM-style audio overview API. The backend lives at Python
 * directly (gateway route `python-podcast`), not at Kotlin, so these helpers
 * hit `/api/v1/podcast/*` through the standard apiClient axios instance.
 */

import { apiClient } from '@/lib/api';

export interface PodcastRecord {
  podcast_id: string;
  collection_id?: string;
  user_id?: string;
  language: string;
  status: 'pending' | 'generating_script' | 'rendering_audio' | 'completed' | 'failed';
  title: string | null;
  file_path: string | null;
  file_size: number | null;
  duration_ms: number | null;
  script?: Array<{ speaker: 'A' | 'B'; text: string }>;
  error: string | null;
  created_at: string | null;
  completed_at: string | null;
}

export async function startPodcastGeneration(
  collectionId: string,
  userId: string,
  language: string
): Promise<{ podcast_id: string; status: string; error?: string }> {
  const { data } = await apiClient.post('/podcast/generate', {
    collection_id: collectionId,
    user_id: userId,
    language,
  });
  return data;
}

export async function getPodcast(podcastId: string): Promise<PodcastRecord> {
  const { data } = await apiClient.get<PodcastRecord>(`/podcast/${podcastId}`);
  return data;
}

export async function listCollectionPodcasts(collectionId: string): Promise<PodcastRecord[]> {
  const { data } = await apiClient.get<{ podcasts: PodcastRecord[] }>(
    `/podcast/collection/${collectionId}`
  );
  return data.podcasts || [];
}

/**
 * Absolute URL for the audio stream endpoint. Not fetched via axios because
 * an HTML5 <audio> tag streams the file directly — we just need the URL.
 */
export function getPodcastAudioUrl(podcastId: string): string {
  // apiClient.defaults.baseURL is something like `https://scrapalot.app/api/v1`.
  const base = (apiClient.defaults.baseURL || '').replace(/\/$/, '');
  return `${base}/podcast/${podcastId}/audio`;
}
