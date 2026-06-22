import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/use-auth';
import { Wifi, WifiOff } from 'lucide-react';

export function OfflineModeBanner() {
  const { t } = useTranslation();
  const { isOfflineMode, enableOfflineMode } = useAuth();

  if (!isOfflineMode) return null;

  return (
    <div className='fixed top-0 left-0 right-0 z-50 bg-yellow-100/80 dark:bg-yellow-900/80 backdrop-blur-sm px-4 py-2 pointer-events-none'>
      {/* Centered + pointer-events-none so the strip is click-through;
          only the reconnect button re-enables pointer events, kept in
          the center to leave the corner header controls reachable. */}
      <div className='flex items-center justify-center gap-3 max-w-screen-xl mx-auto'>
        <div className='flex items-center space-x-2 min-w-0'>
          <WifiOff className='h-5 w-5 text-yellow-700 dark:text-yellow-300' />
          <p className='text-sm text-yellow-800 dark:text-yellow-200'>
            <span className='font-semibold'>
              {t('offlineModeBanner.title')}
            </span>{' '}
            {t('offlineModeBanner.message')}
          </p>
        </div>

        <button
          onClick={() => enableOfflineMode(false)}
          className='pointer-events-auto shrink-0 flex items-center text-xs bg-yellow-200 dark:bg-yellow-800 hover:bg-yellow-300 dark:hover:bg-yellow-700 px-3 py-1 rounded text-yellow-800 dark:text-yellow-200'
        >
          <Wifi className='h-3 w-3 mr-1' />
          {t('offlineModeBanner.reconnect')}
        </button>
      </div>
    </div>
  );
}
