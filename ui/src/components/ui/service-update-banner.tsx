import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function ServiceUpdateBanner() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const show = () => setVisible(true);
    const hide = () => setVisible(false);

    window.addEventListener('serviceUpdating', show);
    window.addEventListener('serviceUpdateDone', hide);
    return () => {
      window.removeEventListener('serviceUpdating', show);
      window.removeEventListener('serviceUpdateDone', hide);
    };
  }, []);

  if (!visible) return null;

  return (
    <div className='fixed top-0 left-0 right-0 z-[10100] bg-blue-100/80 dark:bg-blue-900/80 backdrop-blur-sm px-4 py-2 border-b border-blue-200/50 dark:border-blue-800/50 pointer-events-none'>
      <div className='flex items-center justify-center max-w-screen-xl mx-auto space-x-2'>
        <RefreshCw className='h-4 w-4 text-blue-700 dark:text-blue-300 animate-spin' />
        <p className='text-sm text-blue-800 dark:text-blue-200'>
          {t('serviceUpdateBanner.message')}
        </p>
      </div>
    </div>
  );
}
