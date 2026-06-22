/**
 * Layout popover for the Notes editor toolbar.
 *
 * Splits two concepts that the old single orientation toggle conflated:
 *
 *   1. Paper size + orientation — the "logical" page (A4 / A3 / A5,
 *      portrait or landscape).  Drives page-break visualization and
 *      print output (`@page` size + iframe dimensions).
 *
 *   2. Screen width — the "visual" page width on the writer's
 *      monitor.  Either matches the paper width (default) or grows to
 *      fill the available drawer up to a hard cap so writers on big
 *      monitors get a longer line measure.  Wide mode never affects
 *      what comes out of the printer.
 *
 * The previous behaviour (binary portrait/landscape toggle that
 * coupled both axes) is reachable as Paper=A4 + Orientation=Portrait
 * + Screen=Match paper, so existing notes keep working unchanged.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { NotesEditorOrientation, NotesPaperSize, NotesScreenWidth } from '@/lib/api-settings';

interface NoteLayoutPopoverProps {
  paperSize: NotesPaperSize;
  orientation: NotesEditorOrientation;
  screenWidth: NotesScreenWidth;
  onPaperSizeChange: (size: NotesPaperSize) => void;
  onOrientationChange: (orientation: NotesEditorOrientation) => void;
  onScreenWidthChange: (width: NotesScreenWidth) => void;
  /** The trigger button — typically the existing toolbar icon button. */
  trigger: React.ReactNode;
}

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  ariaLabel?: string;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  testIdPrefix,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (next: T) => void;
  testIdPrefix: string;
}) {
  return (
    <div className="flex border border-border" role="radiogroup">
      {options.map((opt, i) => (
        <Button
          key={opt.value}
          size="sm"
          variant={value === opt.value ? 'default' : 'ghost'}
          aria-checked={value === opt.value}
          aria-label={opt.ariaLabel ?? opt.label}
          role="radio"
          data-testid={`${testIdPrefix}-${opt.value}`}
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex-1 h-8 text-xs',
            i > 0 && 'border-l border-border',
          )}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}

export const NoteLayoutPopover: React.FC<NoteLayoutPopoverProps> = ({
  paperSize,
  orientation,
  screenWidth,
  onPaperSizeChange,
  onOrientationChange,
  onScreenWidthChange,
  trigger,
}) => {
  const { t } = useTranslation();

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        // z-[10050] keeps the popover above the editor toolbar
        // (z-[10001]) — same convention as TemplateGallery and the
        // version-history dialog.  PopoverContent in this codebase
        // doesn't ship a default padding so we add p-4 here, matching
        // the spacing rhythm of other dialogs.
        className="w-72 z-[10050] p-4"
        collisionPadding={8}
        data-testid="notes-layout-popover"
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('notes.layout.paperSize', 'Paper size')}
            </p>
            <Segmented
              value={paperSize}
              options={[
                { value: 'A5', label: 'A5' },
                { value: 'A4', label: 'A4' },
                { value: 'A3', label: 'A3' },
              ]}
              onChange={onPaperSizeChange}
              testIdPrefix="notes-layout-paper"
            />
            <p className="text-[10px] text-muted-foreground">
              {t('notes.layout.paperSizeHint', 'Drives print output and page-break visualization.')}
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('notes.layout.orientation', 'Orientation')}
            </p>
            <Segmented
              value={orientation}
              options={[
                { value: 'portrait', label: t('notes.layout.portrait', 'Portrait') },
                { value: 'landscape', label: t('notes.layout.landscape', 'Landscape') },
              ]}
              onChange={onOrientationChange}
              testIdPrefix="notes-layout-orientation"
            />
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('notes.layout.screenView', 'Screen view')}
            </p>
            <Segmented
              value={screenWidth}
              options={[
                { value: 'paper', label: t('notes.layout.matchPaper', 'Match paper') },
                { value: 'wide', label: t('notes.layout.wide', 'Wide') },
              ]}
              onChange={onScreenWidthChange}
              testIdPrefix="notes-layout-screen"
            />
            <p className="text-[10px] text-muted-foreground">
              {t('notes.layout.screenViewHint', 'Wide grows the on-screen page to fill the drawer; the printed PDF still reflows to the chosen paper.')}
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
