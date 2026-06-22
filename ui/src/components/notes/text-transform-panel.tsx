/**
 * Text Transform Panel
 *
 * Shows original vs transformed text (rephrase/simplify/expand)
 * with Replace, Insert Below, and Cancel actions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { DraggablePanel, DragHandle } from './draggable-panel';
import { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { transformText, translateText } from '@/lib/api-notes-assistant';

interface TextTransformPanelProps {
  editor: Editor;
  selectedText: string;
  transformType: 'academic' | 'simplify' | 'expand' | 'translate';
  targetLanguage?: 'en' | 'hr';
  surroundingContext?: string;
  collectionIds?: string[];
  selectionRange: { from: number; to: number };
  position: { top: number; left: number };
  onClose: () => void;
}

export function TextTransformPanel({
  editor,
  selectedText,
  transformType,
  targetLanguage = 'en',
  surroundingContext,
  collectionIds,
  selectionRange,
  position,
  onClose,
}: TextTransformPanelProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [transformedText, setTransformedText] = useState('');
  const [error, setError] = useState('');

  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    let cancelled = false;

    async function run() {
      setLoading(true);
      setError('');
      try {
        if (transformType === 'translate') {
          const result = await translateText(selectedText, targetLanguage);
          if (!cancelled) setTransformedText(result.translated_text);
        } else {
          // when ESL mode is on, transparently swap 'academic' for
          // 'academic_esl' so the backend uses the non-native English prompt
          // variant. The toggle lives in NoteMenuBar > Alati > Non-native EN.
          const eslMode =
            typeof window !== 'undefined' &&
            window.localStorage.getItem('scrapalot_notes_esl_mode') === 'true';
          const effectiveType: typeof transformType | 'academic_esl' =
            eslMode && transformType === 'academic' ? 'academic_esl' : transformType;
          const result = await transformText(
            selectedText,
            effectiveType as Parameters<typeof transformText>[1],
            surroundingContext,
            collectionIds
          );
          if (!cancelled) setTransformedText(result.transformed_text);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => { cancelled = true; };
  }, [selectedText, transformType, targetLanguage, surroundingContext, collectionIds]);

  const handleReplace = useCallback(() => {
    editor
      .chain()
      .focus()
      .setTextSelection(selectionRange)
      .deleteSelection()
      .insertContent(transformedText)
      .run();
    onClose();
  }, [editor, selectionRange, transformedText, onClose]);

  const handleInsertBelow = useCallback(() => {
    const endPos = selectionRange.to;
    editor
      .chain()
      .focus()
      .setTextSelection(endPos)
      .insertContent([
        { type: 'paragraph', content: [{ type: 'text', text: transformedText }] },
      ])
      .run();
    onClose();
  }, [editor, selectionRange, transformedText, onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const typeLabel = {
    academic: t('notes.research_assistant.rephrase_academic', 'Academic'),
    simplify: t('notes.research_assistant.simplify', 'Simplified'),
    expand: t('notes.research_assistant.expand', 'Expanded'),
    translate: t('notes.research_assistant.translate', 'Translated'),
  }[transformType];

  return (
    <DraggablePanel
      initialPosition={{ top: position.top, left: Math.min(position.left, window.innerWidth - 380) }}
      className="w-[380px]"
      onClickOutside={onClose}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium truncate min-w-0">{typeLabel}</span>
        <div className="flex items-center gap-0.5 shrink-0">
          <DragHandle />
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} aria-label={t('common.close', 'Close')}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="p-3 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <span className="text-sm">{t('notes.research_assistant.processing', 'Processing...')}</span>
          </div>
        ) : error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : (
          <>
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                {t('notes.research_assistant.original', 'Original')}
              </div>
              <div className="text-sm bg-muted/50 rounded p-2 line-clamp-3">{selectedText}</div>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">{typeLabel}</div>
              <div className="text-sm bg-primary/5 rounded p-2">{transformedText}</div>
            </div>
          </>
        )}
      </div>

      {!loading && !error && (
        <div className="flex gap-2 px-3 pb-3">
          <Button size="sm" className="h-7 text-xs" onClick={handleReplace}>
            {t('notes.research_assistant.replace', 'Replace')}
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleInsertBelow}>
            {t('notes.research_assistant.insert_below', 'Insert Below')}
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClose}>
            {t('notes.research_assistant.cancel', 'Cancel')}
          </Button>
        </div>
      )}
    </DraggablePanel>
  );
}
