# PDF Viewer

**Last Updated**: April 2026

Scrapalot's PDF viewing layer wraps `@react-pdf-viewer/core` with annotations, RAG citation highlights, TTS playback, and notes-drawer integration. This document covers Scrapalot's wrapper code only — for the underlying library refer to `react-pdf-viewer.dev`.

## Stack

| Item | Value |
|---|---|
| Library | `@react-pdf-viewer/core` ^3.12.0 |
| Plugins | `@react-pdf-viewer/default-layout`, `@react-pdf-viewer/highlight`, `@react-pdf-viewer/zoom` |
| PDF.js worker | `pdfjs-dist` ^3.11.174 |
| Mount strategy | Singleton via `GlobalPDFViewer` + `pdf-viewer-context` |
| Portal z-index | 1400 (set on `#pdf-viewer-portal`) |

## File Layout

```
src/
├── components/knowledge/pdf/
│   ├── pdf-viewer.tsx              # Core <PDFViewer> wrapper around Viewer + Worker
│   ├── pdf-viewer-drawer.tsx       # Sliding drawer shell + close button
│   ├── global-pdf-viewer.tsx       # Singleton mount via portal + context
│   ├── pdf-reader-settings.tsx     # Reader preferences popover (theme, scale, layout)
│   ├── pdf-viewer-tts-edge.tsx     # Edge-TTS playback overlay
│   └── pdf-document-notes.tsx      # Notes-drawer integration on the side
├── components/annotations/
│   └── pdf-annotation-layer.tsx    # Persistent highlight / underline overlay
└── contexts/
    └── pdf-viewer-context.tsx      # Open / close / metadata state machine
```

## Component Roles

### `<PDFViewer>` (`pdf-viewer.tsx`)
Receives a `url` plus optional initial page, highlight text, zoom, and annotation list. Uses:
- `Viewer` from `@react-pdf-viewer/core` with `defaultLayoutPlugin` and `highlightPlugin`.
- `Worker` for PDF.js, mounted once near the viewer.
- `useTheme()` from `@/providers/theme-provider` to switch the viewer's light/dark mode at runtime.
- `useIsMobile()` to switch fit-to-width vs fixed scale on small screens.

`AnnotationHighlight` props feed the persistent highlight layer (annotationType: 1 = highlight, 3 = underline).

### `<PDFViewerDrawer>` (`pdf-viewer-drawer.tsx`)
Slide-out shell that hosts `<PDFViewer>`, integrates the close button, and respects the side-by-side layout when the notes drawer is open.

### `<GlobalPDFViewer>` (`global-pdf-viewer.tsx`)
Mounted once at app root. Reads `pdf-viewer-context` (`state.isOpen`, `documentId`, `collectionId`, `url`) and renders the drawer through a singleton portal (`#pdf-viewer-portal`, z-index 1400). The portal is created lazily and reused — never delete or recreate it inside the same session, this avoids `insertBefore` errors with React 18 strict-mode double mount.

When `documentId` transitions from null → value, `GlobalPDFViewer` records a `pdf_open` view via `recordDocumentView()` (`api-document-views.ts`). The server throttles within a 5-min window, so re-opening the same PDF after closing the drawer doesn't double-count.

### `<PDFReaderSettings>` (`pdf-reader-settings.tsx`)
Settings popover persisted via `userPrefs` from `lib/storage-utils.ts`.

### `<PDFViewerTtsEdge>` (`pdf-viewer-tts-edge.tsx`)
Edge-TTS playback overlay. Streams audio chunks from the chat backend's `tts.proto` gRPC endpoint via the Kotlin gateway.

### `<PDFDocumentNotes>` (`pdf-document-notes.tsx`)
Renders the notes drawer side-by-side with the PDF, jumps to citation context when the user clicks a chunk.

### `<PDFAnnotationLayer>` (`components/annotations/pdf-annotation-layer.tsx`)
Persistent highlights independent of `@react-pdf-viewer/highlight`'s ephemeral selection. Pulls annotations from the backend, paints them above the PDF, and writes new ones back through `api-annotations.ts`.

## State (`pdf-viewer-context.tsx`)

| Action | Effect |
|---|---|
| `OPEN_PDF_VIEWER` | Sets `isOpen=true`, stores `documentId`, `collectionId`, `url`, optional `highlightText` and `initialPage` |
| `CLOSE_PDF_VIEWER` | Sets `isOpen=false` (state retained so reopen lands on the same page) |
| `SET_HIGHLIGHT` | Replaces `highlightText` mid-session — used when the user clicks a different RAG citation |

Consumers: `usePDFViewer()`. Producers: chat citation links, knowledge stack viewer, deep research source cards.

## Integration Points

| Caller | What it does |
|---|---|
| Chat citation chips | Open the cited document at a specific page with `highlightText` set to the citation snippet |
| Deep research source cards | Same as chat citations |
| Knowledge stack | Open without highlight — user is browsing |
| Notes drawer | When notes drawer is open, layout shrinks PDF to leave room |
| Annotations | Bidirectional — read existing highlights, write new ones |

## Gotchas

- **`@react-pdf-viewer/core` 3.x is locked** — 4.x dropped some plugin APIs we depend on. Do not bump without porting `pdfAnnotationLayer` and `highlightPlugin` usage.
- **Portal z-index** must stay at 1400. Radix Dialogs sit at 1300; NotesDrawer floating panels go higher (10001+). PDF viewer must be above general content but below editor floating menus.
- **Worker URL** is bundled by Vite — do not import the worker from a CDN; offline / VPS deployments break.
- **Highlight by text, not line numbers** — the legacy `highlightLineStart` / `highlightLineEnd` props remain for back-compat but `highlightText` is canonical (line number mapping diverges across PDFs of the same source).
- **Portal singleton** — never call `removeChild` on `#pdf-viewer-portal`. Reuse via `getOrCreatePortalContainer()` in `global-pdf-viewer.tsx`.

## Annotations Subsystem

The annotation layer (`pdf-annotation-layer.tsx`) renders five overlay primitives:

| `annotation_type` | Tool | Default colour | Notes |
|---|---|---|---|
| 1 | Highlight | user-picked | rect-per-line, fills page coords |
| 2 | Note | user-picked | empty rect + comment, fires the gutter pin |
| 3 | Underline | `#2ea8e5` (forced) | text-decoration line below rect |
| 4 | Area capture | user-picked | bounding-box for a screenshot region |
| 5 | Strikethrough | `#aaaaaa` (forced) | line-through pseudo-element per rect |

`annotation-popover.tsx` is the on-selection toolbar with the five tool icons + a Sparkles AI dropdown (Cite / Explain / Similar) + a colour-picker dropdown. Tool icons one-click create — strike forces gray, underline forces blue, the rest use `activeColor`.

### Selection toolbar collection_id resolution

The popover's tool buttons short-circuit to a no-op when `useAnnotations.createHighlight` doesn't have both `documentId` and `collectionId`. The viewer drawer is opened from many surfaces (sidebar, chat citation, knowledge stack); some only know the document id. The `useResolvedCollectionId` hook (`src/hooks/use-resolved-collection-id.ts`) lazily fetches `getDocumentById(documentId)` to derive the missing id, then feeds it into `useAnnotations`. Without this lookup the entire selection toolbar appears broken when the PDF is opened from anywhere other than chat.

### Highlighted-passage transient pulse (citation-driven)

When a chat citation chip is clicked, `use-open-citation-in-viewer.ts` (and the sister inline handler in `chat-message.tsx`) reads `citation.chunk_position_json` (page + char offsets + bbox), packs it as `transientHighlight`, and dispatches `OPEN_PDF_VIEWER` with that payload. The annotation layer renders a yellow-bordered overlay (`data-testid="pdf-transient-highlight"`) for `ttlSeconds` (default 3).

Two effects guard against rpv-core's lazy mount: (a) a `MutationObserver` on the viewer subtree waits for `.rpv-core__page-layer[data-virtual-index="${pageIndex}"]` to appear before flipping `transientVisible`, and (b) the TTL countdown only starts when that page-layer exists. Otherwise the 3 s timer expires before the page is even rendered (130-page books at 190 % zoom take seconds to scroll to a far page).

### Gutter pin for annotations with comments

Any annotation whose `comment` field is non-empty surfaces a small notepad icon (`data-testid="pdf-gutter-pin-${annotationId}"`) in the page gutter. Click opens the existing hover popover with the comment text + share + delete actions.

Pin position is `min(pageBounds.right, innerRect.right) - PIN_WIDTH - 4` so the pin sits inside the visible viewport even when:
- The page-layer renders wider than the inner-pages container (overflow clipped at high zoom).
- A sibling side panel (notes / multimodal) takes part of the drawer width.

A `ResizeObserver` on `.rpv-core__inner-pages` re-renders the pins whenever a side panel opens/closes; without it the pins stick to their first computed coordinates and float over the panel.

### Workspace colour semantics (lookup, not source)

Annotation colours are pure visual until a workspace admin maps them to labels (`scrapalot.annotation_color_semantics(workspace_id PK, color_to_label JSONB)` on the Kotlin side). The `useAnnotationColorSemantics` hook (`src/hooks/use-annotation-color-semantics.ts`) GETs the workspace map and exposes a memoised `labelFor(hex)` lookup. Annotation popover uses it in three places:
- Color-picker swatch tooltips (`Yellow · Insight` instead of `Yellow · General (1.2x RAG boost)`).
- Compact legend under the swatch grid.
- Color picker trigger button label.

The Settings → Documents tab embeds `<SettingsCardAnnotationColors>` for editing the map, with two ready presets ("Critical reading", "Literature review") and 1.5 s debounced auto-save (no explicit Save button, mirroring the embedding-settings card pattern).

### Save AI answer as margin note

Each citation row in chat carries two icons: NotebookPen (insert into Notes editor) and BookmarkPlus (save the AI answer as a margin note in the cited document). Click on BookmarkPlus:
1. Resolves the citation's `source_collection_id` (bridge mode), or fetches `getDocumentById(documentId).collection_id` if not present.
2. Builds a position payload anchored to the cited page (gutter rect at top of page).
3. Calls `createAnnotation(documentId, { annotation_type: 2, comment: <AI answer truncated 1500 chars>, color: '#3b82f6', … })`.
4. The new annotation immediately surfaces a gutter pin in the PDF viewer.

The button is hidden on external URL citations and on file types other than PDF / EPUB.

### Multi-user shared annotations

The `ShareAnnotationDialog` (`share-annotation-dialog.tsx`) is hoisted to the layer level (PdfAnnotationLayer / EpubAnnotationLayer) so the Radix Dialog backdrop doesn't dismiss the parent hover popover. Recipient picker is a `Select` of workspace members returned by `GET /annotations/{id}/share-candidates` — never a free-text email input. Permission options: `read` / `write`. STOMP topic `/topic/annotations.{document_id}.events` broadcasts share / unshare / delete events to other users viewing the same document.

## Visual Entities Side Panel

`pdf-multimodal-panel.tsx` is a side panel (toggled by an Image icon in the viewer toolbar, `data-testid="pdf-viewer-multimodal-toggle"`) that lists every image / table / equation extracted from the document during ingest. Filter chip row at top scopes by element type with per-type counts. Click a row jumps the viewer to that page.

Source: `GET /api/v1/documents/{id}/multimodal-elements` (Kotlin REST → Python `ListDocumentMultimodalElements` gRPC). Empty state explains how to backfill via reprocess.

## Related Documents

- `README_NOTES_EDITOR.md` — notes drawer that hosts `<PDFDocumentNotes>` side-by-side
- `README_TIPTAP.md` — TipTap editor used inside the notes drawer
- `README_API_LAYER.md` — `recordDocumentView`, annotations API
- `README_STATE_MANAGEMENT.md` — provider nesting (PDFViewerProvider position)
- `../scrapalot-chat/docs/README_DOCUMENT_PROCESSING.md` — multimodal pipeline + chunk position_json producers
