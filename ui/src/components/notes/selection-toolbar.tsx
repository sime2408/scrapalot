/**
 * Selection Toolbar - Notion-like floating toolbar
 * Appears when text is selected for quick formatting
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Editor } from '@tiptap/react';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Link,
  Link2,
  Highlighter,
  Palette,
  MoreHorizontal,
  MessageSquare,
  Edit3,
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  ChevronDown,
  BrainCircuit,
  ClipboardCheck,
  ClipboardPaste,
  Copy,
  PenLine,
  Scissors,
  ShieldCheck,
  Sparkles,
  SquareDashedMousePointer,
  Wand2,
  Maximize2,
  Languages,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { BlockMenu } from './block-menu';
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

interface SelectionToolbarProps {
  editor: Editor;
  onComment?: (selection: { from: number; to: number; text: string }) => void;
}

interface ToolbarButtonProps {
  onClick: () => void;
  isActive?: boolean;
  icon: React.ElementType;
  tooltip: string;
  className?: string;
}

const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  onClick,
  isActive,
  icon: Icon,
  tooltip,
  className,
}) => {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  };

  return (
    <button
      onClick={handleClick}
      onMouseDown={(e) => {
        // Prevent default on mousedown to keep editor focus
        e.preventDefault();
      }}
      className={cn(
        'h-8 w-8 flex items-center justify-center rounded-md transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
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

const colorOptions = [
  { label: 'Default', color: null },
  { label: 'Gray', color: '#6B7280' },
  { label: 'Brown', color: '#92400E' },
  { label: 'Orange', color: '#C2410C' },
  { label: 'Yellow', color: '#A16207' },
  { label: 'Green', color: '#15803D' },
  { label: 'Blue', color: '#1E40AF' },
  { label: 'Purple', color: '#6D28D9' },
  { label: 'Pink', color: '#BE185D' },
  { label: 'Red', color: '#B91C1C' },
];

export const SelectionToolbar: React.FC<SelectionToolbarProps> = ({ editor, onComment }) => {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [showTurnInto, setShowTurnInto] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showBlockMenu, setShowBlockMenu] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [suggestionMode, setSuggestionMode] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const turnIntoRef = useRef<HTMLDivElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const blockMenuRef = useRef<HTMLDivElement>(null);
  const justOpenedDropdown = useRef(false);

  const updatePosition = useCallback(() => {
    if (!editor) return;

    const { from, to, empty } = editor.state.selection;

    // Only show toolbar when text is selected (not empty)
    if (empty || from === to) {
      setIsVisible(false);
      setShowTurnInto(false);
      return;
    }

    const view = editor.view;
    if (!view) return;

    try {
      const start = view.coordsAtPos(from);
      const end = view.coordsAtPos(to);

      const coords = {
        top: start.top,
        bottom: end.bottom,
        left: (start.left + end.left) / 2
      };

      const margin = 8;

      // Detect the Notes fixed formatting toolbar to avoid overlap.
      const editorEl = view.dom;
      const drawerContainer = editorEl.closest('[id="notes-drawer-portal"]') as HTMLElement | null;
      const notesToolbar = drawerContainer?.querySelector<HTMLElement>('[class*="z-50"]') ?? null;
      const minTop = notesToolbar ? notesToolbar.getBoundingClientRect().bottom + 4 : margin;

      // Use measured toolbar size if available, otherwise estimate
      const tb = toolbarRef.current;
      const toolbarWidth = tb ? tb.offsetWidth : 380;
      const toolbarHeight = tb ? tb.offsetHeight : 76;

      // Prefer above selection, fallback below if clipped
      let top = coords.top - toolbarHeight - margin;
      let left = coords.left - toolbarWidth / 2;

      // Clamp left/right to viewport
      left = Math.max(margin, Math.min(left, window.innerWidth - toolbarWidth - margin));

      // Clamp top: if above clips, go below selection
      if (top < minTop) {
        top = coords.bottom + margin;
      }
      // If below also clips, pin to bottom of viewport
      if (top + toolbarHeight > window.innerHeight - margin) {
        top = window.innerHeight - toolbarHeight - margin;
      }
      // Final floor — never go above minTop
      if (top < minTop) {
        top = minTop;
      }

      clampedRef.current = false;
      setPosition({ top, left });
      setIsVisible(true);
    } catch {
      // Silently fail — position calculation can fail during DOM updates
    }
  }, [editor]);

  useEffect(() => {
    if (!editor) return;

    const handleSelectionUpdate = () => {
      // Small delay to ensure selection is finalized
      requestAnimationFrame(updatePosition);
    };

    const handleFocus = () => {
      // Show toolbar on focus
      requestAnimationFrame(updatePosition);
    };

    editor.on('selectionUpdate', handleSelectionUpdate);
    editor.on('focus', handleFocus);

    // Handle click outside to close turn into menu
    // On mobile: disable click outside completely, only close via option selection
    // On desktop: enable after delay
    const isMobile = window.innerWidth <= 1080;
    let clickOutsideEnabled = false;

    const enableClickOutsideTimeout = setTimeout(() => {
      // On mobile, never enable click outside
      if (!isMobile) {
        clickOutsideEnabled = true;
      }
    }, 500);

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (!clickOutsideEnabled) return;

      // Ignore if dropdown was just opened
      if (justOpenedDropdown.current) {
        justOpenedDropdown.current = false;
        return;
      }

      if (turnIntoRef.current && !turnIntoRef.current.contains(e.target as Node)) {
        setShowTurnInto(false);
      }

      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }

      if (blockMenuRef.current && !blockMenuRef.current.contains(e.target as Node)) {
        setShowBlockMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);

    return () => {
      clearTimeout(enableClickOutsideTimeout);
      editor.off('selectionUpdate', handleSelectionUpdate);
      editor.off('focus', handleFocus);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [editor, updatePosition]);

  // On mobile: suppress native context menu (copy/paste/select all) so our toolbar is the only UI
  useEffect(() => {
    if (!editor) return;
    const isTouchDevice = 'ontouchstart' in window;
    if (!isTouchDevice) return;

    const handleContextMenu = (e: Event) => {
      // Only suppress when our toolbar is visible (text is selected)
      if (isVisible) {
        e.preventDefault();
      }
    };

    editor.view.dom.addEventListener('contextmenu', handleContextMenu);
    return () => {
      editor.view.dom.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [editor, isVisible]);

  // Post-render clamp: after toolbar is painted, measure its actual rect
  // and nudge it back into the viewport if any edge overflows.
  // Uses a ref flag to prevent infinite adjustment loops.
  const clampedRef = useRef(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs on every render; clampedRef guards against infinite setPosition loops
  useEffect(() => {
    if (!isVisible || !toolbarRef.current) {
      clampedRef.current = false;
      return;
    }
    // Only clamp once per position update (avoid loop)
    if (clampedRef.current) return;

    const tb = toolbarRef.current;
    const rect = tb.getBoundingClientRect();
    const margin = 8;
    let adjustLeft = 0;
    let adjustTop = 0;

    if (rect.right > window.innerWidth - margin) {
      adjustLeft = window.innerWidth - margin - rect.right;
    }
    if (rect.left < margin) {
      adjustLeft = margin - rect.left;
    }
    if (rect.bottom > window.innerHeight - margin) {
      adjustTop = window.innerHeight - margin - rect.bottom;
    }
    if (rect.top < margin) {
      adjustTop = margin - rect.top;
    }

    if (adjustLeft !== 0 || adjustTop !== 0) {
      clampedRef.current = true;
      setPosition(prev => ({
        top: prev.top + adjustTop,
        left: prev.left + adjustLeft,
      }));
    }
  });

  // Hide toolbar when editor loses focus (e.g. clicking outside, opening dialogs)
  useEffect(() => {
    if (!editor) return;

    const handleBlur = () => {
      // Delay to allow clicking toolbar buttons (they steal focus briefly)
      setTimeout(() => {
        if (!toolbarRef.current?.contains(document.activeElement)) {
          setIsVisible(false);
          setShowTurnInto(false);
          setShowColorPicker(false);
          setShowBlockMenu(false);
        }
      }, 200);
    };

    editor.view.dom.addEventListener('blur', handleBlur);
    return () => {
      editor.view.dom.removeEventListener('blur', handleBlur);
    };
  }, [editor]);

  // Clipboard handlers — declared BEFORE the early return so the hook
  // count never changes between renders (React rule of hooks).
  const handleCopy = useCallback(async () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = editor.state.doc.textBetween(from, to, '\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      document.execCommand('copy');
    }
  }, [editor]);

  const handleCut = useCallback(async () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    await handleCopy();
    editor.chain().focus().deleteSelection().run();
  }, [editor, handleCopy]);

  const handlePaste = useCallback(async () => {
    if (!editor) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) editor.chain().focus().insertContent(text).run();
    } catch {
      // Clipboard read permission denied — silently ignore.
    }
  }, [editor]);

  const handleSelectAll = useCallback(() => {
    if (!editor) return;
    editor.chain().focus().selectAll().run();
  }, [editor]);

  if (!isVisible || !editor) return null;

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
      // Add https:// if no protocol specified
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

  const handleComment = () => {
    // Get current selection
    const { from, to } = editor.state.selection;
    if (from === to) return; // No selection

    const selectedText = editor.state.doc.textBetween(from, to);

    // Add highlight with comment marker (darker yellow with underline)
    editor.chain()
      .focus()
      .setHighlight({ color: '#FDE68A' }) // Darker yellow
      .run();

    // Call parent callback to open comment sidebar with selection data
    if (onComment) {
      onComment({ from, to, text: selectedText });
    }

  };

  const handleToggleSuggestionMode = () => {
    const newMode = !suggestionMode;
    setSuggestionMode(newMode);

    if (newMode) {
      // Enable suggestion mode - use blue highlight for suggestions
      editor.chain()
        .focus()
        .setHighlight({ color: '#DBEAFE' })
        .run();

    } else {
      // intentional
    }
  };

  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 1080;

  // Mobile uses the unified MobileEditingToolbar (extensions/
  // mobile-table-toolbar.tsx) that lives at the bottom of the viewport
  // above the keyboard. Skip rendering the floating SelectionToolbar
  // here so the two don't compete or overlap.
  if (isMobile) return null;

  return (
    <div
      ref={toolbarRef}
      data-testid="notes-selection-toolbar"
      className={cn(
        'fixed',
        'z-[10001] flex flex-col gap-0 p-1',
        'bg-popover border border-border shadow-lg',
        'animate-in fade-in-0 zoom-in-95 duration-150',
        isMobile && 'max-w-[calc(100vw-16px)]'
      )}
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
    >
      {/* Row 1: Formatting (hidden on mobile) */}
      {!isMobile && (
      <div className="flex items-center gap-0.5">
      {/* Ask Scrapalot — Confluence's "Ask Rovo" equivalent. Prominent
          brand button anchored at the very start of the toolbar so it
          reads as the primary action; bracketed by a separator from
          the formatting controls. */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const { from, to } = editor.state.selection;
          const text = editor.state.doc.textBetween(from, to, ' ');
          window.dispatchEvent(new CustomEvent('ask-scrapalot', { detail: { text } }));
        }}
        onMouseDown={(e) => e.preventDefault()}
        data-testid="notes-selection-ask-scrapalot"
        className={cn(
          'h-8 px-2 flex items-center gap-1.5 text-xs font-medium',
          'text-primary hover:bg-primary/10 transition-colors',
        )}
        title={t('notes.toolbar.askScrapalot', 'Ask Scrapalot')}
      >
        <BrainCircuit className="h-3.5 w-3.5" />
        <span>{t('notes.toolbar.askScrapalot', 'Ask Scrapalot')}</span>
      </button>
      <div className="w-px h-5 bg-border mx-1" />
      {/* Turn Into dropdown */}
      <div className="relative" ref={turnIntoRef}>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // Track if we're opening the dropdown and add delay
            if (!showTurnInto) {
              justOpenedDropdown.current = true;
              setTimeout(() => {
                justOpenedDropdown.current = false;
              }, 1000);
            }
            setShowTurnInto(!showTurnInto);
          }}
          onMouseDown={(e) => {
            e.preventDefault();
          }}
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
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    option.action(editor);
                    setShowTurnInto(false);
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
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

      <div className="w-px h-5 bg-border mx-1" />

      {/* Text Color */}
      <div className="relative" ref={colorPickerRef}>
        <ToolbarButton
          onClick={() => setShowColorPicker(!showColorPicker)}
          isActive={showColorPicker}
          icon={Palette}
          tooltip="Text color"
        />

        {showColorPicker && (
          <div className="absolute top-full left-0 mt-1 w-48 bg-popover border border-border rounded-lg shadow-lg overflow-hidden z-50 p-2">
            <div className="grid grid-cols-5 gap-1">
              {colorOptions.map((option) => (
                <button
                  key={option.label}
                  onClick={() => {
                    if (option.color) {
                      editor.chain().focus().setColor(option.color).run();
                    } else {
                      editor.chain().focus().unsetColor().run();
                    }
                    setShowColorPicker(false);
                  }}
                  className={cn(
                    'h-8 w-8 rounded border border-border transition-transform hover:scale-110',
                    !option.color && 'bg-background'
                  )}
                  style={{
                    backgroundColor: option.color || 'transparent',
                  }}
                  title={option.label}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Block Menu (⋯) — hidden on mobile. The selection toolbar
          is already at viewport edge there and the row is full of
          higher-priority actions; the block menu's entries are
          reachable via NoteMenuBar overflow + the slash menu. */}
      <div className={cn('relative', isMobile && 'hidden')} ref={blockMenuRef}>
        <ToolbarButton
          onClick={() => setShowBlockMenu(!showBlockMenu)}
          isActive={showBlockMenu}
          icon={MoreHorizontal}
          tooltip="More options"
        />

        {showBlockMenu && (
          <div className="absolute top-full right-0 mt-1 z-50">
            <BlockMenu
              editor={editor}
              onClose={() => setShowBlockMenu(false)}
            />
          </div>
        )}
      </div>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Comment */}
      <ToolbarButton
        onClick={handleComment}
        isActive={false}
        icon={MessageSquare}
        tooltip={`${t('notes.blockMenu.comment')} (Ctrl+Shift+M)`}
      />

      {/* Cite — open citation picker */}
      <ToolbarButton
        onClick={() => window.dispatchEvent(new CustomEvent('open-citation-picker'))}
        isActive={false}
        icon={Quote}
        tooltip={`${t('notes.citation.insert')} (Ctrl+Shift+C)`}
      />

      {/* Suggest Edits */}
      <ToolbarButton
        onClick={handleToggleSuggestionMode}
        isActive={suggestionMode}
        icon={Edit3}
        tooltip={t('notes.blockMenu.suggestEdits')}
        className={cn(suggestionMode && 'bg-blue-100 dark:bg-blue-900')}
      />

      </div>
      )}

      {/* Row 2: Clipboard + AI Actions — wraps when no horizontal space */}
      <div className={cn('flex flex-wrap items-center gap-0.5', !isMobile && 'border-t border-border/50 pt-1 mt-0.5')}>

      {/* Clipboard cluster — Cut / Copy / Paste / Select All */}
      <ToolbarButton
        onClick={() => { void handleCut(); }}
        icon={Scissors}
        tooltip={t('notes.toolbar.cut', 'Cut')}
      />
      <ToolbarButton
        onClick={() => { void handleCopy(); }}
        icon={Copy}
        tooltip={t('notes.toolbar.copy', 'Copy')}
      />
      <ToolbarButton
        onClick={() => { void handlePaste(); }}
        icon={ClipboardPaste}
        tooltip={t('notes.toolbar.paste', 'Paste')}
      />
      <ToolbarButton
        onClick={handleSelectAll}
        icon={SquareDashedMousePointer}
        tooltip={t('notes.toolbar.selectAll', 'Select all')}
      />

      <div className="w-px h-5 bg-border mx-1" />

      {/* Improve Writing */}
      <ToolbarButton
        onClick={() => {
          const { from, to } = editor.state.selection;
          const text = editor.state.doc.textBetween(from, to, ' ');
          window.dispatchEvent(new CustomEvent('notes-ai-transform', { detail: { selectedText: text, from, to, transformType: 'improve' } }));
        }}
        icon={Wand2}
        tooltip={t('notes.toolbar.improveWriting', 'Improve writing')}
      />

      {/* Research This */}
      <ToolbarButton
        onClick={() => {
          const { from, to } = editor.state.selection;
          const text = editor.state.doc.textBetween(from, to, ' ');
          window.dispatchEvent(new CustomEvent('notes-ai-research', { detail: { selectedText: text, from, to } }));
        }}
        icon={BrainCircuit}
        tooltip={t('notes.toolbar.researchThis', 'Research this')}
      />

      {/* Find Citation */}
      <ToolbarButton
        onClick={() => {
          const { from, to } = editor.state.selection;
          const text = editor.state.doc.textBetween(from, to, ' ');
          window.dispatchEvent(new CustomEvent('notes-ai-citation', { detail: { selectedText: text, from, to } }));
        }}
        icon={Quote}
        tooltip={t('notes.toolbar.findCitation', 'Find citation')}
      />

      {/* Rephrase Academically */}
      <ToolbarButton
        onClick={() => {
          const { from, to } = editor.state.selection;
          const text = editor.state.doc.textBetween(from, to, ' ');
          window.dispatchEvent(new CustomEvent('notes-ai-transform', { detail: { selectedText: text, from, to, transformType: 'academic' } }));
        }}
        icon={PenLine}
        tooltip={t('notes.toolbar.rephraseAcademically', 'Rephrase academically')}
      />

      {/* Verify Claim */}
      <ToolbarButton
        onClick={() => {
          const { from, to } = editor.state.selection;
          const text = editor.state.doc.textBetween(from, to, ' ');
          window.dispatchEvent(new CustomEvent('notes-ai-verify', { detail: { selectedText: text, from, to } }));
        }}
        icon={ShieldCheck}
        tooltip={t('notes.toolbar.verifyClaim', 'Verify claim')}
      />

      {/* Feature 3 — Peer Review. Uses the ENTIRE note content (not
          just selection) because peer review needs the full document
          context. Selection position is only used to anchor the
          floating scanner panel. */}
      <ToolbarButton
        onClick={() => {
          const { from } = editor.state.selection;
          const fullText = editor.getText();
          window.dispatchEvent(
            new CustomEvent('notes-ai-review', {
              detail: {
                content: fullText,
                sourceType: 'note',
                sourceTitle: '',
                anchorFrom: from,
              },
            })
          );
        }}
        icon={ClipboardCheck}
        tooltip={t('notes.toolbar.reviewPaper', 'Review paper')}
      />

      {/* Simplify */}
      <ToolbarButton
        onClick={() => {
          const { from, to } = editor.state.selection;
          const text = editor.state.doc.textBetween(from, to, ' ');
          window.dispatchEvent(new CustomEvent('notes-ai-transform', { detail: { selectedText: text, from, to, transformType: 'simplify' } }));
        }}
        icon={Wand2}
        tooltip={t('notes.toolbar.simplify', 'Simplify')}
      />

      {/* Expand */}
      <ToolbarButton
        onClick={() => {
          const { from, to } = editor.state.selection;
          const text = editor.state.doc.textBetween(from, to, ' ');
          window.dispatchEvent(new CustomEvent('notes-ai-transform', { detail: { selectedText: text, from, to, transformType: 'expand' } }));
        }}
        icon={Maximize2}
        tooltip={t('notes.toolbar.expand', 'Expand')}
      />

      {/* Translate */}
      <ToolbarButton
        onClick={() => {
          const { from, to } = editor.state.selection;
          const text = editor.state.doc.textBetween(from, to, ' ');
          window.dispatchEvent(new CustomEvent('notes-ai-transform', { detail: { selectedText: text, from, to, transformType: 'translate' } }));
        }}
        icon={Languages}
        tooltip={t('notes.toolbar.translate', 'Translate')}
      />
      </div>

      {/* Link Dialog */}
      <Dialog open={showLinkDialog} onOpenChange={setShowLinkDialog}>
        <DialogContent data-testid="notes-link-dialog" className="sm:max-w-md" hideCloseButton dialogOpen={showLinkDialog} onOpenChange={setShowLinkDialog}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5" />
              Add Link
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="link-url">URL</Label>
              <Input
                id="link-url"
                data-testid="notes-link-url-input"
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
