import React, { useMemo } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { FileText, Hash, Type, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface PopoverMessageAnalysisProps {
  trigger: React.ReactNode;
  content: string;
}

export const PopoverMessageAnalysis: React.FC<PopoverMessageAnalysisProps> = ({
  trigger,
  content,
}) => {
  const { t } = useTranslation();

  const analysis = useMemo(() => {
    const text = content || '';
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    const charCount = text.length;
    const sentenceCount = text.trim()
      ? (text.match(/[.!?]+(?:\s|$)/g) || []).length || (text.trim() ? 1 : 0)
      : 0;
    const estimatedTokens = Math.ceil(charCount / 4);

    return { wordCount, charCount, sentenceCount, estimatedTokens };
  }, [content]);

  const analysisContent = (
    <div className='space-y-3'>
      <div className='flex items-center gap-3 pb-3 border-b'>
        <FileText className='h-4 w-4' />
        <span className='font-semibold text-base'>
          {t('chat.analysis.title')}
        </span>
      </div>
      <div className='space-y-2'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <Type className='h-3.5 w-3.5 text-muted-foreground' />
            <span className='text-sm text-muted-foreground'>
              {t('chat.analysis.words')}
            </span>
          </div>
          <span className='text-sm font-semibold'>
            {analysis.wordCount.toLocaleString()}
          </span>
        </div>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <Hash className='h-3.5 w-3.5 text-muted-foreground' />
            <span className='text-sm text-muted-foreground'>
              {t('chat.analysis.characters')}
            </span>
          </div>
          <span className='text-sm font-semibold'>
            {analysis.charCount.toLocaleString()}
          </span>
        </div>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <FileText className='h-3.5 w-3.5 text-muted-foreground' />
            <span className='text-sm text-muted-foreground'>
              {t('chat.analysis.sentences')}
            </span>
          </div>
          <span className='text-sm font-semibold'>
            {analysis.sentenceCount.toLocaleString()}
          </span>
        </div>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <Zap className='h-3.5 w-3.5 text-muted-foreground' />
            <span className='text-sm text-muted-foreground'>
              {t('chat.analysis.estimatedTokens')}
            </span>
          </div>
          <span className='text-sm font-semibold'>
            ~{analysis.estimatedTokens.toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <Popover disableBlur={true}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        data-testid="chat-message-analysis-popover"
        className='w-64 max-w-[calc(100vw-2rem)] p-4 z-[9999]'
        side='top'
        align='end'
        sideOffset={8}
        avoidCollisions={true}
        collisionPadding={16}
      >
        {analysisContent}
      </PopoverContent>
    </Popover>
  );
};
