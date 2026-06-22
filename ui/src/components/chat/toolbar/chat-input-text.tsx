import React, { forwardRef, useState, useCallback, useRef, useEffect } from 'react';
import { Textarea } from '@/components/ui/textarea.tsx';
import { cn } from '@/lib/utils.ts';
import { useTranslation } from 'react-i18next';
import { useIsMobileOrTabletPortrait } from '@/hooks/use-mobile';
import type { MentionItem } from '@/hooks/use-chat-mentions';

interface ChatTextAreaProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled: boolean;
  placeholder?: string;
  onCursorChange?: (cursorPos: number) => void;
  mentions?: MentionItem[];
}

export const ChatInputText = forwardRef<HTMLTextAreaElement, ChatTextAreaProps>(
  ({ value, onChange, onKeyDown, disabled, placeholder, onCursorChange, mentions: _mentions = [] }, ref) => {
    const [isFocused, setIsFocused] = useState(false);
    const [dragExtra, setDragExtra] = useState(0);
    // Persist the visible-grip styling for the duration of a drag so the
    // handle doesn't snap back to the invisible default when the cursor
    // strays off the strip mid-drag (the global mousemove keeps the
    // resize active even when :hover stops matching).
    const [isDragging, setIsDragging] = useState(false);
    const { t } = useTranslation();
    const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();
    const internalRef = useRef<HTMLTextAreaElement>(null);
    const textareaRef = (ref as React.RefObject<HTMLTextAreaElement>) || internalRef;
    const dragStateRef = useRef<{ startY: number; startExtra: number } | null>(null);

    const adjustHeight = useCallback(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
        const baseHeight = isMobileOrTabletPortrait ? 56 : 76;
        const minHeight = baseHeight + dragExtra;
        const maxHeight = minHeight + (isMobileOrTabletPortrait ? 144 : 150);
        textarea.style.maxHeight = `${maxHeight}px`;
        const newHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
        textarea.style.height = `${newHeight}px`;
      }
    }, [textareaRef, isMobileOrTabletPortrait, dragExtra]);

    useEffect(() => {
      adjustHeight();
    }, [value, adjustHeight]);

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        onChange(e);
        if (onCursorChange) {
          onCursorChange(e.target.selectionStart);
        }
      },
      [onChange, onCursorChange]
    );

    const handleSelect = useCallback(() => {
      const textarea = textareaRef.current;
      if (textarea && onCursorChange) {
        onCursorChange(textarea.selectionStart);
      }
    }, [textareaRef, onCursorChange]);

    useEffect(() => {
      window.dispatchEvent(
        new CustomEvent('chat-input-focus-change', { detail: { focused: isFocused } })
      );
    }, [isFocused]);

    const handleDragHandleMouseDown = useCallback((e: React.MouseEvent) => {
      // Prevent textarea blur when clicking the handle
      e.preventDefault();
      setIsDragging(true);
      dragStateRef.current = { startY: e.clientY, startExtra: dragExtra };

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragStateRef.current) return;
        const delta = dragStateRef.current.startY - ev.clientY;
        setDragExtra(Math.max(0, Math.min(200, dragStateRef.current.startExtra + delta)));
      };

      const onMouseUp = () => {
        dragStateRef.current = null;
        setIsDragging(false);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }, [dragExtra]);

    const handleDragHandleTouchStart = useCallback((e: React.TouchEvent) => {
      setIsDragging(true);
      dragStateRef.current = { startY: e.touches[0].clientY, startExtra: dragExtra };

      const onTouchMove = (ev: TouchEvent) => {
        // Prevent page scroll while resizing
        ev.preventDefault();
        if (!dragStateRef.current) return;
        const delta = dragStateRef.current.startY - ev.touches[0].clientY;
        setDragExtra(Math.max(0, Math.min(200, dragStateRef.current.startExtra + delta)));
      };

      const onTouchEnd = () => {
        dragStateRef.current = null;
        setIsDragging(false);
        window.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('touchend', onTouchEnd);
      };

      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('touchend', onTouchEnd);
    }, [dragExtra]);

    return (
      <div className='relative'>
        <div
          // Drag-to-resize handle. Default state is essentially blank —
          // a 1.5 px-tall transparent strip — so it doesn't compete
          // visually with the chat-input wrapper's own top border.
          // On hover (and while dragging) the strip animates to a 4 px
          // pill with a fill colour and the ··· grips fade in, giving a
          // clear "this is where to grab" affordance.
          //
          // `isDragging` keeps the open state during the whole drag
          // gesture so the handle doesn't snap back to invisible the
          // moment the cursor leaves the strip mid-drag (the resize is
          // driven by global mousemove listeners, not :hover).
          //
          // Touch still works because the strip retains its layout,
          // cursor-ns-resize and onTouchStart binding. Touch devices
          // ignore :hover, so the visual affordance only fades in
          // during an active drag — but the touch target itself is
          // unchanged, so the gesture is the same as before.
          className={cn(
            'group flex items-end justify-center relative',
            'cursor-ns-resize select-none touch-none',
            'transition-[height,background-color] duration-200 ease-out',
            // 4 px → 12 px: 3× growth, clearly noticeable. The fill
            // colour appears at the same time so the empty space turns
            // into a visible "grip pad".
            isDragging
              ? 'h-3 bg-zinc-200/50 dark:bg-zinc-700/40'
              : 'h-1 bg-transparent hover:h-3 hover:bg-zinc-200/50 dark:hover:bg-zinc-700/40'
          )}
          onMouseDown={handleDragHandleMouseDown}
          onTouchStart={handleDragHandleTouchStart}
        >
          {/* Static hairline divider so the handle is at least
              perceivable when no one is interacting with it. Doesn't
              thicken on hover / drag — the container's growth + fill
              already carry the affordance and a darkening pill on top
              of that just doubled up the visual noise. */}
          <div className='absolute bottom-0 left-0 right-0 pointer-events-none h-px bg-zinc-300/30 dark:bg-zinc-700/20' />
          <span
            className={cn(
              'relative z-10 flex flex-col items-center gap-[2px]',
              'transition-opacity duration-200',
              isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            <span className='text-[6px] leading-none tracking-[0.4em] text-zinc-500 dark:text-zinc-300'>···</span>
            <span className='text-[6px] leading-none tracking-[0.4em] text-zinc-500 dark:text-zinc-300'>···</span>
          </span>
        </div>
        <Textarea
          ref={textareaRef}
          data-testid="chat-input"
          placeholder={
            isFocused && !value.trim()
              ? t('chat.mentions.inputHint')
              : (placeholder || t('chat.placeholder'))
          }
          className={cn(
            'focus-visible:ring-0 focus-visible:ring-offset-0',
            'placeholder:text-zinc-500 dark:placeholder:text-zinc-400',
            'transition-colors duration-200 ease-out',
            value.trim() ? 'overflow-y-auto' : 'overflow-y-hidden',
            'text-zinc-800 dark:text-zinc-200',
            'bg-zinc-50/40 dark:bg-zinc-900/70 backdrop-blur-sm',
            isMobileOrTabletPortrait
              ? cn(
                  'min-h-[76px] pr-16 p-4 text-base placeholder:text-sm',
                  'border-0',
                  'rounded-none'
                )
              : cn(
                  'min-h-[76px] pr-16 sm:pr-4 p-4',
                  'border-0',
                  'resize-none'
                )
          )}
          value={value}
          onChange={handleChange}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          onSelect={handleSelect}
        />
      </div>
    );
  }
);
ChatInputText.displayName = 'ChatInputText';
