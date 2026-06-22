/**
 * Shared helper for optimistic tag toggle logic used in tag assignment components.
 */

import { tagDocument, untagDocument } from '@/lib/api-tags';
import { toast } from '@/lib/toast-compat';

/**
 * Performs an optimistic tag toggle: updates the local Set immediately, then
 * calls the API. On failure it reverts the local state and shows a toast.
 *
 * @param tagId - The tag to toggle.
 * @param hasTag - Whether the document currently has this tag.
 * @param documentId - The document to tag/untag.
 * @param setDocTagIds - State setter for the local tag-id Set.
 * @param onTagsChanged - Optional callback invoked on success.
 */
export async function applyOptimisticTagToggle(
  tagId: string,
  hasTag: boolean,
  documentId: string,
  setDocTagIds: React.Dispatch<React.SetStateAction<Set<string>>>,
  onTagsChanged?: () => void,
): Promise<void> {
  setDocTagIds(prev => {
    const next = new Set(prev);
    if (hasTag) { next.delete(tagId); } else { next.add(tagId); }
    return next;
  });

  const ok = hasTag
    ? await untagDocument(documentId, tagId)
    : await tagDocument(documentId, tagId);

  if (!ok) {
    setDocTagIds(prev => {
      const next = new Set(prev);
      if (hasTag) { next.add(tagId); } else { next.delete(tagId); }
      return next;
    });
    toast.error(hasTag ? 'Failed to remove tag' : 'Failed to add tag');
  } else {
    onTagsChanged?.();
  }
}
