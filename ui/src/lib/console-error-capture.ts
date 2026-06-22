/**
 * Console Error/Warning Capture Service
 * Ring buffer to capture browser console.error and console.warn calls with context
 */

type LogLevel = 'error' | 'warn' | 'log';

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  stack?: string;
  componentStack?: string;
}

class ConsoleErrorCapture {
  private buffer: LogEntry[] = [];
  private maxSize = 50;
  private originalConsoleError: typeof console.error | null = null;
  private originalConsoleWarn: typeof console.warn | null = null;
  private originalConsoleLog: typeof console.log | null = null;
  private initialized = false;

  // Deduplication: track last message per level to avoid duplicates within 1 second
  private lastCapture: Map<LogLevel, { message: string; timestamp: number }> = new Map();
  private dedupeWindowMs = 1000; // 1 second window

  /**
   * Initialize the capture by overriding console.error and console.warn
   * and setting up global error handlers
   */
  initialize(): void {
    if (this.initialized) {
      return;
    }

    // Try to hook into React DevTools if available
    this.tryHookReactDevTools();

    // Store original console methods
    this.originalConsoleError = console.error.bind(console);
    this.originalConsoleWarn = console.warn.bind(console);
    this.originalConsoleLog = console.log.bind(console);

    // Override console.error
    console.error = (...args: unknown[]) => {
      this.capture(args, 'error');
      if (this.originalConsoleError) {
        this.originalConsoleError(...args);
      }
    };

    // Override console.warn
    console.warn = (...args: unknown[]) => {
      // Extract React component stack from fiber tree (if available)
      const componentStack = this.getReactComponentStack();

      // Capture with React component stack
      this.capture(args, 'warn', componentStack);
      if (this.originalConsoleWarn) {
        this.originalConsoleWarn(...args);
      }
    };

    // Also capture console.log for debugging purposes
    console.log = (...args: unknown[]) => {
      // Capture log messages (useful for debugging PDF position, TTS, etc.)
      this.capture(args, 'log');
      if (this.originalConsoleLog) {
        this.originalConsoleLog(...args);
      }
    };

    // Capture unhandled errors
    window.onerror = (
      message: string | Event,
      source?: string,
      lineno?: number,
      colno?: number,
      error?: Error
    ) => {
      const errorMessage = [
        `Unhandled Error: ${String(message)}`,
        source ? `Source: ${source}:${lineno}:${colno}` : '',
        error?.stack || '',
      ]
        .filter(Boolean)
        .join('\n');

      this.capture([errorMessage], 'error');
    };

    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message =
        reason instanceof Error
          ? `Unhandled Promise Rejection: ${reason.message}\n${reason.stack || ''}`
          : `Unhandled Promise Rejection: ${String(reason)}`;

      this.capture([message], 'error');
    });

    this.initialized = true;
  }

  /**
   * Try to hook into React DevTools to capture component stacks
   */
  private tryHookReactDevTools(): void {
    // Store React instance for component stack extraction
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing React DevTools global hook
      const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook && hook.renderers) {
        // React DevTools hook is available
        // We'll use it to get component stacks when warnings occur
      }
    } catch {
      // Silently fail if React DevTools not available
    }
  }

  /**
   * Get React component stack from current fiber
   */
  private getReactComponentStack(): string | undefined {
    try {
      // Access React internals (hacky but works)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing React DevTools global hook
      const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook || !hook.renderers) return undefined;

      // Get the first renderer (usually React DOM)
      const renderers = Array.from(hook.renderers.values());
      if (renderers.length === 0) return undefined;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- React DevTools renderer internals
      const renderer: any = renderers[0];

      // Try to get current fiber from renderer
      const currentFiber = renderer?.getCurrentFiber?.();
      if (!currentFiber) return undefined;

      // Build component stack from fiber
      return this.buildComponentStackFromFiber(currentFiber);
    } catch {
      return undefined;
    }
  }

  /**
   * Build component stack string from React fiber
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- React fiber internals have no public type
  private buildComponentStackFromFiber(fiber: any): string {
    const stack: string[] = [];
    let current = fiber;

    while (current) {
      if (current.type && typeof current.type === 'function') {
        const name = current.type.displayName || current.type.name || 'Unknown';
        const source = current._debugSource;
        if (source) {
          stack.push(`    at ${name} (${source.fileName}:${source.lineNumber}:${source.columnNumber})`);
        } else {
          stack.push(`    at ${name}`);
        }
      } else if (typeof current.type === 'string') {
        stack.push(`    at ${current.type}`);
      }
      current = current.return;
    }

    return stack.length > 0 ? `Error Component Stack\n${stack.join('\n')}` : '';
  }


  /**
   * Patterns to ignore completely (don't capture at all)
   */
  private ignorePatterns = [
    /admin\/debug/i,
    /Bug Tracker/i,
    /\[Test\]/i,
    /getDebugLogs/i,
    /fetchDockerLogs/i,
  ];

  /**
   * Check if message should be ignored completely
   */
  private shouldIgnore(message: string): boolean {
    return this.ignorePatterns.some(pattern => pattern.test(message));
  }


  /**
   * Capture a log entry
   */
  private capture(args: unknown[], level: LogLevel, reactComponentStack?: string): void {
    // Build message first to check if it should be ignored
    const message = args
      .map((a) => {
        if (a instanceof Error) {
          return `${a.name}: ${a.message}`;
        }
        if (typeof a === 'object' && a !== null) {
          try {
            return JSON.stringify(a, null, 2);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(' ');

    // Skip internal admin/debug logs
    if (this.shouldIgnore(message)) {
      return;
    }

    // Deduplication: skip if same message was captured within 1 second
    const now = Date.now();
    const lastEntry = this.lastCapture.get(level);
    if (lastEntry && lastEntry.message === message && (now - lastEntry.timestamp) < this.dedupeWindowMs) {
      return;
    }
    this.lastCapture.set(level, { message, timestamp: now });

    // Find any Error objects in args for stack trace
    const errorObj = args.find((a): a is Error => a instanceof Error);

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      stack: errorObj?.stack,
      componentStack: reactComponentStack,
    };

    this.buffer.push(entry);

    // Maintain ring buffer size
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  /**
   * Capture a React component error with component stack
   */
  captureReactError(error: Error, errorInfo: { componentStack?: string }): void {
    const message = `React Error: ${error.name}: ${error.message}`;

    // Skip internal admin/debug logs
    if (this.shouldIgnore(message)) {
      return;
    }

    // Deduplication: skip if same message was captured within 1 second
    const now = Date.now();
    const lastEntry = this.lastCapture.get('error');
    if (lastEntry && lastEntry.message === message && (now - lastEntry.timestamp) < this.dedupeWindowMs) {
      return;
    }
    this.lastCapture.set('error', { message, timestamp: now });

    const entry: LogEntry = {
      timestamp: Date.now(),
      level: 'error',
      message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    };

    this.buffer.push(entry);

    // Maintain ring buffer size
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  /**
   * Format logs for API submission
   */
  formatForSubmission(): string {
    const logs = this.buffer; // Return all logs, not just last 20

    if (logs.length === 0) {
      return 'No browser logs captured';
    }

    return logs
      .map((e) => {
        const timestamp = new Date(e.timestamp).toISOString();
        const levelTag = e.level === 'error' ? '[ERROR]' : e.level === 'warn' ? '[WARNING]' : '[DEBUG]';
        const lines = [`${levelTag} [${timestamp}] ${e.message}`];
        if (e.stack) {
          lines.push(`Stack: ${e.stack}`);
        }
        if (e.componentStack) {
          lines.push(`Component Stack: ${e.componentStack}`);
        }
        return lines.join('\n');
      })
      .join('\n\n---\n\n');
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * Get total log count (errors + warnings)
   */
  getLogCount(): number {
    return this.buffer.length;
  }

  /**
   * Get error count only (includes internal debug logs)
   */
  getErrorCount(): number {
    return this.buffer.filter(e => e.level === 'error').length;
  }

  /**
   * Get warning count only (includes internal debug logs)
   */
  getWarningCount(): number {
    return this.buffer.filter(e => e.level === 'warn').length;
  }

}

// Singleton instance
export const consoleErrorCapture = new ConsoleErrorCapture();
