import { TFunction } from 'i18next';

const PLAIN_CODE = /^[a-z][a-zA-Z0-9_]*$/;
const PARAMETRIZED_CODE = /^([a-z][a-zA-Z0-9_]*)((?::[^:]+)+)$/;

/**
 * Translate a backend `knowledge.uploader.<code>` status message.
 *
 * Backend emits camelCase codes (CLAUDE.md rule #3) — either plain
 * (`errorWorkerDied`, `embeddingChunks`) or parametrized
 * (`embeddingBatch:9:22`, `lowExtractionYield:1234:567:42`). Plain
 * codes resolve via `t('knowledge.uploader.<code>')`. Parametrized
 * codes pass the colon-separated tail as positional placeholders
 * (`{{0}}`, `{{1}}`, …) so the i18n string can interpolate them.
 *
 * Anything that does not match a code shape (raw English, third-party
 * exception text) passes through unchanged so admins still see
 * diagnostic info.
 */
export function translateBackendStatus(
  raw: string | undefined | null,
  t: TFunction,
): string | null {
  if (!raw) return null;
  if (PLAIN_CODE.test(raw)) {
    return t(`knowledge.uploader.${raw}`, raw);
  }
  const m = PARAMETRIZED_CODE.exec(raw);
  if (m) {
    const code = m[1];
    const parts = m[2].slice(1).split(':');
    const replacements: Record<string, string> = { defaultValue: raw };
    parts.forEach((v, i) => { replacements[String(i)] = v; });
    return t(`knowledge.uploader.${code}`, replacements);
  }
  return raw;
}
