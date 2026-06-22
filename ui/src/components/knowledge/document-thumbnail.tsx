import React, { useState, useCallback, useEffect, useRef } from 'react';
import { FileText, Upload, X, Eye, Download, Loader2, Search, FileSearch, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  uploadCustomThumbnail,
  deleteCustomThumbnail,
  downloadBookCover,
  findOpenAccessPdf,
  extractPdfAnnotations,
  updateDocumentPriority,
} from '@/lib/api-documents';
import { api, clearCache } from '@/lib/api';
import { enqueueThumbnailFetch } from '@/lib/thumbnail-queue';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { toast } from '@/lib/toast-compat';
import { getDocumentTypeInfo, DOCUMENT_TYPES } from '@/lib/document-types';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface DocumentThumbnailProps {
  documentId: string;
  filename: string;
  hasThumbnail?: boolean;
  hasCustomThumbnail?: boolean;
  // True when the current thumbnail came from a previous "Download cover"
  // action (Open Library). Flips the context-menu label from "Preuzmi
  // naslovnicu" to "Probaj drugu naslovnicu" so retries can rotate covers.
  coverDownloaded?: boolean;
  // Bumped by the parent after it mutates the underlying thumbnail file
  // (download / remove). DocumentThumbnail caches the blob URL of the
  // last fetched image — when the file on disk changes but the React
  // props don't, the stale blob stays on screen until a page reload.
  // Bumping `refreshKey` re-triggers the fetch.
  refreshKey?: number;
  coverUrl?: string; // Book cover URL from file_metadata
  documentType?: string; // Structured item type from extracted_metadata.resolved.document_type
  onTypeChange?: (documentId: string, newType: string) => void; // Callback when user changes document type
  className?: string;
  onThumbnailUpdate?: () => void;
  onPreview?: (documentId: string, filename: string) => void; // Preview callback for PDFs/EPUBs
  // Fake-cover metadata: rendered as a stylised book cover when no real
  // thumbnail or downloaded cover is available, replacing the previous
  // oversized format icon.
  title?: string;
  author?: string;
  year?: string | number;
}

// Format extension → discrete badge text + tint class. Tints are drawn
// from the project's semantic palette (only `*-foreground` / `*-muted`
// are permitted by rule §9), so we stay intentionally muted: the badge
// is meant to be readable, not to scream the format.
const formatBadgeForFilename = (filename: string): { label: string; tint: string } => {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'pdf':
      return { label: 'PDF', tint: 'bg-red-600/80 text-white' };
    case 'epub':
      return { label: 'EPUB', tint: 'bg-emerald-600/80 text-white' };
    case 'doc':
    case 'docx':
    case 'rtf':
      return { label: 'DOC', tint: 'bg-blue-600/80 text-white' };
    case 'xls':
    case 'xlsx':
    case 'csv':
      return { label: 'XLS', tint: 'bg-emerald-700/80 text-white' };
    case 'mp4':
    case 'avi':
    case 'mov':
    case 'mkv':
      return { label: 'VID', tint: 'bg-violet-600/80 text-white' };
    case 'md':
    case 'txt':
    case 'json':
    case 'jsonl':
      return { label: ext.toUpperCase(), tint: 'bg-zinc-600/80 text-white' };
    default:
      return { label: ext.toUpperCase() || 'DOC', tint: 'bg-zinc-600/80 text-white' };
  }
};

// Stylised "book cover" used when no real thumbnail exists. Title wraps
// up to 5 short lines; author and year sit small underneath; a tiny
// format chip lives in the bottom-left corner to leave the bottom-right
// for the existing document-type badge.
function FakeBookCover({
  title,
  author,
  year,
  filename,
}: {
  title?: string;
  author?: string;
  year?: string | number;
  filename: string;
}) {
  const displayTitle = (title && title.trim()) || filename.replace(/\.[^.]+$/, '');
  const { label: formatLabel, tint: formatTint } = formatBadgeForFilename(filename);
  return (
    <div
      className={cn(
        'relative w-full h-full flex flex-col',
        // Asymmetric top padding leaves room for the parent's overlay
        // chrome — selection checkbox (top-left) and 3-dot menu
        // (top-right) sit at top:4px with ~20-24px height, so we push
        // the title down past them. Bottom stays tight.
        'px-2 pt-7 pb-2.5 sm:px-2.5 sm:pt-8 sm:pb-3',
        // Paper-toned gradient + spine on the left edge. Both themes
        // resolve via Tailwind's neutral zinc scale to stay on-brand.
        'bg-gradient-to-br from-zinc-50 via-zinc-100 to-zinc-200',
        'dark:from-zinc-800 dark:via-zinc-800/80 dark:to-zinc-900',
        'border-l-[3px] border-l-zinc-300/80 dark:border-l-zinc-600/80',
      )}
    >
      <div
        className={cn(
          'font-serif font-semibold text-zinc-800 dark:text-zinc-100',
          'leading-tight break-words',
          // 7 lines on mobile, 8 from sm: upward — long archaeological /
          // academic titles need the room and the card has it. Tailwind's
          // built-in line-clamp tops out at 6, so use arbitrary values.
          'line-clamp-[7] sm:line-clamp-[8]',
          // Pixel-stepped sizes instead of cqw — predictable at every
          // breakpoint, no Safari container-query gotchas.
          'text-[10px] sm:text-[11px] md:text-xs',
        )}
        title={displayTitle}
      >
        {displayTitle}
      </div>
      <div className="flex-1 min-h-[4px]" />
      {(author || year) && (
        <div className="space-y-0.5">
          {author && (
            <div
              className={cn(
                'italic text-zinc-600 dark:text-zinc-400 line-clamp-1',
                'text-[8px] sm:text-[9px] md:text-[10px]',
              )}
              title={author}
            >
              {author}
            </div>
          )}
          {year !== undefined && year !== null && year !== '' && (
            <div
              className={cn(
                'text-zinc-500 dark:text-zinc-500',
                'text-[8px] sm:text-[9px] md:text-[10px]',
              )}
            >
              {year}
            </div>
          )}
        </div>
      )}
      <div
        className={cn(
          // Centred along the bottom edge — it sits between the library's
          // readiness-status overlay (bottom-left) and the document-type
          // badge (bottom-right) instead of fighting them for a corner.
          'absolute bottom-1 left-1/2 -translate-x-1/2 px-1 py-[1px] tracking-wider font-bold',
          'text-[7px] sm:text-[8px] leading-none',
          formatTint,
        )}
      >
        {formatLabel}
      </div>
    </div>
  );
}

export function DocumentThumbnail({
  documentId,
  filename,
  hasThumbnail = false,
  hasCustomThumbnail = false,
  coverDownloaded = false,
  refreshKey = 0,
  coverUrl,
  documentType,
  onTypeChange,
  className,
  onThumbnailUpdate,
  onPreview,
  title,
  author,
  year,
}: DocumentThumbnailProps) {
  const { t } = useTranslation();
  const [imageError, setImageError] = useState(false);
  const [coverError, setCoverError] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDownloadingCover, setIsDownloadingCover] = useState(false);
  const [cacheBuster, setCacheBuster] = useState(Date.now());
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Gates the thumbnail fetch on viewport proximity. The library view mounts
  // every card up-front (no virtualization); without this, all thumbnails
  // request at once and saturate the gRPC path. Once a card scrolls near the
  // viewport it stays "visible" so the cover doesn't flicker on scroll-back.
  const [isNearViewport, setIsNearViewport] = useState(false);

  // Parent bumped its refresh counter — wipe the failure state and force
  // a new fetch. Without this, a successful retry overwrites the on-disk
  // file but the cached blob URL stays on screen.
  useEffect(() => {
    if (refreshKey === 0) return;
    setImageError(false);
    setCoverError(false);
    setCacheBuster(Date.now());
  }, [refreshKey]);

  // Mark the card as near-viewport once it scrolls into range. `rootMargin`
  // pre-loads a screen ahead so covers are usually ready by the time they're
  // actually visible. Disconnect after the first hit — visibility is sticky.
  useEffect(() => {
    if (isNearViewport) return;
    const el = containerRef.current;
    if (!el) return;
    // No IntersectionObserver (jsdom / very old browsers) → load eagerly.
    if (typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [isNearViewport]);

  // Fetch thumbnail via authenticated request (img src can't send JWT headers).
  // `validateStatus` accepts 404 as a non-error so the global axios interceptor
  // doesn't log "❌ HTTP Request Failed" for documents without a thumbnail
  // (which is the common case — the UI falls back to a file icon).
  //
  // Gated on `isNearViewport` and routed through `enqueueThumbnailFetch` so a
  // large library loads its covers a few at a time as they scroll into view,
  // rather than firing 100+ concurrent requests that saturate the gRPC path
  // and time out at 60s.
  useEffect(() => {
    if (!isNearViewport || !hasThumbnail || coverUrl || imageError) return;

    const abortController = new AbortController();
    let cancelled = false;
    const url = `/documents/${documentId}/thumbnail?size=large&t=${cacheBuster}`;

    enqueueThumbnailFetch(
      () =>
        api.get(url, {
          responseType: 'blob',
          signal: abortController.signal,
          validateStatus: (status) => status === 200 || status === 404,
        }),
      abortController.signal,
    )
      .then((response) => {
        if (cancelled) return;
        if (response.status === 404) {
          setImageError(true);
          return;
        }
        const objectUrl = URL.createObjectURL(response.data);
        setBlobUrl(objectUrl);
      })
      .catch((err) => {
        // Aborts (unmount / scroll-away) are expected — only a real failure
        // should fall back to the stylised cover.
        if (!cancelled && err?.name !== 'AbortError' && err?.code !== 'ERR_CANCELED') {
          setImageError(true);
        }
      });

    return () => {
      cancelled = true;
      abortController.abort();
      setBlobUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [documentId, isNearViewport, hasThumbnail, coverUrl, imageError, cacheBuster]);

  // Determine what to show (priority: book cover > document thumbnail > file icon)
  // Book cover takes precedence if available
  const showBookCover = coverUrl && !coverError;
  const showDocThumbnail = !showBookCover && hasThumbnail && !imageError;

  const thumbnailUrl = showBookCover
    ? coverUrl
    : showDocThumbnail && blobUrl
    ? blobUrl
    : null;

  const handleImageError = useCallback(() => {
    if (showBookCover) {
      // If book cover fails, fall back to document thumbnail
      setCoverError(true);
    } else {
      // If document thumbnail fails, fall back to file icon
      setImageError(true);
    }
  }, [showBookCover]);

  const handleCustomUpload = useCallback(async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        // Validate file size (max 5MB)
        if (file.size > 5 * 1024 * 1024) {
          toast({
            title: t('knowledge.thumbnail.uploadError', 'Upload Error'),
            description: t(
              'knowledge.thumbnail.fileTooLarge',
              'Image is too large. Maximum size is 5MB.'
            ),
            variant: 'destructive',
          });
          return;
        }

        setIsUploading(true);
        try {
          await uploadCustomThumbnail(documentId, file);
          setImageError(false); // Reset error state to try loading new thumbnail
          setCacheBuster(Date.now()); // Force image reload by busting cache
          toast({
            title: t('knowledge.thumbnail.uploadSuccess', 'Success'),
            description: t(
              'knowledge.thumbnail.customUploaded',
              'Custom thumbnail uploaded successfully'
            ),
          });
          onThumbnailUpdate?.();
        } catch (error) {
          console.error('Failed to upload thumbnail:', error);
          toast({
            title: t('knowledge.thumbnail.uploadError', 'Upload Error'),
            description:
              error instanceof Error
                ? error.message
                : t(
                    'knowledge.thumbnail.uploadFailed',
                    'Failed to upload thumbnail'
                  ),
            variant: 'destructive',
          });
        } finally {
          setIsUploading(false);
        }
      }
    };
    input.click();
  }, [documentId, onThumbnailUpdate, t]);

  const handleDownloadCover = useCallback(async () => {
    setIsDownloadingCover(true);
    const wasRetry = coverDownloaded;
    try {
      const result = await downloadBookCover(documentId);
      if (result.success) {
        setImageError(false);
        setCoverError(false);
        setCacheBuster(Date.now());
        clearCache('/documents/collection/');
        toast({
          title: wasRetry
            ? t('knowledge.thumbnail.alternateCoverDownloaded', 'Different cover loaded')
            : t('knowledge.thumbnail.coverDownloaded', 'Cover Downloaded'),
          description: result.message,
        });
        onThumbnailUpdate?.();
      } else if (result.source === 'no_more_covers') {
        // Backend exhausted the alternates and deleted the existing
        // thumbnail — force the <img> to refetch (it'll 404 and the
        // stylised fake cover takes over).
        setImageError(true);
        setCoverError(true);
        setCacheBuster(Date.now());
        clearCache('/documents/collection/');
        toast({
          title: t('knowledge.thumbnail.noMoreCovers', 'No more covers'),
          description: t(
            'knowledge.thumbnail.noMoreCoversDescription',
            'No alternative covers available for this book. You can upload one manually.'
          ),
        });
        onThumbnailUpdate?.();
      } else {
        toast({
          title: t('knowledge.thumbnail.noCoverFound', 'No Cover Found'),
          description: result.message,
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Failed to download cover:', error);
      toast({
        title: t('knowledge.thumbnail.coverDownloadError', 'Download Error'),
        description: error instanceof Error ? error.message : t('knowledge.thumbnail.coverDownloadFailed', 'Failed to download cover'),
        variant: 'destructive',
      });
    } finally {
      setIsDownloadingCover(false);
    }
  }, [documentId, coverDownloaded, onThumbnailUpdate, t]);

  const handleRemoveCustom = useCallback(async () => {
    try {
      await deleteCustomThumbnail(documentId);
      setImageError(false); // Reset to allow regenerated thumbnail to load
      setCacheBuster(Date.now()); // Force image reload by busting cache
      toast({
        title: t('knowledge.thumbnail.removeSuccess', 'Success'),
        description: t(
          'knowledge.thumbnail.customRemoved',
          'Custom thumbnail removed'
        ),
      });
      onThumbnailUpdate?.();
    } catch (error) {
      console.error('Failed to remove thumbnail:', error);
      toast({
        title: t('knowledge.thumbnail.removeError', 'Error'),
        description:
          error instanceof Error
            ? error.message
            : t(
                'knowledge.thumbnail.removeFailed',
                'Failed to remove thumbnail'
              ),
        variant: 'destructive',
      });
    }
  }, [documentId, onThumbnailUpdate, t]);

  // Responsive size: fill parent width on mobile, fixed on desktop
  const sizeClasses = 'w-full aspect-[3/4]';
  const iconSizeClasses = 'w-2/5 h-2/5';

  // Check if file is previewable (PDF, EPUB, or DOCX)
  const fileExtension = filename.split('.').pop()?.toLowerCase();
  const isPreviewable = onPreview && (fileExtension === 'pdf' || fileExtension === 'epub' || fileExtension === 'docx');

  const handlePreviewClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onPreview) {
      onPreview(documentId, filename);
    }
  }, [onPreview, documentId, filename]);

  return (
    <TooltipProvider>
      <Tooltip>
        <ContextMenu>
          <ContextMenuTrigger>
            <TooltipTrigger asChild>
              <div
                ref={containerRef}
                data-testid={`knowledge-document-thumbnail-${documentId}`}
                className={cn(
                  'relative overflow-hidden flex items-center justify-center group cursor-pointer',
                  thumbnailUrl
                    ? 'rounded-md bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700'
                    : 'border border-zinc-200 dark:border-zinc-700',
                  sizeClasses,
                  className
                )}
                onClick={isPreviewable ? handlePreviewClick : undefined}
              >
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={filename}
              className="w-full h-full object-cover"
              onError={handleImageError}
              loading="lazy"
            />
          ) : (
            <FakeBookCover
              title={title}
              author={author}
              year={year}
              filename={filename}
            />
          )}

          {/* Hover overlay — Preview for previewable files only */}
          {!isUploading && isPreviewable && (
            <div
              data-testid={`document-preview-overlay-${documentId}`}
              className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all duration-200 flex items-center justify-center opacity-0 group-hover:opacity-100"
            >
              <div className="flex flex-col items-center gap-1">
                <Eye className={cn('text-white', iconSizeClasses)} />
                <span className="text-white text-xs font-medium">
                  {t('knowledge.thumbnail.preview', 'Preview')}
                </span>
              </div>
            </div>
          )}

          {/* Uploading/downloading overlay */}
          {(isUploading || isDownloadingCover) && (
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {/* Custom thumbnail indicator */}
          {hasCustomThumbnail && !imageError && !coverError && (
            <div
              className="absolute top-0.5 right-0.5 w-2.5 h-2.5 bg-blue-500 rounded-full border border-white dark:border-zinc-800"
              title={t('knowledge.thumbnail.custom', 'Custom thumbnail')}
            />
          )}

          {/* Document type icon badge — click to edit */}
          {(() => {
            const typeInfo = getDocumentTypeInfo(documentType);
            if (!typeInfo && !onTypeChange) return null;
            const TypeIcon = typeInfo?.icon;
            const badge = (
              <div
                className={cn(
                  'absolute bottom-1 right-1 w-5 h-5 rounded-full flex items-center justify-center cursor-pointer',
                  'border border-white/80 dark:border-zinc-800/80 opacity-90 hover:opacity-100 transition-opacity',
                  'lg:opacity-0 lg:group-hover:opacity-100 lg:hover:opacity-100',
                  typeInfo ? typeInfo.bgColor : 'bg-zinc-400'
                )}
                title={typeInfo ? t(`knowledge.documentType.${typeInfo.id}`, typeInfo.label) : t('knowledge.documentType.changeType', 'Set document type')}
              >
                {TypeIcon ? <TypeIcon className="w-3 h-3 text-white" /> : <FileText className="w-3 h-3 text-white" />}
              </div>
            );
            if (!onTypeChange) return badge;
            return (
              <Popover>
                <PopoverTrigger asChild onClick={(e) => e.stopPropagation()}>
                  {badge}
                </PopoverTrigger>
                <PopoverContent className="w-48 p-1 z-[1400]" align="end" side="bottom">
                  {DOCUMENT_TYPES.map(dt => {
                    const Icon = dt.icon;
                    return (
                      <button
                        key={dt.id}
                        className={cn(
                          'w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent transition-colors',
                          documentType === dt.id && 'bg-accent/50'
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          onTypeChange(documentId, dt.id);
                        }}
                      >
                        <Icon className={cn('w-3.5 h-3.5', dt.textColor)} />
                        {t(`knowledge.documentType.${dt.id}`, dt.label)}
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>
            );
          })()}
              </div>
            </TooltipTrigger>
          </ContextMenuTrigger>
          <ContextMenuContent>
        <ContextMenuItem data-testid={`knowledge-thumbnail-download-cover-${documentId}`} onClick={handleDownloadCover} disabled={isUploading || isDownloadingCover}>
          {isDownloadingCover ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
          {coverDownloaded
            ? t('knowledge.thumbnail.tryDifferentCover', 'Try a different cover')
            : t('knowledge.thumbnail.downloadCover', 'Download cover (ISBN)')}
        </ContextMenuItem>
        <ContextMenuItem data-testid={`knowledge-thumbnail-upload-custom-${documentId}`} onClick={handleCustomUpload} disabled={isUploading || isDownloadingCover}>
          <Upload className="w-4 h-4 mr-2" />
          {t('knowledge.thumbnail.uploadCustom', 'Upload custom thumbnail')}
        </ContextMenuItem>
        {hasCustomThumbnail && (
          <ContextMenuItem data-testid={`knowledge-thumbnail-remove-custom-${documentId}`} onClick={handleRemoveCustom} disabled={isUploading || isDownloadingCover}>
            <X className="w-4 h-4 mr-2" />
            {t('knowledge.thumbnail.removeCustom', 'Remove custom thumbnail')}
          </ContextMenuItem>
        )}
        {/* Find open-access PDF */}
        <ContextMenuItem
          onClick={async () => {
            try {
              const result = await findOpenAccessPdf(documentId);
              if (result.success && result.pdf_url) {
                window.open(result.pdf_url, '_blank');
                toast.success(t('knowledge.unpaywall.found', 'Open access PDF found'));
              } else {
                toast.info(result.message || t('knowledge.unpaywall.notFound', 'No open access version available'));
              }
            } catch { toast.error(t('knowledge.document.unpaywallFailed')); }
          }}
        >
          <Search className="w-4 h-4 mr-2" />
          {t('knowledge.unpaywall.findPdf', 'Find open-access PDF')}
        </ContextMenuItem>
        {/* Extract PDF annotations */}
        {filename?.toLowerCase().endsWith('.pdf') && (
          <ContextMenuItem
            onClick={async () => {
              try {
                const result = await extractPdfAnnotations(documentId);
                if (result.success && result.annotations.length > 0) {
                  toast.success(t('knowledge.annotations.extracted', { count: result.annotations.length, defaultValue: `Extracted ${result.annotations.length} annotations` }));
                } else {
                  toast.info(result.message || t('knowledge.annotations.noneFound', 'No annotations found in PDF'));
                }
              } catch { toast.error(t('knowledge.document.annotationExtractionFailed')); }
            }}
          >
            <FileSearch className="w-4 h-4 mr-2" />
            {t('knowledge.annotations.extractFromPdf', 'Extract PDF annotations')}
          </ContextMenuItem>
        )}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Star className="w-4 h-4 mr-2" />
            {t('knowledge.priority.label', 'Priority')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {[
              { value: 2.0, label: t('knowledge.priority.high', 'High'), icon: '⬆' },
              { value: 1.0, label: t('knowledge.priority.normal', 'Normal'), icon: '—' },
              { value: 0.5, label: t('knowledge.priority.low', 'Low'), icon: '⬇' },
            ].map(({ value, label, icon }) => (
              <ContextMenuItem
                key={value}
                onClick={async () => {
                  try {
                    await updateDocumentPriority(documentId, value);
                    toast.success(`${label}`);
                  } catch { toast.error(t('knowledge.document.priorityUpdateFailed')); }
                }}
              >
                <span className="w-4 mr-2 text-center">{icon}</span>
                {label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
          </ContextMenuContent>
        </ContextMenu>
        <TooltipContent>
          <p className="max-w-xs">{title || filename}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
