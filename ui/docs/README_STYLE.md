# Scrapalot UI Style Guide

This document provides a comprehensive overview of the design system and styling conventions used throughout the Scrapalot UI project.

---

## Table of Contents

1. [Overview](#overview)
2. [Color Palette](#color-palette)
3. [Dynamic Accent Color System](#dynamic-accent-color-system)
4. [Typography](#typography)
5. [Spacing System](#spacing-system)
6. [Component Styles](#component-styles)
7. [Shadows & Elevation](#shadows--elevation)
8. [Animations & Transitions](#animations--transitions)
9. [Framer Motion Animations](#framer-motion-animations)
10. [Border Radius](#border-radius)
11. [Opacity & Transparency](#opacity--transparency)
12. [Gradient Backgrounds](#gradient-backgrounds)
13. [Modern Component Patterns](#modern-component-patterns)
14. [Common Tailwind CSS Usage](#common-tailwind-css-usage)
15. [Example Component Reference](#example-component-reference)
16. [Portal Containers & Drawer Management](#portal-containers--drawer-management)
17. [Glassmorphism & Backdrop Blur](#glassmorphism--backdrop-blur)
18. [Inline Styles for Standalone Components](#inline-styles-for-standalone-components)

---

## Overview

Scrapalot UI follows a modern, accessible design system built with **React**, **TypeScript**, **Tailwind CSS**, **Framer Motion**, and **shadcn/ui** components. The design emphasizes clarity, consistency, and user experience across both light and dark themes.

### Design Principles

- **Consistency**: Uniform spacing, typography, and color usage throughout the application
- **Accessibility**: WCAG 2.1 AA compliant color contrasts and keyboard navigation
- **Responsiveness**: Mobile-first approach with breakpoints for all screen sizes
- **Performance**: Optimized animations and efficient CSS usage
- **Maintainability**: Reusable components and utility-first CSS approach
- **Geometric Clarity**: Sharp, precise design with minimal border radius

---

## Color Palette

### Theme System

The application supports both **light** and **dark** themes with automatic system preference detection, plus **6 dynamic accent colors** that users can switch between.

### Primary Colors

```css
/* Light Theme */
--background: 0 0% 100%;           /* #FFFFFF - Main background */
--foreground: 240 10% 3.9%;        /* #09090B - Main text */
--primary: 217.2 91.2% 59.8%;      /* Blue primary (default) */
--primary-foreground: 222.2 47.4% 11.2%; /* Text on primary */

/* Dark Theme */
--background: 240 10% 3.9%;        /* #09090B - Main background */
--foreground: 0 0% 98%;            /* #FAFAFA - Main text */
--primary: 217.2 91.2% 59.8%;      /* Blue primary (default) */
--primary-foreground: 222.2 47.4% 11.2%; /* Text on primary */
```

### Semantic Colors

```css
/* Accent Colors */
--accent: 240 4.8% 95.9%;          /* Light: #F4F4F5, Dark: #27272A */
--accent-foreground: 240 5.9% 10%; /* Text on accent */

/* Muted Colors */
--muted: 240 4.8% 95.9%;           /* Light: #F4F4F5, Dark: #27272A */
--muted-foreground: 240 3.8% 46.1%; /* #71717A - Secondary text */

/* Border & Input */
--border: 240 5.9% 90%;            /* #E4E4E7 - Default borders */
--input: 240 5.9% 90%;             /* Input field borders */
--ring: 217.2 91.2% 59.8%;         /* Focus ring color (matches primary) */
```

### Status Colors

```css
/* Destructive (Error/Danger) */
--destructive: 0 84.2% 60.2%;      /* #EF4444 - Red */
--destructive-foreground: 0 0% 98%; /* Text on destructive */

/* Success */
--success: 142 76% 36%;            /* #10B981 - Green */

/* Warning */
--warning: 38 92% 50%;             /* #F59E0B - Amber */

/* Info */
--info: 199 89% 48%;               /* #0EA5E9 - Blue */
```

### Zinc Palette (Grays)

```css
zinc-50:  #FAFAFA
zinc-100: #F4F4F5
zinc-200: #E4E4E7
zinc-300: #D4D4D8
zinc-400: #A1A1AA
zinc-500: #71717A
zinc-600: #52525B
zinc-700: #3F3F46
zinc-800: #27272A
zinc-900: #18181B
```

### Usage Examples

```tsx
// Background colors
<div className="bg-background text-foreground">
  <div className="bg-accent text-accent-foreground">Accent section</div>
  <div className="bg-muted text-muted-foreground">Muted section</div>
</div>

// Primary actions (adapts to user's accent color)
<button className="bg-primary text-primary-foreground hover:bg-primary/90">
  Primary Button
</button>

// Status indicators
<div className="text-destructive">Error message</div>
<div className="text-success">Success message</div>
<div className="text-warning">Warning message</div>
```

---

## Dynamic Accent Color System

Scrapalot UI supports **6 accent color themes** that users can switch between. The accent color dynamically updates the `--primary` CSS variable throughout the entire application.

### Available Accent Colors

Users can choose from 6 accent colors via the settings panel. Each color is defined using the `data-accent` attribute on the `:root` element:

```css
/* Set via data-accent attribute on :root or html element */
[data-accent='gray'] {
  --primary: 240 5.9% 50%;          /* Gray/Neutral */
  --primary-foreground: 0 0% 98%;
}

[data-accent='blue'] {
  --primary: 217.2 91.2% 59.8%;     /* Blue (Default) */
  --primary-foreground: 222.2 47.4% 11.2%;
}

[data-accent='green'] {
  --primary: 142.1 76.2% 36.3%;     /* Green */
  --primary-foreground: 355.7 100% 97.3%;
}

[data-accent='red'] {
  --primary: 0 72.2% 50.6%;         /* Red */
  --primary-foreground: 0 0% 98%;
}

[data-accent='violet'] {
  --primary: 262.1 83.3% 57.8%;     /* Violet/Purple */
  --primary-foreground: 210 20% 98%;
}

[data-accent='orange'] {
  --primary: 24.6 95% 53.1%;        /* Orange */
  --primary-foreground: 60 9.1% 97.8%;
}
```

### Dark Theme Adjustments

Some colors adjust for better visibility in dark mode:

```css
.dark[data-accent='gray'] {
  --primary: 240 3.7% 70%;
}

.dark[data-accent='violet'] {
  --primary: 263.4 70% 70.2%;  /* Lighter in dark mode */
}

/* Other colors remain the same in dark mode */
```

### Usage Guidelines

**Always use semantic color variables** so components automatically adapt to the user's selected accent color:

```tsx
// CORRECT - Adapts to user's accent color
<button className="bg-primary text-primary-foreground hover:bg-primary/90">
  Themed Button
</button>

<div className="border-primary/30 bg-primary/10">
  Themed container
</div>

<span className="text-primary">Themed text</span>

// ❌ WRONG - Hardcoded color, doesn't adapt
<button className="bg-violet-600 text-white hover:bg-violet-700">
  Hardcoded Button
</button>

<div className="border-violet-300 bg-violet-100">
  Hardcoded container
</div>
```

### Opacity Modifiers

Use opacity modifiers for subtle backgrounds and borders:

```tsx
// Backgrounds
<div className="bg-primary/5">Very subtle (5%)</div>
<div className="bg-primary/10">Subtle (10%)</div>
<div className="bg-primary/20">Medium (20%)</div>

// Borders
<div className="border border-primary/30">Subtle border</div>
<div className="border border-primary/50">Medium border</div>

// Gradients with primary color
<div className="bg-gradient-to-br from-primary/15 via-primary/10 to-primary/5">
  Gradient background
</div>
```

### Important Rules

1. **Never hardcode accent colors** - Always use `bg-primary`, `text-primary`, `border-primary`
2. **Test all accent colors** - When creating new components, test with all 6 accent colors
3. **Respect the theme** - Don't override `--primary` in component CSS
4. **Use opacity for subtlety** - `/10`, `/20`, `/30` for backgrounds; `/50`, `/70` for borders

---

## Typography

### Font Families

```css
/* Primary Font - Inter */
font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

/* Monospace Font - JetBrains Mono */
font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
```

### Font Sizes

```css
text-xs:   0.75rem  (12px)  - Small labels, captions
text-sm:   0.875rem (14px)  - Secondary text, descriptions
text-base: 1rem     (16px)  - Body text (default)
text-lg:   1.125rem (18px)  - Emphasized text
text-xl:   1.25rem  (20px)  - Small headings
text-2xl:  1.5rem   (24px)  - Section headings
text-3xl:  1.875rem (30px)  - Page headings
text-4xl:  2.25rem  (36px)  - Large headings
text-5xl:  3rem     (48px)  - Hero text
```

### Font Weights

```css
font-light:     300 - Light emphasis
font-normal:    400 - Body text (default)
font-medium:    500 - Subtle emphasis
font-semibold:  600 - Strong emphasis
font-bold:      700 - Headings, important text
```

### Line Heights

```css
leading-none:    1      - Tight spacing
leading-tight:   1.25   - Headings
leading-snug:    1.375  - Compact text
leading-normal:  1.5    - Body text (default)
leading-relaxed: 1.625  - Comfortable reading
leading-loose:   2      - Spacious text
```

### Typography Usage Examples

```tsx
// Headings
<h1 className="text-3xl font-bold">Page Title</h1>
<h2 className="text-2xl font-semibold">Section Heading</h2>
<h3 className="text-xl font-medium">Subsection</h3>

// Body text
<p className="text-base leading-relaxed">
  Regular paragraph text with comfortable line height.
</p>

// Small text
<span className="text-sm text-muted-foreground">
  Secondary information
</span>

// Extra small labels
<span className="text-[10px] text-muted-foreground uppercase tracking-wide">
  Label
</span>

// Code/Monospace
<code className="font-mono text-sm bg-muted px-1.5 py-0.5">
  const example = true;
</code>
```

### Font Combinations

Pay attention to how different font weights and sizes are used together:

- **Headings**: Bold (700) or Semibold (600) with larger sizes
- **Body**: Normal (400) or Medium (500) at base size
- **Labels**: Medium (500) or Semibold (600) at small size
- **Captions**: Normal (400) at extra small size with muted color

---

## Spacing System

### Base Spacing Scale

Tailwind's spacing scale is based on `0.25rem` (4px) increments:

```css
0:    0px
0.5:  2px   (0.125rem)
1:    4px   (0.25rem)
1.5:  6px   (0.375rem)
2:    8px   (0.5rem)
2.5:  10px  (0.625rem)
3:    12px  (0.75rem)
3.5:  14px  (0.875rem)
4:    16px  (1rem)
5:    20px  (1.25rem)
6:    24px  (1.5rem)
8:    32px  (2rem)
10:   40px  (2.5rem)
12:   48px  (3rem)
16:   64px  (4rem)
20:   80px  (5rem)
24:   96px  (6rem)
```

### Common Spacing Patterns

```tsx
// Component padding
<div className="p-4">          {/* 16px all sides */}
<div className="px-4 py-2">    {/* 16px horizontal, 8px vertical */}
<div className="p-3 md:p-4">  {/* Responsive padding */}

// Component margins
<div className="mb-4">         {/* 16px bottom margin */}
<div className="space-y-4">    {/* 16px vertical spacing between children */}
<div className="gap-4">        {/* 16px gap in flex/grid */}

// Layout spacing
<div className="container mx-auto px-4">  {/* Centered container with padding */}
<div className="max-w-7xl mx-auto">       {/* Max width container */}
```

### Spacing Guidelines

- **Tight spacing** (2-3): Related elements within a component
- **Normal spacing** (4-6): Between components or sections
- **Loose spacing** (8-12): Between major sections or page elements
- **Extra loose** (16-24): Between page sections or hero elements

---

## Component Styles

### Buttons

```tsx
// Primary Button (uses accent color)
<button className="bg-primary text-primary-foreground hover:bg-primary/90
                   px-4 py-2 font-medium transition-colors">
  Primary Action
</button>

// Secondary Button
<button className="bg-secondary text-secondary-foreground hover:bg-secondary/80
                   px-4 py-2 font-medium transition-colors">
  Secondary Action
</button>

// Outline Button
<button className="border border-input bg-background hover:bg-accent
                   hover:text-accent-foreground px-4 py-2
                   font-medium transition-colors">
  Outline Button
</button>

// Ghost Button
<button className="hover:bg-accent hover:text-accent-foreground
                   px-4 py-2 font-medium transition-colors">
  Ghost Button
</button>

// Icon Button
<button className="h-10 w-10 hover:bg-accent flex items-center
                   justify-center transition-colors">
  <Icon className="h-4 w-4" />
</button>
```

### Cards

```tsx
// Basic Card (no border radius)
<div className="border border-border bg-card text-card-foreground
                shadow-sm p-6">
  <h3 className="text-lg font-semibold mb-2">Card Title</h3>
  <p className="text-sm text-muted-foreground">Card content</p>
</div>

// Interactive Card
<div className="border border-border bg-card hover:bg-accent
                shadow-sm p-6 transition-colors cursor-pointer">
  Card content
</div>

// Themed Card
<div className="border border-primary/30 bg-primary/10
                text-foreground p-4">
  Themed with accent color
</div>
```

### Input Fields

```tsx
// Text Input
<input
  type="text"
  className="flex h-10 w-full border border-input
             bg-background px-3 py-2 text-sm ring-offset-background
             file:border-0 file:bg-transparent file:text-sm file:font-medium
             placeholder:text-muted-foreground focus-visible:outline-none
             focus-visible:ring-2 focus-visible:ring-ring
             focus-visible:ring-offset-2 disabled:cursor-not-allowed
             disabled:opacity-50"
  placeholder="Enter text..."
/>

// Textarea
<textarea
  className="flex min-h-[80px] w-full border border-input
             bg-background px-3 py-2 text-sm ring-offset-background
             placeholder:text-muted-foreground focus-visible:outline-none
             focus-visible:ring-2 focus-visible:ring-ring
             focus-visible:ring-offset-2 disabled:cursor-not-allowed
             disabled:opacity-50"
  placeholder="Enter text..."
/>
```

### Badges

```tsx
// Default Badge (fully rounded)
<span className="inline-flex items-center rounded-full border px-2.5 py-0.5
                 text-xs font-semibold transition-colors focus:outline-none
                 focus:ring-2 focus:ring-ring focus:ring-offset-2">
  Badge
</span>

// Status Badges
<span className="rounded-full bg-success/10 text-success border-success/20">Success</span>
<span className="rounded-full bg-destructive/10 text-destructive border-destructive/20">Error</span>
<span className="rounded-full bg-warning/10 text-warning border-warning/20">Warning</span>

// Themed Badge
<span className="rounded-full bg-primary/10 text-primary border-primary/20">
  Themed
</span>
```

---

## Shadows & Elevation

### Shadow Scale

```css
shadow-sm:   0 1px 2px 0 rgb(0 0 0 / 0.05)
shadow:      0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)
shadow-md:   0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)
shadow-lg:   0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)
shadow-xl:   0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)
shadow-2xl:  0 25px 50px -12px rgb(0 0 0 / 0.25)
```

### Shadow Usage in Scrapalot

**Important:** Scrapalot UI **prefers borders over shadows** for most components, especially in dark mode. Shadows are used sparingly for floating elements.

```tsx
// Preferred: Borders for definition
<div className="border border-border bg-card">
  Card with border (no shadow)
</div>

// Subtle elevation with border and minimal shadow
<div className="border border-border shadow-sm">
  Subtle elevation
</div>

// Dark mode: Always prefer borders
<div className="border border-border shadow-sm dark:shadow-none">
  Adaptive elevation
</div>

// Floating elements (modals, popovers) - use shadows
<div className="shadow-lg border border-border">
  Floating element
</div>
```

### Elevation Guidelines

```tsx
// Level 0 - Flat (borders only)
<div className="border border-border bg-background">Base level</div>

// Level 1 - Subtle (cards, inputs)
<div className="border border-border shadow-sm">Subtle elevation</div>

// Level 2 - Raised (dropdowns)
<div className="border border-border shadow-md">Raised element</div>

// Level 3 - Floating (modals, popovers)
<div className="border border-border shadow-lg">Floating element</div>

// Level 4 - Overlay (dialogs, sheets)
<div className="border border-border shadow-xl">Overlay element</div>
```

---

## Animations & Transitions

### Transition Utilities

```css
transition-none:     transition-property: none;
transition-all:      transition-property: all;
transition-colors:   transition-property: color, background-color, border-color;
transition-opacity:  transition-property: opacity;
transition-transform: transition-property: transform;

duration-75:   75ms
duration-100:  100ms
duration-150:  150ms
duration-200:  200ms
duration-300:  300ms
duration-500:  500ms
duration-700:  700ms
duration-1000: 1000ms
```

### Common CSS Animations

```tsx
// Hover transitions
<button className="transition-colors duration-200 hover:bg-accent">
  Smooth color transition
</button>

// Fade in/out
<div className="transition-opacity duration-300 opacity-0 hover:opacity-100">
  Fade effect
</div>

// Scale on hover
<div className="transition-transform duration-200 hover:scale-105">
  Subtle scale
</div>
```

### Custom CSS Animations

```css
/* In globals.css */
@keyframes slide-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.animate-slide-in {
  animation: slide-in 0.3s ease-out;
}

/* Pulse animation for loading states */
@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.animate-pulse {
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

/* Shimmer effect for progress bars */
@keyframes shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

.animate-shimmer {
  animation: shimmer 2s infinite;
}
```

### Animation Guidelines

- **Subtle**: Use for micro-interactions (hover states, focus)
- **Duration**: 150-300ms for most UI transitions
- **Easing**: `ease-out` for entrances, `ease-in` for exits
- **Performance**: Prefer `transform` and `opacity` for smooth 60fps animations
- **Accessibility**: Respect `prefers-reduced-motion` media query

---

## Framer Motion Animations

Scrapalot UI uses **Framer Motion** for advanced animations and smooth micro-interactions. Framer Motion provides GPU-accelerated animations and automatically respects `prefers-reduced-motion`.

### Installation

```bash
npm install framer-motion
```

### Basic Usage

```tsx
import { motion } from 'framer-motion';

// Fade in on mount
<motion.div
  initial={{ opacity: 0, y: 10 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.3, ease: "easeOut" }}
>
  Content fades in
</motion.div>

// Hover animations
<motion.button
  whileHover={{ scale: 1.05 }}
  whileTap={{ scale: 0.95 }}
  transition={{ duration: 0.2 }}
  className="bg-primary text-primary-foreground px-4 py-2"
>
  Interactive button
</motion.button>
```

### Sequential/Staggered Animations

Use staggered animations to reveal lists progressively:

```tsx
// Stagger children animations
{items.map((item, index) => (
  <motion.div
    key={item.id}
    initial={{ opacity: 0, x: -10 }}
    animate={{ opacity: 1, x: 0 }}
    transition={{
      duration: 0.3,
      delay: index * 0.05, // 50ms stagger between items
      ease: "easeOut"
    }}
  >
    {item.content}
  </motion.div>
))}
```

**Stagger timing guidelines:**
- **40-50ms**: Fast, snappy lists
- **50-60ms**: Standard timing (recommended)
- **80-100ms**: Slower, more deliberate

### AnimatePresence for Exit Animations

Use `AnimatePresence` for smooth mount/unmount animations:

```tsx
import { motion, AnimatePresence } from 'framer-motion';

<AnimatePresence>
  {isOpen && (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: "easeInOut" }}
      className="overflow-hidden"
    >
      Collapsible content
    </motion.div>
  )}
</AnimatePresence>
```

### Micro-interactions

Small animations that enhance user feedback:

```tsx
// Icon animations on hover
<motion.div
  whileHover={{ scale: 1.1, rotate: 5 }}
  transition={{ duration: 0.2 }}
>
  <Icon className="h-4 w-4 text-primary" />
</motion.div>

// Scale animation on value change
<motion.span
  key={value} // Re-animate on value change
  initial={{ scale: 1.2 }}
  animate={{ scale: 1 }}
  transition={{ duration: 0.3 }}
  className="text-sm font-bold text-primary"
>
  {value}%
</motion.span>

// Rotating element
<motion.div
  animate={{ rotate: [0, 360] }}
  transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
>
  <LoadingIcon />
</motion.div>
```

### Chevron Rotation (Collapsible Headers)

Standard pattern for collapsible sections:

```tsx
<motion.div
  animate={{ rotate: isExpanded ? 0 : -90 }}
  transition={{ duration: 0.2 }}
>
  <ChevronDown className="h-4 w-4" />
</motion.div>
```

### Progress Animations

Animated progress bars with smooth transitions:

```tsx
<div className="h-2 bg-primary/20 overflow-hidden">
  <motion.div
    initial={{ width: 0 }}
    animate={{ width: `${progress}%` }}
    transition={{ duration: 0.5, ease: "easeOut" }}
    className="h-full bg-gradient-to-r from-primary to-primary/80 relative"
  >
    {/* Shimmer effect */}
    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer" />
  </motion.div>
</div>
```

### Animation Best Practices

- **Duration**:
  - 150-200ms for micro-interactions (hover, icon animations)
  - 200-300ms for UI transitions (modals, drawers)
  - 300-500ms for complex animations (page transitions)
  - 20s+ for ambient animations (rotating icons, background effects)

- **Easing**:
  - `easeOut` for entrances (things appearing)
  - `easeIn` for exits (things disappearing)
  - `easeInOut` for height/width changes
  - `linear` for continuous animations (rotation, shimmer)

- **Stagger**: 40-60ms delay between sequential items

- **Performance**: Framer Motion only animates `transform` and `opacity` by default (GPU-accelerated)

- **Accessibility**: Framer Motion automatically respects `prefers-reduced-motion` - no extra code needed

### Common Patterns

```tsx
// Slide on hover
<motion.button
  whileHover={{ x: 2 }}
  transition={{ duration: 0.2 }}
  className="w-full flex items-center justify-between p-3"
>
  Button content
</motion.button>

// Fade and scale
<motion.div
  initial={{ opacity: 0, scale: 0.95 }}
  animate={{ opacity: 1, scale: 1 }}
  transition={{ duration: 0.4, ease: "easeOut" }}
>
  Content
</motion.div>

// Staggered fade in list
{items.map((item, i) => (
  <motion.div
    key={item.id}
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.3, delay: i * 0.05 }}
  >
    {item.content}
  </motion.div>
))}
```

---

## Border Radius

### Design Direction

Scrapalot UI uses a **sharp, geometric design aesthetic** with **minimal border radius** on most components. This creates a modern, structured appearance that emphasizes clarity and precision.

### Radius Scale

```css
rounded-none:  0px           - Sharp corners (default for most components)
rounded-sm:    0.125rem  (2px) - Rarely used
rounded:       0.25rem   (4px) - Rarely used
rounded-md:    0.375rem  (6px) - Rarely used
rounded-lg:    0.5rem    (8px) - Rarely used
rounded-xl:    0.75rem   (12px) - Rarely used
rounded-2xl:   1rem      (16px) - Rarely used
rounded-3xl:   1.5rem    (24px) - Rarely used
rounded-full:  9999px         - Circular elements only
```

### Usage Guidelines

**Default: No Border Radius**

Most components use **sharp corners** (no `rounded-*` classes):

```tsx
// Buttons - sharp corners
<button className="bg-primary text-primary-foreground px-4 py-2">
  Sharp button
</button>

// Cards - sharp corners
<div className="border border-border bg-card p-6">
  Sharp card
</div>

// Input fields - sharp corners
<input className="border border-input bg-background px-3 py-2" />

// Containers - sharp corners
<div className="bg-muted p-4">
  Sharp container
</div>
```

**Exception: Fully Rounded Elements**

Use `rounded-full` for circular/pill-shaped elements:

```tsx
// Avatars
<img src="avatar.jpg" className="rounded-full w-10 h-10" />

// Status indicators and dots
<div className="w-2 h-2 rounded-full bg-primary" />

// Badge pills
<span className="rounded-full bg-primary/10 text-primary px-2.5 py-0.5">
  Badge
</span>

// Circular buttons
<button className="rounded-full w-10 h-10 flex items-center justify-center">
  <Icon />
</button>
```

### When to Use Round vs Sharp

| Element | Border Radius | Reasoning |
|---------|--------------|-----------|
| Buttons | `none` | Sharp, clear call-to-action |
| Cards | `none` | Geometric, structured layout |
| Inputs | `none` | Consistent with overall aesthetic |
| Modals | `none` | Sharp, focused attention |
| Dropdowns | `none` | Clean, precise |
| Avatars | `rounded-full` | Traditional circular avatars |
| Badges | `rounded-full` | Pill-shaped, compact |
| Status dots | `rounded-full` | Circular indicators |
| Progress circles | `rounded-full` | Circular by nature |

### Border Radius Best Practices

- **Default to sharp** - No border radius unless there's a specific reason
- **Fully rounded only** - If using border radius, go `rounded-full` (not `rounded-md`, `rounded-lg`)
- **Consistency** - Never mix rounded and sharp variants of the same component
- **Exceptions** - Only avatars, badges, dots, and circular UI elements get `rounded-full`

---

## Opacity & Transparency

### Opacity Scale

```css
opacity-0:    0
opacity-5:    0.05
opacity-10:   0.1
opacity-20:   0.2
opacity-25:   0.25
opacity-30:   0.3
opacity-40:   0.4
opacity-50:   0.5
opacity-60:   0.6
opacity-70:   0.7
opacity-75:   0.75
opacity-80:   0.8
opacity-90:   0.9
opacity-95:   0.95
opacity-100:  1
```

### Color Opacity Modifiers

```tsx
// Background with opacity (adapts to accent color)
<div className="bg-primary/5">5% opacity primary background</div>
<div className="bg-primary/10">10% opacity (subtle cards)</div>
<div className="bg-primary/20">20% opacity (medium emphasis)</div>

// Black/white overlays
<div className="bg-black/50">50% opacity black overlay</div>
<div className="bg-white/95">95% opacity white backdrop</div>

// Text with opacity
<span className="text-foreground/70">70% opacity text</span>
<span className="text-muted-foreground">Muted text color</span>

// Border with opacity
<div className="border border-border/50">50% opacity border</div>
<div className="border border-primary/30">30% opacity themed border</div>

// Hover states with opacity
<button className="hover:bg-primary/90">
  Slightly transparent on hover
</button>
```

### Common Opacity Patterns

```tsx
// Disabled states
<button disabled className="opacity-50 cursor-not-allowed">
  Disabled Button
</button>

// Loading states
<div className="opacity-60 pointer-events-none">
  Loading content...
</div>

// Modal overlays
<div className="fixed inset-0 bg-black/80 backdrop-blur-sm">
  Modal overlay
</div>

// Subtle backgrounds (use with accent color)
<div className="bg-primary/5">Very subtle accent background</div>
<div className="bg-accent/50">Subtle accent background</div>

// Header/drawer backgrounds
<div className="bg-background/95 backdrop-blur-sm">
  Translucent header
</div>
```

### Opacity Usage Guidelines

- **Backgrounds**: `/5` to `/20` for subtle themed backgrounds
- **Borders**: `/30` to `/50` for soft borders
- **Overlays**: `/80` to `/95` for modal backdrops
- **Text**: Use `text-muted-foreground` instead of opacity on foreground color
- **Disabled**: `opacity-50` is standard for disabled states

---

## Gradient Backgrounds

Subtle gradients add depth and visual interest while maintaining the clean aesthetic.

### Subtle Gradients with Accent Color

```tsx
// Card with gradient (adapts to accent color)
<div className="bg-gradient-to-br from-primary/15 via-primary/10 to-primary/5
                border border-primary/30 p-4">
  Subtle gradient background
</div>

// Directional gradients
<div className="bg-gradient-to-r from-primary/10 to-transparent">
  Left to right fade
</div>

<div className="bg-gradient-to-b from-primary/5 to-primary/10">
  Top to bottom gradient
</div>
```

### Radial Gradients for Depth

Use radial gradients for ambient depth effects:

```tsx
<div className="relative p-4">
  {/* Radial gradient background layer */}
  <div className="absolute inset-0 opacity-20">
    <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_120%,hsl(var(--primary)),transparent)]" />
  </div>

  {/* Content layer */}
  <div className="relative">
    Content with depth effect
  </div>
</div>
```

### Progress Bar Gradients

```tsx
<div className="h-2 bg-primary/20 overflow-hidden">
  <div className="h-full bg-gradient-to-r from-primary to-primary/80"
       style={{ width: `${progress}%` }}>
  </div>
</div>
```

### Multi-stop Gradients

```tsx
// Three-color gradient
<div className="bg-gradient-to-br from-primary/15 via-primary/10 to-primary/5">
  Multi-stop gradient
</div>

// Complex gradient for hero sections
<div className="bg-gradient-to-br from-background via-primary/5 to-background">
  Subtle center accent
</div>
```

### Gradient Best Practices

- **Subtle opacity**: Keep gradients at `/5` to `/20` opacity for subtlety
- **Use primary color**: Gradients should use `primary` to adapt to accent color
- **Limit stops**: 2-3 color stops maximum
- **Purposeful**: Use for emphasis, not decoration
- **Test all accents**: Gradients should look good with all 6 accent colors

---

## Modern Component Patterns

Common UI patterns used throughout Scrapalot UI.

### Collapsible Sections

Standard pattern for expandable/collapsible content:

```tsx
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';

const [expanded, setExpanded] = useState(true);

<div className="border border-border">
  {/* Header */}
  <motion.button
    onClick={() => setExpanded(!expanded)}
    className="w-full flex items-center justify-between p-3 hover:bg-muted/50
               transition-colors group"
    whileHover={{ x: 2 }}
    transition={{ duration: 0.2 }}
  >
    <div className="flex items-center gap-2">
      <motion.div
        whileHover={{ scale: 1.1, rotate: 5 }}
        transition={{ duration: 0.2 }}
      >
        <Icon className="h-4 w-4 text-primary" />
      </motion.div>
      <span className="text-sm font-medium text-foreground
                       group-hover:text-primary transition-colors">
        Section Title
      </span>
    </div>

    {/* Animated chevron */}
    <motion.div
      animate={{ rotate: expanded ? 0 : -90 }}
      transition={{ duration: 0.2 }}
    >
      <ChevronDown className="h-4 w-4 text-muted-foreground" />
    </motion.div>
  </motion.button>

  {/* Collapsible content */}
  <AnimatePresence>
    {expanded && (
      <motion.div
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: "auto", opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ duration: 0.2, ease: "easeInOut" }}
        className="overflow-hidden"
      >
        <div className="p-3">
          Collapsible content goes here
        </div>
      </motion.div>
    )}
  </AnimatePresence>
</div>
```

### Loading Skeletons

Skeleton screens for loading states:

```tsx
// Basic skeleton
<div className="space-y-4 animate-pulse">
  <div className="h-4 bg-muted w-3/4" />
  <div className="h-3 bg-muted w-5/6" />
  <div className="h-3 bg-muted w-4/6" />
</div>

// Card skeleton
<div className="border border-border p-6 space-y-4 animate-pulse">
  <div className="flex items-center gap-3">
    <div className="w-12 h-12 bg-muted" />
    <div className="flex-1 space-y-2">
      <div className="h-4 bg-muted w-3/4" />
      <div className="h-3 bg-muted/60 w-1/2" />
    </div>
  </div>
  <div className="space-y-2">
    <div className="h-3 bg-muted w-full" />
    <div className="h-3 bg-muted w-5/6" />
  </div>
</div>
```

### Progress Bars with Shimmer

Animated progress indicators:

```tsx
<div className="h-2 bg-primary/20 overflow-hidden border border-primary/20">
  <motion.div
    initial={{ width: 0 }}
    animate={{ width: `${progress}%` }}
    transition={{ duration: 0.5, ease: "easeOut" }}
    className="h-full bg-gradient-to-r from-primary to-primary/80 relative"
  >
    {/* Shimmer effect */}
    <div className="absolute inset-0 bg-gradient-to-r from-transparent
                    via-white/30 to-transparent animate-shimmer" />
  </motion.div>
</div>

{/* Add CSS for shimmer */}
<style>{`
  @keyframes shimmer {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }
  .animate-shimmer {
    animation: shimmer 2s infinite;
  }
`}</style>
```

### Stat Cards with Hover Animation

Interactive stat cards:

```tsx
<motion.div
  className="flex items-center gap-2 group cursor-default"
  whileHover={{ scale: 1.05 }}
  transition={{ duration: 0.2 }}
>
  <div className="p-1.5 bg-primary/10 group-hover:bg-primary/20 transition-colors">
    <Icon className="h-3.5 w-3.5 text-primary" />
  </div>
  <div className="flex flex-col">
    <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
      Label
    </span>
    <span className="font-semibold text-foreground">
      42
    </span>
  </div>
</motion.div>
```

### Timeline Components

Vertical timeline with connector line:

```tsx
{items.map((item, index) => (
  <motion.div
    key={item.id}
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.3, delay: index * 0.05 }}
    className="flex gap-3 group"
  >
    {/* Timeline connector */}
    <div className="flex flex-col items-center">
      <div className="w-7 h-7 border-2 border-primary bg-background
                      flex items-center justify-center transition-all
                      group-hover:scale-110">
        <Icon className="h-3.5 w-3.5 text-primary" />
      </div>
      {!isLast && (
        <div className="w-0.5 h-full min-h-[20px]
                        bg-gradient-to-b from-primary/30 to-muted" />
      )}
    </div>

    {/* Content */}
    <div className="flex-1 pb-4">
      <p className="text-sm font-medium">{item.title}</p>
      <p className="text-xs text-muted-foreground">{item.description}</p>
    </div>
  </motion.div>
))}
```

### Empty States

Friendly empty states with icons:

```tsx
<div className="flex flex-col items-center justify-center py-12 px-4">
  <div className="w-16 h-16 bg-muted/50 flex items-center justify-center mb-4">
    <Icon className="h-8 w-8 text-muted-foreground" />
  </div>
  <p className="text-sm font-medium text-foreground mb-1">
    No items yet
  </p>
  <p className="text-xs text-muted-foreground text-center max-w-xs">
    Get started by creating your first item
  </p>
</div>
```

### Pulsating Dot Indicator

Animated status indicator:

```tsx
const PulsatingDot = ({ color = 'primary', size = 'sm' }) => {
  const sizeClasses = {
    sm: 'w-2 h-2',
    md: 'w-3 h-3',
    lg: 'w-4 h-4'
  };

  return (
    <span className="relative flex">
      <span className={`animate-ping absolute inline-flex h-full w-full
                        opacity-75 bg-${color}`} />
      <span className={`relative inline-flex ${sizeClasses[size]} bg-${color}`} />
    </span>
  );
};

// Usage
<PulsatingDot color="primary" size="md" />
```

### Circular Progress Indicator

Custom circular progress:

```tsx
const CircularProgress = ({ progress, size = 48, strokeWidth = 4 }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (progress * circumference);

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg className="transform -rotate-90" width={size} height={size}>
        <circle
          className="text-muted"
          strokeWidth={strokeWidth}
          stroke="currentColor"
          fill="transparent"
          r={radius}
          cx={size / 2}
          cy={size / 2}
        />
        <circle
          className="text-primary transition-all duration-500 ease-out"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          stroke="currentColor"
          fill="transparent"
          r={radius}
          cx={size / 2}
          cy={size / 2}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs font-semibold text-primary">
          {Math.round(progress * 100)}%
        </span>
      </div>
    </div>
  );
};

// Usage
<CircularProgress progress={0.75} size={48} strokeWidth={4} />
```

---

## Common Tailwind CSS Usage

### Layout Patterns

```tsx
// Flex layouts
<div className="flex items-center justify-between">
  <span>Left</span>
  <span>Right</span>
</div>

<div className="flex flex-col gap-4">
  <div>Item 1</div>
  <div>Item 2</div>
</div>

// Grid layouts
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
  {items.map(item => <Card key={item.id} />)}
</div>

// Centering
<div className="flex items-center justify-center min-h-screen">
  <div>Centered content</div>
</div>
```

### Responsive Design

```tsx
// Mobile-first responsive classes
<div className="text-sm md:text-base lg:text-lg">
  Responsive text size
</div>

<div className="px-4 md:px-6 lg:px-8">
  Responsive padding
</div>

<div className="hidden md:block">
  Hidden on mobile, visible on tablet+
</div>

<div className="block md:hidden">
  Visible on mobile only
</div>

// Responsive flex direction
<div className="flex flex-col md:flex-row gap-4">
  Stacks on mobile, row on desktop
</div>
```

### Dark Mode

```tsx
// Theme-aware styling (using semantic variables is preferred)
<div className="bg-background text-foreground">
  Automatically adapts
</div>

// Explicit dark mode classes (use sparingly)
<div className="bg-white dark:bg-zinc-900 text-black dark:text-white">
  Explicit dark mode
</div>

<button className="bg-zinc-100 hover:bg-zinc-200
                   dark:bg-zinc-800 dark:hover:bg-zinc-700">
  Theme-aware button
</button>
```

### Utility Combinations

```tsx
// Truncate text
<p className="truncate max-w-xs">
  Long text that will be truncated with ellipsis...
</p>

// Line clamp
<p className="line-clamp-3">
  Multi-line text that will be clamped to 3 lines...
</p>

// Scrollable container
<div className="overflow-y-auto max-h-96">
  Scrollable content
</div>

// Sticky positioning
<header className="sticky top-0 z-50 bg-background/95 backdrop-blur-sm border-b">
  Sticky header
</header>

// Absolute positioning
<div className="relative">
  <div className="absolute top-2 right-2">
    Positioned element
  </div>
</div>
```

---

## Example Component Reference

### Enhanced Chat Message Component

```tsx
import React from 'react';
import { User } from 'lucide-react';
import { motion } from 'framer-motion';

interface ChatMessageProps {
  message: string;
  isUser: boolean;
  timestamp: string;
}

export function ChatMessage({ message, isUser, timestamp }: ChatMessageProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={`px-4 py-4 flex flex-col transition-colors ${
        isUser
          ? 'bg-zinc-100 dark:bg-zinc-900'
          : 'bg-white dark:bg-transparent'
      }`}
    >
      <div className="flex space-x-4">
        {/* Avatar */}
        <div className="flex-shrink-0 pt-1">
          {isUser ? (
            <div className="h-7 w-7 rounded-full flex items-center justify-center
                            bg-zinc-200 dark:bg-zinc-800">
              <User className="h-4 w-4" />
            </div>
          ) : (
            <div className="h-7 w-7 rounded-full bg-primary flex items-center
                            justify-center">
              <span className="text-xs font-semibold text-primary-foreground">
                AI
              </span>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 space-y-2 overflow-hidden">
          {/* Header */}
          <div className="flex items-center">
            <h3 className="font-semibold text-sm">
              {isUser ? 'You' : 'AI Assistant'}
            </h3>
            <span className="text-xs text-muted-foreground ml-2">
              {timestamp}
            </span>
          </div>

          {/* Message */}
          <div className="prose dark:prose-invert prose-sm max-w-none">
            <p className="leading-relaxed">{message}</p>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2">
            <button
              className="text-xs text-muted-foreground hover:text-foreground
                         transition-colors"
            >
              Copy
            </button>
            <button
              className="text-xs text-muted-foreground hover:text-foreground
                         transition-colors"
            >
              Edit
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
```

### Enhanced Button Component

```tsx
import React from 'react';
import { motion } from 'framer-motion';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center text-sm font-medium ' +
  'ring-offset-background transition-colors focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 px-3',
        lg: 'h-11 px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asMotion?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asMotion = false,
  ...props
}: ButtonProps) {
  const classes = buttonVariants({ variant, size, className });

  if (asMotion) {
    return (
      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        transition={{ duration: 0.2 }}
        className={classes}
        {...props}
      />
    );
  }

  return (
    <button
      className={classes}
      {...props}
    />
  );
}
```

### Enhanced Card Component

```tsx
import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface CardProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  themed?: boolean;
  interactive?: boolean;
}

export function Card({
  title,
  description,
  children,
  className = '',
  themed = false,
  interactive = false,
}: CardProps) {
  const baseClasses = cn(
    "border overflow-hidden transition-shadow",
    themed
      ? "bg-primary/10 border-primary/30 text-foreground"
      : "bg-card border-border text-card-foreground shadow-sm",
    interactive && "cursor-pointer hover:shadow-md",
    className
  );

  const Wrapper = interactive ? motion.div : 'div';
  const motionProps = interactive ? {
    whileHover: { y: -2 },
    transition: { duration: 0.2 }
  } : {};

  return (
    <Wrapper className={baseClasses} {...motionProps}>
      {(title || description) && (
        <div className="p-6 pb-4">
          {title && (
            <h3 className="text-lg font-semibold leading-none tracking-tight">
              {title}
            </h3>
          )}
          {description && (
            <p className="text-sm text-muted-foreground mt-1.5">
              {description}
            </p>
          )}
        </div>
      )}
      <div className="p-6 pt-0">{children}</div>
    </Wrapper>
  );
}
```

---

## Portal Containers & Drawer Management

### Problem: insertBefore DOM Errors

When using React portals with Radix UI components (Dialog, DropdownMenu, Select), you may encounter intermittent errors:

```
Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.
```

This occurs when multiple portals try to manipulate `document.body` simultaneously, creating race conditions between:
- Outer portals (global drawers rendering via `createPortal`)
- Inner portals (Radix UI components creating their own portals)
- React reconciliation trying to update the DOM

### Solution: Dedicated Portal Containers

Instead of rendering directly to `document.body`, create a **dedicated, stable container** for each global drawer/portal:

```tsx
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export const GlobalNotesDrawer: React.FC = () => {
  const notesDrawer = useNotesDrawer();
  const portalContainerRef = useRef<HTMLDivElement | null>(null);

  // Create a stable, dedicated portal container to prevent insertBefore errors
  // that occur when multiple portals compete for document.body
  useEffect(() => {
    if (!portalContainerRef.current) {
      const container = document.createElement('div');
      container.id = 'notes-drawer-portal';
      container.style.position = 'relative';
      container.style.zIndex = '50'; // Match drawer z-index
      document.body.appendChild(container);
      portalContainerRef.current = container;
    }

    return () => {
      if (portalContainerRef.current) {
        document.body.removeChild(portalContainerRef.current);
        portalContainerRef.current = null;
      }
    };
  }, []);

  // Don't render until container is ready
  if (!portalContainerRef.current) {
    return null;
  }

  // Render through Portal to dedicated container to prevent DOM conflicts
  // This avoids insertBefore errors from nested Radix UI portals
  return createPortal(
    <NotesDrawer
      isOpen={notesDrawer.isOpen}
      onClose={notesDrawer.close}
      sessionId={notesDrawer.sessionId}
      noteId={notesDrawer.noteId}
    />,
    portalContainerRef.current
  );
};
```

### Key Points

1. **Unique container IDs**: Each drawer gets its own container (`notes-drawer-portal`, `pdf-viewer-portal`, `epub-viewer-portal`)
2. **Lifecycle management**: Container created on mount, cleaned up on unmount
3. **Null check**: Return `null` until container is ready to prevent race conditions
4. **useRef stability**: Ref keeps container reference stable across renders
5. **No direct document.body**: Portals render to dedicated containers, not `document.body`

### When to Use

Use dedicated portal containers for:
- Global drawers (Notes, PDF viewer, EPUB viewer)
- Any component that creates a portal AND contains Radix UI components
- Components experiencing intermittent `insertBefore` errors

Don't use for:
- Simple components without nested portals
- Components that don't use `createPortal`
- Regular dialog/modal components (handled by Radix)

---

## Glassmorphism & Backdrop Blur

Scrapalot UI uses **glassmorphism** effects for modal dialogs and overlays to create a modern, layered aesthetic with translucent backgrounds and blur effects.

### Standard Glassmorphism Pattern

Used in dialogs, connection-lost alerts, and floating panels:

```tsx
// Dialog with glassmorphism
<DialogPrimitive.Content
  className={cn(
    "fixed grid gap-4 border shadow-lg duration-200",
    "bg-white/30 dark:bg-white/10 backdrop-blur-xl",
    "border-zinc-300/10 dark:border-zinc-700/10",
    // ... other positioning classes
  )}
>
  Dialog content
</DialogPrimitive.Content>
```

### Glassmorphism Values

| Property | Light Mode | Dark Mode | Purpose |
|----------|-----------|-----------|---------|
| Background | `bg-white/30` | `bg-white/10` | Semi-transparent white |
| Backdrop Blur | `backdrop-blur-xl` | `backdrop-blur-xl` | Strong blur (24px) |
| Border | `border-zinc-300/10` | `border-zinc-700/10` | Subtle border |

### Opacity Guidelines for Glassmorphism

- **Light mode**: Use `/30` (30%) opacity for balanced translucency
- **Dark mode**: Use `/10` (10%) opacity for subtlety without washing out
- **Backdrop blur**: Always use `backdrop-blur-xl` (24px) for strongest effect
- **Borders**: Use `/10` opacity on borders for soft edges

### Layered Glassmorphism

For components with multiple sections (sidebar, header, footer, content):

```tsx
// Drawer with layered glassmorphism sections
<div className="bg-white/98 dark:bg-zinc-950/98 backdrop-blur-xl">
  {/* Sidebar - strongest opacity */}
  <div className="bg-white/95 dark:bg-zinc-950/95 backdrop-blur-xl border-r border-zinc-200/20 dark:border-zinc-700/20">
    Sidebar
  </div>

  {/* Header - medium opacity */}
  <div className="bg-white/80 dark:bg-zinc-950/80 backdrop-blur-xl border-b border-zinc-200/20 dark:border-zinc-700/20">
    Header
  </div>

  {/* Content area - lightest opacity */}
  <div className="bg-white/60 dark:bg-zinc-950/60 backdrop-blur-md">
    Content
  </div>
</div>
```

### When to Use Glassmorphism

**Use for**:
- Modal dialogs and alerts
- Floating panels and popovers
- Connection status indicators
- Overlay UI elements
- Sections within drawers/sheets

**Don't use for**:
- Standard cards and containers (use solid backgrounds)
- Main page backgrounds (performance impact)
- Text-heavy content (readability issues)
- Elements without sufficient contrast

### Performance Considerations

- `backdrop-blur` is GPU-intensive - use sparingly
- Limit to modal/overlay elements that appear briefly
- Avoid on scrolling containers or frequently updated elements
- Test on lower-end devices

---

## Inline Styles for Standalone Components

Some utility components (like admin debug tools) use **inline styles** instead of Tailwind classes for portability and to avoid class conflicts.

### When to Use Inline Styles

Use inline styles for:
- Standalone utility components injected into DOM
- Development/debugging tools not part of main UI
- Components that need to work without Tailwind context
- High z-index overlays that can't rely on CSS cascade

### Modern Inline Style Patterns

```tsx
// Gradient background with border accent
const container = `
  <div style="
    margin-bottom: 16px;
    background: linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 100%);
    border: 1px solid #333;
    padding: 14px;
    position: relative;
  ">
    <div style="
      position: absolute;
      top: 0;
      left: 0;
      width: 3px;
      height: 100%;
      background: linear-gradient(180deg, #3b82f6 0%, #8b5cf6 100%);
    "></div>
    Content
  </div>
`;

// Button with hover effects (via onmouseover/onmouseout)
const button = `
  <button
    style="
      padding: 10px 20px;
      border-radius: 6px;
      border: none;
      background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
      color: #fff;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      transition: all 0.2s;
      box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4);
    "
    onmouseover="
      this.style.background='linear-gradient(135deg, #b91c1c 0%, #991b1b 100%)';
      this.style.transform='translateY(-2px)';
      this.style.boxShadow='0 6px 16px rgba(220, 38, 38, 0.5)';
    "
    onmouseout="
      this.style.background='linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)';
      this.style.transform='translateY(0)';
      this.style.boxShadow='0 4px 12px rgba(220, 38, 38, 0.4)';
    "
  >
    Button
  </button>
`;
```

### Inline Style Best Practices

1. **Use CSS variables when possible**: For colors that might change
2. **Include transitions**: For smooth state changes
3. **Use onmouseover/onmouseout**: For hover effects in HTML strings
4. **Specify all units**: Don't rely on browser defaults (use `px`, `%`, etc.)
5. **Keep it minimal**: Only use when Tailwind isn't available
6. **Document why**: Comment why inline styles are needed

### Gradient Patterns for Inline Styles

```typescript
// Subtle background gradients
'background: linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 100%)'  // Dark gray
'background: linear-gradient(135deg, #1f1f1f 0%, #2a2a2a 100%)'  // Medium gray
'background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)'  // Red
'background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)'  // Blue to purple

// Accent border gradients
'background: linear-gradient(180deg, #3b82f6 0%, #8b5cf6 100%)'  // Vertical blue to purple
'background: linear-gradient(90deg, #10b981 0%, #059669 100%)'   // Horizontal green
```

---

## Best Practices

### Do's ✅

- **Use semantic color variables** (`bg-primary`, `text-foreground`) for automatic accent color adaptation
- **Follow the spacing scale** consistently (4, 8, 12, 16, 24px)
- **Use transitions** for interactive elements (buttons, links, cards)
- **Implement dark mode** support for all components using semantic variables
- **Keep components responsive** with mobile-first approach
- **Use borders over shadows** for most components
- **Use Framer Motion** for complex animations (sequential, collapsible, micro-interactions)
- **Leverage Tailwind utilities** before writing custom CSS
- **Default to sharp corners** - no border radius except for circular elements
- **Test with all accent colors** - Ensure components look good with all 6 themes
- **Use staggered animations** for lists (40-60ms delay)
- **Respect accessibility** - Framer Motion handles `prefers-reduced-motion` automatically
- **Use dedicated portal containers** - Prevent `insertBefore` errors with stable containers
- **Apply glassmorphism** to modals and overlays with `backdrop-blur-xl`
- **Use inline styles** only for standalone/utility components outside Tailwind context

### Don'ts ❌

- **Don't hardcode accent colors** - Use `bg-primary`, not `bg-violet-600` or `bg-blue-500`
- **Don't add border radius to standard components** - Use sharp corners (no `rounded-md`, `rounded-lg`)
- **Don't use arbitrary values excessively** - Prefer the spacing scale (e.g., `w-[347px]`)
- **Don't mix spacing units** - Stick to the spacing scale
- **Don't forget hover/focus states** on interactive elements
- **Don't ignore accessibility** - Ensure proper contrast and keyboard navigation
- **Don't create one-off styles** - Reuse existing patterns
- **Don't skip responsive design** - Test on all breakpoints
- **Don't use shadows without borders** - Combine or prefer borders alone
- **Don't skip Framer Motion** - Use Motion for complex animations instead of CSS
- **Don't mix rounded and sharp** - Never mix variants of the same component
- **Don't render portals directly to document.body** - Use dedicated portal containers
- **Don't overuse glassmorphism** - Only for modals/overlays, not main content
- **Don't use inline styles in regular components** - Reserve for standalone utilities only

---

## Resources

- [Shadcn Landing Page Template](https://github.com/leoMirandaa/shadcn-landing-page)
- [VitePress Home Page Config](https://vitepress.dev/reference/default-theme-home-page)
- [Framer Motion Variants](https://www.framer.com/motion/animation/)

### Documentation

- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [Framer Motion Documentation](https://www.framer.com/motion/)
- [shadcn/ui Components](https://ui.shadcn.com/)
- [Radix UI Primitives](https://www.radix-ui.com/)
- [Lucide Icons](https://lucide.dev/)
- [Class Variance Authority (CVA)](https://cva.style/docs)

### Tools

- [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) - VS Code extension
- [Tailwind Play](https://play.tailwindcss.com/) - Online playground
- [Color Palette Generator](https://uicolors.app/) - Generate color scales
- [HSL Color Picker](https://hslpicker.com/) - Pick HSL colors for theme variables

---

## Conclusion

This style guide serves as a living document for the Scrapalot UI project. As the design system evolves, this guide should be updated to reflect new patterns, components, and best practices.

**Key takeaways:**
- Sharp, geometric design with minimal border radius
- Dynamic accent color system with 6 themes
- Framer Motion for advanced animations
- Borders over shadows for clean aesthetics
- Semantic color variables for consistency and flexibility
- Modern component patterns for common UI needs
- Dedicated portal containers to prevent DOM errors
- Glassmorphism for modals and overlays (`backdrop-blur-xl`)
- Inline styles reserved for standalone utility components

Consistency is key to maintaining a professional and cohesive user interface.

For questions or suggestions regarding the style guide, please open an issue or submit a pull request.

---

**Last Updated**: March 2026
**Version**: 2.1.1
