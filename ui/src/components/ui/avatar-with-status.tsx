import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface AvatarWithStatusProps {
  src?: string;
  alt?: string;
  status?: 'online' | 'offline' | 'typing' | 'none';
  className?: string;
  size?: 'xxs' | 'xs' | 'sm' | 'md' | 'lg';
  fillBackground?: boolean;
}

export const AvatarWithStatus = ({
  src,
  alt = 'Avatar',
  status = 'none',
  className,
  size = 'md',
  fillBackground = false,
}: AvatarWithStatusProps) => {
  // Render the <img> directly and let its own error event drive the fallback.
  // The previous new Image() pre-load probe was redundant and unreliable in
  // the Android WebView, where it failed for bundled SVGs and forced every
  // model icon onto the fallback logo.
  const [error, setError] = useState(false);

  useEffect(() => {
    setError(false);
  }, [src]);

  const sizeClasses = {
    xxs: 'w-4 h-4',
    xs: 'w-5 h-5',
    sm: 'w-7 h-7',
    md: 'w-9 h-9',
    lg: 'w-11 h-11',
  };

  const statusSizeClasses = {
    xxs: 'w-1 h-1',
    xs: 'w-1 h-1',
    sm: 'w-1.5 h-1.5',
    md: 'w-2.5 h-2.5',
    lg: 'w-3 h-3',
  };

  const statusColorClasses = {
    online: 'bg-green-500',
    offline: 'bg-gray-400',
    typing: 'bg-blue-400',
    none: 'hidden',
  };

  return (
    <div className='relative inline-block'>
      <div
        className={cn(
          'rounded-full overflow-hidden transition-opacity duration-300',
          sizeClasses[size],
          fillBackground ? 'bg-white' : 'bg-white',
          className
        )}
      >
        {src && !error ? (
          <img
            src={src}
            alt={alt}
            className='w-full h-full object-cover'
            onError={() => setError(true)}
          />
        ) : error ? (
          // Show the default logo when there's an error loading the image
          <img
            src='/logo512.png'
            alt={alt}
            className='w-full h-full object-cover'
          />
        ) : (
          <div className='w-full h-full flex items-center justify-center bg-primary text-primary-foreground font-medium'>
            {alt?.charAt(0)?.toUpperCase() || '?'}
          </div>
        )}
      </div>

      {status !== 'none' && (
        <div
          className={cn(
            'absolute bottom-0 right-0 rounded-full border-2 border-background',
            statusSizeClasses[size],
            statusColorClasses[status]
          )}
        >
          {status === 'typing' && (
            <span className='flex h-full items-center justify-center'>
              <span className='sr-only'>Typing</span>
              <span className='block w-1 h-1 bg-white rounded-full animate-ping'></span>
            </span>
          )}
        </div>
      )}
    </div>
  );
};
