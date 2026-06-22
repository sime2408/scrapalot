/**
 * Markdown Paste Extension
 * Automatically converts pasted Markdown to formatted rich text.
 *
 * Handles two scenarios:
 * 1. Markdown text paste: detects Markdown syntax in plain text and converts
 *    it to rich HTML via markdown-it before inserting into the editor.
 * 2. Rich HTML paste (Word, Google Docs, web pages): passes through to
 *    TipTap's native HTML paste handling (which relies on loaded extensions
 *    for Tables, Links, CodeBlock, etc.).
 *
 * Uses TipTap's `editor.commands.insertContent()` for Y.js-safe insertion.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DOMParser as ProseMirrorDOMParser, Schema, Slice } from '@tiptap/pm/model';
import MarkdownIt from 'markdown-it';

// Initialize markdown-it with GitHub Flavored Markdown-like options
const md = new MarkdownIt({
  html: false,        // Disable raw HTML tags in source (security)
  breaks: true,       // Convert \n to <br>
  linkify: true,      // Auto-convert URL-like text to links
  typographer: true,  // Enable smartypants and other sweet transforms
});

/**
 * Detect if text contains Markdown syntax.
 * Returns true if at least one Markdown pattern is found.
 */
function looksLikeMarkdown(text: string): boolean {
  if (text.trim().length < 3) return false;

  const markdownPatterns = [
    /^#{1,6}\s+.+$/m,           // Headers: # ## ### etc.
    /^\s*[-*+]\s+.+$/m,         // Unordered lists: - * +
    /^\s*\d+\.\s+.+$/m,         // Ordered lists: 1. 2. 3.
    /\*\*[^*\n]+\*\*/,          // Bold: **text**
    /\*[^*\n]+\*/,              // Italic: *text*
    /__[^_\n]+__/,              // Bold: __text__
    /_[^_\n]+_/,                // Italic: _text_
    /`[^`\n]+`/,                // Inline code: `code`
    /```[\s\S]+?```/,           // Code blocks: ```code```
    /\[.+?\]\(.+?\)/,           // Links: [text](url)
    /!\[.*?\]\(.+?\)/,          // Images: ![alt](url)
    /^\s*>.+$/m,                // Blockquotes: > text
    /^\s*[-*_]{3,}\s*$/m,       // Horizontal rules: --- *** ___
    /\|.+\|.+\|/,              // Tables: | col | col |
    /~~[^~\n]+~~/,              // Strikethrough: ~~text~~
    /^\s*-\s*\[[x ]\]\s+.+$/mi, // Task lists: - [ ] or - [x]
  ];

  return markdownPatterns.some(pattern => pattern.test(text));
}

/**
 * Post-process HTML to convert task list markup that markdown-it
 * renders as plain `<li>[x] text</li>` into proper checkbox HTML
 * that TipTap's TaskList extension can parse.
 */
function convertTaskLists(html: string): string {
  // markdown-it renders task items as: <li>[x] text</li> or <li>[ ] text</li>
  // TipTap's TaskItem expects: <ul data-type="taskList"><li data-type="taskItem" data-checked="true">text</li></ul>
  // We convert the inner items and wrap the parent <ul> when task items are found.

  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;

  const lists = tempDiv.querySelectorAll('ul');
  lists.forEach(ul => {
    let hasTaskItems = false;
    const items = ul.querySelectorAll(':scope > li');

    items.forEach(li => {
      const textContent = li.innerHTML;
      const checkedMatch = textContent.match(/^\s*\[x\]\s*/i);
      const uncheckedMatch = textContent.match(/^\s*\[ \]\s*/);

      if (checkedMatch) {
        hasTaskItems = true;
        li.setAttribute('data-type', 'taskItem');
        li.setAttribute('data-checked', 'true');
        li.innerHTML = textContent.replace(checkedMatch[0], '');
      } else if (uncheckedMatch) {
        hasTaskItems = true;
        li.setAttribute('data-type', 'taskItem');
        li.setAttribute('data-checked', 'false');
        li.innerHTML = textContent.replace(uncheckedMatch[0], '');
      }
    });

    if (hasTaskItems) {
      ul.setAttribute('data-type', 'taskList');
    }
  });

  return tempDiv.innerHTML;
}

/**
 * Convert Markdown text to HTML using markdown-it, then apply
 * post-processing for features markdown-it does not natively support
 * in a TipTap-compatible way (task lists).
 */
function convertMarkdownToHtml(markdown: string): string {
  try {
    let html = md.render(markdown).trim();
    // Post-process task lists for TipTap compatibility
    html = convertTaskLists(html);
    return html;
  } catch (error) {
    console.error('[MarkdownPaste] Failed to parse markdown:', error);
    return markdown;
  }
}

/**
 * Convert an HTML string to a ProseMirror Slice using the schema's DOMParser.
 */
function htmlToSlice(html: string, schema: Schema): Slice {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  const parser = ProseMirrorDOMParser.fromSchema(schema);
  const doc = parser.parse(tempDiv);
  return new Slice(doc.content, 0, 0);
}

export const MarkdownPaste = Extension.create({
  name: 'markdownPaste',

  addProseMirrorPlugins() {
    // Capture the TipTap editor from the extension context.
    // This is safe because addProseMirrorPlugins() is called with the
    // extension instance bound, so `this.editor` is the TipTap Editor.
    const tiptapEditor = this.editor;

    return [
      new Plugin({
        key: new PluginKey('markdownPaste'),
        props: {
          handlePaste: (view, event, _slice) => {
            const clipboardData = event.clipboardData;
            if (!clipboardData) return false;

            const text = clipboardData.getData('text/plain');
            const html = clipboardData.getData('text/html');

            // Nothing to process
            if (!text || text.trim().length === 0) return false;

            // If the paste originates from TipTap/ProseMirror itself, let the
            // default handler deal with it to preserve internal node metadata.
            if (html && html.includes('data-pm-slice')) {
              return false;
            }

            // If clipboard has rich HTML (from Word, Google Docs, web pages)
            // AND it is not just a wrapper around plain text, let TipTap's
            // native HTML paste handling take over. The loaded extensions
            // (Table, Link, CodeBlock, Heading, etc.) will parse it correctly.
            if (html && isRichHtml(html)) {
              // TipTap's default paste handler will process the HTML.
              return false;
            }

            // At this point we only have plain text. Check for Markdown syntax.
            if (!looksLikeMarkdown(text)) {
              return false;
            }

            // Convert Markdown to HTML
            const convertedHtml = convertMarkdownToHtml(text);

            // Verify the conversion actually produced something different
            const plainFallback = `<p>${text}</p>`;
            if (convertedHtml === text || convertedHtml === plainFallback) {
              return false;
            }

            // Insert via TipTap commands (Y.js-safe, handles undo history)
            try {
              if (tiptapEditor && typeof tiptapEditor.chain === 'function') {
                const success = tiptapEditor
                  .chain()
                  .focus()
                  .insertContent(convertedHtml, { parseOptions: { preserveWhitespace: false } })
                  .run();

                if (success) {
                  event.preventDefault();
                  return true;
                }
              }

              // Fallback: direct ProseMirror transaction (for edge cases where
              // the TipTap editor reference is not available)
              const { state } = view;
              const newSlice = htmlToSlice(convertedHtml, state.schema);
              const tr = state.tr.replaceSelection(newSlice);
              view.dispatch(tr);
              event.preventDefault();
              return true;
            } catch (error) {
              console.error('[MarkdownPaste] Error converting markdown:', error);
              return false;
            }
          },
        },
      }),
    ];
  },
});

/**
 * Determine whether an HTML string from the clipboard is "rich" content
 * (from Word, Google Docs, web pages, etc.) as opposed to a minimal
 * wrapper that browsers add around plain text copies.
 *
 * Browsers often wrap plain text in a simple <meta><body><p>text</p></body>
 * structure. We detect truly rich HTML by looking for tags that indicate
 * structured content beyond simple paragraphs.
 */
function isRichHtml(html: string): boolean {
  // Strip the outer meta/body wrapper that browsers add to plain text
  const body = html.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body[\s\S]*$/i, '');

  // Check for tags that indicate actual rich formatting
  const richIndicators = [
    /<h[1-6][\s>]/i,
    /<table[\s>]/i,
    /<(ul|ol)[\s>]/i,
    /<(strong|b|em|i|u|s|del|strike|mark)[\s>]/i,
    /<a\s+href/i,
    /<img[\s>]/i,
    /<pre[\s>]/i,
    /<code[\s>]/i,
    /<blockquote[\s>]/i,
    /style\s*=\s*"/i,        // Inline styles (Word, Google Docs)
    /class\s*=\s*"Mso/i,     // Microsoft Office classes
    /id\s*=\s*"docs-/i,      // Google Docs element IDs
    /data-sheets-/i,          // Google Sheets attributes
  ];

  return richIndicators.some(pattern => pattern.test(body));
}
