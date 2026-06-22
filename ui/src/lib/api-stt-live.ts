/**
 * Live STT (server-side streaming Whisper) API client.
 *
 * Wraps the three REST endpoints exposed by the Kotlin SttController:
 *
 *   POST /api/v1/stt/live/start    — open a Redis-backed session
 *   POST /api/v1/stt/live/chunk    — send accumulated audio so far,
 *                                     returns partial transcript
 *   POST /api/v1/stt/live/finish   — finalize, returns full transcript
 *
 * The protocol is "cumulative audio" — each chunk request sends the whole
 * recording from start to now, NOT just the delta since last chunk. The
 * server re-transcribes the whole clip each time and slices the result into
 * a stable ``committed_text`` and a still-being-refined ``mutable_text``
 * tail so the UI can show progressive transcription with the last few words
 * de-emphasised until they stabilise.
 */
import { apiClient, authState } from '@/lib/api';

export interface LiveSessionState {
  session_id: string;
  committed_text: string;
  mutable_text: string;
  transcript_text: string;
  language: string;
  last_chunk_index: number;
}

export interface FinishedTranscript {
  text: string;
  language: string;
  duration_s: number;
}

export async function startLiveSttSession(language?: string): Promise<LiveSessionState> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post<LiveSessionState>('/stt/live/start', {
    language: language ?? '',
  });
  return data;
}

/**
 * Send the cumulative audio recorded so far. The server expects a multipart
 * upload — pass the whole recording from t=0 each call so Whisper can
 * re-transcribe and refine the tail.
 */
export async function sendLiveSttChunk(
  sessionId: string,
  chunkIndex: number,
  audio: Blob,
  options: { isSilence?: boolean } = {},
): Promise<LiveSessionState> {
  await authState.waitForAuthReady();
  const form = new FormData();
  form.append('session_id', sessionId);
  form.append('chunk_index', String(chunkIndex));
  form.append('is_silence', options.isSilence ? 'true' : 'false');
  form.append('file', audio, 'chunk.wav');

  const { data } = await apiClient.post<LiveSessionState>('/stt/live/chunk', form, {
    params: {
      session_id: sessionId,
      chunk_index: chunkIndex,
      is_silence: options.isSilence ? 'true' : 'false',
    },
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function finishLiveSttSession(sessionId: string): Promise<FinishedTranscript> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.post<FinishedTranscript>('/stt/live/finish', {
    sessionId,
  });
  return data;
}
