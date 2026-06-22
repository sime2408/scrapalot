import { create } from 'zustand';

interface NotesDrawerStore {
  isOpen: boolean;
  sessionId?: string;
  noteId?: string;
  isOnLeft: boolean; // Track if Notes drawer is positioned on the left
  open: (sessionId?: string, noteId?: string) => void;
  close: () => void;
  toggle: () => void;
  setPosition: (isOnLeft: boolean) => void;
}

export const useNotesDrawer = create<NotesDrawerStore>((set) => ({
  isOpen: false,
  sessionId: undefined,
  noteId: undefined,
  isOnLeft: false, // Default to right side
  open: (sessionId, noteId) => set({ isOpen: true, sessionId, noteId }),
  close: () => set({ isOpen: false, sessionId: undefined, noteId: undefined, isOnLeft: false }), // Reset position on close
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  setPosition: (isOnLeft) => set({ isOnLeft }),
}));
