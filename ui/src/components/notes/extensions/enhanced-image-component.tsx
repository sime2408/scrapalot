/**
 * Enhanced Image Component - React NodeView for Enhanced Image Extension
 * Renders images with resize handles and captions
 */

import React, { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/core';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Maximize2, AlignLeft, Columns2 } from 'lucide-react';

type ImageStyle = 'default' | 'inline' | 'side-by-side';

export const EnhancedImageComponent: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
}) => {
  const { t } = useTranslation();
  const [isResizing, setIsResizing] = useState(false);
  const [width, setWidth] = useState<string>(node.attrs.width || '100%');
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageStyle: ImageStyle = (node.attrs.imageStyle as ImageStyle) || 'default';

  const handleCaptionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateAttributes({ caption: e.target.value });
  };

  const handleResize = (e: React.MouseEvent, side: 'left' | 'right') => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const startX = e.clientX;
    const startWidth = imgRef.current?.offsetWidth || 0;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = side === 'right' ? moveEvent.clientX - startX : startX - moveEvent.clientX;
      const newWidth = Math.max(100, Math.min(800, startWidth + delta * 2)); // Min 100px, max 800px
      setWidth(`${newWidth}px`);
      updateAttributes({ width: `${newWidth}px` });
    };

    const onMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const alignmentClasses = {
    left: 'mr-auto',
    center: 'mx-auto',
    right: 'ml-auto',
    full: 'w-full',
  };

  const align = node.attrs.align || 'center';
  const isFull = align === 'full';

  // 7.10 — image style picker. Persists to node attrs so the CSS rule
  // `.image-wrapper[data-image-style=…]` in notes-drawer.css can lay
  // the image out (default = full-width with caption, inline = floated,
  // side-by-side = 48 % column).
  const setImageStyle = (style: ImageStyle) => {
    updateAttributes({ imageStyle: style });
  };

  const styleButtons: Array<{ key: ImageStyle; icon: typeof Maximize2; label: string }> = [
    { key: 'default', icon: Maximize2, label: t('notes.image.style.default', 'Full width') },
    { key: 'inline', icon: AlignLeft, label: t('notes.image.style.inline', 'Inline (text wraps)') },
    { key: 'side-by-side', icon: Columns2, label: t('notes.image.style.sideBySide', 'Side by side') },
  ];

  return (
    <NodeViewWrapper className="image-wrapper my-4" data-image-style={imageStyle}>
      <div
        ref={containerRef}
        className={cn(
          'image-container relative group',
          alignmentClasses[align as keyof typeof alignmentClasses]
        )}
        style={{
          width: isFull || imageStyle === 'inline' || imageStyle === 'side-by-side'
            ? '100%'
            : width,
          maxWidth: '100%',
        }}
      >
        <div className="relative">
          <img
            ref={imgRef}
            src={node.attrs.src}
            alt={node.attrs.alt || ''}
            className={cn(
              'w-full rounded-lg shadow-md',
              isResizing && 'select-none'
            )}
            draggable={false}
          />

          {/* 7.10 — Style picker (top-right, hover-revealed). Three
              tri-state buttons cycle the layout. */}
          <div
            className="absolute top-2 right-2 z-20 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-background/95 backdrop-blur-sm rounded-md border border-border p-0.5 shadow-sm"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {styleButtons.map(({ key, icon: Icon, label }) => (
              <Button
                key={key}
                size="sm"
                variant={imageStyle === key ? 'default' : 'ghost'}
                className="h-7 w-7 p-0"
                title={label}
                aria-label={label}
                aria-pressed={imageStyle === key}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setImageStyle(key);
                }}
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            ))}
          </div>

          {/* Resize Handles */}
          {!isFull && (
            <>
              {/* Left Handle */}
              <div
                className="absolute top-0 bottom-0 -left-1 w-2 cursor-ew-resize opacity-0 group-hover:opacity-100 transition-opacity bg-primary rounded-l"
                onMouseDown={(e) => handleResize(e, 'left')}
                style={{ zIndex: 10 }}
              />

              {/* Right Handle */}
              <div
                className="absolute top-0 bottom-0 -right-1 w-2 cursor-ew-resize opacity-0 group-hover:opacity-100 transition-opacity bg-primary rounded-r"
                onMouseDown={(e) => handleResize(e, 'right')}
                style={{ zIndex: 10 }}
              />
            </>
          )}
        </div>

        {/* Caption Input */}
        <Input
          type="text"
          placeholder={t('notes.image.captionPlaceholder')}
          value={node.attrs.caption || ''}
          onChange={handleCaptionChange}
          className="mt-2 text-sm text-center text-muted-foreground bg-transparent border-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />
      </div>
    </NodeViewWrapper>
  );
};
