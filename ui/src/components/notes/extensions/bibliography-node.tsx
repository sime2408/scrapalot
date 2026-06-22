/* eslint-disable react-refresh/only-export-components -- this file exports both a node extension and helper functions used by other modules */
/**
 * Bibliography Node Extension
 * Block-level atom that scans the document for CitationMark marks,
 * deduplicates by documentId, and renders a formatted "References" section.
 * Includes export buttons for BibTeX/RIS/CSV/Markdown via the shared ExportDialog.
 */

import React, { useEffect, useState } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { ResolvedMetadata } from '@/lib/api-metadata';
import { formatBibliography, toBibTeXBatch, isNumericStyle } from '@/lib/citation-formatter';
import { ExportDialog } from '@/components/knowledge/export-dialog';
import { Button } from '@/components/ui/button';
import { Copy, Download } from 'lucide-react';
import { toast } from '@/lib/toast-compat';
import { useTranslation } from 'react-i18next';

/** Collect all unique citation metadata from the document */
export function collectCitations(editor: Editor): Map<string, ResolvedMetadata> {
  const citations = new Map<string, ResolvedMetadata>();

  editor.state.doc.descendants(node => {
    if (node.isText && node.marks.length > 0) {
      for (const mark of node.marks) {
        if (mark.type.name === 'citationMark' && mark.attrs.documentId) {
          if (!citations.has(mark.attrs.documentId)) {
            try {
              const meta = JSON.parse(mark.attrs.metadata || '{}');
              citations.set(mark.attrs.documentId, meta);
            } catch {
              // Skip unparseable metadata
            }
          }
        }
      }
    }
  });

  return citations;
}

interface BibliographyViewProps {
  editor: Editor;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TipTap NodeView props are loosely typed
  node: any;
}

const BibliographyView: React.FC<BibliographyViewProps> = ({ editor }) => {
  const { t } = useTranslation();
  const [bibliography, setBibliography] = useState('');
  const [citationCount, setCitationCount] = useState(0);
  const [citationMetadata, setCitationMetadata] = useState<ResolvedMetadata[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const updateBibliography = async () => {
      const citations = collectCitations(editor);
      const metas = Array.from(citations.values());
      setCitationCount(metas.length);
      setCitationMetadata(metas);

      if (metas.length === 0) {
        setBibliography('');
        return;
      }

      try {
        // Detect style from first citation mark in document
        let style = 'apa';
        editor.state.doc.descendants(node => {
          if (style !== 'apa') return false; // already found
          if (node.isText && node.marks.length > 0) {
            for (const mark of node.marks) {
              if (mark.type.name === 'citationMark' && mark.attrs.style) {
                style = mark.attrs.style;
                return false;
              }
            }
          }
        });

        // For numeric styles (IEEE, Vancouver), prepend [N] to each entry
        const result = await formatBibliography(metas, style);
        if (!cancelled) {
          if (isNumericStyle(style)) {
            const lines = result.split('\n').filter(l => l.trim());
            const numbered = lines.map((line, i) => `[${i + 1}] ${line}`).join('\n');
            setBibliography(numbered);
          } else {
            setBibliography(result);
          }
        }
      } catch (error) {
        console.error('[BibliographyNode] Failed to format bibliography:', error);
      }
    };

    void updateBibliography();

    // Re-render when the document changes
    const handleUpdate = () => { void updateBibliography(); };
    editor.on('update', handleUpdate);

    return () => {
      cancelled = true;
      editor.off('update', handleUpdate);
    };
  }, [editor]);

  const handleCopyBibTeX = async () => {
    if (citationMetadata.length === 0) return;
    setCopying(true);
    try {
      const bibtex = await toBibTeXBatch(citationMetadata);
      await navigator.clipboard.writeText(bibtex);
      toast.success(t('notes.citation.bibtexCopied', 'BibTeX copied to clipboard'));
    } catch {
      toast.error(t('notes.citation.bibtexCopyFailed', 'Failed to copy BibTeX'));
    } finally {
      setCopying(false);
    }
  };

  return (
    <NodeViewWrapper className="bibliography-node" data-testid="bibliography-node">
      <div
        contentEditable={false}
        className="border-t-2 border-border mt-8 pt-4"
      >
        <h2 className="text-xl font-bold mb-4">
          {t('notes.citation.references', 'References')}
        </h2>
        {citationCount === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            {t('notes.citation.noCitations', 'No citations found in this document. Use /quote to insert citations.')}
          </p>
        ) : (
          <>
            <div className="text-sm leading-relaxed whitespace-pre-wrap">
              {bibliography}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyBibTeX}
                disabled={copying}
                data-testid="bibliography-copy-bibtex-button"
              >
                <Copy className="h-3.5 w-3.5 mr-1.5" />
                {t('notes.citation.copyBibtex', 'Copy BibTeX')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExportOpen(true)}
                data-testid="bibliography-export-button"
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />
                {t('notes.citation.exportBibliography', 'Export Bibliography')}
              </Button>
            </div>
          </>
        )}
      </div>
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        metadata={citationMetadata}
        filenamePrefix="notes-bibliography"
      />
    </NodeViewWrapper>
  );
};

export const BibliographyNode = Node.create({
  name: 'bibliographyNode',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  parseHTML() {
    return [
      {
        tag: 'div[data-bibliography]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-bibliography': 'true',
        class: 'bibliography-node',
      }),
      'References',
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BibliographyView);
  },

  addCommands() {
    return {
      insertBibliography:
        () =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
          });
        },
    };
  },
});
