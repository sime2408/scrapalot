/**
 * Sonner compatibility layer for our custom toast implementation
 * This provides the same API as Sonner but uses our custom toast system
 */

// Toast duplicate tracking
const activeToasts = new Set<string>();
const TOAST_SPACING = 100; // Increased spacing between toasts
const ERROR_DURATION = 8000; // Longer duration for error messages
const DEFAULT_DURATION = 5000;

// After a toast dismisses, keep its key in `activeToasts` for this many ms so
// the same notification firing again from background polling / a second failed
// request doesn't produce a fresh stack. Error-type messages typically come
// from recurring conditions (a slow backend, an auth refresh loop, a polling
// fetch) — if the user saw the same error a second ago, they don't need to
// see it four more times while the condition clears. Success / info are
// user-triggered and should show immediately on retry, so they get no
// cooldown.
const TOAST_COOLDOWN_MS: Record<string, number> = {
  error: 30000,
  warning: 15000,
  info: 0,
  success: 0,
};

// Simple fallback toast implementation using native browser alerts for now
// This will be replaced once the proper context is working
const showToast = (message: string, type: string = 'info') => {
  // Check for duplicate messages
  const messageKey = `${type}:${message}`;
  if (activeToasts.has(messageKey)) {
    return;
  }
  activeToasts.add(messageKey);
  // For now, just log to console and show a simple alert


  // Create a simple toast element
  const toastEl = document.createElement('div');
  const getToastStyles = (type: string) => {
    const baseStyles = {
      error: {
        bg: 'linear-gradient(135deg, rgba(254, 226, 226, 0.4) 0%, rgba(254, 202, 202, 0.4) 100%)',
        border: '#fca5a5',
        text: '#7f1d1d',
        icon: '❌',
      },
      success: {
        bg: 'linear-gradient(135deg, rgba(220, 252, 231, 0.4) 0%, rgba(187, 247, 208, 0.4) 100%)',
        border: '#86efac',
        text: '#14532d',
        icon: '✅',
      },
      warning: {
        bg: 'linear-gradient(135deg, rgba(254, 243, 199, 0.4) 0%, rgba(253, 230, 138, 0.4) 100%)',
        border: '#fcd34d',
        text: '#78350f',
        icon: '⚠️',
      },
      info: {
        bg: 'linear-gradient(135deg, rgba(219, 234, 254, 0.4) 0%, rgba(191, 219, 254, 0.4) 100%)',
        border: '#60a5fa',
        text: '#1e3a8a',
        icon: 'ℹ️',
      },
    };

    // Check if the app is using dark theme by looking at the HTML element's class
    const isDark = document.documentElement.classList.contains('dark') ||
      (document.documentElement.dataset.theme === 'dark') ||
      (!document.documentElement.classList.contains('light') &&
        !document.documentElement.dataset.theme &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);

    if (isDark) {
      return (
        {
          error: {
            bg: 'linear-gradient(135deg, rgba(127, 29, 29, 0.4) 0%, rgba(153, 27, 27, 0.4) 100%)',
            border: '#dc2626',
            text: '#fecaca',
            icon: '❌',
          },
          success: {
            bg: 'linear-gradient(135deg, rgba(20, 83, 45, 0.4) 0%, rgba(22, 101, 52, 0.4) 100%)',
            border: '#16a34a',
            text: '#bbf7d0',
            icon: '✅',
          },
          warning: {
            bg: 'linear-gradient(135deg, rgba(120, 53, 15, 0.4) 0%, rgba(146, 64, 14, 0.4) 100%)',
            border: '#d97706',
            text: '#fde68a',
            icon: '⚠️',
          },
          info: {
            bg: 'linear-gradient(135deg, rgba(30, 58, 138, 0.4) 0%, rgba(30, 64, 175, 0.4) 100%)',
            border: '#3b82f6',
            text: '#bfdbfe',
            icon: 'ℹ️',
          },
        }[type] || baseStyles.info
      );
    }

    return baseStyles[type] || baseStyles.info;
  };

  const styles = getToastStyles(type);

  toastEl.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${styles.bg};
    color: ${styles.text};
    padding: 16px 20px;
    border-radius: 0px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.05);
    z-index: 999999;
    max-width: 380px;
    min-width: 280px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.5;
    animation: slideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    backdrop-filter: blur(20px);
    pointer-events: auto;
    cursor: pointer;
    word-wrap: break-word;
    overflow-wrap: break-word;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    transition: all 0.2s ease;
  `;

  // Add responsive styles for mobile
  const mediaQuery = window.matchMedia('(max-width: 768px)');
  if (mediaQuery.matches) {
    toastEl.style.cssText += `
        max-width: calc(100vw - 32px);
        min-width: calc(100vw - 32px);
        right: 16px;
        left: 16px;
        width: auto;
        padding: 14px 16px;
        font-size: 13px;
        border-radius: 0px;
        `;
  }

  // Add animation keyframes if not already added
  if (!document.getElementById('toast-animations')) {
    const style = document.createElement('style');
    style.id = 'toast-animations';
    style.textContent = `
      @keyframes slideIn {
        from { 
          transform: translateX(100%) scale(0.9); 
          opacity: 0; 
        }
        to { 
          transform: translateX(0) scale(1); 
          opacity: 1; 
        }
      }
      @keyframes slideOut {
        from { 
          transform: translateX(0) scale(1); 
          opacity: 1; 
        }
        to { 
          transform: translateX(100%) scale(0.9); 
          opacity: 0; 
        }
      }
      @keyframes pulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.02); }
      }
      [data-toast-copy] {
        opacity: 0.5;
        transition: opacity 0.2s ease;
      }
      [data-toast-copy]:hover {
        opacity: 1;
      }
    `;
    document.head.appendChild(style);
  }

  // Create icon and message elements
  const iconEl = document.createElement('span');
  iconEl.textContent = styles.icon;
  iconEl.style.cssText = `
        font-size: 16px;
        flex-shrink: 0;
        margin-top: 1px;
    `;

  const messageEl = document.createElement('span');
  messageEl.textContent = message;
  messageEl.style.cssText = `
        flex: 1;
        word-break: break-word;
    `;

  toastEl.appendChild(iconEl);
  toastEl.appendChild(messageEl);

  // Copy-to-clipboard button — small, faint icon on the right. Clicking it
  // copies the message without dismissing the toast (the whole toast is
  // click-to-dismiss, so we stop propagation here).
  const COPY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  const CHECK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.innerHTML = COPY_ICON;
  copyBtn.setAttribute('data-toast-copy', 'true');
  copyBtn.setAttribute('aria-label', 'Copy message');
  copyBtn.title = 'Copy';
  copyBtn.style.cssText = `
        flex-shrink: 0;
        margin-top: 1px;
        padding: 0;
        background: transparent;
        border: none;
        color: inherit;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 0;
    `;
  let copyResetId: ReturnType<typeof setTimeout>;
  copyBtn.addEventListener('click', e => {
    e.stopPropagation();
    const done = () => {
      copyBtn.innerHTML = CHECK_ICON;
      clearTimeout(copyResetId);
      copyResetId = setTimeout(() => {
        copyBtn.innerHTML = COPY_ICON;
      }, 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(message).then(done).catch(() => {});
    } else {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = message;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        done();
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
  });

  toastEl.appendChild(copyBtn);

  // Stack toasts properly with increased spacing
  const existingToasts = document.querySelectorAll('[data-toast="true"]');
  toastEl.setAttribute('data-toast', 'true');
  toastEl.setAttribute('data-toast-key', messageKey);
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const spacing = isMobile ? TOAST_SPACING : TOAST_SPACING;
  toastEl.style.top = `${20 + existingToasts.length * spacing}px`;

  document.body.appendChild(toastEl);

  // Hover-to-pause functionality
  let remainingTime = type === 'error' ? ERROR_DURATION : DEFAULT_DURATION;
  let startTime = Date.now();
  let timeoutId: ReturnType<typeof setTimeout>;

  const removeToast = (element: HTMLElement) => {
    // Clear any pending timeout
    clearTimeout(timeoutId);
    // Remove from active toasts set, but honour the per-type cooldown so
    // a recurring error doesn't immediately re-fire once its predecessor
    // auto-dismisses.
    const toastKey = element.getAttribute('data-toast-key');
    if (toastKey) {
      const typePrefix = toastKey.slice(0, toastKey.indexOf(':'));
      const cooldown = TOAST_COOLDOWN_MS[typePrefix] ?? 0;
      if (cooldown > 0) {
        setTimeout(() => activeToasts.delete(toastKey), cooldown);
      } else {
        activeToasts.delete(toastKey);
      }
    }

    element.style.animation = 'slideOut 0.3s ease-in';
    setTimeout(() => {
      if (element.parentNode) {
        element.parentNode.removeChild(element);
        // Reposition remaining toasts with proper spacing
        const remainingToasts = document.querySelectorAll(
          '[data-toast="true"]'
        );
        const spacing = TOAST_SPACING;
        remainingToasts.forEach((toast, index) => {
          (toast as HTMLElement).style.top = `${20 + index * spacing}px`;
        });
      }
    }, 300);
  };

  const startTimer = () => {
    startTime = Date.now();
    timeoutId = setTimeout(() => {
      removeToast(toastEl);
    }, remainingTime);
  };

  const pauseTimer = () => {
    clearTimeout(timeoutId);
    remainingTime -= Date.now() - startTime;
    // Ensure remaining time doesn't go negative
    if (remainingTime < 0) remainingTime = 0;
  };

  // Click to dismiss
  toastEl.addEventListener('click', () => {
    removeToast(toastEl);
  });

  // Pause timer on hover
  toastEl.addEventListener('mouseenter', () => {
    pauseTimer();
    // Visual feedback - subtle border glow (balanced between solid border and blur)
    toastEl.style.boxShadow = `0 0 0 1px ${styles.border}60, 0 0 12px ${styles.border}35, 0 10px 40px rgba(0,0,0,0.08)`;
  });

  // Resume timer when mouse leaves
  toastEl.addEventListener('mouseleave', () => {
    // Reset to original shadow
    toastEl.style.boxShadow = '0 10px 40px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.05)';
    startTimer();
  });

  // Start the initial timer
  startTimer();
};

type ToastMessageArg = string | { title?: string; description?: string };

interface ToastFunction {
  (messageOrOptions: string | { title?: string; description?: string; variant?: string }, data?: Record<string, unknown>): string;
  success: (messageOrOptions: ToastMessageArg) => string;
  error: (messageOrOptions: ToastMessageArg) => string;
  warning: (messageOrOptions: ToastMessageArg) => string;
  info: (messageOrOptions: ToastMessageArg) => string;
  dismiss: () => string;
  loading: (message: string) => string;
  custom: (...args: unknown[]) => string;
  message: ToastFunction;
  promise: (...args: unknown[]) => string;
}

// Main toast function that mimics Sonner's API
export const toast = ((
  messageOrOptions:
    | string
    | { title?: string; description?: string; variant?: string },
  _data?: Record<string, unknown>
) => {
  if (typeof messageOrOptions === 'string') {
    showToast(messageOrOptions, 'info');
  } else {
    // Handle object-style API (like Sonner)
    const { title, description, variant = 'default' } = messageOrOptions;
    // Show both title and description when both are provided
    const message = title && description
      ? `${title}: ${description}`
      : title || description || 'Notification';
    const type =
      variant === 'destructive'
        ? 'error'
        : variant === 'default'
          ? 'success'
          : variant;
    showToast(message, type);
  }
  return Date.now().toString(); // Return ID like Sonner
}) as ToastFunction;

// Add the helper methods
toast.success = (
  messageOrOptions: string | { title?: string; description?: string }
) => {
  if (typeof messageOrOptions === 'string') {
    showToast(messageOrOptions, 'success');
  } else {
    const { title, description } = messageOrOptions;
    // Show both title and description when both are provided
    const message = title && description
      ? `${title}: ${description}`
      : title || description || 'Success';
    showToast(message, 'success');
  }
  return Date.now().toString();
};

toast.error = (
  messageOrOptions: string | { title?: string; description?: string }
) => {
  if (typeof messageOrOptions === 'string') {
    showToast(messageOrOptions, 'error');
  } else {
    const { title, description } = messageOrOptions;
    // Show both title and description when both are provided
    const message = title && description
      ? `${title}: ${description}`
      : title || description || 'Error';
    showToast(message, 'error');
  }
  return Date.now().toString();
};

toast.warning = (
  messageOrOptions: string | { title?: string; description?: string }
) => {
  if (typeof messageOrOptions === 'string') {
    showToast(messageOrOptions, 'warning');
  } else {
    const { title, description } = messageOrOptions;
    // Show both title and description when both are provided
    const message = title && description
      ? `${title}: ${description}`
      : title || description || 'Warning';
    showToast(message, 'warning');
  }
  return Date.now().toString();
};

toast.info = (
  messageOrOptions: string | { title?: string; description?: string }
) => {
  if (typeof messageOrOptions === 'string') {
    showToast(messageOrOptions, 'info');
  } else {
    const { title, description } = messageOrOptions;
    // Show both title and description when both are provided
    const message = title && description
      ? `${title}: ${description}`
      : title || description || 'Info';
    showToast(message, 'info');
  }
  return Date.now().toString();
};

// Add other Sonner methods as no-ops for compatibility
toast.dismiss = () => Date.now().toString();
toast.loading = (message: string) => {
  toast.info(message);
  return Date.now().toString();
};
toast.custom = () => Date.now().toString();
toast.message = toast; // message is just an alias for the main function
toast.promise = () => Date.now().toString();

export default toast;
