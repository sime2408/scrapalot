---
name: scrapalot-ui-component-developer
description: Use this skill when building or modifying React components for the Scrapalot product UI (chat, notes, research, settings, knowledge, admin) using Radix UI primitives, CVA, TailwindCSS, Framer Motion and TypeScript. Encodes the real design system, the hard-won layout/Radix gotchas, and the Chrome-first verification protocol. NOT for public landing/marketing pages — use scrapalot-landing-design for those.
---

# UI Component Developer (Scrapalot product UI)

Build production components that look like they already belong in the app. The
in-app surface is a mature, consistent system (≈289 components) — match it, do
not redesign it. **CLAUDE.md rule #14: never modify existing UI design without an
explicit request.**

> **Sources of truth — read before non-trivial work**
> - `docs/README_STYLE.md` — full design system (tokens, accents, spacing, motion)
> - `CLAUDE.md` (frontend) — the 44 critical rules; this skill encodes the highest-value ones
> - `docs/README_COMPONENT_ARCHITECTURE.md`, `docs/README_STATE_MANAGEMENT.md`

## Stack (verified)

- React 18.3 + TypeScript 5.9, Vite
- Radix UI primitives + Tailwind (shadcn/ui conventions), CVA for variants
- **Framer Motion** for animation (`framer-motion@12`). There is **no GSAP** — do not add it.
- i18next (`en` + `hr`), Lucide icons, React Hook Form + Zod for forms
- **State: React Context is the app-wide mechanism (15 providers).** Zustand exists
  but is used only for a few isolated local UI stores (`use-notes-drawer`,
  `use-chat-scope-store`, `use-document-file-status`). Do **not** reach for Zustand
  for cross-feature/shared state — add or extend a Context provider instead.
  (Note: CLAUDE.md's "no Zustand" line predates these local stores; treat it as
  "no Zustand for shared state".)
- API: **direct axios** in `lib/api-*.ts`. React Query is configured but dead — do
  not introduce `useQuery`/`useMutation`. STOMP is a **default-export singleton**.

## Design system (the parts people get wrong)

Old guidance hardcoded a violet `#8B5CF6` primary and `rounded-lg`/`shadow-lg`.
That is wrong. The real system:

- **Primary is dynamic.** Default accent is **blue** (`--primary: 217 91% 59.8%`),
  and users pick one of **6 accents** (gray, blue, green, red, violet, orange) via
  `data-accent` on `:root`. **Always** use `bg-primary` / `text-primary` /
  `ring-primary` — never a hardcoded hex or `bg-blue-500`. Every component must be
  verified across all 6 accents and **both** light and dark themes.
- **Semantic tokens only:** `bg-background`, `text-foreground`,
  `text-muted-foreground`, `bg-accent`, `border-border`, `text-destructive`,
  `text-success`, `text-warning`. No raw Tailwind color scales in app components.
- **Geometric clarity — sharp corners.** Minimal radius; `rounded-full` only for
  circles (avatars, dots, pills). Do not sprinkle `rounded-lg/xl`. (Some legacy
  files still do — match the *intended* system, not the drift.)
- **Borders over shadows.** Prefer `border border-border` for elevation; avoid
  `shadow-lg`.
- **Spacing in 4px multiples** (`gap-2`, `p-4`, `p-6`…). Cards `p-6`, dialogs `p-4`.

## Component template (CVA + semantic tokens)

```tsx
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const widgetVariants = cva(
  'inline-flex items-center justify-center border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground border-transparent hover:bg-primary/90',
        outline: 'border-border bg-background hover:bg-accent hover:text-accent-foreground',
        ghost: 'border-transparent hover:bg-accent hover:text-accent-foreground',
      },
      size: { sm: 'h-9 px-3 text-sm', md: 'h-10 px-4', lg: 'h-11 px-8 text-lg' },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  }
);

export interface WidgetProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof widgetVariants> {}

export const Widget = React.forwardRef<HTMLDivElement, WidgetProps>(
  ({ className, variant, size, ...props }, ref) => (
    <div ref={ref} className={cn(widgetVariants({ variant, size, className }))} {...props} />
  )
);
Widget.displayName = 'Widget';
```

Reuse the existing `@/components/ui/*` primitives (Button, Dialog, Input, Form,
ConfirmDialog, DraggablePanel…) before building a new base component.

## i18n (mandatory)

Every user-facing string goes through `t('key.path')`. When adding keys, update
**both** `i18n/locales/en/translation.json` and `hr/translation.json`. Run
`node src/i18n/translations-alignment.cjs --add-missing`, then translate every
`": "[placeholder]"` it inserts before commit. Backend sends **status codes**, not
English — translate via `lib/status-message-parser.ts`.

## Hard-won gotchas (these are the bugs the skill exists to prevent)

**Radix / layout**
- **One `asChild` per child ref.** Nesting two ref-forwarding primitives (Popover +
  Tooltip, DropdownMenu + Tooltip) on the same button makes the outer a silent
  no-op. Flatten, or drop the outer to native `title`/`aria-label`.
- **Radix `ScrollArea` breaks inside a `flex flex-col`** — its viewport ignores
  parent flex height and wheel events die. Use native
  `<div className="flex-1 min-h-0 overflow-y-auto">`.
- **Popover positioning:** use the `collisionPadding` prop, never CSS `!left-[Xpx]`.
- **Floating panels from the notes toolbar** must stack above `z-[10001]` (TipTap
  selection toolbar). Reuse `DraggablePanel` (`z-[10002]`); its prop is
  `initialPosition` (not `defaultPosition`, which crashes), and it self-clamps to
  the viewport — never roll your own positioning.
- **Portal containers** inside drawers prevent `insertBefore` errors.
- **Knowledge Stacks nested dialogs** need viewport > 1400px (smaller → mobile
  fullscreen path closes the outer dialog).

**State / data**
- **`0` is falsy** — check `typeof value === 'number'`, not truthiness
  (`progress === 0`, `count === 0` break silently). Progress is `0.0–1.0`, not 0–100.
- `useMemo`/`useEffect` dep arrays must include every referenced prop and context value.
- **Two caches:** `api.ts` `responseCache` (60s) and `api-utils.ts` `memoryCache`
  (300s). A real cache-bust invalidates **both** (see `clearSessionsCache()`).
- Always `await authState.waitForAuthReady()` before any `apiClient` call.
- **Programmatic mutations bypass observers** — after `editor.chain()…`, imperative
  store writes, or direct Y.Doc edits, kick autosave/dirty-check explicitly.
- `require()` is undefined in the Vite ESM bundle — use `import` / dynamic `import()`.

**Mobile / touch**
- Desktop buttons inside forms: `onMouseDown={(e) => e.preventDefault()}` to keep
  textarea focus.
- Mobile popover lists: `onTouchStart`/`onTouchEnd` with a <10px = tap, >10px =
  scroll threshold (no `preventDefault` — it kills scroll). Guard against parent
  re-renders closing the popover (ignore close events within 3s of open).
- Small confirmations/settings dialogs: `disableFullscreenOnMobile`.

**Chat surface**
- For UI that renders in chat (clarification, plan preview, research setup, peer
  review): **add a prop to `ChatMessage`** and render inside it — never build a
  parallel wrapper (you'd lose model icon, streaming, scroll-to-bottom, edit).

## Verification protocol (CLAUDE.md — not optional)

**Chrome-first, Playwright second.** Never claim "will work" without proof.

1. `npm run build`, then `docker cp dist/. scrapalot-ui:/app/dist/` to sync without a CI deploy.
2. **Chrome:** open the feature, interact, screenshot. Check `getComputedStyle`,
   z-index layering, touch/scroll, snake_case API mapping, **and all 6 accents +
   light/dark**. These are the bug classes Playwright misses.
3. Fix what's broken.
4. **Then** write a Playwright spec in `tests/e2e/` — strict assertions only
   (`await expect(x).toBeVisible()`), `[data-testid]` selectors only, full flows
   (create → interact → verify). No tolerant `.catch(() => false)` + skip.

Always `npx tsc --noEmit` after `.ts`/`.tsx` edits. **UI commits go out immediately**
— build + Chrome-verify, then commit and push (no Claude attribution).
