import { useCallback, useMemo, useRef } from 'react';

/**
 * Configuration for swipe gesture detection
 */
export interface SwipeConfig {
  /** Minimum distance in pixels for a valid swipe */
  readonly minSwipeDistance?: number;
  /** Maximum time in milliseconds for a valid swipe */
  readonly maxSwipeTime?: number;
  /** Maximum deviation from horizontal axis (in pixels) */
  readonly maxVerticalDeviation?: number;
}

/**
 * Swipe gesture direction
 */
export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

/**
 * Swipe gesture event data
 */
export interface SwipeEvent {
  readonly direction: SwipeDirection;
  readonly distance: number;
  readonly duration: number;
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
}

/**
 * Touch/mouse position data
 */
interface TouchPosition {
  x: number;
  y: number;
  timestamp: number;
}

/**
 * Default swipe configuration
 */
const DEFAULT_CONFIG: Required<SwipeConfig> = {
  minSwipeDistance: 50,
  maxSwipeTime: 500,
  maxVerticalDeviation: 100
};

/**
 * Custom hook for detecting swipe gestures on mobile and desktop
 * Supports both touch events (mobile) and mouse events (desktop)
 *
 * @param onSwipe Callback function called when a valid swipe is detected
 * @param config Optional configuration for swipe detection
 * @returns Object with event handlers to attach to target element
 */
export function useSwipeGesture(
  onSwipe: (swipeEvent: SwipeEvent) => void,
  config: SwipeConfig = {}
) {
  const finalConfig = useMemo(
    () => ({ ...DEFAULT_CONFIG, ...config }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- individual config fields are stable primitives
    [config?.minSwipeDistance, config?.maxSwipeTime, config?.maxVerticalDeviation]
  );
  const startPosition = useRef<TouchPosition | null>(null);
  const isDragging = useRef(false);
  // True when the gesture began inside a horizontally-scrollable region (a wide
  // table, a code block, anything with overflow-x: auto/scroll wider than its
  // box). Panning such content sideways must NOT be hijacked into the
  // left/right "open notes / open sidebar" navigation swipe.
  const startedInScrollableX = useRef(false);

  /**
   * Walk up from the touch target to decide whether the gesture started inside
   * a horizontally-scrollable element. We require BOTH an overflow-x of
   * auto/scroll AND content actually wider than the box (scrollWidth >
   * clientWidth) so a non-scrolling table never blocks navigation swipes.
   */
  const beganInHorizontalScroller = useCallback((target: EventTarget | null): boolean => {
    let el: Element | null = target instanceof Element ? target : null;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.scrollWidth - el.clientWidth > 1) {
        const overflowX = window.getComputedStyle(el).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') {
          return true;
        }
      }
      el = el.parentElement;
    }
    return false;
  }, []);

  /**
   * Get touch/mouse position from event
   */
  const getPosition = useCallback((event: TouchEvent | MouseEvent): TouchPosition => {
    try {
      let touch: Touch | MouseEvent;

      if ('touches' in event) {
        // For touch events, use the first active touch or the first changed touch if no active touches
        touch = event.touches[0] || event.changedTouches[0];
        if (!touch) {
          // Fallback position to prevent crashes
          return {
            x: 0,
            y: 0,
            timestamp: Date.now()
          };
        }
      } else {
        touch = event as MouseEvent;
      }

      return {
        x: touch.clientX || 0,
        y: touch.clientY || 0,
        timestamp: Date.now()
      };
    } catch (error) {
      // Fallback position to prevent crashes
      return {
        x: 0,
        y: 0,
        timestamp: Date.now()
      };
    }
  }, []);

  /**
   * Calculate swipe direction and distance
   */
  const calculateSwipe = useCallback((start: TouchPosition, end: TouchPosition): SwipeEvent | null => {
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    const duration = end.timestamp - start.timestamp;

    // Check if swipe meets minimum requirements
    if (distance < finalConfig.minSwipeDistance || duration > finalConfig.maxSwipeTime) {
      return null;
    }

    // Determine primary direction
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);

    let direction: SwipeDirection;
    let deviation: number;

    if (absDeltaX > absDeltaY) {
      // Horizontal swipe
      direction = deltaX > 0 ? 'right' : 'left';
      deviation = absDeltaY;
    } else {
      // Vertical swipe
      direction = deltaY > 0 ? 'down' : 'up';
      deviation = absDeltaX;
    }

    // Check if deviation is within acceptable range for horizontal swipes
    if ((direction === 'left' || direction === 'right') && deviation > finalConfig.maxVerticalDeviation) {
      return null;
    }

    return {
      direction,
      distance,
      duration,
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y
    };
  }, [finalConfig]);

  /**
   * Handle start of touch/mouse interaction
   */
  const handleStart = useCallback((event: TouchEvent | MouseEvent) => {
    try {
      // Prevent default to avoid scrolling issues
      if ('touches' in event) {
        // Only handle single touch
        if (event.touches.length !== 1) return;
      }

      const position = getPosition(event);
      if (position.x === 0 && position.y === 0) return; // Skip if position detection failed

      startPosition.current = position;
      isDragging.current = true;
      startedInScrollableX.current = beganInHorizontalScroller(event.target);

      // Don't prevent default to avoid interfering with scrolling and other touch interactions
    } catch (error) {
      // Reset state on error
      startPosition.current = null;
      isDragging.current = false;
      startedInScrollableX.current = false;
    }
  }, [getPosition, beganInHorizontalScroller]);

  /**
   * Handle end of touch/mouse interaction
   */
  const handleEnd = useCallback((event: TouchEvent | MouseEvent) => {
    try {
      if (!isDragging.current || !startPosition.current) return;

      const endPosition = getPosition(event);
      if (endPosition.x === 0 && endPosition.y === 0) {
        // Reset state if position detection failed
        startPosition.current = null;
        isDragging.current = false;
        startedInScrollableX.current = false;
        return;
      }

      const swipeEvent = calculateSwipe(startPosition.current, endPosition);
      const blockHorizontal = startedInScrollableX.current;

      // Reset state
      startPosition.current = null;
      isDragging.current = false;
      startedInScrollableX.current = false;

      // Call callback if a valid swipe was detected — but drop horizontal
      // swipes that began inside a sideways-scrollable region (table / code
      // block) so panning that content never opens the notes drawer / sidebar.
      // Vertical swipes are unaffected; they don't drive that navigation.
      const isHorizontal =
        swipeEvent?.direction === 'left' || swipeEvent?.direction === 'right';
      if (swipeEvent && !(blockHorizontal && isHorizontal)) {
        onSwipe(swipeEvent);
      }
    } catch (error) {
      // Reset state on error
      startPosition.current = null;
      isDragging.current = false;
      startedInScrollableX.current = false;
    }
  }, [getPosition, calculateSwipe, onSwipe]);

  /**
   * Handle cancel (when touch is interrupted)
   */
  const handleCancel = useCallback(() => {
    startPosition.current = null;
    isDragging.current = false;
    startedInScrollableX.current = false;
  }, []);

  const touchHandlers = useMemo(() => ({
    onTouchStart: handleStart,
    onTouchEnd: handleEnd,
    onTouchCancel: handleCancel,
  }), [handleStart, handleEnd, handleCancel]);

  const mouseHandlers = useMemo(() => ({
    onMouseDown: handleStart,
    onMouseUp: handleEnd,
    onMouseLeave: handleCancel,
  }), [handleStart, handleEnd, handleCancel]);

  const allHandlers = useMemo(() => ({
    ...touchHandlers,
    ...mouseHandlers,
  }), [touchHandlers, mouseHandlers]);

  return {
    touchHandlers,
    mouseHandlers,
    allHandlers,
    isDragging: isDragging.current,
  };
}
