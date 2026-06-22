# Notes Editor System Documentation

This document provides a comprehensive overview of the Notes Editor system in Scrapalot UI, including architecture, components, state management, and technical implementation details.

**Last Updated**: April 2026

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Core Components](#core-components)
4. [Portal Pattern & DOM Management](#portal-pattern--dom-management)
5. [State Management](#state-management)
6. [TipTap Editor](#tiptap-editor)
7. [Real-Time Collaboration](#real-time-collaboration)
8. [Auto-Save System](#auto-save-system)
9. [Mobile Optimizations](#mobile-optimizations)
10. [Position Management](#position-management)
11. [Permissions & Sharing](#permissions--sharing)
12. [Extensions](#extensions)
13. [CATEGORY_07 PRD Features](#category_07-prd-features)
14. [Common Workflows](#common-workflows)
15. [Troubleshooting](#troubleshooting)

---

## Overview

The Notes Editor is a collaborative rich-text editing system built on TipTap (ProseMirror) with Y.js for real-time collaboration. It provides a full-featured note-taking experience with:

- **Rich Text Editing**: Headers, lists, tables, code blocks, callouts, and more
- **Real-Time Collaboration**: Multiple users can edit simultaneously with presence indicators
- **Auto-Save**: Debounced automatic saving with localStorage fallback
- **Markdown Support**: Auto-converts pasted Markdown to formatted text
- **Mobile Optimized**: Notion-style floating toolbar, swipe gestures, touch-optimized UI
- **Portal Rendering**: Prevents DOM conflicts with other drawer components
- **Side-by-Side Layout**: Works alongside PDF viewer in split-screen mode

### Key Features

- Real-time collaborative editing (Y.js + WebSocket)
- Auto-save with 3-second debounce
- Markdown paste auto-conversion
- Commenting system with threading
- Version history tracking
- Role-based permissions (owner/editor/viewer)
- Mobile-first responsive design
- Swipe-to-close gesture on mobile
- Position toggling (left/right sides)

---

## Architecture

### Component Hierarchy

```
GlobalNotesDrawer (Portal Container)
└── NotesDrawer (Main Drawer Component)
    └── CollaborativeNotesEditor (TipTap Editor)
        ├── CollaborationHeader (User presence, share button)
        ├── SelectionToolbar (Bubble menu for text formatting)
        ├── MobileEditorBar (Mobile floating toolbar - NEW)
        ├── BlockMenu (Block-level actions)
        ├── SimpleCommentInput (Add comments)
        ├── HoverCommentBalloon (View/resolve comments)
        └── TipTap Extensions
            ├── MarkdownPaste (Auto-convert pasted Markdown - NEW)
            ├── Collaboration (Y.js integration)
            ├── CollaborationCursor (User cursors)
            ├── Callout (Callout blocks)
            ├── CodeBlockWithLanguage (Syntax-highlighted code)
            ├── EnhancedImage (Image with captions)
            ├── TableControls (Table editing)
            ├── Toggle (Collapsible sections)
            ├── CommentMark (Inline comments)
            └── TrailingParagraph (Always end with paragraph)
```

### Data Flow

```
User Input → TipTap Editor → Y.js Document → WebSocket Provider → Backend
                    ↓                                  ↓
              onChange Handler                  Broadcast to other users
                    ↓                                  ↓
          Debounced Auto-Save              Update other editors
                    ↓
          Backend API (updateNote/createNote)
                    ↓
          PostgreSQL Database
                    ↓
          localStorage (fallback)
```

---

## Core Components

### 1. GlobalNotesDrawer

**Location**: `src/components/notes/global-notes-drawer.tsx`

**Purpose**: Global wrapper that manages portal rendering to prevent DOM conflicts.

#### Key Features

- **Portal Pattern**: Renders into dedicated DOM container (`#notes-drawer-portal`)
- **Stable Container**: Persists across component re-renders
- **Conflict Prevention**: Avoids `insertBefore` errors from nested Radix UI portals
- **Delayed Initialization**: 10ms delay ensures DOM readiness

#### Implementation Details

```typescript
// Create portal container once globally
let notesPortalContainer: HTMLDivElement | null = null;

const getOrCreatePortalContainer = () => {
  if (!notesPortalContainer) {
    const existing = document.getElementById('notes-drawer-portal');
    if (existing instanceof HTMLDivElement) {
      notesPortalContainer = existing;
    } else {
      const container = document.createElement('div');
      container.id = 'notes-drawer-portal';
      container.style.position = 'relative';
      container.style.zIndex = '1300';
      document.body.appendChild(container);
      notesPortalContainer = container;
    }
  }
  return notesPortalContainer;
};
```

#### Why This Pattern?

1. **Prevents DOM Errors**: TipTap's ProseMirror can throw `insertBefore` errors when portals are destroyed during active editing
2. **Stable Reference**: Global container persists even when React component unmounts
3. **z-index Isolation**: Creates separate stacking context with `z-index: 1300`
4. **Cleanup on Unload**: Only removes container on `beforeunload` event

#### Container Readiness Check

```typescript
const [isContainerReady, setIsContainerReady] = React.useState(false);

useEffect(() => {
  const timer = setTimeout(() => {
    portalContainerRef.current = getOrCreatePortalContainer();
    setIsContainerReady(true);
  }, 10); // 10ms delay for DOM stability

  return () => clearTimeout(timer);
}, []);

// Don't render until container is ready
if (!isContainerReady || !portalContainerRef.current) {
  return null;
}
```

---

### 2. NotesDrawer

**Location**: `src/components/notes/notes-drawer.tsx`

**Purpose**: Main drawer component handling UI, state, and API interactions.

#### Key Responsibilities

1. **UI Layout**: Header, toolbar, content area
2. **State Management**: Notes content, saving state, permissions
3. **API Integration**: Load, save, share notes
4. **Position Calculation**: Dynamic positioning based on sidebar/PDF state
5. **Auto-Save**: Debounced saving with localStorage fallback
6. **Permission Handling**: Role-based access control

#### Position Calculation

The drawer can appear on **left or right side** based on:
- PDF viewer state (`isPdfOpen`, `isPdfOnLeft`)
- User preference (toggle button)
- Screen size (full-screen on narrow screens)

```typescript
const calculatePosition = () => {
  // Narrow screens: full-screen
  if (isNarrowScreen) {
    return { width: '100vw', height: '100vh', ... };
  }

  // Determine side: opposite of PDF if PDF is open
  const defaultPosition = isPdfOpen ? isPdfOnLeft : true;
  const shouldBeOnRight = openedOnRight !== null ? openedOnRight : defaultPosition;

  if (!shouldBeOnRight) {
    // Left side positioning
    const sidebarWidth = isSidebarOpen ? 335 : 56;
    return {
      width: `calc(50vw - ${sidebarWidth}px)`,
      left: `${sidebarWidth}px`,
      right: 'auto',
    };
  }

  // Right side positioning (default)
  const width = isPdfOpen ? 'calc(50vw)' : calculateWidth(drawerWidth);
  return {
    width,
    right: '0',
    left: 'auto',
    transform: isSidebarOpen ? `translateX(-${279}px)` : 'translateX(0px)',
  };
};
```

#### Width Constants

```typescript
const ICON_SIDEBAR_WIDTH = 56;           // w-14 = 3.5rem
const CONVERSATIONS_SIDEBAR_WIDTH = 335; // Expanded sidebar
```

#### Responsive Width

```typescript
// Auto-adjust width based on screen size
if (screenWidth < 768) {
  width = '100'; // Full width on mobile
} else if (screenWidth < 1280) {
  width = '45';  // 45% on tablet
} else {
  width = '50';  // 50% on desktop
}
```

---

### 3. CollaborativeNotesEditor

**Location**: `src/components/notes/collaborative-notes-editor.tsx`

**Purpose**: TipTap editor instance with Y.js collaboration.

#### Props Interface

```typescript
interface CollaborativeNotesEditorProps {
  noteId: string;
  workspaceId: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  userColor?: string;
  content?: string;
  onChange?: (content: string) => void;
  placeholder?: string;
  className?: string;
  editable?: boolean;
  isReadOnly?: boolean;
  documentTitle?: string;
  createdBy?: { id: string; name: string; email?: string; avatar?: string };
  workspaceMembers?: WorkspaceMember[];
  currentUserRole?: 'owner' | 'editor' | 'viewer' | null;
  onShare?: () => void;
  showCollaborationHeader?: boolean;
  showCommentsSidebar?: boolean;
}
```

#### User Color Assignment

```typescript
// Generate consistent color for user based on ID
const getConsistentColor = (userId: string) => {
  const colors = ['#958DF1', '#F98181', '#FBBC88', '#FAF594', '#70CFF8', '#94FADB', '#B9F18D'];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};
```

---

## Portal Pattern & DOM Management

### Problem: DOM `insertBefore` Errors

TipTap's ProseMirror can throw errors when:
1. Radix UI portals (Dialog, Popover) are destroyed during editing
2. Parent containers are removed while editor is still rendering
3. Multiple portal layers conflict during unmount

### Solution: Stable Global Portal Container

```typescript
// CORRECT: Stable container that persists
const getOrCreatePortalContainer = () => {
  if (!notesPortalContainer) {
    // Check if container already exists in DOM
    const existing = document.getElementById('notes-drawer-portal');
    if (existing instanceof HTMLDivElement) {
      notesPortalContainer = existing;
    } else {
      // Create new container
      const container = document.createElement('div');
      container.id = 'notes-drawer-portal';
      container.style.position = 'relative';
      container.style.zIndex = '1300';
      document.body.appendChild(container);
      notesPortalContainer = container;
    }
  }
  return notesPortalContainer;
};

// Cleanup ONLY on window unload (not component unmount)
window.addEventListener('beforeunload', () => {
  if (notesPortalContainer?.parentNode) {
    notesPortalContainer.parentNode.removeChild(notesPortalContainer);
    notesPortalContainer = null;
  }
});
```

### Benefits

1. **Prevents Crashes**: No more `insertBefore` errors during note switching
2. **Smooth Transitions**: Container persists across navigation
3. **Proper Cleanup**: Only removed when page unloads
4. **z-index Isolation**: Separate stacking context prevents overlap issues

---

## State Management

### useNotesDrawer Hook

**Location**: `src/hooks/use-notes-drawer.tsx`

**Type**: Zustand store (global state)

```typescript
interface NotesDrawerStore {
  isOpen: boolean;
  sessionId?: string;
  noteId?: string;
  isOnLeft: boolean; // Position tracking
  open: (sessionId?: string, noteId?: string) => void;
  close: () => void;
  toggle: () => void;
  setPosition: (isOnLeft: boolean) => void;
}
```

#### Usage

```typescript
import { useNotesDrawer } from '@/hooks/use-notes-drawer';

// In component
const notesDrawer = useNotesDrawer();

// Open notes for a session
notesDrawer.open(sessionId);

// Open specific note
notesDrawer.open(undefined, noteId);

// Toggle position
notesDrawer.setPosition(true); // Move to left
```

#### State Reset on Close

```typescript
close: () => set({
  isOpen: false,
  sessionId: undefined,
  noteId: undefined,
  isOnLeft: false, // Reset position
})
```

---

## TipTap Editor

### Extensions Used

#### Core Extensions

1. **StarterKit**: Basic editing (bold, italic, headings, lists, etc.)
2. **Underline**: Underline text
3. **Link**: Hyperlinks
4. **Placeholder**: Placeholder text when empty
5. **TextStyle**: Text color and styling
6. **Color**: Text color picker
7. **Highlight**: Text highlighting
8. **TextAlign**: Left/center/right/justify alignment

#### List Extensions

9. **TaskList**: Checkbox task lists
10. **TaskItem**: Individual task items

#### Table Extensions

11. **Table**: Table support
12. **TableRow**: Table rows
13. **TableCell**: Table cells
14. **TableHeader**: Table headers

#### Custom Extensions (NEW)

15. **MarkdownPaste**: Auto-converts pasted Markdown to rich text
16. **Callout**: Info/warning/error callout blocks
17. **CodeBlockWithLanguage**: Syntax-highlighted code blocks
18. **EnhancedImage**: Images with captions and resizing
19. **TableControls**: Table manipulation UI
20. **Toggle**: Collapsible toggle sections
21. **CommentMark**: Inline commenting
22. **TrailingParagraph**: Always end document with paragraph
23. **SlashCommandExtension**: `/` command menu

#### Collaboration Extensions

24. **Collaboration**: Y.js document binding
25. **CollaborationCursor**: User cursor indicators

### Editor Configuration

```typescript
const editor = useEditor({
  extensions: [
    StarterKit,
    Underline,
    Link,
    Placeholder.configure({ placeholder }),
    Collaboration.configure({ document: ydoc }),
    CollaborationCursor.configure({
      provider: websocketProvider,
      user: { name: userName, color: userColor },
    }),
    MarkdownPaste, // NEW: Auto-convert Markdown
    // ... other extensions
  ],
  content,
  editable: !isReadOnly,
  onUpdate: ({ editor }) => {
    const html = editor.getHTML();
    onChange?.(html);
  },
});
```

---

## Real-Time Collaboration

### Y.js + WebSocket Architecture

```
User A's Editor ←→ Y.js Document ←→ WebSocket Provider ←→ Backend
                                           ↕
User B's Editor ←→ Y.js Document ←→ WebSocket Provider
```

### Setup

```typescript
// Create Y.js document
const ydoc = new Y.Doc();

// WebSocket provider for syncing
const websocketProvider = new WebsocketProvider(
  WS_URL,
  `${workspaceId}-${noteId}`,
  ydoc,
  {
    params: {
      userId,
      userName,
      userColor,
    },
  }
);

// Cleanup on unmount
return () => {
  websocketProvider?.destroy();
  ydoc?.destroy();
};
```

### Presence Indicators

- **User Cursors**: Real-time cursor position with name labels
- **User Selection**: Highlighted text selections in user's color
- **Typing Indicator**: Shows when other users are typing
- **Active Users List**: CollaborationHeader displays all connected users

---

## Auto-Save System

### Strategy

1. **Debounced Save**: 3-second delay after last edit
2. **Immediate Save on Close**: Saves when drawer closes
3. **localStorage Fallback**: Saves to local storage if API fails
4. **Empty Content Guard**: Prevents saving empty notes

### Implementation

```typescript
// Debounced save (3 seconds)
const debouncedSave = useDebounce(async (content: string) => {
  if (!currentWorkspace?.id || !content.trim()) return;
  if (isContentEmpty(content)) return;

  const noteTitle = generateNoteTitle(content, 'Notes for session');

  if (noteId) {
    // Update existing note
    await updateNote(noteId, {
      title: noteTitle,
      content: { html: content }
    });
  } else if (sessionId) {
    // Create new note
    const newNote = await createNote({
      workspace_id: currentWorkspace.id,
      session_id: sessionId,
      title: noteTitle,
      content: { html: content },
    });
    setNoteId(newNote.id);
  }

  localStorage.setItem(`notes-${noteId || sessionId}`, content);
}, 3000);

// Trigger on content change
useEffect(() => {
  if (notesContent && isOpen && !isContentEmpty(notesContent)) {
    debouncedSave(notesContent);
  }
}, [notesContent, isOpen]);
```

### Save on Close

```typescript
useEffect(() => {
  if (prevIsOpenRef.current && !isOpen) {
    // Drawer just closed - save immediately
    const content = notesContentRef.current;
    if (content && !isContentEmpty(content)) {
      saveImmediately(content);
    }
  }
  prevIsOpenRef.current = isOpen;
}, [isOpen]);
```

### Safety Guards

```typescript
// Prevent saving empty content shortly after loading non-empty content
const timeSinceLoad = Date.now() - lastLoadTimeRef.current;
const isJustLoaded = timeSinceLoad < 5000;
const isEmpty = isContentEmpty(notesContent);
const hadContent = loadedContentRef.current.length > 100;

if (isJustLoaded && isEmpty && hadContent) {
  console.warn('BLOCKED auto-save: Empty content detected shortly after loading');
  return;
}
```

---

## Mobile Optimizations

### 1. Mobile Editor Bar (NEW)

**Location**: `src/components/notes/mobile-editor-bar.tsx`

Notion-style floating toolbar that appears when editor is focused.

#### Features

- Floats at bottom of screen when keyboard is visible
- Quick access to formatting (Bold, Italic, H1, List, Checklist)
- Undo/Redo buttons
- Dismiss keyboard button
- Auto-hides when editor loses focus

#### Positioning

```typescript
style={{
  position: 'fixed',
  bottom: 0,
  left: 0,
  right: 0,
  zIndex: 100,
  transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
  transition: 'transform 0.2s ease-in-out',
}}
```

### 2. Swipe-to-Close Gesture

```typescript
const handleTouchMove = (e: React.TouchEvent) => {
  if (!isMobile || !touchStart) return;

  const touch = e.touches[0];
  const deltaX = touch.clientX - touchStart.x;
  const progress = Math.min(Math.abs(deltaX) / window.innerWidth, 1);
  setSwipeProgress(progress);

  // Close if swiped >30% of screen width
  if (Math.abs(deltaX) > window.innerWidth * 0.3) {
    onClose();
  }
};
```

### 3. Mobile-Specific Styles

```css
.mobile-editor .ProseMirror {
  font-size: 16px !important; /* Prevent iOS zoom */
  line-height: 1.5 !important;
  min-height: 200px !important;
}

/* Touch-friendly tap targets */
.mobile-editor .ProseMirror button,
.mobile-editor .ProseMirror input[type="checkbox"] {
  min-width: 44px !important;
  min-height: 44px !important;
}
```

### 4. Mobile Menu

Overflow menu for desktop actions (save, share, download, clear):

```typescript
<DropdownMenu open={showMobileMenu} onOpenChange={setShowMobileMenu}>
  <DropdownMenuTrigger asChild>
    <Button variant="ghost" size="default">
      <MoreVertical className="h-4 w-4" />
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuItem onClick={handleSave}>Save notes</DropdownMenuItem>
    <DropdownMenuItem onClick={handleMobileShare}>Share notes</DropdownMenuItem>
    <DropdownMenuItem onClick={handleDownload}>Download</DropdownMenuItem>
    <DropdownMenuItem onClick={handleClear}>Clear all</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

---

## Position Management

### Dynamic Positioning

The notes drawer can appear on **left or right side** based on context.

#### Rules

1. **Alone**: Opens on **right side** (default)
2. **With PDF on right**: Opens on **left side**
3. **With PDF on left**: Opens on **right side**
4. **User toggle**: Can manually swap position
5. **Narrow screens**: Full-screen (no side-by-side)

#### Toggle Position

```typescript
const togglePosition = () => {
  setOpenedOnRight(prev => {
    const currentlyOnRight = prev !== null ? prev : defaultPosition;
    const newPosition = !currentlyOnRight;
    notesDrawer.setPosition(!newPosition); // Update global store
    return newPosition;
  });
};
```

#### Position Lock

Once drawer opens, position is "locked" until closed:

```typescript
// Capture position on open
if (justOpened) {
  const opensOnRight = !isPdfOpen;
  setOpenedOnRight(opensOnRight);
  notesDrawer.setPosition(!opensOnRight);
}

// Reset on close
if (!isOpen && wasOpen) {
  setOpenedOnRight(null);
}
```

---

## Permissions & Sharing

### Role-Based Access

```typescript
type UserRole = 'owner' | 'editor' | 'viewer';
```

| Role | Can View | Can Edit | Can Comment | Can Share |
|------|----------|----------|-------------|-----------|
| Owner | | | | |
| Editor | | | | ❌ |
| Viewer | | ❌ | | ❌ |

### Permission Loading

```typescript
useEffect(() => {
  const loadWorkspaceMembers = async () => {
    // For new documents, grant full access
    if (isOpen && !propsNoteId && user?.id) {
      setCurrentUserRole('owner');
      setPermissionsReady(true);
      return;
    }

    // For existing notes, fetch workspace members
    const members = await getWorkspaceMembers(currentWorkspace.id);
    const currentMember = members.find(m => m.id === user.id);

    if (currentMember) {
      setCurrentUserRole(currentMember.role);
    } else {
      // Fallback: Check if user is workspace owner
      const isOwner = String(currentWorkspace.user_id) === String(user.id);
      setCurrentUserRole(isOwner ? 'owner' : 'viewer');
    }

    setPermissionsReady(true);
  };

  loadWorkspaceMembers();
}, [isOpen, propsNoteId, currentWorkspace?.id, user?.id]);
```

### Share Dialog

```typescript
const handleShare = async () => {
  await shareNote(noteId, {
    email: shareEmail.trim(),
    role: shareRole, // 'editor' | 'viewer'
  });

  // Reload workspace members
  const members = await getWorkspaceMembers(currentWorkspace.id);
  setWorkspaceMembers(members);
};
```

---

## Extensions

### 1. MarkdownPaste (NEW)

**Location**: `src/components/notes/extensions/markdown-paste.ts`

Auto-converts pasted Markdown text to formatted rich text.

#### Supported Syntax

- Headers: `# ## ###`
- Bold: `**text**` or `__text__`
- Italic: `*text*` or `_text_`
- Lists: `- * +` and `1. 2. 3.`
- Links: `[text](url)`
- Code: `` `code` `` and ` ```code``` `
- Tables: `| col | col |`
- Task lists: `- [ ]` and `- [x]`
- Blockquotes: `> text`
- Horizontal rules: `---`, `***`, `___`
- Strikethrough: `~~text~~`

#### Detection Logic

```typescript
function looksLikeMarkdown(text: string): boolean {
  const markdownPatterns = [
    /^#{1,6}\s/m,           // Headers
    /^\s*[-*+]\s/m,         // Unordered lists
    /^\s*\d+\.\s/m,         // Ordered lists
    /\*\*[^*]+\*\*/,        // Bold
    /`[^`]+`/,              // Inline code
    /\[.+\]\(.+\)/,         // Links
    // ... more patterns
  ];
  return markdownPatterns.some(pattern => pattern.test(text));
}
```

#### Conversion

```typescript
import { marked } from 'marked';

function convertMarkdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false, gfm: true });
}
```

### 2. Callout Extension

Colored callout blocks for notes, warnings, errors.

```
[!NOTE] This is a note
[!WARNING] This is a warning
[!ERROR] This is an error
```

### 3. CodeBlockWithLanguage

Syntax-highlighted code blocks with language selector.

```python
def hello():
    print("Hello, World!")
```

### 4. EnhancedImage

Images with captions, resizing, and alignment.

### 5. TableControls

UI for adding/removing rows/columns in tables.

### 6. Toggle Extension

Collapsible sections (like Notion toggles).

### 7. CommentMark

Inline commenting system with threading.

---

## CATEGORY_07 PRD Features

This section documents the writing-tool surface added by `scrapalot-chat/docs/prd-scrapalot-mix/CATEGORY_07_NOTES_WRITING.md`. Every item below is *opt-in* and lives inside the Notes drawer; none of these affect chat or deep-research code paths.

### 7.1 AI Autocomplete (ghost text)

Ghost-text completion inside the editor. A short LLM call fires on a typing pause and renders translucent inline text at the caret. Tab inserts; Escape, click, or any further typing dismisses.

**UI**:
- Extension: `src/components/notes/extensions/ai-autocomplete-extension.ts` — TipTap `Extension` that owns a ProseMirror `Plugin` with its own `DecorationSet`. Suggestions live inside the editor's decoration system so they survive Y.js remote ops and focus-mode re-decorations without flicker.
- Toolbar toggle: `note-menu-bar.tsx` flips `editor.commands.setAutocompleteEnabled(true|false)` — persists in `localStorage['scrapalot_notes_autocomplete_enabled']`.
- API client: `ghostCompleteNote()` in `src/lib/api-notes-assistant.ts`.

**Knobs (compile-time constants in the extension)**:
- `DEBOUNCE_MS = 700` — pause window before the call fires.
- `MIN_BEFORE_CHARS = 10` — don't ask the model when the caret has < 10 chars of context above.
- `SEND_BEFORE_MAX = 2000`, `SEND_AFTER_MAX = 800` — payload caps before the request leaves the browser.

**Backend**: `NotesAssistantService.GhostCompleteNote` (gRPC) → `autocomplete_service.py` (`scrapalot-chat/src/main/service/notes_assistant/`). Prompt key `notes.ghost_complete_note` in `configs/prompts.yaml`. Request omits `outline_summary` when there is none — the prompt branches on its presence.

**Extension lifecycle gotcha**: storage flag `enabled` defaults to `false`. The toolbar toggle MUST plumb the initial state on mount via `defaultEnabled`, otherwise the plugin stays dormant after a page refresh even with the toggle visually "on".

### 7.2 Outline Generation

Generates a hierarchical outline from existing notes content, biased by a discipline-specific template.

**UI**:
- Picker dialog: `src/components/notes/outline-template-picker-dialog.tsx` — five cards (Generic, IMRAD, PRISMA Lit Review, Doctoral Thesis, Grant Proposal). Each maps to an `OutlineTemplate` value.
- Output rendered into the editor as a nested ordered list.
- API client: `generateOutline(notes, templateType)` in `api-notes-assistant.ts`.

**`OutlineTemplate` enum**: `'' | 'imrad' | 'lit_review' | 'thesis' | 'grant'` (empty string = Generic, intentional — backend treats empty as "no template hint").

**Backend**: `NotesAssistantService.GenerateOutline` → `text_transform_service.generate_outline()`. Prompts:
- `notes.generate_outline` (Generic)
- `notes.generate_outline_imrad`
- `notes.generate_outline_lit_review`
- `notes.generate_outline_thesis`
- `notes.generate_outline_grant`

**Z-index gotcha**: the dialog uses `overlayZIndex="10049"` because the default `DialogContent` z-71 renders BEHIND the notes drawer. Same layering pattern as `VersionHistoryDialog` and `ComposeFromSourcesDialog`.

### 7.3 Compose from Sources (RAG-grounded prose)

Generates prose grounded in the user's collections and inserts it as a citation-marked block.

**UI**:
- Dialog: `src/components/notes/compose-from-sources-dialog.tsx` — editorial three-step layout (`01 TOPIC`, `02 LENGTH`, `03 RESULT`). Pre-result control panel pivots to a reading-layout post-result.
- Status pill states: `idle | no-scope | composing | grounded | timeout | no-match | failed | soft-no-citations`.
- Mounted from `notes-drawer.tsx` Tools menu (around line 2716).

**Retrieval status enum** (propagated end-to-end via response `error` field):
| Code | Meaning |
|---|---|
| `retrieval_no_match` | Vector search returned 0 chunks above similarity floor |
| `retrieval_timeout` | Retrieval exceeded the 15 s budget |
| `retrieval_failed` | Retrieval threw an exception |
| (none) | OK — sources were used |

**Backend**: `NotesAssistantService.ComposeFromSources` → `compose_from_sources_service.py`. Notable knobs:
- `_retrieve_chunks` returns `(sources, status)` tuple.
- `skip_reranking=True` — the CPU cross-encoder reranker was eating the entire 30 s budget on cloud Hetzner. Status code `retrieval_timeout` was masking what was actually a reranker stall, not a vector search miss.
- HNSW index on `langchain_pg_embedding.embedding` is REQUIRED. Migration `020` dropped the original index; `064_restore_pgvector_hnsw_indexes.py` puts it back. Without it ANN search degrades to seq-scan and times out at ≈3000 chunks.

**Style**: dialog conforms to `docs/README_STYLE.md` — Inter sans only, tracking-wide, sharp corners, no `font-serif` / `font-mono` / dropcap experiments.

### 7.4 LaTeX Export

Pure client-side TipTap-JSON → LaTeX converter. No LLM, no Python round-trip.

**UI**:
- Two menu items in `note-menu-bar.tsx`:
  - `notes.fileMenu.exportLatex` — single `.tex` download
  - `notes.fileMenu.exportLatexZip` — `.tex` + `.bib` + `images/` packed for Overleaf round-trip
- Handlers: `handleExportLatex` and `handleExportLatexZip` in `notes-drawer.tsx` (~lines 497, 550).

**Library**: `src/lib/tiptap-to-latex.ts` — rule-based per-node-type emitter.

**`LatexPreambleTemplate` enum**: `'article' | 'imrad' | 'minimal' | 'none'` (`'none'` returns body-only, useful for paste into existing Overleaf projects).

**Citations**: emits `\cite{key}` markers and a paired BibTeX file, NOT inline entries. This preserves Overleaf round-trip semantics — Overleaf refuses to recompile against an inline-encoded bibliography.

**Why client-side**: TipTap has no Python equivalent and a Node sidecar would mean a new container. The pure-JS walk avoids both.

### 7.5 Title Generation

One-shot title generator that emits a single short title from the current note body.

**UI**: `notes-drawer.tsx` ~line 310 — `handleGenerateMeta('title', ...)` is shared with `'abstract'` and `'highlights'` variants.

**Backend**: routes through `NotesAssistantService.TransformText` with `transform_type='title'`. Reuses the generic transform RPC — no dedicated handler needed.

### 7.6 Reading Modes (Fullscreen / Focus / Reading / Sepia)

Four orthogonal viewport modes. Each is a `body.notes-*` class toggled by `notes-drawer.tsx`; CSS lives in `src/styles/notes-drawer.css`. Each mode persists independently in `localStorage`.

| Mode | Keyboard | localStorage key | Body class | Effect |
|---|---|---|---|---|
| Fullscreen | `Cmd/Ctrl+Shift+F`, `Esc` to exit | `scrapalot_notes_fullscreen` | `body.notes-fullscreen` | Drawer takes 100vw × 100vh; sidebars hidden |
| Focus | toolbar toggle, `Esc` to exit | `scrapalot_notes_focus_mode` | `body.notes-focus-mode` | Dims every block except `is-active-block` |
| Reading | toolbar toggle | `scrapalot_notes_reading_mode` | `body.notes-reading-mode` | Locks editing (`editor.setEditable(false)`) + hides chrome (toolbar, comments). Does NOT cap column width — column control lives on the editor's own className |
| Sepia | toolbar toggle | `scrapalot_notes_sepia_mode` | `body.notes-sepia-mode` | Warm paper background + tinted prose |

**Active-block tracking** (Focus mode dependency): `src/components/notes/extensions/active-block-decoration.ts` — TipTap extension that adds an `is-active-block` class to the top-level node containing the caret.

**CSS specificity gotcha**: `body.notes-reading-mode .ProseMirror` is 3 classes and beats `.max-w-none` (1 class). Earlier versions of the CSS pinned `max-width: 65ch` here, which caused the editor's `prose max-w-none` className to silently lose. The CSS now scopes only `caret-color: transparent` — column width stays controlled by the editor's own className.

### 7.7 Thought Partner Mode

Critique-only feedback that asks questions instead of writing prose. Lives in two places:

1. **In chat**: `Direct LLM` provider with the questions-only system prompt, surfaced as a "Thought Partner" model in the model picker. Implementation lives outside this document — see `scrapalot-backend/docs/README_GRPC_ARCHITECTURE.md`.
2. **In notes**: `Tools → Critique my draft` menu item in `note-menu-bar.tsx`. Calls `critiqueWithQuestions(html)` (`api-notes-assistant.ts`), receives a list of probing questions, and inserts them as a `data-callout="" data-type="review"` block at the cursor. Implementation reference: `notes-drawer.tsx` ~line 421.

**Callout type**: `review` (violet tint, ✎ icon) — defined in `extensions/callout-types.ts`.

### 7.8 Reserved

PRD slot 7.8 is intentionally unallocated — notes editor jumped from 7.7 (Thought Partner) to 7.9 (Versions) during PRD revision.

### 7.9 Version Control v1

Named saves and one-click restore.

**UI**:
- Dialog: `src/components/notes/version-history-dialog.tsx`
  - Maximizable (`allowMaximize={true}`) — diffs need real estate
  - Filter toggle "Samo imenovane" / "Sve verzije" (`namedOnly` state, default `true`)
  - Single flex-col body wrapper to prevent grid auto-row stretching
  - In-corner Maximize/Close buttons (`top-2 right-2`) when maximized — outside-corner placement (`-top-4 -right-4`) clipped under the viewport edge

**Wire shape** (`api-notes.ts:NoteVersion`):
```typescript
{
  id: string;
  note_id: string;
  user_id: string;
  version_number: number;
  content: string;
  change_summary: string;
  created_at: string;
  kind?: 'auto' | 'named' | 'restore';   // 7.9
  label?: string | null;                  // 7.9
  message?: string | null;                // 7.9
  parent_version_id?: string | null;      // 7.9
}
```

Field naming intentionally matches Jackson's snake_case JSON. An earlier camelCase variant silently rendered every field as `undefined` ("Invalid Date" / "NaN ago" in the dialog).

**Endpoints**:
- `GET /notes/{id}/versions` — list (newest first; client filters by `kind`)
- `POST /notes/{id}/versions/save-named` — `{ label, message }` (label required)
- `POST /notes/{id}/versions/{vid}/restore` — captures current state as `kind=restore` first so the user can undo

### 7.9 v2 — Mark-aware Diff

LCS-based line diff with a second pass that detects format-only changes (bold/italic/link/etc.) on otherwise-identical lines.

**Library**: `src/lib/text-diff.ts` — pure JS, no DOMParser (works in any context).

**`DiffOpKind` enum**: `'same' | 'add' | 'remove' | 'format-change'`.

**Tracked marks**: `strong`, `em`, `code`, `mark`, `underline`, `strike`, `sup`, `sub`, plus `link:href`. Citation-mark and comment-mark are intentionally OMITTED — they regenerate fresh ids on every render and would make every diff look like a format-change.

**Why line-level, not character-level**: char-level diff over HTML surfaces every attribute change as a noisy edit (mark spans flicker on every auto-save). Line-level over typical paragraph counts (≤ a few hundred) keeps the LCS O(n·m) cost negligible.

**View component**: `src/components/notes/version-diff-view.tsx`
- Side-by-side panes with sticky `PRIJE` / `POSLIJE` headers
- Amber row class for `format-change` kind
- `FormatDeltaChips` sub-component shows `+strong` / `−em` markers per row
- Draggable splitter between panes (6 px hit area, `cursor-col-resize`, ARIA `role="separator"`, persisted in `localStorage['scrapalot_notes_version_diff_split_ratio']`, clamped 0.15–0.85)

### 7.10 Editor Styling

Beautiful default look + sepia/reading themes + callout taxonomy.

**Callout taxonomy** (`extensions/callout-types.ts`):

| Key | Icon | Tint | Use |
|---|---|---|---|
| `info` | 💡 | blue | Tips / inline definitions |
| `warning` | ⚠️ | amber | Caveats |
| `success` | ✅ | green | Confirmation / completed milestones |
| `error` | ❌ | red | Critical mistakes |
| `default` | 📝 | gray | Generic note |
| `review` | ✎ | violet | Thought-Partner output (7.7) |
| `bridge_insights` | 🔗 | indigo | Cross-Domain Bridge results |

Each type has paired `bgLight`/`bgDark`/`borderLight`/`borderDark` so light + dark themes are first-class.

**Code blocks**: `extensions/code-block-with-language.tsx` — language selector + copy-to-clipboard with feedback ("Copied!" toast).

**File menu → New Note save-before-clear** (`notes-drawer.tsx`):
- `saveCurrentNoteImmediateRef` — awaitable immediate save bypassing the debounce
- `saveContentNow(content)` — single source of truth for both debounced and immediate paths
- `handleNewNoteConfirm` awaits the save before clearing state, then imperatively resets the editor

This fixes a class of bugs where rapidly clicking File → New Note dropped the last few seconds of edits before the 3-second debounce fired.

---

## Common Workflows

### 1. Opening Notes for a Chat Session

```typescript
import { useNotesDrawer } from '@/hooks/use-notes-drawer';

const notesDrawer = useNotesDrawer();

// Open notes for current session
notesDrawer.open(sessionId);
```

The drawer will:
1. Load existing note for session (if any)
2. Create new note on first save
3. Link note to session via `session_id` field

### 2. Opening a Specific Note

```typescript
// Open note by ID (e.g., from sidebar)
notesDrawer.open(undefined, noteId);
```

### 3. Creating a New Note

```typescript
// Open without sessionId or noteId
notesDrawer.open();

// User types content, auto-save creates note
// Title generated from first heading or "Notes for session"
```

### 4. Saving Notes Manually

```typescript
// Click save button in header
const handleSave = async () => {
  const noteTitle = generateNoteTitle(content, 'Notes for session');

  if (noteId) {
    await updateNote(noteId, { title: noteTitle, content: { html: content } });
  } else {
    const newNote = await createNote({
      workspace_id: currentWorkspace.id,
      session_id: sessionId,
      title: noteTitle,
      content: { html: content },
    });
    setNoteId(newNote.id);
  }
};
```

### 5. Sharing a Note

```typescript
// Click share button
setShowShareDialog(true);

// Enter email and role
await shareNote(noteId, {
  email: 'user@example.com',
  role: 'editor', // or 'viewer'
});
```

### 6. Switching Position

```typescript
// Click swap position button
togglePosition();

// Drawer animates to opposite side
```

---

## Troubleshooting

### Issue: `insertBefore` DOM Error

**Cause**: TipTap's ProseMirror throws error when portal container is removed during editing.

**Solution**: Use `GlobalNotesDrawer` with stable portal container.

```typescript
// CORRECT
<GlobalNotesDrawer />

// ❌ WRONG
<NotesDrawer /> // Direct use without portal
```

### Issue: Notes Not Saving

**Checklist**:
1. Check `currentWorkspace?.id` is defined
2. Verify `sessionId` or `noteId` exists
3. Check console for auto-save logs
4. Verify user has `editor` or `owner` role
5. Check network tab for API errors

### Issue: Auto-Save Overwriting Content

**Cause**: Auto-save triggered immediately after loading note.

**Solution**: Safety guard prevents saving empty content shortly after load.

```typescript
const timeSinceLoad = Date.now() - lastLoadTimeRef.current;
const isJustLoaded = timeSinceLoad < 5000;

if (isJustLoaded && isEmpty && hadContent) {
  console.warn('BLOCKED auto-save');
  return;
}
```

### Issue: Drawer Not Opening

**Checklist**:
1. Check `isOpen` state in Zustand store
2. Verify portal container exists: `document.getElementById('notes-drawer-portal')`
3. Check `isContainerReady` state
4. Check console for errors

### Issue: Collaboration Not Working

**Checklist**:
1. Verify WebSocket connection: Check network tab for `wss://` connection
2. Check `noteId` is a valid UUID
3. Verify Y.js provider is initialized
4. Check backend WebSocket server is running
5. Verify all users are in same `workspaceId-noteId` room

### Issue: Mobile Toolbar Not Appearing

**Checklist**:
1. Check `isMobile` hook returns `true`
2. Verify editor has focus
3. Check `MobileEditorBar` is rendered in `CollaborativeNotesEditor`
4. Inspect z-index: Should be `z-index: 100`

---

## Technical Considerations

### Performance Optimizations

1. **Debounced Auto-Save**: 3-second delay prevents excessive API calls
2. **Lazy Loading**: Portal container created only when needed
3. **Memoized Calculations**: Position calculations use `useMemo`
4. **Event Delegation**: Touch gestures use single event listener

### Browser Compatibility

- **Chrome/Edge**: Full support ✅
- **Firefox**: Full support ✅
- **Safari**: Full support ✅
- **iOS Safari**: Mobile optimizations applied ✅
- **Android Chrome**: Mobile optimizations applied ✅

### Accessibility

- **Keyboard Navigation**: Full keyboard support (Tab, Enter, Arrow keys)
- **Screen Readers**: ARIA labels on all interactive elements
- **Focus Management**: Focus trapped in drawer when open
- **Color Contrast**: WCAG AA compliant

---

## Future Enhancements

- [ ] Offline mode with IndexedDB
- [ ] Conflict resolution UI for Y.js conflicts
- [ ] Voice dictation
- [ ] Drawing/sketching canvas
- [ ] @mentions for workspace members
- [ ] Full-text search within notes

> Items previously listed here are now shipped: Export to LaTeX (7.4), Export to Markdown (Tools menu), and Templates library (7.2 outline templates + the gallery in `template-gallery.tsx`).

---

## API Reference

### Backend Endpoints

```typescript
// Get note by ID
GET /api/v1/notes/{noteId}

// Create note
POST /api/v1/notes
{
  workspace_id: string,
  session_id?: string,
  title: string,
  content: { html: string }
}

// Update note
PATCH /api/v1/notes/{noteId}
{
  title?: string,
  content?: { html: string }
}

// List notes
GET /api/v1/workspaces/{workspaceId}/notes?filter=all|owned|shared

// Share note
POST /api/v1/notes/{noteId}/share
{
  email: string,
  role: 'editor' | 'viewer'
}

// Get workspace members
GET /api/v1/workspaces/{workspaceId}/members

// 7.9 — list versions (newest first; client filters by `kind`)
GET /api/v1/notes/{noteId}/versions

// 7.9 — explicit named save (label required)
POST /api/v1/notes/{noteId}/versions/save-named
{
  label: string,
  message?: string | null
}

// 7.9 — restore previous version (snapshots current as `kind=restore` first)
POST /api/v1/notes/{noteId}/versions/{versionId}/restore
```

### gRPC (NotesAssistantService) — Python AI backend

These run through Kotlin → gRPC → Python. Used by 7.1, 7.2, 7.3, 7.5.

| RPC | Used by | Notes |
|---|---|---|
| `TransformText` | 7.5 (title), other transforms | `transform_type` switches the prompt: `title`, `abstract`, `highlights`, `summary`, `simplify`, etc. |
| `GenerateOutline` | 7.2 | `template_type ∈ {'', 'imrad', 'lit_review', 'thesis', 'grant'}` |
| `ComposeFromSources` | 7.3 | Returns prose + `sources[]`. Soft warnings via `error="retrieval_*"` field |
| `GhostCompleteNote` | 7.1 | Short single-shot. Caps payload at 1500/500 chars on the Python side too |

---

## Related Documentation

- [Component Architecture](./README_COMPONENT_ARCHITECTURE.md)
- [Style Guide](./README_STYLE.md)
- [TipTap Internals](./README_TIPTAP.md)
- [PRD CATEGORY_07 — Notes & Writing](../../scrapalot-chat/docs/prd-scrapalot-mix/CATEGORY_07_NOTES_WRITING.md)
- [Backend gRPC Architecture](../../scrapalot-backend/docs/README_GRPC_ARCHITECTURE.md)
- [TipTap Documentation](https://tiptap.dev/)
- [Y.js Documentation](https://docs.yjs.dev/)

---

**Last Updated**: April 2026

*For questions or contributions, please refer to the main project documentation.*
