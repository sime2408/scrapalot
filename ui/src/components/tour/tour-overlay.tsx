import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTour } from '@/contexts/tour-context';
import { TourTooltip } from './tour-tooltip';
import { useIsMobile } from '@/hooks/use-mobile';

interface SpotlightPosition {
  top: number;
  left: number;
  width: number;
  height: number;
}

export const TourOverlay: React.FC = () => {
  const { isActive, currentStep, steps } = useTour();
  const [spotlightPosition, setSpotlightPosition] = useState<SpotlightPosition | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const isMobile = useIsMobile();

  const currentStepData = steps[currentStep];

  const updateSpotlight = useCallback(() => {
    if (!currentStepData) return;

    const target = document.querySelector(currentStepData.target);
    if (!target) {
      setSpotlightPosition(null);
      return;
    }

    const rect = target.getBoundingClientRect();
    const padding = currentStepData.spotlightPadding || 12;

    setSpotlightPosition({
      top: rect.top - padding + window.scrollY,
      left: rect.left - padding + window.scrollX,
      width: rect.width + padding * 2,
      height: rect.height + padding * 2,
    });
  }, [currentStepData]);

  useEffect(() => {
    if (isActive) {
      setIsVisible(true);
      const timer = setTimeout(() => {
        updateSpotlight();
      }, 100);

      window.addEventListener('resize', updateSpotlight);
      window.addEventListener('scroll', updateSpotlight);

      return () => {
        clearTimeout(timer);
        window.removeEventListener('resize', updateSpotlight);
        window.removeEventListener('scroll', updateSpotlight);
      };
    } else {
      setIsVisible(false);
    }
  }, [isActive, currentStep, updateSpotlight]);

  if (!isVisible) return null;

  // Mirrors the tooltip's docking decision so the backdrop doesn't
  // darken the area where the bottom-sheet tooltip will render.
  // Without this, when the tooltip flips to the top of the viewport
  // for lower-half targets the gap is left at the bottom and the
  // sheet itself ends up on a fully dark backdrop.
  const mobileSheetAtTop = !!(
    isMobile &&
    spotlightPosition &&
    spotlightPosition.top + spotlightPosition.height / 2 >
      window.innerHeight * 0.5
  );

  return (
    <AnimatePresence>
      {isActive && (
        <>
          {/* Modal backdrop. `pointer-events-auto` makes the tour
              fully block — the user has to either Next-through the
              walkthrough or hit the X / Esc to leave. Without this
              an opened drawer / modal that happened to be visible
              when the tour auto-started stayed clickable underneath
              and the spotlight pointed at things the user kept
              interacting with, breaking the staged experience the
              tour copy assumes. The bottom-sheet exception on
              mobile is preserved so the tooltip itself can still
              be tapped. */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 z-[9998] pointer-events-auto"
            style={{
              ...(isMobile
                ? mobileSheetAtTop
                  ? { top: 200 }
                  : { bottom: 200 }
                : {}),
              background: spotlightPosition
                ? `radial-gradient(
                    circle at ${spotlightPosition.left + spotlightPosition.width / 2}px ${
                    spotlightPosition.top + spotlightPosition.height / 2
                  }px,
                    transparent ${Math.max(spotlightPosition.width, spotlightPosition.height) / 2}px,
                    rgba(0, 0, 0, 0.7) ${Math.max(spotlightPosition.width, spotlightPosition.height) / 2 + 100}px
                  )`
                : 'rgba(0, 0, 0, 0.7)',
            }}
            // Swallow every click — only the tooltip's own buttons
            // (already pointer-events-auto) should respond.
            onClick={(e) => e.stopPropagation()}
          />

          {/* Spotlight border */}
          {spotlightPosition && (
            <motion.div
              key={currentStep}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="fixed z-[9999] pointer-events-none"
              style={{
                top: spotlightPosition.top,
                left: spotlightPosition.left,
                width: spotlightPosition.width,
                height: spotlightPosition.height,
              }}
            >
              <div className="absolute inset-0 border-2 border-primary shadow-[0_0_0_4px_rgba(0,0,0,0.1)]" />
              <div className="absolute -top-1 -left-1 w-3 h-3 bg-primary" />
              <div className="absolute -top-1 -right-1 w-3 h-3 bg-primary" />
              <div className="absolute -bottom-1 -left-1 w-3 h-3 bg-primary" />
              <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-primary" />
            </motion.div>
          )}

          {/* Tooltip */}
          <TourTooltip spotlightPosition={spotlightPosition} />
        </>
      )}
    </AnimatePresence>
  );
};
