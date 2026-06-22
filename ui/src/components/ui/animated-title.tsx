import React, { useRef, useState, useEffect, useLayoutEffect } from 'react';
import { cn } from '@/lib/utils';

interface AnimatedTitleProps {
  title: string;
  className?: string;
  maxAnimations?: number; // Number of scroll cycles before showing ellipsis (default: 2)
  animationDuration?: number; // Duration of one scroll cycle in ms (default: 15000)
  pauseDuration?: number; // Pause at each end in ms (default: 2000)
  disableNativeTitle?: boolean; // Suppress the native `title` tooltip (e.g. when wrapped in a Radix Tooltip)
}

/**
 * AnimatedTitle - A smart title component that:
 * 1. Shows full title if it fits within container
 * 2. If overflow detected, animates text scrolling left-right
 * 3. After specified cycles, stops and shows ellipsis
 */
export const AnimatedTitle = ({
  title,
  className,
  maxAnimations = 2,
  animationDuration = 15000,
  pauseDuration = 2000,
  disableNativeTitle = false,
}: AnimatedTitleProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [overflowAmount, setOverflowAmount] = useState(0);
  const [animationPhase, setAnimationPhase] = useState<'checking' | 'idle' | 'animating' | 'done'>('checking');
  const [scrollPosition, setScrollPosition] = useState(0);
  const [animationCycle, setAnimationCycle] = useState(0);
  const animationRef = useRef<number | null>(null);

  // Check overflow and start animation if needed
  useLayoutEffect(() => {
    let cancelled = false;

    const checkOverflow = () => {
      if (cancelled || !containerRef.current || !measureRef.current) return;

      const containerWidth = containerRef.current.offsetWidth;
      const textWidth = measureRef.current.offsetWidth;

      // Need at least 5px overflow to trigger
      if (textWidth > containerWidth + 5) {
        const overflow = textWidth - containerWidth + 20; // Extra padding for readability
        setOverflowAmount(overflow);
        setAnimationPhase('animating');
        setAnimationCycle(0);
        setScrollPosition(0);
      } else {
        setOverflowAmount(0);
        setAnimationPhase('idle');
        setScrollPosition(0);
      }
    };

    // Reset state
    setAnimationPhase('checking');
    setScrollPosition(0);
    setAnimationCycle(0);

    // Check multiple times as layout settles
    const timers = [
      setTimeout(checkOverflow, 50),
      setTimeout(checkOverflow, 200),
      setTimeout(checkOverflow, 500),
    ];

    // Also observe resize
    const resizeObserver = new ResizeObserver(() => {
      if (!cancelled) checkOverflow();
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      resizeObserver.disconnect();
    };
  }, [title]);

  // Animation effect
  useEffect(() => {
    if (animationPhase !== 'animating' || overflowAmount <= 0) return;

    const easeInOutCubic = (t: number): number => {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    };

    let startTime: number | null = null;
    let currentPhase: 'pause1' | 'left' | 'pause2' | 'right' = 'pause1';
    let phaseStart = 0;

    const animate = (timestamp: number) => {
      if (startTime === null) {
        startTime = timestamp;
        phaseStart = timestamp;
      }

      const phaseElapsed = timestamp - phaseStart;

      switch (currentPhase) {
        case 'pause1':
          if (phaseElapsed >= pauseDuration) {
            currentPhase = 'left';
            phaseStart = timestamp;
          }
          break;

        case 'left': {
          const progress = Math.min(phaseElapsed / animationDuration, 1);
          setScrollPosition(-overflowAmount * easeInOutCubic(progress));
          if (progress >= 1) {
            currentPhase = 'pause2';
            phaseStart = timestamp;
          }
          break;
        }

        case 'pause2':
          if (phaseElapsed >= pauseDuration) {
            currentPhase = 'right';
            phaseStart = timestamp;
          }
          break;

        case 'right': {
          const progress = Math.min(phaseElapsed / animationDuration, 1);
          setScrollPosition(-overflowAmount * (1 - easeInOutCubic(progress)));
          if (progress >= 1) {
            // Cycle complete
            const nextCycle = animationCycle + 1;
            if (nextCycle >= maxAnimations) {
              setAnimationPhase('done');
              setScrollPosition(0);
              return;
            }
            setAnimationCycle(nextCycle);
            currentPhase = 'pause1';
            phaseStart = timestamp;
          }
          break;
        }
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [animationPhase, animationCycle, overflowAmount, maxAnimations, animationDuration, pauseDuration]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  const isOverflowing = overflowAmount > 0;
  const showEllipsis = animationPhase === 'done' && isOverflowing;

  return (
    <div
      ref={containerRef}
      className={cn(
        'overflow-hidden relative w-full',
        className
      )}
      title={isOverflowing && !disableNativeTitle ? title : undefined}
    >
      {/* Hidden measurement span - always rendered to measure text */}
      <span
        ref={measureRef}
        className="absolute invisible whitespace-nowrap pointer-events-none"
        style={{ top: 0, left: 0 }}
        aria-hidden="true"
      >
        {title}
      </span>

      {/* Visible title */}
      {showEllipsis ? (
        <span className="block truncate">{title}</span>
      ) : (
        <span
          className="inline-block whitespace-nowrap"
          style={{ transform: `translateX(${scrollPosition}px)` }}
        >
          {title}
        </span>
      )}
    </div>
  );
};
