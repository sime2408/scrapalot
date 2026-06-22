/**
 * Callout Types Configuration
 * Defines the available callout styles with icons and colors
 */

export const CALLOUT_TYPES = {
  info: {
    icon: '💡',
    bgLight: 'rgb(227, 242, 253)',
    bgDark: 'rgb(30, 58, 95)',
    borderLight: 'rgb(144, 202, 249)',
    borderDark: 'rgb(66, 165, 245)',
    labelKey: 'notes.callout.info',
  },
  warning: {
    icon: '⚠️',
    bgLight: 'rgb(255, 243, 205)',
    bgDark: 'rgb(95, 78, 30)',
    borderLight: 'rgb(255, 224, 130)',
    borderDark: 'rgb(255, 202, 40)',
    labelKey: 'notes.callout.warning',
  },
  success: {
    icon: '✅',
    bgLight: 'rgb(212, 237, 218)',
    bgDark: 'rgb(30, 95, 58)',
    borderLight: 'rgb(129, 199, 132)',
    borderDark: 'rgb(102, 187, 106)',
    labelKey: 'notes.callout.success',
  },
  error: {
    icon: '❌',
    bgLight: 'rgb(248, 215, 218)',
    bgDark: 'rgb(95, 30, 46)',
    borderLight: 'rgb(239, 154, 154)',
    borderDark: 'rgb(229, 115, 115)',
    labelKey: 'notes.callout.error',
  },
  default: {
    icon: '📝',
    bgLight: 'rgb(245, 245, 245)',
    bgDark: 'rgb(46, 46, 46)',
    borderLight: 'rgb(224, 224, 224)',
    borderDark: 'rgb(66, 66, 66)',
    labelKey: 'notes.callout.note',
  },
  // 7.10 — Thought Partner / peer review output.  Violet tint.
  review: {
    icon: '✎',
    bgLight: 'rgb(237, 233, 254)',
    bgDark: 'rgb(67, 56, 121)',
    borderLight: 'rgb(196, 181, 253)',
    borderDark: 'rgb(139, 92, 246)',
    labelKey: 'notes.callout.review',
  },
  // 7.10 — Bridge concepts (Cross-Domain Bridge feature). Indigo tint.
  bridge_insights: {
    icon: '🔗',
    bgLight: 'rgb(224, 231, 255)',
    bgDark: 'rgb(49, 46, 129)',
    borderLight: 'rgb(165, 180, 252)',
    borderDark: 'rgb(99, 102, 241)',
    labelKey: 'notes.callout.bridgeInsights',
  },
} as const;

export type CalloutType = keyof typeof CALLOUT_TYPES;
