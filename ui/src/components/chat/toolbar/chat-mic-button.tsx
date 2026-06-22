/**
 * Microphone button for live speech-to-text in the chat toolbar.
 *
 * States: idle → recording (with live transcript preview) → transcribing → idle
 * The final transcript is inserted into the chat input via onTranscript callback.
 */

import React, { useCallback } from 'react';
import { Mic, MicOff, Loader2, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useAudioRecording } from '@/hooks/use-audio-recording';
import { useTranslation } from 'react-i18next';

interface ChatMicButtonProps {
  /** Called with the final transcript text when recording stops */
  onTranscript: (text: string) => void;
  /** Language hint for STT (e.g., "en", "hr") */
  language?: string;
  /** Whether the button is disabled */
  disabled?: boolean;
}

export function ChatMicButton({
  onTranscript,
  language,
  disabled = false,
}: ChatMicButtonProps) {
  const { t } = useTranslation();
  const {
    recordingState,
    transcriptText,
    committedText,
    mutableText,
    error,
    isSupported,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useAudioRecording();

  const handleClick = useCallback(async () => {
    if (recordingState === 'idle') {
      await startRecording(language);
    } else if (recordingState === 'recording') {
      const text = await stopRecording();
      if (text.trim()) {
        onTranscript(text.trim());
      }
    }
  }, [recordingState, startRecording, stopRecording, language, onTranscript]);

  const handleCancel = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      cancelRecording();
    },
    [cancelRecording]
  );

  if (!isSupported) return null;

  const isRecording = recordingState === 'recording';
  const isTranscribing = recordingState === 'transcribing';
  const isActive = isRecording || isTranscribing;

  return (
    <div className='relative flex items-center'>
      {/* Live transcript preview */}
      {isActive && transcriptText && (
        <div className='absolute bottom-full right-0 mb-2 w-64 max-h-24 overflow-y-auto p-2 text-xs bg-card border border-border shadow-sm z-50'>
          <span className='text-foreground'>{committedText}</span>
          {mutableText && (
            <span className='text-muted-foreground italic'> {mutableText}</span>
          )}
        </div>
      )}

      {/* Error tooltip */}
      {error && recordingState === 'error' && (
        <div className='absolute bottom-full right-0 mb-2 w-56 p-2 text-xs bg-destructive/10 text-destructive border border-destructive/20 z-50'>
          {error}
        </div>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            data-testid='chat-mic-button'
            variant='ghost'
            size='icon'
            className={cn(
              'h-8 w-8 flex-shrink-0',
              isRecording && 'text-red-500 hover:text-red-600 bg-red-50 dark:bg-red-950/30',
              isTranscribing && 'text-primary'
            )}
            disabled={disabled || isTranscribing}
            onClick={handleClick}
            onMouseDown={(e) => e.preventDefault()}
          >
            {isTranscribing ? (
              <Loader2 className='h-4 w-4 animate-spin' />
            ) : isRecording ? (
              <Square className='h-3.5 w-3.5 fill-current' />
            ) : (
              <Mic className='h-4 w-4' />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side='top'>
          {isRecording
            ? t('chat.mic.stopRecording', 'Stop recording')
            : isTranscribing
              ? t('chat.mic.transcribing', 'Transcribing...')
              : t('chat.mic.startRecording', 'Voice input')}
        </TooltipContent>
      </Tooltip>

      {/* Cancel button when recording */}
      {isRecording && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant='ghost'
              size='icon'
              className='h-8 w-8 flex-shrink-0 text-muted-foreground hover:text-destructive'
              onClick={handleCancel}
              onMouseDown={(e) => e.preventDefault()}
            >
              <MicOff className='h-4 w-4' />
            </Button>
          </TooltipTrigger>
          <TooltipContent side='top'>
            {t('chat.mic.cancel', 'Cancel recording')}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Recording indicator pulse */}
      {isRecording && (
        <span className='absolute -top-0.5 -right-0.5 h-2 w-2'>
          <span className='absolute inline-flex h-full w-full animate-ping bg-red-400 rounded-full opacity-75' />
          <span className='relative inline-flex h-2 w-2 bg-red-500 rounded-full' />
        </span>
      )}
    </div>
  );
}
