/**
 * Global Error Boundary
 * Catches React errors and captures them with component stack traces
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { consoleErrorCapture } from '@/lib/console-error-capture';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** Called after componentDidCatch — use to dispatch context cleanup
   * (e.g. close a crashing viewer) and surface a toast. */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Capture the error with component stack for the debug modal
    consoleErrorCapture.captureReactError(error, {
      componentStack: errorInfo.componentStack,
    });

    // Also log to console for development
    console.error('React Error Boundary caught error:', error, errorInfo);

    // Expose to window for Chrome MCP / DevTools debugging — this is
    // the only way to get the full stack + component stack out of the
    // sandbox when the error message alone isn't enough to root-cause.
    (window as unknown as { __lastReactError?: unknown }).__lastReactError = {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    };

    this.props.onError?.(error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
    });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      // Custom fallback UI or default error UI
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center min-h-screen p-4 bg-white dark:bg-zinc-950">
          <div className="max-w-md w-full space-y-4 text-center">
            <AlertCircle className="w-16 h-16 mx-auto text-red-500" />
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">
              Something went wrong
            </h1>
            <p className="text-zinc-600 dark:text-zinc-400">
              An unexpected error occurred. The error has been captured for debugging.
            </p>
            {this.state.error && (
              <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-md text-left">
                <p className="text-sm font-mono text-red-800 dark:text-red-200">
                  {this.state.error.message}
                </p>
              </div>
            )}
            <div className="flex gap-2 justify-center">
              <Button onClick={this.handleReset} variant="default">
                Try Again
              </Button>
              <Button
                onClick={() => window.location.reload()}
                variant="outline"
              >
                Reload Page
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
