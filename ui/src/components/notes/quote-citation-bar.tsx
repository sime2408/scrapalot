/**
 * QuoteCitationBar — small floating bar that appears after /quote slash command.
 * Lets user choose: type manually (just dismiss) or pick from library (opens citation picker).
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Keyboard, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

interface QuoteCitationBarProps {
  onPickFromLibrary: () => void;
}

export const QuoteCitationBar: React.FC<QuoteCitationBarProps> = ({ onPickFromLibrary }) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [centerX, setCenterX] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const show = useCallback(() => setVisible(true), []);
  const dismiss = useCallback(() => setVisible(false), []);

  useEffect(() => {
    window.addEventListener('show-quote-citation-bar', show);
    return () => window.removeEventListener('show-quote-citation-bar', show);
  }, [show]);

  // Auto-dismiss after 8 seconds
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), 8000);
    return () => clearTimeout(timer);
  }, [visible]);

  // Position bar centered on the Notes drawer, not viewport
  useEffect(() => {
    if (!visible) return;
    const drawer = document.querySelector('[data-testid="notes-drawer"]') ||
                   document.querySelector('.notes-drawer');
    if (drawer) {
      const rect = drawer.getBoundingClientRect();
      setCenterX(rect.left + rect.width / 2);
    } else {
      setCenterX(null); // fallback to viewport center
    }
  }, [visible]);

  if (!visible) return null;

  // Portal to document.body to avoid Notes drawer zoom/transform issues
  return createPortal(
    <div
      ref={barRef}
      className={cn(
        'fixed bottom-20 z-[9999]',
        'flex items-center gap-1.5 px-2 py-1.5',
        'bg-popover border border-border shadow-lg',
        'animate-in fade-in-0 slide-in-from-bottom-2 duration-200',
        'max-w-[calc(100vw-16px)]',
      )}
      style={centerX != null
        ? { left: centerX, transform: 'translateX(-50%)' }
        : { left: '50%', transform: 'translateX(-50%)' }
      }
    >
      <button
        onClick={dismiss}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 text-xs whitespace-nowrap',
          'bg-muted hover:bg-accent transition-colors cursor-pointer',
          'text-foreground',
        )}
      >
        <Keyboard className="h-3.5 w-3.5 shrink-0" />
        <span className="hidden sm:inline">{t('notes.quote.typeManually', 'Type manually')}</span>
        <span className="sm:hidden">{t('notes.quote.typeManuallyShort', 'Manual')}</span>
      </button>

      <button
        onClick={() => {
          dismiss();
          setTimeout(() => onPickFromLibrary(), 50);
        }}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 text-xs whitespace-nowrap',
          'bg-primary/10 hover:bg-primary/20 text-primary transition-colors cursor-pointer',
          'border border-primary/20',
        )}
      >
        <BookOpen className="h-3.5 w-3.5 shrink-0" />
        <span className="hidden sm:inline">{t('notes.quote.fromLibrary', 'From my library')}</span>
        <span className="sm:hidden">{t('notes.quote.fromLibraryShort', 'Library')}</span>
      </button>

      <button
        onClick={dismiss}
        className="p-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>,
    document.body
  );
};
