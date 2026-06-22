/**
 * Image generation API client.
 *
 * Posts a prompt to ``/api/v1/chat/generate/image`` and consumes the NDJSON
 * stream that comes back, surfacing each ``image_attached`` packet to the
 * caller as it arrives so a multi-image generation can render placeholders +
 * real tiles incrementally.
 */
import { apiClient, authState, getStaticBaseUrl } from '@/lib/api';
import type {
  ImageAttachedPacket,
  StatusPacket,
  StreamEndPacket,
  ErrorPacket,
} from '@/types/streaming-packets';

export interface GenerateImageInput {
  prompt: string;
  workspace_id?: string;
  session_id?: string;
  message_id: string;
  size?: string; // "1024x1024" | "1024x1792" | "1792x1024" | ...
  n?: number; // 1..4
  quality?: 'standard' | 'hd';
  model_override?: string;
}

export interface ImageGenerationCallbacks {
  onStatus?: (packet: StatusPacket) => void;
  onImage?: (packet: ImageAttachedPacket) => void;
  onError?: (packet: ErrorPacket) => void;
  onEnd?: (packet: StreamEndPacket) => void;
}

/**
 * Open the NDJSON stream and dispatch each packet to the appropriate callback.
 *
 * Returns a Promise that resolves when the stream closes (success or error).
 * Clients should treat ``onError`` as terminal — further packets will not arrive.
 */
export async function generateImage(
  input: GenerateImageInput,
  callbacks: ImageGenerationCallbacks,
): Promise<void> {
  await authState.waitForAuthReady();

  // Use the apiClient's auth header but stream the body directly via fetch — axios
  // doesn't expose a Web Streams reader on the response.
  const apiBase = (apiClient.defaults.baseURL ?? '').replace(/\/+$/, '');
  const url = `${apiBase || getStaticBaseUrl()}/chat/generate/image`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiClient.defaults.headers.common['Authorization'] as string,
    },
    body: JSON.stringify({
      prompt: input.prompt,
      workspace_id: input.workspace_id,
      session_id: input.session_id,
      message_id: input.message_id,
      size: input.size ?? '1024x1024',
      n: input.n ?? 1,
      quality: input.quality ?? 'standard',
      model_override: input.model_override,
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Image generation request failed: ${response.status} ${response.statusText}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // NDJSON: split on newline and parse each complete line.
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line) dispatchLine(line, callbacks);
      newlineIdx = buffer.indexOf('\n');
    }
  }

  // Flush trailing data.
  const trailing = buffer.trim();
  if (trailing) dispatchLine(trailing, callbacks);
}

function dispatchLine(line: string, callbacks: ImageGenerationCallbacks): void {
  let envelope: { obj?: { type?: string } } | undefined;
  try {
    envelope = JSON.parse(line);
  } catch {
    return; // ignore malformed line — never abort the stream
  }
  const obj = envelope?.obj;
  if (!obj || typeof obj.type !== 'string') return;

  switch (obj.type) {
    case 'status':
      callbacks.onStatus?.(obj as unknown as StatusPacket);
      break;
    case 'image_attached':
      callbacks.onImage?.(obj as unknown as ImageAttachedPacket);
      break;
    case 'error':
      callbacks.onError?.(obj as unknown as ErrorPacket);
      break;
    case 'stream_end':
      callbacks.onEnd?.(obj as unknown as StreamEndPacket);
      break;
    default:
      break;
  }
}

/**
 * Resolve a relative ``storage_path`` (e.g. ``generated/images/{user}/{m}.png``)
 * to a full URL routed through the document-file proxy. Always go through the
 * proxy so JWT auth is enforced and the same-origin policy keeps the URL
 * accessible to the browser without a separate CORS round-trip.
 */
export function imageStorageUrl(storagePath: string): string {
  const base = getStaticBaseUrl().replace(/\/+$/, '');
  const prefix = storagePath.startsWith('/') ? '' : '/';
  return `${base}/documents/file${prefix}${storagePath}`;
}
