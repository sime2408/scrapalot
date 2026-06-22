/**
 * Global concurrency-limited queue for document thumbnail fetches.
 *
 * The library view mounts one DocumentThumbnail per book with no
 * virtualization, so 100+ books each fire a `/documents/{id}/thumbnail`
 * request on mount. Every request is proxied Gateway → Kotlin → gRPC →
 * Python, and the CPU-capped Python gRPC server saturates: 60s axios
 * timeouts, DEADLINE_EXCEEDED storms, and broken-pipe errors as the browser
 * cancels the backlog mid-response.
 *
 * Funnelling every thumbnail fetch through this queue caps in-flight requests
 * so covers sharpen in progressively (a few at a time) instead of all at once,
 * and the collection-stats / document-list calls sharing the same gRPC path
 * are no longer starved.
 */

// Conservative cap: enough to keep covers filling in quickly while leaving
// gRPC headroom for the concurrent collection-stats / document-list calls.
const MAX_CONCURRENT = 5;

let active = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) {
    // Hand the slot directly to the next waiter — `active` stays unchanged,
    // since the waiter never incremented it on enqueue.
    next();
  } else {
    active--;
  }
}

/**
 * Run `task` once a queue slot is free. If `signal` aborts before the slot is
 * granted, the task is skipped (the slot is released immediately) so cards the
 * user scrolled past don't hold up the ones now on screen.
 */
export async function enqueueThumbnailFetch<T>(
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await acquire();
  try {
    if (signal?.aborted) {
      throw new DOMException('Thumbnail fetch aborted before start', 'AbortError');
    }
    return await task();
  } finally {
    release();
  }
}
