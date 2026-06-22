/**
 * Enhanced Image Extension for TipTap
 * Extends the base Image extension with caption, alignment, and resize support
 */

import Image from '@tiptap/extension-image';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { EnhancedImageComponent } from './enhanced-image-component';

export interface EnhancedImageOptions {
  inline: boolean;
  allowBase64: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TipTap extension convention for HTML attributes
  HTMLAttributes: Record<string, any>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    enhancedImage: {
      /**
       * Set an image with enhanced attributes
       */
      setEnhancedImage: (options: {
        src: string;
        alt?: string;
        caption?: string;
        width?: string;
        align?: 'left' | 'center' | 'right' | 'full';
        imageStyle?: 'default' | 'inline' | 'side-by-side';
      }) => ReturnType;
    };
  }
}

export const EnhancedImage = Image.extend<EnhancedImageOptions>({
  name: 'image',

  addOptions() {
    return {
      inline: false,
      allowBase64: true,
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      caption: {
        default: null,
        parseHTML: element => element.getAttribute('data-caption'),
        renderHTML: attributes => {
          if (!attributes.caption) {
            return {};
          }
          return { 'data-caption': attributes.caption };
        },
      },
      width: {
        default: null,
        parseHTML: element => element.getAttribute('width') || element.style.width,
        renderHTML: attributes => {
          if (!attributes.width) {
            return {};
          }
          return { width: attributes.width };
        },
      },
      align: {
        default: 'center',
        parseHTML: element => element.getAttribute('data-align') || 'center',
        renderHTML: attributes => ({ 'data-align': attributes.align }),
      },
      // 7.10 — image style. `default` keeps the existing center-aligned
      // full-width layout; `inline` floats the image so body text wraps
      // around it; `side-by-side` lets two adjacent images share a row.
      // The CSS that consumes this attribute lives in
      // `notes-drawer.css` under `.image-wrapper[data-image-style=…]`.
      imageStyle: {
        default: 'default',
        parseHTML: element => element.getAttribute('data-image-style') || 'default',
        renderHTML: attributes => ({ 'data-image-style': attributes.imageStyle }),
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(EnhancedImageComponent);
  },

  addCommands() {
    return {
      ...this.parent?.(),
      setEnhancedImage:
        options =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: options,
          });
        },
    };
  },
});
