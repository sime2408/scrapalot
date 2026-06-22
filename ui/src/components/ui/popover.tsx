import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import { cn } from '@/lib/utils';

interface PopoverProps extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Root> {
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  disableBlur?: boolean;
  modal?: boolean;
  open?: boolean;
}

const Popover = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Root>,
  PopoverProps
>(({ onOpenChange, children, disableBlur = true, modal = false, open: controlledOpen, ...props }, _ref) => {
  const [internalOpen, setInternalOpen] = React.useState(false);

  // Support both controlled and uncontrolled modes
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;

  const handleOpenChange = (newOpen: boolean) => {
    if (!isControlled) {
      setInternalOpen(newOpen);
    }
    onOpenChange?.(newOpen);
  };

  // For now, keep popover behavior consistent across all devices
  // Future enhancement: could add drawer mode with a prop flag

  return (
    <PopoverPrimitive.Root
      open={isOpen}
      onOpenChange={handleOpenChange}
      modal={modal}
      {...props}
    >
      {children}
      {isOpen && !disableBlur && (
        <div className="fixed inset-0 bg-black/20 dark:bg-black/40 z-40" />
      )}
    </PopoverPrimitive.Root>
  );
});

Popover.displayName = 'Popover';

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverAnchor = PopoverPrimitive.Anchor;


interface PopoverContentProps extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  title?: string;
  description?: string;
  showMobileHeader?: boolean;
}

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  PopoverContentProps
>(({
  className,
  align = 'center',
  sideOffset = 8,
  side = 'bottom',
  title,
  description,
  showMobileHeader = false,
  children,
  ...props
}, ref) => {
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);

  // Ensure portal container exists before rendering to prevent insertBefore errors
  React.useEffect(() => {
    setPortalContainer(document.body);
  }, []);

  if (!portalContainer) {
    return null;
  }

  return (
    <PopoverPrimitive.Portal container={portalContainer}>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          // Base styles - z-[80] to appear above dialogs (z-71)
          'z-[80] min-w-[200px] max-w-[500px] rounded-md border border-border bg-popover text-popover-foreground text-sm shadow-lg outline-none',
          // Responsive max-width
          'w-auto max-w-[calc(100vw-1rem)]',
          // Animations
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          // Side-specific slide animations
          'data-[side=bottom]:slide-in-from-top-2',
          'data-[side=left]:slide-in-from-right-2',
          'data-[side=right]:slide-in-from-left-2',
          'data-[side=top]:slide-in-from-bottom-2',
          // Responsive adjustments
          'sm:max-w-[500px]',
          className
        )}
        onCloseAutoFocus={(e) => {
          // Prevent focus from jumping around
          e.preventDefault();
        }}
        {...props}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
});

PopoverContent.displayName = 'PopoverContent';

// Helper component for consistent popover sections
const PopoverSection = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    title?: string;
    description?: string;
  }
>(({ className, title, description, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('p-4 space-y-3', className)}
    {...props}
  >
    {(title || description) && (
      <div className="space-y-1">
        {title && (
          <h4 className="text-sm font-medium text-foreground">{title}</h4>
        )}
        {description && (
          <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
        )}
      </div>
    )}
    {children}
  </div>
));

PopoverSection.displayName = 'PopoverSection';

// Helper component for popover actions/footer
const PopoverFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'flex items-center justify-end gap-2 px-4 py-3 border-t border-border bg-muted/30',
      className
    )}
    {...props}
  />
));

PopoverFooter.displayName = 'PopoverFooter';

// Helper component for separator
const PopoverSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('h-px bg-border mx-4', className)}
    {...props}
  />
));

PopoverSeparator.displayName = 'PopoverSeparator';

export {
  Popover,
  PopoverTrigger,
  PopoverAnchor,
  PopoverContent,
  PopoverSection,
  PopoverFooter,
  PopoverSeparator
};