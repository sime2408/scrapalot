import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { ChevronRight } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { DocumentCollection } from '@/types';
import { buildCollectionTree, CollectionTreeNode } from '@/lib/collection-tree';
import { Slider } from '@/components/ui/slider.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useCollections } from '@/contexts/collections-context';
import { KnowledgeStacksDialog } from '@/components/knowledge/knowledge-stacks-dialog';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { getRagStrategies, saveGeneralSettings, getGeneralSettings, saveSelectedCollections } from '@/lib/api-settings';
import { BrainCircuit, Book, Sliders, X } from 'lucide-react';
import { useIsNarrowScreen } from '@/hooks/use-mobile';
import { useSimpleMode } from '@/hooks/use-simple-mode';
import { cn } from '@/lib/utils';

interface PopoverCollectionSelectorProps {
  selectedCollections: DocumentCollection[];
  onSelectCollections: (collections: DocumentCollection[], similarity?: number, numChunks?: number) => void;
  initialSimilarity?: number;
  initialNumChunks?: number;
  sessionId?: string; // Current session ID for saving collection selections
  // Mobile-only props
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  // Callback to switch to agentic routing mode
  onSwitchToAgentic?: () => void;
}

// Fallback Individual RAG Strategies
const fallbackIndividualStrategies = (t: (key: string) => string) => [
  {
    value: 'RAGSimilaritySearch',
    label: t('settings.ragStrategy.strategies.RAGSimilaritySearch.label'),
    description: t('settings.ragStrategy.strategies.RAGSimilaritySearch.description'),
  },
  {
    value: 'RAGSelfQuery',
    label: t('settings.ragStrategy.strategies.RAGSelfQuery.label'),
    description: t('settings.ragStrategy.strategies.RAGSelfQuery.description'),
  },
  {
    value: 'RAGHybridSelfQuery',
    label: t('settings.ragStrategy.strategies.RAGHybridSelfQuery.label'),
    description: t('settings.ragStrategy.strategies.RAGHybridSelfQuery.description'),
  },
  {
    value: 'RAGHyDE',
    label: t('settings.ragStrategy.strategies.RAGHyDE.label'),
    description: t('settings.ragStrategy.strategies.RAGHyDE.description'),
  },
  {
    value: 'RAGMultiQuery',
    label: t('settings.ragStrategy.strategies.RAGMultiQuery.label'),
    description: t('settings.ragStrategy.strategies.RAGMultiQuery.description'),
  },
  {
    value: 'RAGFusion',
    label: t('settings.ragStrategy.strategies.RAGFusion.label'),
    description: t('settings.ragStrategy.strategies.RAGFusion.description'),
  },
  {
    value: 'RAGParentDocument',
    label: t('settings.ragStrategy.strategies.RAGParentDocument.label'),
    description: t('settings.ragStrategy.strategies.RAGParentDocument.description'),
  },
  {
    value: 'RAGStepBack',
    label: t('settings.ragStrategy.strategies.RAGStepBack.label'),
    description: t('settings.ragStrategy.strategies.RAGStepBack.description'),
  },
  {
    value: 'RAGDecomposition',
    label: t('settings.ragStrategy.strategies.RAGDecomposition.label'),
    description: t('settings.ragStrategy.strategies.RAGDecomposition.description'),
  },
  {
    value: 'RAGGraphSearch',
    label: t('settings.ragStrategy.strategies.RAGGraphSearch.label'),
    description: t('settings.ragStrategy.strategies.RAGGraphSearch.description'),
  },
  {
    value: 'RAGGenerativeFeedbackLoop',
    label: t('settings.ragStrategy.strategies.RAGGenerativeFeedbackLoop.label'),
    description: t('settings.ragStrategy.strategies.RAGGenerativeFeedbackLoop.description'),
  },
  {
    value: 'RAGQueryChain',
    label: t('settings.ragStrategy.strategies.RAGQueryChain.label'),
    description: t('settings.ragStrategy.strategies.RAGQueryChain.description'),
  },
  {
    value: 'RAGRewriteRetrieveRead',
    label: t('settings.ragStrategy.strategies.RAGRewriteRetrieveRead.label'),
    description: t('settings.ragStrategy.strategies.RAGRewriteRetrieveRead.description'),
  },
  {
    value: 'RAGAgenticExpansion',
    label: t('settings.ragStrategy.strategies.RAGAgenticExpansion.label'),
    description: t('settings.ragStrategy.strategies.RAGAgenticExpansion.description'),
  },
];

// Fallback RAG Orchestrators
const fallbackOrchestrators = (t: (key: string) => string) => [
  {
    value: 'RAGAdaptiveOrchestrator',
    label: t('settings.ragStrategy.strategies.RAGAdaptiveOrchestrator.label'),
    description: t('settings.ragStrategy.strategies.RAGAdaptiveOrchestrator.description'),
  },
  {
    value: 'RAGPrecisionOrchestrator',
    label: t('settings.ragStrategy.strategies.RAGPrecisionOrchestrator.label'),
    description: t('settings.ragStrategy.strategies.RAGPrecisionOrchestrator.description'),
  },
  {
    value: 'RAGBalancedOrchestrator',
    label: t('settings.ragStrategy.strategies.RAGBalancedOrchestrator.label'),
    description: t('settings.ragStrategy.strategies.RAGBalancedOrchestrator.description'),
  },
  {
    value: 'RAGContextEnhancedOrchestrator',
    label: t('settings.ragStrategy.strategies.RAGContextEnhancedOrchestrator.label'),
    description: t('settings.ragStrategy.strategies.RAGContextEnhancedOrchestrator.description'),
  },
  {
    value: 'RAGKnowledgeIntensiveOrchestrator',
    label: t('settings.ragStrategy.strategies.RAGKnowledgeIntensiveOrchestrator.label'),
    description: t('settings.ragStrategy.strategies.RAGKnowledgeIntensiveOrchestrator.description'),
  },
  {
    value: 'RAGDocumentHierarchyOrchestrator',
    label: t('settings.ragStrategy.strategies.RAGDocumentHierarchyOrchestrator.label'),
    description: t('settings.ragStrategy.strategies.RAGDocumentHierarchyOrchestrator.description'),
  },
  {
    value: 'RAGQueryRefinementOrchestrator',
    label: t('settings.ragStrategy.strategies.RAGQueryRefinementOrchestrator.label'),
    description: t('settings.ragStrategy.strategies.RAGQueryRefinementOrchestrator.description'),
  },
  {
    value: 'RAGFeedbackLoopOrchestrator',
    label: t('settings.ragStrategy.strategies.RAGFeedbackLoopOrchestrator.label'),
    description: t('settings.ragStrategy.strategies.RAGFeedbackLoopOrchestrator.description'),
  },
  {
    value: 'EnhancedTriModalOrchestrator',
    label: t('settings.ragStrategy.strategies.EnhancedTriModalOrchestrator.label'),
    description: t('settings.ragStrategy.strategies.EnhancedTriModalOrchestrator.description'),
  },
];

/** Tree-structured collection list with expand/collapse and indentation. */
function CollectionTreeList({
  collections,
  selected,
  onToggle,
}: {
  collections: DocumentCollection[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const tree = useMemo(() => buildCollectionTree(collections), [collections]);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Auto-expand parents of selected collections
    const parentIds = new Set<string>();
    for (const col of collections) {
      if (selected.includes(col.id)) {
        const pid = col.parentCollectionId || col.parent_collection_id;
        if (pid) parentIds.add(pid);
      }
    }
    return parentIds;
  });

  const toggleExpand = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const renderNode = (node: CollectionTreeNode, depth: number) => {
    const isSelected = selected.includes(node.id);
    const hasChildren = node.children.length > 0;
    const isExpanded = expanded.has(node.id);

    return (
      <div key={node.id}>
        <div
          data-testid={`chat-collection-item-${node.id}`}
          className={`group flex items-center gap-2 p-2 transition-all duration-200 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 ${
            isSelected ? 'bg-primary/5 border-l-2 border-l-primary' : ''
          }`}
          style={{ paddingLeft: `${8 + depth * 20}px` }}
        >
          {hasChildren ? (
            <button
              onClick={(e) => { e.preventDefault(); toggleExpand(node.id); }}
              className="p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-sm transition-transform"
            >
              <ChevronRight className={`h-3 w-3 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            </button>
          ) : (
            <span className="w-4" />
          )}
          <Checkbox
            data-testid={`chat-collection-checkbox-${node.id}`}
            id={`collection-${node.id}`}
            checked={isSelected}
            onCheckedChange={() => onToggle(node.id)}
          />
          <label
            htmlFor={`collection-${node.id}`}
            className="flex-1 min-w-0 text-sm cursor-pointer truncate text-zinc-900 dark:text-zinc-100 group-hover:text-primary"
          >
            {node.name}
          </label>
          {node.documentCount !== undefined && node.documentCount > 0 && (
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {node.documentCount}
            </span>
          )}
        </div>
        {hasChildren && isExpanded && node.children.map(child => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="p-1">
      {tree.map(node => renderNode(node, 0))}
    </div>
  );
}

export const PopoverCollectionSelector = ({
  selectedCollections,
  onSelectCollections,
  initialSimilarity = 0.5,
  initialNumChunks = 15,
  sessionId,
  // Mobile-only props
  open,
  onOpenChange,
  onSwitchToAgentic,
}: PopoverCollectionSelectorProps) => {
  const { t } = useTranslation();
  const isNarrowScreen = useIsNarrowScreen();
  const simpleMode = useSimpleMode();
  // Use preloaded collections from context
  const { collections: availableCollections, loading, error, refreshCollections } = useCollections();
  const [selected, setSelected] = useState<string[]>([]);
  const [similarity, setSimilarity] = useState<number>(initialSimilarity); // Similarity threshold (0.0-1.0)
  const [numChunks, setNumChunks] = useState<number>(initialNumChunks); // Number of chunks to retrieve
  const [isKnowledgeStacksOpen, setIsKnowledgeStacksOpen] = useState(false);
  // Ref to track KnowledgeStacksDialog open state synchronously (avoids race condition)
  const isKnowledgeStacksOpenRef = useRef<boolean>(false);
  const [activeTab, setActiveTab] = useState<string>('collections');

  // Clamp the active tab to 'collections' whenever simple mode is on —
  // the Strategy and Parameters triggers are hidden, so leaving the tab
  // on a hidden value would make the popover appear empty.
  useEffect(() => {
    if (simpleMode && activeTab !== 'collections') setActiveTab('collections');
  }, [simpleMode, activeTab]);

  // RAG Strategy state
  const [ragStrategy, setRagStrategy] = useState<string>('RAGSimilaritySearch');
  const [ragOrchestrator, setRagOrchestrator] = useState<string>('EnhancedTriModalOrchestrator');
  const [useOrchestrator, setUseOrchestrator] = useState<boolean>(true);
  // Knowledge augmentation: how to combine RAG citations with the LLM's
  // general knowledge. "strict" = only cited content; "augmented" = always
  // append a labeled wider-context paragraph; "auto" = append only when
  // retrieval is judged insufficient by the LLM. Default keeps current
  // behavior (strict).
  const [ragAugmentation, setRagAugmentation] = useState<'strict' | 'augmented' | 'auto'>('strict');
  const [isSettingsLoaded, setIsSettingsLoaded] = useState<boolean>(false);

  // Track if user has made changes (to prevent saving on initial load)
  const hasUserInteracted = useRef<boolean>(false);

  // Track if component has been initialized (to prevent resetting user changes)
  const hasInitialized = useRef<boolean>(false);

  // Debounce timer for auto-save
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  // Create translated fallback strategies - recalculate when the language changes
  const translatedIndividualStrategies = useMemo(() => {
    return fallbackIndividualStrategies(t);
  }, [t]);

  const translatedOrchestrators = useMemo(() => {
    return fallbackOrchestrators(t);
  }, [t]);

  // State for RAG strategies from API
  const [individualStrategies, setIndividualStrategies] = useState(translatedIndividualStrategies);
  const [orchestrators, setOrchestrators] = useState(translatedOrchestrators);

  // Initialize selected collections and parameters from props ONLY on first mount
  useEffect(() => {
    if (!hasInitialized.current) {
      setSelected(selectedCollections.map(col => col.id));
      setSimilarity(initialSimilarity);
      setNumChunks(initialNumChunks);
      hasInitialized.current = true;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  // Load RAG strategy settings from user settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const generalSettings = await getGeneralSettings();
        if (generalSettings) {
          setRagStrategy(generalSettings.rag_strategy || 'RAGSimilaritySearch');
          setRagOrchestrator(generalSettings.rag_orchestrator || 'EnhancedTriModalOrchestrator');
          setUseOrchestrator(generalSettings.use_orchestrator ?? true);
          const aug = generalSettings.rag_augmentation;
          if (aug === 'augmented' || aug === 'auto') setRagAugmentation(aug);
          else setRagAugmentation('strict');
        }
        // Mark settings as loaded after successful load
        setIsSettingsLoaded(true);
      } catch (error) {
        console.error('Failed to load RAG settings:', error);
        // Still mark as loaded to allow user changes
        setIsSettingsLoaded(true);
      }
    };
    void loadSettings();
  }, []);

  // Fetch RAG strategies from API
  useEffect(() => {
    const fetchStrategies = async () => {
      try {
        const strategies = await getRagStrategies();
        if (strategies && strategies.length > 0) {
          const individuals = strategies.filter(s => !s.value.includes('Orchestrator'));
          const orchs = strategies.filter(s => s.value.includes('Orchestrator'));
          if (individuals.length > 0) setIndividualStrategies(individuals);
          if (orchs.length > 0) setOrchestrators(orchs);
        } else {
          setIndividualStrategies(translatedIndividualStrategies);
          setOrchestrators(translatedOrchestrators);
        }
      } catch (error) {
        console.error('Failed to fetch RAG strategies:', error);
        setIndividualStrategies(translatedIndividualStrategies);
        setOrchestrators(translatedOrchestrators);
      }
    };
    void fetchStrategies();
  }, [translatedIndividualStrategies, translatedOrchestrators]);

  // Auto-save RAG settings when they change
  const saveRagSettings = async (settings: {
    use_agentic_routing?: boolean;
    rag_strategy?: string;
    rag_orchestrator?: string;
    use_orchestrator?: boolean;
    rag_augmentation?: 'strict' | 'augmented' | 'auto';
  }) => {
    try {
      await saveGeneralSettings(settings);
      console.log('RAG settings saved successfully:', settings);
    } catch (error) {
      console.error('❌ Failed to save RAG settings:', error);
    }
  };

  // Save when strategy changes (only after user interaction)
  useEffect(() => {
    if (isSettingsLoaded && hasUserInteracted.current && ragStrategy) {
      void saveRagSettings({ rag_strategy: ragStrategy });
    }
  }, [ragStrategy, isSettingsLoaded]);

  // Save when orchestrator changes (only after user interaction)
  useEffect(() => {
    if (isSettingsLoaded && hasUserInteracted.current && ragOrchestrator) {
      void saveRagSettings({ rag_orchestrator: ragOrchestrator });
    }
  }, [ragOrchestrator, isSettingsLoaded]);

  // Save when augmentation mode changes (only after user interaction)
  useEffect(() => {
    if (isSettingsLoaded && hasUserInteracted.current) {
      void saveRagSettings({ rag_augmentation: ragAugmentation });
    }
  }, [ragAugmentation, isSettingsLoaded]);

  // Save when orchestrator toggle changes (only after user interaction)
  useEffect(() => {
    if (isSettingsLoaded && hasUserInteracted.current) {
      void saveRagSettings({ use_orchestrator: useOrchestrator });
    }
  }, [useOrchestrator, isSettingsLoaded]);

  // Wrapper functions to track user interaction and update state
  const handleSetRagStrategy = (value: string) => {
    hasUserInteracted.current = true;
    setRagStrategy(value);
  };

  const handleSetRagOrchestrator = (value: string) => {
    hasUserInteracted.current = true;
    setRagOrchestrator(value);
  };

  const handleSetUseOrchestrator = (value: boolean) => {
    hasUserInteracted.current = true;
    setUseOrchestrator(value);
  };

  // Debounced apply function for auto-save
  const debouncedApplySelections = useCallback((newSelected: string[] = selected, newSimilarity: number = similarity, newNumChunks: number = numChunks) => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    
    debounceTimer.current = setTimeout(() => {
      void applySelections(newSelected, newSimilarity, newNumChunks);
    }, 500);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [selected, similarity, numChunks]);

  const handleToggleCollection = (collectionId: string) => {
    setSelected(prev => {
      // Create the new selection state
      const newSelected = prev.includes(collectionId)
        ? prev.filter(id => id !== collectionId)
        : [...prev, collectionId];

      // Auto-save with debounce
      debouncedApplySelections(newSelected, similarity, numChunks);

      return newSelected;
    });
  };

  const applySelections = async (newSelected: string[] = selected, newSimilarity: number = similarity, newNumChunks: number = numChunks) => {
    // Only apply if we have available collections to select from
    if (availableCollections.length === 0) return;

    const selectedCollectionObjects = availableCollections.filter(col =>
      newSelected.includes(col.id)
    );

    // Only update and show notification if the selection has changed
    const currentIds = selectedCollections
      .map(c => c.id)
      .sort()
      .join(',');
    const newIds = selectedCollectionObjects
      .map(c => c.id)
      .sort()
      .join(',');

    if (currentIds !== newIds || newSimilarity !== similarity || newNumChunks !== numChunks) {
      // Apply the selection with similarity and numChunks parameters
      onSelectCollections(selectedCollectionObjects, newSimilarity, newNumChunks);

      // Save selected collections to user_settings when in manual mode and session exists
      if (sessionId && newSelected.length > 0) {
        try {
          await saveSelectedCollections(sessionId, newSelected, newSimilarity, newNumChunks);
          console.log('Selected collections saved for session:', sessionId);
        } catch (error) {
          console.error('❌ Failed to save selected collections:', error);
        }
      }

      // Toast removed - selection is already visible in the UI
    }
  };

  const getSimilarityLabel = (value: number): string => {
    if (value < 0.33) return t('popovers.collectionSelector.similarityLow');
    if (value < 0.66) return t('popovers.collectionSelector.similarityMedium');
    return t('popovers.collectionSelector.similarityHigh');
  };

  // Handle opening Knowledge Stacks dialog
  const handleOpenKnowledgeStacks = useCallback(() => {
    // Set ref synchronously to prevent race condition with Dialog's onOpenChange
    isKnowledgeStacksOpenRef.current = true;
    setIsKnowledgeStacksOpen(true);
  }, []);

  // Handle Knowledge Stacks dialog open/close
  const handleKnowledgeStacksOpenChange = useCallback((open: boolean) => {
    // Set ref synchronously
    isKnowledgeStacksOpenRef.current = open;
    setIsKnowledgeStacksOpen(open);

    // Refresh collections when dialog closes
    if (!open) {
      void refreshCollections();
    }
  }, [refreshCollections]);

  // Handle when a collection is created/updated in KnowledgeStacksDialog
  const handleCollectionChange = useCallback((newCollectionId?: string) => {
    // Refresh collections immediately when a collection is created/updated
    void refreshCollections();

    // Auto-select the newly created collection
    if (newCollectionId) {
      setSelected(prev => {
        // Only add if not already selected
        if (prev.includes(newCollectionId)) {
          return prev;
        }
        const newSelected = [...prev, newCollectionId];
        // Apply selections with debounce to save to backend
        debouncedApplySelections(newSelected, similarity, numChunks);
        return newSelected;
      });
    }
  }, [refreshCollections, debouncedApplySelections, similarity, numChunks]);

  // Collections section component (reusable)
  const collectionsSection = (
    <div>
      {loading ? (
        <div className='py-4 flex justify-center'>
          <div className='animate-pulse text-sm'>
            {t('popovers.collectionSelector.loading')}
          </div>
        </div>
      ) : error ? (
        <div className='py-2 text-center text-red-500 text-sm'>{error}</div>
      ) : (
        <>
          <div className='flex items-center justify-between mb-3'>
            <h3 className='text-sm font-semibold text-zinc-900 dark:text-zinc-100'>
              Knowledge Collections
            </h3>
            {availableCollections.filter(c => c.documentCount === undefined || c.documentCount > 0).length > 0 && (
              <span className='text-xs text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-1 rounded-full'>
                {availableCollections.filter(c => c.documentCount === undefined || c.documentCount > 0).length} available
              </span>
            )}
          </div>

          <div className={`${isNarrowScreen ? '' : 'max-h-[280px]'} overflow-y-auto border border-zinc-200 dark:border-zinc-800 rounded-md bg-card dark:bg-zinc-950`}>
            {!availableCollections || availableCollections.filter(c => c.documentCount === undefined || c.documentCount > 0).length === 0 ? (
              <div className='py-8 text-center text-zinc-500 dark:text-zinc-400'>
                <div className='mb-2 opacity-50 text-2xl'>📚</div>
                <p className='text-sm'>{t('popovers.collectionSelector.noStacksAvailable')}</p>
              </div>
            ) : (
              <CollectionTreeList
                collections={availableCollections.filter(c => c.documentCount === undefined || c.documentCount > 0)}
                selected={selected}
                onToggle={handleToggleCollection}
              />
            )}
          </div>
        </>
      )}
    </div>
  );

  // Strategy section component (reusable)
  const strategySection = (
    <div className='bg-zinc-50 dark:bg-zinc-900/50 rounded-md p-4 border border-zinc-200 dark:border-zinc-800 space-y-4'>
      {/* Strategy Type Selector */}
      <div className='space-y-3'>
        <Label className='text-sm font-medium text-zinc-700 dark:text-zinc-300'>
          Strategy Type
        </Label>
        <div className='flex bg-card dark:bg-zinc-800 rounded-md p-1 border border-zinc-200 dark:border-zinc-700 shadow-sm'>
          <button
            type='button'
            onClick={() => handleSetUseOrchestrator(true)}
            className={`flex-1 px-3 py-2.5 text-sm font-medium rounded-sm transition-all duration-200 ${
              useOrchestrator
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700/50'
            }`}
          >
            <span className='block font-semibold'>Orchestrator</span>
            <span className='block text-xs opacity-80 mt-1'>Intelligent routing</span>
          </button>
          <button
            type='button'
            onClick={() => handleSetUseOrchestrator(false)}
            className={`flex-1 px-3 py-2.5 text-sm font-medium rounded-sm transition-all duration-200 ${
              !useOrchestrator
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700/50'
            }`}
          >
            <span className='block font-semibold'>Individual</span>
            <span className='block text-xs opacity-80 mt-1'>Single strategy</span>
          </button>
        </div>
      </div>

      {/* Orchestrator Dropdown */}
      {useOrchestrator && (
        <div className='space-y-2'>
          <Label className='text-sm font-semibold text-zinc-700 dark:text-zinc-300'>
            {t('settings.ragStrategy.orchestratorLabel')}
          </Label>
          <Select
            value={ragOrchestrator}
            defaultValue='EnhancedTriModalOrchestrator'
            onValueChange={handleSetRagOrchestrator}
          >
            <SelectTrigger data-testid="chat-rag-orchestrator-select" className='w-full h-10 text-sm border-zinc-300 dark:border-zinc-700 bg-card dark:bg-zinc-800'>
              <SelectValue>
                {orchestrators.find(s => s.value === ragOrchestrator)?.label || t('settings.ragStrategy.selectOrchestrator')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className='z-[100]'>
              {orchestrators.map(strategy => (
                <SelectItem key={strategy.value} value={strategy.value} className='text-sm'>
                  {strategy.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {ragOrchestrator && (
            <div className='bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800/50 rounded-md p-2.5'>
              <p className='text-xs text-blue-800 dark:text-blue-200 leading-relaxed'>
                {orchestrators.find(s => s.value === ragOrchestrator)?.description}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Individual Strategy Dropdown */}
      {!useOrchestrator && (
        <div className='space-y-2'>
          <Label className='text-sm font-semibold text-zinc-700 dark:text-zinc-300'>
            {t('settings.ragStrategy.strategyLabel')}
          </Label>
          <Select
            value={ragStrategy}
            defaultValue='RAGSimilaritySearch'
            onValueChange={handleSetRagStrategy}
          >
            <SelectTrigger data-testid="chat-rag-strategy-select" className='w-full h-10 text-sm border-zinc-300 dark:border-zinc-700 bg-card dark:bg-zinc-800'>
              <SelectValue>
                {individualStrategies.find(s => s.value === ragStrategy)?.label || t('settings.ragStrategy.selectStrategy')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className='z-[100]'>
              {individualStrategies.map(strategy => (
                <SelectItem key={strategy.value} value={strategy.value} className='text-sm'>
                  {strategy.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {ragStrategy && (
            <div className='bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800/50 rounded-md p-2.5'>
              <p className='text-xs text-green-800 dark:text-green-200 leading-relaxed'>
                {individualStrategies.find(s => s.value === ragStrategy)?.description}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );

  // Parameters section component (reusable)
  const parametersSection = (
    <div className='bg-zinc-50 dark:bg-zinc-900/50 rounded-md p-4 border border-zinc-200 dark:border-zinc-800'>
      <div className='space-y-6'>
        <div>
          <div className='flex justify-between items-center mb-2'>
            <label className='text-sm font-semibold text-zinc-700 dark:text-zinc-300'>
              {t('popovers.collectionSelector.similarity')}
            </label>
            <span className='text-xs font-semibold text-primary bg-primary/10 px-2 py-1 rounded'>
              {getSimilarityLabel(similarity)}
            </span>
          </div>
          <Slider
            value={[similarity]}
            min={0}
            max={1}
            step={0.01}
            className='w-full'
            onValueChange={values => {
              setSimilarity(values[0]);
              debouncedApplySelections(selected, values[0], numChunks);
            }}
          />
        </div>

        <div>
          <div className='flex justify-between items-center mb-2'>
            <label className='text-sm font-semibold text-zinc-700 dark:text-zinc-300'>
              {t('popovers.collectionSelector.numChunks')}
            </label>
            <span className='text-xs font-semibold text-primary bg-primary/10 px-2 py-1 rounded'>
              {numChunks}
            </span>
          </div>
          <Slider
            value={[numChunks]}
            min={1}
            max={30}
            step={1}
            className='w-full'
            onValueChange={values => {
              setNumChunks(values[0]);
              debouncedApplySelections(selected, similarity, values[0]);
            }}
          />
        </div>

        {/* Knowledge augmentation mode (Strict / Augmented / Auto).
            Controls whether the LLM is allowed to add a clearly-labeled
            wider-context paragraph from its general knowledge alongside
            the cited RAG content. */}
        <div>
          <div className='mb-2'>
            <label className='text-sm font-semibold text-zinc-700 dark:text-zinc-300'>
              {t('popovers.collectionSelector.augmentation.title')}
            </label>
            <p className='text-xs text-zinc-500 dark:text-zinc-400 mt-0.5'>
              {t('popovers.collectionSelector.augmentation.description')}
            </p>
          </div>
          <Select
            value={ragAugmentation}
            onValueChange={(v) => {
              hasUserInteracted.current = true;
              setRagAugmentation(v as 'strict' | 'augmented' | 'auto');
            }}
          >
            <SelectTrigger
              data-testid='popover-rag-augmentation'
              className='w-full border-zinc-300 dark:border-zinc-700'
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='strict'>
                <div className='flex flex-col text-left'>
                  <span className='font-medium'>{t('popovers.collectionSelector.augmentation.strict')}</span>
                  <span className='text-xs text-muted-foreground'>{t('popovers.collectionSelector.augmentation.strictHint')}</span>
                </div>
              </SelectItem>
              <SelectItem value='augmented'>
                <div className='flex flex-col text-left'>
                  <span className='font-medium'>{t('popovers.collectionSelector.augmentation.augmented')}</span>
                  <span className='text-xs text-muted-foreground'>{t('popovers.collectionSelector.augmentation.augmentedHint')}</span>
                </div>
              </SelectItem>
              <SelectItem value='auto'>
                <div className='flex flex-col text-left'>
                  <span className='font-medium'>{t('popovers.collectionSelector.augmentation.auto')}</span>
                  <span className='text-xs text-muted-foreground'>{t('popovers.collectionSelector.augmentation.autoHint')}</span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );

  // "Switch to AI Routing" link component (reusable)
  const switchToAgenticLink = onSwitchToAgentic ? (
    <div className='flex items-center justify-between bg-primary/5 border border-primary/20 rounded-md p-3'>
      <div className='flex items-center gap-3 flex-1'>
        <BrainCircuit className='w-5 h-5 text-primary flex-shrink-0' />
        <div className='flex-1'>
          <p className='text-sm font-medium text-zinc-900 dark:text-white'>
            {t('chat.actions.switchToAIRouting')}
          </p>
          <p className='text-xs text-zinc-500 dark:text-zinc-400 mt-0.5'>
            {t('chat.actions.aiRoutingDescription')}
          </p>
        </div>
      </div>
      <Button
        data-testid="chat-switch-to-agentic-button"
        variant='ghost'
        size='sm'
        className='text-primary text-xs'
        onClick={onSwitchToAgentic}
      >
        {t('chat.actions.enable')}
      </Button>
    </div>
  ) : null;

  // Mobile content - merged scrollable view without tabs
  const mobileContent = (
    <>
      {/* Content Sections */}
      <div className='space-y-6'>
        {!simpleMode && (
          <>
            {/* Strategy Section */}
            <div>
              <div className='flex items-center gap-2 mb-3'>
                <BrainCircuit className='h-4 w-4 text-zinc-500' />
                <h3 className='text-sm font-semibold text-zinc-900 dark:text-zinc-100'>Strategy</h3>
              </div>
              {strategySection}
            </div>

            {/* Parameters Section */}
            <div>
              <div className='flex items-center gap-2 mb-3'>
                <Sliders className='h-4 w-4 text-zinc-500' />
                <h3 className='text-sm font-semibold text-zinc-900 dark:text-zinc-100'>Parameters</h3>
              </div>
              {parametersSection}
            </div>
          </>
        )}

        {/* Collections Section */}
        <div>
          <div className='flex items-center gap-2 mb-3'>
            <Book className='h-4 w-4 text-zinc-500' />
            <h3 className='text-sm font-semibold text-zinc-900 dark:text-zinc-100'>Collections</h3>
          </div>
          {collectionsSection}
        </div>

        {/* Switch to AI Routing */}
        {switchToAgenticLink}
      </div>

    </>
  );

  // Desktop content - tabbed view
  const desktopContent = (
    <>
      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className='w-full'>
        <TabsList className={cn(
          'w-full grid bg-zinc-100 dark:bg-zinc-900 p-0.5 gap-0.5 rounded-md overflow-hidden',
          simpleMode ? 'grid-cols-1' : 'grid-cols-3'
        )}>
          {!simpleMode && (
            <TabsTrigger
              data-testid="chat-collection-tab-strategy"
              value='strategy'
              className='flex items-center gap-2 text-sm font-semibold py-2 px-3'
            >
              <BrainCircuit className='h-4 w-4' />
              <span>Strategy</span>
            </TabsTrigger>
          )}
          {!simpleMode && (
            <TabsTrigger
              data-testid="chat-collection-tab-parameters"
              value='parameters'
              className='flex items-center gap-2 text-sm font-semibold py-2 px-3'
            >
              <Sliders className='h-4 w-4' />
              <span>Parameters</span>
            </TabsTrigger>
          )}
          <TabsTrigger
            data-testid="chat-collection-tab-collections"
            value='collections'
            className='flex items-center gap-2 text-sm font-semibold py-2 px-3'
          >
            <Book className='h-4 w-4' />
            <span>Collections</span>
          </TabsTrigger>
        </TabsList>

        <div className='mt-4 relative min-h-[350px]'>
          {/* Collections Tab */}
          {activeTab === 'collections' && (
            <TabsContent
              value='collections'
              forceMount
              className='absolute inset-0 p-2 overflow-y-auto'
            >
              {collectionsSection}
            </TabsContent>
          )}

          {/* Strategy Tab */}
          {activeTab === 'strategy' && (
            <TabsContent
              value='strategy'
              forceMount
              className='absolute inset-0 p-2 overflow-y-auto'
            >
              {strategySection}
            </TabsContent>
          )}

          {/* Parameters Tab */}
          {activeTab === 'parameters' && (
            <TabsContent
              value='parameters'
              forceMount
              className='absolute inset-0 p-2 overflow-y-auto'
            >
              {parametersSection}
            </TabsContent>
          )}
        </div>
      </Tabs>

      {/* Switch to AI Routing - at bottom */}
      {switchToAgenticLink && (
        <div className='mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800'>
          {switchToAgenticLink}
        </div>
      )}

      {/* Header Section - Moved to bottom */}
      <div className='flex items-center gap-3 mt-4'>
        <BrainCircuit className='h-4 w-4 text-primary' />
        <h2 className='text-base font-semibold text-foreground flex-1'>
          {t('popovers.collectionSelector.title') || 'RAG Configuration'}
        </h2>
        <Button
          variant='ghost'
          size='sm'
          className='h-8 w-8 p-0 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleOpenKnowledgeStacks();
          }}
          title='Manage Knowledge Collections'
        >
          <Book className='h-4 w-4' />
        </Button>
      </div>

      {/* Knowledge Stacks Dialog */}
      <KnowledgeStacksDialog
        open={isKnowledgeStacksOpen}
        onOpenChange={handleKnowledgeStacksOpenChange}
        onCollectionChange={handleCollectionChange}
      />
    </>
  );

  // Mobile: Wrap in Dialog for fullscreen with proper back button/ESC handling
  if (isNarrowScreen && open !== undefined && onOpenChange) {
    return (
      <>
        <Dialog open={open} onOpenChange={(newOpen) => {
          // Prevent closing parent dialog while KnowledgeStacksDialog is open
          // Use ref for synchronous check (state may not be updated yet due to React batching)
          if (!newOpen && isKnowledgeStacksOpenRef.current) {
            return;
          }
          onOpenChange(newOpen);
        }}>
          <DialogContent
            className='w-[min(420px,calc(100vw-24px))] max-h-[min(85vh,720px)] p-0 gap-0 overflow-hidden bg-card dark:bg-zinc-950 flex flex-col'
            hideCloseButton={true}
            overlayZIndex='100'
            disableFullscreenOnMobile
            onPointerDownOutside={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
          >
            {/* Header Bar - Settings-like styling */}
            <div className='sticky top-0 z-20' style={{ position: 'sticky' }}>
              <div
                className='absolute inset-0 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-xl -z-10'
                style={{ maskImage: 'linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)' }}
              />
              <div className='flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800'>
                <div className='flex items-center gap-3'>
                  <BrainCircuit className='h-5 w-5 text-primary' />
                  <DialogTitle className='text-lg font-semibold text-zinc-900 dark:text-white'>
                    {t('popovers.collectionSelector.title') || 'RAG Configuration'}
                  </DialogTitle>
                </div>
                <div className='flex items-center gap-2'>
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-8 w-8 p-0 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800'
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleOpenKnowledgeStacks();
                    }}
                    title='Manage Knowledge Collections'
                  >
                    <Book className='h-4 w-4' />
                  </Button>
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-8 w-8 p-0 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800'
                    onClick={() => onOpenChange(false)}
                  >
                    <X className='h-4 w-4' />
                  </Button>
                </div>
              </div>
            </div>
            <DialogDescription className='sr-only'>
              Configure RAG settings including collections, strategy, and parameters
            </DialogDescription>
            {/* Scrollable Content */}
            <div className='flex-1 overflow-y-auto p-4'>
              {mobileContent}
            </div>
          </DialogContent>
        </Dialog>

        {/* KnowledgeStacksDialog rendered OUTSIDE parent Dialog to avoid portal/history conflicts */}
        <KnowledgeStacksDialog
          open={isKnowledgeStacksOpen}
          onOpenChange={handleKnowledgeStacksOpenChange}
          onCollectionChange={handleCollectionChange}
        />
      </>
    );
  }

  // Desktop: Return as popover content (used inside PopoverContent)
  return (
    <div className='w-[500px] max-w-full p-4'>
      {desktopContent}
    </div>
  );
};
