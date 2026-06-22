import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Plus, Settings } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface ChatToolbarNoModelsDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  openSettingsWithTab?: (tab: string) => void;
  className?: string;
}

export const ChatToolbarNoModelsDialog: React.FC<ChatToolbarNoModelsDialogProps> = ({
  isOpen,
  onOpenChange,
  openSettingsWithTab,
  className = 'w-[240px] h-8 justify-start text-sm',
}) => {
  const { t } = useTranslation();

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          data-testid="chat-no-models-button"
          variant='outline'
          className={`${className} border-orange-300 dark:border-orange-700 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950`}
        >
          <AlertTriangle className='h-4 w-4 mr-2 flex-shrink-0' />
          <span className='truncate'>
            {t('chatToolbar.noModelsFound')}
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent className='mx-4 max-w-[calc(100vw-2rem)] sm:max-w-md pointer-events-auto h-[270px] my-auto' hideCloseButton={false} aria-describedby='no-models-description'>
        <DialogHeader className='space-y-3'>
          <DialogTitle className='text-center sm:text-left text-lg'>
            {t('chatToolbar.noModelsDialog.title')}
          </DialogTitle>
          <DialogDescription id='no-models-description' className='text-center sm:text-left text-sm leading-relaxed'>
            {t('chatToolbar.noModelsDialog.description')}
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-3 mt-4'>
          <Button
            data-testid="chat-no-models-add-provider-button"
            onClick={() => {
              openSettingsWithTab?.('remote-providers');
              onOpenChange(false);
            }}
            className='flex items-center justify-center sm:justify-start gap-3 h-10 font-medium'
          >
            <Plus className='h-4 w-4 flex-shrink-0' />
            <span>
              {t('chatToolbar.noModelsDialog.addRemoteProvider')}
            </span>
          </Button>
          <Button
            data-testid="chat-no-models-local-ai-button"
            variant='outline'
            onClick={() => {
              openSettingsWithTab?.('local-ai');
              onOpenChange(false);
            }}
            className='flex items-center justify-center sm:justify-start gap-3 h-10 font-medium'
          >
            <Settings className='h-4 w-4 flex-shrink-0' />
            <span>
              {t('chatToolbar.noModelsDialog.configureLocalAI')}
            </span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
