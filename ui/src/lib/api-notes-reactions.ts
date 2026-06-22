/**
 * Notes reactions API client — migration 117.
 *
 * Backend stores one row per (note, user, emoji). The GET endpoint
 * groups them into emoji chips ready for render; POST/DELETE toggle
 * a single (user, emoji) pair on the addressed note.
 */

import { apiClient } from './api';

export interface NoteReactionGroup {
  emoji: string;
  count: number;
  /** UUIDs of users that picked this emoji. Used by the tooltip to
   *  surface "You and 3 others". */
  user_ids: string[];
  /** True if the current viewer's UUID is in user_ids — drives the
   *  chip's filled/outlined state. */
  includes_viewer: boolean;
}

export interface NoteReactionRow {
  id: string;
  note_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
}

export async function listNoteReactions(noteId: string): Promise<NoteReactionGroup[]> {
  const res = await apiClient.get<NoteReactionGroup[]>(`/notes/${noteId}/reactions`);
  return res.data;
}

export async function addNoteReaction(noteId: string, emoji: string): Promise<NoteReactionRow> {
  const res = await apiClient.post<NoteReactionRow>(`/notes/${noteId}/reactions`, { emoji });
  return res.data;
}

export async function removeNoteReaction(noteId: string, emoji: string): Promise<void> {
  // Emoji as query param, not path. Spring Cloud Gateway 404s on
  // percent-encoded multi-byte glyphs in the path (🚀 →
  // %F0%9F%9A%80 fails before reaching the controller). Query
  // parameters bypass that validator.
  await apiClient.delete(`/notes/${noteId}/reactions`, {
    params: { emoji },
  });
}
