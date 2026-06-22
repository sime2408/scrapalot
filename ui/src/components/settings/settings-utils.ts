/**
 * Copy text to clipboard
 */
export const copyToClipboard = (text: string): void => {
  void navigator.clipboard.writeText(text);
};
