/**
 * Client helpers for the live voice mode endpoints (Scite follow-up).
 *
 *   /api/v1/voice/transcribe  — multipart audio blob → {text, language, byok_used}
 *   /api/v1/voice/synthesize  — {text, language} → MP3 stream (binary blob)
 *
 * Both routes go direct to the Python backend via the `python-voice` gateway
 * route; the UI hits them through the normal apiClient axios instance so JWT
 * auth + base URL + rate limiting all stay consistent with the rest of the
 * app.
 */

import { apiClient, API_BASE_URL } from '@/lib/api';

export interface TranscribeResult {
  text: string;
  language?: string;
  duration_s?: number;
  byok_used?: boolean;
  error?: string;
}

/**
 * Send a recorded audio blob (WebM/Opus from MediaRecorder by default on
 * Chromium, MP4 on Safari) to Whisper. The server resolves the API key:
 * prefers the user's `settings_general.voice_openai_api_key` (BYOK), falls
 * back to Scrapalot's system Whisper key.
 */
export async function transcribeVoiceClip(
  blob: Blob,
  userId: string,
  language?: string,
  focusDocumentId?: string,
): Promise<TranscribeResult> {
  const form = new FormData();
  form.append('audio', blob, 'voice.webm');
  form.append('user_id', userId);
  if (language) form.append('language', language);
  // When the user is focused on one book, bias Whisper toward that book's
  // title + graph entities so its proper nouns ("Baal", "Goetia") transcribe
  // right — scoped per-book, no static vocabulary.
  if (focusDocumentId) form.append('focus_document_id', focusDocumentId);

  const { data } = await apiClient.post<TranscribeResult>('/voice/transcribe', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    // Explicitly opt out of the axios response cache — every transcription is unique.
    transformRequest: (d) => d,
  });
  return data;
}

/**
 * Semantic endpointing: ask the backend whether a transcribed utterance is a
 * finished thought (true) or was cut off when the speaker paused to think
 * (false). The voice client uses this to stitch a paused-mid-sentence question
 * ("what do you know about… <pause> …Baal") into one turn instead of sending a
 * half-sentence. Fails open (returns true) so a hiccup never strands the user.
 */
export async function judgeTurnComplete(text: string): Promise<boolean> {
  try {
    const { data } = await apiClient.post<{ complete?: boolean }>(
      '/voice/turn-complete',
      { text },
    );
    return data?.complete !== false;
  } catch {
    return true;
  }
}

/**
 * Low-latency conversational LLM reply. Skips the full RAG / tools / session
 * pipeline the normal chat uses (60–300 s per turn → 1–3 s here), at the
 * cost of losing citations + document grounding. Right tradeoff for voice
 * mode: a voice exchange that takes a minute feels broken.
 */
export async function voiceChatReply(
  text: string,
  language?: string,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  options?: {
    collectionIds?: string[];
    documentIds?: string[];
    userId?: string;
    workspaceId?: string;
  },
): Promise<{
  text: string;
  used_rag?: boolean;
  error?: string;
  /** Server-side hint that the agent activated one or more books as the
   *  conversation focus (via set_book_focus). Persist this set on the
   *  client and replay it as `documentIds` on subsequent turns so the
   *  phase-1 grep/cat/get_book_summary tools stay armed for the same
   *  books without needing an @-tag from the user. */
  focused_document_ids?: string[];
  /** Companion to `focused_document_ids`: {document_id, title} pairs the
   *  voice dialog feeds into BookThumbCard so the user sees a thumbnail
   *  badge for every book the agent put in focus. */
  focused_books?: Array<{ document_id: string; title: string }>;
}> {
  const { data } = await apiClient.post<{
    text: string;
    used_rag?: boolean;
    error?: string;
    focused_document_ids?: string[];
    focused_books?: Array<{ document_id: string; title: string }>;
  }>(
    '/voice/chat',
    {
      text,
      language: language || 'en',
      history: history || [],
      // Server attaches the optional retrieval tools only when BOTH the scope
      // (collection or document) AND `user_id` are present. Without them the
      // agent stays on the fast memory-only path.
      collection_ids: options?.collectionIds || [],
      // When document_ids are set the server registers lexical tools
      // (grep_search + cat_document) against documents.content — preferred for
      // hands-free "talk to a book" mode where the user wants verbatim
      // surrounding context, not similarity-only chunks.
      document_ids: options?.documentIds || [],
      user_id: options?.userId || '',
      // workspace_id unlocks the workspace-introspection tool block on the
      // server (list_workspace_collections, list_documents_in_collection,
      // search_documents_by_metadata, list_user_papers,
      // get_workspace_overview). Without it the agent only sees the
      // tagged-book / collection scope.
      workspace_id: options?.workspaceId || '',
    },
  );
  return data;
}

/**
 * Streaming variant of `voiceChatReply`. Same endpoint (`/voice/chat`), same
 * request body, plus `stream: true` flips the server into Server-Sent Events
 * mode. The server emits four event kinds:
 *
 *   - `phase`  {tool, label, stage}  one pair per tool call (start / done)
 *   - `text`   {delta}                token-level streaming reply text
 *   - `final`  {text, used_rag, focused_document_ids, focused_books}
 *                                     identical shape to the non-stream JSON
 *   - `done`   {}                     terminal marker
 *
 * The caller passes a `callbacks` bag; we never throw on a missing handler.
 * AbortController is honoured if `signal` is supplied (dialog close mid-turn
 * stops the underlying fetch and the agent on the server gives up its
 * remaining tool calls).
 */
export type VoiceChatPhase = {
  tool: string;
  label?: string;
  stage: 'start' | 'done';
};
export type VoiceChatFinal = {
  text: string;
  used_rag?: boolean;
  focused_document_ids?: string[];
  focused_books?: Array<{ document_id: string; title: string }>;
};
export async function voiceChatReplyStream(
  text: string,
  language: string | undefined,
  history: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
  options: {
    collectionIds?: string[];
    documentIds?: string[];
    userId?: string;
    workspaceId?: string;
  },
  callbacks: {
    onPhase?: (phase: VoiceChatPhase) => void;
    onText?: (delta: string) => void;
    onFinal: (final: VoiceChatFinal) => void;
    onError?: (error: string) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const auth = apiClient.defaults.headers.common['Authorization'] as string | undefined;
  const response = await fetch(`${API_BASE_URL}/voice/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify({
      text,
      language: language || 'en',
      history: history || [],
      collection_ids: options.collectionIds || [],
      document_ids: options.documentIds || [],
      user_id: options.userId || '',
      workspace_id: options.workspaceId || '',
      stream: true,
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`voice_chat_stream_${response.status}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let eventType = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      // SSE frames are separated by blank lines. Split on `\n` and walk
      // line-by-line; a blank line flushes the current event.
      let lineEnd = buffer.indexOf('\n');
      while (lineEnd !== -1) {
        const rawLine = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line === '') {
          eventType = '';
        } else if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const dataStr = line.slice(6);
          try {
            const data = JSON.parse(dataStr);
            if (eventType === 'phase' && callbacks.onPhase) {
              callbacks.onPhase(data as VoiceChatPhase);
            } else if (eventType === 'text' && callbacks.onText) {
              callbacks.onText(typeof data?.delta === 'string' ? data.delta : '');
            } else if (eventType === 'final') {
              callbacks.onFinal(data as VoiceChatFinal);
            } else if (eventType === 'error' && callbacks.onError) {
              callbacks.onError(typeof data?.error === 'string' ? data.error : 'stream_error');
            }
          } catch {
            // Malformed JSON in a data: line — log and keep going. Robust
            // parsing matters more than aborting the whole stream.
            // eslint-disable-next-line no-console
            console.warn('voice stream: failed to parse data line', dataStr);
          }
        }
        lineEnd = buffer.indexOf('\n');
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Synthesize a short reply line via Edge-TTS. Returns a Blob the caller drops
 * straight into an `<audio>` element (`URL.createObjectURL`).
 *
 * `speed` is a user-facing multiplier — 1.0 = normal, 0.5 = half speed,
 * 1.5 = 50% faster. Backend clamps to that range and maps to Edge-TTS
 * percent strings.
 */
export async function synthesizeVoice(text: string, language?: string, speed?: number): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/voice/synthesize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Reuse the JWT header the apiClient normally injects.
      Authorization: apiClient.defaults.headers.common['Authorization'] as string,
    },
    body: JSON.stringify({ text, language: language || 'en', speed: speed ?? 1.0 }),
  });
  if (!response.ok) throw new Error(`voice_synthesize_${response.status}`);
  return await response.blob();
}
