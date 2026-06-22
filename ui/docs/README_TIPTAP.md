# TipTap Editor

**Last Updated**: April 2026

How Scrapalot uses TipTap inside the notes editor — including custom extensions, Y.js collaboration, citation handling, and LaTeX export. For TipTap library docs go to `tiptap.dev`; this document is about Scrapalot's wrapper code.

## Stack

| Item | Value |
|---|---|
| Core | `@tiptap/core`, `@tiptap/react`, `@tiptap/starter-kit` ^2.10.3 |
| Newer extensions | tables, drag-handle, collaboration, color, image, typography, suggestion, text-align ^2.27.1 |
| Collaboration | `@tiptap/extension-collaboration` 2.27.1 + `@tiptap/y-tiptap` 2.0.0 |
| CRDT | `yjs` 13.6.27 + `y-websocket` 2.1.0 (NOT STOMP) |
| Editor entry | `src/components/notes/collaborative-notes-editor.tsx` |
| Drawer wrapper | `src/components/notes/notes-drawer.tsx` |

Why two TipTap versions: starter-kit and core dependencies are pinned at 2.10.3 for editor stability; tables, drag handle, collaboration, suggestion, and a few visual extensions need 2.27.1 APIs (decoration spec, react NodeView refresh). Bumping core to 2.27.x requires re-validating slash commands and the bibliography node.

## File Layout

```
src/components/notes/
├── notes-drawer.tsx                   # Drawer shell, layout, save/share/template controls
├── collaborative-notes-editor.tsx     # TipTap Editor instance + Y.js wiring
├── note-menu-bar.tsx                  # Top toolbar
├── slash-commands.tsx                 # / command palette (suggestion-based)
├── slash-command-extension.tsx        # Suggestion extension wiring
├── extensions/
│   ├── active-block-decoration.ts     # Highlights the focused block
│   ├── ai-autocomplete-extension.ts   # Inline AI suggestions on Tab
│   ├── bibliography-node.tsx          # Bibliography node + collectCitations()
│   ├── callout-extension.ts           # Callout block (info, warn, success, etc.)
│   ├── callout-component.tsx          # React NodeView for callouts
│   ├── citation-mark.tsx              # Inline citation mark with source linkback
│   ├── code-block-with-language.tsx   # Code block with language picker
│   ├── comment-mark.tsx               # Comment thread anchor
│   ├── drag-handle-plugin.tsx         # Hoverable drag handle for blocks
│   ├── enhanced-image-extension.ts    # Resizable / captioned image
│   ├── enhanced-image-component.tsx   # React NodeView for images
│   ├── heading-anchor.ts              # Auto-link anchors on headings
│   ├── image-upload-handler.ts        # Drag/drop + paste upload pipeline
│   ├── markdown-paste.ts              # Convert pasted markdown → ProseMirror nodes
│   ├── page-break-decoration.ts       # Page-break visualization for paper export
│   ├── table-commands.ts              # Custom table commands
│   ├── table-controls.tsx             # Table toolbar UI
│   ├── table-grip-overlay.tsx         # Row/column resize grips
│   ├── table-grip-menu.tsx            # Table grip context menu
│   ├── toggle-extension.ts            # Collapsible toggle block
│   ├── toggle-component.tsx           # React NodeView for toggles
│   └── trailing-paragraph.tsx         # Always keep an empty trailing paragraph
└── utils/
    └── markdown-converter.ts          # markdownToHtml() for templates and pasting
```

Supporting libs:
- `src/lib/tiptap-to-latex.ts` — converts editor JSON to LaTeX for paper generation.
- `src/lib/citation-formatter.ts` — `toBibTeXBatch`, `generateCitationKey`.
- `src/lib/note-research-context.ts` — pins a research scope to a note.

## Editor Composition

`collaborative-notes-editor.tsx` builds the editor with:
1. `StarterKit` (paragraph, heading, lists, bold/italic/strike, code/code-block, etc.) configured to disable `history` (replaced by Y.js undo).
2. Custom blocks: callout, toggle, code-block-with-language, enhanced-image, bibliography-node.
3. Inline marks: citation-mark, comment-mark, link, highlight, color, text-align, underline, typography.
4. Tables: table, table-row, table-header, table-cell + Scrapalot's table-controls.
5. UX layers: drag-handle-plugin, slash-command-extension, active-block-decoration, page-break-decoration, trailing-paragraph, heading-anchor, ai-autocomplete-extension, markdown-paste.
6. Collaboration: `Collaboration` + `CollaborationCursor` bound to a `Y.Doc` synced through `y-websocket` to the chat backend.

## Collaboration Flow

```
User keystroke
  → TipTap → Y.Doc transaction
    → y-websocket → ws://chat-backend/yjs/<noteId>
      → broadcast → other tabs/users
        → Y.Doc apply → TipTap re-render
```

- Y.Doc lives on the editor instance; never recreate inside re-renders.
- Awareness states feed `CollaborationCursor` so each connected user gets a colored cursor + label.
- Sync delay between tabs is **3–5 seconds** under normal load; under VPS pressure it can stretch to ~10 s. This is expected; do not "fix" by polling.
- **Notes WebSocket is NOT STOMP** — STOMP runs on `/ws` for chat / streaming packets; Y.js runs on a separate `/yjs/<noteId>` endpoint with a binary protocol.

## Citations & Bibliography

- Inline citations are added by selecting a chunk from a research result; this inserts a `citation-mark` referencing the source ID.
- The bibliography is rendered by the `bibliography-node` (a leaf block usually placed at the end of the note). `collectCitations(editor)` walks the document, deduplicates citations, and returns them in source order.
- `toBibTeXBatch(citations)` produces BibTeX output; `generateCitationKey()` builds keys from author + year.
- Bibliography export is triggered from the notes-drawer toolbar and runs through the Notes Assistant gRPC client (Kotlin `NotesAssistantGrpcClient` → Python `notes_assistant.proto`).

## LaTeX & Paper Generation

- `tiptap-to-latex.ts` walks editor JSON and emits LaTeX, mapping callouts → `\begin{tcolorbox}`, code blocks → `\begin{minted}`, tables → `tabular`, citations → `\cite{}`.
- The "Generate paper" flow (`paper-generation-dialog.tsx`) calls `generatePaper()` which posts the rendered LaTeX to the backend's paper service (Kotlin `PaperGrpcClient`).
- Page-break visualization is purely cosmetic in the editor; the actual page breaks are decided by the LaTeX class.

## AI Autocomplete

`ai-autocomplete-extension.ts` listens for typing pauses and asks the chat backend for an inline continuation. Acceptance is via `Tab`. The suggestion is rendered as a ghost decoration; never inserted as text until accepted.

## Slash Commands

`slash-commands.tsx` + `slash-command-extension.tsx` use `@tiptap/suggestion` to show a popup of insertable blocks (heading, list, callout, toggle, code, image, citation lookup, …). The extension owns trigger detection (`/`); the React component owns the menu and dispatches the chosen command on the editor.

## Gotchas

- **Programmatic edits bypass autosave observers** — when you mutate the editor from code (`editor.chain().insertContentAt(...)`, importing markdown, applying templates), kick the persistence pipeline explicitly. The change-watcher autosave only fires on user input transactions.
- **Collaboration replaces history** — do NOT also enable `StarterKit.history`. Two undo stacks deadlock the editor.
- **Drag-handle requires 2.27.x APIs** — keep `@tiptap/extension-drag-handle*` on 2.27.1; it will silently no-op on 2.10.x.
- **Trailing paragraph is mandatory** — without it, blocks at the end of the document become uneditable when the cursor lands past them.
- **Bibliography-node and citation-mark are coupled** — removing a citation-mark in text does NOT remove the entry from the bibliography node. Both are edited via the notes-drawer toolbar; never mutate them through `editor.commands` unless you mirror the pair.
- **Y.js room IDs are note IDs** — never reuse a room across notes; cross-note edits land in the wrong document.
- **Image uploads** go through `image-upload-handler.ts` → `api-uploads.ts` → backend `/api/v1/uploads`. Do not insert raw `data:` URLs into the editor; they survive a save but make the document multi-megabyte.

## Related Documents

- `README_NOTES_EDITOR.md` — notes drawer behavior, layout, collaboration flow
- `README_PDF_VIEWER.md` — PDF viewer that pairs with the notes drawer
- `README_API_LAYER.md` — Notes / paper / uploads APIs
- `README_DEEP_RESEARCH.md` — research panel that feeds citations into the editor
- `../scrapalot-chat/docs/README_KNOWLEDGE_GRAPH.md` — entity types referenced by citation marks
