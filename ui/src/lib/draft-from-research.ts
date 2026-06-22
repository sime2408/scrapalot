/**
 * Draft From Research bridge.
 *
 * The deep research panel fires a CustomEvent carrying the completed
 * synthesis content; the notes drawer listens and opens with that content
 * pre-populated. Same decoupled pattern as `chat-with-document.ts`.
 */

export const DRAFT_FROM_RESEARCH_EVENT = 'scrapalot:draft-from-research' as const;

export interface DraftFromResearchPayload {
  /** The full markdown body to seed the note with. */
  markdown: string;
  /** Optional title that the notes drawer can use for the new note. */
  title?: string;
  /** Optional research session id for cross-reference. */
  researchSessionId?: string;
}

export type DraftFromResearchEvent = CustomEvent<DraftFromResearchPayload>;

/**
 * Build a structured markdown body from a deep-research synthesis object.
 * Lightweight — caller passes only the fields they have. Missing fields
 * are skipped silently.
 */
export function buildResearchDraft(synthesis: {
  title?: string;
  executive_summary?: string;
  main_content?: string;
  conclusions?: string[];
  recommendations?: string[];
}): string {
  const parts: string[] = [];
  if (synthesis.title) parts.push(`# ${synthesis.title}`);
  if (synthesis.executive_summary) {
    parts.push('## Executive summary', synthesis.executive_summary.trim());
  }
  if (synthesis.main_content) {
    parts.push('## Main content', synthesis.main_content.trim());
  }
  if (synthesis.conclusions && synthesis.conclusions.length > 0) {
    parts.push('## Key conclusions');
    parts.push(synthesis.conclusions.map((c) => `- ${c.trim()}`).join('\n'));
  }
  if (synthesis.recommendations && synthesis.recommendations.length > 0) {
    parts.push('## Recommendations');
    parts.push(synthesis.recommendations.map((r) => `- ${r.trim()}`).join('\n'));
  }
  return parts.join('\n\n').trim();
}

export function draftFromResearch(payload: DraftFromResearchPayload): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<DraftFromResearchPayload>(DRAFT_FROM_RESEARCH_EVENT, { detail: payload })
  );
}
