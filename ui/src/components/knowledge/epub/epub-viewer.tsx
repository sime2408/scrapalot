import React, { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import ePub, { Book, Rendition } from 'epubjs';
import JSZip from 'jszip';
import { useTheme } from '@/providers/theme-provider';
import { useTranslation } from 'react-i18next';
import { api } from '@/contexts/api-client-context';
import { ChevronLeft, ChevronRight, List } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface EpubViewerProps {
  url: string;
  initialLocation?: string | number;
  onLocationChange?: (location: string) => void;
  renditionRef?: React.MutableRefObject<Rendition | null>;
  onRenditionReady?: () => void;
  isInverted?: boolean;
  // Timestamp of the last user-initiated page navigation (next/prev/arrow).
  // The TTS hook reads this so it can distinguish a click on the page-turn
  // arrow from epub.js's internal CSS-column relocated events.
  userNavRef?: React.MutableRefObject<number>;
}

interface TocItem {
  href: string;
  label: string;
  subitems?: TocItem[];
}

// Helper to decode corrupted data (converts "109,105,109,101" back to "mime")
// JSZip browser bug corrupts BOTH file names AND file content to comma-separated byte values
const decodeCorruptedString = (str: string): string => {
  if (!str || typeof str !== 'string') return str || '';
  // Check if the string looks like comma-separated byte values
  // Must have at least some digits and commas, and only digits/commas
  if (/^\d+(,\d+)+$/.test(str)) {
    try {
      const bytes = str.split(',').map(n => parseInt(n, 10));
      // Validate all bytes are in valid range (0-255)
      if (bytes.every(b => b >= 0 && b <= 255)) {
        return String.fromCharCode(...bytes);
      }
    } catch {
      return str;
    }
  }
  return str;
};

const decodeCorruptedFileName = (name: string): string => {
  const hasTrailingSlash = name.endsWith('/');
  const nameToProcess = hasTrailingSlash ? name.slice(0, -1) : name;
  const decoded = decodeCorruptedString(nameToProcess);
  return hasTrailingSlash ? decoded + '/' : decoded;
};

// Helper to detect MIME type from file extension
const getMimeType = (url: string): string => {
  const ext = url.split('.').pop()?.toLowerCase() || '';
  const mimeTypes: Record<string, string> = {
    // Images
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    // Fonts
    'ttf': 'font/ttf',
    'otf': 'font/otf',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    // Styles
    'css': 'text/css',
    // Documents
    'html': 'text/html',
    'htm': 'text/html',
    'xhtml': 'application/xhtml+xml',
    'xml': 'application/xml',
    'ncx': 'application/x-dtbncx+xml',
    'opf': 'application/oebps-package+xml',
    // Scripts
    'js': 'application/javascript',
  };
  return mimeTypes[ext] || 'application/octet-stream';
};

export const EpubViewer: React.FC<EpubViewerProps> = ({
  url,
  initialLocation = 0,
  onLocationChange,
  renditionRef: externalRenditionRef,
  onRenditionReady,
  isInverted = false,
  userNavRef,
}) => {
  const [isLoading, setIsLoading] = useState(true);
  const mountCountRef = useRef(0);

  // Track mount/unmount
  useEffect(() => {
    mountCountRef.current++;
    console.log('📚 EPUB: Component MOUNTED (count:', mountCountRef.current, ')');
    return () => {
      console.log('📚 EPUB: Component UNMOUNTED');
    };
  }, []);

  console.log('📚 EPUB: Component rendering, url:', url, 'isLoading:', isLoading, 'mountCount:', mountCountRef.current);
  const [error, setError] = useState<string>('');
  const [toc, setToc] = useState<TocItem[]>([]);
  const [showToc, setShowToc] = useState(false);
  const [, setCurrentLocation] = useState<string>('');
  const [containerReady, setContainerReady] = useState(false);

  const { theme } = useTheme();
  const { t } = useTranslation();

  const containerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const internalRenditionRef = useRef<Rendition | null>(null);
  const isInitializedRef = useRef<boolean>(false);

  // Use the external ref if provided, otherwise use internal - memoized to prevent re-renders
  const renditionRef = useMemo(() => {
    return externalRenditionRef || internalRenditionRef;
  }, [externalRenditionRef]);

  // Use callback ref to detect when container is mounted
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    console.log('📚 EPUB: Container ref callback, node exists:', !!node);
    if (node) {
      (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      setContainerReady(true);
    }
  }, []);

  const cleanup = useCallback(() => {
    console.log('📚 EPUB: Cleaning up...');
    if (renditionRef.current) {
      try {
        renditionRef.current.destroy();
      } catch (e) {
        console.warn('📚 EPUB: Error destroying rendition:', e);
      }
      renditionRef.current = null;
    }
    if (bookRef.current) {
      try {
        bookRef.current.destroy();
      } catch (e) {
        // Archive destroy error should not happen anymore after adding destroy() method
        console.warn('📚 EPUB: Error destroying book:', e);
      }
      bookRef.current = null;
    }
    isInitializedRef.current = false;
  }, [renditionRef]);

  const prevPage = useCallback(() => {
    console.log('📚 EPUB: prevPage called, renditionRef.current:', !!renditionRef.current);
    if (renditionRef.current) {
      if (userNavRef) userNavRef.current = Date.now();
      const beforeCfi = (renditionRef.current.currentLocation() as { start?: { cfi?: string } } | null)?.start?.cfi;
      console.log('📚 EPUB: Before prev() - CFI:', beforeCfi);

      renditionRef.current.prev().then(() => {
        console.log('📚 EPUB: prev() completed');
        const afterCfi = (renditionRef.current?.currentLocation() as { start?: { cfi?: string } } | null)?.start?.cfi;
        console.log('📚 EPUB: After prev() - CFI:', afterCfi);
      }).catch((err: Error) => {
        console.error('📚 EPUB: prev() error:', err);
      });
    }
  }, [renditionRef, userNavRef]);

  const nextPage = useCallback(() => {
    console.log('📚 EPUB: nextPage called, renditionRef.current:', !!renditionRef.current);
    if (renditionRef.current) {
      if (userNavRef) userNavRef.current = Date.now();
      const beforeCfi = (renditionRef.current.currentLocation() as { start?: { cfi?: string } } | null)?.start?.cfi;
      console.log('📚 EPUB: Before next() - CFI:', beforeCfi);

      renditionRef.current.next().then(() => {
        console.log('📚 EPUB: next() completed');
        const afterCfi = (renditionRef.current?.currentLocation() as { start?: { cfi?: string } } | null)?.start?.cfi;
        console.log('📚 EPUB: After next() - CFI:', afterCfi);
      }).catch((err: Error) => {
        console.error('📚 EPUB: next() error:', err);
      });
    }
  }, [renditionRef, userNavRef]);

  const goToTocItem = useCallback((href: string) => {
    if (renditionRef.current) {
      void renditionRef.current.display(href);
      setShowToc(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  useEffect(() => {
    console.log('📚 EPUB: useEffect triggered, url:', url, 'containerReady:', containerReady);
    if (!url) {
      console.log('📚 EPUB: No URL provided');
      return;
    }
    if (!containerReady || !containerRef.current) {
      console.log('📚 EPUB: Waiting for container...');
      return;
    }

    // Prevent re-initialization if already initialized
    // This avoids resetting to first page when TTS starts or theme changes
    if (isInitializedRef.current) {
      console.log('📚 EPUB: Already initialized, skipping re-initialization');
      return;
    }

    const initEpub = async () => {
      console.log('📚 EPUB: Starting initialization for URL:', url);
      setIsLoading(true);
      setError('');
      cleanup();

      try {
        console.log('📚 EPUB: Fetching with api.get...');
        const response = await api.get(url, {
          headers: { Accept: 'application/epub+zip' },
          responseType: 'arraybuffer',
          timeout: 60000,
        });

        console.log('📚 EPUB: Response received, size:', response.data?.byteLength);

        if (!response.data || response.data.byteLength === 0) {
          setError('Failed to open EPUB: Received empty EPUB file');
          setIsLoading(false);
          return;
        }

        // Verify ZIP magic number
        const dataView = new DataView(response.data);
        const magic = dataView.getUint16(0, false);
        if (magic !== 0x504B) {
          setError('Failed to open EPUB: File is not a valid EPUB (ZIP) format');
          setIsLoading(false);
          return;
        }

        // Load ZIP and check for corrupted file names
        console.log('📚 EPUB: Loading ZIP...');
        const zip = await JSZip.loadAsync(response.data);
        const rawFiles = Object.keys(zip.files);
        console.log('📚 EPUB: Raw files:', rawFiles.slice(0, 5));

        // Check if names are corrupted
        const hasCorruptedNames = rawFiles.some(f => {
          const name = f.endsWith('/') ? f.slice(0, -1) : f;
          return /^\d+(,\d+)*$/.test(name);
        });

        console.log('📚 EPUB: Has corrupted names:', hasCorruptedNames);

        // Helper to find a file in the ZIP by decoded name
        const findZipFile = (targetName: string): JSZip.JSZipObject | null => {
          const targetLower = targetName.toLowerCase();
          for (const rawName of rawFiles) {
            const decoded = decodeCorruptedFileName(rawName);
            if (decoded.toLowerCase() === targetLower) {
              return zip.files[rawName];
            }
          }
          return null;
        };

        // Read container.xml to get the OPF path
        console.log('📚 EPUB: Reading container.xml...');
        const containerFile = findZipFile('META-INF/container.xml');
        if (!containerFile) {
          setError('Failed to open EPUB: No META-INF/container.xml found in EPUB');
          setIsLoading(false);
          return;
        }

        // Use arraybuffer and TextDecoder to prevent JSZip corruption
        const containerXmlBuffer = await containerFile.async('arraybuffer');
        const containerXml = new TextDecoder('utf-8').decode(containerXmlBuffer);
        console.log('📚 EPUB: container.xml content:', containerXml.substring(0, 200));

        // Parse container.xml to get rootfile path
        // Use getElementsByTagName instead of querySelector to handle XML namespaces
        const parser = new DOMParser();
        const containerDoc = parser.parseFromString(containerXml, 'application/xml');

        // Try multiple approaches to find rootfile element (namespace handling)
        let rootfileEl = containerDoc.getElementsByTagName('rootfile')[0];
        if (!rootfileEl) {
          rootfileEl = containerDoc.getElementsByTagNameNS('*', 'rootfile')[0];
        }
        if (!rootfileEl) {
          // Fallback: parse with regex
          const match = containerXml.match(/full-path=["']([^"']+)["']/);
          if (match) {
            console.log('📚 EPUB: Using regex fallback for OPF path:', match[1]);
          }
          if (!match) {
            setError('Failed to open EPUB: No rootfile element found in container.xml');
            setIsLoading(false);
            return;
          }
        }

        const opfPath = rootfileEl ? rootfileEl.getAttribute('full-path') : containerXml.match(/full-path=["']([^"']+)["']/)?.[1];
        if (!opfPath) {
          setError('Failed to open EPUB: No full-path attribute on rootfile');
          setIsLoading(false);
          return;
        }
        console.log('📚 EPUB: OPF path:', opfPath);

        // Log all available files (decoded)
        console.log('📚 EPUB: Available files (decoded):');
        rawFiles.forEach((rawName, i) => {
          if (i < 10) {
            console.log(`  ${i}: ${rawName} -> ${decodeCorruptedFileName(rawName)}`);
          }
        });

        // Read the OPF file
        const opfFile = findZipFile(opfPath);
        if (!opfFile) {
          setError(`Failed to open EPUB: OPF file not found: ${opfPath}`);
          setIsLoading(false);
          return;
        }

        // Use arraybuffer and TextDecoder to prevent JSZip corruption
        const opfBuffer = await opfFile.async('arraybuffer');
        const opfContent = new TextDecoder('utf-8').decode(opfBuffer);
        console.log('📚 EPUB: OPF content length:', opfContent.length);

        // Create book with OPF input type
        const book = ePub();
        bookRef.current = book;

        book.on('openFailed', (err: unknown) => {
          console.error('📚 EPUB: openFailed:', err);
        });

        // Set up the book's internal state manually
        book.archived = true;
        // @ts-expect-error accessing internals
        book.url = { resolve: (path: string) => '/' + path, directory: '/', origin: '' };

        // @ts-expect-error setting internal archive
        // Create a custom archive that handles corrupted names
        book.archive = {
          zip: zip,
          urlCache: {},

          request: function(url: string, type?: string) {
            // Remove ALL leading slashes
            let cleanUrl = url.replace(/^\/+/, '');
            console.log('📚 EPUB: Archive.request:', url, '-> cleaned:', cleanUrl, 'type:', type);

            let file = findZipFile(cleanUrl);

            // epub.js openPackaging() sets `this.path = new Path(opfPath)` then calls
            // `this.load(opfPath)`, which runs `this.path.resolve(opfPath)`. POSIX resolve
            // against the OPF's own directory doubles the prefix (OEBPS/content.opf →
            // OEBPS/OEBPS/content.opf). Detect and collapse duplicated consecutive segments.
            if (!file) {
              const segments = cleanUrl.split('/');
              for (let i = 1; i < segments.length; i++) {
                if (segments[i - 1] && segments[i - 1] === segments[i]) {
                  const dedupedUrl = [...segments.slice(0, i - 1), ...segments.slice(i)].join('/');
                  const dedupedFile = findZipFile(dedupedUrl);
                  if (dedupedFile) {
                    console.log('📚 EPUB: Collapsed duplicated path segment:', cleanUrl, '->', dedupedUrl);
                    cleanUrl = dedupedUrl;
                    file = dedupedFile;
                    break;
                  }
                }
              }
            }

            if (!file) {
              // Some files are optional (like Apple's iBooks display options)
              const isOptional = cleanUrl.includes('com.apple.ibooks') ||
                                 cleanUrl.includes('encryption.xml') ||
                                 cleanUrl.includes('rights.xml');
              if (isOptional) {
                console.log('📚 EPUB: Optional file not found (OK):', cleanUrl);
                return Promise.resolve(null);
              }
              console.error('📚 EPUB: File not found:', cleanUrl);
              console.log('📚 EPUB: Searching for similar files...');
              // Log files that might match
              rawFiles.forEach((rawName) => {
                const decoded = decodeCorruptedFileName(rawName);
                if (decoded.includes('opf') || decoded.includes('content')) {
                  console.log(`  Candidate: ${decoded}`);
                }
              });
              return Promise.reject({ message: `File not found: ${url}` });
            }

            if (type === 'blob') {
              // Use arraybuffer to prevent JSZip corruption of binary data
              console.log('📚 EPUB: request(blob) for:', cleanUrl);
              return file.async('arraybuffer').then((arrayBuffer: ArrayBuffer) => {
                return new Blob([arrayBuffer]);
              });
            }

            // Use arraybuffer for all files to prevent JSZip corruption
            return file.async('arraybuffer').then((arrayBuffer: ArrayBuffer) => {
              // Decode text content using TextDecoder (handles UTF-8 properly)
              const content = new TextDecoder('utf-8').decode(arrayBuffer);
              console.log('📚 EPUB: Decoded content for', cleanUrl, 'length:', content.length);

              // Parse XML/HTML if needed - epub.js expects Document objects for these
              const lowerUrl = cleanUrl.toLowerCase();
              if (type === 'xml' || lowerUrl.endsWith('.xml') || lowerUrl.endsWith('.opf') || lowerUrl.endsWith('.ncx')) {
                const parser = new DOMParser();
                return parser.parseFromString(content, 'application/xml');
              }
              if (type === 'xhtml' || lowerUrl.endsWith('.xhtml') || lowerUrl.endsWith('.html') || lowerUrl.endsWith('.htm')) {
                const parser = new DOMParser();
                // Use application/xhtml+xml for XHTML files to preserve XML structure
                const mimeType = lowerUrl.endsWith('.xhtml') ? 'application/xhtml+xml' : 'text/html';
                return parser.parseFromString(content, mimeType);
              }
              return content;
            });
          },

          getText: function(url: string) {
            const cleanUrl = url.replace(/^\/+/, '');
            const file = findZipFile(cleanUrl);
            if (!file) return Promise.resolve(null);
            // Use arraybuffer and TextDecoder to prevent JSZip corruption
            return file.async('arraybuffer').then((arrayBuffer: ArrayBuffer) => {
              return new TextDecoder('utf-8').decode(arrayBuffer);
            });
          },

          getBlob: function(url: string, mimeType?: string) {
            const cleanUrl = url.replace(/^\/+/, '');
            console.log('📚 EPUB: getBlob called for:', cleanUrl);
            const file = findZipFile(cleanUrl);
            if (!file) {
              console.warn('📚 EPUB: File not found for getBlob:', cleanUrl);
              return Promise.resolve(null);
            }

            // Detect MIME type
            const detectedMime = mimeType || getMimeType(cleanUrl);
            // ALWAYS use arraybuffer to prevent JSZip corruption
            console.log('📚 EPUB: Loading file as arraybuffer:', cleanUrl, 'mime:', detectedMime);
            return file.async('arraybuffer').then((arrayBuffer: ArrayBuffer) => {
              return new Blob([arrayBuffer], { type: detectedMime });
            });
          },

          createUrl: function(url: string, _options?: { base64?: boolean }) {
            const cleanUrl = url.replace(/^\/+/, '');
            console.log('📚 EPUB: createUrl called for:', cleanUrl);
            const file = findZipFile(cleanUrl);
            if (!file) {
              console.warn('📚 EPUB: File not found for createUrl:', cleanUrl);
              return Promise.resolve('');
            }

            // ALWAYS use arraybuffer to prevent JSZip corruption
            const mimeType = getMimeType(cleanUrl);
            console.log('📚 EPUB: Creating URL for file:', cleanUrl, 'mime:', mimeType);
            return file.async('arraybuffer').then((arrayBuffer: ArrayBuffer) => {
              const blob = new Blob([arrayBuffer], { type: mimeType });
              const objectUrl = URL.createObjectURL(blob);
              console.log('📚 EPUB: Created blob URL:', objectUrl, 'size:', arrayBuffer.byteLength);
              return objectUrl;
            });
          },

          revokeUrl: function(url: string) {
            URL.revokeObjectURL(url);
          },

          destroy: function() {
            // Cleanup method called by epub.js when book is destroyed
            // Revoke all created blob URLs to free memory
            if (this.urlCache) {
              Object.keys(this.urlCache).forEach((key) => {
                if (typeof this.urlCache[key] === 'string') {
                  URL.revokeObjectURL(this.urlCache[key]);
                }
              });
              this.urlCache = {};
            }
            console.log('📚 EPUB: Archive destroyed');
          }
        };


        console.log('📚 EPUB: Custom archive created, opening packaging...');

        // Parse the OPF and set up the book
        await book.openPackaging(opfPath);

        console.log('📚 EPUB: Book opened, waiting for ready...');

        // Wait for ready with timeout
        await Promise.race([
          book.ready,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Book loading timed out')), 30000)
          ),
        ]);

        console.log('📚 EPUB: Book ready!');

        // Load TOC
        const navigation = await book.loaded.navigation;
        setToc(navigation.toc || []);

        // Create rendition
        if (!containerRef.current) {
          setError('Failed to open EPUB: Container not available');
          setIsLoading(false);
          return;
        }

        // Use explicit pixel dimensions to ensure epub.js respects container bounds
        // Using '100%' can cause epub.js to calculate a different width than the container
        const containerWidth = containerRef.current.clientWidth;
        const containerHeight = containerRef.current.clientHeight;
        console.log(`📚 EPUB: Creating rendition with explicit dimensions: ${containerWidth}x${containerHeight}`);

        const rendition = book.renderTo(containerRef.current, {
          width: containerWidth,
          height: containerHeight,
          spread: 'none', // Force single page view to prevent clipping
          minSpreadWidth: 99999, // Prevent spread mode from activating on wide screens
          flow: 'paginated',
        });
        renditionRef.current = rendition;
        console.log('EPUB: Rendition created and set in ref', {
          hasRendition: !!renditionRef.current,
          refObject: renditionRef,
        });

        // Force overflow clipping on our container
        // epub.js may modify container styles, so re-apply after renderTo
        if (containerRef.current) {
          containerRef.current.style.overflow = 'hidden';
          containerRef.current.style.position = 'relative';
          console.log('📚 EPUB: Re-applied overflow:hidden to containerRef after renderTo');
        }

        // Also check the manager container
        // @ts-expect-error - epub.js manager property is not in public type definitions
        const manager = rendition.manager;
        if (manager?.container) {
          // The manager.container is what scrolls - it should have overflow:hidden on its PARENT
          // Log what styles epub.js set
          console.log('📚 EPUB: manager.container styles:', {
            overflow: manager.container.style.overflow,
            width: manager.container.style.width,
            position: manager.container.style.position,
          });
        }

        // Apply theme with !important to override EPUB styles
        const isDark = theme === 'dark';
        const bgColor = isDark ? '#09090B' : '#FFFFFF';
        const textColor = isDark ? '#FAFAFA' : '#09090B';
        const linkColor = isDark ? '#60A5FA' : '#2563EB';

        rendition.themes.default({
          'body': {
            'background': `${bgColor} !important`,
            'background-color': `${bgColor} !important`,
            'color': `${textColor} !important`,
            '-webkit-touch-callout': 'none',
          },
          'body *': {
            'color': `${textColor} !important`,
            'background-color': 'transparent !important',
            '-webkit-touch-callout': 'none',
          },
          'p, div, span, h1, h2, h3, h4, h5, h6, li, td, th': {
            'color': `${textColor} !important`,
          },
          'a': {
            'color': `${linkColor} !important`,
          },
        });

        // Create a promise that resolves when relocated event fires
        // This is more reliable than display() promise which sometimes never resolves
        let relocatedResolve: (() => void) | null = null;
        const relocatedPromise = new Promise<void>((resolve) => {
          relocatedResolve = resolve;
        });

        rendition.on('relocated', async (location: { start?: { cfi?: string } }) => {
          const cfi = location?.start?.cfi;
          if (cfi) {
            console.log('📍 EPUB: Relocated event - NEW CFI:', cfi);
            console.log('📍 EPUB: Relocated - calling onLocationChange callback');

            // Signal that display is complete (relocated = content is visible)
            if (relocatedResolve) {
              relocatedResolve();
              relocatedResolve = null; // Only resolve once
            }

            // Wait for currentLocation() to be internally ready (max 1 second)
            // This fixes timing issue where relocated event fires before currentLocation() is available
            let attempts = 0;
            const maxAttempts = 10;
            while (attempts < maxAttempts) {
              const currentLoc = rendition.currentLocation() as { start?: { cfi?: string } } | null;
              if (currentLoc && currentLoc.start && currentLoc.start.cfi) {
                console.log('EPUB: currentLocation() ready after', attempts * 100, 'ms');
                break;
              }
              await new Promise(resolve => setTimeout(resolve, 100));
              attempts++;
            }

            if (attempts >= maxAttempts) {
              console.warn('⚠️ EPUB: currentLocation() still not ready after 1 second, but proceeding');
            }

            setCurrentLocation(cfi);
            onLocationChange?.(cfi);
          }
        });

        rendition.on('displayError', (err: Error) => {
          console.error('📚 EPUB: Display error:', err);
        });

        // Display with multiple completion signals:
        // 1. display() promise resolves (sometimes doesn't happen in epub.js)
        // 2. relocated event fires (most reliable - means content is visible)
        // 3. timeout after 5 seconds (fallback)
        try {
          const locationToDisplay = typeof initialLocation === 'string' && initialLocation.startsWith('epubcfi')
            ? initialLocation
            : undefined;

          console.log('📚 EPUB: Starting display, location:', locationToDisplay || '(beginning)');

          // Start the display (don't await it directly - it may never resolve)
          const displayPromise = rendition.display(locationToDisplay);

          // Wait for ANY of these to complete:
          // - display() resolves
          // - relocated event fires (content is visible)
          // - 10 second timeout (increased for first load)
          await Promise.race([
            displayPromise,
            relocatedPromise,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Display timed out')), 10000)
            ),
          ]);
          console.log('📚 EPUB: Display complete!');
        } catch (displayError) {
          console.warn('📚 EPUB: Display timeout or error, continuing anyway:', displayError);
        }

        console.log('📚 EPUB: Setting isLoading to false...');
        setIsLoading(false);
        console.log('📚 EPUB: isLoading set to false');

        // Mark as initialized to prevent re-initialization
        isInitializedRef.current = true;
        console.log('📚 EPUB: isInitializedRef set to true');

        // Notify parent that rendition is ready (after display is complete)
        console.log('📚 EPUB: Calling onRenditionReady callback');
        if (onRenditionReady) {
          onRenditionReady();
        }
        console.log('📚 EPUB: onRenditionReady callback completed');

        // Defensive: ensure isLoading is false after callback completes
        // This catches race conditions where parent re-render sees stale state
        setIsLoading(false);

      } catch (err: unknown) {
        console.error('📚 EPUB: Error:', err);
        // Better error extraction
        let message = 'Unknown error';
        if (err instanceof Error) {
          message = err.message;
        } else if (typeof err === 'string') {
          message = err;
        } else if (err && typeof err === 'object') {
          message = JSON.stringify(err);
        }
        setError(`Failed to open EPUB: ${message}`);
        setIsLoading(false);
      }
    };

    initEpub().catch((err) => {
      console.error('📚 EPUB: Unhandled error in initEpub:', err);
      setError(`Failed to open EPUB: ${err?.message || String(err)}`);
      setIsLoading(false);
    });
    return cleanup;
  }, [url, containerReady, cleanup, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  // NOTE: initialLocation intentionally NOT in dependencies to prevent re-initialization on position load

  // Safety net: Synchronously fix stuck loader state after every render
  // This catches race conditions where parent re-renders reset state
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  useLayoutEffect(() => {
    if (isInitializedRef.current && isLoading) {
      console.log('📚 EPUB: Safety net (useLayoutEffect) - fixing stuck isLoading state');
      setIsLoading(false);
    }
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') prevPage();
      else if (e.key === 'ArrowRight') nextPage();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [prevPage, nextPage]);

  // Apply `initialLocation` *after* the initial mount. The DB-backed saved
  // position arrives asynchronously (drawer fetches it on open), and on first
  // mount the prop is often undefined. When it later resolves to a CFI, we
  // need to navigate the existing rendition there — but only if the user
  // hasn't already moved to their own spot.
  const lastAppliedLocationRef = useRef<string | number | undefined>(initialLocation);
  useEffect(() => {
    if (!isInitializedRef.current) return;
    if (!renditionRef.current) return;
    if (initialLocation === undefined || initialLocation === null) return;
    if (initialLocation === lastAppliedLocationRef.current) return;
    if (userNavRef && userNavRef.current > 0) {
      console.log('📚 EPUB: Skipping initialLocation update — user already navigated');
      return;
    }
    console.log('📚 EPUB: Applying restored initialLocation:', initialLocation);
    lastAppliedLocationRef.current = initialLocation;
    void renditionRef.current.display(
      typeof initialLocation === 'string' ? initialLocation : undefined
    );
  }, [initialLocation, renditionRef, userNavRef]);

  if (error) {
    return (
      <div
        className="h-full w-full flex flex-col items-center justify-center gap-4"
        style={{
          background: theme === 'dark' ? '#09090B' : '#FFFFFF',
          color: theme === 'dark' ? '#FAFAFA' : '#09090B',
        }}
      >
        <div className="text-destructive text-lg font-medium">
          {t('epub.errorLoadingBook', 'Error loading book')}
        </div>
        <div className="text-muted-foreground text-sm max-w-md text-center px-4">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col relative overflow-hidden" style={{ contain: 'layout paint', isolation: 'isolate' }}>
      {/* Force clip on epub.js container - 'clip' is stricter than 'hidden' */}
      <style>{`
        .epub-container {
          overflow: clip !important;
        }
      `}</style>
      {isLoading && (
        <div
          className="absolute inset-0 flex items-center justify-center z-10"
          style={{ background: theme === 'dark' ? '#09090B' : '#FFFFFF' }}
        >
          <div className="flex flex-col items-center gap-2">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-muted-foreground">
              {t('epub.loadingBook', 'Loading book...')}
            </span>
          </div>
        </div>
      )}

      <div className="absolute left-2 top-1/2 -translate-y-1/2 z-20">
        <Button variant="ghost" size="icon" onClick={prevPage} className="bg-background/80 hover:bg-background">
          <ChevronLeft className="h-6 w-6" />
        </Button>
      </div>

      <div className="absolute right-2 top-1/2 -translate-y-1/2 z-20">
        <Button variant="ghost" size="icon" onClick={nextPage} className="bg-background/80 hover:bg-background">
          <ChevronRight className="h-6 w-6" />
        </Button>
      </div>

      {/* TOC control */}
      <div className="absolute top-2 right-2 z-20 flex items-center gap-1 epub-viewer-container">
        <TooltipProvider delayDuration={300} skipDelayDuration={200}>
          {/* TOC button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={() => setShowToc(!showToc)} className="h-8 w-8 bg-background/80 hover:bg-background">
                <List className="h-5 w-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('epub.tableOfContents', 'Table of Contents')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {showToc && toc.length > 0 && (
        <div
          className="absolute top-12 right-2 z-30 w-64 max-h-96 overflow-y-auto border bg-background shadow-lg"
          style={{ background: theme === 'dark' ? '#09090B' : '#FFFFFF' }}
        >
          <div className="p-2">
            <div className="font-medium mb-2 text-sm">
              {t('epub.tableOfContents', 'Table of Contents')}
            </div>
            {toc.map((item, index) => (
              <button
                key={index}
                className="w-full text-left px-2 py-1 text-sm hover:bg-accent truncate"
                onClick={() => goToTocItem(item.href)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Outer clipping wrapper - NOT flexbox, will definitely clip */}
      <div
        className="flex-1 w-full"
        style={{
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Hard clipping boundary - block display, explicit dimensions */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            overflow: 'hidden',
            // NOT flexbox - this ensures overflow:hidden actually clips
            display: 'block',
          }}
        >
          {/* Inner container where epub.js renders */}
          <div
            ref={setContainerRef}
            className="epub-render-target"
            style={{
              width: '100%',
              height: '100%',
              background: theme === 'dark' ? '#09090B' : '#FFFFFF',
              filter: isInverted ? 'invert(1) hue-rotate(180deg)' : 'none',
              transition: 'filter 0.3s ease',
              overflow: 'hidden',
            }}
          />
        </div>
      </div>
    </div>
  );
};
