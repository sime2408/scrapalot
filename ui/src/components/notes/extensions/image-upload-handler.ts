/**
 * Image Upload Handler
 * Handles image uploads to the backend
 */

import { getStaticBaseUrl } from '@/lib/api';

// Resolve API base + auth token from the same storage axios uses so
// the fetch path picks up whatever the user is currently signed in as.
function getApiBase(): string {
  // Vite env var, falls back to the same default the axios instance uses
  return (import.meta.env.VITE_API_BASE_URL as string) || 'https://api.scrapalot.app/api/v1';
}

function getAuthToken(): string | null {
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem('auth_tokens');
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const tok = parsed?.access_token || parsed?.accessToken;
      if (typeof tok === 'string' && tok.length > 0) return tok;
    } catch {
      /* fall through */
    }
  }
  return null;
}

export interface UploadImageResult {
  url: string;
  filename: string;
}

/**
 * Resolve a server-relative upload path (e.g. "/upload/notes/images/…")
 * against the backend origin. Without this the browser would resolve
 * the relative URL against the SPA origin (scrapalot.app) instead of
 * api.scrapalot.app, and the <img> would hit the SPA fallback.
 */
function toAbsoluteUrl(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) {
    return url;
  }
  const base = getStaticBaseUrl().replace(/\/+$/, '');
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

export const uploadImage = async (file: File): Promise<UploadImageResult> => {
  // Validate file type
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
  if (!allowedTypes.includes(file.type)) {
    throw new Error('Invalid file type. Please upload an image (JPG, PNG, GIF, WEBP, or SVG).');
  }

  // Validate file size (10MB max)
  const maxSize = 10 * 1024 * 1024; // 10MB
  if (file.size > maxSize) {
    throw new Error('File size exceeds 10MB limit.');
  }

  const formData = new FormData();
  formData.append('file', file);

  // Native fetch — bypasses axios entirely because axios.create()
  // inherits a default `Content-Type: application/x-www-form-urlencoded`
  // for POST which a) overrides our undefined intent and b) strips the
  // multipart boundary the server needs to split parts (server then
  // returns 400 Bad Request before the controller even sees the
  // request). Native fetch + FormData always sets
  // `multipart/form-data; boundary=...XYZ` correctly and never adds a
  // body content-type guess of its own.
  const token = getAuthToken();
  const base = getApiBase();
  const res = await fetch(`${base}/notes/upload-image`, {
    method: 'POST',
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Upload failed: ${res.status} ${res.statusText}${errText ? ' — ' + errText : ''}`);
  }
  const data = (await res.json()) as UploadImageResult;
  return {
    ...data,
    url: toAbsoluteUrl(data.url),
  };
};
