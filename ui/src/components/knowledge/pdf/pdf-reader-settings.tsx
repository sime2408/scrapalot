/**
 * PDF Reader Settings Popover
 *
 * Consolidated settings for PDF reading experience:
 * - Voice selection for TTS
 * - Speech rate control
 * - PDF color inversion
 * - Ambient background sounds
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  MoreVertical,
  Volume2,
  Gauge,
  Moon,
  Music,
  VolumeX,
  CloudRain,
  Sparkles,
  Waves,
  Piano,
  Wind,
  StickyNote,
  Image,
  Search,
  Circle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useTranslation } from 'react-i18next';
import type { TTSVoice } from '@/lib/api-tts';

// Ambient sound options - local files in public/audio/ambient/
// Sources: Pixabay (royalty-free), SoundBible (public domain)
const AMBIENT_SOUNDS = [
  {
    id: 'none',
    name: 'Off',
    icon: VolumeX,
    url: '',
  },
  {
    id: 'rain',
    name: 'Rain',
    icon: CloudRain,
    url: '/audio/ambient/rain.mp3',
  },
  {
    id: 'waves',
    name: 'Ocean',
    icon: Waves,
    url: '/audio/ambient/ocean.mp3',
  },
  {
    id: 'wind',
    name: 'Wind',
    icon: Wind,
    url: '/audio/ambient/wind.mp3',
  },
  {
    id: 'stream',
    name: 'Stream',
    icon: Sparkles,
    url: '/audio/ambient/stream.mp3',
  },
  {
    id: 'piano',
    name: 'Piano',
    icon: Piano,
    url: '/audio/ambient/piano.mp3',
  },
];

interface PDFReaderSettingsProps {
  // TTS Voice settings
  availableVoices: TTSVoice[];
  selectedVoice: string;
  isLoadingVoices: boolean;
  onVoiceChange: (voice: string) => void;

  // Speech rate
  speechRate: number;
  onSpeechRateChange: (rate: number) => void;

  // Color inversion
  isInverted: boolean;
  onInvertChange: (inverted: boolean) => void;

  // Theme
  theme: 'light' | 'dark';

  // Additional header actions
  showNotesPanel?: boolean;
  onToggleNotes?: () => void;
  showMultimodalPanel?: boolean;
  onToggleMultimodal?: () => void;
  documentId?: string | null;
}

export const PDFReaderSettings: React.FC<PDFReaderSettingsProps> = ({
  availableVoices,
  selectedVoice,
  isLoadingVoices,
  onVoiceChange,
  speechRate,
  onSpeechRateChange,
  isInverted,
  onInvertChange,
  theme,
  showNotesPanel = false,
  onToggleNotes,
  showMultimodalPanel = false,
  onToggleMultimodal,
  documentId = null,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  // Ambient sound state
  const [selectedAmbient, setSelectedAmbient] = useState<string>(() => {
    try {
      return localStorage.getItem('pdf_ambient_sound') || 'none';
    } catch {
      return 'none';
    }
  });
  const [ambientVolume, setAmbientVolume] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('pdf_ambient_volume');
      if (saved) {
        const parsed = parseFloat(saved);
        // Ensure volume is a finite number between 0 and 1
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return 0.3;
  });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fadeIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Helper to safely set volume (must be finite number 0-1)
  const safeSetVolume = useCallback((audio: HTMLAudioElement, vol: number) => {
    audio.volume = Number.isFinite(vol) ? Math.max(0, Math.min(1, vol)) : 0.3;
  }, []);

  // Initialize audio element
  useEffect(() => {
    audioRef.current = new Audio();
    audioRef.current.loop = true;
    safeSetVolume(audioRef.current, ambientVolume);

    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
        audioRef.current = null;
      }
      if (fadeIntervalRef.current) {
        clearInterval(fadeIntervalRef.current);
      }
    };
  }, [safeSetVolume, ambientVolume]);

  // Handle ambient sound change
  const handleAmbientChange = useCallback((soundId: string) => {
    setSelectedAmbient(soundId);
    localStorage.setItem('pdf_ambient_sound', soundId);

    if (!audioRef.current) return;

    const sound = AMBIENT_SOUNDS.find(s => s.id === soundId);

    if (!sound || sound.id === 'none' || !sound.url) {
      // Fade out current sound
      if (fadeIntervalRef.current) {
        clearInterval(fadeIntervalRef.current);
      }

      const fadeOut = () => {
        if (!audioRef.current) return;
        if (audioRef.current.volume > 0.05) {
          safeSetVolume(audioRef.current, audioRef.current.volume - 0.05);
        } else {
          if (fadeIntervalRef.current) {
            clearInterval(fadeIntervalRef.current);
          }
          audioRef.current.pause();
          audioRef.current.src = '';
          safeSetVolume(audioRef.current, ambientVolume);
        }
      };

      fadeIntervalRef.current = setInterval(fadeOut, 50);
    } else {
      // Play new sound with fade in
      audioRef.current.src = sound.url;
      safeSetVolume(audioRef.current, 0);
      audioRef.current.play().catch(err => {
        console.warn('Failed to play ambient sound:', err);
      });

      if (fadeIntervalRef.current) {
        clearInterval(fadeIntervalRef.current);
      }

      const targetVolume = Number.isFinite(ambientVolume) ? ambientVolume : 0.3;
      const fadeIn = () => {
        if (!audioRef.current) return;
        if (audioRef.current.volume < targetVolume - 0.05) {
          safeSetVolume(audioRef.current, audioRef.current.volume + 0.05);
        } else {
          safeSetVolume(audioRef.current, targetVolume);
          if (fadeIntervalRef.current) {
            clearInterval(fadeIntervalRef.current);
          }
        }
      };

      fadeIntervalRef.current = setInterval(fadeIn, 50);
    }
  }, [ambientVolume, safeSetVolume]);

  // Handle ambient volume change
  const handleAmbientVolumeChange = useCallback((value: number[]) => {
    const vol = value[0];
    // Ensure volume is valid before saving and applying
    const safeVol = Number.isFinite(vol) ? Math.max(0, Math.min(1, vol)) : 0.3;
    setAmbientVolume(safeVol);
    localStorage.setItem('pdf_ambient_volume', safeVol.toString());

    if (audioRef.current && selectedAmbient !== 'none') {
      safeSetVolume(audioRef.current, safeVol);
    }
  }, [selectedAmbient, safeSetVolume]);

  // Resume ambient sound when popover opens (if one was selected)
  useEffect(() => {
    if (selectedAmbient !== 'none' && audioRef.current) {
      const sound = AMBIENT_SOUNDS.find(s => s.id === selectedAmbient);
      if (sound && sound.url && audioRef.current.paused) {
        audioRef.current.src = sound.url;
        safeSetVolume(audioRef.current, ambientVolume);
        // Don't auto-play - let user click to start
      }
    }
  }, [selectedAmbient, ambientVolume, safeSetVolume]);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          data-testid="pdf-reader-settings-button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title={t('pdfViewer.readerSettings', 'Reader settings')}
        >
          <MoreVertical size={16} className="text-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        // Above the EPUB / PDF drawer (1700, boosts to 9999 when focused)
        // and the floating-panel layer (z-[10002]). See ../CLAUDE.md §24.
        className="w-[min(22rem,calc(100vw-1rem))] p-0 z-[10003]"
        align="end"
        side="bottom"
        sideOffset={8}
        collisionPadding={8}
        // Re-measure on every animation frame: the gear button rides
        // a `fixed` drawer that translates in from the right, and the
        // default 'optimized' strategy snapshots the trigger's rect
        // before the slide finishes — anchoring the popover to the
        // off-screen position and dropping it at viewport (0,0).
        updatePositionStrategy="always"
        style={{
          backgroundColor: theme === 'light'
            ? 'var(--pdf-light-background, hsl(var(--background)))'
            : 'var(--pdf-dark-background, hsl(var(--background)))',
        }}
      >
        <div className="p-4 space-y-5">
          {/* Header */}
          <div className="flex items-center gap-2">
            <div className="w-1 h-4 bg-primary rounded-full" />
            <span className="text-sm font-semibold text-foreground">
              {t('pdfViewer.readerSettings', 'Reader Settings')}
            </span>
          </div>

          {/* Section: Text-to-Speech */}
          <div className="space-y-3">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t('pdfViewer.textToSpeech', 'Text-to-Speech')}
            </div>

            {/* Voice Selection */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Volume2 size={13} />
                <span>{t('pdfViewer.voice', 'Voice')}</span>
              </div>
              <Select
                value={selectedVoice}
                onValueChange={onVoiceChange}
                disabled={isLoadingVoices}
              >
                <SelectTrigger className="h-8 text-xs bg-muted/30 border-border/50">
                  <SelectValue placeholder={t('pdfViewer.selectVoice', 'Select voice...')} />
                </SelectTrigger>
                <SelectContent className="z-[10004] max-h-48">
                  {availableVoices.map(voice => (
                    <SelectItem key={voice.name} value={voice.name} className="text-xs">
                      {voice.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Speech Rate */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <Gauge size={13} />
                  <span>{t('pdfViewer.speechRate', 'Speed')}</span>
                </div>
                <span className="font-medium">{speechRate.toFixed(1)}x</span>
              </div>
              <Slider
                value={[speechRate]}
                onValueChange={(value) => onSpeechRateChange(value[0])}
                min={0.5}
                max={2.0}
                step={0.1}
                className="w-full"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
                <span>0.5x</span>
                <span>1.0x</span>
                <span>2.0x</span>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-border" />

          {/* Section: Display */}
          <div className="space-y-3">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t('pdfViewer.display', 'Display')}
            </div>

            {/* Color Inversion */}
            <div className="flex items-center justify-between py-1">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <Moon size={15} className="text-muted-foreground" />
                <span>{t('pdfViewer.invertColors', 'Invert colors')}</span>
              </div>
              <Switch
                checked={isInverted}
                onCheckedChange={onInvertChange}
                className="scale-90"
              />
            </div>

            {/* Ambient Sounds */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Music size={13} />
                <span>{t('pdfViewer.ambientSound', 'Ambient sound')}</span>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {AMBIENT_SOUNDS.map(sound => {
                  const Icon = sound.icon;
                  const isSelected = selectedAmbient === sound.id;
                  return (
                    <button
                      key={sound.id}
                      onClick={() => handleAmbientChange(sound.id)}
                      className={`flex flex-col items-center justify-center p-2 rounded-lg transition-all ${
                        isSelected
                          ? 'bg-primary/20 border border-primary/50 text-primary shadow-sm'
                          : 'bg-muted/20 border border-transparent hover:bg-muted/40 text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Icon size={15} />
                      <span className="text-[10px] mt-0.5">{sound.name}</span>
                    </button>
                  );
                })}
              </div>

              {/* Ambient Volume (only show when ambient is playing) */}
              {selectedAmbient !== 'none' && (
                <div className="pt-1.5">
                  <div className="flex items-center gap-2">
                    <VolumeX size={11} className="text-muted-foreground flex-shrink-0" />
                    <Slider
                      value={[ambientVolume]}
                      onValueChange={handleAmbientVolumeChange}
                      min={0}
                      max={1}
                      step={0.05}
                      className="flex-1"
                    />
                    <Volume2 size={11} className="text-muted-foreground flex-shrink-0" />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Divider before panels */}
          {documentId && (
            <div className="border-t border-border" />
          )}

          {/* Section: Panels & Actions - horizontal row */}
          {documentId && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t('pdfViewer.panels', 'Panels')} & {t('pdfViewer.actions', 'Actions')}
              </div>

              <div className="flex gap-1">
                {/* Document Notes Toggle */}
                {onToggleNotes && (
                  <button
                    onClick={() => {
                      onToggleNotes();
                      setIsOpen(false);
                    }}
                    className={`relative flex-1 flex items-center justify-center px-2 py-2 rounded-lg transition-all ${
                      showNotesPanel
                        ? 'bg-primary/20 text-primary border border-primary/50 shadow-sm'
                        : 'bg-muted/20 border border-transparent hover:bg-muted/40 text-foreground'
                    }`}
                    title={t('pdfViewer.notes.toggle', 'Document Notes')}
                  >
                    <StickyNote size={16} />
                    {showNotesPanel && (
                      <Circle size={5} className="fill-current absolute bottom-1 right-1.5" />
                    )}
                  </button>
                )}

                {/* Multimodal Panel Toggle */}
                {onToggleMultimodal && (
                  <button
                    onClick={() => {
                      onToggleMultimodal();
                      setIsOpen(false);
                    }}
                    className={`relative flex-1 flex items-center justify-center px-2 py-2 rounded-lg transition-all ${
                      showMultimodalPanel
                        ? 'bg-primary/20 text-primary border border-primary/50 shadow-sm'
                        : 'bg-muted/20 border border-transparent hover:bg-muted/40 text-foreground'
                    }`}
                    title={t('pdfViewer.multimodal.toggle', 'Visual entities')}
                  >
                    <Image size={16} />
                    {showMultimodalPanel && (
                      <Circle size={5} className="fill-current absolute bottom-1 right-1.5" />
                    )}
                  </button>
                )}

                {/* Annotation Comment Search */}
                <button
                  onClick={() => {
                    const trigger = document.querySelector('[data-testid="annotation-comment-search-trigger"]') as HTMLButtonElement;
                    trigger?.click();
                    setIsOpen(false);
                  }}
                  className="flex-1 flex items-center justify-center px-2 py-2 rounded-lg transition-all bg-muted/20 border border-transparent hover:bg-muted/40 text-foreground"
                  title={t('pdfViewer.annotationCommentSearch', 'Search comments')}
                >
                  <Search size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default PDFReaderSettings;
