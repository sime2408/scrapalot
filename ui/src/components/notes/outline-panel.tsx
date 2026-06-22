/**
 * Outline Panel
 *
 * Shows AI-generated document outline from notes content.
 * Triggered by /outline slash command.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Circle, List, Loader2, Plus, X } from 'lucide-react';
import { DraggablePanel, DragHandle } from './draggable-panel';
import { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { generateOutline, type OutlineSection } from '@/lib/api-notes-assistant';

interface OutlinePanelProps {
  editor: Editor;
  notesContent: string;
  collectionIds: string[];
  position: { top: number; left: number };
  onClose: () => void;
}

export function OutlinePanel({
  editor,
  notesContent,
  collectionIds,
  position,
  onClose,
}: OutlinePanelProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [sections, setSections] = useState<OutlineSection[]>([]);
  const [_formattedOutline, setFormattedOutline] = useState('');
  const [error, setError] = useState('');

  const collectionIdsRef = useRef(collectionIds);
  collectionIdsRef.current = collectionIds;
  const hasRequested = useRef(false);

  useEffect(() => {
    if (hasRequested.current) return;
    hasRequested.current = true;

    let cancelled = false;

    async function generate() {
      setError('');
      try {
        const res = await generateOutline(notesContent, collectionIdsRef.current);
        if (!cancelled) {
          setSections(res.sections ?? []);
          setFormattedOutline(res.formatted_outline ?? '');
        }
      } catch (err) {
        console.error('Outline generation failed:', err);
        if (!cancelled) setError(t('notes.assistant.outlineFailed', 'Could not generate outline from this content.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void generate();
    return () => { cancelled = true; };
  }, [notesContent, t]);

  const insertOutline = useCallback(() => {
    if (sections.length === 0) return;

    const content: Array<Record<string, unknown>> = [];

    for (const section of sections) {
      const level = Math.min(Math.max(section.level, 2), 4);
      content.push({
        type: 'heading',
        attrs: { level },
        content: [{ type: 'text', text: section.title }],
      });
      if (section.description) {
        content.push({
          type: 'paragraph',
          content: [{ type: 'text', marks: [{ type: 'italic' }], text: section.description }],
        });
      }
    }

    editor.chain().focus().insertContentAt(editor.state.selection.to, content).run();
    onClose();
  }, [editor, sections, onClose]);

  const coveredCount = sections.filter(s => s.covered_in_notes).length;

  return (
    <DraggablePanel
      initialPosition={{ top: position.top, left: Math.min(position.left, window.innerWidth - 380) }}
      className="w-[380px]"
      onClickOutside={onClose}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium flex items-center gap-1.5 truncate min-w-0">
          <List className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {loading
              ? t('notes.assistant.generatingOutline', 'Generating outline...')
              : t('notes.assistant.sectionsCount', { count: sections.length, defaultValue: '{{count}} sections' })}
          </span>
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <DragHandle />
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} aria-label={t('common.close', 'Close')}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground/60">{t('notes.assistant.analyzing_structure', 'Analyzing document structure...')}</span>
          </div>
        ) : error || sections.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {error || t('notes.assistant.outlineFailed', 'Could not generate outline from this content.')}
          </div>
        ) : (
          <div className="p-2">
            {coveredCount > 0 && (
              <div className="text-[10px] text-muted-foreground px-2 py-1 mb-1">
                {t('notes.assistant.outlineCoveredSummary', {
                  covered: coveredCount,
                  total: sections.length,
                  defaultValue: '{{covered}}/{{total}} sections already covered in your notes',
                })}
              </div>
            )}
            {sections.map((section, i) => (
              <div
                key={i}
                className="flex items-start gap-2 px-2 py-1.5 hover:bg-accent/50 transition-colors"
                style={{ paddingLeft: `${(section.level - 1) * 16 + 8}px` }}
              >
                {section.covered_in_notes ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
                ) : (
                  <Circle className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-xs font-medium">{section.title}</div>
                  {section.description && (
                    <div className="text-[10px] text-muted-foreground line-clamp-1">{section.description}</div>
                  )}
                  {section.source_count > 0 && (
                    <div className="text-[10px] text-muted-foreground">
                      {t('notes.assistant.outlineSourcesCount', { count: section.source_count, defaultValue: '{{count}} sources' })}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {sections.length > 0 && (
        <div className="flex justify-end gap-2 px-3 py-2 border-t border-border">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={insertOutline}>
            <Plus className="h-3 w-3 mr-1" /> {t('notes.assistant.insertOutline', 'Insert Outline')}
          </Button>
        </div>
      )}
    </DraggablePanel>
  );
}
