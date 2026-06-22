/**
 * Markdown Converter Utility
 * Safely converts Markdown to HTML using markdown-it library
 */

import MarkdownIt from 'markdown-it';
import { DOMParser as ProseMirrorDOMParser, Schema } from '@tiptap/pm/model';
import { Slice } from '@tiptap/pm/model';

// Initialize markdown-it with GitHub Flavored Markdown-like options
const md = new MarkdownIt({
  html: false,        // Disable HTML tags in source
  breaks: true,       // Convert \n to <br>
  linkify: true,      // Autoconvert URL-like text to links
  typographer: true,  // Enable smartypants and other sweet transforms
});

/**
 * Convert Markdown to HTML
 * @param markdown - Markdown string to convert
 * @returns HTML string
 */
export function markdownToHtml(markdown: string): string {
  try {
    const html = md.render(markdown);
    return html.trim();
  } catch (error) {
    console.error('[MarkdownConverter] Failed to parse markdown:', error);
    return markdown; // Return original markdown on error
  }
}

/**
 * Convert HTML string to ProseMirror slice
 * @param html - HTML string to convert
 * @param schema - ProseMirror schema
 * @returns ProseMirror Slice
 */
export function htmlToSlice(html: string, schema: Schema): Slice {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;

  const parser = ProseMirrorDOMParser.fromSchema(schema);
  const doc = parser.parse(tempDiv);

  return new Slice(doc.content, 0, 0);
}
