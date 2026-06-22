/**
 * CitationStanceChip — numbered citation chip with stance colour, symbol,
 * and a Radix Popover that works on both desktop hover AND mobile tap.
 *
 * Desktop: hover delay 200ms (chip fires pointerenter)
 * Mobile:  tap toggles open; tap outside closes (Radix handles this).
 *
 * The native `title` attribute was the previous mechanism — it worked on
 * desktop only. Touch devices dismiss native tooltips on press, leaving
 * mobile users with no way to see the stance rationale.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { useOpenCitationInViewer, type OpenableCitation } from '@/hooks/use-open-citation-in-viewer';
import { ExternalLink, FileX, Globe, BookOpen } from 'lucide-react';
import { api } from '@/lib/api';
import { useTranslation } from 'react-i18next';
import { AnimatedTitle } from '@/components/ui/animated-title';
import {
  useDocumentFileStatusStore,
  probeDocumentFile,
} from '@/hooks/use-document-file-status';

type Stance = 'supporting' | 'contrasting' | 'mentioning';

interface CitationStanceChipProps {
  num: number;
  stance?: Stance;
  stance_confidence?: number;
  stance_rationale?: string;
  document_title?: string;
  text?: string;
  /** Compact sentence-bounded excerpt, rendered as a blockquote inside
   *  the popover. Falls back to `text` when absent. */
  citation_context?: string;
  /** Full citation object — when provided, clicking the chip opens the
   *  source document in the correct viewer with a precise text highlight. */
  citation?: OpenableCitation;
  children: React.ReactNode;
}

export function CitationStanceChip({
  num,
  stance,
  stance_confidence,
  stance_rationale,
  document_title,
  text,
  citation_context,
  citation,
  children,
}: CitationStanceChipProps) {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const openInViewer = useOpenCitationInViewer();

  // Desktop: show on pointerenter / hide on pointerleave.
  // Mobile: toggle only on tap (onClick).
  const onEnter = useCallback(() => { if (!isMobile) setOpen(true); }, [isMobile]);
  const onLeave = useCallback(() => { if (!isMobile) setOpen(false); }, [isMobile]);
  const onClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setOpen(v => !v);
  }, []);

  // Resolve this citation's document id and track its file-on-disk status
  // so we can disable the "Open source" button when we already know the
  // file is missing. Probe lazily when the popover first opens so we
  // don't HEAD-request every citation in the message up-front.
  const citationDocId = citation?.document_id || citation?.documentId;
  const fileStatus = useDocumentFileStatusStore(
    (s) => (citationDocId ? s.status[citationDocId] : undefined) ?? 'unknown'
  );
  useEffect(() => {
    if (open && citationDocId && fileStatus === 'unknown') {
      void probeDocumentFile(citationDocId);
    }
  }, [open, citationDocId, fileStatus]);

  // Distinguish a WEB citation (external http(s) URL, no document id) from a
  // library document citation — drives the source icon (🌐 vs book cover).
  const citUrl = citation?.url || '';
  const isWebSource = !citationDocId && /^https?:\/\//i.test(citUrl);
  let webHost = '';
  if (isWebSource) {
    try { webHost = new URL(citUrl).hostname.replace(/^www\./, ''); } catch { webHost = ''; }
  }

  // Lazy-load the book cover for document citations when the popover opens.
  // Separate from the file-on-disk probe (/thumbnail vs /file), so a
  // struck-through "file missing" citation can still show its cover + title.
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const coverTriedRef = useRef(false);
  useEffect(() => {
    if (!open || isWebSource || !citationDocId || coverTriedRef.current) return;
    coverTriedRef.current = true;
    let revoked = false;
    let objUrl: string | null = null;
    void (async () => {
      try {
        const res = await api.get(`/documents/${citationDocId}/thumbnail?size=large`, {
          responseType: 'blob',
          validateStatus: (s: number) => s < 500,
        });
        if (res.status === 200 && res.data && (res.data as Blob).size > 0 && !revoked) {
          objUrl = URL.createObjectURL(res.data as Blob);
          setCoverUrl(objUrl);
        }
      } catch { /* no cover — fall back to the book glyph */ }
    })();
    return () => { revoked = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [open, isWebSource, citationDocId]);

  const handleOpenSource = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (citation && fileStatus !== 'missing') {
      void openInViewer(citation);
      setOpen(false);
    }
  }, [citation, openInViewer, fileStatus]);

  const stanceClass =
    stance === 'supporting'
      ? 'bg-emerald-500 text-white dark:bg-emerald-600 dark:text-white ring-1 ring-emerald-700/60 shadow-sm'
      : stance === 'contrasting'
        ? 'bg-rose-500 text-white dark:bg-rose-600 dark:text-white ring-1 ring-rose-700/60 shadow-sm'
        : stance === 'mentioning'
          ? 'bg-amber-500 text-white dark:bg-amber-600 dark:text-white ring-1 ring-amber-700/60 shadow-sm'
          : 'bg-primary/15 text-primary';

  // Stance is encoded via background colour + ring + popover label.
  // Adding a prefix symbol to the number was confusing — users mistook "·3"
  // for a page number or "-1" for a minus sign. Keep the chip = citation
  // number only; stance lives in the colour and the accessible popover.
  const stanceSymbol = '';

  const stanceLabel = stance
    ? t(`smartCitations.stance.${stance}`, { defaultValue: stance })
    : '';
  const ariaLabel = stance
    ? stance_rationale
      ? t('smartCitations.aria.citationWithStanceAndRationale', { num, stance: stanceLabel, rationale: stance_rationale })
      : t('smartCitations.aria.citationWithStance', { num, stance: stanceLabel })
    : document_title
      ? t('smartCitations.aria.citationWithTitle', { num, title: document_title })
      : t('smartCitations.aria.citation', { num });

  // Dim dot colour for heading in popover
  const dotColor = stance === 'supporting' ? 'bg-emerald-500'
    : stance === 'contrasting' ? 'bg-rose-500'
    : stance === 'mentioning' ? 'bg-amber-500'
    : 'bg-primary';

  const confidencePct = typeof stance_confidence === 'number' ? Math.round(stance_confidence * 100) : null;

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <sup
          onPointerEnter={onEnter}
          onPointerLeave={onLeave}
          onClick={onClick}
          // align-super raises the chip but its 1.4em height + super offset
          // pushed the top edge above the parent's line box; any overflow:hidden
          // upstream then clipped the pill. Switch to align-baseline + relative
          // -top + leading-none so the chip sits at baseline (zero line-box
          // contribution), then we visually nudge it up like a superscript
          // without ever exceeding the line height.
          className={cn(
            'inline-flex items-center justify-center min-w-[1.4em] h-[1.2em] px-[0.35em] mx-[1px] text-[0.75em] font-bold rounded-full align-baseline relative -top-[0.35em] leading-none cursor-pointer select-none transition-colors',
            stanceClass,
          )}
          aria-label={ariaLabel}
          aria-expanded={open}
          data-stance={stance || undefined}
        >
          {stanceSymbol && <span aria-hidden className='text-[0.9em] leading-none'>{stanceSymbol}</span>}
          {children}
        </sup>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='start'
        sideOffset={4}
        collisionPadding={16}
        className='w-80 max-w-[90vw] p-3 space-y-2 z-[1400]'
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
      >
        {/* Source header: 🌐 + domain for a web result, book cover (or a book
            glyph fallback) for a library document. Cover loads even when the
            file is missing on disk, so struck-through citations still preview. */}
        {isWebSource ? (
          <span className='inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground min-w-0 max-w-full'>
            <Globe className='h-3.5 w-3.5 shrink-0 text-sky-500' />
            <span className='truncate'>{webHost || t('smartCitations.webSource', 'Web source')}</span>
          </span>
        ) : coverUrl ? (
          <img src={coverUrl} alt='' className='w-11 aspect-[3/4] object-cover border border-border shrink-0' />
        ) : (
          <span className='inline-flex h-[3.6rem] w-11 items-center justify-center border border-border bg-muted/40 shrink-0'>
            <BookOpen className='h-4 w-4 text-muted-foreground' />
          </span>
        )}
        {stance ? (
          <>
            <div className='flex items-center justify-between'>
              <span className={cn(
                'inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border',
                stance === 'supporting' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/40'
                  : stance === 'contrasting' ? 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/40'
                  : 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/40'
              )}>
                <span className={cn('w-1.5 h-1.5 rounded-full', dotColor)} aria-hidden />
                {stanceLabel}
              </span>
              {confidencePct !== null && (
                <span className='text-[10px] text-muted-foreground'>{t('smartCitations.confidence', 'Confidence')} {confidencePct}%</span>
              )}
            </div>
            {document_title && (
              <AnimatedTitle
                title={document_title}
                className='text-xs font-semibold text-foreground leading-snug'
              />
            )}
            {stance_rationale && (
              <p className='text-[11px] text-muted-foreground italic leading-relaxed border-l-2 pl-2 border-border'>
                {stance_rationale}
              </p>
            )}
            {(citation_context || text) && (
              <blockquote className='text-[11px] text-foreground/80 leading-relaxed border-l-2 border-primary/40 pl-2 italic line-clamp-4'>
                “{(citation_context || text || '').slice(0, 280)}{((citation_context || text || '').length > 280) ? '…' : ''}”
              </blockquote>
            )}
          </>
        ) : (
          <>
            {document_title && (
              <AnimatedTitle
                title={document_title}
                className='text-xs font-semibold text-foreground leading-snug'
              />
            )}
            {(citation_context || text) && (
              <blockquote className='text-[11px] text-muted-foreground leading-relaxed border-l-2 border-border pl-2 italic line-clamp-4'>
                “{(citation_context || text || '').slice(0, 280)}{((citation_context || text || '').length > 280) ? '…' : ''}”
              </blockquote>
            )}
          </>
        )}
        {citation && (
          <button
            type='button'
            onClick={handleOpenSource}
            onMouseDown={(e) => e.preventDefault()}
            disabled={fileStatus === 'missing'}
            title={fileStatus === 'missing' ? t('smartCitations.fileMissing.description', 'The source file for this citation is no longer on disk and cannot be opened.') : undefined}
            className={cn(
              'mt-2 pt-2 border-t border-border/60 w-full flex items-center justify-center gap-1.5 text-[11px] font-semibold transition-colors',
              fileStatus === 'missing'
                ? 'text-muted-foreground/60 cursor-not-allowed'
                : 'text-primary hover:text-primary/80'
            )}
          >
            {fileStatus === 'missing' ? (
              <>
                <FileX className='h-3 w-3' />
                {t('smartCitations.fileMissing.short', 'File unavailable')}
              </>
            ) : (
              <>
                <ExternalLink className='h-3 w-3' />
                {t('smartCitations.openSource', 'Open source')}
              </>
            )}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
