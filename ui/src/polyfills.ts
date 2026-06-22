/**
 * This file contains polyfills needed by libraries that expect Node.js globals
 * to be available in the browser environment.
 */

// Fix for "Uncaught ReferenceError: global is not defined" in sockjs-client
if (typeof window !== 'undefined') {
  // Define global for sockjs-client
  window.global = window;

  // Define process.env
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type is dynamic
  window.process = window.process || ({} as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type is dynamic
  window.process.env = window.process.env || ({} as any);

  // Define Buffer for libraries that might need it
  window.Buffer =
    window.Buffer ||
    ((() => {
      // Simple Buffer polyfill for browser
      class BufferPolyfill {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- polyfill requires dynamic types
        static from(data: any, _encoding?: string): any {
          return data;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type is dynamic
        static alloc(size: number): any {
          return new Uint8Array(size);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type is dynamic
        static isBuffer(_obj: any): boolean {
          return false;
        }
      }
      return BufferPolyfill;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type is dynamic
    })() as any);
}

export {};
