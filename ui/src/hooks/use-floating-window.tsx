import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFloatingWindowManager } from '@/contexts/floating-window-context';
import { EDGE_SNAP_THRESHOLD, WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from '@/types/floating-window';
import type { WindowMode, WindowRect } from '@/types/floating-window';

interface FloatingStorage {
  getMode?: () => WindowMode | null;
  setMode?: (mode: WindowMode) => void;
  getRect?: () => Partial<WindowRect> | null;
  setRect?: (rect: Partial<WindowRect>) => void;
}

interface UseFloatingWindowOpts {
  id: string;
  initialMode?: WindowMode;
  /** Default size for first entry into floating mode. */
  defaultFloatingSize?: { width: number; height: number };
  storage?: FloatingStorage;
  /** When true, hook reports maximized regardless of stored mode (e.g. narrow mobile). */
  forceMaximized?: boolean;
  /** When true, hook returns no-op handlers (drag/resize disabled). */
  disabled?: boolean;
}

interface UseFloatingWindowResult {
  mode: WindowMode;
  setMode: (m: WindowMode) => void;
  isFloating: boolean;
  isPinnedLeft: boolean;
  isPinnedRight: boolean;
  isMaximized: boolean;
  floatingStyle: React.CSSProperties;
  /** Callback ref. Pass directly to a div: <div ref={fw.panelRef} />. */
  panelRef: (node: HTMLDivElement | null) => void;
  /** Read the current panel node when needed (e.g. for getBoundingClientRect during drag). */
  getPanel: () => HTMLDivElement | null;
  headerDragProps: { onMouseDown: (e: React.MouseEvent) => void; className: string };
  focusProps: { onMouseDownCapture: () => void };
  resizeHandles: React.ReactNode;
  order: number;
}

export function useFloatingWindow(opts: UseFloatingWindowOpts): UseFloatingWindowResult {
  const {
    id,
    initialMode = 'floating',
    defaultFloatingSize = { width: 480, height: 600 },
    storage,
    forceMaximized = false,
    disabled = false,
  } = opts;

  const mgr = useFloatingWindowManager();
  // Pull stable function refs out of mgr — the manager's value memo changes
  // every time order/modes change, but the individual callbacks (wrapped in
  // useCallback with no deps inside the provider) keep the same identity.
  // Using these directly in useEffect deps prevents register/unregister from
  // thrashing on every state update.
  const { registerWindow, unregisterWindow, bringToFront, reportMode } = mgr;
  const panelNodeRef = useRef<HTMLDivElement | null>(null);
  const focusHandlerRef = useRef<() => void>(() => {});
  // Wrap the ref read in a stable function so addEventListener gets one
  // callable identity across the panel's lifetime.
  const stableMouseDown = useRef<() => void>(() => focusHandlerRef.current());
  const panelRef = useCallback((node: HTMLDivElement | null) => {
    if (panelNodeRef.current) {
      panelNodeRef.current.removeEventListener('mousedown', stableMouseDown.current, true);
    }
    panelNodeRef.current = node;
    if (node) {
      node.addEventListener('mousedown', stableMouseDown.current, true);
    }
  }, []);
  const getPanel = useCallback(() => panelNodeRef.current, []);

  const [storedMode, setStoredMode] = useState<WindowMode>(() => storage?.getMode?.() ?? initialMode);
  const [rect, setRectState] = useState<WindowRect>(() => {
    const persisted = storage?.getRect?.() ?? {};
    const w = persisted.width ?? defaultFloatingSize.width;
    const h = persisted.height ?? defaultFloatingSize.height;
    const left = persisted.left ?? Math.max(40, (typeof window !== 'undefined' ? window.innerWidth : 1024) - w - 80);
    const top = persisted.top ?? 80;
    return { left, top, width: w, height: h };
  });

  useEffect(() => {
    registerWindow(id);
    return () => unregisterWindow(id);
  }, [registerWindow, unregisterWindow, id]);

  const mode: WindowMode = forceMaximized ? 'maximized' : storedMode;

  useEffect(() => {
    reportMode(id, mode);
  }, [reportMode, id, mode]);

  const setMode = useCallback((m: WindowMode) => {
    setStoredMode(m);
    storage?.setMode?.(m);
  }, [storage]);

  const persistRect = useCallback((r: WindowRect) => {
    setRectState(r);
    storage?.setRect?.(r);
  }, [storage]);

  const focus = useCallback(() => bringToFront(id), [bringToFront, id]);
  // Keep focusHandlerRef pointing at the latest focus callback so the native
  // mousedown listener (attached once by panelRef on mount) always reads
  // through to the current bringToFront — no detach/reattach churn needed.
  focusHandlerRef.current = focus;

  const beginDrag = useCallback((e: React.MouseEvent) => {
    if (disabled) return;
    if (e.button !== 0) return;
    if (!getPanel()) return;
    if ((e.target as HTMLElement).closest('button, select, input, textarea, [role="menuitem"]')) return;
    e.preventDefault();
    mgr.bringToFront(id);

    const elRect = getPanel().getBoundingClientRect();
    const wasPinned = mode !== 'floating';

    let w = elRect.width;
    let h = elRect.height;
    let offX = e.clientX - elRect.left;
    let offY = e.clientY - elRect.top;

    if (wasPinned) {
      // Tear-off: shrink to default floating size and re-center under cursor.
      w = Math.min(elRect.width, defaultFloatingSize.width);
      h = Math.min(elRect.height, Math.max(window.innerHeight - 100, WINDOW_MIN_HEIGHT));
      offX = w / 2;
      offY = 20;
      setMode('floating');
    }

    let lastL = e.clientX - offX;
    let lastT = e.clientY - offY;
    setRectState({ left: lastL, top: lastT, width: w, height: h });
    let snapZone: 'left' | 'right' | null = null;

    mgr.startEdgeSnap();

    const onMove = (ev: MouseEvent) => {
      lastL = Math.min(Math.max(ev.clientX - offX, 0), Math.max(window.innerWidth - w, 0));
      lastT = Math.min(Math.max(ev.clientY - offY, 0), Math.max(window.innerHeight - h, 0));
      setRectState({ left: lastL, top: lastT, width: w, height: h });

      const px = ev.clientX;
      if (px < EDGE_SNAP_THRESHOLD) snapZone = 'left';
      else if (px > window.innerWidth - EDGE_SNAP_THRESHOLD) snapZone = 'right';
      else snapZone = null;
      mgr.setEdgeSnapZone(snapZone);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      mgr.endEdgeSnap();

      if (snapZone) {
        setMode(snapZone === 'left' ? 'pinned-left' : 'pinned-right');
      } else {
        persistRect({ left: lastL, top: lastT, width: w, height: h });
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }, [disabled, mgr, id, mode, defaultFloatingSize, setMode, persistRect]);

  const beginResize = useCallback((dir: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw') => (e: React.MouseEvent) => {
    if (disabled) return;
    if (!getPanel()) return;
    if (mode !== 'floating') return;
    e.preventDefault();
    e.stopPropagation();
    mgr.bringToFront(id);

    const elRect = getPanel().getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = elRect.width;
    const startH = elRect.height;
    const startL = elRect.left;
    const startT = elRect.top;
    let lastW = startW;
    let lastH = startH;
    let lastL = startL;
    let lastT = startT;

    const cursorMap: Record<typeof dir, string> = {
      n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
      nw: 'nwse-resize', se: 'nwse-resize',
      ne: 'nesw-resize', sw: 'nesw-resize',
    };

    const onMove = (ev: MouseEvent) => {
      if (dir.includes('w')) {
        // West edge: width grows leftward, left moves with it.
        const dx = startX - ev.clientX;
        lastW = Math.min(Math.max(startW + dx, WINDOW_MIN_WIDTH), window.innerWidth - 80);
        lastL = Math.max(startL - (lastW - startW), 0);
      } else if (dir.includes('e')) {
        // East edge: width grows rightward, left stays.
        const dx = ev.clientX - startX;
        lastW = Math.min(Math.max(startW + dx, WINDOW_MIN_WIDTH), window.innerWidth - startL - 8);
        lastL = startL;
      }
      if (dir.includes('n')) {
        // North edge: height grows upward, top moves with it.
        const dy = startY - ev.clientY;
        lastH = Math.min(Math.max(startH + dy, WINDOW_MIN_HEIGHT), window.innerHeight - 80);
        lastT = Math.max(startT - (lastH - startH), 0);
      } else if (dir.includes('s')) {
        // South edge: height grows downward, top stays.
        const dy = ev.clientY - startY;
        lastH = Math.min(Math.max(startH + dy, WINDOW_MIN_HEIGHT), window.innerHeight - startT - 8);
        lastT = startT;
      }
      setRectState({ left: lastL, top: lastT, width: lastW, height: lastH });
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persistRect({ left: lastL, top: lastT, width: lastW, height: lastH });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = cursorMap[dir];
    document.body.style.userSelect = 'none';
  }, [disabled, mgr, id, mode, persistRect]);

  const isFloating = mode === 'floating';
  const isPinnedLeft = mode === 'pinned-left';
  const isPinnedRight = mode === 'pinned-right';
  const isMaximized = mode === 'maximized';

  const floatingStyle: React.CSSProperties = useMemo(() => ({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  }), [rect]);

  const headerDragProps = useMemo(() => ({
    onMouseDown: beginDrag,
    className: disabled || forceMaximized ? '' : 'cursor-grab active:cursor-grabbing',
  }), [beginDrag, disabled, forceMaximized]);

  const focusProps = useMemo(() => ({ onMouseDownCapture: focus }), [focus]);

  const resizeHandles = useMemo(() => {
    if (!isFloating || disabled) return null;
    return (
      <>
        {/* Edges — 1.5 px hit areas hugging each side; corners (12 x 12) sit on top with z-30. */}
        <div
          onMouseDown={beginResize('w')}
          data-testid={`${id}-resize-w`}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize z-20 hover:bg-primary/40 transition-colors"
        />
        <div
          onMouseDown={beginResize('e')}
          data-testid={`${id}-resize-e`}
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize z-20 hover:bg-primary/40 transition-colors"
        />
        <div
          onMouseDown={beginResize('n')}
          data-testid={`${id}-resize-n`}
          className="absolute left-0 right-0 top-0 h-1.5 cursor-ns-resize z-20 hover:bg-primary/40 transition-colors"
        />
        <div
          onMouseDown={beginResize('s')}
          data-testid={`${id}-resize-s`}
          className="absolute left-0 right-0 bottom-0 h-1.5 cursor-ns-resize z-20 hover:bg-primary/40 transition-colors"
        />
        <div
          onMouseDown={beginResize('nw')}
          data-testid={`${id}-resize-nw`}
          className="absolute left-0 top-0 w-3 h-3 cursor-nwse-resize z-30 hover:bg-primary/40 transition-colors"
        />
        <div
          onMouseDown={beginResize('ne')}
          data-testid={`${id}-resize-ne`}
          className="absolute right-0 top-0 w-3 h-3 cursor-nesw-resize z-30 hover:bg-primary/40 transition-colors"
        />
        <div
          onMouseDown={beginResize('sw')}
          data-testid={`${id}-resize-sw`}
          className="absolute left-0 bottom-0 w-3 h-3 cursor-nesw-resize z-30 hover:bg-primary/40 transition-colors"
        />
        <div
          onMouseDown={beginResize('se')}
          data-testid={`${id}-resize-se`}
          className="absolute right-0 bottom-0 w-3 h-3 cursor-nwse-resize z-30 hover:bg-primary/40 transition-colors"
        />
      </>
    );
  }, [isFloating, disabled, beginResize, id]);

  return {
    mode,
    setMode,
    isFloating,
    isPinnedLeft,
    isPinnedRight,
    isMaximized,
    floatingStyle,
    panelRef,
    headerDragProps,
    focusProps,
    resizeHandles,
    order: mgr.getOrder(id),
  };
}
