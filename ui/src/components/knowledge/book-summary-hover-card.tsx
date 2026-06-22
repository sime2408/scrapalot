import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import { mdUrlTransform } from '@/lib/native-app';
import remarkGfm from 'remark-gfm';
import { Hourglass, Volume2, Square, Loader2, X, Languages, Sparkles } from 'lucide-react';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getBookSummary, translateBookSummary, generateBookSummary } from '@/lib/api-documents';
import { synthesizeSpeech, base64ToAudioBlob } from '@/lib/api-tts';
import { LANGUAGE_VOICE_MAP } from '@/lib/tts-constants';
import { useIsMobile } from '@/hooks/use-mobile';

interface BookSummaryHoverCardProps {
  documentId: string;
  children: React.ReactNode;
  openSummary?: boolean;
  onSummaryOpenChange?: (open: boolean) => void;
  /** Fired once after generation succeeds so the parent (e.g. LibraryView)
   *  can flip its local `has_summary` flag — the dropdown menu label
   *  "Izradi sažetak" → "Sažetak" reacts to that flag without a refetch. */
  onSummaryGenerated?: () => void;
}

function SummaryContent({
  loading,
  summary,
  noSummary,
  ttsLoading,
  ttsPlaying,
  onTtsToggle,
  translatedText,
  translating,
  showTranslation,
  onTranslateToggle,
  showTranslateButton,
  generating,
  generateProgress,
  generateMessage,
  onGenerate,
  t,
}: {
  loading: boolean;
  summary: string | null;
  noSummary: boolean;
  ttsLoading: boolean;
  ttsPlaying: boolean;
  onTtsToggle: () => void;
  translatedText: string | null;
  translating: boolean;
  showTranslation: boolean;
  onTranslateToggle: () => void;
  showTranslateButton: boolean;
  generating: boolean;
  generateProgress: number;
  generateMessage: string;
  onGenerate?: () => void;
  t: (key: string, fallback: string) => string;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Hourglass className="h-4 w-4 animate-pulse text-muted-foreground" />
      </div>
    );
  }

  if (generating) {
    return (
      <div className="py-4 space-y-3">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">{generateMessage}</span>
        </div>
        <div className="w-full bg-muted h-1.5">
          <div
            className="bg-primary h-1.5 transition-all duration-300"
            style={{ width: `${Math.round(generateProgress * 100)}%` }}
          />
        </div>
      </div>
    );
  }

  if (noSummary) {
    return (
      <div className="py-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          {t('knowledge.summary.noSummary', 'No summary available for this document.')}
        </p>
        {onGenerate && (
          <button
            data-testid="knowledge-summary-generate-button"
            onClick={onGenerate}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t('knowledge.summary.generate', 'Generate Summary')}
          </button>
        )}
      </div>
    );
  }

  if (!summary) return null;

  const displayText = showTranslation && translatedText ? translatedText : summary;

  return (
    <>
      <div className="flex justify-end gap-1 mb-1">
        {showTranslateButton && (
          <button
            onClick={onTranslateToggle}
            disabled={translating}
            className={`p-1 rounded-full hover:bg-muted/50 transition-colors disabled:opacity-50 ${
              showTranslation ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
            title={showTranslation
              ? t('knowledge.summary.showOriginal', 'Show original')
              : t('knowledge.summary.translate', 'Translate')}
          >
            {translating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Languages className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        <button
          onClick={onTtsToggle}
          disabled={ttsLoading}
          className="p-1 rounded-full hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
          title={ttsPlaying
            ? t('knowledge.summary.stopReading', 'Stop reading')
            : t('knowledge.summary.readAloud', 'Read aloud')}
        >
          {ttsLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : ttsPlaying ? (
            <Square className="h-3.5 w-3.5" />
          ) : (
            <Volume2 className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto text-xs text-foreground/80 prose prose-xs dark:prose-invert prose-p:my-1 prose-headings:my-1.5">
        <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={mdUrlTransform}>
          {displayText}
        </ReactMarkdown>
      </div>
    </>
  );
}

export function BookSummaryHoverCard({
  documentId,
  children,
  openSummary,
  onSummaryOpenChange,
  onSummaryGenerated,
}: BookSummaryHoverCardProps) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [noSummary, setNoSummary] = useState(false);
  const fetchedRef = useRef(false);

  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Translation state
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const translationAbortRef = useRef<AbortController | null>(null);

  // Generation state
  const [generating, setGenerating] = useState(false);
  const [generateProgress, setGenerateProgress] = useState(0);
  const [generateMessage, setGenerateMessage] = useState('');
  const generateAbortRef = useRef<AbortController | null>(null);

  // Show translate button whenever a summary exists (user may want to translate regardless of UI language)
  const showTranslateButton = !!summary;

  // HoverCard pinned state (stays open while TTS is playing or translating)
  const [pinned, setPinned] = useState(false);
  const [hoverCardOpen, setHoverCardOpen] = useState(false);

  // Auto-close hover card when no summary found (hover-triggered only, not from dropdown)
  useEffect(() => {
    if (noSummary && !openSummary && hoverCardOpen && !generating) {
      setHoverCardOpen(false);
    }
  }, [noSummary, openSummary, hoverCardOpen, generating]);

  // Mobile drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);

  const fetchSummary = useCallback(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    getBookSummary(documentId).then((result) => {
      if (result.found && result.summary_text) {
        setSummary(result.summary_text);
      } else {
        setNoSummary(true);
      }
      setLoading(false);
    });
  }, [documentId]);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      URL.revokeObjectURL(audioRef.current.src);
      audioRef.current = null;
    }
    setTtsPlaying(false);
  }, []);

  // External open trigger (e.g. from dropdown menu after generation)
  useEffect(() => {
    if (openSummary) {
      fetchedRef.current = false; // Force re-fetch to get fresh summary
      fetchSummary();
      if (isMobile) {
        setDrawerOpen(true);
      } else {
        setHoverCardOpen(true);
      }
    }
  }, [openSummary, isMobile, fetchSummary]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        URL.revokeObjectURL(audioRef.current.src);
      }
      translationAbortRef.current?.abort();
      generateAbortRef.current?.abort();
    };
  }, []);

  const handleTtsToggle = useCallback(async () => {
    if (ttsPlaying) {
      stopAudio();
      if (!translating) setPinned(false);
      return;
    }

    // TTS reads whatever is currently displayed (translated or original)
    const textToRead = showTranslation && translatedText ? translatedText : summary;
    if (!textToRead) return;

    setTtsLoading(true);
    setPinned(true);
    try {
      // Pick TTS voice matching the displayed language
      const ttsVoice = showTranslation && translatedText
        ? (LANGUAGE_VOICE_MAP[i18n.language] || 'en-US-AriaNeural')
        : 'en-US-AriaNeural';
      const response = await synthesizeSpeech(textToRead, ttsVoice);
      const blob = base64ToAudioBlob(response.audio);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onended = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        setTtsPlaying(false);
        if (!translating) setPinned(false);
      };

      await audio.play();
      setTtsPlaying(true);
    } catch (error) {
      console.error('TTS synthesis failed:', error);
      if (!translating) setPinned(false);
    } finally {
      setTtsLoading(false);
    }
  }, [summary, translatedText, showTranslation, ttsPlaying, translating, stopAudio, i18n.language]);

  const handleTranslateToggle = useCallback(async () => {
    // If already showing translation, toggle back to original
    if (showTranslation) {
      setShowTranslation(false);
      return;
    }

    // If we already have a cached translation, just show it
    if (translatedText) {
      setShowTranslation(true);
      return;
    }

    // Start streaming translation
    if (!summary) return;

    setTranslating(true);
    setPinned(true);
    setShowTranslation(true);

    const abortController = new AbortController();
    translationAbortRef.current = abortController;

    try {
      await translateBookSummary(
        documentId,
        i18n.language,
        (fullText) => setTranslatedText(fullText),
        (fullText) => {
          setTranslatedText(fullText);
          setTranslating(false);
          if (!ttsPlaying) setPinned(false);
        },
        (error) => {
          console.error('Translation failed:', error);
          setTranslating(false);
          setShowTranslation(false);
          if (!ttsPlaying) setPinned(false);
        },
        abortController.signal
      );
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error('Translation error:', error);
      }
      setTranslating(false);
      setShowTranslation(false);
      if (!ttsPlaying) setPinned(false);
    }
  }, [summary, translatedText, showTranslation, ttsPlaying, documentId, i18n.language]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenerateProgress(0);
    setGenerateMessage('Initializing...');

    const abortController = new AbortController();
    generateAbortRef.current = abortController;

    try {
      await generateBookSummary(
        documentId,
        (message, progress) => {
          setGenerateMessage(message);
          setGenerateProgress(progress);
        },
        (summaryText) => {
          setSummary(summaryText);
          setNoSummary(false);
          setGenerating(false);
          onSummaryGenerated?.();
        },
        (error) => {
          console.error('Summary generation failed:', error);
          setGenerating(false);
          setGenerateMessage(error);
        },
        abortController.signal
      );
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error('Summary generation error:', error);
      }
      setGenerating(false);
    }
  }, [documentId, onSummaryGenerated]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        fetchSummary();
        setHoverCardOpen(true);
      } else if (!pinned) {
        stopAudio();
        translationAbortRef.current?.abort();
        setHoverCardOpen(false);
        onSummaryOpenChange?.(false);
      }
    },
    [fetchSummary, stopAudio, pinned, onSummaryOpenChange]
  );

  const handleHoverCardClose = useCallback(() => {
    stopAudio();
    translationAbortRef.current?.abort();
    setTranslating(false);
    setPinned(false);
    setHoverCardOpen(false);
    onSummaryOpenChange?.(false);
  }, [stopAudio, onSummaryOpenChange]);

  const handleDrawerOpenChange = useCallback(
    (open: boolean) => {
      setDrawerOpen(open);
      if (open) {
        fetchSummary();
      }
      if (!open) {
        stopAudio();
        translationAbortRef.current?.abort();
        generateAbortRef.current?.abort();
        setTranslating(false);
        setGenerating(false);
        onSummaryOpenChange?.(false);
      }
    },
    [fetchSummary, stopAudio, onSummaryOpenChange]
  );

  // Mobile: summary opened via three-dot menu (openSummary prop)
  if (isMobile) {
    return (
      <>
        {children}
        <Drawer open={drawerOpen} onOpenChange={handleDrawerOpenChange}>
          <DrawerContent className="z-[1100]" overlayClassName="z-[1100]">
            <DrawerHeader>
              <DrawerTitle>
                {t('knowledge.summary.bookSummary', 'Book Summary')}
              </DrawerTitle>
            </DrawerHeader>
            <div className="px-4 pb-6">
              <SummaryContent
                loading={loading}
                summary={summary}
                noSummary={noSummary}
                ttsLoading={ttsLoading}
                ttsPlaying={ttsPlaying}
                onTtsToggle={handleTtsToggle}
                translatedText={translatedText}
                translating={translating}
                showTranslation={showTranslation}
                onTranslateToggle={handleTranslateToggle}
                showTranslateButton={showTranslateButton}
                generating={generating}
                generateProgress={generateProgress}
                generateMessage={generateMessage}
                onGenerate={handleGenerate}
                t={t}
              />
            </div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  // Desktop: programmatic open from three-dot menu → use Dialog (not HoverCard)
  if (openSummary && !isMobile) {
    return (
      <>
        {children}
        <Dialog open={true} onOpenChange={(open) => { if (!open) { stopAudio(); translationAbortRef.current?.abort(); generateAbortRef.current?.abort(); onSummaryOpenChange?.(false); } }}>
          <DialogContent className="max-w-md p-0 z-[1100]" overlayZIndex="1050">
            <DialogHeader className="px-4 pt-4 pb-2 border-b border-border">
              <DialogTitle className="text-sm">{t('knowledge.summary.bookSummary', 'Book Summary')}</DialogTitle>
              <DialogDescription className="sr-only">{t('knowledge.summary.bookSummary', 'Book Summary')}</DialogDescription>
            </DialogHeader>
            <div className="px-4 pb-4 max-h-[60vh] overflow-y-auto">
              <SummaryContent
                loading={loading}
                summary={summary}
                noSummary={noSummary}
                ttsLoading={ttsLoading}
                ttsPlaying={ttsPlaying}
                onTtsToggle={handleTtsToggle}
                translatedText={translatedText}
                translating={translating}
                showTranslation={showTranslation}
                onTranslateToggle={handleTranslateToggle}
                showTranslateButton={showTranslateButton}
                generating={generating}
                generateProgress={generateProgress}
                generateMessage={generateMessage}
                onGenerate={handleGenerate}
                t={t}
              />
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // If we already know there is no summary, not generating, and not externally opened, render children directly
  if (noSummary && !generating && !openSummary && !hoverCardOpen) {
    return <>{children}</>;
  }

  return (
    <HoverCard open={hoverCardOpen} openDelay={300} onOpenChange={handleOpenChange}>
      <HoverCardTrigger asChild>
        <div>{children}</div>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="center"
        collisionPadding={16}
        className="w-80 bg-popover/70 backdrop-blur-md border border-border p-3 z-[1100]"
      >
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-foreground">
            {t('knowledge.summary.bookSummary', 'Book Summary')}
          </h4>
          <div className="flex items-center gap-1">
            {showTranslateButton && (
              <button
                onClick={handleTranslateToggle}
                disabled={translating}
                className={`p-1 rounded-full hover:bg-muted/50 transition-colors disabled:opacity-50 ${
                  showTranslation ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
                title={showTranslation
                  ? t('knowledge.summary.showOriginal', 'Show original')
                  : t('knowledge.summary.translate', 'Translate')}
              >
                {translating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Languages className="h-3.5 w-3.5" />
                )}
              </button>
            )}
            {summary && (
              <button
                onClick={handleTtsToggle}
                disabled={ttsLoading}
                className="p-1 rounded-full hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
                title={ttsPlaying
                  ? t('knowledge.summary.stopReading', 'Stop reading')
                  : t('knowledge.summary.readAloud', 'Read aloud')}
              >
                {ttsLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : ttsPlaying ? (
                  <Square className="h-3.5 w-3.5" />
                ) : (
                  <Volume2 className="h-3.5 w-3.5" />
                )}
              </button>
            )}
            {pinned && (
              <button
                onClick={handleHoverCardClose}
                className="p-1 rounded-full hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
                title={t('general.close', 'Close')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Hourglass className="h-4 w-4 animate-pulse text-muted-foreground" />
          </div>
        ) : generating ? (
          <div className="py-4 space-y-3">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span className="text-xs text-muted-foreground">{generateMessage}</span>
            </div>
            <div className="w-full bg-muted h-1.5">
              <div
                className="bg-primary h-1.5 transition-all duration-300"
                style={{ width: `${Math.round(generateProgress * 100)}%` }}
              />
            </div>
          </div>
        ) : noSummary ? (
          // Only show "no summary" + generate button when opened from dropdown menu
          openSummary ? (
            <div className="py-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                {t('knowledge.summary.noSummary', 'No summary available for this document.')}
              </p>
              <button
                onClick={handleGenerate}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {t('knowledge.summary.generate', 'Generate Summary')}
              </button>
            </div>
          ) : null
        ) : summary ? (
          <div className="max-h-64 overflow-y-auto text-xs text-foreground/80 prose prose-xs dark:prose-invert prose-p:my-1 prose-headings:my-1.5">
            <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={mdUrlTransform}>
              {showTranslation && translatedText ? translatedText : summary}
            </ReactMarkdown>
          </div>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}
