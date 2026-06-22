/**
 * Fixed Toolbar - Notion-like toolbar at top of editor
 * Always visible with formatting options
 */

import React, { useState } from 'react';
import { Editor } from '@tiptap/react';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Link,
  Highlighter,
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  ChevronDown,
  Undo,
  Redo,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface FixedToolbarProps {
  editor: Editor;
}

interface ToolbarButtonProps {
  onClick: () => void;
  isActive?: boolean;
  icon: React.ElementType;
  tooltip: string;
  className?: string;
  disabled?: boolean;
}

const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  onClick,
  isActive,
  icon: Icon,
  tooltip,
  className,
  disabled = false,
}) => {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'h-8 w-8 flex items-center justify-center rounded-md transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        isActive && 'bg-accent text-accent-foreground',
        className
      )}
      title={tooltip}
      type="button"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
};

interface TurnIntoOption {
  label: string;
  icon: React.ElementType;
  action: (editor: Editor) => void;
  isActive?: (editor: Editor) => boolean;
}

const turnIntoOptions: TurnIntoOption[] = [
  {
    label: 'Text',
    icon: Type,
    action: (editor) => editor.chain().focus().setParagraph().run(),
    isActive: (editor) => editor.isActive('paragraph') && !editor.isActive('heading'),
  },
  {
    label: 'Heading 1',
    icon: Heading1,
    action: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    isActive: (editor) => editor.isActive('heading', { level: 1 }),
  },
  {
    label: 'Heading 2',
    icon: Heading2,
    action: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    isActive: (editor) => editor.isActive('heading', { level: 2 }),
  },
  {
    label: 'Heading 3',
    icon: Heading3,
    action: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    isActive: (editor) => editor.isActive('heading', { level: 3 }),
  },
  {
    label: 'Bullet List',
    icon: List,
    action: (editor) => editor.chain().focus().toggleBulletList().run(),
    isActive: (editor) => editor.isActive('bulletList'),
  },
  {
    label: 'Numbered List',
    icon: ListOrdered,
    action: (editor) => editor.chain().focus().toggleOrderedList().run(),
    isActive: (editor) => editor.isActive('orderedList'),
  },
  {
    label: 'Quote',
    icon: Quote,
    action: (editor) => editor.chain().focus().toggleBlockquote().run(),
    isActive: (editor) => editor.isActive('blockquote'),
  },
];

export const FixedToolbar: React.FC<FixedToolbarProps> = ({ editor }) => {
  const [showTurnInto, setShowTurnInto] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  if (!editor) return null;

  const getCurrentBlockType = () => {
    if (editor.isActive('heading', { level: 1 })) return 'H1';
    if (editor.isActive('heading', { level: 2 })) return 'H2';
    if (editor.isActive('heading', { level: 3 })) return 'H3';
    if (editor.isActive('bulletList')) return 'List';
    if (editor.isActive('orderedList')) return 'Num';
    if (editor.isActive('blockquote')) return 'Quote';
    return 'Text';
  };

  const handleLinkClick = () => {
    const previousUrl = editor.getAttributes('link').href || '';
    setLinkUrl(previousUrl);
    setShowLinkDialog(true);
  };

  const handleLinkSubmit = () => {
    if (linkUrl === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      const url = linkUrl.match(/^https?:\/\//) ? linkUrl : `https://${linkUrl}`;
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
    setShowLinkDialog(false);
    setLinkUrl('');
  };

  const handleRemoveLink = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setShowLinkDialog(false);
    setLinkUrl('');
  };

  return (
    <div data-testid="notes-fixed-toolbar" className="border-b border-border bg-background px-4 py-2 flex items-center gap-1 flex-wrap">
      {/* Undo/Redo */}
      <ToolbarButton
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
        icon={Undo}
        tooltip="Undo (Ctrl+Z)"
      />
      <ToolbarButton
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
        icon={Redo}
        tooltip="Redo (Ctrl+Shift+Z)"
      />

      <div className="w-px h-5 bg-border mx-1" />

      {/* Turn Into dropdown */}
      <div className="relative">
        <button
          onClick={() => setShowTurnInto(!showTurnInto)}
          className={cn(
            'h-8 px-2 flex items-center gap-1 rounded-md text-sm font-medium',
            'hover:bg-accent hover:text-accent-foreground transition-colors',
            showTurnInto && 'bg-accent'
          )}
          type="button"
        >
          <span className="min-w-[32px]">{getCurrentBlockType()}</span>
          <ChevronDown className="h-3 w-3" />
        </button>

        {showTurnInto && (
          <div className="absolute top-full left-0 mt-1 w-48 bg-popover border border-border rounded-lg shadow-lg overflow-hidden z-50">
            {turnIntoOptions.map((option) => {
              const Icon = option.icon;
              const isActive = option.isActive?.(editor);
              return (
                <button
                  key={option.label}
                  onClick={() => {
                    option.action(editor);
                    setShowTurnInto(false);
                  }}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-sm',
                    'hover:bg-accent hover:text-accent-foreground transition-colors',
                    isActive && 'bg-accent/50'
                  )}
                  type="button"
                >
                  <Icon className="h-4 w-4" />
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Text formatting */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        isActive={editor.isActive('bold')}
        icon={Bold}
        tooltip="Bold (Ctrl+B)"
      />
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        isActive={editor.isActive('italic')}
        icon={Italic}
        tooltip="Italic (Ctrl+I)"
      />
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        isActive={editor.isActive('underline')}
        icon={Underline}
        tooltip="Underline (Ctrl+U)"
      />
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        isActive={editor.isActive('strike')}
        icon={Strikethrough}
        tooltip="Strikethrough"
      />
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleCode().run()}
        isActive={editor.isActive('code')}
        icon={Code}
        tooltip="Code (Ctrl+E)"
      />

      <div className="w-px h-5 bg-border mx-1" />

      {/* Link */}
      <ToolbarButton
        onClick={handleLinkClick}
        isActive={editor.isActive('link')}
        icon={Link}
        tooltip="Link (Ctrl+K)"
      />

      {/* Highlight */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        isActive={editor.isActive('highlight')}
        icon={Highlighter}
        tooltip="Highlight"
      />

      {/* Link Dialog */}
      <Dialog open={showLinkDialog} onOpenChange={setShowLinkDialog}>
        <DialogContent data-testid="notes-fixed-toolbar-link-dialog" className="sm:max-w-md" hideCloseButton dialogOpen={showLinkDialog} onOpenChange={setShowLinkDialog}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link className="h-5 w-5" />
              Add Link
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="link-url">URL</Label>
              <Input
                id="link-url"
                data-testid="notes-fixed-toolbar-link-input"
                placeholder="https://example.com"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleLinkSubmit();
                  }
                }}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter className="flex gap-2 sm:gap-0">
            {editor.isActive('link') && (
              <Button
                type="button"
                variant="destructive"
                onClick={handleRemoveLink}
              >
                Remove Link
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShowLinkDialog(false);
                setLinkUrl('');
              }}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleLinkSubmit}>
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
