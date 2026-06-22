/**
 * Shared utility functions for accent-color-based Tailwind classes.
 *
 * These helpers map the user's selected accent color to the appropriate
 * Tailwind border (and hover-border) classes so that every component
 * renders consistent accent styling.
 */

type AccentColor = 'gray' | 'blue' | 'green' | 'red' | 'violet' | 'orange';

// ── selected-state border classes (solid, visible border) ────────────
const SELECTED_BORDER: Record<AccentColor, string> = {
  gray: 'border-gray-600 dark:border-gray-400',
  blue: 'border-blue-600 dark:border-blue-400',
  green: 'border-green-600 dark:border-green-400',
  red: 'border-red-600 dark:border-red-400',
  violet: 'border-violet-600 dark:border-violet-400',
  orange: 'border-orange-600 dark:border-orange-400',
};

// ── hover-state border classes (transparent → colored on hover) ──────
const HOVER_BORDER: Record<AccentColor, string> = {
  gray: 'border-transparent hover:border-gray-300 dark:hover:border-gray-700',
  blue: 'border-transparent hover:border-blue-300 dark:hover:border-blue-700',
  green: 'border-transparent hover:border-green-300 dark:hover:border-green-700',
  red: 'border-transparent hover:border-red-300 dark:hover:border-red-700',
  violet: 'border-transparent hover:border-violet-300 dark:hover:border-violet-700',
  orange: 'border-transparent hover:border-orange-300 dark:hover:border-orange-700',
};

/**
 * Returns Tailwind border classes for a left-accent indicator that reacts
 * to selection and hover state.
 *
 * @param accentColor  The user's current accent color preference.
 * @param isSelected   Whether the element is currently selected/active.
 * @param isHover      Whether the element should show hover-state classes.
 * @param borderWidth  Tailwind border-width utility (default `border-l-[3px]`).
 */
export function getAccentBorderClasses(
  accentColor: string,
  isSelected: boolean,
  isHover: boolean = false,
  borderWidth: string = 'border-l-[3px]',
): string {
  const color = (accentColor as AccentColor) || 'blue';

  if (isSelected) {
    const classes = SELECTED_BORDER[color] || SELECTED_BORDER.blue;
    return `${borderWidth} border-solid ${classes}`;
  }

  if (isHover) {
    const classes = HOVER_BORDER[color] || HOVER_BORDER.blue;
    return `${borderWidth} border-solid ${classes}`;
  }

  return `${borderWidth} border-solid border-transparent`;
}
