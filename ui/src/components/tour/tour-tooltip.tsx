import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useTour } from '@/contexts/tour-context';
import { X, ArrowLeft, ArrowRight, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

interface TooltipPosition {
  top: number;
  left: number;
}

interface TourTooltipProps {
  spotlightPosition: { top: number; left: number; width: number; height: number } | null;
}

export const TourTooltip: React.FC<TourTooltipProps> = ({ spotlightPosition }) => {
  const { currentStep, steps, nextStep, previousStep, skipTour, goToStep } = useTour();
  const [position, setPosition] = useState<TooltipPosition>({ top: 0, left: 0 });
  const isMobile = useIsMobile();

  const currentStepData = steps[currentStep];
  const isFirstStep = currentStep === 0;
  const isLastStep = currentStep === steps.length - 1;

  useEffect(() => {
    if (!currentStepData) return;
    // On mobile, tooltip is a bottom sheet — no positioning needed
    if (isMobile) return;

    const calculatePosition = () => {
      const tooltipWidth = 400;
      const tooltipHeight = 200;
      // Steps that anchor to `body` (welcome, command-palette, complete)
      // describe a concept rather than a UI element. Pinning the
      // tooltip to the body's bounding rect put it at the very bottom
      // of the viewport on tall pages and made the welcome screen
      // feel like a footer banner. Render those steps centred
      // horizontally and slightly above the vertical centre — under
      // the dashboard's "Start new conversation" CTA so the eye flows
      // CTA → tour copy.
      const isBodyAnchored = currentStepData.target === 'body';
      if (isBodyAnchored || !spotlightPosition) {
        // Tooltip top at ~55 % of viewport height. The dashboard's
        // "Start new conversation" CTA sits roughly at viewport
        // centre, so 55 % drops the welcome card immediately under
        // it instead of overlapping the headline + CTA on top.
        setPosition({
          top: Math.round(window.innerHeight * 0.55),
          left: Math.round(window.innerWidth / 2 - tooltipWidth / 2),
        });
        return;
      }

      const offset = currentStepData.offset || { x: 0, y: 0 };
      const spacing = 24;

      let top = 0;
      let left = 0;

      switch (currentStepData.placement) {
        case 'top':
          top = spotlightPosition.top - tooltipHeight - spacing + offset.y;
          left = spotlightPosition.left + spotlightPosition.width / 2 - tooltipWidth / 2 + offset.x;
          break;
        case 'bottom':
          top = spotlightPosition.top + spotlightPosition.height + spacing + offset.y;
          left = spotlightPosition.left + spotlightPosition.width / 2 - tooltipWidth / 2 + offset.x;
          break;
        case 'left':
          top = spotlightPosition.top + spotlightPosition.height / 2 - tooltipHeight / 2 + offset.y;
          left = spotlightPosition.left - tooltipWidth - spacing + offset.x;
          break;
        case 'right':
          top = spotlightPosition.top + spotlightPosition.height / 2 - tooltipHeight / 2 + offset.y;
          left = spotlightPosition.left + spotlightPosition.width + spacing + offset.x;
          break;
      }

      const padding = 16;
      top = Math.max(padding, Math.min(top, window.innerHeight - tooltipHeight - padding));
      left = Math.max(padding, Math.min(left, window.innerWidth - tooltipWidth - padding));
      top = Math.max(padding, top - 100);

      setPosition({ top, left });
    };

    calculatePosition();
    window.addEventListener('resize', calculatePosition);
    return () => window.removeEventListener('resize', calculatePosition);
  }, [currentStepData, spotlightPosition, isMobile]);

  if (!currentStepData) return null;

  // Mobile: sheet layout — pinned to top when the spotlight sits in
  // the lower half of the viewport so the bottom sheet doesn't
  // occlude the very element it's pointing at. Falls back to bottom
  // for top-half targets (and body-anchored welcome / complete steps
  // which have no spotlight rect).
  if (isMobile) {
    const dockToTop = !!(
      spotlightPosition &&
      spotlightPosition.top + spotlightPosition.height / 2 >
        window.innerHeight * 0.5
    );
    return (
      <motion.div
        key={currentStep}
        initial={{ opacity: 0, y: dockToTop ? -60 : 60 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: dockToTop ? -60 : 60 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className={cn(
          'fixed left-0 right-0 z-[10000] pointer-events-auto',
          dockToTop ? 'top-0' : 'bottom-0'
        )}
      >
        <div className="bg-background border-t-2 border-primary shadow-2xl">
          {/* Drag handle */}
          <div className="flex justify-center pt-2 pb-1">
            <div className="w-8 h-1 bg-border" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-4 pb-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="p-1 bg-primary/10 flex-shrink-0">
                <Zap className="w-3.5 h-3.5 text-primary" />
              </div>
              <h3 className="text-base font-semibold text-foreground truncate">{currentStepData.title}</h3>
            </div>
            <button
              onClick={skipTour}
              className="p-1.5 hover:bg-accent transition-colors flex-shrink-0"
              aria-label="Close tour"
            >
              <X className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>

          {/* Content */}
          <div className="px-4 pb-3">
            <p className="text-sm text-muted-foreground leading-relaxed">
              {currentStepData.description}
            </p>
          </div>

          {/* Footer */}
          <div className="px-4 pb-4 pt-2 border-t border-border bg-accent/30">
            <div className="flex items-center justify-between">
              {/* Progress bar */}
              <div className="flex items-center gap-1.5">
                {steps.map((_, index) => (
                  <button
                    key={index}
                    onClick={() => goToStep(index)}
                    aria-label={`Go to step ${index + 1}`}
                  >
                    <div
                      className={`w-1.5 h-1.5 rounded-full transition-all ${
                        index === currentStep
                          ? 'bg-primary scale-125'
                          : index < currentStep
                          ? 'bg-primary/50'
                          : 'bg-border'
                      }`}
                    />
                  </button>
                ))}
                <span className="text-xs text-muted-foreground font-mono ml-2">
                  {currentStep + 1}/{steps.length}
                </span>
              </div>

              {/* Navigation. Back collapses to an icon-only button so
                  the row fits inside the 400 px tooltip when the
                  primary button widens to "Get Started" + Zap on the
                  final step. The arrow direction reads on its own and
                  aria-label keeps it accessible. */}
              <div className="flex items-center gap-2">
                {!isFirstStep && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={previousStep}
                    aria-label="Back"
                    title="Back"
                    className="h-8 w-8 p-0"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                  </Button>
                )}
                <Button
                  variant="default"
                  size="sm"
                  onClick={nextStep}
                  className="gap-1 h-8 px-3 bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {isLastStep ? (
                    <>
                      Get Started
                      <Zap className="w-3.5 h-3.5" />
                    </>
                  ) : (
                    <>
                      Next
                      <ArrowRight className="w-3.5 h-3.5" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    );
  }

  // Desktop: positioned tooltip
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.95 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="fixed z-[10000] pointer-events-auto"
      style={{
        top: position.top,
        left: position.left,
        width: '400px',
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      <div className="bg-background border-2 border-primary shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-primary/10">
              <Zap className="w-4 h-4 text-primary" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">{currentStepData.title}</h3>
          </div>
          <button
            onClick={skipTour}
            className="p-1 hover:bg-accent transition-colors"
            aria-label="Close tour"
          >
            <X className="w-5 h-5 text-muted-foreground hover:text-foreground" />
          </button>
        </div>

        <div className="p-6">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {currentStepData.description}
          </p>
        </div>

        <div className="p-4 border-t border-border bg-accent/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {steps.map((_, index) => (
                <button
                  key={index}
                  onClick={() => goToStep(index)}
                  className="group relative"
                  aria-label={`Go to step ${index + 1}`}
                >
                  <div
                    className={`w-2 h-2 rounded-full transition-all ${
                      index === currentStep
                        ? 'bg-primary scale-125'
                        : index < currentStep
                        ? 'bg-primary/50'
                        : 'bg-border'
                    }`}
                  />
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                    <div className="bg-foreground text-background text-xs px-2 py-1 whitespace-nowrap">
                      {steps[index].title}
                    </div>
                  </div>
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              {!isFirstStep && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={previousStep}
                  aria-label="Back"
                  title="Back"
                  className="h-8 w-8 p-0"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                </Button>
              )}

              <Button
                variant="default"
                size="sm"
                onClick={nextStep}
                className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {isLastStep ? (
                  <>
                    Get Started
                    <Zap className="w-3.5 h-3.5" />
                  </>
                ) : (
                  <>
                    Next
                    <ArrowRight className="w-3.5 h-3.5" />
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className="mt-3 text-center">
            <span className="text-xs text-muted-foreground font-mono">
              {currentStep + 1} / {steps.length}
            </span>
          </div>
        </div>
      </div>

      {spotlightPosition && currentStepData.placement !== 'top' && (
        <div
          className="absolute w-0 h-0"
          style={{
            ...(currentStepData.placement === 'bottom' && {
              top: -8,
              left: '50%',
              transform: 'translateX(-50%)',
              borderLeft: '8px solid transparent',
              borderRight: '8px solid transparent',
              borderBottom: '8px solid hsl(var(--primary))',
            }),
            ...(currentStepData.placement === 'left' && {
              top: '50%',
              right: -8,
              transform: 'translateY(-50%)',
              borderTop: '8px solid transparent',
              borderBottom: '8px solid transparent',
              borderLeft: '8px solid hsl(var(--primary))',
            }),
            ...(currentStepData.placement === 'right' && {
              top: '50%',
              left: -8,
              transform: 'translateY(-50%)',
              borderTop: '8px solid transparent',
              borderBottom: '8px solid transparent',
              borderRight: '8px solid hsl(var(--primary))',
            }),
          }}
        />
      )}
    </motion.div>
  );
};
