import { useEffect, useCallback } from 'react';

/**
 * Hook to handle dynamic viewport height changes on mobile devices
 * Addresses the issue where mobile browser URL bars appear/disappear causing layout shifts
 */
export const useDynamicViewport = () => {
  const updateViewportHeight = useCallback(() => {
    // Get the actual viewport height
    const vh = window.innerHeight * 0.01;
    const vw = window.innerWidth * 0.01;

    // Set CSS custom properties for dynamic viewport calculations
    document.documentElement.style.setProperty('--vh', `${vh}px`);
    document.documentElement.style.setProperty('--dynamic-vh', `${vh}px`);
    document.documentElement.style.setProperty('--vw', `${vw}px`);

    // Handle safe area insets for devices with notches/dynamic islands
    const computedStyle = getComputedStyle(document.documentElement);
    const safeAreaTop =
      computedStyle.getPropertyValue('--safe-area-inset-top') ||
      computedStyle.getPropertyValue('env(safe-area-inset-top)') ||
      '0px';
    const safeAreaBottom =
      computedStyle.getPropertyValue('--safe-area-inset-bottom') ||
      computedStyle.getPropertyValue('env(safe-area-inset-bottom)') ||
      '0px';

    document.documentElement.style.setProperty(
      '--safe-area-inset-top',
      safeAreaTop
    );
    document.documentElement.style.setProperty(
      '--safe-area-inset-bottom',
      safeAreaBottom
    );
  }, []);

  const handleResize = useCallback(() => {
    // Use requestAnimationFrame to ensure smooth updates
    requestAnimationFrame(updateViewportHeight);
  }, [updateViewportHeight]);

  const handleOrientationChange = useCallback(() => {
    // Handle orientation changes with a slight delay to ensure proper viewport calculation
    setTimeout(() => {
      requestAnimationFrame(updateViewportHeight);
    }, 100);
  }, [updateViewportHeight]);

  const handleVisibilityChange = useCallback(() => {
    // Handle when page becomes visible again (can trigger URL bar changes)
    if (!document.hidden) {
      setTimeout(() => {
        requestAnimationFrame(updateViewportHeight);
      }, 50);
    }
  }, [updateViewportHeight]);

  useEffect(() => {
    // Initial setup
    updateViewportHeight();

    // Add event listeners
    window.addEventListener('resize', handleResize, { passive: true });
    window.addEventListener('orientationchange', handleOrientationChange, {
      passive: true,
    });
    document.addEventListener('visibilitychange', handleVisibilityChange, {
      passive: true,
    });

    // Additional mobile-specific events
    if ('visualViewport' in window) {
      const visualViewport = window.visualViewport!;
      visualViewport.addEventListener('resize', handleResize, {
        passive: true,
      });
      visualViewport.addEventListener('scroll', handleResize, {
        passive: true,
      });
    }

    // Handle focus events that might trigger URL bar changes
    const handleFocus = () => {
      setTimeout(() => {
        requestAnimationFrame(updateViewportHeight);
      }, 300); // Delay to allow URL bar animation to complete
    };

    const handleBlur = () => {
      setTimeout(() => {
        requestAnimationFrame(updateViewportHeight);
      }, 300);
    };

    window.addEventListener('focus', handleFocus, { passive: true });
    window.addEventListener('blur', handleBlur, { passive: true });

    // Cleanup function
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleOrientationChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);

      if ('visualViewport' in window) {
        const visualViewport = window.visualViewport!;
        visualViewport.removeEventListener('resize', handleResize);
        visualViewport.removeEventListener('scroll', handleResize);
      }
    };
  }, [
    updateViewportHeight,
    handleResize,
    handleOrientationChange,
    handleVisibilityChange,
  ]);

  return {
    updateViewportHeight,
  };
};

/**
 * Utility function to get the current dynamic viewport height
 */
export const getDynamicViewportHeight = (): number => {
  const vh = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--dynamic-vh')
  );
  return vh || window.innerHeight * 0.01;
};

/**
 * Utility function to calculate height accounting for mobile browser UI
 */
export const calculateMobileHeight = (percentage: number = 100): string => {
  return `calc(${percentage} * var(--dynamic-vh, 1vh))`;
};
