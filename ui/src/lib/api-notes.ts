/**
 * API client functions for notes collaboration
 */

import { apiClient } from './api';

/** one of the frontend template categories, or null = uncategorized. */
export type NoteCategory = 'academic' | 'writing' | 'social' | 'personal' | 'review';

/** Page-head status badge (migration 116). Confluence-style fixed set. */
export type NoteStatus = 'draft' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'on_hold';

/** Page-head font scale (migration 116). */
export type NoteFontScale = 'small' | 'default' | 'large' | 'xlarge';

export interface Note {
  id: string;
  title: string | null;
  content: string | null;
  content_text?: string;
  workspace_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_edited_by?: string;
  is_shared?: boolean;
  role?: 'owner' | 'editor' | 'viewer';
  session_id?: string;
  /** organizational category; null = Nekategorizirano. */
  category?: NoteCategory | null;
  /** Migration 116 — page-head emoji rendered next to the H1. */
  emoji?: string | null;
  /** Migration 116 — Draft / In progress / etc. status badge. */
  status?: NoteStatus | null;
  /** Migration 116 — banner image URL above the title. */
  header_image_url?: string | null;
  /** Migration 116 — editor font scale. */
  font_scale?: NoteFontScale | null;
}

export interface NoteShare {
  id: string;
  note_id: string;
  workspace_id: string;
  user_id: string | null;
  role: 'owner' | 'editor' | 'viewer';
  shared_by: string;
  shared_at: string;
}

export interface CreateNoteRequest {
  workspace_id: string;
  session_id?: string;
  title?: string;
  content?: string;
  /** templated notes pass the template's category here. */
  category?: NoteCategory | null;
}

export interface UpdateNoteRequest {
  title?: string;
  content?: string;
  /** reassign the note to a different category. */
  category?: NoteCategory | null;
  /**
   * Migration 116 — page-head metadata. Backend uses tri-state semantics:
   *   - field omitted     → keep current
   *   - field === ""      → clear (set to NULL)
   *   - field === "value" → set to value
   * The TS layer keeps the values typed; pass "" to clear from the UI.
   */
  emoji?: string;
  status?: NoteStatus | '';
  header_image_url?: string;
  font_scale?: NoteFontScale | '';
}

/** paginated response for the Datoteka → Otvori dialog. */
export interface PaginatedNotesResponse {
  items: Note[];
  page: number;
  page_size: number;
  total: number;
}

export type NoteCategoryFilter = NoteCategory | 'uncategorized' | 'all';

export interface ShareNoteRequest {
  email: string;
  role: 'editor' | 'viewer';
}

/**
 * Create a new note
 */
export const createNote = async (request: CreateNoteRequest): Promise<Note> => {
  const response = await apiClient.post('/notes', request);
  return response.data;
};

/**
 * List notes in a workspace
 */
export const listNotes = async (
  workspaceId: string,
  filter: 'all' | 'mine' | 'shared' = 'all'
): Promise<Note[]> => {
  const response = await apiClient.get('/notes', {
    params: { workspace_id: workspaceId, filter },
  });
  return response.data;
};

/**
 * paginated + category-scoped list for the Datoteka → Otvori
 * dialog. `category='all'` drops the filter; `'uncategorized'` matches rows
 * with category IS NULL.
 */
export const listNotesPaged = async (
  workspaceId: string,
  opts: {
    category?: NoteCategoryFilter;
    q?: string;
    page?: number;
    pageSize?: number;
  } = {}
): Promise<PaginatedNotesResponse> => {
  const { category = 'all', q, page = 1, pageSize = 20 } = opts;
  const params: Record<string, string | number> = {
    workspace_id: workspaceId,
    page,
    page_size: pageSize,
  };
  if (category !== 'all') params.category = category;
  if (q && q.trim()) params.q = q.trim();
  const response = await apiClient.get('/notes/paged', { params });
  return response.data;
};

/**
 * Get a specific note
 */
export const getNote = async (noteId: string): Promise<Note> => {
  const response = await apiClient.get(`/notes/${noteId}`);
  return response.data;
};

/**
 * Update a note
 */
export const updateNote = async (
  noteId: string,
  request: UpdateNoteRequest
): Promise<Note> => {
  const response = await apiClient.put(`/notes/${noteId}`, request);
  return response.data;
};

/**
 * Delete a note (soft delete)
 */
export const deleteNote = async (noteId: string): Promise<void> => {
  await apiClient.delete(`/notes/${noteId}`);
};

/**
 * Share a note with another user
 */
export const shareNote = async (
  noteId: string,
  request: ShareNoteRequest
): Promise<{ message: string }> => {
  const response = await apiClient.post(`/notes/${noteId}/share`, request);
  return response.data;
};

/**
 * Get shares for a note
 */
export const getNoteShares = async (noteId: string): Promise<NoteShare[]> => {
  const response = await apiClient.get(`/notes/${noteId}/shares`);
  return response.data;
};

/**
 * Remove a share
 */
export const removeNoteShare = async (
  noteId: string,
  userId: string
): Promise<void> => {
  await apiClient.delete(`/notes/${noteId}/shares/${userId}`);
};

/**
 * Get workspace members for collaboration
 */
export const getWorkspaceMembers = async (workspaceId: string): Promise<Array<{
  id: string;
  username: string;
  email?: string;
  avatar_url?: string;
  role: 'owner' | 'editor' | 'viewer';
}>> => {
  const response = await apiClient.get(`/workspaces/${workspaceId}`);

  // Extract users array from the workspace response
  const workspaceData = response.data;

  // Debug logging
  console.log('getWorkspaceMembers debug:', {
    workspaceId,
    responseStatus: response.status,
    workspaceData,
    usersArray: workspaceData.users,
    usersArrayLength: workspaceData.users?.length || 0,
  });

  // Map the users array to the expected format
  return workspaceData.users?.map((user: { user_id: string; username: string; email: string; role: string }) => ({
    id: user.user_id, // Use user_id from workspace_users table
    username: user.username,
    email: user.email,
    role: user.role,
  })) || [];
};

// ==================== Comments API ====================

export interface NoteComment {
  id: string;
  note_id: string;
  parent_comment_id?: string;
  content: string;
  position?: {
    from: number;
    to: number;
    text?: string;
  };
  created_by: string;
  created_by_name?: string;
  created_by_avatar?: string;
  created_at: string;
  updated_at: string;
  is_resolved: boolean;
  resolved_by?: string;
  resolved_at?: string;
  replies?: NoteComment[];
}

export interface CreateCommentRequest {
  content: string;
  parent_comment_id?: string;
  position?: {
    from: number;
    to: number;
    text?: string;
  };
}

export interface UpdateCommentRequest {
  content: string;
}

/**
 * List all comments for a note
 */
/**
 * Helper function to structure flat comments into nested tree
 */
const structureComments = (flatComments: NoteComment[]): NoteComment[] => {
  // Create a map for quick lookup
  const commentsMap = new Map<string, NoteComment>();
  const rootComments: NoteComment[] = [];

  // First pass: Create map and initialize replies arrays
  flatComments.forEach(comment => {
    commentsMap.set(comment.id, { ...comment, replies: [] });
  });

  // Second pass: Build the tree structure
  flatComments.forEach(comment => {
    const commentWithReplies = commentsMap.get(comment.id)!;

    if (comment.parent_comment_id) {
      // This is a reply - add to parent's replies array
      const parent = commentsMap.get(comment.parent_comment_id);
      if (parent) {
        parent.replies = parent.replies || [];
        parent.replies.push(commentWithReplies);
      }
    } else {
      // This is a root comment
      rootComments.push(commentWithReplies);
    }
  });

  return rootComments;
};

export const listComments = async (noteId: string): Promise<NoteComment[]> => {
  const response = await apiClient.get(`/notes/${noteId}/comments`);
  const flatComments: NoteComment[] = response.data;

  // Structure the flat list into nested tree
  return structureComments(flatComments);
};

/**
 * Create a new comment
 */
export const createComment = async (
  noteId: string,
  request: CreateCommentRequest
): Promise<NoteComment> => {
  const response = await apiClient.post(`/notes/${noteId}/comments`, request);
  return response.data;
};

/**
 * Update a comment
 */
export const updateComment = async (
  noteId: string,
  commentId: string,
  request: UpdateCommentRequest
): Promise<NoteComment> => {
  const response = await apiClient.put(
    `/notes/${noteId}/comments/${commentId}`,
    request
  );
  return response.data;
};

/**
 * Delete a comment
 */
export const deleteComment = async (
  noteId: string,
  commentId: string
): Promise<void> => {
  await apiClient.delete(`/notes/${noteId}/comments/${commentId}`);
};

/**
 * Resolve or unresolve a comment
 */
export const toggleResolveComment = async (
  noteId: string,
  commentId: string
): Promise<{
  id: string;
  is_resolved: boolean;
  resolved_by?: string;
  resolved_at?: string;
  message: string;
}> => {
  const response = await apiClient.post(
    `/notes/${noteId}/comments/${commentId}/resolve`
  );
  return response.data;
};

// ─── User-created note templates ────────────

/**
 * Template record as stored on the server (matches
 * NoteTemplateController.toResponse). Mirrors the shape of the
 * frontend NoteTemplate in lib/note-templates-catalog.ts so the
 * template-gallery can merge server + system into one list.
 */
export interface UserNoteTemplate {
  id: string;
  user_id: string;
  workspace_id: string | null;
  name: string;
  description: string | null;
  category: string | null;
  expected_word_count: string | null;
  icon: string | null;
  skeleton: string;
  default_research_context: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export async function listUserNoteTemplates(
  workspaceId?: string
): Promise<UserNoteTemplate[]> {
  const { data } = await apiClient.get('/notes/templates', {
    params: workspaceId ? { workspace_id: workspaceId } : {},
  });
  return data;
}

export interface CreateUserNoteTemplateRequest {
  workspace_id?: string | null;
  name: string;
  description?: string;
  category?: string;
  expected_word_count?: string;
  icon?: string;
  skeleton: string;
  default_research_context?: Record<string, unknown>;
}

export async function createUserNoteTemplate(
  request: CreateUserNoteTemplateRequest
): Promise<UserNoteTemplate> {
  const { data } = await apiClient.post('/notes/templates', request);
  return data;
}

export async function deleteUserNoteTemplate(id: string): Promise<void> {
  await apiClient.delete(`/notes/templates/${id}`);
}

// ─── 7.9 Version Control ─────────────────────────────────────────────────

/** Wire shape returned by `GET /notes/{id}/versions` — snake_case
 *  because Jackson is configured globally for snake_case. Earlier
 *  versions of this interface used camelCase and silently rendered
 *  every field as undefined ("Invalid Date" / "NaN ago" in the
 *  dialog), so the names below intentionally match the JSON. */
export interface NoteVersion {
  id: string;
  note_id: string;
  user_id: string;
  version_number: number;
  content: string;
  change_summary: string;
  created_at: string;
  /** 7.9 — `auto` | `named` | `restore`. Defaults to 'auto' for legacy
   *  rows the UI fetches before the migration ran. */
  kind?: 'auto' | 'named' | 'restore';
  label?: string | null;
  message?: string | null;
  parent_version_id?: string | null;
}

/** 7.9 — list all versions of a note, newest first. Includes auto,
 *  named, and restore-pivot rows; the dialog filters client-side. */
export async function listNoteVersions(noteId: string): Promise<NoteVersion[]> {
  const { data } = await apiClient.get(`/notes/${noteId}/versions`);
  return data as NoteVersion[];
}

/** 7.9 — explicit named save of the current note state. Backend
 *  reads the live `note.content` (not the version content) so the
 *  user doesn't need to send it again. Label is required. */
export async function saveNamedNoteVersion(
  noteId: string,
  label: string,
  message?: string,
): Promise<NoteVersion> {
  const { data } = await apiClient.post(`/notes/${noteId}/versions/save-named`, {
    label,
    message: message || null,
  });
  return data as NoteVersion;
}

/** 7.9 — restore a previous version. Backend captures the current
 *  state as a `kind=restore` snapshot first so the user can undo. */
export async function restoreNoteVersion(noteId: string, versionId: string): Promise<void> {
  await apiClient.post(`/notes/${noteId}/versions/${versionId}/restore`);
}
