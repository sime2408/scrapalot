import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useCollections } from '@/contexts/collections-context';
import { getDocumentsByCollection } from '@/lib/api-documents';
import { mapWithConcurrency } from '@/lib/api-utils';
import type { ExistingDocument } from '@/types/file-attachments';

export interface MentionItem {
  type: 'collection' | 'document';
  id: string;
  name: string;
  displayName?: string; // Truncated name used in textarea text (set on selection)
  collectionId?: string;
  collectionName?: string;
  pageCount?: number;
}

interface MentionState {
  active: boolean;
  query: string;
  startIndex: number;
  isCollectionMode: boolean; // true when user typed @/
  isDrillDown: boolean; // true when user typed @/CollectionName/
  drillDownCollectionId?: string;
  drillDownCollectionName?: string;
}

type EnrichedDocument = ExistingDocument & { _collectionName: string };

export function useChatMentions() {
  const { collections } = useCollections();
  const [mentions, setMentions] = useState<MentionItem[]>([]);
  const [mentionState, setMentionState] = useState<MentionState>({
    active: false,
    query: '',
    startIndex: -1,
    isCollectionMode: false,
    isDrillDown: false,
  });
  const [documents, setDocuments] = useState<EnrichedDocument[]>([]);
  const openedAtRef = useRef<number>(0); // timestamp when popover opened
  const [docsLoading, setDocsLoading] = useState(false);
  const docsLoadedForRef = useRef<Set<string>>(new Set());

  // Load documents for all collections (lazy, once)
  const loadDocuments = useCallback(async () => {
    if (collections.length === 0) return;
    const unloaded = collections.filter(c => !docsLoadedForRef.current.has(c.id));
    if (unloaded.length === 0) return;

    setDocsLoading(true);
    try {
      // Capped fan-out so a large workspace doesn't fire one parallel
      // /documents/collection/{id} request per collection at once.
      const results = await mapWithConcurrency(unloaded, 6, async (col) => {
        try {
          const res = await getDocumentsByCollection(col.id, 1, 100);
          docsLoadedForRef.current.add(col.id);
          return (res.documents || []).map((d: ExistingDocument) => ({
            ...d,
            _collectionName: col.name,
          }));
        } catch {
          return [];
        }
      });
      const newDocs = results.flat();
      if (newDocs.length > 0) {
        setDocuments(prev => {
          const existingIds = new Set(prev.map(d => d.id));
          const unique = newDocs.filter((d: ExistingDocument) => !existingIds.has(d.id));
          return unique.length > 0 ? [...prev, ...unique] : prev;
        });
      }
    } finally {
      setDocsLoading(false);
    }
  }, [collections]);

  // Load docs when mention popover activates (document mode or drill-down mode)
  useEffect(() => {
    if (mentionState.active && (!mentionState.isCollectionMode || mentionState.isDrillDown)) {
      void loadDocuments();
    }
  }, [mentionState.active, mentionState.isCollectionMode, mentionState.isDrillDown, loadDocuments]);

  // Filter suggestions based on query
  const suggestions = useMemo((): MentionItem[] => {
    if (!mentionState.active) return [];
    const q = mentionState.query.toLowerCase();

    // Drill-down mode: show documents within the selected collection
    if (mentionState.isDrillDown && mentionState.drillDownCollectionId) {
      return documents
        .filter((d) => {
          if (d.collection_id !== mentionState.drillDownCollectionId) return false;
          const name = d.filename || d.title || '';
          return name.toLowerCase().includes(q);
        })
        .slice(0, 8)
        .map((d) => ({
          type: 'document' as const,
          id: d.id,
          name: d.filename || d.title || d.id,
          collectionId: d.collection_id,
          collectionName: mentionState.drillDownCollectionName || d._collectionName || '',
          pageCount: d.doc_metadata?.page_count,
        }));
    }

    if (mentionState.isCollectionMode) {
      return collections
        .filter(c => c.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map(c => ({
          type: 'collection' as const,
          id: c.id,
          name: c.name,
        }));
    }

    // Document mode: show documents matching query
    return documents
      .filter((d) => {
        const name = d.filename || d.title || '';
        return name.toLowerCase().includes(q);
      })
      .slice(0, 8)
      .map((d) => ({
        type: 'document' as const,
        id: d.id,
        name: d.filename || d.title || d.id,
        collectionId: d.collection_id,
        collectionName: d._collectionName || '',
        pageCount: d.doc_metadata?.page_count,
      }));
  }, [mentionState.active, mentionState.query, mentionState.isCollectionMode, mentionState.isDrillDown, mentionState.drillDownCollectionId, mentionState.drillDownCollectionName, collections, documents]);

  // Detect @-mention trigger from text input
  const handleInputChange = useCallback((text: string, cursorPos: number) => {
    // Look backwards from cursor for an unmatched @
    let i = cursorPos - 1;
    while (i >= 0 && text[i] !== '@' && text[i] !== ' ' && text[i] !== '\n') {
      i--;
    }

    if (i >= 0 && text[i] === '@') {
      // Check it's at start of text or preceded by whitespace
      if (i === 0 || /\s/.test(text[i - 1])) {
        const afterAt = text.substring(i + 1, cursorPos);

        // Skip if cursor is inside an already-confirmed mention (e.g. @filename.epub )
        const isConfirmedMention = mentions.some(m => {
          const mentionText = `@${m.name}`;
          const mentionEnd = i + 1 + m.name.length;
          return text.substring(i, mentionEnd) === mentionText && cursorPos <= mentionEnd;
        });
        if (isConfirmedMention) {
          if (mentionState.active) {
            setMentionState({ active: false, query: '', startIndex: -1, isCollectionMode: false, isDrillDown: false });
          }
          return;
        }
        const isSlashMode = afterAt.startsWith('/');

        if (isSlashMode) {
          const slashContent = afterAt.slice(1); // remove leading /
          const secondSlashIndex = slashContent.indexOf('/');

          if (secondSlashIndex >= 0) {
            // Pattern: @/collectionName/docQuery
            const collectionPart = slashContent.substring(0, secondSlashIndex);
            const docQuery = slashContent.substring(secondSlashIndex + 1);

            // Find matching collection (case-insensitive exact match)
            const matchedCollection = collections.find(
              c => c.name.toLowerCase() === collectionPart.toLowerCase()
            );

            if (matchedCollection) {
              openedAtRef.current = Date.now();
              setMentionState({
                active: true,
                query: docQuery,
                startIndex: i,
                isCollectionMode: false,
                isDrillDown: true,
                drillDownCollectionId: matchedCollection.id,
                drillDownCollectionName: matchedCollection.name,
              });
              return;
            }
          }

          // Regular collection mode: @/query
          openedAtRef.current = Date.now();
          setMentionState({
            active: true,
            query: isSlashMode ? afterAt.slice(1) : afterAt,
            startIndex: i,
            isCollectionMode: true,
            isDrillDown: false,
          });
          return;
        }

        // Document mode: @query
        openedAtRef.current = Date.now();
        setMentionState({
          active: true,
          query: afterAt,
          startIndex: i,
          isCollectionMode: false,
          isDrillDown: false,
        });
        return;
      }
    }

    // No @ found at cursor — guard against spurious closes on mobile
    if (mentionState.active) {
      // Don't auto-close within 3s of opening (mobile re-renders from keyboard/context)
      if (Date.now() - openedAtRef.current < 3000) {
        return;
      }
      // Also keep open if @ still exists at saved position
      if (mentionState.startIndex >= 0 && text[mentionState.startIndex] === '@') {
        return;
      }
      setMentionState({ active: false, query: '', startIndex: -1, isCollectionMode: false, isDrillDown: false });
    }
  }, [mentionState.active, mentionState.startIndex, collections, mentions]);

  // Select a suggestion - removes @query from text and tracks mention via chips only
  const selectSuggestion = useCallback((item: MentionItem, currentText: string, cursorPos: number): { text: string; cursor: number } => {
    setMentions(prev => {
      if (prev.some(m => m.id === item.id && m.type === item.type)) return prev;
      return [...prev, item];
    });

    // Cut the @-token only — NEVER lose text the user typed AFTER it.
    // The token ends at the first whitespace after the @ (or end of
    // string). Using `cursorPos` as the cut point silently wiped the
    // user's whole sentence when the cursor sat past the token (e.g.
    // pressing Enter on a still-open popover after typing
    // "@art_of_war Tko je Sun Tzu?" — `cursorPos` is at the period,
    // so `text.substring(cursorPos)` is empty and the post-@-text gets
    // dropped). Search forward from startIndex to find the token end.
    const at = mentionState.startIndex;
    let tokenEnd = currentText.length;
    for (let i = at + 1; i < currentText.length; i++) {
      if (/\s/.test(currentText[i])) {
        tokenEnd = i;
        break;
      }
    }
    const before = currentText.substring(0, at);
    const after = currentText.substring(tokenEnd).replace(/^\s/, ''); // trim one leading space
    const newText = before + after;
    const newCursor = before.length;

    setMentionState({ active: false, query: '', startIndex: -1, isCollectionMode: false, isDrillDown: false });

    return { text: newText, cursor: newCursor };
  }, [mentionState.startIndex]);

  // Remove a mention
  const removeMention = useCallback((id: string, type: 'collection' | 'document') => {
    setMentions(prev => prev.filter(m => !(m.id === id && m.type === type)));
  }, []);

  // Clear all mentions
  const clearMentions = useCallback(() => {
    setMentions([]);
  }, []);

  // Close mention popover
  const closeMentions = useCallback(() => {
    setMentionState({ active: false, query: '', startIndex: -1, isCollectionMode: false, isDrillDown: false });
  }, []);

  // Programmatically add a mention (e.g. from viewer → chat handoff). Safe against
  // duplicates — the same (id, type) pair is only added once.
  const addMention = useCallback((item: MentionItem) => {
    setMentions(prev => {
      if (prev.some(m => m.id === item.id && m.type === item.type)) return prev;
      return [...prev, item];
    });
  }, []);

  // Extract mentioned collection_ids: explicit collection mentions + parent collections of document mentions
  const mentionedCollectionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of mentions) {
      if (m.type === 'collection') {
        ids.add(m.id);
      } else if (m.type === 'document' && m.collectionId) {
        ids.add(m.collectionId);
      }
    }
    return Array.from(ids);
  }, [mentions]);
  const mentionedDocumentIds = useMemo(
    () => mentions.filter(m => m.type === 'document').map(m => m.id),
    [mentions]
  );

  // Strip @mention names from text before sending to backend
  const cleanPrompt = useCallback((text: string): string => {
    let cleaned = text;
    for (const m of mentions) {
      // Remove @displayName occurrences (with optional trailing space)
      const mentionText = `@${m.displayName || m.name}`;
      while (cleaned.includes(mentionText)) {
        const idx = cleaned.indexOf(mentionText);
        const end = idx + mentionText.length;
        // Also remove trailing space if present
        const trimEnd = end < cleaned.length && cleaned[end] === ' ' ? end + 1 : end;
        cleaned = cleaned.substring(0, idx) + cleaned.substring(trimEnd);
      }
    }
    return cleaned.replace(/\s{2,}/g, ' ').trim();
  }, [mentions]);

  return {
    mentions,
    mentionState,
    suggestions,
    docsLoading,
    handleInputChange,
    selectSuggestion,
    addMention,
    removeMention,
    clearMentions,
    closeMentions,
    mentionedCollectionIds,
    mentionedDocumentIds,
    cleanPrompt,
  };
}
