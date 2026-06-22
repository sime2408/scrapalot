import { Send, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useIsMobileOrTabletPortrait } from '@/hooks/use-mobile';

interface ChatInputSendProps {
  onSend: () => void;
  onCancel?: () => void;
  disabled: boolean;
  isLoading: boolean;
  sendText?: string;
  cancelText?: string;
}

export const ChatInputSend = ({
  onSend,
  onCancel,
  disabled,
  isLoading,
  sendText,
  cancelText,
}: ChatInputSendProps) => {
  const { t } = useTranslation();
  const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();

  return (
    <div className='flex items-center justify-center h-full no-mobile-scale'>
      <button
        data-testid="chat-send-button"
        onClick={isLoading ? onCancel : onSend}
        disabled={isLoading ? false : disabled}
        style={isMobileOrTabletPortrait ? { width: 44, height: 44, minWidth: 44, minHeight: 44, maxWidth: 44, maxHeight: 44 } : undefined}
        className={cn(
          'group relative flex items-center justify-center shrink-0 no-mobile-scale',
          'transition-colors duration-300 ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:ring-offset-2',
          // Size: larger on mobile for better touch targets
          isMobileOrTabletPortrait ? 'h-11 w-11' : 'h-9 w-9',
          // State-based styling
          isLoading
            ? cn(
                'bg-destructive/10 hover:bg-destructive/15',
                'border border-destructive/20 hover:border-destructive/30',
                'text-destructive',
                'hover:shadow-sm hover:shadow-destructive/5'
              )
            : disabled
              ? cn(
                  'bg-muted/30',
                  'border border-border/20',
                  'text-muted-foreground/40',
                  'cursor-not-allowed opacity-40'
                )
              : cn(
                  'bg-primary/5 hover:bg-primary/10',
                  'border border-primary/10 hover:border-primary/20',
                  'text-primary',
                  'hover:shadow-sm hover:shadow-primary/5'
                )
        )}
        title={
          isLoading
            ? cancelText || t('chat-toolbar.cancel')
            : sendText || t('chat-toolbar.send')
        }
        aria-label={
          isLoading
            ? cancelText || t('chat-toolbar.cancel')
            : disabled
              ? t('general.loading')
              : sendText || t('chat-toolbar.send')
        }
      >
        {/* Subtle fill on hover */}
        <span
          className={cn(
            'absolute inset-0',
            isLoading ? 'bg-destructive/5' : 'bg-primary/5',
            'opacity-0 group-hover:opacity-100',
            'transition-opacity duration-500 ease-out'
          )}
        />

        {/* Icon */}
        <span className="relative flex items-center justify-center">
          {isLoading ? (
            <Square
              className={cn(
                'fill-current transition-transform duration-300 group-hover:scale-110',
                isMobileOrTabletPortrait ? 'h-4 w-4' : 'h-3.5 w-3.5'
              )}
              strokeWidth={0}
            />
          ) : (
            <Send
              className={cn(
                'translate-x-[1px] transition-transform duration-300 group-hover:scale-110',
                isMobileOrTabletPortrait ? 'h-5 w-5' : 'h-4 w-4'
              )}
              strokeWidth={2}
            />
          )}
        </span>

        <span className='sr-only'>
          {isLoading
            ? cancelText || t('chat-toolbar.cancel')
            : disabled
              ? t('general.loading')
              : sendText || t('chat-toolbar.send')}
        </span>
      </button>
    </div>
  );
};
