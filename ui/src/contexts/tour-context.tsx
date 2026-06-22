import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useIsMobile } from '@/hooks/use-mobile';
import { listSessions } from '@/lib/api-sessions';
import { updateTourCompleted } from '@/lib/api-users';

export interface TourStep {
  id: string;
  title: string;
  description: string;
  target: string; // CSS selector for element to highlight
  placement: 'top' | 'bottom' | 'left' | 'right';
  spotlightPadding?: number; // Padding around highlighted element
  offset?: { x: number; y: number }; // Tooltip offset from target
  onEnter?: () => void; // Callback when entering this step
  onExit?: () => void; // Callback when leaving this step
  /**
   * If `'always'`, the start-of-tour DOM filter keeps this step even
   * when its target selector matches nothing yet. Use when an earlier
   * step's `onEnter` opens the parent surface (e.g. the Settings
   * dialog) so the target only renders mid-tour.
   */
  availableWhen?: 'always';
}

interface TourContextValue {
  isActive: boolean;
  currentStep: number;
  steps: TourStep[];
  startTour: () => void;
  endTour: () => void;
  nextStep: () => void;
  previousStep: () => void;
  skipTour: () => void;
  goToStep: (step: number) => void;
  completeTour: () => void;
}

const TourContext = createContext<TourContextValue | undefined>(undefined);

const TOUR_STORAGE_KEY = 'scrapalot_tour_completed';

// Helper: open a tour element's popover/dropdown after a delay
const openTourElement = (selector: string) => {
  setTimeout(() => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (el && el.getAttribute('data-state') !== 'open') {
      el.click();
    }
  }, 150);
};

// Helper: close a tour element's popover/dropdown
const closeTourElement = (selector: string) => {
  requestAnimationFrame(() => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (el?.getAttribute('data-state') === 'open') {
      el.click();
    }
  });
};

// Desktop tour: full steps with popover interactions
const DESKTOP_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Scrapalot!',
    description: 'Your AI-powered research assistant with deep research, RAG technology, knowledge graphs, and collaborative notes. Let\'s walk through the key features!',
    target: 'body',
    placement: 'bottom',
    spotlightPadding: 0,
  },
  {
    id: 'start-conversation',
    title: 'Start a Conversation',
    description: 'Click here to open a new chat. Each conversation has its own message history, model selection, attached collections, and notes — like a research thread you can return to.',
    target: '[data-tour="start-conversation"]',
    placement: 'top',
    spotlightPadding: 12,
  },
  {
    id: 'chat-input',
    title: 'Chat Interface',
    description: 'Type your questions here. Use Shift+Enter for new lines, Enter to send. Attach files with the paperclip icon. AI responses appear above with citations and source references.',
    target: '[data-tour="chat-input"]',
    placement: 'top',
    spotlightPadding: 16,
  },
  {
    id: 'model-selector',
    title: 'AI Model Selector',
    description: 'Choose your AI model here. "Scrapalot AI" is the default system model. You can add providers like OpenAI, Anthropic, Google Gemini, Ollama, and more in Settings.',
    target: '[data-tour="model-selector"]',
    placement: 'bottom',
    spotlightPadding: 8,
  },
  {
    id: 'knowledge-stacks',
    title: 'Knowledge Stacks',
    description: 'Click here to manage your document collections for RAG. Choose retrieval strategies (17 available), configure parameters, select collections, or enable Agentic Routing to let AI pick the best strategy automatically.',
    target: '[data-tour="knowledge-stacks"]',
    placement: 'bottom',
    spotlightPadding: 8,
    onEnter: () => openTourElement('[data-tour="knowledge-stacks"]'),
    onExit: () => closeTourElement('[data-tour="knowledge-stacks"]'),
  },
  {
    id: 'search-options',
    title: 'Search & Deep Research',
    description: 'Toggle between Simple Search (quick web lookup) and Deep Research (comprehensive multi-source analysis with 5-phase pipeline: planning, decomposition, coordination, search, and synthesis with citations).',
    target: '[data-tour="search-options"]',
    placement: 'bottom',
    spotlightPadding: 8,
    onEnter: () => openTourElement('[data-tour="search-options"]'),
    onExit: () => closeTourElement('[data-tour="search-options"]'),
  },
  {
    id: 'sidebar-providers',
    title: 'AI Providers',
    description: 'Plug in your own keys for OpenAI, Anthropic, Google, Groq, OpenRouter, and Ollama. Use Scrapalot AI by default, or bring your own model and pay your provider directly.',
    target: '[data-tour="providers"]',
    placement: 'right',
    spotlightPadding: 12,
  },
  {
    id: 'sidebar-knowledge',
    title: 'Knowledge Library',
    description: 'Upload PDFs, EPUB, DOCX, and more. Create collections to organize your documents. The system extracts text, generates embeddings, and builds a knowledge graph with entities and relationships.',
    target: '[data-tour="knowledge-upload"]',
    placement: 'right',
    spotlightPadding: 12,
  },
  {
    id: 'sidebar-prompts',
    title: 'Prompt Templates',
    description: 'Save reusable system prompts for different research modes — literature review, peer-review critique, summarization, fact-check. Pick one in the chat toolbar to swap the assistant\'s persona without retyping.',
    target: '[data-tour="prompts"]',
    placement: 'right',
    spotlightPadding: 12,
  },
  {
    id: 'sidebar-theme',
    title: 'Theme & Accent',
    description: 'Toggle light / dark and pick an accent colour. Your choice persists across sessions and applies to highlights, links, and chart series.',
    target: '[data-tour="theme-toggle"]',
    placement: 'right',
    spotlightPadding: 12,
  },
  {
    id: 'sidebar-inspector',
    title: 'Data Inspector',
    description: 'Monitor your system: RAG strategy tracing, LLM cost analysis, knowledge graph explorer with entity visualization, document processing status, and graph sync management.',
    target: '[data-tour="admin-inspector"]',
    placement: 'right',
    spotlightPadding: 12,
  },
  {
    id: 'sidebar-settings',
    title: 'Settings',
    description: 'Configure everything: AI providers, document processing (OCR, chunking), prompt templates, workspace management, account, language, and theme. Click to open — we\'ll walk you through the key sections.',
    target: '[data-tour="settings-button"]',
    placement: 'right',
    spotlightPadding: 12,
    onEnter: () => openTourElement('[data-tour="settings-button"]'),
    // Don't close on exit — the next two steps live inside the
    // Settings dialog. The closing happens at the end of
    // `settings-appearance`.
  },
  {
    id: 'settings-language',
    title: 'Language',
    description: 'Pick the UI language. Scrapalot ships English, Croatian, and Macedonian; the choice persists across devices and applies to every screen, including AI replies that respect locale-specific phrasing.',
    target: '[data-tour="settings-language"]',
    placement: 'top',
    spotlightPadding: 8,
    // Settings dialog renders only after the previous step's onEnter
    // — keep this step regardless of current DOM presence.
    availableWhen: 'always',
  },
  {
    id: 'settings-appearance',
    title: 'Appearance',
    description: 'Light, dark, or follow the system. Below this section you can pick an accent color (gray / blue / green / red / violet / orange) that applies to highlights, links, and chart series across the app.',
    target: '[data-tour="settings-appearance"]',
    placement: 'top',
    spotlightPadding: 8,
    availableWhen: 'always',
    // Close the Settings dialog before the tour returns to the
    // dashboard for the Account / Command Palette / Complete steps —
    // otherwise the tour keeps the modal open and the spotlights
    // beneath read as overlays on top of stale settings content.
    onExit: () => {
      const closeBtn = document.querySelector(
        '[data-state="open"] button[aria-label="Close"]'
      ) as HTMLElement | null;
      closeBtn?.click();
    },
  },
  {
    id: 'sidebar-user',
    title: 'Your Account',
    description: 'View your subscription plan, storage usage, document quota, and token consumption. Access account settings or log out. Upload a profile picture by clicking your avatar.',
    target: '[data-tour="user-menu"]',
    placement: 'right',
    spotlightPadding: 12,
    onEnter: () => openTourElement('[data-tour="user-menu"]'),
    onExit: () => closeTourElement('[data-tour="user-menu"]'),
  },
  {
    id: 'command-palette',
    title: 'Command Palette',
    description: 'Press Ctrl+K (or Cmd+K on Mac) to jump to anything: a recent document, a workspace, a saved prompt, a setting. The palette is the fastest route through the app.',
    target: 'body',
    placement: 'bottom',
    spotlightPadding: 0,
  },
  {
    id: 'complete',
    title: 'You\'re All Set!',
    description: 'Start chatting to explore AI answers, upload documents for RAG-powered research, or try Deep Research for comprehensive analysis. After sending a message, you\'ll see the Notes button for collaborative note-taking. Restart this tour anytime from Settings.',
    target: 'body',
    placement: 'bottom',
    spotlightPadding: 0,
  },
];

// Mobile tour: fewer steps, no popover interactions (bottom sheet would cover them),
// skip model-selector (not visible without active conversation), shorter descriptions
const MOBILE_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Scrapalot!',
    description: 'Your AI-powered research assistant. Let\'s take a quick tour of the key features!',
    target: 'body',
    placement: 'bottom',
    spotlightPadding: 0,
  },
  {
    id: 'start-conversation',
    title: 'Start a Conversation',
    description: 'Tap to open a new chat. Each conversation has its own history, model, and notes.',
    target: '[data-tour="start-conversation"]',
    placement: 'top',
    spotlightPadding: 8,
  },
  {
    id: 'chat-input',
    title: 'Chat Interface',
    description: 'Type your questions here. Tap send to get AI-powered answers with citations and source references.',
    target: '[data-tour="chat-input"]',
    placement: 'top',
    spotlightPadding: 12,
  },
  {
    id: 'model-selector',
    title: 'AI Model',
    description: 'Tap to pick the model for this conversation. "Scrapalot AI" is the default; bring your own provider key in Settings to use OpenAI, Anthropic, Gemini, Groq, or Ollama.',
    target: '[data-tour="model-selector"]',
    placement: 'top',
    spotlightPadding: 8,
  },
  {
    id: 'knowledge-stacks',
    title: 'Knowledge Stacks',
    description: 'Manage document collections, choose retrieval strategies, and enable Agentic Routing for automatic strategy selection.',
    target: '[data-tour="knowledge-stacks"]',
    placement: 'top',
    spotlightPadding: 8,
  },
  {
    id: 'search-options',
    title: 'Search & Deep Research',
    description: 'Switch between Simple Search and Deep Research for comprehensive multi-source analysis with citations.',
    target: '[data-tour="search-options"]',
    placement: 'top',
    spotlightPadding: 8,
  },
  {
    id: 'sidebar-knowledge',
    title: 'Knowledge Library',
    description: 'Upload PDFs, EPUB, DOCX, and more. Create collections to organize your research documents.',
    target: '[data-tour="knowledge-upload"]',
    placement: 'right',
    spotlightPadding: 8,
  },
  {
    id: 'sidebar-settings',
    title: 'Settings',
    description: 'Configure AI providers, document processing, prompt templates, workspace, and account settings.',
    target: '[data-tour="settings-button"]',
    placement: 'right',
    spotlightPadding: 8,
  },
  {
    id: 'sidebar-user',
    title: 'Your Account',
    description: 'View your subscription, storage usage, and token consumption. Access account settings or log out.',
    target: '[data-tour="user-menu"]',
    placement: 'right',
    spotlightPadding: 8,
  },
  {
    id: 'complete',
    title: 'You\'re All Set!',
    description: 'Start chatting, upload documents for RAG research, or try Deep Research. Restart this tour anytime from Settings.',
    target: 'body',
    placement: 'bottom',
    spotlightPadding: 0,
  },
];

export const TourProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isActive, setIsActive] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const isMobile = useIsMobile();
  const allSteps = useMemo(() => isMobile ? MOBILE_STEPS : DESKTOP_STEPS, [isMobile]);
  // The list of steps actually shown to the user. Pruned at tour
  // start so steps whose `target` selector matches nothing on the
  // current page (chat toolbar elements when no session is active,
  // admin-only sidebar buttons when impersonating a regular user)
  // don't render an empty centered tooltip with nothing to point
  // at — that's the "doesn't accurately match every screen"
  // complaint the impersonation flow surfaced.
  const [activeSteps, setActiveSteps] = useState<TourStep[]>(allSteps);
  const steps = isActive ? activeSteps : allSteps;
  const { user, isAuthenticated, refreshUser } = useAuth();

  const startTour = useCallback(() => {
    // Snapshot the DOM right now and filter out steps whose target
    // is not present. `body` always exists; everything else is
    // probed once. We don't re-filter mid-tour because navigation
    // between steps would jump indexes if elements appeared /
    // disappeared in response to user clicks elsewhere.
    const filtered = allSteps.filter(s => {
      if (s.target === 'body') return true;
      // `availableWhen: 'always'` keeps steps that depend on a parent
      // surface opened by a previous step's onEnter (e.g. the
      // Settings dialog children).
      if (s.availableWhen === 'always') return true;
      const el = document.querySelector(s.target);
      if (!el) return false;
      // The DOM-presence check is not enough on its own. Mobile /
      // narrow-viewport layouts keep the sidebar mounted but
      // collapsed via `transform: translateX(-100%)`, so every
      // sidebar-anchored step would survive the filter and the
      // tour would spotlight a 0×0 rect at (0, 0). Drop anything
      // that has no visible footprint.
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    // Defensive fallback: if literally nothing matches (broken DOM,
    // login screen during a redirect race) keep the welcome + complete
    // pair so the tour can still finish gracefully.
    const final = filtered.length > 0
      ? filtered
      : allSteps.filter(s => s.target === 'body');
    setActiveSteps(final);
    setIsActive(true);
    setCurrentStep(0);

    // Call onEnter for first step after a brief delay
    setTimeout(() => {
      if (final[0]?.onEnter) {
        final[0].onEnter();
      }
    }, 1100); // Wait for initial 1s delay + 100ms
  }, [allSteps]);

  // Manage body class for CSS z-index targeting of Radix popovers
  useEffect(() => {
    if (isActive) {
      document.body.classList.add('tour-active');
    } else {
      document.body.classList.remove('tour-active');
    }
    return () => document.body.classList.remove('tour-active');
  }, [isActive]);

  // Check if tour has been completed
  useEffect(() => {
    // Priority 1: Check backend flag from user object
    const backendTourCompleted = user?.tour_completed;

    // Priority 2: Check localStorage as fallback
    const localStorageTourCompleted = localStorage.getItem(TOUR_STORAGE_KEY);

    // Tour is completed if backend flag OR localStorage says so
    const tourCompleted = backendTourCompleted || localStorageTourCompleted;

    // Only auto-start tour for authenticated users who haven't completed it
    // and have already accepted the license agreement
    if (!tourCompleted && isAuthenticated && user && user.license_agreement_consent !== false) {
      let timer: NodeJS.Timeout | null = null;

      // If the account was created more than 24h ago, skip tour (existing user, not new)
      const accountAge = user.created_at
        ? Date.now() - new Date(user.created_at).getTime()
        : 0;
      const isExistingUser = accountAge > 24 * 60 * 60 * 1000;

      if (isExistingUser) {
        console.log('⏭️ Account older than 24h, skipping tour');
        localStorage.setItem(TOUR_STORAGE_KEY, 'skipped_existing_user');
        updateTourCompleted(true)
          .then(() => refreshUser())
          .then(() => console.log('Tour auto-skipped and synced with backend'))
          .catch((err) => console.warn('Failed to sync tour completion:', err));
        return;
      }

      // Check if user has existing chat sessions before starting tour
      const checkExistingSessions = async () => {
        try {
          const paginatedResult = await listSessions();
          const sessions = paginatedResult?.sessions || [];

          // If user has existing sessions, they've used the app before - don't show tour
          if (sessions.length > 0) {
            console.log('⏭️ User has existing sessions, skipping tour');
            localStorage.setItem(TOUR_STORAGE_KEY, 'skipped_has_sessions');
            // Update backend and refresh user object
            try {
              await updateTourCompleted(true);
              await refreshUser();
              console.log('Tour auto-skipped and synced with backend');
            } catch (err) {
              console.warn('Failed to sync tour completion:', err);
            }
            return;
          }

          // New user with no sessions - auto-start tour after a short delay
          timer = setTimeout(() => {
            startTour();
          }, 1000);
        } catch (error) {
          console.error('Failed to check sessions for tour:', error);
          // On error, don't start tour to be safe
        }
      };

      void checkExistingSessions();

      // Cleanup function
      return () => {
        if (timer) {
          clearTimeout(timer);
        }
      };
    }
  }, [isAuthenticated, user, startTour, refreshUser]);

  // Keyboard navigation
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        void skipTour();
      } else if (e.key === 'ArrowRight') {
        nextStep();
      } else if (e.key === 'ArrowLeft') {
        previousStep();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isActive, currentStep]);

  const endTour = useCallback(() => {
    // Call onExit for current step before ending
    if (steps[currentStep]?.onExit) {
      steps[currentStep].onExit();
    }

    setIsActive(false);
    setCurrentStep(0);
  }, [currentStep, steps]);

  const nextStep = useCallback(() => {
    // Call onExit for current step
    if (steps[currentStep]?.onExit) {
      steps[currentStep].onExit();
    }

    if (currentStep < steps.length - 1) {
      const nextStepIndex = currentStep + 1;
      setCurrentStep(nextStepIndex);

      // Call onEnter for next step after a brief delay
      setTimeout(() => {
        if (steps[nextStepIndex]?.onEnter) {
          steps[nextStepIndex]?.onEnter();
        }
      }, 100);
    } else {
      void completeTour();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [currentStep, steps]);

  const previousStep = useCallback(() => {
    // Call onExit for current step
    if (steps[currentStep]?.onExit) {
      steps[currentStep].onExit();
    }

    if (currentStep > 0) {
      const prevStepIndex = currentStep - 1;
      setCurrentStep(prevStepIndex);

      // Call onEnter for previous step after a brief delay
      setTimeout(() => {
        if (steps[prevStepIndex]?.onEnter) {
          steps[prevStepIndex]?.onEnter();
        }
      }, 100);
    }
  }, [currentStep, steps]);

  const skipTour = useCallback(async () => {
    // Update localStorage as backup
    localStorage.setItem(TOUR_STORAGE_KEY, 'skipped');

    // Update backend flag and refresh user object to get updated tour_completed value
    try {
      await updateTourCompleted(true);
      // Refresh user object to ensure tour_completed is updated in frontend state
      await refreshUser();
      console.log('Tour completion status synced with backend');
    } catch (err) {
      console.warn('Failed to update backend tour completion status:', err);
    }

    endTour();
  }, [endTour, refreshUser]);

  const goToStep = useCallback((step: number) => {
    if (step >= 0 && step < steps.length) {
      setCurrentStep(step);
    }
  }, [steps.length]);

  const completeTour = useCallback(async () => {
    // Update localStorage as backup
    localStorage.setItem(TOUR_STORAGE_KEY, 'completed');

    // Update backend flag and refresh user object to get updated tour_completed value
    try {
      await updateTourCompleted(true);
      // Refresh user object to ensure tour_completed is updated in frontend state
      await refreshUser();
      console.log('Tour completion status synced with backend');
    } catch (err) {
      console.warn('Failed to update backend tour completion status:', err);
    }

    endTour();
  }, [endTour, refreshUser]);

  const value: TourContextValue = {
    isActive,
    currentStep,
    steps,
    startTour,
    endTour,
    nextStep,
    previousStep,
    skipTour,
    goToStep,
    completeTour,
  };

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export const useTour = () => {
  const context = useContext(TourContext);
  if (context === undefined) {
    throw new Error('useTour must be used within a TourProvider');
  }
  return context;
};
