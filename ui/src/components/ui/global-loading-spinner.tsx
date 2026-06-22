import React, { memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLoadingService } from '@/lib/loading-service';
import { useIsMobile } from '@/hooks/use-mobile';
import { useDeepResearchPanel } from '@/contexts/deep-research-context';
import { useEpubViewer } from '@/contexts/epub-viewer-context';
import { usePDFViewer } from '@/contexts/pdf-viewer-context';
import { cn } from '@/lib/utils';

interface GlobalLoadingSpinnerProps {
  /** Additional CSS classes to apply to the overlay */
  readonly className?: string;
  /** Whether to show debug information about active operations */
  readonly showDebugInfo?: boolean;
  /** Custom z-index for the overlay */
  readonly zIndex?: number;
}

/**
 * Global loading spinner with snake-chasing-tail animation.
 *
 * Design:
 * - Snake segments chase each other around a square path
 * - Primary color gradient with glow effects
 * - Glass-morphism container with subtle shadow
 * - Theme-aware (adapts to light/dark mode)
 * - Mobile: centered on screen
 * - Desktop: upper-right corner
 *
 * @component
 */
const GlobalLoadingSpinnerComponent: React.FC<GlobalLoadingSpinnerProps> = ({
  className,
  showDebugInfo = false,
  zIndex = 9999
}) => {
  const { isLoading, activeCount, getDebugInfo } = useLoadingService();
  const isMobile = useIsMobile();
  const { isResearching, isOpen: isDeepResearchPanelOpen } = useDeepResearchPanel();
  const { state: epubViewerState } = useEpubViewer();
  const { state: pdfViewerState } = usePDFViewer();

  // Don't render if nothing is loading
  if (!isLoading) {
    return null;
  }

  // Don't show global spinner when deep research is active
  if (isResearching || isDeepResearchPanelOpen) {
    return null;
  }

  // Don't show global spinner when EPUB viewer is open (to avoid interrupting TTS/reading)
  if (epubViewerState.isOpen) {
    return null;
  }

  // Don't show global spinner when PDF viewer is open (to avoid interrupting reading/highlighting)
  if (pdfViewerState.isOpen) {
    return null;
  }

  const size = isMobile ? 60 : 56;
  const padding = 14;
  const trackSize = size - (padding * 2);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      className={cn(
        'fixed pointer-events-none',
        isMobile ? 'inset-0 flex items-center justify-center' : 'top-5 right-6',
        className
      )}
      style={{ zIndex }}
      role="status"
      aria-live="polite"
      aria-label={`Loading... ${activeCount} operation${activeCount !== 1 ? 's' : ''} in progress`}
    >
      <div className="relative">
        {/* Outer glow effect */}
        <motion.div
          className="absolute inset-0 bg-primary/20 blur-xl"
          animate={{ opacity: [0.3, 0.6, 0.3] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          style={{
            width: `${size + 16}px`,
            height: `${size + 16}px`,
            left: '-8px',
            top: '-8px',
          }}
        />

        {/* Main container with glass-morphism */}
        <div
          className={cn(
            'relative overflow-hidden',
            'bg-transparent',
            'border border-border/50',
            'shadow-lg shadow-primary/10 dark:shadow-primary/5'
          )}
          style={{
            width: `${size}px`,
            height: `${size}px`,
          }}
        >
          {/* Subtle inner gradient overlay */}
          <div className="absolute inset-0 bg-transparent" />

          {/* Track path indicator */}
          <div
            className="absolute border border-primary/15 dark:border-primary/10"
            style={{
              top: `${padding - 1}px`,
              left: `${padding - 1}px`,
              right: `${padding - 1}px`,
              bottom: `${padding - 1}px`,
            }}
          />

          {/* Snake animation track */}
          <div
            className="absolute"
            style={{
              top: `${padding}px`,
              left: `${padding}px`,
              right: `${padding}px`,
              bottom: `${padding}px`
            }}
          >
            {/* Snake head - with glow */}
            <motion.div
              className="absolute w-3 h-3 bg-primary shadow-[0_0_8px_2px] shadow-primary/50"
              animate={{
                x: [-6, trackSize - 6, trackSize - 6, -6, -6],
                y: [-6, -6, trackSize - 6, trackSize - 6, -6],
              }}
              transition={{
                duration: 1.6,
                repeat: Infinity,
                ease: "linear",
                times: [0, 0.25, 0.5, 0.75, 1]
              }}
            />

            {/* Snake body segment 1 */}
            <motion.div
              className="absolute w-2.5 h-2.5 bg-primary/85 shadow-[0_0_6px_1px] shadow-primary/40"
              animate={{
                x: [-5, trackSize - 5, trackSize - 5, -5, -5],
                y: [-5, -5, trackSize - 5, trackSize - 5, -5],
              }}
              transition={{
                duration: 1.6,
                repeat: Infinity,
                ease: "linear",
                times: [0, 0.25, 0.5, 0.75, 1],
                delay: 0.12
              }}
            />

            {/* Snake body segment 2 */}
            <motion.div
              className="absolute w-2 h-2 bg-primary/70 shadow-[0_0_4px_1px] shadow-primary/30"
              animate={{
                x: [-4, trackSize - 4, trackSize - 4, -4, -4],
                y: [-4, -4, trackSize - 4, trackSize - 4, -4],
              }}
              transition={{
                duration: 1.6,
                repeat: Infinity,
                ease: "linear",
                times: [0, 0.25, 0.5, 0.75, 1],
                delay: 0.24
              }}
            />

            {/* Snake body segment 3 */}
            <motion.div
              className="absolute w-1.5 h-1.5 bg-primary/55 shadow-[0_0_3px_1px] shadow-primary/20"
              animate={{
                x: [-3, trackSize - 3, trackSize - 3, -3, -3],
                y: [-3, -3, trackSize - 3, trackSize - 3, -3],
              }}
              transition={{
                duration: 1.6,
                repeat: Infinity,
                ease: "linear",
                times: [0, 0.25, 0.5, 0.75, 1],
                delay: 0.36
              }}
            />

            {/* Snake tail */}
            <motion.div
              className="absolute w-1 h-1 bg-primary/40 rounded-full"
              animate={{
                x: [-2, trackSize - 2, trackSize - 2, -2, -2],
                y: [-2, -2, trackSize - 2, trackSize - 2, -2],
              }}
              transition={{
                duration: 1.6,
                repeat: Infinity,
                ease: "linear",
                times: [0, 0.25, 0.5, 0.75, 1],
                delay: 0.48
              }}
            />
          </div>
        </div>

        {/* Active count badge */}
        <AnimatePresence>
          {activeCount > 1 && (
            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              className={cn(
                'absolute -top-1.5 -right-1.5',
                'min-w-[20px] h-[20px] px-1.5',
                'flex items-center justify-center',
                'bg-primary text-primary-foreground',
                'text-[10px] font-semibold',
                'border-2 border-background',
                'shadow-md shadow-primary/30'
              )}
              title={`${activeCount} operations active`}
            >
              {activeCount}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Debug info panel (development only) */}
      {showDebugInfo && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: 0.1 }}
          className={cn(
            'absolute mt-3',
            isMobile ? 'top-full left-1/2 -translate-x-1/2' : 'top-full right-0',
            'min-w-[220px] p-4',
            'bg-background/95 backdrop-blur-md',
            'border border-border',
            'shadow-lg shadow-black/10 dark:shadow-black/20',
            'text-xs text-muted-foreground',
            'pointer-events-auto'
          )}
        >
          <div className="font-semibold text-foreground mb-2">Loading Operations:</div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[10px] bg-muted/50 p-2 -mx-1">
            {JSON.stringify(getDebugInfo(), null, 2)}
          </pre>
        </motion.div>
      )}
    </motion.div>
  );
};

// Memoize the component to prevent unnecessary re-renders
export const GlobalLoadingSpinner = memo(GlobalLoadingSpinnerComponent);

/**
 * Inline loading spinner for smaller components
 * Primary color with subtle glow
 */
export const InlineLoadingSpinner: React.FC<{
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}> = ({ size = 'md', className }) => {
  const sizeConfig = {
    sm: { classes: 'h-4 w-4', border: 'border-[1.5px]' },
    md: { classes: 'h-6 w-6', border: 'border-2' },
    lg: { classes: 'h-8 w-8', border: 'border-[2.5px]' }
  };

  const config = sizeConfig[size];

  return (
    <motion.div
      className={cn(
        config.border,
        'border-primary/20 border-t-primary',
        'shadow-[0_0_4px_0] shadow-primary/20',
        config.classes,
        className
      )}
      animate={{ rotate: 360 }}
      transition={{
        duration: 0.8,
        repeat: Infinity,
        ease: "linear"
      }}
    />
  );
};
