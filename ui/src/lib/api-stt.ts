/**
 * STT (Speech-to-Text) API Client
 *
 * Supports file-based transcription and live streaming sessions via Redis-backed
 * progressive transcription on the backend.
 */

import { apiClient, authState } from './api';

/**
 * Transcript segment with timestamps
 */
export interface TranscriptSegment {
  text: string;
  start_s: number;
  end_s: number;
}

/**
 * File-based transcription response
 */
export interface TranscribeResponse {
  text: string;
  language: string;
  duration_s: number;
  segments: TranscriptSegment[];
  provider: string;
}

/**
 * Live session state returned by start/chunk/finish endpoints
 */
export interface LiveSessionState {
  session_id: string;
  committed_text: string;
  mutable_text: string;
  transcript_text: string;
  language: string;
  last_chunk_index: number;
}

/**
 * Final transcript from finishing a live session
 */
export interface FinishSessionResponse {
  text: string;
  language: string;
  duration_s: number;
}

/**
 * Transcribe an uploaded audio/video file (one-shot, non-streaming).
 *
 * Hits the Kotlin `/stt/transcribe` endpoint which forwards to the Python
 * SttService → Whisper. Large/video files are demuxed + chunked server-side.
 * Use a generous timeout: a few-minute clip can take a while on the model.
 */
export async function transcribeAudioFile(
  file: File,
  language?: string
): Promise<TranscribeResponse> {
  await authState.waitForAuthReady();

  const formData = new FormData();
  formData.append('file', file);
  if (language) formData.append('language', language);

  const response = await apiClient.post<TranscribeResponse>(
    '/stt/transcribe',
    formData,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,
    }
  );

  return response.data;
}

/**
 * Start a live transcription session.
 */
export async function startLiveSession(
  language?: string
): Promise<LiveSessionState> {
  await authState.waitForAuthReady();

  const response = await apiClient.post<LiveSessionState>(
    '/stt/live/start',
    language ? { language } : {}
  );

  return response.data;
}

/**
 * Send an audio chunk for live transcription.
 */
export async function sendAudioChunk(
  sessionId: string,
  chunkIndex: number,
  audioBlob: Blob,
  isSilence = false
): Promise<LiveSessionState> {
  await authState.waitForAuthReady();

  const formData = new FormData();
  formData.append('session_id', sessionId);
  formData.append('chunk_index', String(chunkIndex));
  formData.append('file', audioBlob, 'chunk.wav');
  formData.append('is_silence', String(isSilence));

  const response = await apiClient.post<LiveSessionState>(
    '/stt/live/chunk',
    formData,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 30000,
    }
  );

  return response.data;
}

/**
 * Finish a live session and get the final transcript.
 */
export async function finishLiveSession(
  sessionId: string
): Promise<FinishSessionResponse> {
  await authState.waitForAuthReady();

  const response = await apiClient.post<FinishSessionResponse>(
    '/stt/live/finish',
    { session_id: sessionId }
  );

  return response.data;
}
