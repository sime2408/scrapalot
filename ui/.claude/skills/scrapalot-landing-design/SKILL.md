---
name: scrapalot-landing-design
description: Use this skill when designing or building PUBLIC marketing/landing pages for Scrapalot (home, about, contact, buy-license, and src/components/landing). Pushes for art-directed, distinctive, motion-rich pages and breaks the generic-AI-UI defaults — adapted to Scrapalot's real stack (Framer Motion + existing landing primitives, NOT GSAP). For in-app product UI use scrapalot-ui-component-developer instead.
---

# Landing & Marketing Design (Scrapalot)

This is the one surface where "make it distinctive" beats "match the existing
system". The product app is deliberately restrained; the landing pages should be
premium, art-directed and memorable. Ideas here are cherry-picked from the
taste-skill project and re-pointed at **our** stack — we do **not** use GSAP.

**Scope:** `src/pages/{home,about,contact,buy-license,Index}.tsx`,
`src/components/landing/*`, `src/styles/landing.css`. Do not apply this aesthetic to
in-app product UI.

## Our motion + visual toolkit (use these, not GSAP)

We already ship a landing primitive library — reach for it before writing raw
animation:

| Need | Use |
|---|---|
| Animated section background | `aurora-background`, `cinematic-ribbons` |
| Card with hover/spotlight | `spotlight-card` |
| Scroll/word reveal | `blur-words` |
| Continuous logo/feature row | `marquee` |
| Count-up stat | `animated-counter` |
| Section title block | `section-heading` |

Animation engine is **Framer Motion** (`whileInView`, `viewport={{ once: true }}`,
staggered children, scroll-linked `useScroll`/`useTransform`). Landing-specific CSS
lives in `src/styles/landing.css`. Semantic color tokens still apply
(`bg-primary` etc.), but landing may use richer gradients, glows and (sparingly)
rounded shapes that the product UI avoids.

## Break the generic-AI defaults (the real value)

LLMs collapse into the same tells. Aggressively avoid all of these:

- **6-line heading walls.** H1 must flow horizontally in **2–3 lines max**. Use an
  ultra-wide container (`max-w-5xl`/`max-w-6xl`) and fluid size
  (`clamp(3rem, 5vw, 5.5rem)`), shrink the font before you let it wrap to 4+ lines.
- **Cramped sections.** Major sections get big vertical rhythm (`py-24 md:py-40`);
  each should read as a distinct cinematic chapter.
- **Repeated left-text/right-image** for every section. Vary the architecture
  (centered cinematic hero, artistic asymmetry, editorial split, full-bleed media).
- **Bento grids with dead cells.** Use `grid-flow-dense` and verify spans
  interlock — no empty corners.
- **Card spam / cards-inside-cards-inside-cards.** 3–5 intentional cards beat 8
  messy ones. Keep nesting shallow.
- **Cheap meta-labels** — "SECTION 01", "QUESTION 05", "ABOUT US" eyebrow tags.
  Remove them.
- **Invisible button text.** Guarantee contrast: dark bg → light text, light bg →
  dark text.
- **Static interfaces.** Every card/image reacts:
  `group-hover:scale-[1.03] transition-transform duration-500` inside
  `overflow-hidden`. Reveal content on scroll with Framer Motion `whileInView`.
- **No emojis in code/markup.** Keep formatting professional.

## Pre-flight design plan (mandatory before coding a new page/section)

Before writing JSX, output a short `<design_plan>` — this is the discipline that
stops lazy first-draft layouts. Drop taste-skill's "simulate Python RNG" gimmick;
just **consciously choose** instead of defaulting:

1. **Layout choice:** which hero architecture + which 2–3 section layouts (name them,
   and say why this page, not the same template as last time).
2. **Toolkit map:** which existing landing primitives + Framer Motion patterns each
   section uses.
3. **Hero math:** the exact `max-w` on the H1 that guarantees 2–3 lines, and
   confirm no eyebrow meta-label / floating badge spam.
4. **Density check:** bento spans interlock (`grid-flow-dense`), shallow nesting.
5. **Contrast + token sweep:** buttons legible, semantic tokens used, works light +
   dark.

Only write the page after this block.

## Image-first workflow (for net-new pages where visuals matter)

When the task is primarily visual and image generation is available:

1. **Generate/collect a reference image first** (large, section-specific, readable —
   not one tiny compressed board for the whole page). For prototyping placeholders,
   `https://picsum.photos/seed/{keyword}/1920/1080` with tasteful CSS filters
   (`grayscale`, `contrast-125`, dark overlay) reads less "stock".
2. **Analyze it** — layout, hierarchy, spacing, motion intent.
3. **Implement to match** with our primitives. The image is the visual source of
   truth; don't freeform-code first and reinterpret loosely.

Swap placeholders for real Scrapalot assets before shipping. Reference design notes:
the landing design kit (see workspace memory `reference_landing_design_kit`) for
`--glow-2` accent, the `#root` `text-align` trap, and doubled `.landing-btn`
selectors.

## Motion principles (adapted from design-motion-principles)

Motion must be purposeful, fast, and selective — not decoration sprayed on
everything. Pick the lens by context: **restraint/speed** for anything
interactive or repeated, **production polish** (subtle, refined) for the marketing
narrative, **creative** only where the brand is deliberately playful.

**Timing & easing (defaults):**
- **UI motion stays < 300ms.** 180ms reads as more responsive than 400ms. When in
  doubt, faster.
- **Frequency rule:** the more often an interaction happens, the less it should
  animate. Big morphing reveals are fine for a once-per-visit hero; keyboard- or
  high-frequency interactions get instant transitions or none.
- **Custom easing always.** Bare `ease`/`ease-in-out` lack strength. `ease-out` for
  things arriving, `ease-in` for leaving, spring for interactive. For Framer Motion
  prefer springs: `transition={{ type: 'spring', duration: 0.45, bounce: 0 }}`
  (`bounce: 0` = refined; raise bounce only for playful brand moments — never on a
  professional CTA).

**Enter / exit recipe (the polished default):**
```jsx
// Enter: opacity + small translateY + brief blur "materializes" the element
initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
viewport={{ once: true, margin: '-10%' }}
transition={{ type: 'spring', duration: 0.45, bounce: 0 }}
// Exit should be SUBTLER than enter — focus is on what's arriving, not leaving:
exit={{ opacity: 0, y: -12, filter: 'blur(4px)' }}
```
Use `AnimatePresence` for any conditional render; never instant-swap mounted content.

**Anti-slop motion checklist (do NOT do these by default):**
- Pulsing/glowing/breathing status dots and CTAs (`animate-pulse`, infinite
  scale/opacity loops) — almost always slop.
- Blur-on-entrance applied to *every* element — the blur recipe is for a hero/modal,
  not all cards + paragraphs (and never on first-paint headings, it hurts readability).
- `hover:scale-*` slapped on every card/button/image — reserve for a few intentional
  targets.
- Stagger-spam / uniform fade-ins for all content; motion on mount for static content.
- `scale(0)` start points (use `scale(0.9)`+); bouncy/elastic easing on utility actions.

**Accessibility (not optional):** always respect reduced motion. Either gate Framer
variants on `useReducedMotion()`, or keep this global guard so final states survive:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important; animation-iteration-count: 1 !important;
    transition-duration: .01ms !important; scroll-behavior: auto !important;
  }
}
```
Avoid large-scale/parallax motion and unpausable loops for motion-sensitive users.

## Craft & polish (adapted from impeccable)

- **Typography carries the page.** Avoid invisible defaults (Inter/Roboto/system at
  a flat scale) for brand surfaces; use a fluid `clamp()` scale with a **≥1.25 ratio**
  between steps and strong weight contrast (muddy 14/15/16px hierarchy is a tell).
  Body ≥16px, line length 45–75 chars, max 2–3 families.
- **Real content, no filler.** No lorem ipsum, fake metrics, dead links, emoji-as-
  imagery, or decorative CSS panels standing in for real images. Image-led sections
  need real/sourced imagery, not CSS scenery.
- **Color depth.** Don't use pure black/flat gray — tint neutrals toward the brand.
  No gray text on colored backgrounds.
- **Full state coverage** for anything interactive: default, hover, focus-visible,
  active, disabled, loading, error, empty, plus long/short text and overflow.
- **The approved direction is a contract.** If a mock/reference was agreed, the live
  build must keep its major ingredients (hero object, imagery, section structure,
  CTA/nav treatment, signature motif). Missing them = a blocking defect, not a
  variation.

## Guardrails (still apply on landing)

- **i18n:** every string via `t('key.path')`, update `en` + `hr`.
- **Both themes:** verify light and dark.
- **Public routes** must be in `isPublicRoute()` or they 401-bounce to `/login`.
- **Wrap pages** in `overflow-x-hidden w-full` to kill horizontal scrollbars from
  off-screen animation.
- **Verify in Chrome, then Playwright** (`playwright.marketing.config.ts` exists for
  marketing specs). `npm run build` + Chrome screenshot before commit. UI commits go
  out immediately, no Claude attribution.
- **Fast agent-driven browser iteration (optional):** for quick visual loops the
  Chrome MCP tools are the default here. `vercel-labs/agent-browser` (native Rust
  CDP CLI, ref-based: snapshot → `find role button --name …` → act) is a faster
  alternative for headless agent checks, but it is a separate global install
  (`npm i -g agent-browser && agent-browser install`) — confirm with the user before
  adding it. It does **not** replace the committed Playwright E2E layer; the
  `tests/e2e` + marketing specs remain the source of truth for regression.
