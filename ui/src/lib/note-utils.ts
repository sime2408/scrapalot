/**
 * Utility functions for notes
 */

/**
 * Generates a note title from HTML content
 * - Uses the first H1-H5 heading if present as the first element
 * - Otherwise returns a default title
 * @param htmlContent - HTML string to parse
 * @param defaultTitle - Default title to use if no heading found
 * @returns The generated title
 */
export function generateNoteTitle(htmlContent: string, defaultTitle: string = 'Untitled Note'): string {
  if (!htmlContent || !htmlContent.trim()) {
    console.log('[note-utils] Empty content, using default title:', defaultTitle);
    return defaultTitle;
  }

  try {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlContent;

    // Get the first element child (ignores text nodes and whitespace)
    const firstElement = tempDiv.firstElementChild;

    console.log('[note-utils] First element:', firstElement?.tagName, firstElement?.textContent?.substring(0, 50));

    if (!firstElement) {
      console.log('[note-utils] No first element found, using default title');
      return defaultTitle;
    }

    // Check if the first element is a heading
    const tagName = firstElement.tagName.toLowerCase();
    if (['h1', 'h2', 'h3', 'h4', 'h5'].includes(tagName)) {
      const headingText = firstElement.textContent?.trim();

      if (headingText && headingText.length > 0) {
        // Limit title length to avoid database issues
        const maxLength = 255;
        const title = headingText.length > maxLength
          ? headingText.substring(0, maxLength) + '...'
          : headingText;

        console.log('[note-utils] Generated title from heading:', title);
        return title;
      }
    }

    console.log('[note-utils] First element is not a heading, using default title');
    return defaultTitle;
  } catch (error) {
    console.error('[note-utils] Error generating note title:', error);
    return defaultTitle;
  }
}
