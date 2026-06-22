/**
 * Editor Ruler — Word/Docs-style horizontal ruler with draggable margins.
 *
 * Sits above the TipTap editor. Shows cm tick marks along an A4-width
 * track (794px @ 96 DPI = 210mm). Left and right margin handles can be
 * dragged to adjust editor content padding in real-time.
 *
 * Design:
 *  - 24px total height (unobtrusive)
 *  - Semantic colors (border-border, text-muted-foreground, bg-muted)
 *  - Sharp corners only (Scrapalot design rule #10)
 *  - 44px hit area on handles (touch target rule)
 *  - Dark + light theme safe
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** 1cm in px at 96 DPI (≈37.8px). */
const CM_PX = 37.795275591;

/** A4 widths in px at 96 DPI. 210mm portrait, 297mm landscape. */
const A4_PORTRAIT_WIDTH_PX = 794;
const A4_LANDSCAPE_WIDTH_PX = 1123;

/** Minimum margin in px (≈1cm). */
const MIN_MARGIN = 38;

export type RulerOrientation = 'portrait' | 'landscape';

interface EditorRulerProps {
  /** Current left margin in px. */
  leftMargin: number;
  /** Current right margin in px. */
  rightMargin: number;
  /** Called when left margin changes (px value). */
  onLeftMarginChange: (px: number) => void;
  /** Called when right margin changes (px value). */
  onRightMarginChange: (px: number) => void;
  /** A4 orientation — controls ruler width (21cm vs 29.7cm) and max drag. */
  orientation?: RulerOrientation;
  /** Optional override for the on-screen page width.  When omitted the
   *  ruler renders at A4 (794 px portrait / 1123 px landscape); pass a
   *  larger value to grow the track on wide monitors.  Print CSS in
   *  collaborative-notes-editor.tsx forces the editor container back
   *  to 21 cm regardless, so PDFs always stay A4. */
  pageWidthPx?: number;
  /** Optional className for the outer container. */
  className?: string;
}

/** Generate cm tick positions along the ruler. */
function generateTicks(widthPx: number): Array<{ x: number; cm: number; major: boolean }> {
  const ticks: Array<{ x: number; cm: number; major: boolean }> = [];
  const totalCm = Math.floor(widthPx / CM_PX);
  for (let i = 0; i <= totalCm; i++) {
    ticks.push({ x: i * CM_PX, cm: i, major: i % 5 === 0 });
    // Half-cm ticks
    if (i < totalCm) {
      ticks.push({ x: (i + 0.5) * CM_PX, cm: i + 0.5, major: false });
    }
  }
  return ticks;
}

export function EditorRuler({
  leftMargin,
  rightMargin,
  onLeftMarginChange,
  onRightMarginChange,
  orientation = 'portrait',
  pageWidthPx,
  className,
}: EditorRulerProps) {
  const rulerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null);
  const dragStartX = useRef(0);
  const dragStartMargin = useRef(0);

  // Track width: caller can widen past A4 for wide-screen rendering;
  // we still floor at the orientation's A4 measure so the ruler never
  // becomes narrower than a sheet.
  const a4Width = orientation === 'landscape' ? A4_LANDSCAPE_WIDTH_PX : A4_PORTRAIT_WIDTH_PX;
  const widthPx = Math.max(a4Width, pageWidthPx ?? a4Width);
  // Cap max margin so left + right can never exceed "page width minus 2cm",
  // and no single side takes more than ~40% of the page.
  const maxMargin = Math.min(widthPx * 0.4, widthPx - 2 * CM_PX - MIN_MARGIN);
  const ticks = useMemo(() => generateTicks(widthPx), [widthPx]);

  const handlePointerDown = useCallback(
    (side: 'left' | 'right', e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(side);
      dragStartX.current = e.clientX;
      dragStartMargin.current = side === 'left' ? leftMargin : rightMargin;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [leftMargin, rightMargin],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const delta = e.clientX - dragStartX.current;
      const direction = dragging === 'left' ? 1 : -1; // right margin moves opposite
      const newMargin = Math.max(
        MIN_MARGIN,
        Math.min(maxMargin, dragStartMargin.current + delta * direction),
      );

      // Snap to nearest 0.5cm
      const snapped = Math.round(newMargin / (CM_PX / 2)) * (CM_PX / 2);

      if (dragging === 'left') {
        onLeftMarginChange(snapped);
      } else {
        onRightMarginChange(snapped);
      }
    },
    [dragging, maxMargin, onLeftMarginChange, onRightMarginChange],
  );

  const handlePointerUp = useCallback(() => {
    setDragging(null);
  }, []);

  // Keyboard support for margin handles
  const handleKeyDown = useCallback(
    (side: 'left' | 'right', e: React.KeyboardEvent) => {
      const step = CM_PX / 2; // 0.5cm per arrow press
      const current = side === 'left' ? leftMargin : rightMargin;
      let newVal = current;

      if (e.key === 'ArrowLeft') {
        newVal = Math.max(MIN_MARGIN, current - step);
      } else if (e.key === 'ArrowRight') {
        newVal = Math.min(maxMargin, current + step);
      } else {
        return;
      }

      e.preventDefault();
      if (side === 'left') onLeftMarginChange(newVal);
      else onRightMarginChange(newVal);
    },
    [leftMargin, rightMargin, maxMargin, onLeftMarginChange, onRightMarginChange],
  );

  return (
    <div
      className={cn('relative select-none w-full', className)}
    >
      {/* Full-width background strip with border */}
      <div className="relative h-6 border-b border-border bg-muted/30">
        {/* A4-width ruler track centered inside */}
        <div
          ref={rulerRef}
          className="relative h-full overflow-hidden mx-auto"
          style={{ width: widthPx, maxWidth: '100%' }}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
        {/* Margin shading — left */}
        <div
          className="absolute top-0 bottom-0 left-0 bg-muted/50"
          style={{ width: leftMargin }}
        />
        {/* Margin shading — right */}
        <div
          className="absolute top-0 bottom-0 right-0 bg-muted/50"
          style={{ width: rightMargin }}
        />

        {/* Tick marks */}
        <svg
          className="absolute inset-0 w-full h-full"
          viewBox={`0 0 ${widthPx} 24`}
          preserveAspectRatio="none"
        >
          {ticks.map((tick, i) => {
            const isCm = Number.isInteger(tick.cm);
            const height = tick.major ? 12 : isCm ? 8 : 4;
            return (
              <g key={i}>
                <line
                  x1={tick.x}
                  y1={24 - height}
                  x2={tick.x}
                  y2={24}
                  stroke="hsl(var(--muted-foreground))"
                  strokeWidth={tick.major ? 1 : 0.5}
                  strokeOpacity={tick.major ? 0.5 : isCm ? 0.35 : 0.2}
                />
                {/* Label every 5cm */}
                {tick.major && tick.cm > 0 && (
                  <text
                    x={tick.x}
                    y={10}
                    textAnchor="middle"
                    fill="hsl(var(--muted-foreground))"
                    style={{ fontSize: 8, fontWeight: 500 }}
                    fillOpacity={0.5}
                  >
                    {tick.cm}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Left margin handle */}
        <div
          className={cn(
            'absolute top-0 bottom-0 flex items-end justify-center cursor-ew-resize z-10',
            dragging === 'left' && 'opacity-100',
          )}
          style={{ left: leftMargin - 6, width: 12 }}
          onPointerDown={(e) => handlePointerDown('left', e)}
          onKeyDown={(e) => handleKeyDown('left', e)}
          tabIndex={0}
          role="slider"
          aria-label="Left margin"
          aria-valuemin={MIN_MARGIN}
          aria-valuemax={Math.round(maxMargin)}
          aria-valuenow={Math.round(leftMargin)}
        >
          {/* Visual triangle — pointing down */}
          <svg width="10" height="8" viewBox="0 0 10 8" className="mb-0.5">
            <polygon
              points="0,0 10,0 5,8"
              fill="hsl(var(--primary))"
              fillOpacity={dragging === 'left' ? 1 : 0.6}
            />
          </svg>
          {/* Invisible wider hit area */}
          <div className="absolute -inset-x-4 -inset-y-2" />
        </div>

        {/* Right margin handle */}
        <div
          className={cn(
            'absolute top-0 bottom-0 flex items-end justify-center cursor-ew-resize z-10',
            dragging === 'right' && 'opacity-100',
          )}
          style={{ right: rightMargin - 6, width: 12 }}
          onPointerDown={(e) => handlePointerDown('right', e)}
          onKeyDown={(e) => handleKeyDown('right', e)}
          tabIndex={0}
          role="slider"
          aria-label="Right margin"
          aria-valuemin={MIN_MARGIN}
          aria-valuemax={Math.round(maxMargin)}
          aria-valuenow={Math.round(rightMargin)}
        >
          <svg width="10" height="8" viewBox="0 0 10 8" className="mb-0.5">
            <polygon
              points="0,0 10,0 5,8"
              fill="hsl(var(--primary))"
              fillOpacity={dragging === 'right' ? 1 : 0.6}
            />
          </svg>
          <div className="absolute -inset-x-4 -inset-y-2" />
        </div>

        {/* Drag guideline */}
        {dragging === 'left' && (
          <div
            className="absolute top-0 bottom-0 w-px bg-primary/40"
            style={{ left: leftMargin }}
          />
        )}
        {dragging === 'right' && (
          <div
            className="absolute top-0 bottom-0 w-px bg-primary/40"
            style={{ right: rightMargin }}
          />
        )}
        </div>
      </div>
    </div>
  );
}
