import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';

import { cn } from '@/lib/utils';

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      'relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full',
      className
    )}
    {...props}
  />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image> & {
    /**
     * Optional fallback source tried when `src` fails to load. Used for
     * local-first profile pictures: serve from the local host, fall back to
     * production when the file is not present locally. See `profilePicSources`.
     */
    fallbackSrc?: string;
  }
>(({ className, src, fallbackSrc, onLoadingStatusChange, ...props }, ref) => {
  const [active, setActive] = React.useState(src);
  // Reset to the primary src whenever it changes (e.g. cache-buster bump).
  React.useEffect(() => setActive(src), [src]);
  return (
    <AvatarPrimitive.Image
      ref={ref}
      src={active}
      onLoadingStatusChange={(status) => {
        if (status === 'error' && fallbackSrc && active !== fallbackSrc) {
          setActive(fallbackSrc);
        }
        onLoadingStatusChange?.(status);
      }}
      className={cn('aspect-square h-full w-full', className)}
      {...props}
    />
  );
});
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      'flex h-full w-full items-center justify-center rounded-full bg-muted',
      className
    )}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

export { Avatar, AvatarImage, AvatarFallback };
