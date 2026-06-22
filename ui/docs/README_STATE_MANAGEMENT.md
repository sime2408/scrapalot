# State Management

**Last Updated**: March 2026

React Context-based state management with 15 providers, event-driven coordination, and localStorage persistence.

## Overview

```
App.tsx
  └─ Provider Nesting (15 contexts)
       └─ Routes & Components
            └─ useContext() hooks
```

## Provider Nesting Order

```
QueryClientProvider (configured but NOT used)
  ErrorBoundary
    ThemeProvider
      LanguageProvider (i18n)
        TooltipProvider
          LoadingProvider ─────────────────────┐
            AuthProvider ────────────────────┐ │
              ApiClientProvider ────────────┼─┤
                FontSettingsProvider ──────┼─┤
                  PDFViewerProvider ───────┼─┤
                    EpubViewerProvider ────┼─┤
                      DocxViewerProvider ──┼─┤
                        MarkdownViewerProvider ┤
                          DeepResearchProvider │
                          ModelsProvider ────┤
                          CartProvider ──────┤
                            Router
                              SidebarProvider
                                WorkspaceProvider ─────┐
                                  CollectionsProvider ─┤
                                    TourProvider ──────┤
                                      Routes
```

## 15 Context Providers

### 1. AuthProvider

**File**: `src/contexts/auth-context.tsx` (1,274 lines)

| Export | Type | Purpose |
|--------|------|---------|
| `user` | User \| null | Current user with profile data |
| `isAuthenticated` | boolean | Auth status (token validation) |
| `isOfflineMode` | boolean | Offline flag for local-only mode |
| `login()` | function | Email/password auth with remember me |
| `loginWithGoogle()` | function | OAuth callback for Google SSO |
| `logout()` | function | Clear tokens, reset state |
| `refreshToken()` | function | Silent token refresh |
| `isAuthReady` | boolean | Auth initialization complete |

**Special**: Uses `authState` object (not React context) for event-based auth signaling. Manages both `sessionStorage` (default) and `localStorage` (remember me) token persistence.

### 2. WorkspaceProvider

**File**: `src/contexts/workspace-context.tsx`

| Export | Type | Purpose |
|--------|------|---------|
| `currentWorkspace` | Workspace \| null | Active workspace |
| `isLoading` | boolean | Loading state |
| `selectWorkspace()` | function | Change workspace |

**Special**: Lazy loading - only fetches on `/dashboard`, `/workspaces` routes.

### 3. CollectionsProvider

**File**: `src/contexts/collections-context.tsx`

| Export | Type | Purpose |
|--------|------|---------|
| `collections` | DocumentCollection[] | Collection list |
| `loading` | boolean | Loading state |
| `hasMore` | boolean | Pagination flag |
| `refreshCollections()` | function | Reload from page 1 |
| `loadMoreCollections()` | function | Fetch next page |

**Special**: Workspace-dependent - waits for `currentWorkspace.id`.

### 4. ModelsProvider

**File**: `src/contexts/models-context.tsx`

| Export | Type | Purpose |
|--------|------|---------|
| `availableModels` | Model[] | All LLM models |
| `isLoading` | boolean | Loading state |
| `modelsLoaded` | boolean | Load complete flag |
| `refreshModels()` | function | Reload models |

**Special**: Delegates to `useProviders()` hook.

### 5. DeepResearchProvider

**File**: `src/contexts/deep-research-context.tsx` (1,170 lines, 37KB)

| Export | Type | Purpose |
|--------|------|---------|
| `researchSteps` | ResearchStep[] | Phase-by-phase data with timestamps |
| `processPacket()` | function | Handle 49 packet types from backend |
| `researchPlan` | ResearchPlan | Planning phase data (sections, methodology) |
| `planningProgress` | PlanningProgress | Progress tracking (0.0-1.0 range) |
| `taskDecomposition` | TaskDecomposition | Task breakdown and dependencies |
| `agentStatuses` | AgentStatus[] | Multi-agent coordination status |
| `searchProgresses` | SearchProgress[] | Search provider progress |
| `synthesisData` | SynthesisData | Synthesis and QA results |
| `isResearching` | boolean | Active research status |
| `clearResearch()` | function | Reset all research state |

**Special**: Packet-driven via STOMP subscription. Processes 49 distinct packet types across 5 research phases. Alternative to `useDeepResearchPanel` hook. See `README_DEEP_RESEARCH.md`.

### 6. PDFViewerProvider

**File**: `src/contexts/pdf-viewer-context.tsx`

| Export | Type | Purpose |
|--------|------|---------|
| `state` | PDFViewerState | Viewer state |
| `dispatch` | Dispatch | Reducer actions |

**Actions**: `OPEN_PDF_VIEWER`, `CLOSE_PDF_VIEWER`, `SET_PDF_POSITION`

### 7. EpubViewerProvider

**File**: `src/contexts/epub-viewer-context.tsx`

| Export | Type | Purpose |
|--------|------|---------|
| `state` | EpubViewerState | Reader state |
| `dispatch` | Dispatch | Reducer actions |

**Actions**: `OPEN_EPUB_VIEWER`, `CLOSE_EPUB_VIEWER`, `UPDATE_LOCATION`

### 8. DocxViewerProvider

**File**: `src/contexts/docx-viewer-context.tsx`

| Export | Type | Purpose |
|--------|------|---------|
| `state` | DocxViewerState | Viewer state |
| `dispatch` | Dispatch | Reducer actions |

### 9. LoadingProvider

**File**: `src/contexts/loading-context.tsx`

| Export | Type | Purpose |
|--------|------|---------|
| `isLoading` | boolean | General loading |
| `isProcessingDocuments` | boolean | Doc processing |
| `processingProgress` | number | 0-100 progress |
| `startDocumentProcessing()` | function | Begin tracking |
| `updateDocumentProcessing()` | function | Update progress |
| `finishDocumentProcessing()` | function | Complete |

### 10. FontSettingsProvider

**File**: `src/contexts/font-settings-context.tsx`

| Export | Type | Purpose |
|--------|------|---------|
| `fontSize` | number | Code editor size |
| `codeTheme` | string | Syntax theme |
| `setFontSize()` | function | Update & persist |
| `setCodeTheme()` | function | Update & persist |

### 11. SidebarProvider

**File**: `src/contexts/sidebar-context.tsx`

| Export | Type | Purpose |
|--------|------|---------|
| `isSidebarOpen` | boolean | Visibility |
| `sidebarWidth` | number | Width (300-500px) |
| `toggleSidebar()` | function | Toggle open/close |
| `setSidebarWidth()` | function | With constraints |

**Special**: Auto-closes on screens < 1200px width.

### 12. CartProvider

**File**: `src/contexts/cart-context.tsx`

| Export | Type | Purpose |
|--------|------|---------|
| `items` | CartItem[] | Cart contents |
| `totalItems` | number | Sum of quantities |
| `totalPrice` | number | Sum of prices |
| `addItem()` | function | Add or increment |
| `removeItem()` | function | Remove item |

### 13. TourProvider

**File**: `src/contexts/tour-context.tsx`

| Export | Type | Purpose |
|--------|------|---------|
| `isActive` | boolean | Tour running |
| `currentStep` | number | Current step |
| `steps` | TourStep[] | 5 default steps |
| `startTour()` | function | Begin at step 0 |
| `nextStep()` | function | Advance |
| `completeTour()` | function | End & sync backend |

**Special**: Auto-starts for new users without existing sessions.

### 14. ApiClientProvider

**File**: `src/contexts/api-client-context.tsx`

| Export | Type | Purpose |
|--------|------|---------|
| `apiClient` | AxiosInstance | Configured client |

**Special**: Syncs auth tokens to request headers.

### 15. MarkdownViewerProvider

**File**: `src/contexts/markdown-viewer-context.tsx`

| Export | Type | Purpose |
|--------|------|---------|
| `state` | MarkdownViewerState | Viewer state |
| `dispatch` | Dispatch | Reducer actions |

## Dependency Chain

```
AuthProvider (auth ready)
       ↓
WorkspaceProvider (loads workspace)
       ↓
CollectionsProvider (fetches collections)
```

## Event-Based Coordination

| Event | Emitter | Listeners |
|-------|---------|-----------|
| `auth-ready` | AuthProvider | WorkspaceProvider, SidebarProvider |
| `workspace-loaded` | AuthProvider | CollectionsProvider |
| `scrapalot:cache-cleared` | Various | WorkspaceProvider, CollectionsProvider |

```typescript
// Emitting
window.dispatchEvent(new CustomEvent('auth-ready'));

// Listening
window.addEventListener('auth-ready', handleAuthReady);
```

## localStorage Persistence

| Provider | Keys |
|----------|------|
| AuthProvider | `auth_tokens`, `offline_mode` |
| WorkspaceProvider | Via `uiState.setCurrentWorkspace()` |
| SidebarProvider | `sidebarOpen`, `sidebarWidth` |
| TourProvider | `scrapalot_tour_completed` |
| FontSettingsProvider | Via `userPrefs` helper |

## Storage Helpers

```typescript
import { userPrefs, uiState, modelSelections } from '@/lib/storage-utils';

// Type-safe localStorage access
userPrefs.get('theme');
uiState.setCurrentWorkspace(workspace);
modelSelections.get('selectedModel');
```

## Hook Usage

```typescript
// Auth
import { useAuth } from '@/contexts/auth-context';
const { user, isAuthenticated, login, logout } = useAuth();

// Workspace
import { useWorkspace } from '@/contexts/workspace-context';
const { currentWorkspace, selectWorkspace } = useWorkspace();

// Collections
import { useCollections } from '@/contexts/collections-context';
const { collections, refreshCollections } = useCollections();

// Deep Research
import { useDeepResearchPanel } from '@/hooks/use-deep-research-panel';
const { processPacket, researchSteps } = useDeepResearchPanel();
```

## HMR Resilience

Many hooks provide fallback values during hot module reload:

```typescript
export function useCollections() {
  const context = useContext(CollectionsContext);
  if (!context) {
    // HMR fallback - prevents crashes
    return {
      collections: [],
      loading: false,
      hasMore: false,
      // ... defaults
    };
  }
  return context;
}
```

## Optimistic Updates

CollectionsProvider supports instant UI feedback:

```typescript
// Update local state immediately
updateCollectionInState(id, { name: 'New Name' });

// API call happens in background
await updateCollection(id, { name: 'New Name' });
```

## Critical Patterns

### Lazy Workspace Loading

```typescript
// WorkspaceProvider only loads on protected routes
const isProtectedRoute = ['/dashboard', '/workspaces'].some(
  route => location.pathname.startsWith(route)
);
if (!isProtectedRoute) return;
```

### Auth-Ready Signaling

```typescript
// AuthProvider signals when ready
authState.setAuthReady(true);
window.dispatchEvent(new CustomEvent('auth-ready'));

// Other contexts wait
await authState.waitForAuthReady();
```

### Debounced Loading

```typescript
// WorkspaceProvider - 5 second minimum between fetches
const MIN_FETCH_INTERVAL = 5000;
if (Date.now() - lastFetch < MIN_FETCH_INTERVAL) return;
```

## Common Gotchas

1. **React Query NOT Used**: Configured but all API calls use direct axios
2. **Provider Order Matters**: Auth must be ready before Workspace, Workspace before Collections
3. **Lazy Loading**: WorkspaceProvider only fetches on protected routes
4. **HMR Fallbacks**: Always provide defaults in useContext hooks for dev mode

---

*See also: `README_COMPONENT_ARCHITECTURE.md` for component hierarchy*
