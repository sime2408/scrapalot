/**
 * Toggle Component - React NodeView for Toggle Extension
 * Renders collapsible sections with editable summary + arrow indicator.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NodeViewWrapper, NodeViewContent } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/core';
import { ChevronRight, ChevronDown } from 'lucide-react';

export const ToggleComponent: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(node.attrs.open || false);
  const summaryRef = useRef<HTMLSpanElement | null>(null);
  // The hardcoded 'Toggle' that used to be the schema default is now
  // surfaced through i18n. Localized labels: hr "Sklopivi popis",
  // en "Toggle list", mk "Преклоплив список".
  const placeholder = t('notes.toggle.placeholder', 'Toggle list');

  // Empty summary triggers the placeholder via the `[data-empty='true']`
  // CSS rule (see toggle CSS in editor-theme.css / inline <style>).
  const summaryText = (node.attrs.summary || '').trim();
  const isEmpty = summaryText === '' || summaryText === 'Toggle';

  // Keep the contentEditable span in sync with node attrs when an
  // upstream change (collaboration, undo) mutates summary. Avoid
  // overwriting while the user is actively typing — selection caret
  // jumps if we rewrite textContent under their cursor.
  useEffect(() => {
    const el = summaryRef.current;
    if (!el) return;
    if (document.activeElement === el) return;
    const desired = isEmpty ? '' : summaryText;
    if (el.textContent !== desired) {
      el.textContent = desired;
    }
  }, [summaryText, isEmpty]);

  const handleToggle = () => {
    const newState = !isOpen;
    setIsOpen(newState);
    updateAttributes({ open: newState });
  };

  const handleSummaryInput = useCallback(
    (e: React.FormEvent<HTMLSpanElement>) => {
      const text = (e.currentTarget.textContent || '').trim();
      // Persist '' explicitly so the placeholder shows again when the
      // user deletes the whole label.
      updateAttributes({ summary: text });
    },
    [updateAttributes],
  );

  return (
    <NodeViewWrapper className="toggle-block my-2">
      <div
        className="toggle-header flex items-center gap-2 px-2 py-1.5 hover:bg-accent transition-colors select-none"
      >
        {/* Chevron is the ONLY trigger for collapse — the summary
            label is now editable so clicking on it must place the
            caret, not toggle. */}
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={isOpen}
          aria-label={isOpen ? t('notes.toggle.collapse', 'Collapse') : t('notes.toggle.expand', 'Expand')}
          className="flex items-center justify-center h-5 w-5 flex-shrink-0 text-muted-foreground hover:text-foreground"
          contentEditable={false}
        >
          {isOpen ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </button>
        <span
          ref={summaryRef}
          className="toggle-summary font-medium text-sm flex-1 outline-none focus:outline-none"
          contentEditable
          suppressContentEditableWarning
          data-placeholder={placeholder}
          data-empty={isEmpty ? 'true' : 'false'}
          onInput={handleSummaryInput}
          onKeyDown={(e) => {
            // Block Enter — newline inside the summary makes the label
            // multi-line and breaks the row alignment. Forward Enter
            // to expand the toggle instead.
            if (e.key === 'Enter') {
              e.preventDefault();
              handleToggle();
            }
          }}
        />
      </div>
      {/* NodeViewContent must always be in the DOM — conditionally
          unmounting it would orphan ProseMirror's content tracking
          and could leave child blocks invisible to the editor.
          Hide via CSS instead so the toggle still collapses
          visually but the schema stays consistent. */}
      <div
        className="toggle-content pl-6 pt-2"
        style={{ display: isOpen ? 'block' : 'none' }}
      >
        <NodeViewContent />
      </div>
    </NodeViewWrapper>
  );
};
