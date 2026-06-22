/**
 * TTS (Text-to-Speech) API Client
 *
 * Uses edge-tts backend for high-quality speech synthesis with word-level timestamps.
 * This completely avoids Chrome's 15-second timeout bug by using pre-rendered audio.
 */

import { apiClient, authState } from './api';

/**
 * Word boundary for text highlighting synchronization
 */
export interface WordBoundary {
  text: string;
  offset: number; // Time offset in 100-nanosecond units (10,000 = 1ms)
  duration: number; // Duration in 100-nanosecond units
}

/**
 * TTS synthesis response
 */
export interface TTSResponse {
  audio: string; // Base64-encoded MP3 audio
  word_boundaries: WordBoundary[];
  duration_ms: number;
}

/**
 * TTS voice information
 */
export interface TTSVoice {
  name: string; // e.g., "en-US-AriaNeural"
  display_name: string;
  locale: string;
  gender: string;
  language: string;
}

/**
 * Convert text to speech using edge-tts backend
 *
 * @param text Text to convert to speech (max 50,000 characters)
 * @param voice Voice name (default: "en-US-AriaNeural")
 * @param rate Speech rate (e.g., "+50%", "-25%", default: "+0%")
 * @param pitch Speech pitch (e.g., "+10Hz", "-5Hz", default: "+0Hz")
 * @returns TTS response with audio and word boundaries
 */
export async function synthesizeSpeech(
  text: string,
  voice: string = 'en-US-AriaNeural',
  rate: string = '+0%',
  pitch: string = '+0Hz'
): Promise<TTSResponse> {
  await authState.waitForAuthReady();

  const response = await apiClient.post<TTSResponse>('/tts/synthesize', {
    text,
    voice,
    rate,
    pitch,
  }, {
    timeout: 180000, // 3 minutes — edge-tts synthesis with retry logic can take >60s for long texts
  });

  return response.data;
}

/**
 * Get list of available TTS voices
 *
 * @returns List of available voices
 */
export async function listTTSVoices(): Promise<TTSVoice[]> {
  await authState.waitForAuthReady();

  const response = await apiClient.get<{ voices: TTSVoice[] }>('/tts/voices');

  return response.data.voices;
}

/**
 * Convert base64 audio to Blob
 *
 * @param base64Audio Base64-encoded audio data
 * @returns Audio Blob (MP3)
 */
export function base64ToAudioBlob(base64Audio: string): Blob {
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: 'audio/mpeg' });
}

/**
 * Convert word boundary offset to milliseconds
 *
 * @param offset Offset in 100-nanosecond units
 * @returns Offset in milliseconds
 */
export function offsetToMs(offset: number): number {
  return offset / 10000.0;
}

/**
 * Split long text into chunks for TTS processing
 * (edge-tts supports up to 10,000 chars, but smaller chunks load faster)
 *
 * @param text Text to split
 * @param maxChars Maximum characters per chunk (default: 5000)
 * @returns Array of text chunks
 */
export function splitTextForTTS(text: string, maxChars: number = 5000): string[] {
  const chunks: string[] = [];

  // Split on sentence boundaries
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text];

  let currentChunk = '';
  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}
