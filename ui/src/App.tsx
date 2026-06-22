import { useEffect } from 'react';
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { initNativeAppShell, isNativeApp } from './lib/native-app';

// Detect if running in Electron (file:// protocol or electron API available)
const isElectron = typeof window !== 'undefined' && (
  window.location.protocol === 'file:' ||
  // @ts-expect-error - window.electron is defined in preload script, not in TS types
  typeof window.electron !== 'undefined'
);

// React Router v7 future flags to opt-in early and suppress warnings
const routerFutureFlags = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
};

// Use HashRouter for Electron (file:// protocol), BrowserRouter for web
const Router = isElectron ? HashRouter : BrowserRouter;
// ToastProvider no longer needed - using toast-compat
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarProvider } from './contexts/sidebar-context';
import { ThemeProvider } from './providers/theme-provider';
import { LanguageProvider } from './providers/language-provider';
import { AuthProvider } from './contexts/auth-context';
import { WorkspaceProvider } from './contexts/workspace-context';
import { LoadingProvider } from './contexts/loading-context';
import { ApiClientProvider } from './contexts/api-client-context';
import { FontSettingsProvider } from './contexts/font-settings-context';
import { PDFViewerProvider } from './contexts/pdf-viewer-context';
import { EpubViewerProvider } from './contexts/epub-viewer-context';
import { DocxViewerProvider } from './contexts/docx-viewer-context';
import { MarkdownViewerProvider } from './contexts/markdown-viewer-context';
import { DeepResearchProvider } from './contexts/deep-research-context';
import { FloatingWindowProvider } from './contexts/floating-window-context';
import { EdgeSnapOverlay } from './components/ui/edge-snap-overlay';
import { ProcessingOverlay } from './components/ui/processing-overlay';
import { OfflineModeBanner } from './components/ui/offline-mode-banner';
import { ServiceUpdateBanner } from './components/ui/service-update-banner';
import { ImpersonationBanner } from './components/ui/impersonation-banner';
import { SettingsPreloader } from './components/settings/settings-preloader';
import {
  SafeGlobalPDFViewer,
  SafeGlobalEpubViewer,
  SafeGlobalDocxViewer,
  SafeGlobalMarkdownViewer,
} from './components/knowledge/safe-global-viewers';
import { GlobalNotesDrawer } from './components/notes/global-notes-drawer';
import { ToolDock } from './components/tool-dock/tool-dock';
import { AdminMessagesProvider } from './contexts/admin-messages-context';
import { AdminToastHost } from './components/notifications/admin-toast-host';
import { CommandPalette } from './components/command-palette/command-palette';
import { GlobalLoadingSpinner } from './components/ui/global-loading-spinner';
import { useAuth } from './hooks/use-auth';
// AdminDebugButton is now standalone (initialized in main.tsx BEFORE React, survives crashes)
// import { PerformanceMonitorWidget } from './components/ui/performance-monitor-widget';
import { ModelsProvider } from './contexts/models-context';
import { CartProvider } from './contexts/cart-context';
import { CollectionsProvider } from './contexts/collections-context';
import { TourProvider } from './contexts/tour-context';
import { TourOverlay } from './components/tour';
import { ErrorBoundary } from './components/error-boundary';
import { useDynamicViewport } from './hooks/use-dynamic-viewport';
import ScrollToTop from './components/ui/scroll-to-top';
import CanonicalUrl from './components/ui/canonical-url';
import { DesktopAutoLogin } from './components/desktop-auto-login';
import Index from './pages/Index';
import NotFound from './pages/NotFound';
import LoginPage from './pages/login';
import SignUpPage from './pages/sign-up';
import HomePage from './pages/home';
import PricingPage from './pages/pricing';
import BuyLicensePage from './pages/buy-license';
import AboutPage from './pages/about';
import Shop from './pages/Shop';
import DesktopPage from './pages/desktop';
import ContactPage from './pages/contact';
import PrivacyPage from './pages/privacy';
import DeleteAccountPage from './pages/delete-account';
import InvitePage from './pages/invite';
import SharedConversationPage from './pages/shared-conversation';
import ProtectedRoute from './components/protected-route';


// Create a client with optimized settings to reduce duplicate calls and over-fetching
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Use data for longer before refetching (15 seconds)
      staleTime: 15000,

      // Cache data for 5 minutes
      gcTime: 5 * 60 * 1000,

      // Only retry failed queries once
      retry: 1,

      // Don't refetch automatically on window focus or reconnect
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,

      // Don't refetch on component mount if data is stale but not invalidated
      refetchOnMount: true,
    },
  },
});

// App routes where the authenticated tooling (tool dock, notes, command palette)
// belongs. On public marketing pages (/home, /pricing, /about, …) these must stay
// hidden even when the user is logged in.
const APP_ROUTES = ['/dashboard', '/workspaces'];

// Wrapper for components that should only render when authenticated AND on an app route
const AuthenticatedComponents = () => {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  const isAppRoute = APP_ROUTES.some(
    (route) => location.pathname === route || location.pathname.startsWith(`${route}/`),
  );

  if (!isAuthenticated || !isAppRoute) {
    return null;
  }

  return (
    <AdminMessagesProvider>
      <GlobalNotesDrawer />
      <ToolDock />
      <CommandPalette />
      <AdminToastHost />
    </AdminMessagesProvider>
  );
};

const App = () => {
  // Initialize dynamic viewport handling for mobile browser URL bar
  useDynamicViewport();

  // Android back button → close overlays / navigate back (no-op on web)
  useEffect(() => {
    initNativeAppShell();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <ThemeProvider>
        <LanguageProvider>
          <TooltipProvider>
            <LoadingProvider>
                <AuthProvider>
                  <ApiClientProvider>
                    <FontSettingsProvider>
                    <FloatingWindowProvider>
                      <PDFViewerProvider>
                        <EpubViewerProvider>
                          <DocxViewerProvider>
                          <MarkdownViewerProvider>
                            <DeepResearchProvider>
                              <ModelsProvider>
                              <CartProvider>
                              <Router future={routerFutureFlags}>
                            <ScrollToTop />
                            <CanonicalUrl />
                            <DesktopAutoLogin />
                            <SidebarProvider>
                              <WorkspaceProvider>
                              <CollectionsProvider>
                              <TourProvider>
                              <OfflineModeBanner />
                              <ServiceUpdateBanner />
                              <ImpersonationBanner />
                              <SettingsPreloader />
                              <Routes>
                                <Route path='/home' element={<HomePage />} />
                                <Route
                                  path='/pricing'
                                  element={<PricingPage />}
                                />
                                <Route
                                  path='/buy-license'
                                  element={<BuyLicensePage />}
                                />
                                <Route path='/about' element={<AboutPage />} />
                                <Route path='/shop' element={<Shop />} />
                                <Route path='/desktop' element={<DesktopPage />} />
                                <Route path='/contact' element={<ContactPage />} />
                                <Route path='/privacy' element={<PrivacyPage />} />
                                <Route path='/delete-account' element={<DeleteAccountPage />} />
                                <Route path='/login' element={<LoginPage />} />
                                <Route path='/sign-up' element={<SignUpPage />} />
                                <Route path='/invite' element={<InvitePage />} />
                                <Route path='/shared/:shareToken' element={<SharedConversationPage />} />
                                <Route
                                  path='/dashboard'
                                  element={
                                    <ProtectedRoute>
                                      <Index />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path='/workspaces'
                                  element={
                                    <ProtectedRoute>
                                      <Index showWorkspaces={true} />
                                    </ProtectedRoute>
                                  }
                                />
                                {/* Native app (Capacitor) skips the marketing landing page entirely */}
                                <Route
                                  path='/'
                                  element={
                                    isNativeApp() ? (
                                      <Navigate to='/dashboard' replace />
                                    ) : (
                                      <HomePage />
                                    )
                                  }
                                />
                                <Route path='*' element={<NotFound />} />
                              </Routes>
                              <ProcessingOverlay />
                              <EdgeSnapOverlay />
                              <SafeGlobalPDFViewer />
                              <SafeGlobalEpubViewer />
                              <SafeGlobalDocxViewer />
                              <SafeGlobalMarkdownViewer />
                              {/* Only render NotesDrawer for authenticated users */}
                              <AuthenticatedComponents />
                              <GlobalLoadingSpinner />
                              <TourOverlay />
                              {/* <PerformanceMonitorWidget /> */}
                              </TourProvider>
                              </CollectionsProvider>
                            </WorkspaceProvider>
                          </SidebarProvider>
                              </Router>
                            </CartProvider>
                          </ModelsProvider>
                            </DeepResearchProvider>
                          </MarkdownViewerProvider>
                          </DocxViewerProvider>
                        </EpubViewerProvider>
                      </PDFViewerProvider>
                    </FloatingWindowProvider>
                    </FontSettingsProvider>
                  </ApiClientProvider>
                </AuthProvider>
            </LoadingProvider>
          </TooltipProvider>
        </LanguageProvider>
      </ThemeProvider>
      </ErrorBoundary>
    </QueryClientProvider>
  );
};

export default App;
