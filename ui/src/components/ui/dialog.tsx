import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X, Maximize2, Minimize2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';

// Global flag to prevent cleanup-triggered history.back() from cascading to parent dialogs
// When true, popstate handlers should ignore the event
const isCleanupHistoryBack = false;

const Dialog = ({ ...props }: DialogPrimitive.DialogProps) => (
  <DialogPrimitive.Root {...props}>{props.children}</DialogPrimitive.Root>
);

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => {
  React.useEffect(() => {
    // Ensure browser extensions and admin debug button remain clickable when dialog is open
    const extensionElements = document.querySelectorAll(
      '.toolbar-container, [class*="toolbar-container"], [data-extension], [data-testid*="extension"], div[id*="extension"], div[class*="extension-"]'
    );

    extensionElements.forEach((element) => {
      const htmlElement = element as HTMLElement;
      htmlElement.style.zIndex = '10000';
      htmlElement.style.pointerEvents = 'auto';
      htmlElement.style.position = 'relative';
    });

    // Ensure admin debug button and modal remain clickable when dialog is open
    const adminDebugButton = document.getElementById('admin-debug-btn-standalone');
    if (adminDebugButton) {
      adminDebugButton.style.pointerEvents = 'auto';
      adminDebugButton.style.zIndex = '2147483647'; // Max z-index
    }

    const adminDebugModal = document.getElementById('admin-debug-modal-standalone');
    if (adminDebugModal) {
      adminDebugModal.style.pointerEvents = 'auto';
      adminDebugModal.style.zIndex = '2147483647'; // Max z-index
    }

    return () => {
      // Cleanup: restore original styles
      extensionElements.forEach((element) => {
        const htmlElement = element as HTMLElement;
        // Only reset if we set these values
        if (htmlElement.style.zIndex === '10000') {
          htmlElement.style.zIndex = '';
          htmlElement.style.pointerEvents = '';
          htmlElement.style.position = '';
        }
      });
    };
  }, []);

  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        'fixed inset-0 z-[70] bg-black/50 backdrop-blur-[2px] dark:bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 pointer-events-none',
        className
      )}
      style={{
        // Additional CSS to ensure extensions work properly
        ...props.style,
        // Default raised to 10100 — Notes drawer in full / focused
        // mode reaches z-9999 (see notes-drawer.tsx zIndex calc), so
        // the previous 70 left dialogs trapped underneath. Callers
        // can still override via overlayZIndex / the CSS var.
        zIndex: 'var(--dialog-overlay-z-index, 10100)'
      }}
      {...props}
    />
  );
});
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    hideCloseButton?: boolean;
    onOpenChange?: (open: boolean) => void;
    disableBackdropClose?: boolean;
    overlayZIndex?: string;
    /** Additional className for the overlay (e.g., transparent in split-screen mode) */
    overlayClassName?: string;
    disableFullscreenOnMobile?: boolean;
    /** Force mobile back button behavior even on larger screens (for fullscreen dialogs) */
    forceMobileBackButton?: boolean;
    /** Disable pointer events on overlay and content (e.g., when PDF/EPUB viewer is open) */
    disablePointerEvents?: boolean;
    /** Enable maximize/minimize functionality */
    allowMaximize?: boolean;
    /** Controlled maximize state */
    isMaximized?: boolean;
    /** Callback when maximize state changes */
    onMaximizeChange?: (maximized: boolean) => void;
    /** Dialog open state - used to reset history state when dialog closes */
    dialogOpen?: boolean;
  }
>(
  (
    {
      className,
      children,
      hideCloseButton = false,
      onOpenChange,
      disableBackdropClose = false,
      overlayZIndex,
      overlayClassName,
      disableFullscreenOnMobile = false,
      forceMobileBackButton = false,
      disablePointerEvents = false,
      allowMaximize = false,
      isMaximized: controlledMaximized,
      onMaximizeChange,
      dialogOpen,
      ...props
    },
    ref
  ) => {
    const isMobile = useIsMobile();
    const shouldUseFullscreen = isMobile && !disableFullscreenOnMobile;
    // Use mobile back button behavior if on mobile OR if forced (for fullscreen dialogs on tablets)
    const shouldUseMobileBackButton = isMobile || forceMobileBackButton;

    // Internal state for uncontrolled maximize mode
    const [internalMaximized, setInternalMaximized] = React.useState(false);
    const isMaximized = controlledMaximized !== undefined ? controlledMaximized : internalMaximized;
    const handleMaximizeToggle = () => {
      const newValue = !isMaximized;
      if (onMaximizeChange) {
        onMaximizeChange(newValue);
      } else {
        setInternalMaximized(newValue);
      }
    };

    // Track if we've pushed a history state to avoid duplicates
    const historyPushedRef = React.useRef(false);
    // Unique ID for this dialog instance to avoid conflicts with nested dialogs
    const dialogIdRef = React.useRef(`dialog-${Math.random().toString(36).slice(2, 11)}`);

    // Store onOpenChange in a ref to avoid triggering effect re-runs
    const onOpenChangeRef = React.useRef(onOpenChange);
    onOpenChangeRef.current = onOpenChange;

    // Reset history state when dialog closes
    React.useEffect(() => {
      if (dialogOpen === false && historyPushedRef.current) {
        // Dialog closed - reset the flag so next open will push new history entry
        historyPushedRef.current = false;
      }
    }, [dialogOpen]);

    // Singleton-dialog policy: when this dialog opens, broadcast a
    // window event with its instance id. Other mounted dialogs listen
    // for the event and close themselves if the id is NOT theirs.
    // Tabs inside the same dialog stay live because they reuse the
    // same instance id (Radix Dialog only mounts one DialogContent per
    // Dialog root). The exception channel `data-no-singleton="true"`
    // on the dialog content opts out (used for nested confirmation
    // dialogs that shouldn't kill their parent).
    React.useEffect(() => {
      if (dialogOpen !== true) return;
      const myId = dialogIdRef.current;
      // Announce that I'm now the active dialog.
      window.dispatchEvent(
        new CustomEvent('scrapalot:dialog-opened', { detail: { id: myId } }),
      );
      // Listen for future openings — if someone else opens, close me.
      const onAnotherOpened = (e: Event) => {
        const otherId = (e as CustomEvent).detail?.id;
        if (otherId && otherId !== myId) {
          if (onOpenChangeRef.current) {
            onOpenChangeRef.current(false);
          }
        }
      };
      window.addEventListener('scrapalot:dialog-opened', onAnotherOpened);
      return () => {
        window.removeEventListener('scrapalot:dialog-opened', onAnotherOpened);
      };
    }, [dialogOpen]);

    React.useEffect(() => {
      if (shouldUseMobileBackButton) {
        const dialogId = dialogIdRef.current;

        // Mobile/Fullscreen: Allow dismissal via back button
        const handlePopState = () => {
          // Ignore if this is a cleanup-triggered history.back() from another dialog
          if (isCleanupHistoryBack) {
            return;
          }
          // Only handle if we pushed a history state for this dialog
          if (!historyPushedRef.current) {
            return;
          }
          // Close the dialog
          historyPushedRef.current = false;
          if (onOpenChangeRef.current) {
            onOpenChangeRef.current(false);
          } else {
            const closeButton = document.querySelector(
              '[data-state="open"] button[aria-label="Close"], [data-state="open"] button:has(.lucide-x)'
            );
            if (closeButton instanceof HTMLElement) {
              closeButton.click();
            }
          }
        };

        // Only add history entry when dialog is open and we haven't pushed yet
        if (dialogOpen && !historyPushedRef.current) {
          window.history.pushState({ dialogOpen: true, dialogId }, '');
          historyPushedRef.current = true;
        }

        window.addEventListener('popstate', handlePopState);

        return () => {
          window.removeEventListener('popstate', handlePopState);
          // Don't call history.back() here - it causes the dialog to close immediately
          // The history entry will be cleaned up naturally when user navigates
        };
      } else {
        // Desktop: Only allow dismissal via Escape key (X button is handled by Radix)
        const handleKeyDown = (event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            if (onOpenChange) {
              onOpenChange(false);
            } else {
              const closeButton = document.querySelector(
                '[data-state="open"] button[aria-label="Close"], [data-state="open"] button:has(.lucide-x)'
              );
              if (closeButton instanceof HTMLElement) {
                closeButton.click();
              }
            }
          }
        };

        document.addEventListener('keydown', handleKeyDown);

        return () => {
          document.removeEventListener('keydown', handleKeyDown);
        };
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    }, [shouldUseMobileBackButton, dialogOpen]);

    // Use a stable container ref to avoid portal mounting issues
    const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);

    React.useEffect(() => {
      setPortalContainer(document.body);
    }, []);

    // Measure the dialog content's bounding rect so the floating action
    // buttons (maximize / close) can be rendered as a fixed-positioned
    // SIBLING of the content. Rendering them inside the content gets them
    // clipped whenever a caller passes `overflow-hidden` (e.g. CommandDialog,
    // any dialog with rounded scrollable inner regions). Floating outside
    // the content is the canonical Scrapalot dialog look (see settings.tsx
    // which works only because it adds `overflow-visible`); doing the
    // measurement here makes that look the default for every dialog
    // regardless of overflow.
    //
    // The content node is tracked as STATE (not a ref) so the layout
    // effect re-runs the moment Radix attaches the DOM node via the
    // callback ref. A plain ref keeps a mutable value but does not
    // trigger any subscriber to re-evaluate, which left `contentBox`
    // stuck at null on first mount inside a Portal.
    const [contentNode, setContentNode] = React.useState<HTMLDivElement | null>(null);
    const [contentBox, setContentBox] = React.useState<DOMRect | null>(null);
    const handleContentRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        setContentNode(node);
        if (typeof ref === 'function') {
          ref(node);
        } else if (ref) {
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }
      },
      [ref]
    );

    React.useLayoutEffect(() => {
      if (!contentNode) {
        setContentBox(null);
        return;
      }
      const update = () => {
        setContentBox(contentNode.getBoundingClientRect());
      };
      update();
      const ro = new ResizeObserver(update);
      ro.observe(contentNode);
      window.addEventListener('resize', update);
      // capture-phase scroll listener picks up scroll on any ancestor
      // (drawers, scrollable panels) so the floating buttons stay glued
      // to the dialog corner if anything beneath shifts.
      window.addEventListener('scroll', update, true);
      // Radix's open animation (`animate-in slide-in-from-top-[48%]`)
      // animates `transform`, which leaves width/height stable but
      // shifts `top` / `left`. ResizeObserver only fires on size
      // changes, so without these listeners the floating buttons render
      // at the mid-animation position and never catch up. animationend
      // fires when the slide settles; the staggered timeouts are a
      // safety net for browsers that batch the event after paint.
      contentNode.addEventListener('animationend', update);
      contentNode.addEventListener('transitionend', update);
      const timeouts = [120, 260, 420].map(ms => window.setTimeout(update, ms));
      return () => {
        ro.disconnect();
        window.removeEventListener('resize', update);
        window.removeEventListener('scroll', update, true);
        contentNode.removeEventListener('animationend', update);
        contentNode.removeEventListener('transitionend', update);
        timeouts.forEach(t => window.clearTimeout(t));
      };
    }, [contentNode, isMaximized]);

    const showFloatingButtons =
      !hideCloseButton &&
      !isMobile &&
      typeof window !== 'undefined' &&
      window.innerWidth >= 992;

    return (
      <DialogPortal container={portalContainer}>
        <DialogOverlay
          style={overlayZIndex ? { zIndex: overlayZIndex } : undefined}
          className={cn(
            disablePointerEvents ? 'pointer-events-none' : undefined,
            overlayClassName
          )}
        />
        <DialogPrimitive.Content
          ref={handleContentRef}
          aria-describedby={undefined}
          className={cn(
            'fixed grid gap-4 border duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            // Dense glass surface. An earlier 40%-opacity glass was
            // removed because content behind bled through and killed
            // text contrast; this recipe fixes that with density
            // (85→75% gradient) + saturate instead of going opaque,
            // so semantic foreground colors stay readable in both
            // themes while the dialog still reads as glass.
            'bg-gradient-to-b from-white/90 to-white/80 text-popover-foreground backdrop-blur-xl backdrop-saturate-150 dark:from-zinc-900/85 dark:to-zinc-950/80',
            'border-black/10 shadow-2xl shadow-black/20 dark:border-white/10 dark:shadow-black/60',
            shouldUseFullscreen
              ? 'inset-x-2 inset-y-0 w-auto h-full p-4 overflow-y-auto data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom'
              : isMaximized
                // `!max-w-none !max-h-none` overrides any caller-supplied
                // `max-w-*` / `max-h-*` (e.g. version-history dialog uses
                // `max-w-5xl max-h-[85vh]` to cap the non-maximized size).
                // Without `!` Tailwind's cascade keeps the caller's values
                // active because they appear later in the CSS layer than
                // `max-w-none`, leaving the "maximized" dialog still capped
                // at 1024 × 85vh and visually anchored to the top-left.
                //
                // `m-3 p-3` (12 px each) instead of `m-5 p-4`: keeps
                // the dialog visually distinct from the page behind
                // without surfacing the blurry edge of the underlying
                // notes drawer that the original 20 px ring exposed.
                // It also leaves enough margin for the in-corner
                // Minimize / Close buttons (which we move inside the
                // dialog when maximized — see the buttons block below)
                // to sit comfortably without clipping the viewport.
                ? 'inset-0 m-3 w-auto h-auto !max-w-none !max-h-none p-3 left-0 top-0 translate-x-0 translate-y-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95'
                : 'left-[50%] top-[50%] -translate-x-1/2 -translate-y-1/2 w-auto max-w-lg p-4 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
            className,
            disablePointerEvents && 'pointer-events-none'
          )}
          style={{
            // Default 10101 — overlay default is now 10100 (was 70),
            // dialogs sit above notes drawer's max z-index of 9999.
            zIndex: overlayZIndex ? (parseInt(overlayZIndex) + 1).toString() : '10101',
            ...props.style
          }}
          // Disable backdrop clicks but allow Esc key when disableBackdropClose is true
          onPointerDownOutside={
            disableBackdropClose ? e => e.preventDefault() : undefined
          }
          onInteractOutside={
            disableBackdropClose
              ? e => {
                // Allow Esc key but prevent other interactions
                if (e.detail?.originalEvent?.type !== 'keydown') {
                  e.preventDefault();
                }
              }
              : undefined
          }
          {...props}
        >
          {children}
        </DialogPrimitive.Content>
        {showFloatingButtons && contentBox && (
          <div
            // Floating action buttons are rendered as a SIBLING of the
            // dialog content (not a child) and use `position: fixed` with
            // JS-measured coordinates. This is the only way to make them
            // overflow the dialog corner when the content has
            // `overflow-hidden` (CommandDialog, any rounded scrollable
            // dialog) — an absolutely positioned child with negative
            // offsets is clipped by the content's overflow rule.
            //
            // Each button is `w-8 h-8` (32 px). For the non-maximized
            // case we offset 24 px (3/4 of the button) outside the
            // dialog's top-right corner: 24 px above + 24 px right of
            // the corner, with 8 px overlapping the dialog edge so the
            // button stays visually attached.
            //
            // Maximized state pulls the dialog flush to the viewport
            // (`inset-0 m-3`), so 3/4-outside placement would clip the
            // button at the viewport edge. When maximized we anchor the
            // buttons INSIDE the dialog at 8 px inset.
            data-state='open'
            className='fixed flex items-center gap-2 pointer-events-auto'
            style={{
              top: isMaximized ? contentBox.top + 8 : contentBox.top - 24,
              right: isMaximized
                ? Math.max(0, window.innerWidth - contentBox.right + 8)
                : Math.max(0, window.innerWidth - contentBox.right - 24),
              zIndex: overlayZIndex
                ? (parseInt(overlayZIndex) + 2).toString()
                : '72',
            }}
          >
            {allowMaximize && (
              <button
                onClick={handleMaximizeToggle}
                className='border border-border dark:border-zinc-700 bg-card dark:bg-black p-0 w-8 h-8 flex items-center justify-center hover:bg-muted dark:hover:bg-zinc-900 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
                title={isMaximized ? 'Minimize' : 'Maximize'}
              >
                {isMaximized ? (
                  <Minimize2 className='h-4 w-4 text-zinc-800 dark:text-white' />
                ) : (
                  <Maximize2 className='h-4 w-4 text-zinc-800 dark:text-white' />
                )}
              </button>
            )}
            <DialogPrimitive.Close
              aria-label='Close'
              className='border border-border dark:border-zinc-700 bg-card dark:bg-black p-0 w-8 h-8 flex items-center justify-center hover:bg-muted dark:hover:bg-zinc-900 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
            >
              <X className='h-4 w-4 text-zinc-800 dark:text-white' />
              <span className='sr-only'>Close</span>
            </DialogPrimitive.Close>
          </div>
        )}
      </DialogPortal>
    );
  }
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col space-y-1.5 text-center sm:text-left',
      className
    )}
    {...props}
  />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      // gap-2 (not space-x) so the buttons keep breathing room in the
      // mobile column stack as well as the desktop row.
      'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      'text-lg font-semibold leading-none tracking-tight',
      className
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
