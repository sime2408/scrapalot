/**
 * Hook to render drag handles as an overlay (outside contenteditable)
 * This avoids conflicts with TipTap's DOM management
 *
 * Notion-like behavior:
 * - Handles appear on the left of each block
 * - Includes both a "+" button and drag handle (6-dot)
 */

import { useEffect, useState, useCallback, useRef, RefObject } from 'react';
import { Editor } from '@tiptap/react';

interface BlockPosition {
  id: string;
  top: number;
  left: number;
  height: number;
  /** ProseMirror padding-left in px — the gutter where buttons live */
  gutterWidth: number;
}

export const useDragHandleOverlay = (
  editor: Editor | null,
  editable: boolean,
  containerRef?: RefObject<HTMLDivElement>
) => {
  const [blockPositions, setBlockPositions] = useState<BlockPosition[]>([]);
  const [hoveredBlock, setHoveredBlock] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const throttleRef = useRef<number>(0);

  const updateBlockPositions = useCallback(() => {
    if (!editor) return;

    // Throttle: skip if last update was <100ms ago
    const now = Date.now();
    if (now - throttleRef.current < 100) return;
    throttleRef.current = now;

    const editorElement = editor.view.dom as HTMLElement;
    const proseMirror = editorElement.closest('.ProseMirror') || editorElement;
    const blocks = proseMirror.querySelectorAll(':scope > *');

    let containerRect: DOMRect | null = null;
    if (containerRef?.current) {
      containerRect = containerRef.current.getBoundingClientRect();
    } else {
      const container = editorElement.closest('[data-notes-container]') ||
                        editorElement.parentElement?.parentElement;
      if (container) {
        containerRect = container.getBoundingClientRect();
      }
    }

    if (!containerRect) return;

    // Read ProseMirror padding-left once (the gutter)
    const pmElement = proseMirror as HTMLElement;
    const gutterWidth = pmElement.style.paddingLeft
      ? parseFloat(pmElement.style.paddingLeft)
      : parseFloat(getComputedStyle(pmElement).paddingLeft) || 56;

    const positions: BlockPosition[] = [];

    blocks.forEach((block, index) => {
      if (!(block instanceof HTMLElement)) return;

      const rect = block.getBoundingClientRect();
      positions.push({
        id: `block-${index}`,
        top: rect.top - containerRect!.top,
        left: rect.left - containerRect!.left,
        height: rect.height,
        gutterWidth,
      });
    });

    setBlockPositions(positions);
  }, [editor, containerRef]);

  useEffect(() => {
    if (!editor || !editable) {
      setBlockPositions([]);
      return;
    }

    const scheduleUpdate = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(updateBlockPositions);
    };

    // Initial update with delay to ensure DOM is ready
    const initialTimeout = setTimeout(updateBlockPositions, 200);

    // Only update on document content changes, NOT on every transaction
    editor.on('update', scheduleUpdate);

    // Update on scroll/resize
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);

    return () => {
      clearTimeout(initialTimeout);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      editor.off('update', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
    };
  }, [editor, editable, updateBlockPositions]);

  return { blockPositions, hoveredBlock, setHoveredBlock };
};
