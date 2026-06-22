import React, {
  createContext,
  useContext,
  useState,
  ReactNode,
  useEffect,
} from 'react';

interface SidebarContextType {
  isSidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;
  openSidebar: () => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  resetSidebarOnLogin: () => void;
}

const SidebarContext = createContext<SidebarContextType | undefined>(undefined);

// Default, min and max sidebar widths
const DEFAULT_SIDEBAR_WIDTH = 335;
const MIN_SIDEBAR_WIDTH = 300;
const MAX_SIDEBAR_WIDTH = 500;

// Screen size breakpoint for auto-collapse (matches TABLET_BREAKPOINT in use-mobile.tsx)
const SIDEBAR_AUTO_COLLAPSE_BREAKPOINT = 1200;

export const SidebarProvider = ({
  children,
  defaultOpen = false,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
}) => {
  const [isSidebarOpen, setIsSidebarOpen] = useState(defaultOpen);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);

  // Load saved width and sidebar state from localStorage on mount
  useEffect(() => {
    const savedWidth = localStorage.getItem('sidebarWidth');
    if (savedWidth) {
      const width = parseInt(savedWidth, 10);
      // Ensure width is within constraints
      if (width >= MIN_SIDEBAR_WIDTH && width <= MAX_SIDEBAR_WIDTH) {
        setSidebarWidth(width);
      }
    }

    // Load saved sidebar state or set default based on screen size
    const savedSidebarState = localStorage.getItem('sidebarOpen');
    const isLargeScreen = window.innerWidth >= SIDEBAR_AUTO_COLLAPSE_BREAKPOINT;

    if (savedSidebarState !== null) {
      // Use saved state but force closed on small screens
      const savedState = savedSidebarState === 'true';
      setIsSidebarOpen(isLargeScreen ? savedState : false);
    } else {
      // No saved state - large screens open by default, small screens closed
      setIsSidebarOpen(isLargeScreen);
    }

    // Add resize listener to handle screen size changes
    const handleResize = () => {
      const currentIsLargeScreen = window.innerWidth >= SIDEBAR_AUTO_COLLAPSE_BREAKPOINT;
      // Force close sidebar on small screens, respect saved state on large screens
      if (!currentIsLargeScreen) {
        setIsSidebarOpen(false);
      } else if (localStorage.getItem('sidebarOpen') === null) {
        setIsSidebarOpen(true);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Listen for login events to reset sidebar state
  useEffect(() => {
    const handleLoginReset = () => {
      // Small delay to ensure screen size is properly detected
      setTimeout(() => {
        resetSidebarOnLogin();
      }, 100);
    };

    // Listen for auth-ready event (fired after successful login)
    window.addEventListener('auth-ready', handleLoginReset);

    return () => {
      window.removeEventListener('auth-ready', handleLoginReset);
    };
  }, []);

  const toggleSidebar = () => {
    const newState = !isSidebarOpen;
    setIsSidebarOpen(newState);
    localStorage.setItem('sidebarOpen', newState.toString());
  };

  const closeSidebar = () => {
    setIsSidebarOpen(false);
    localStorage.setItem('sidebarOpen', 'false');
  };

  const openSidebar = () => {
    setIsSidebarOpen(true);
    localStorage.setItem('sidebarOpen', 'true');
  };

  // Update sidebar width with constraints and save to localStorage
  const handleSetSidebarWidth = (width: number) => {
    const constrainedWidth = Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(MAX_SIDEBAR_WIDTH, width)
    );
    setSidebarWidth(constrainedWidth);
    localStorage.setItem('sidebarWidth', constrainedWidth.toString());
  };

  // Reset sidebar state based on screen size after login
  const resetSidebarOnLogin = () => {
    const newState = window.innerWidth >= SIDEBAR_AUTO_COLLAPSE_BREAKPOINT; // Open on large screens, closed on small screens
    setIsSidebarOpen(newState);
    localStorage.setItem('sidebarOpen', newState.toString());
  };

  return (
    <SidebarContext.Provider
      value={{
        isSidebarOpen,
        toggleSidebar,
        closeSidebar,
        openSidebar,
        sidebarWidth,
        setSidebarWidth: handleSetSidebarWidth,
        resetSidebarOnLogin,
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export const useSidebar = (): SidebarContextType => {
  const context = useContext(SidebarContext);
  if (context === undefined) {
    // During HMR (hot module reload), context might be temporarily unavailable
    // Check if we're in development mode and provide a safe fallback
    if (import.meta.env.DEV) {
      console.warn('useSidebar: SidebarContext not available (possibly during HMR). Using fallback values.');
      // Return a safe fallback during HMR to prevent crashes
      return {
        isSidebarOpen: false,
        toggleSidebar: () => {},
        closeSidebar: () => {},
        openSidebar: () => {},
        sidebarWidth: 335,
        setSidebarWidth: () => {},
        resetSidebarOnLogin: () => {},
      } as SidebarContextType;
    }
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return context;
};
