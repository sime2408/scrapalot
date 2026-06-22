/**
 * Heading Anchor Extension for TipTap
 * Adds slug-based IDs to heading DOM elements and shows a "copy link" icon on hover.
 * Clicking the icon copies a URL with #heading-slug to the clipboard.
 * When a note is opened with a hash fragment, the editor scrolls to that heading.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Generate a URL-safe slug from heading text content.
 * Handles duplicates by appending -1, -2, etc.
 */
function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')   // Remove non-word chars (except spaces and hyphens)
    .replace(/\s+/g, '-')       // Replace spaces with hyphens
    .replace(/-+/g, '-')        // Collapse multiple hyphens
    .replace(/^-|-$/g, '');     // Trim leading/trailing hyphens
}

/**
 * Assign unique slug IDs to all heading elements in the editor DOM.
 * Handles duplicate slugs by appending a counter suffix.
 */
function assignHeadingIds(editorElement: HTMLElement): void {
  const headings = editorElement.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const slugCounts = new Map<string, number>();

  headings.forEach((heading) => {
    const text = heading.textContent || '';
    if (!text.trim()) return;

    let slug = generateSlug(text);
    if (!slug) return;

    // Handle duplicate slugs
    const count = slugCounts.get(slug) || 0;
    slugCounts.set(slug, count + 1);
    if (count > 0) {
      slug = `${slug}-${count}`;
    }

    heading.setAttribute('id', slug);
    // Mark as having anchor support for CSS
    heading.setAttribute('data-heading-anchor', slug);
  });
}

/**
 * Scroll to a heading matching the URL hash fragment.
 * Returns true if a matching heading was found and scrolled to.
 */
export function scrollToHeadingAnchor(editorElement: HTMLElement): boolean {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return false;

  const targetId = decodeURIComponent(hash.substring(1));
  const target = editorElement.querySelector(`[id="${CSS.escape(targetId)}"]`);

  if (target) {
    // Delay scroll slightly to ensure layout is stable
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Brief highlight effect
      target.classList.add('heading-anchor-highlight');
      setTimeout(() => target.classList.remove('heading-anchor-highlight'), 2000);
    });
    return true;
  }
  return false;
}

export interface HeadingAnchorOptions {
  /** Called after a heading link is copied to clipboard */
  onLinkCopied?: (slug: string) => void;
}

export const HeadingAnchor = Extension.create<HeadingAnchorOptions>({
  name: 'headingAnchor',

  addOptions() {
    return {
      onLinkCopied: undefined,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;

    return [
      new Plugin({
        key: new PluginKey('headingAnchor'),

        view(editorView) {
          // Assign IDs on initial render
          assignHeadingIds(editorView.dom);

          // Handle click on heading anchor icon (the ::after pseudo-element area)
          const handleClick = (event: MouseEvent) => {
            const target = event.target as HTMLElement;

            // Check if the click target is a heading with an anchor
            const heading = target.closest('[data-heading-anchor]') as HTMLElement | null;
            if (!heading) return;

            // Detect click on the right side of the heading (where ::after icon is)
            const headingRect = heading.getBoundingClientRect();
            const textWidth = heading.scrollWidth;
            const clickX = event.clientX - headingRect.left;

            // If click is in the icon zone (after the text content + some padding)
            // The icon area starts after text and is about 32px wide
            if (clickX > textWidth + 4) {
              event.preventDefault();
              event.stopPropagation();

              const slug = heading.getAttribute('data-heading-anchor');
              if (!slug) return;

              // Build the full URL with hash
              const url = new URL(window.location.href);
              url.hash = slug;
              const linkUrl = url.toString();

              navigator.clipboard.writeText(linkUrl).then(() => {
                // Visual feedback: brief highlight
                heading.classList.add('heading-anchor-copied');
                setTimeout(() => heading.classList.remove('heading-anchor-copied'), 1500);

                options.onLinkCopied?.(slug);
              });
            }
          };

          editorView.dom.addEventListener('click', handleClick);

          return {
            update() {
              // Re-assign IDs whenever the document changes
              assignHeadingIds(editorView.dom);
            },
            destroy() {
              editorView.dom.removeEventListener('click', handleClick);
            },
          };
        },
      }),
    ];
  },
});
