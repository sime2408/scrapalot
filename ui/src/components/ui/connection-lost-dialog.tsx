import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogPortal,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { WifiOff, RefreshCw, X } from 'lucide-react';
import i18n from '@/i18n';
import { API_BASE_URL } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ConnectionLostDialogProps {
  open: boolean;
  onStay: () => void;
  onLogout: () => void;
  retryAttempt?: number;
  nextRetryIn?: number;
  isRetrying?: boolean;
}

const ConnectionLostDialogComponent: React.FC<ConnectionLostDialogProps> = ({
  open,
  onStay,
  onLogout,
  retryAttempt = 0,
  nextRetryIn = 0,
  isRetrying = false,
}) => {
  const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogPortal>
        {/* Custom transparent overlay */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-[1300] bg-transparent pointer-events-none" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[50%] translate-x-[-50%] translate-y-[-50%]",
            "z-[1301] grid w-full max-w-md gap-4 border p-6",
            "bg-white/40 dark:bg-zinc-900/60 backdrop-blur-2xl",
            "border-white/20 dark:border-white/10",
            "shadow-2xl shadow-black/10 dark:shadow-black/30",
            "min-h-[220px]",
            "duration-200",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            "data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]",
            "data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
          )}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (e.detail?.originalEvent?.type !== 'keydown') {
              e.preventDefault();
            }
          }}
        >
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            {isRetrying ? (
              <RefreshCw className="h-6 w-6 text-blue-500 animate-spin" />
            ) : (
              <WifiOff className="h-6 w-6 text-red-500" />
            )}
            <DialogTitle>
              {isRetrying
                ? t('general.errors.connectionLost.retrying')
                : t('general.errors.connectionLost.title')}
            </DialogTitle>
          </div>
          <DialogDescription className="text-left">
            {isRetrying ? (
              <span className="text-blue-600 dark:text-blue-400">
                {t('general.errors.connectionLost.retryingAttempt', {
                  attempt: retryAttempt,
                  seconds: nextRetryIn,
                })}
              </span>
            ) : (
              <>
                {t('general.errors.connectionLost.description')}
                {retryAttempt > 0 && (
                  <span className="block mt-2 text-sm text-muted-foreground">
                    {t('general.errors.connectionLost.nextRetry', { seconds: nextRetryIn })}
                  </span>
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {/* Close button (X) on the edge */}
        <button
          onClick={onStay}
          className="absolute -right-4 -top-4 z-[1302] rounded-sm border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-black p-0 w-8 h-8 flex items-center justify-center hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          aria-label={t('general.close')}
        >
          <X className="h-4 w-4 text-zinc-800 dark:text-white" />
          <span className="sr-only">Close</span>
        </button>
        <DialogFooter className="flex-row justify-end gap-2 sm:gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => window.location.reload()}
            title={t('general.errors.connectionLost.refresh')}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button variant="destructive" onClick={onLogout}>
            {t('general.errors.connectionLost.logOut')}
          </Button>
        </DialogFooter>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
};

// Singleton instance management
let dialogRoot: Root | null = null;
let dialogContainer: HTMLDivElement | null = null;
let currentResolve: ((action: 'stay' | 'logout') => void) | null = null;
let isDialogOpen = false;
let retryTimeoutId: NodeJS.Timeout | null = null;
let countdownIntervalId: NodeJS.Timeout | null = null;
let pendingPromise: Promise<'stay' | 'logout'> | null = null;

// Exponential backoff configuration
const BACKOFF_CONFIG = {
  initialDelay: 2000,    // 2 seconds
  maxDelay: 60000,       // 60 seconds max
  multiplier: 2,         // Double each time
};

const ensureContainer = () => {
  if (!dialogContainer) {
    dialogContainer = document.createElement('div');
    dialogContainer.id = 'connection-lost-dialog-root';
    document.body.appendChild(dialogContainer);
    dialogRoot = createRoot(dialogContainer);
  }
  return { container: dialogContainer, root: dialogRoot! };
};

const renderDialog = (props: Omit<ConnectionLostDialogProps, 'onStay' | 'onLogout'>) => {
  const { root } = ensureContainer();

  const handleStay = () => {
    // Defer callback execution to prevent blocking UI during async operations
    setTimeout(() => {
      console.log('[ConnectionLostDialog] handleStay called, closing dialog');
      stopRetryLoop();
      if (currentResolve) {
        currentResolve('stay');
        currentResolve = null;
      }
      isDialogOpen = false;
      root.render(
        <ConnectionLostDialogComponent
          {...props}
          open={false}
          onStay={() => {}}
          onLogout={() => {}}
        />
      );
    }, 0);
  };

  const handleLogout = () => {
    // Defer callback execution to prevent blocking UI during async operations
    setTimeout(() => {
      console.log('[ConnectionLostDialog] handleLogout called');
      stopRetryLoop();
      if (currentResolve) {
        currentResolve('logout');
        currentResolve = null;
      }
      isDialogOpen = false;
      root.render(
        <ConnectionLostDialogComponent
          {...props}
          open={false}
          onStay={() => {}}
          onLogout={() => {}}
        />
      );
    }, 0);
  };

  root.render(
    <ConnectionLostDialogComponent
      {...props}
      onStay={handleStay}
      onLogout={handleLogout}
    />
  );
};

const stopRetryLoop = () => {
  if (retryTimeoutId) {
    clearTimeout(retryTimeoutId);
    retryTimeoutId = null;
  }
  if (countdownIntervalId) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }
};

const checkBackendHealth = async (): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeoutSignal = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch(`${API_BASE_URL}/`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
    });

    clearTimeout(timeoutSignal);

    // If we get any response (even 404), backend is alive
    if (response) {
      console.log('[ConnectionLostDialog] Backend is reachable');
      return true;
    }
  } catch (error) {
    console.log('[ConnectionLostDialog] Ping failed, backend still unreachable:', error);
  }
  return false;
};

const startRetryLoop = () => {
  let attempt = 0;
  let currentDelay = BACKOFF_CONFIG.initialDelay;

  const scheduleNextRetry = () => {
    attempt++;
    const delay = Math.min(currentDelay, BACKOFF_CONFIG.maxDelay);
    let countdown = Math.ceil(delay / 1000);

    console.log(`[ConnectionLostDialog] Scheduling retry ${attempt} in ${delay}ms`);

    // Update dialog with countdown
    const updateCountdown = () => {
      renderDialog({
        open: true,
        isRetrying: false,
        retryAttempt: attempt,
        nextRetryIn: countdown,
      });
    };

    updateCountdown();

    // Countdown interval
    countdownIntervalId = setInterval(() => {
      countdown--;
      if (countdown > 0) {
        updateCountdown();
      }
    }, 1000);

    // Schedule the actual retry
    retryTimeoutId = setTimeout(async () => {
      if (countdownIntervalId) {
        clearInterval(countdownIntervalId);
        countdownIntervalId = null;
      }

      // Show retrying state
      renderDialog({
        open: true,
        isRetrying: true,
        retryAttempt: attempt,
        nextRetryIn: 0,
      });

      const isConnected = await checkBackendHealth();

      if (isConnected) {
        // Backend is back! Auto-close dialog
        console.log('[ConnectionLostDialog] Connection restored, auto-closing');
        stopRetryLoop();
        if (currentResolve) {
          currentResolve('stay');
          currentResolve = null;
        }
        isDialogOpen = false;
        renderDialog({
          open: false,
          isRetrying: false,
        });

        // Dispatch event to notify app that connection is restored
        // Components can listen for this to refresh their data
        window.dispatchEvent(new CustomEvent('connectionRestored'));
      } else {
        // Still disconnected, schedule next retry with exponential backoff
        currentDelay = Math.min(currentDelay * BACKOFF_CONFIG.multiplier, BACKOFF_CONFIG.maxDelay);
        scheduleNextRetry();
      }
    }, delay);
  };

  // Start the first retry
  scheduleNextRetry();
};

// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export const connectionLostDialog = {
  /**
   * Check if dialog is currently open
   */
  isOpen: () => isDialogOpen,

  /**
   * Show the connection lost dialog and wait for user action
   * Uses exponential backoff to retry connection
   * @returns Promise that resolves with 'stay' or 'logout'
   */
  show: (): Promise<'stay' | 'logout'> => {
    // Return existing promise if dialog is already open or being opened
    if (pendingPromise) {
      console.log('[ConnectionLostDialog] Returning existing pending promise');
      return pendingPromise;
    }

    // Safety check: if flag says open but container doesn't exist, reset
    if (isDialogOpen) {
      const container = document.getElementById('connection-lost-dialog-root');
      if (!container || !container.querySelector('[data-state="open"]')) {
        console.log('[ConnectionLostDialog] Resetting stale isDialogOpen flag');
        isDialogOpen = false;
        stopRetryLoop();
      } else {
        console.log('[ConnectionLostDialog] Dialog already open, skipping duplicate');
        // Create a promise that resolves when dialog closes
        pendingPromise = new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (!isDialogOpen) {
              clearInterval(checkInterval);
              pendingPromise = null;
              resolve('stay');
            }
          }, 100);
        });
        return pendingPromise;
      }
    }

    isDialogOpen = true;
    console.log('[ConnectionLostDialog] Opening dialog with exponential backoff retry');

    pendingPromise = new Promise((resolve) => {
      currentResolve = (action: 'stay' | 'logout') => {
        pendingPromise = null;
        resolve(action);
      };
      renderDialog({
        open: true,
        isRetrying: false,
        retryAttempt: 0,
        nextRetryIn: Math.ceil(BACKOFF_CONFIG.initialDelay / 1000),
      });

      // Start the exponential backoff retry loop
      startRetryLoop();
    });

    return pendingPromise;
  },

  /**
   * Hide the dialog
   */
  hide: () => {
    console.log('[ConnectionLostDialog] Hiding dialog');
    stopRetryLoop();
    if (dialogRoot) {
      renderDialog({
        open: false,
        isRetrying: false,
      });
    }
    currentResolve = null;
    isDialogOpen = false;
    pendingPromise = null;
  },
};

export { ConnectionLostDialogComponent };
