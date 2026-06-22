/**
 * DraggablePanel — wrapper that makes floating panels repositionable.
 *
 * Exposes pointer handlers via DragHandleContext so panels can place a
 * <DragHandle /> anywhere inside their header — typically next to the X
 * button — instead of having a fixed left-edge strip.
 */

import React, { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DragHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
}

const DragHandleContext = createContext<DragHandlers | null>(null);

interface DraggablePanelProps {
  initialPosition: { top: number; left: number };
  className?: string;
  children: React.ReactNode;
  onClickOutside?: () => void;
}

export function DraggablePanel({ initialPosition, className, children, onClickOutside }: DraggablePanelProps) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Measured after mount so we can clamp the panel inside the viewport
  // using its REAL height instead of a hardcoded 120px margin — a tall
  // panel like Find Citation (≈598px at max-h-[70vh]) otherwise slid off
  // the bottom edge whenever the click target was mid-screen.
  const [panelSize, setPanelSize] = useState<{ width: number; height: number }>({ width: 380, height: 200 });
  const dragState = useRef<{ startX: number; startY: number; startOffsetX: number; startOffsetY: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!panelRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setPanelSize((prev) => {
        if (Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1) return prev;
        return { width, height };
      });
    });
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      startOffsetX: offset.x,
      startOffsetY: offset.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [offset]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    setOffset({
      x: dragState.current.startOffsetX + dx,
      y: dragState.current.startOffsetY + dy,
    });
  }, []);

  const onPointerUp = useCallback(() => {
    dragState.current = null;
  }, []);

  const handlers = useMemo<DragHandlers>(
    () => ({ onPointerDown, onPointerMove, onPointerUp }),
    [onPointerDown, onPointerMove, onPointerUp]
  );

  // Clamp the panel inside the viewport using its measured size so the
  // bottom edge never falls below `window.innerHeight - 8`. Before this
  // fix a 598px tall panel (Find Citation at max-h-[70vh]) clipped
  // ~67px off the bottom on short viewports.
  const VIEWPORT_PADDING = 8;
  const maxTop = window.innerHeight - panelSize.height - VIEWPORT_PADDING;
  const maxLeft = window.innerWidth - panelSize.width - VIEWPORT_PADDING;
  const top = Math.max(VIEWPORT_PADDING, Math.min(initialPosition.top + offset.y, maxTop));
  const left = Math.max(VIEWPORT_PADDING, Math.min(initialPosition.left + offset.x, maxLeft));

  return (
    <>
      {/* Backdrop — click outside to close. Sits one below the panel but
          above the selection toolbar (z-[10001]) so a click outside the
          panel does not land back on a toolbar button. */}
      {onClickOutside && (
        <div className="fixed inset-0 z-[10001]" onClick={onClickOutside} />
      )}
      <div
        ref={panelRef}
        className={cn(
          // Must stack above the TipTap selection toolbar which uses
          // z-[10001] (see src/components/notes/selection-toolbar.tsx).
          // Panels opened from the toolbar otherwise render behind it.
          'fixed z-[10002] bg-popover border border-border shadow-lg',
          'animate-in fade-in-0 slide-in-from-top-2',
          'flex flex-col max-h-[70vh]',
          className,
        )}
        style={{ top, left }}
      >
        <DragHandleContext.Provider value={handlers}>
          {children}
        </DragHandleContext.Provider>
      </div>
    </>
  );
}

/**
 * DragHandle — a small grip button that activates panel dragging when
 * pressed. Place it in the panel header, typically next to the close button.
 */
export function DragHandle({ className }: { className?: string }) {
  const handlers = useContext(DragHandleContext);
  if (!handlers) return null;
  return (
    <button
      type="button"
      aria-label="Drag panel"
      {...handlers}
      className={cn(
        'h-6 w-6 flex items-center justify-center rounded',
        'cursor-grab active:cursor-grabbing touch-none select-none',
        'hover:bg-muted text-muted-foreground/60 hover:text-muted-foreground',
        className,
      )}
    >
      <GripVertical className="h-3.5 w-3.5" />
    </button>
  );
}
