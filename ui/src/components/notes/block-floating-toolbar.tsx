/**
 * Block Floating Toolbar - block-level actions toolbar
 * Appears above a block when the 6-dot grip handle is clicked
 * Contains: block type conversion + copy/duplicate/delete
 */

import React, { useEffect, useRef, useState } from 'react';
import { Editor } from '@tiptap/react';
import {
  MoreHorizontal,
  Trash2,
  Copy,
  Link2,
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  Code,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

interface BlockFloatingToolbarProps {
  editor: Editor;
  position: { top: number; left: number; width: number };
  onClose: () => void;
}

interface ToolbarButtonProps {
  onClick: () => void;
  isActive?: boolean;
  icon: React.ElementType;
  tooltip: string;
  className?: string;
  children?: React.ReactNode;
}

const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  onClick,
  isActive,
  icon: Icon,
  tooltip,
  className,
  children,
}) => (
  <button
    onMouseDown={(e) => e.preventDefault()}
    onClick={(e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    }}
    className={cn(
      'h-7 flex items-center justify-center transition-colors',
      children ? 'px-2 gap-1.5 text-xs font-medium' : 'w-7',
      'hover:bg-accent hover:text-accent-foreground',
      isActive && 'bg-accent text-accent-foreground',
      className
    )}
    title={tooltip}
    type="button"
  >
    <Icon className="h-3.5 w-3.5" />
    {children}
  </button>
);

const BLOCK_TYPES = [
  { name: 'paragraph', icon: Type, label: 'Text' },
  { name: 'heading1', icon: Heading1, label: 'Heading 1' },
  { name: 'heading2', icon: Heading2, label: 'Heading 2' },
  { name: 'heading3', icon: Heading3, label: 'Heading 3' },
  { name: 'bulletList', icon: List, label: 'Bullet list' },
  { name: 'orderedList', icon: ListOrdered, label: 'Numbered list' },
  { name: 'taskList', icon: CheckSquare, label: 'Task list' },
  { name: 'blockquote', icon: Quote, label: 'Quote' },
  { name: 'codeBlock', icon: Code, label: 'Code' },
] as const;

export const BlockFloatingToolbar: React.FC<BlockFloatingToolbarProps> = ({
  editor,
  position,
  onClose,
}) => {
  const { t } = useTranslation();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [showMore, setShowMore] = useState(false);
  const [showBlockTypes, setShowBlockTypes] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const blockTypeRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const timeout = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timeout);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Detect current block type
  const getCurrentBlockType = () => {
    if (editor.isActive('heading', { level: 1 })) return 'heading1';
    if (editor.isActive('heading', { level: 2 })) return 'heading2';
    if (editor.isActive('heading', { level: 3 })) return 'heading3';
    if (editor.isActive('bulletList')) return 'bulletList';
    if (editor.isActive('orderedList')) return 'orderedList';
    if (editor.isActive('taskList')) return 'taskList';
    if (editor.isActive('blockquote')) return 'blockquote';
    if (editor.isActive('codeBlock')) return 'codeBlock';
    return 'paragraph';
  };

  const currentType = getCurrentBlockType();
  const currentTypeInfo = BLOCK_TYPES.find(bt => bt.name === currentType) || BLOCK_TYPES[0];
  const CurrentIcon = currentTypeInfo.icon;

  const applyBlockType = (typeName: string) => {
    const chain = editor.chain().focus();
    switch (typeName) {
      case 'paragraph': chain.setParagraph().run(); break;
      case 'heading1': chain.setHeading({ level: 1 }).run(); break;
      case 'heading2': chain.setHeading({ level: 2 }).run(); break;
      case 'heading3': chain.setHeading({ level: 3 }).run(); break;
      case 'bulletList': chain.toggleBulletList().run(); break;
      case 'orderedList': chain.toggleOrderedList().run(); break;
      case 'taskList': chain.toggleTaskList().run(); break;
      case 'blockquote': chain.toggleBlockquote().run(); break;
      case 'codeBlock': chain.toggleCodeBlock().run(); break;
    }
    setShowBlockTypes(false);
  };

  const handleDuplicate = () => {
    const { from } = editor.state.selection;
    const $pos = editor.state.doc.resolve(from);
    let depth = $pos.depth;
    while (depth > 0) {
      const node = $pos.node(depth);
      if (node.type.name !== 'doc' && depth === 1) {
        const nodeJSON = node.toJSON();
        const nodePos = $pos.before(depth);
        const nodeSize = node.nodeSize;
        editor.chain().focus().insertContentAt(nodePos + nodeSize, nodeJSON).run();
        break;
      }
      depth--;
    }
    onClose();
  };

  const handleDelete = () => {
    const { from } = editor.state.selection;
    const $pos = editor.state.doc.resolve(from);
    let depth = $pos.depth;
    while (depth > 0) {
      const node = $pos.node(depth);
      if (node.type.name !== 'doc' && depth === 1) {
        const nodePos = $pos.before(depth);
        const nodeSize = node.nodeSize;
        editor.chain().focus().deleteRange({ from: nodePos, to: nodePos + nodeSize }).run();
        break;
      }
      depth--;
    }
    onClose();
  };

  const handleCopyLink = () => {
    const url = `${window.location.origin}${window.location.pathname}#block`;
    void navigator.clipboard.writeText(url);
    onClose();
  };

  // Calculate toolbar position - centered above the block
  const toolbarWidth = toolbarRef.current?.offsetWidth || 320;
  const centeredLeft = position.left + (position.width / 2) - (toolbarWidth / 2);
  const clampedLeft = Math.max(8, centeredLeft);

  return (
    <div
      ref={toolbarRef}
      data-testid="block-floating-toolbar"
      className={cn(
        'absolute z-[10002]',
        'flex items-center gap-px p-0.5',
        'bg-popover border border-border shadow-lg',
        'animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-150',
        'block-floating-toolbar'
      )}
      style={{
        top: `${position.top - 40}px`,
        left: `${clampedLeft}px`,
      }}
    >
      {/* Block type selector */}
      <div className="relative" ref={blockTypeRef}>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setShowBlockTypes(!showBlockTypes);
            setShowMore(false);
          }}
          className={cn(
            'h-7 flex items-center gap-1 px-2 text-xs font-medium transition-colors',
            'hover:bg-accent hover:text-accent-foreground',
            showBlockTypes && 'bg-accent text-accent-foreground',
          )}
          title={t('notes.blockMenu.turnInto', 'Turn into')}
          type="button"
        >
          <CurrentIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{currentTypeInfo.label}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </button>

        {showBlockTypes && (
          <div className="absolute top-full left-0 mt-1 w-44 bg-popover border border-border shadow-lg overflow-hidden z-50">
            {BLOCK_TYPES.map((bt) => {
              const Icon = bt.icon;
              return (
                <button
                  key={bt.name}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyBlockType(bt.name)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                    'hover:bg-accent hover:text-accent-foreground',
                    currentType === bt.name && 'bg-accent/50 text-accent-foreground',
                  )}
                  type="button"
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{bt.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="w-px h-4 bg-border mx-0.5" />

      {/* Direct actions */}
      <ToolbarButton
        onClick={handleDuplicate}
        icon={Copy}
        tooltip={t('notes.blockMenu.duplicate', 'Duplicate')}
      />
      <ToolbarButton
        onClick={handleCopyLink}
        icon={Link2}
        tooltip={t('notes.blockMenu.copyLink', 'Copy link')}
      />
      <ToolbarButton
        onClick={handleDelete}
        icon={Trash2}
        tooltip={t('notes.blockMenu.delete', 'Delete')}
        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
      />

      {/* More actions */}
      <div className="relative" ref={moreRef}>
        <ToolbarButton
          onClick={() => {
            setShowMore(!showMore);
            setShowBlockTypes(false);
          }}
          isActive={showMore}
          icon={MoreHorizontal}
          tooltip={t('notes.blockMenu.more', 'More actions')}
        />

        {showMore && (
          <div className="absolute top-full right-0 mt-1 w-48 bg-popover border border-border shadow-lg overflow-hidden z-50">
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                editor.chain().focus().setHighlight({ color: '#FEF3C7' }).run();
                setShowMore(false);
                onClose();
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
              type="button"
            >
              <span className="h-3.5 w-3.5 rounded bg-yellow-200 border border-yellow-300" />
              <span>{t('notes.blockMenu.highlight', 'Highlight')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
