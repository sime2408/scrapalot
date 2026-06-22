/**
 * Centralized z-index values for settings dialogs and components
 * This ensures consistent layering across all settings components
 *
 * Hierarchy:
 * - Main settings dialog: 1050
 * - Dropdowns in main dialog: 1100
 * - Child dialogs (Local AI, Provider Form): 1550
 * - Dropdowns in child dialogs: 1600
 * - Nested dialogs (User Form): 10000
 * - Dropdowns in nested dialogs: 10001
 */
export const SETTINGS_Z_INDEX = {
  // Main settings dialog content (settings.tsx)
  MAIN_DIALOG: 1050,

  // Select/Dropdown content within main settings dialog
  MAIN_DIALOG_SELECT: 1100,
  MAIN_DIALOG_DROPDOWN: 1100,

  // Child dialogs (Local AI models, Provider forms)
  CHILD_DIALOG: 1550,
  CHILD_DIALOG_CONTROLS: 1600,

  // Select/Dropdown content within child dialogs
  CHILD_DIALOG_SELECT: 1600,
  CHILD_DIALOG_DROPDOWN: 1600,

  // Nested dialogs (User form, delete confirmations)
  NESTED_DIALOG: 10000,

  // Select/Dropdown content within nested dialogs
  NESTED_DIALOG_SELECT: 10001,
  NESTED_DIALOG_DROPDOWN: 10001,
} as const;
