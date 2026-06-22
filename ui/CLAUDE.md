# CLAUDE.md — Frontend (React + Vite)

**Last Updated**: April 2026

React 18 / TypeScript / Vite frontend for Scrapalot. Business logic and deep technical detail live in the `docs/README_*.md` files linked from each section. Rules below only.

## Quick Reference

| Item | Value |
|---|---|
| Stack | React 18.3.1, TypeScript 5.9.3, Vite |
| UI kit | Radix UI + Tailwind (Shadcn) |
| State | 15 React Context providers for shared state (no Redux); Zustand only for isolated local UI stores |
| API | Direct axios (React Query configured but NOT used) |
| WebSocket | STOMP over WebSocket (default export singleton) |
| i18n | i18next with `en` + `hr` translations |
| Editor | TipTap (core 2.10.3, newer extensions 2.27.1) |
| Test | Playwright E2E, **runs on the host**, not in Docker |

## Commands

```bash
npm run dev              # Dev server on :3000
npm run build            # Production build
npx tsc --noEmit         # Type check (mandatory after edits to .ts/.tsx)
npx playwright test      # E2E suite (from host, not inside container)
```

Full local-dev setups (gateway / direct Kotlin / Python-only / prod) with `.env.local` variants: `docs/README_API_LAYER.md`.

## Documentation Index

| Topic | Document |
|---|---|
| Component architecture (289 components) | `docs/README_COMPONENT_ARCHITECTURE.md` |
| State management (15 contexts, storage helpers) | `docs/README_STATE_MANAGEMENT.md` |
| API layer (auth, caches, axios config) | `docs/README_API_LAYER.md` |
| **Design system (read before any UI change)** | `docs/README_STYLE.md` |
| Notes editor + TipTap | `docs/README_NOTES_EDITOR.md`, `docs/README_TIPTAP.md` |
| PDF viewer | `docs/README_PDF_VIEWER.md` |
| Deep research panel | `docs/README_DEEP_RESEARCH.md` |
| **E2E testing (selectors, fixtures, patterns)** | `docs/README_E2E_TESTING.md` |
| Cloud deployment | `docs/README_CLOUD_DEPLOYMENT.md` |

## Architecture

```
User → Component → Hook → lib/api-*.ts → Gateway :8080 → Kotlin BE :8091 → gRPC → Python AI :8090
         ↓          ↓            ↓            JWT + rate      Postgres            PacketEmitter
    UI render  Context state  axios / STOMP                                       (83 packet types)
```

**Key directories (`src/`):**
- `components/` — 289 UI components (chat, notes, research, settings, knowledge, admin)
- `contexts/` — 15 providers (auth, workspace, models, collections, deep research, etc.)
- `hooks/` — custom hooks (conversations, streaming, research)
- `lib/` — `api.ts`, per-feature `api-*.ts`, `stomp-service.ts`, `storage-utils.ts`
- `types/` — `streaming-packets.ts` (79 packet type guards)
- `i18n/locales/{en,hr}/` — translations

## Critical Rules

### API + auth
1. **Always `await authState.waitForAuthReady()`** before any `apiClient` call. Workspace/models/collections contexts depend on auth being ready.
2. **React Query is NOT used** — it's configured but dead code. All API calls go through direct axios in `lib/api-*.ts`. Do not introduce `useQuery`/`useMutation`.
3. **STOMP is a default export singleton** — `import stompService from '@/lib/stomp-service'` (not named import, not new instance).
4. **Two separate caches** — `api.ts` has `responseCache` (60 s TTL, axios interceptor); `api-utils.ts` has `memoryCache` (300 s TTL). A real cache-bust must invalidate **both** — see `clearSessionsCache()` pattern.
5. **Notes collaboration uses Y.js WebSocket**, not STOMP. ~3–5 s sync delay between tabs is normal.

### Numeric values
6. **`0` is falsy** — always check `typeof value === 'number'`, not truthiness. Breaks silently on `progress === 0`, `count === 0`, etc.
7. **Progress range is `0.0 – 1.0`**, not `0 – 100`. Backend sends fractions.
8. `useMemo` dependency arrays must include **all** referenced state, including props and context values.

### Design system (`docs/README_STYLE.md`)
9. **Semantic colors only** — `bg-primary`, `text-muted-foreground`, never `bg-blue-500` or hex.
10. **Sharp corners (product UI)** — minimal radius is the intended default; `rounded-full` only for circles. ~60 legacy files still use `rounded-md|lg` — match the intended system in new code, don't propagate the drift. Public landing/marketing pages are exempt (see the `scrapalot-landing-design` skill).
11. **Borders over shadows** — prefer `border border-border` over `shadow-lg`.
12. **4 px spacing multiples** — 4, 8, 12, 16, 24…
13. **Both themes required** — every component must work in light AND dark. Verify all 6 accent colors (gray, blue, green, red, violet, orange).
14. **Never modify existing UI design** without explicit user request.

### i18n
15. Every new string uses `t('key.path')`. When adding keys, update **both** `en/translation.json` AND `hr/translation.json`.
16. Backend sends **status codes**, not English — e.g. `'documentQaNotIndexed'` → frontend translates via `lib/status-message-parser.ts`.
17. Run `node src/i18n/translations-alignment.cjs --add-missing` to sync en/hr/mk. The script inserts `[keyname]` placeholders for missing entries — these MUST be translated manually before commit (grep `": "\[` finds unresolved ones).

### Mobile / touch
18. **Desktop buttons** inside forms: `onMouseDown={(e) => e.preventDefault()}` to prevent textarea blur.
19. **Mobile popover lists**: use `onTouchStart`/`onTouchEnd` with a movement threshold (<10 px = tap, >10 px = scroll). `preventDefault` on touch blocks scroll gestures, do not use it there.
20. **Mobile popover re-render stability** — parent state refreshes (sessions list, collections context) can close popovers via stale cursor callbacks. Use a timestamp-based guard (ignore close events within 3 s of open) on mobile.
21. **Mobile dialogs** — use `disableFullscreenOnMobile` for small confirmations / settings dialogs.

### Radix + layout gotchas
22. **Popover positioning** — use the `collisionPadding` prop, never CSS `!left-[Xpx]` overrides.
23. **Radix `ScrollArea` breaks inside flex columns** — `<ScrollArea className="flex-1 min-h-0">` does not propagate parent flex height to its viewport; wheel events silently fail. Use a native `<div className="flex-1 min-h-0 overflow-y-auto">` for scroll regions inside `flex flex-col`. Fixed in `ea7afe5`.
24. **AI panel z-index must exceed `z-[10001]`** — TipTap selection toolbar sits at `z-[10001]`. `DraggablePanel` uses `z-[10002]` with backdrop at `z-[10001]`. Any new floating panel from the notes toolbar must stack above 10001.
25. **`DraggablePanel` viewport clamp** — hardcoded `window.innerHeight - 120` margins clip tall panels. `DraggablePanel` uses `useLayoutEffect` + `ResizeObserver` to measure real size, then clamps `top/left` so `panel.bottom ≤ viewport - 8`. Reuse `DraggablePanel` — never roll your own positioning.
26. **Portal containers** — use dedicated portal containers to prevent `insertBefore` errors inside drawers.
27. **Knowledge Stacks nested dialogs** — viewport must be > 1400 px; smaller triggers the mobile-fullscreen path which closes the outer dialog first.
28. **`@mentions` chips-only pattern** — never insert mention text into the textarea (transparent overlay leaves invisible gaps). Track mentions in state, render chips above the input, strip matching tokens from text on selection.
29. **Extend ChatMessage via props, never build a parallel component** — for UI that renders in chat context (clarification, plan preview, research setup, peer review), add a prop to `ChatMessage` and render inside it (like `clarificationData`, `planPreviewData`, `researchSetupData`). Building a wrapper bypasses model icon, streaming, scroll-to-bottom, and edit handlers.
30. **`DraggablePanel` prop is `initialPosition`** (not `defaultPosition`) — mismatch crashes with "Cannot read properties of undefined (reading 'top')".

### RAG + search
31. **`document_ids` without `collection_ids`** — when passing document_ids to the retriever, always also pass `collection_ids`. Retriever falls back to the default collection when `collection_ids=None`, which will not contain the target document's embeddings.
32. **Sessions vs conversations** — the backend table is `sessions`; the frontend historically used `conversations`. Both show up in code; treat them as the same thing.

### Code quality
33. **Always run `npx tsc --noEmit`** after any `.ts`/`.tsx` edit.
34. **Never claim "will work"** without proof — build locally + verify in Chrome BEFORE committing.
35. **Fix bugs at the root** — no workarounds, no disabled features, no revert to backend when the user asked for frontend rendering.
36. **No in-memory cross-service cache** — use direct axios, Redis Streams SAGA, or gRPC.
37. **`require()` is not defined in Vite ESM bundle** — use top-level `import` or dynamic `import()`. Never `const { x } = require('./y')` inside callbacks; it throws "require is not defined" at runtime.

### Git / docs
38. **No Claude Code attribution** on commits — no co-author tags, no automation signatures.
39. **Never create `*.md` files** without user approval. All docs in English, placed in `docs/` with `README_` prefix.
40. **UI commits go out immediately** — don't wait for user to say "push".

### Composition & integration gotchas
41. **One `asChild` per child ref.** If two Radix primitives (Popover + Tooltip, DropdownMenu + Tooltip, etc.) both want `asChild` on the same button, the inner one silently steals the outer's trigger ref and the outer becomes a no-op. Flatten the nesting or drop the outer affordance to native (`title`, `aria-label`). Applies to any ref-forwarding library where wrappers compose (not just Radix).
42. **Reverse proxy DNS is cached until reload.** NGINX / Envoy / HAProxy resolve a literal `proxy_pass hostname` once at startup. Any `docker restart <upstream>` silently turns requests into 502. Fix at source — declare a resolver with short TTL and put the upstream in a variable (`resolver 127.0.0.11 valid=10s; set $u svc:port; proxy_pass http://$u;`) — so DNS actually re-resolves. Reloads should be emergency-only, not routine.
43. **Third-party APIs are CORS-hostile by default.** Every new provider (LLM, analytics, payments, whatever) goes through the existing server-side proxy first; direct browser fetch is an opt-in *after* verifying CORS headers for that specific endpoint. Don't let a working prototype on one provider tempt you into skipping the proxy for the next.
44. **Programmatic mutations can bypass reactive observers.** Editor/state libraries run their "something changed" side-effects off user input events. When you mutate from code (TipTap `editor.chain().insertContentAt`, imperative Zustand `setState`, direct Y.Doc writes, etc.), autosave / dirty-check / telemetry may not fire. Kick the persistence pipeline explicitly after any programmatic edit rather than trusting the observer chain.

## Testing protocol

### Chrome-first, Playwright second (mandatory)

Every UI feature must be verified manually in Chrome **before** writing a Playwright test. No exceptions.

1. **Build** — `npm run build`, then `docker cp dist/. scrapalot-ui:/app/dist/` to sync into the container without a CI deploy.
2. **Chrome verify** — open the feature in a real browser, interact with it, take screenshots as proof. Verify computed styles (`getComputedStyle`), z-index layering, touch/scroll behavior, snake_case field mapping from API. These are the classes of bugs Playwright misses.
3. **Fix what is broken** before writing any test.
4. **Then write the Playwright test** against the confirmed-working UI.

### Playwright rules (strict)

- **Tests run on the host** from `/opt/scrapalot/scrapalot-ui/`, not inside the `scrapalot-ui` container (the container only has `dist/`).
- **No tolerant tests** — `isVisible().catch(() => false)` + conditional skip is banned. Use `await expect(x).toBeVisible({ timeout: ... })`. A missing element must fail the test.
- **No class selectors** — `[data-testid]` / `[data-tour]` only, never `.h-8.w-8`.
- **Full flows only** — create → interact → verify result. Not isolated existence checks.
- **Test order** — light tests first (auth, settings, chat, knowledge), deep research **last**. Deep research is sensitive to VPS load and produces truncated responses under CPU pressure.
- **Tour must be disabled** via `addInitScript` **before** navigation, setting `localStorage['scrapalot_tour_completed'] = 'true'` (underscores, not hyphens).
- **`force: true`** fallback when clicking disabled options (e.g. collections without embeddings).

Full selector list, `beforeEach` fixtures, page object helpers, and the 107-test breakdown: `docs/README_E2E_TESTING.md`.

### "Test it" = Playwright E2E

When the user says "test it" or "probaj", write and run a Playwright spec from `tests/e2e/`. Do not use browser automation MCP tools for verification — those are for Chrome-first manual verification only. Never stop at a partial result; when the user says "test all PRDs" or "finish", complete the entire task.

## Key Files

| Category | Files |
|---|---|
| Chat | `src/components/chat/chat-message.tsx`, `chat-messages.tsx`, `chat-input.tsx` |
| Deep research | `src/hooks/use-deep-research-panel.tsx`, `src/contexts/deep-research-context.tsx`, `src/components/research/*.tsx` |
| Notes editor | `src/components/notes/notes-drawer.tsx`, `src/components/notes/extensions/*.ts` |
| Knowledge Stacks | `src/components/knowledge/knowledge-stacks-dialog.tsx`, `knowledge-file-uploader.tsx` |
| API clients | `src/lib/api.ts`, `src/lib/api-*.ts` |
| Streaming | `src/lib/stomp-service.ts`, `src/types/streaming-packets.ts` |
| Storage | `src/lib/storage-utils.ts` (`userPrefs`, `modelSelections`, `uiState`) |
| Admin inspector | `src/components/admin/document-rag-tracing.tsx`, `graph-housekeeping.tsx` |

---

**Workspace**: `../CLAUDE.md` · **Gateway**: `../scrapalot-gw/CLAUDE.md` · **Backend (Kotlin)**: `../scrapalot-backend/CLAUDE.md` · **Python AI**: `../scrapalot-chat/CLAUDE.md`
