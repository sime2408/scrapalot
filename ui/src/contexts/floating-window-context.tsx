import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { WindowMode } from '@/types/floating-window';

const BASE_Z = 60;
const MAX_OFFSET = 30;

interface FloatingWindowContextValue {
  registerWindow: (id: string) => void;
  unregisterWindow: (id: string) => void;
  bringToFront: (id: string) => void;
  /** Order of last focus, 0 = oldest, n-1 = most recently focused. -1 if not registered. */
  getOrder: (id: string) => number;
  /** Convenience: BASE_Z + order. Use this only when the window's base layer is around 60. */
  getZIndex: (id: string) => number;
  /** True if id is the most recently focused floating window — used to boost its z above all others. */
  isTopFocused: (id: string) => boolean;

  /** Mode tracking — used by chat layout to ignore floating viewers when computing widths. */
  modes: Record<string, WindowMode>;
  reportMode: (id: string, mode: WindowMode) => void;
  /** True if the window is open AND not floating (i.e. it actually occupies side space). */
  isPinned: (id: string) => boolean;

  edgeSnapActive: boolean;
  edgeSnapZone: 'left' | 'right' | null;
  startEdgeSnap: () => void;
  endEdgeSnap: () => void;
  setEdgeSnapZone: (zone: 'left' | 'right' | null) => void;
}

const FloatingWindowContext = createContext<FloatingWindowContextValue | null>(null);

export function FloatingWindowProvider({ children }: { children: React.ReactNode }) {
  const [order, setOrder] = useState<string[]>([]);
  const [modes, setModes] = useState<Record<string, WindowMode>>({});
  const [edgeSnapActive, setEdgeSnapActive] = useState(false);
  const [edgeSnapZone, setEdgeSnapZone] = useState<'left' | 'right' | null>(null);

  const registerWindow = useCallback((id: string) => {
    setOrder(prev => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const unregisterWindow = useCallback((id: string) => {
    setOrder(prev => prev.filter(x => x !== id));
  }, []);

  const bringToFront = useCallback((id: string) => {
    setOrder(prev => {
      if (prev[prev.length - 1] === id) return prev;
      const without = prev.filter(x => x !== id);
      return [...without, id];
    });
  }, []);

  const getOrder = useCallback(
    (id: string) => {
      const idx = order.indexOf(id);
      return idx === -1 ? -1 : Math.min(idx, MAX_OFFSET);
    },
    [order],
  );

  const getZIndex = useCallback(
    (id: string) => {
      const idx = order.indexOf(id);
      if (idx === -1) return BASE_Z;
      return BASE_Z + Math.min(idx, MAX_OFFSET);
    },
    [order],
  );

  const isTopFocused = useCallback((id: string) => {
    return order.length > 0 && order[order.length - 1] === id;
  }, [order]);

  const reportMode = useCallback((id: string, mode: WindowMode) => {
    setModes(prev => (prev[id] === mode ? prev : { ...prev, [id]: mode }));
  }, []);

  const isPinned = useCallback((id: string) => {
    const m = modes[id];
    return m !== undefined && m !== 'floating';
  }, [modes]);

  const startEdgeSnap = useCallback(() => {
    setEdgeSnapActive(true);
    setEdgeSnapZone(null);
  }, []);

  const endEdgeSnap = useCallback(() => {
    setEdgeSnapActive(false);
    setEdgeSnapZone(null);
  }, []);

  const value = useMemo<FloatingWindowContextValue>(
    () => ({
      registerWindow,
      unregisterWindow,
      bringToFront,
      getOrder,
      getZIndex,
      isTopFocused,
      modes,
      reportMode,
      isPinned,
      edgeSnapActive,
      edgeSnapZone,
      startEdgeSnap,
      endEdgeSnap,
      setEdgeSnapZone,
    }),
    [registerWindow, unregisterWindow, bringToFront, getOrder, getZIndex, isTopFocused, modes, reportMode, isPinned, edgeSnapActive, edgeSnapZone, startEdgeSnap, endEdgeSnap],
  );

  return <FloatingWindowContext.Provider value={value}>{children}</FloatingWindowContext.Provider>;
}

export function useFloatingWindowManager(): FloatingWindowContextValue {
  const ctx = useContext(FloatingWindowContext);
  if (!ctx) {
    return {
      registerWindow: () => {},
      unregisterWindow: () => {},
      bringToFront: () => {},
      getOrder: () => -1,
      getZIndex: () => BASE_Z,
      isTopFocused: () => false,
      modes: {},
      reportMode: () => {},
      isPinned: () => false,
      edgeSnapActive: false,
      edgeSnapZone: null,
      startEdgeSnap: () => {},
      endEdgeSnap: () => {},
      setEdgeSnapZone: () => {},
    };
  }
  return ctx;
}
