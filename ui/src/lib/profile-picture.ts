import { getStaticBaseUrl, PROD_STATIC_BASE_URL } from '@/lib/api';

/**
 * Build a full URL for a user's profile picture. Accepts either an absolute
 * http(s) URL, a stored filename (e.g. "abc123.jpg"), or a relative path
 * starting with "data/upload/…". Returns undefined when no picture is set.
 *
 * Production stores pictures under `${uploadPath}/profile_pictures/` and
 * exposes them via the public `/upload/profile_pictures/{filename}` endpoint
 * (Kotlin `StaticFileController`, also Python FastAPI `/upload` static mount
 * when local dev points at port 8090). The earlier attempt to serve via
 * `/api/v1/users/profile-pictures/` broke prod because the Kotlin
 * `UserController` GET handler reads from a flat `${uploadPath}/{filename}`
 * path that does not match where the files actually live.
 *
 * In local development the file only exists on whichever static host
 * `getStaticBaseUrl()` resolves to (localhost). When a picture was uploaded on
 * production it is absent from the local disk and would 404. Use
 * `profilePicSources()` for a local-first URL plus a production fallback so the
 * picture shows up locally regardless of where the file physically lives.
 */
export interface ProfilePicSources {
  /** Primary (locally-configured) URL — tried first. */
  src?: string;
  /**
   * Production fallback URL — used by the renderer when `src` fails to load.
   * Undefined when it would equal `src` (production, or an absolute http pic),
   * so callers can skip the fallback wiring entirely.
   */
  fallbackSrc?: string;
}

/** Map a stored picture reference to its path under the static host. */
function buildProfilePath(pic: string): string {
  const clean = pic.replace(/^\/+/, '');
  // Legacy/raw paths already carry the full upload prefix.
  if (clean.startsWith('data/upload/')) return clean;
  return `upload/profile_pictures/${clean}`;
}

/** Append a cache-busting query param (used after a fresh upload). */
function withCacheBuster(url: string, cacheBuster?: number): string {
  return typeof cacheBuster === 'number' ? `${url}?t=${cacheBuster}` : url;
}

/**
 * Local-first sources for a profile picture: `src` points at the
 * locally-configured static host, `fallbackSrc` at the production host. The
 * renderer (`AvatarImage` with `fallbackSrc`, or `ProfileImg`) tries `src`
 * first and swaps to `fallbackSrc` on load error.
 *
 * `fallbackSrc` is omitted when it equals `src` — i.e. in production (where
 * `getStaticBaseUrl()` already returns the production host) or for an absolute
 * http picture — so the fallback never fires and never double-loads there.
 */
export function profilePicSources(
  pic: string | null | undefined,
  cacheBuster?: number,
): ProfilePicSources {
  if (!pic) return {};
  if (pic.startsWith('http')) return { src: withCacheBuster(pic, cacheBuster) };

  const path = buildProfilePath(pic);
  const src = withCacheBuster(`${getStaticBaseUrl()}/${path}`, cacheBuster);
  const remote = withCacheBuster(`${PROD_STATIC_BASE_URL}/${path}`, cacheBuster);
  return { src, fallbackSrc: remote === src ? undefined : remote };
}
