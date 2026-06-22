/**
 * Utilities for cleaning up source titles that come back from the backend.
 *
 * Backend often returns the full on-disk path as `source_title`
 * (e.g. `/app/data/upload/<user>/<workspace>/<collection>/<file>.pdf`).
 * Panels should show a human-readable filename instead.
 */

const FILE_EXTENSIONS = /\.(pdf|epub|docx?|txt|md|html?|rtf|odt|pptx?)$/i;

/**
 * Clean a source_title/path coming from the backend into a display title.
 *
 * Strategy:
 *  - If the value looks like a path, take the basename
 *  - Strip a common document extension (.pdf, .epub, .docx, ...)
 *  - Replace underscores / hyphens with spaces
 *  - Collapse repeated whitespace
 *  - Trim length to a sane default with an ellipsis when truncated
 */
export function cleanSourceTitle(source: string | null | undefined, maxLength = 120): string {
  if (!source) return '';
  const raw = String(source).trim();
  if (!raw) return '';

  // Take the last path segment if it looks like a path
  const basename = /[\\/]/.test(raw) ? (raw.split(/[\\/]/).pop() || raw) : raw;

  // Remove known document extensions
  const withoutExt = basename.replace(FILE_EXTENSIONS, '');

  // Replace underscores / hyphens with spaces, collapse whitespace
  const prettified = withoutExt.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

  const result = prettified || basename;
  if (result.length <= maxLength) return result;
  return result.slice(0, maxLength - 1).trimEnd() + '…';
}
