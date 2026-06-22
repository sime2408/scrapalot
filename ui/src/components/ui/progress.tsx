'use client';

import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';

import { cn } from '@/lib/utils';

// Enhanced Progress Component with improved smoothing for WebSocket updates
const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
    indicatorClassName?: string;
  }
>(({ className, value, indicatorClassName, ...props }, ref) => {
  // State to track displayed progress value with smooth transitions
  const [displayValue, setDisplayValue] = React.useState(0);
  // Ref to store the target value for more reliable animation
  const targetValueRef = React.useRef(0);

  // Normalize and clamp the input value
  const normalizeAndClamp = (inputValue: unknown): number => {
    if (inputValue == null) return 0;
    const numValue =
      typeof inputValue === 'string'
        ? parseFloat(inputValue)
        : Number(inputValue);
    if (isNaN(numValue)) return 0;
    return Math.min(100, Math.max(0, numValue));
  };

  // The actual progress value after normalization
  const progressValue = normalizeAndClamp(value);

  // Update the target value ref when the progress value changes
  React.useEffect(() => {
    targetValueRef.current = progressValue;
  }, [progressValue]);

  // Animation effect to smoothly update the display value
  React.useEffect(() => {
    // Skip animation for values that are already very close
    if (Math.abs(displayValue - targetValueRef.current) < 0.5) {
      if (displayValue !== targetValueRef.current) {
        setDisplayValue(targetValueRef.current);
      }
      return;
    }

    // For completion (100%) or very small values, skip animation
    if (targetValueRef.current === 100 || targetValueRef.current === 0) {
      setDisplayValue(targetValueRef.current);
      return;
    }

    // Determine animation speed based on the jump size
    const jumpSize = Math.abs(displayValue - targetValueRef.current);
    let animationSpeed = 30; // Default 30ms for normal updates
    let incrementSize = 1; // Default increment size

    // Adjust speed and increment for different jump sizes
    if (jumpSize > 20) {
      // For very large jumps, move faster
      animationSpeed = 20;
      incrementSize = Math.max(2, Math.floor(jumpSize / 10));
    } else if (jumpSize > 10) {
      // For medium jumps
      animationSpeed = 25;
      incrementSize = 2;
    }

    const animationId = setTimeout(() => {
      if (displayValue < targetValueRef.current) {
        // Moving up
        setDisplayValue(prev =>
          Math.min(targetValueRef.current, prev + incrementSize)
        );
      } else if (displayValue > targetValueRef.current) {
        // Moving down (rare, but supported)
        setDisplayValue(prev =>
          Math.max(targetValueRef.current, prev - incrementSize)
        );
      }
    }, animationSpeed);

    return () => clearTimeout(animationId);
  }, [displayValue]);

  // Handle extreme jumps (like from 0 to 80%) immediately
  React.useEffect(() => {
    const jumpSize = Math.abs(displayValue - progressValue);

    // For very large jumps, immediately move closer to target
    if (jumpSize > 40) {
      // Jump halfway there immediately
      setDisplayValue(prev => prev + (progressValue - prev) / 2);
    } else if (progressValue === 100 && displayValue < 95) {
      // Special case: If target is 100% and we're not close, jump to 95%
      setDisplayValue(95);
    }
  }, [progressValue, displayValue]);

  return (
    <ProgressPrimitive.Root
      ref={ref}
      className={cn(
        'relative h-4 w-full overflow-hidden rounded-full bg-secondary',
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          'h-full w-full flex-1 bg-primary transition-all',
          indicatorClassName // Allows customizing indicator color (e.g., for success/error)
        )}
        style={{
          transform: `translateX(-${100 - displayValue}%)`,
          transitionProperty: 'transform',
          transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
          transitionDuration: '100ms', // Faster transition for smoother appearance
        }}
      />
    </ProgressPrimitive.Root>
  );
});
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
