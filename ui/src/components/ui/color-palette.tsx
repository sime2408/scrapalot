/**
 * Reusable color palette — small grid of preset color dots.
 * Used by tag management, saved search creation, and annotation color selection.
 */

import React from 'react';
import { cn } from '@/lib/utils';

const PRESET_COLORS = [
  { hex: '#ffd400', label: 'Yellow' },
  { hex: '#ff6666', label: 'Red' },
  { hex: '#5fb236', label: 'Green' },
  { hex: '#2ea8e5', label: 'Blue' },
  { hex: '#a28ae5', label: 'Purple' },
  { hex: '#e56eee', label: 'Magenta' },
  { hex: '#f19837', label: 'Orange' },
  { hex: '#aaaaaa', label: 'Gray' },
  { hex: '#3b82f6', label: 'Sky' },
  { hex: '#14b8a6', label: 'Teal' },
];

interface ColorPaletteProps {
  value?: string | null;
  onChange: (color: string) => void;
  colors?: Array<{ hex: string; label: string }>;
  size?: 'sm' | 'md';
  className?: string;
}

export function ColorPalette({
  value,
  onChange,
  colors = PRESET_COLORS,
  size = 'sm',
  className,
}: ColorPaletteProps) {
  const dotSize = size === 'sm' ? 'w-5 h-5' : 'w-6 h-6';

  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {colors.map(({ hex, label }) => (
        <button
          key={hex}
          type="button"
          title={label}
          onClick={() => onChange(hex)}
          className={cn(
            dotSize,
            'border-2 transition-transform hover:scale-110',
            value === hex
              ? 'border-zinc-900 dark:border-white scale-110'
              : 'border-transparent',
          )}
          style={{ backgroundColor: hex }}
        />
      ))}
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export { PRESET_COLORS };
