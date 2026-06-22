/**
 * Note Research Context — per-note scope that flows into every AI action
 * invoked from inside the note (Verify, Find Citation, Hypothesis,
 * Connect Dots, etc.).
 *
 * Persistence model (since commit aeafaa7, G Layer 1):
 *   - Server is source of truth: `notes.research_context` JSONB column
 *     (Liquibase 102) + GET/PUT /api/v1/notes/{id}/research-context.
 *   - localStorage is a synchronous-read cache, primarily so the pill has
 *     something to paint during the first frame before the async GET
 *     completes. A session-scoped draft (no note id yet) also lives in
 *     localStorage under the session id key.
 *   - `fetchNoteResearchContextFromServer` pulls the server value on
 *     note open and overwrites the local cache.
 *   - `saveNoteResearchContextToServer` debounces writes so rapid pill
 *     changes don't flood the backend — the caller drives the debounce.
 */

import { apiClient, authState } from './api';

const STORAGE_KEY = 'scrapalot_notes_research_context';

export interface NoteResearchContext {
  /** Selected collection IDs whose documents the AI should consult. */
  collectionIds: string[];
  /** Free-form connector ids — placeholder for backend wiring. */
  connectorIds?: string[];
  /** Web search on/off. */
  webSearchEnabled: boolean;
  /** Agentic routing toggle (mirrors the chat Knowledge Stacks setting). */
  agenticRoutingEnabled: boolean;
  /** When the user explicitly accepted an auto-detected context. */
  autoDetected?: boolean;
  /** Last-updated timestamp (epoch ms). */
  updatedAt: number;
}

export function emptyContext(): NoteResearchContext {
  return {
    collectionIds: [],
    connectorIds: [],
    webSearchEnabled: false,
    agenticRoutingEnabled: false,
    autoDetected: false,
    updatedAt: Date.now(),
  };
}

type Map = Record<string, NoteResearchContext>;

function readAll(): Map {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Map) : {};
  } catch {
    return {};
  }
}

function writeAll(map: Map): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota or disabled — silently ignore; context will simply not persist */
  }
}

export function getNoteResearchContext(noteId: string | null | undefined): NoteResearchContext {
  if (!noteId) return emptyContext();
  return readAll()[noteId] ?? emptyContext();
}

export function setNoteResearchContext(
  noteId: string | null | undefined,
  context: Partial<NoteResearchContext>
): NoteResearchContext {
  const next: NoteResearchContext = {
    ...emptyContext(),
    ...getNoteResearchContext(noteId),
    ...context,
    updatedAt: Date.now(),
  };
  if (!noteId) return next;
  const map = readAll();
  map[noteId] = next;
  writeAll(map);
  return next;
}

export function clearNoteResearchContext(noteId: string): void {
  const map = readAll();
  if (!(noteId in map)) return;
  delete map[noteId];
  writeAll(map);
}

/**
 * Fetch the server-persisted Research Context. Returns `null` when the
 * note has none set OR when the server call fails (caller falls back to
 * the local cache). Only valid UUID note ids hit the network; session-
 * draft ids are localStorage-only.
 */
export async function fetchNoteResearchContextFromServer(
  noteId: string | null | undefined
): Promise<NoteResearchContext | null> {
  if (!noteId || !isUuid(noteId)) return null;
  try {
    await authState.waitForAuthReady();
    const { data } = await apiClient.get(`/notes/${noteId}/research-context`);
    const raw = data?.research_context;
    if (!raw || typeof raw !== 'object') return null;
    return {
      ...emptyContext(),
      ...(raw as Partial<NoteResearchContext>),
      updatedAt: typeof (raw as NoteResearchContext).updatedAt === 'number'
        ? (raw as NoteResearchContext).updatedAt
        : Date.now(),
    };
  } catch (err) {
    console.warn('[research-context] fetch failed:', err);
    return null;
  }
}

/**
 * Persist the Research Context blob to the server. Fire-and-forget —
 * local writes are synchronous and authoritative for UI feedback; the
 * server call is purely for cross-device durability.
 */
export async function saveNoteResearchContextToServer(
  noteId: string | null | undefined,
  context: NoteResearchContext
): Promise<void> {
  if (!noteId || !isUuid(noteId)) return;
  try {
    await authState.waitForAuthReady();
    await apiClient.put(`/notes/${noteId}/research-context`, {
      research_context: context,
    });
  } catch (err) {
    console.warn('[research-context] save failed:', err);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Build the short label shown inside the Research Context pill. Returns an
 * empty string when nothing is selected — the caller renders a "no context"
 * fallback in that case.
 */
export function formatResearchContextLabel(
  context: NoteResearchContext,
  collectionNames: Record<string, string>
): string {
  const parts: string[] = [];
  if (context.collectionIds.length > 0) {
    const names = context.collectionIds
      .map((id) => collectionNames[id])
      .filter(Boolean) as string[];
    if (names.length === 0) {
      parts.push(`${context.collectionIds.length} collections`);
    } else if (names.length <= 3) {
      parts.push(names.join(' · '));
    } else {
      parts.push(`${names.slice(0, 2).join(' · ')} +${names.length - 2}`);
    }
  }
  if (context.webSearchEnabled) parts.push('Web ✓');
  if (context.agenticRoutingEnabled) parts.push('Agentic ✓');
  return parts.join(' · ');
}

/**
 * Build the scope breadcrumb shown in the transient status bar during an AI
 * operation. Unlike formatResearchContextLabel, this ALWAYS returns a
 * human-readable string — when nothing is selected we render "All
 * collections" (the semantic default), not an empty-state placeholder.
 *
 * Caller passes localised strings so we don't hardcode English here.
 */
export function formatResearchScopeLabel(
  context: NoteResearchContext,
  collectionNames: Record<string, string>,
  labels: { allCollections: string; web: string }
): string {
  const parts: string[] = [];
  if (context.collectionIds.length === 0) {
    parts.push(labels.allCollections);
  } else {
    const names = context.collectionIds
      .map((id) => collectionNames[id])
      .filter(Boolean) as string[];
    if (names.length === 0) {
      parts.push(`${context.collectionIds.length}`);
    } else if (names.length <= 3) {
      parts.push(names.join(' · '));
    } else {
      parts.push(`${names.slice(0, 2).join(' · ')} +${names.length - 2}`);
    }
  }
  if (context.webSearchEnabled) parts.push(labels.web);
  return parts.join(' + ');
}
