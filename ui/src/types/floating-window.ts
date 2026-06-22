export type WindowMode = 'floating' | 'pinned-left' | 'pinned-right' | 'maximized';

export interface WindowRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WindowState {
  mode: WindowMode;
  /** Remembered free-position rect; restored when user toggles back to 'floating'. */
  freeRect?: WindowRect;
}

export const DEFAULT_WINDOW_STATE: WindowState = { mode: 'floating' };

export const EDGE_SNAP_THRESHOLD = 60;

export const WINDOW_MIN_WIDTH = 280;
export const WINDOW_MIN_HEIGHT = 320;
