import type { WindowMode, WindowRect } from '@/types/floating-window';

const KEY = (id: string) => `scrapalot_fw_${id}`;

interface PersistedState {
  mode?: WindowMode;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

function read(id: string): PersistedState {
  try {
    return JSON.parse(localStorage.getItem(KEY(id)) || '{}');
  } catch {
    return {};
  }
}

function write(id: string, patch: PersistedState): void {
  try {
    const current = read(id);
    localStorage.setItem(KEY(id), JSON.stringify({ ...current, ...patch }));
  } catch {
    // localStorage may be unavailable (private mode, full quota); silent fallback.
  }
}

export function makeFloatingWindowStorage(id: string) {
  return {
    getMode: (): WindowMode | null => read(id).mode ?? null,
    setMode: (mode: WindowMode) => write(id, { mode }),
    getRect: (): Partial<WindowRect> | null => {
      const r = read(id);
      if (r.left == null || r.top == null || r.width == null || r.height == null) {
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      }
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    },
    setRect: (rect: Partial<WindowRect>) => write(id, rect),
  };
}
