/**
 * Block menu for TipTap editor - Notion-like block actions
 * Appears when clicking the drag handle (6-dot icon)
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Editor } from '@tiptap/react';
import {
  Heading1,
  Heading2,
  Heading3,
  Type,
  List,
  ListOrdered,
  Quote,
  Code,
  Trash2,
  Copy,
  ChevronRight,
  Palette,
  Link2,
  Move,
  ArrowUp,
  ArrowDown,
  MessageSquare,
  Edit3,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';


interface BlockMenuProps {
  editor: Editor;
  onClose?: () => void;
  /** PM position of the block whose 6-dot gutter the user clicked.
   *  Actions that mutate the block (setHeading, setParagraph,
   *  toggleBulletList, deleteSelection…) pre-pend setTextSelection
   *  to this position inside the same chain so the transform always
   *  targets the right row — even if Radix popover focus-grab moved
   *  the in-editor selection between the gutter click and this click. */
  targetPos?: number | null;
}

type SubmenuKey = 'turnInto' | 'color' | 'moveTo';
type ActionKey =
  | 'turnInto'
  | 'color'
  | 'copyLinkToBlock'
  | 'duplicate'
  | 'moveUp'
  | 'moveDown'
  | 'moveTo'
  | 'delete'
  | 'comment'
  | 'suggestEdits';

/**
 * Find the top-level block that contains `pos`. Returns the child index,
 * start position and node, or null when `pos` doesn't resolve to a
 * direct child of the document.
 */
function findTopLevelChildAt(
  editor: Editor,
  pos: number
): { index: number; from: number; node: import('@tiptap/pm/model').Node } | null {
  const doc = editor.state.doc;
  let found: { index: number; from: number; node: import('@tiptap/pm/model').Node } | null = null;
  let running = 0;
  doc.content.forEach((child, _offset, index) => {
    const childFrom = running;
    const childTo = running + child.nodeSize;
    if (pos >= childFrom && pos < childTo && !found) {
      found = { index, from: childFrom, node: child };
    }
    running = childTo;
  });
  return found;
}

/**
 * Expand a top-level child at `index` to the range that covers the whole
 * "section" when the child is a heading — heading + everything until the
 * next heading of level <= current. For any other block type the range
 * is just the block itself.
 */
function getSectionRangeFromChild(
  editor: Editor,
  index: number,
  childFrom: number,
  child: import('@tiptap/pm/model').Node
): { from: number; to: number } {
  const from = childFrom;
  let to = childFrom + child.nodeSize;
  if (child.type.name !== 'heading') return { from, to };
  const level: number = child.attrs.level as number;
  const doc = editor.state.doc;
  let running = 0;
  doc.content.forEach((sibling, _offset, siblingIndex) => {
    const sibFrom = running;
    const sibTo = running + sibling.nodeSize;
    if (siblingIndex > index) {
      if (sibling.type.name === 'heading' && (sibling.attrs.level as number) <= level) {
        // stop expanding
      } else {
        // keep track of the furthest end seen while walking into the
        // section; but once we hit a same/higher-level heading we must
        // not extend further, so only advance `to` for siblings that
        // come before any such heading.
        // Implementation: break out by short-circuiting via `running`
        // sentinel — we detect the first stop-heading and freeze `to`.
        if (to === sibFrom) to = sibTo;
      }
    }
    running = sibTo;
  });
  return { from, to };
}

/**
 * Move the top-level block (or heading section) that contains `pos` up
 * or down by one top-level block.
 */
function moveBlockOrSection(editor: Editor, pos: number, direction: 'up' | 'down') {
  const hit = findTopLevelChildAt(editor, pos);
  if (!hit) return;
  const range = getSectionRangeFromChild(editor, hit.index, hit.from, hit.node);
  const doc = editor.state.doc;

  // Collect top-level children with their running positions so we can
  // find the block immediately before/after the section.
  const children: Array<{ from: number; to: number; node: import('@tiptap/pm/model').Node }> = [];
  let running = 0;
  doc.content.forEach((child) => {
    children.push({ from: running, to: running + child.nodeSize, node: child });
    running += child.nodeSize;
  });

  if (direction === 'up') {
    const firstInSection = children.findIndex((c) => c.from === range.from);
    if (firstInSection <= 0) return; // already at top
    const prev = children[firstInSection - 1];
    // Capture section JSON before mutating the doc.
    const sectionSlice = doc.slice(range.from, range.to);
    const sectionJSON = sectionSlice.content.toJSON();
    editor
      .chain()
      .focus()
      .deleteRange({ from: range.from, to: range.to })
      .insertContentAt(prev.from, sectionJSON)
      .run();
  } else {
    const lastInSection = children.findIndex((c) => c.to === range.to);
    if (lastInSection === -1 || lastInSection >= children.length - 1) return;
    const next = children[lastInSection + 1];
    const sectionSlice = doc.slice(range.from, range.to);
    const sectionJSON = sectionSlice.content.toJSON();
    // Compute insertion point AFTER the next block, but account for
    // the fact that removing the section first shifts the doc left
    // by (range.to - range.from).
    const removedLength = range.to - range.from;
    const insertAt = next.to - removedLength;
    editor
      .chain()
      .focus()
      .deleteRange({ from: range.from, to: range.to })
      .insertContentAt(insertAt, sectionJSON)
      .run();
  }
}

export const BlockMenu: React.FC<BlockMenuProps> = ({ editor, onClose, targetPos }) => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchQuery, setSearchQuery] = React.useState('');
  const [activeSubmenu, setActiveSubmenu] = React.useState<SubmenuKey | null>(null);

  // Start a chained command that always lands the selection back on
  // the row whose 6-dot was clicked, then runs the caller's mutation
  // in the SAME transaction so the focus-grab from this very click
  // can't disrupt targeting.
  const targeted = React.useCallback(() => {
    const chain = editor.chain().focus();
    if (typeof targetPos === 'number') {
      chain.setTextSelection(targetPos);
    }
    return chain;
  }, [editor, targetPos]);

  // Get current block type (translated)
  const getCurrentBlockType = () => {
    if (editor.isActive('heading', { level: 1 })) return t('notes.blockMenu.blockType.heading1');
    if (editor.isActive('heading', { level: 2 })) return t('notes.blockMenu.blockType.heading2');
    if (editor.isActive('heading', { level: 3 })) return t('notes.blockMenu.blockType.heading3');
    if (editor.isActive('bulletList')) return t('notes.blockMenu.blockType.bulletList');
    if (editor.isActive('orderedList')) return t('notes.blockMenu.blockType.numberedList');
    if (editor.isActive('blockquote')) return t('notes.blockMenu.blockType.quote');
    if (editor.isActive('codeBlock')) return t('notes.blockMenu.blockType.codeBlock');
    return t('notes.blockMenu.blockType.text');
  };

  // Block type conversion options. Every action runs through
  // `targeted()` so the transform targets the row the user clicked,
  // not whichever block last held the cursor.
  const blockTypeOptions = [
    {
      label: t('notes.blockMenu.blockType.text'),
      icon: Type,
      action: () => {
        targeted().setParagraph().run();
        onClose?.();
      },
    },
    {
      label: t('notes.blockMenu.blockType.heading1'),
      icon: Heading1,
      action: () => {
        targeted().setHeading({ level: 1 }).run();
        onClose?.();
      },
    },
    {
      label: t('notes.blockMenu.blockType.heading2'),
      icon: Heading2,
      action: () => {
        targeted().setHeading({ level: 2 }).run();
        onClose?.();
      },
    },
    {
      label: t('notes.blockMenu.blockType.heading3'),
      icon: Heading3,
      action: () => {
        targeted().setHeading({ level: 3 }).run();
        onClose?.();
      },
    },
    {
      label: t('notes.blockMenu.blockType.bulletList'),
      icon: List,
      action: () => {
        targeted().toggleBulletList().run();
        onClose?.();
      },
    },
    {
      label: t('notes.blockMenu.blockType.numberedList'),
      icon: ListOrdered,
      action: () => {
        targeted().toggleOrderedList().run();
        onClose?.();
      },
    },
    {
      label: t('notes.blockMenu.blockType.quote'),
      icon: Quote,
      action: () => {
        targeted().toggleBlockquote().run();
        onClose?.();
      },
    },
    {
      label: t('notes.blockMenu.blockType.codeBlock'),
      icon: Code,
      action: () => {
        targeted().toggleCodeBlock().run();
        onClose?.();
      },
    },
  ];

  // Color options — `labelKey` maps to i18n colors, `color`/`bgColor` are style tokens
  const colorOptions = [
    { labelKey: 'color_default', color: null, bgColor: null },
    { labelKey: 'color_gray', color: '#6B7280', bgColor: '#F3F4F6' },
    { labelKey: 'color_brown', color: '#92400E', bgColor: '#FEF3C7' },
    { labelKey: 'color_orange', color: '#C2410C', bgColor: '#FFEDD5' },
    { labelKey: 'color_yellow', color: '#A16207', bgColor: '#FEF9C3' },
    { labelKey: 'color_green', color: '#15803D', bgColor: '#DCFCE7' },
    { labelKey: 'color_blue', color: '#1E40AF', bgColor: '#DBEAFE' },
    { labelKey: 'color_purple', color: '#6D28D9', bgColor: '#EDE9FE' },
    { labelKey: 'color_pink', color: '#BE185D', bgColor: '#FCE7F3' },
    { labelKey: 'color_red', color: '#B91C1C', bgColor: '#FEE2E2' },
  ];

  // Move to options
  const moveToOptions: Array<{ key: 'top' | 'bottom' | 'new'; labelKey: string; icon: React.ElementType }> = [
    { key: 'top', labelKey: 'moveToTop', icon: Type },
    { key: 'bottom', labelKey: 'moveToBottom', icon: Type },
    { key: 'new', labelKey: 'moveToNewPage', icon: Type },
  ];

  const allActions: Array<{
    key: ActionKey;
    label: string;
    icon: React.ElementType;
    shortcut?: string;
    hasSubmenu?: boolean;
    danger?: boolean;
    action: () => void;
  }> = [
    {
      key: 'turnInto',
      label: t('notes.blockMenu.turnInto'),
      icon: ChevronRight,
      action: () => {
        setActiveSubmenu(activeSubmenu === 'turnInto' ? null : 'turnInto');
      },
      hasSubmenu: true,
    },
    {
      key: 'color',
      label: t('notes.blockMenu.color'),
      icon: Palette,
      action: () => {
        setActiveSubmenu(activeSubmenu === 'color' ? null : 'color');
      },
      hasSubmenu: true,
    },
    {
      key: 'copyLinkToBlock',
      label: t('notes.blockMenu.copyLinkToBlock'),
      icon: Link2,
      shortcut: 'Alt+Shift+L',
      action: () => {
        try {
          // Get current block position
          const { from } = editor.state.selection;
          const $pos = editor.state.doc.resolve(from);

          // Find the top-level block
          let blockIndex = 0;
          let depth = $pos.depth;
          while (depth > 0) {
            const node = $pos.node(depth);
            if (node.type.name !== 'doc' && depth === 1) {
              // Calculate block index by counting siblings before this position
              const parent = $pos.node(depth - 1);
              for (let i = 0; i < parent.childCount; i++) {
                const childPos = $pos.posAtIndex(i, depth - 1);
                if (childPos >= $pos.before(depth)) {
                  blockIndex = i;
                  break;
                }
              }
              break;
            }
            depth--;
          }

          // Generate link with block anchor
          const url = `${window.location.origin}${window.location.pathname}#block-${blockIndex}`;

          // Copy to clipboard
          navigator.clipboard.writeText(url).then(() => {
            console.log('[Copy Link] Copied block link:', url);
          });
        } catch (error) {
          console.error('[Copy Link] Error:', error);
        }
      },
    },
    {
      key: 'duplicate',
      label: t('notes.blockMenu.duplicate'),
      icon: Copy,
      shortcut: 'Ctrl+D',
      action: () => {
        try {
          // Get current selection position to find which block we're in
          const { from } = editor.state.selection;

          // Get the resolved position
          const $pos = editor.state.doc.resolve(from);

          // Find the top-level block node
          let depth = $pos.depth;
          while (depth > 0) {
            const node = $pos.node(depth);
            if (node.type.name !== 'doc' && depth === 1) {
              // Found the top-level block
              const nodeJSON = node.toJSON();
              const nodePos = $pos.before(depth);
              const nodeSize = node.nodeSize;

              console.log('[Duplicate] Duplicating block:', { nodeJSON, nodePos, nodeSize });

              // Insert the duplicate after this block
              editor.chain()
                .focus()
                .insertContentAt(nodePos + nodeSize, nodeJSON)
                .run();
              return;
            }
            depth--;
          }

          console.warn('[Duplicate] Could not find block to duplicate');
        } catch (error) {
          console.error('[Duplicate] Error:', error);
        }
      },
    },
    {
      key: 'moveUp',
      label: t('notes.blockMenu.moveUp', 'Move up'),
      icon: ArrowUp,
      shortcut: 'Alt+Shift+↑',
      action: () => {
        try {
          const { from } = editor.state.selection;
          moveBlockOrSection(editor, from, 'up');
        } catch (error) {
          console.error('[Move up] Error:', error);
        }
      },
    },
    {
      key: 'moveDown',
      label: t('notes.blockMenu.moveDown', 'Move down'),
      icon: ArrowDown,
      shortcut: 'Alt+Shift+↓',
      action: () => {
        try {
          const { from } = editor.state.selection;
          moveBlockOrSection(editor, from, 'down');
        } catch (error) {
          console.error('[Move down] Error:', error);
        }
      },
    },
    {
      key: 'moveTo',
      label: t('notes.blockMenu.moveTo'),
      icon: Move,
      shortcut: 'Ctrl+Shift+P',
      action: () => {
        setActiveSubmenu(activeSubmenu === 'moveTo' ? null : 'moveTo');
      },
      hasSubmenu: true,
    },
    {
      key: 'delete',
      label: t('notes.blockMenu.delete'),
      icon: Trash2,
      shortcut: 'Del',
      action: () => {
        try {
          const { from } = editor.state.selection;
          const $pos = editor.state.doc.resolve(from);

          // Find the top-level block node
          let depth = $pos.depth;
          while (depth > 0) {
            const node = $pos.node(depth);
            if (node.type.name !== 'doc' && depth === 1) {
              console.log('[Delete] Deleting block:', node.type.name);

              // Delete this block
              const nodePos = $pos.before(depth);
              const nodeSize = node.nodeSize;

              editor.chain()
                .focus()
                .deleteRange({ from: nodePos, to: nodePos + nodeSize })
                .run();
              return;
            }
            depth--;
          }

          console.warn('[Delete] Could not find block to delete');
        } catch (error) {
          console.error('[Delete] Error:', error);
        }
      },
      danger: true,
    },
    {
      key: 'comment',
      label: t('notes.blockMenu.comment'),
      icon: MessageSquare,
      shortcut: 'Ctrl+Shift+M',
      action: () => {
        // Get current selection or block
        const { from, to } = editor.state.selection;

        // For now, just highlight the selection
        // In a full implementation, this would open a comment dialog
        // and store the comment in the backend
        editor.chain()
          .focus()
          .setHighlight({ color: '#FEF3C7' }) // Yellow highlight for comments
          .run();

        console.log('[Comment] Added comment highlight at positions', from, to);
        // TODO: Open comment dialog and store in backend
      },
    },
    {
      key: 'suggestEdits',
      label: t('notes.blockMenu.suggestEdits'),
      icon: Edit3,
      shortcut: 'Ctrl+Shift+Alt+X',
      action: () => {
        // Toggle suggestion mode
        // In a full implementation, this would enable track changes mode
        // For now, we'll use a different highlight color to indicate suggestions
        const { from, to } = editor.state.selection;

        editor.chain()
          .focus()
          .setHighlight({ color: '#DBEAFE' }) // Blue highlight for suggestions
          .run();

        console.log('[Suggest Edits] Enabled suggestion mode at positions', from, to);
        // TODO: Implement full track changes with Y.js
      },
    },
  ];

  const filteredActions = allActions.filter((action) =>
    action.label.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div data-testid="notes-block-menu" className="w-80 rounded-lg border border-border bg-popover shadow-lg">
      {/* Search bar */}
      <div className="p-3 border-b border-border">
        <Input
          type="text"
          data-testid="notes-block-menu-search"
          placeholder={t('notes.blockMenu.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-8 text-sm border-primary/50 focus-visible:ring-primary"
          autoFocus
        />
      </div>

      {/* Current block type */}
      <div className="px-3 py-2 text-sm text-muted-foreground border-b border-border">
        {getCurrentBlockType()}
      </div>

      {/* Actions list */}
      <div className="p-2 max-h-[400px] overflow-y-auto">
        {filteredActions.map((action) => {
          const Icon = action.icon;
          return (
            <div key={action.label}>
              <button
                onClick={() => {
                  action.action();
                  if (!action.hasSubmenu) {
                    onClose?.();
                  }
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  action.danger && 'text-destructive hover:bg-destructive/10'
                )}
              >
                <div className="flex items-center gap-3">
                  <Icon className="h-4 w-4" />
                  <span>{action.label}</span>
                </div>
                {action.shortcut && (
                  <span className="text-xs text-muted-foreground">{action.shortcut}</span>
                )}
                {action.hasSubmenu && (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </button>

              {/* Turn Into Submenu */}
              {action.key === 'turnInto' && activeSubmenu === 'turnInto' && (
                <div className="ml-4 mt-1 space-y-1 border-l-2 border-border pl-2">
                  {blockTypeOptions.map((option) => {
                    const OptionIcon = option.icon;
                    return (
                      <button
                        key={option.label}
                        onClick={option.action}
                        className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                      >
                        <OptionIcon className="h-4 w-4" />
                        <span>{option.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Color Submenu */}
              {action.key === 'color' && activeSubmenu === 'color' && (
                <div className="ml-4 mt-1 space-y-1 border-l-2 border-border pl-2">
                  {colorOptions.map((option) => (
                    <button
                      key={option.labelKey}
                      onClick={() => {
                        if (option.color) {
                          editor.chain().focus().setColor(option.color).run();
                        } else {
                          editor.chain().focus().unsetColor().run();
                        }
                        onClose?.();
                      }}
                      className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <div
                        className="h-4 w-4 rounded border border-border"
                        style={{
                          backgroundColor: option.bgColor || 'transparent',
                        }}
                      />
                      <span>{t(`notes.blockMenu.${option.labelKey}`)}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Move To Submenu */}
              {action.key === 'moveTo' && activeSubmenu === 'moveTo' && (
                <div className="ml-4 mt-1 space-y-1 border-l-2 border-border pl-2">
                  {moveToOptions.map((option) => {
                    const OptionIcon = option.icon;
                    return (
                      <button
                        key={option.key}
                        onClick={() => {
                          // Get current block
                          const { from } = editor.state.selection;
                          const $pos = editor.state.doc.resolve(from);

                          let depth = $pos.depth;
                          while (depth > 0) {
                            const node = $pos.node(depth);
                            if (node.type.name !== 'doc' && depth === 1) {
                              const nodeJSON = node.toJSON();
                              const nodePos = $pos.before(depth);
                              const nodeSize = node.nodeSize;

                              // Delete from current position
                              editor.chain().focus().deleteRange({ from: nodePos, to: nodePos + nodeSize }).run();

                              // Insert at new position
                              if (option.key === 'top') {
                                editor.chain().focus().insertContentAt(0, nodeJSON).run();
                              } else if (option.key === 'bottom') {
                                const docSize = editor.state.doc.content.size;
                                editor.chain().focus().insertContentAt(docSize, nodeJSON).run();
                              }
                              // 'new' would require backend integration

                              console.log('[Move To] Moved block to:', option.key);
                              onClose?.();
                              return;
                            }
                            depth--;
                          }
                        }}
                        className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                      >
                        <OptionIcon className="h-4 w-4" />
                        <span>{t(`notes.blockMenu.${option.labelKey}`)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border">
        {t('notes.blockMenu.lastEditedBy', { name: user?.username || '' })}
      </div>
    </div>
  );
};
