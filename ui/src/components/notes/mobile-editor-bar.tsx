/**
 * Mobile Editor Bar - Notion-style floating bar for mobile devices
 * Appears at the bottom when editor is focused, with undo/redo and quick actions
 */

import React, { useEffect, useState } from 'react';
import { Editor } from '@tiptap/react';
import {
  Undo,
  Redo,
  Bold,
  Italic,
  List,
  CheckSquare,
  Heading1,
  Keyboard,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Track the on-screen keyboard height via the visualViewport API so the
 * toolbar can sit flush with the top of the keyboard instead of getting
 * hidden behind it. Returns the number of pixels the keyboard covers.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      // layoutViewportHeight - visualViewportHeight = keyboard height
      // offsetTop handles the case when the viewport scrolls under the keyboard
      const next = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setInset(next);
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('orientationchange', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return inset;
}

interface MobileEditorBarProps {
  editor: Editor;
  isVisible: boolean;
  onDismissKeyboard?: () => void;
}

interface BarButtonProps {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ElementType;
  isActive?: boolean;
}

const BarButton: React.FC<BarButtonProps> = ({
  onClick,
  disabled = false,
  icon: Icon,
  isActive = false,
}) => (
  <button
    onClick={(e) => {
      e.preventDefault();
      onClick();
    }}
    onMouseDown={(e) => e.preventDefault()}
    disabled={disabled}
    className={cn(
      'h-10 w-10 flex items-center justify-center rounded-lg transition-colors',
      'active:bg-accent active:scale-95',
      disabled && 'opacity-30',
      isActive && 'bg-accent text-accent-foreground'
    )}
    type="button"
  >
    <Icon className="h-5 w-5" />
  </button>
);

export const MobileEditorBar: React.FC<MobileEditorBarProps> = ({
  editor,
  isVisible,
  onDismissKeyboard,
}) => {
  const keyboardInset = useKeyboardInset();

  if (!isVisible || !editor) return null;

  return (
    <div
      data-testid="notes-mobile-editor-bar"
      style={{
        // Sit flush against the top of the keyboard, or at the screen bottom when hidden.
        // When the keyboard is open we also drop safe-area padding so the bar hugs it cleanly.
        bottom: `${keyboardInset}px`,
        paddingBottom: keyboardInset > 0 ? '6px' : undefined,
      }}
      className={cn(
        'fixed left-0 right-0 z-[9999]',
        'bg-background/95 backdrop-blur-sm border-t border-border',
        'px-2 py-1.5',
        keyboardInset === 0 && 'safe-area-inset-bottom',
        'flex items-center justify-between gap-1',
        'animate-in slide-in-from-bottom duration-200',
        'transition-[bottom] duration-150 ease-out'
      )}
    >
      {/* Left side - Undo/Redo */}
      <div className="flex items-center gap-0.5">
        <BarButton
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          icon={Undo}
        />
        <BarButton
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          icon={Redo}
        />
      </div>

      {/* Center - Quick formatting */}
      <div className="flex items-center gap-0.5">
        <BarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          icon={Bold}
          isActive={editor.isActive('bold')}
        />
        <BarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          icon={Italic}
          isActive={editor.isActive('italic')}
        />
        <BarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          icon={Heading1}
          isActive={editor.isActive('heading', { level: 1 })}
        />
        <BarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          icon={List}
          isActive={editor.isActive('bulletList')}
        />
        <BarButton
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          icon={CheckSquare}
          isActive={editor.isActive('taskList')}
        />
      </div>

      {/* Right side - Dismiss keyboard */}
      <div className="flex items-center">
        <BarButton
          onClick={() => {
            editor.commands.blur();
            onDismissKeyboard?.();
          }}
          icon={Keyboard}
        />
      </div>
    </div>
  );
};
