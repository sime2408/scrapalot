import { useState, useEffect, useRef } from 'react';
import {
  BookText,
  Book,
  BrainCircuit,
  Globe,
  MoreHorizontal,
  Paperclip,
  Settings,
  Sparkles,
  Search,
  Brain,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { Slider } from '@/components/ui/slider.tsx';
import { PopoverModelSettings } from './popover-model-settings.tsx';
import { DocumentCollection, ModelSettings, PromptTemplate } from '@/types';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover.tsx';
import { PopoverPromptSelector } from './popover-prompt-selector.tsx';
import { PopoverFileAttachment } from '@/components/chat/toolbar/actions/popover-file-attachment.tsx';
import { PopoverCollectionSelector } from '@/components/chat/toolbar/actions/popover-collection-selector.tsx';
import { useTranslation } from 'react-i18next';

interface ActionsProps {
  selectedCollections: DocumentCollection[];
  onSelectCollections: (collections: DocumentCollection[], similarity?: number, numChunks?: number) => void;
  onWebSearchToggle?: (enabled: boolean) => void;
  webSearchEnabled?: boolean;
  onDeepResearchToggle?: (enabled: boolean) => void;
  deepResearchEnabled?: boolean;
  onResearchConfigChange?: (breadth: number, depth: number) => void;
  researchBreadth?: number;
  researchDepth?: number;
  similarity?: number;
  numChunks?: number;
  preloadedModelSettings?: ModelSettings | null;
  onAgenticRagToggle?: (enabled: boolean) => void;
  onAttachmentsChange?: (attachments: import('@/types/file-attachments').ChatAttachment[]) => void;
  attachmentCount?: number;
  showReasoningIndicators?: boolean;
  onReasoningToggle?: (enabled: boolean) => void;
  agenticRagEnabled?: boolean;
  /** 7.8 v1 — AI Tutor Mode toggle. */
  onTutorModeToggle?: (enabled: boolean) => void;
  tutorModeEnabled?: boolean;
  /** 7.7 — Thought Partner toggle. Mutually exclusive with tutor +
   *  deep research + web search. */
  onThoughtPartnerToggle?: (enabled: boolean) => void;
  thoughtPartnerEnabled?: boolean;
  /** Settings → Prompts → Custom Templates picker. The popover
   *  invokes this with the chosen template; the toolbar then forwards
   *  template.title (= backend template name) into the next chat
   *  request as `prompt_template_name` so Layer 6 of the system-prompt
   *  builder picks up its body. */
  onSelectPromptTemplate?: (template: PromptTemplate | null) => void;
  /** Currently active template title (toolbar-level state). When set,
   *  the toolbar shows a small "Prompt: <name>" affordance so the
   *  user knows their messages are being augmented. */
  activePromptTemplateName?: string | null;
}

export const Actions = ({
  selectedCollections,
  onSelectCollections,
  onWebSearchToggle,
  webSearchEnabled = false,
  onDeepResearchToggle,
  deepResearchEnabled = false,
  onResearchConfigChange,
  researchBreadth = 4,
  researchDepth = 2,
  similarity = 0.5,
  numChunks = 15,
  preloadedModelSettings,
  onAgenticRagToggle,
  onAttachmentsChange,
  attachmentCount = 0,
  showReasoningIndicators = true,
  onReasoningToggle,
  agenticRagEnabled = false,
  onTutorModeToggle,
  tutorModeEnabled = false,
  onThoughtPartnerToggle,
  thoughtPartnerEnabled = false,
  onSelectPromptTemplate,
  activePromptTemplateName,
}: ActionsProps) => {
  const { t } = useTranslation();
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [attachPopoverOpen, setAttachPopoverOpen] = useState(false);
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(false);
  const [searchMenuOpen, setSearchMenuOpen] = useState(false);
  const [_isDropdownOpen, _setIsDropdownOpen] = useState(false);
  const [_selectedSearchType, setSelectedSearchType] = useState<
    'simple' | 'deep' | null
  >('simple');
  const [localResearchBreadth, setLocalResearchBreadth] =
    useState(researchBreadth);
  const [localResearchDepth, setLocalResearchDepth] = useState(researchDepth);
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 992
  );

  // Track window width changes for responsive behavior
  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleBreadthChange = (value: number) => {
    setLocalResearchBreadth(value);
    onResearchConfigChange?.(value, localResearchDepth);
  };

  const handleDepthChange = (value: number) => {
    setLocalResearchDepth(value);
    onResearchConfigChange?.(localResearchBreadth, value);
  };

  // Use preloaded settings or fallback to defaults
  const [modelSettings, setModelSettings] = useState<ModelSettings>(() => {
    return preloadedModelSettings || {
      maxOutputTokens: 8000,
      temperature: 0.1,
      contextWindowSize: 256000,
      topP: 0.9,
      topK: 40,
      frequencyPenalty: 0.5,
      presencePenalty: 0.5,
      gpuLayers: -1,
      contextMessageLimit: 30,
      modelInstructions: 'You are a helpful assistant.',
    };
  });

  // Update local settings when preloaded settings change
  useEffect(() => {
    if (preloadedModelSettings) {
      setModelSettings(preloadedModelSettings);
    }
  }, [preloadedModelSettings]);

  const handleSettingsChange = (newSettings: ModelSettings) => {
    setModelSettings(newSettings);
    // Here you would typically propagate these settings to your chat context or state management
  };

  const handleSimpleSearchSelect = () => {
    setSelectedSearchType('simple');
    if (onWebSearchToggle) {
      onWebSearchToggle(true);
    }
    if (onDeepResearchToggle) {
      onDeepResearchToggle(false);
    }
    // Mutually exclusive with the Tutor / Thought Partner personas (same trap
    // as deep research — a leftover persona would win at send time).
    if (onTutorModeToggle) {
      onTutorModeToggle(false);
    }
    if (onThoughtPartnerToggle) {
      onThoughtPartnerToggle(false);
    }
    setSearchMenuOpen(false);
  };

  const handleDeepResearchSelect = () => {
    setSelectedSearchType('deep');
    if (onWebSearchToggle) {
      onWebSearchToggle(false);
    }
    // Deep Research is mutually exclusive with the Tutor / Thought Partner
    // personas — leaving one of them on alongside it routes the send to that
    // persona instead of deep research (the menu showed BOTH checked). Turn
    // them off here, mirroring handleTutorModeSelect / handleThoughtPartnerSelect.
    if (onTutorModeToggle) {
      onTutorModeToggle(false);
    }
    if (onThoughtPartnerToggle) {
      onThoughtPartnerToggle(false);
    }
    if (onDeepResearchToggle) {
      onDeepResearchToggle(true);
    }
    // Keep popover open when enabling deep research so user can configure breadth/depth
    // setSearchMenuOpen(false);
  };

  // 7.8 v1 — toggle AI Tutor Mode. Mutually exclusive with Deep
  // Research, Web Search, and Thought Partner (each persona would
  // fight the others).
  const handleTutorModeSelect = () => {
    const next = !tutorModeEnabled;
    if (next && onDeepResearchToggle) onDeepResearchToggle(false);
    if (next && onWebSearchToggle) onWebSearchToggle(false);
    if (next && onThoughtPartnerToggle) onThoughtPartnerToggle(false);
    if (onTutorModeToggle) onTutorModeToggle(next);
    setSearchMenuOpen(false);
  };

  // 7.7 — toggle Thought Partner Mode. Mutually exclusive with all
  // other generation modes — TP routes to DirectLLM and skips
  // retrieval entirely.
  const handleThoughtPartnerSelect = () => {
    const next = !thoughtPartnerEnabled;
    if (next && onDeepResearchToggle) onDeepResearchToggle(false);
    if (next && onWebSearchToggle) onWebSearchToggle(false);
    if (next && onTutorModeToggle) onTutorModeToggle(false);
    if (onThoughtPartnerToggle) onThoughtPartnerToggle(next);
    setSearchMenuOpen(false);
  };

  const handleSearchDisable = () => {
    setSelectedSearchType(null);
    if (onWebSearchToggle) {
      onWebSearchToggle(false);
    }
    if (onDeepResearchToggle) {
      onDeepResearchToggle(false);
    }
    setSearchMenuOpen(false);
  };

  const handleSelectPromptTemplate = (template: PromptTemplate) => {
    // Toolbar tracks the active template at the chat-toolbar level. Toggle
    // off when the user clicks the same template again so there's no
    // captive-state pitfall ("how do I clear it?").
    if (onSelectPromptTemplate) {
      const isSame = activePromptTemplateName === template.title;
      onSelectPromptTemplate(isSame ? null : template);
    }
    setPromptsOpen(false);
  };

  const handleSelectCollections = (collections: DocumentCollection[], similarity?: number, numChunks?: number) => {
    onSelectCollections(collections, similarity, numChunks);
    setCollectionsOpen(false);
  };

  // Handler to switch from agentic to manual mode
  const handleSwitchToManual = () => {
    onAgenticRagToggle?.(false);
    setCollectionsOpen(false);
  };

  // Handler to switch from manual to agentic mode
  const handleSwitchToAgentic = () => {
    onAgenticRagToggle?.(true);
    setCollectionsOpen(false);
  };

  // Define all available actions
  const allActions = [
    {
      id: 'collections',
      component: agenticRagEnabled ? (
        // === AGENTIC MODE: BrainCircuit icon with small status popover ===
        <Popover
          key='collections-agentic'
          onOpenChange={setCollectionsOpen}
          disableBlur
          open={collectionsOpen}
        >
          <PopoverTrigger asChild>
            <Button
              data-testid="collection-selector"
              size='icon'
              variant='ghost'
              className='relative h-8 w-8 p-0 text-primary bg-primary/10'
            >
              <BrainCircuit className='h-5 w-5 animate-pulse' />
              {selectedCollections.length > 0 && (
                <span data-testid='collection-count-badge' className='absolute top-0 right-0 h-3 w-3 flex items-center justify-center rounded-full bg-primary text-[10px] text-white'>
                  {selectedCollections.length}
                </span>
              )}
              <span className='sr-only'>{t('chat.actions.aiRoutingActive')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className='p-0 w-[min(280px,calc(100vw-16px))] z-[90]'
            align='center'
            side='top'
            sideOffset={8}
            collisionPadding={{ left: 8, right: 8, top: 8, bottom: 8 }}
          >
            <div className='p-4 space-y-3'>
              <div className='flex items-center gap-3'>
                <div className='h-8 w-8 bg-primary/10 flex items-center justify-center'>
                  <BrainCircuit className='h-4 w-4 text-primary' />
                </div>
                <div>
                  <p className='text-sm font-medium text-zinc-900 dark:text-white'>
                    {t('chat.actions.aiRoutingActive')}
                  </p>
                  <p className='text-xs text-zinc-500 dark:text-zinc-400'>
                    {t('chat.actions.aiRoutingDescription')}
                  </p>
                </div>
              </div>
              {selectedCollections.length > 0 && (
                <div className='border-t border-border pt-3 space-y-1.5'>
                  <p className='text-xs font-medium text-zinc-700 dark:text-zinc-300'>
                    {t('chat.actions.pinnedOverrideTitle')}
                  </p>
                  <p className='text-xs text-zinc-500 dark:text-zinc-400'>
                    {t('chat.actions.pinnedOverrideHint')}
                  </p>
                  <div className='flex flex-wrap gap-1.5 pt-1'>
                    {selectedCollections.map((c) => (
                      <span
                        key={c.id}
                        data-testid={`agentic-pinned-collection-${c.id}`}
                        className='inline-flex items-center gap-1 border border-primary/30 bg-primary/10 text-primary text-xs px-2 py-0.5'
                      >
                        {c.name}
                        <button
                          type='button'
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => handleSelectCollections(selectedCollections.filter((x) => x.id !== c.id))}
                          className='hover:text-primary/70'
                          aria-label={t('chat.actions.removePinnedCollection')}
                        >
                          <X className='h-3 w-3' />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <Button
                data-testid="chat-switch-to-manual-button"
                variant='ghost'
                size='sm'
                className='w-full text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300'
                onClick={handleSwitchToManual}
              >
                {t('chat.actions.switchToManual')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : (
        // === MANUAL MODE: Book icon with full RAG config popover ===
        <Popover
          key='collections'
          onOpenChange={setCollectionsOpen}
          disableBlur
          open={collectionsOpen}
        >
          <PopoverTrigger asChild>
            <Button
              data-testid="collection-selector"
              data-tour="knowledge-stacks"
              size='icon'
              variant='ghost'
              className={`h-8 w-8 p-0 ${selectedCollections.length > 0
                ? 'text-primary bg-primary/10'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
            >
              <Book className='h-5 w-5' />
              {selectedCollections.length > 0 && (
                <span data-testid='collection-count-badge' className='absolute top-0 right-0 h-3 w-3 flex items-center justify-center rounded-full bg-primary text-[10px] text-white'>
                  {selectedCollections.length}
                </span>
              )}
              <span className='sr-only'>{t('sidebar.knowledgeStacks')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className='p-0 w-[min(500px,calc(100vw-16px))] z-[90]'
            align='center'
            side='top'
            sideOffset={8}
            collisionPadding={{ left: 8, right: 8, top: 8, bottom: 8 }}
            onInteractOutside={(e) => {
              const target = e.target as HTMLElement;
              const isInsideDialog = target?.closest('[role="dialog"]') ||
                                     target?.closest('[data-radix-portal]');
              if (isInsideDialog) {
                e.preventDefault();
              }
            }}
          >
            <PopoverCollectionSelector
              selectedCollections={selectedCollections}
              onSelectCollections={handleSelectCollections}
              initialSimilarity={similarity}
              initialNumChunks={numChunks}
              onSwitchToAgentic={handleSwitchToAgentic}
            />
          </PopoverContent>
        </Popover>
      ),
      menuItem: (
        <Button
          key='collections-menu'
          variant='ghost'
          className='w-full justify-start text-left text-sm h-9 px-2 py-1.5'
          onClick={() => {
            setCollectionsOpen(true);
            setMoreOptionsOpen(false);
          }}
        >
          {agenticRagEnabled ? (
            <BrainCircuit className='h-4 w-4 mr-2 text-primary' />
          ) : (
            <Book className='h-4 w-4 mr-2' />
          )}
          {agenticRagEnabled ? t('chat.actions.aiRoutingActive') : t('sidebar.knowledgeStacks')}
          {selectedCollections.length > 0 && (
            <span className='ml-auto text-xs bg-primary text-white rounded-full px-1.5 py-0.5 min-w-[16px] text-center'>
              {selectedCollections.length}
            </span>
          )}
        </Button>
      ),
      priority: 1,
    },
    {
      id: 'search',
      component: (
        <Popover
          key='search'
          onOpenChange={setSearchMenuOpen}
          disableBlur
          open={searchMenuOpen}
        >
          <PopoverTrigger asChild>
            <Button
              data-testid="search-menu-button"
              data-tour="search-options"
              size='icon'
              variant='ghost'
              className={`h-8 w-8 p-0 ${webSearchEnabled || deepResearchEnabled
                ? 'text-blue-600 bg-blue-50 dark:text-blue-400 dark:bg-blue-950'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              onClick={e => {
                if (webSearchEnabled || deepResearchEnabled) {
                  e.preventDefault();
                  handleSearchDisable();
                }
              }}
            >
              <Globe className='h-5 w-5' />
              <span className='sr-only'>{t('chat.actions.searchOptions')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className='p-0 w-[220px] z-[90]'
            align='center'
            side='top'
            collisionPadding={{ left: 8, right: 8, bottom: 8 }}
          >
            <div className='w-full'>
              <div className='p-1'>
                <Button
                  data-testid="chat-search-simple-button"
                  variant='ghost'
                  className={`w-full justify-start text-left text-sm min-h-9 h-auto px-2 py-1.5 whitespace-normal leading-snug ${webSearchEnabled
                    ? 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400'
                    : ''
                    }`}
                  onClick={handleSimpleSearchSelect}
                >
                  <Search className='h-4 w-4 mr-2 shrink-0' />
                  {t('chat.actions.simpleSearch')}
                  {webSearchEnabled && (
                    <span className='ml-auto text-xs text-blue-600 dark:text-blue-400'>
                      ✓
                    </span>
                  )}
                </Button>
                <div className='space-y-2'>
                  <Button
                    data-testid="chat-search-deep-research-button"
                    data-tour="research-toggle"
                    variant='ghost'
                    className={`w-full justify-start text-left text-sm min-h-9 h-auto px-2 py-1.5 whitespace-normal leading-snug ${deepResearchEnabled
                      ? 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400'
                      : ''
                      }`}
                    onClick={handleDeepResearchSelect}
                  >
                    <Brain className='h-4 w-4 mr-2 shrink-0' />
                    {t('chat.actions.deepResearch')}
                    {deepResearchEnabled && (
                      <span className='ml-auto text-xs text-blue-600 dark:text-blue-400'>
                        ✓
                      </span>
                    )}
                  </Button>

                  {/* 7.8 v1 — AI Tutor Mode. Same popover as web/deep
                      since it's a "what kind of answer do I want"
                      switch, not a separate workflow. */}
                  <Button
                    data-testid="chat-search-tutor-mode-button"
                    variant='ghost'
                    className={`w-full justify-start text-left text-sm min-h-9 h-auto px-2 py-1.5 whitespace-normal leading-snug ${tutorModeEnabled
                      ? 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300'
                      : ''
                      }`}
                    onClick={handleTutorModeSelect}
                  >
                    <Brain className='h-4 w-4 mr-2 shrink-0' />
                    {t('chat.actions.tutorMode', 'AI Tutor mode')}
                    {tutorModeEnabled && (
                      <span className='ml-auto text-xs text-amber-700 dark:text-amber-300'>
                        ✓
                      </span>
                    )}
                  </Button>

                  {/* 7.7 — Thought Partner. Pure questions-only mode;
                      LLM never answers, only probes the user's
                      reasoning with 3-5 numbered questions. */}
                  <Button
                    data-testid="chat-search-thought-partner-button"
                    variant='ghost'
                    className={`w-full justify-start text-left text-sm min-h-9 h-auto px-2 py-1.5 whitespace-normal leading-snug ${thoughtPartnerEnabled
                      ? 'bg-violet-50 dark:bg-violet-950 text-violet-700 dark:text-violet-300'
                      : ''
                      }`}
                    onClick={handleThoughtPartnerSelect}
                  >
                    <Brain className='h-4 w-4 mr-2 shrink-0' />
                    {t('chat.actions.thoughtPartner', 'Thought Partner (asks questions)')}
                    {thoughtPartnerEnabled && (
                      <span className='ml-auto text-xs text-violet-700 dark:text-violet-300'>
                        ✓
                      </span>
                    )}
                  </Button>

                  {deepResearchEnabled && (
                    <div className='px-2 py-2 space-y-3 border-t border-zinc-200 dark:border-zinc-700'>
                      <div className='space-y-2'>
                        <div className='flex items-center justify-between'>
                          <label className='text-xs font-medium text-zinc-600 dark:text-zinc-400'>
                            {t('chat.deepResearch.breadth')}:{' '}
                            {localResearchBreadth}
                          </label>
                        </div>
                        <Slider
                          value={[localResearchBreadth]}
                          min={1}
                          max={10}
                          step={1}
                          onValueChange={values =>
                            handleBreadthChange(values[0])
                          }
                        />
                        <div className='flex justify-between text-xs text-zinc-500 dark:text-zinc-400'>
                          <span>
                            {t('chat.deepResearch.breadthLabels.focused')}
                          </span>
                          <span>
                            {t('chat.deepResearch.breadthLabels.comprehensive')}
                          </span>
                        </div>
                      </div>

                      <div className='space-y-2'>
                        <div className='flex items-center justify-between'>
                          <label className='text-xs font-medium text-zinc-600 dark:text-zinc-400'>
                            {t('chat.deepResearch.depth')}: {localResearchDepth}
                          </label>
                        </div>
                        <Slider
                          value={[localResearchDepth]}
                          min={1}
                          max={5}
                          step={1}
                          onValueChange={values =>
                            handleDepthChange(values[0])
                          }
                        />
                        <div className='flex justify-between text-xs text-zinc-500 dark:text-zinc-400'>
                          <span>
                            {t('chat.deepResearch.depthLabels.surface')}
                          </span>
                          <span>{t('chat.deepResearch.depthLabels.deep')}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      ),
      menuItem: (
        <Button
          key='search-menu'
          variant='ghost'
          className='w-full justify-start text-left text-sm h-9 px-2 py-1.5'
          onClick={() => {
            setSearchMenuOpen(true);
            setMoreOptionsOpen(false);
          }}
        >
          <Globe className='h-4 w-4 mr-2' />
          {t('chat.actions.searchOptions')}
          {(webSearchEnabled || deepResearchEnabled) && (
            <span className='ml-auto text-xs text-blue-600 dark:text-blue-400'>
              ✓
            </span>
          )}
        </Button>
      ),
      priority: 2,
    },
    {
      id: 'settings',
      component: (
        <Popover
          key='settings'
          onOpenChange={setSettingsOpen}
          disableBlur
          open={settingsOpen}
        >
          <PopoverTrigger asChild>
            <Button
              data-testid="chat-toolbar-settings-button"
              size='icon'
              variant='ghost'
              className='h-8 w-8 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 p-0'
            >
              <Settings className='h-5 w-5' />
              <span className='sr-only'>{t('sidebar.settings')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className='p-0 w-[min(320px,calc(100vw-16px))] max-h-[70vh] overflow-y-auto z-[90]'
            align='center'
            side='bottom'
            collisionPadding={8}
          >
            <div className='w-full'>
              <PopoverModelSettings
                settings={modelSettings}
                onSettingsChange={handleSettingsChange}
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                insidePopover
              />
            </div>
          </PopoverContent>
        </Popover>
      ),
      menuItem: (
        <Button
          key='settings-menu'
          variant='ghost'
          className='w-full justify-start text-left text-sm h-9 px-2 py-1.5'
          onClick={() => {
            setSettingsOpen(true);
            setMoreOptionsOpen(false);
          }}
        >
          <Settings className='h-4 w-4 mr-2' />
          {t('sidebar.settings')}
        </Button>
      ),
      priority: 3,
    },
    {
      id: 'attach-files',
      component: (
        <Popover
          key='attach-files'
          open={attachPopoverOpen}
          onOpenChange={setAttachPopoverOpen}
          disableBlur
        >
          <PopoverTrigger asChild>
            <Button
              data-testid="chat-toolbar-attach-files-standalone-button"
              size='icon'
              variant='ghost'
              className={cn(
                'h-8 w-8 p-0 relative',
                attachmentCount > 0
                  ? 'text-primary bg-primary/10'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              )}
            >
              <Paperclip className='h-5 w-5' />
              {attachmentCount > 0 && (
                <span className='absolute top-0 right-0 h-3 w-3 flex items-center justify-center rounded-full bg-primary text-[10px] text-white'>
                  {attachmentCount}
                </span>
              )}
              <span className='sr-only'>{t('chat.actions.attachFiles')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className='p-0 w-[min(400px,calc(100vw-16px))] h-[min(320px,calc(100vh-96px))] z-[90] flex flex-col overflow-hidden'
            align='center'
            side='top'
            sideOffset={8}
            collisionPadding={8}
          >
            <PopoverFileAttachment
              fillHeight
              onClose={() => setAttachPopoverOpen(false)}
              onAttachmentsChange={onAttachmentsChange}
            />
          </PopoverContent>
        </Popover>
      ),
      menuItem: (
        <Button
          key='attach-files-menu'
          data-testid="chat-toolbar-attach-files-button"
          variant='ghost'
          className='w-full justify-start text-left text-sm h-9 px-2 py-1.5'
          onClick={() => setFileMenuOpen(true)}
        >
          <Paperclip className='h-4 w-4 mr-2' />
          {t('chat.actions.attachFiles')}
          {attachmentCount > 0 && (
            <span className='ml-auto text-xs bg-primary text-white rounded-full px-1.5 py-0.5 min-w-[16px] text-center'>
              {attachmentCount}
            </span>
          )}
        </Button>
      ),
      priority: 4,
    },
    {
      id: 'prompt-templates',
      component: (
        <Popover
          key='prompt-templates'
          open={promptsOpen}
          onOpenChange={setPromptsOpen}
          disableBlur
        >
          <PopoverTrigger asChild>
            <Button
              data-testid="chat-toolbar-prompts-standalone-button"
              size='icon'
              variant='ghost'
              className='h-8 w-8 p-0 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
            >
              <BookText className='h-5 w-5' />
              <span className='sr-only'>{t('chat.promptTemplates')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className='p-0 w-[min(360px,calc(100vw-16px))] max-h-[min(500px,calc(100vh-64px))] overflow-y-auto z-[90]'
            align='center'
            side='bottom'
            collisionPadding={8}
          >
            <PopoverPromptSelector
              onSelect={handleSelectPromptTemplate}
              activeTemplateTitle={activePromptTemplateName}
            />
          </PopoverContent>
        </Popover>
      ),
      menuItem: (
        <Button
          key='prompts-menu'
          data-testid="chat-toolbar-prompts-button"
          variant='ghost'
          className='w-full justify-start text-left text-sm h-9 px-2 py-1.5'
          onClick={() => {
            setPromptsOpen(true);
            setMoreOptionsOpen(false);
          }}
        >
          <BookText className='h-4 w-4 mr-2' />
          {t('chat.promptTemplates')}
        </Button>
      ),
      priority: 5,
    },
    {
      id: 'ai-thinking',
      component: (
        <Button
          key='ai-thinking'
          data-testid="chat-toolbar-reasoning-toggle-button"
          size='icon'
          variant='ghost'
          className={cn(
            'h-8 w-8 p-0',
            showReasoningIndicators
              ? 'text-primary bg-primary/10'
              : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          )}
          onClick={() => onReasoningToggle?.(!showReasoningIndicators)}
          title={t('chat.actions.showAIThinking')}
        >
          <Sparkles className='h-5 w-5' />
          <span className='sr-only'>{t('chat.actions.showAIThinking')}</span>
        </Button>
      ),
      menuItem: (
        <div
          key='ai-thinking-menu'
          data-testid="chat-toolbar-reasoning-toggle"
          className='flex items-center justify-between w-full text-sm h-9 px-2 py-1.5 hover:bg-accent hover:text-accent-foreground cursor-pointer'
          onClick={() => onReasoningToggle?.(!showReasoningIndicators)}
        >
          <div className='flex items-center whitespace-nowrap'>
            <Sparkles className='h-4 w-4 mr-2 flex-shrink-0' />
            {t('chat.actions.showAIThinking')}
          </div>
          <Switch
            checked={showReasoningIndicators}
            onCheckedChange={(checked) => onReasoningToggle?.(checked)}
            className='scale-75'
          />
        </div>
      ),
      priority: 6,
    },
  ];

  // Determine how many buttons to show based on screen size with improved breakpoints
  const getVisibleButtonCount = () => {
    // Calculate available space more accurately
    // Mobile model selector takes ~140-160px, send button ~36px, margins ~16px
    // This leaves approximately windowWidth - 200px for actions

    const availableSpace = windowWidth - 200; // Conservative estimate for remaining space
    const buttonWidth = 32; // Each action button is 32px (h-8 w-8)
    const spacing = 8; // Space between buttons (space-x-2)
    const moreButtonWidth = 32; // Three dots button width

    // Calculate how many buttons can fit
    const maxButtonsWithoutOverflow = Math.floor(availableSpace / (buttonWidth + spacing));
    const maxButtonsWithOverflow = Math.floor((availableSpace - moreButtonWidth - spacing) / (buttonWidth + spacing));

    // If we can fit all buttons without overflow, show all
    if (maxButtonsWithoutOverflow >= allActions.length) {
      return allActions.length;
    }

    // Otherwise, show as many as possible with overflow menu
    // But ensure we have at least 1 button visible if there's space
    const visibleCount = Math.max(0, Math.min(maxButtonsWithOverflow, allActions.length - 1));

    // Fallback to original logic for very small screens
    if (windowWidth <= 320) {
      return 0; // Show only three dots menu on very small screens
    } else if (windowWidth <= 360) {
      return Math.min(1, visibleCount);
    } else if (windowWidth <= 400) {
      return Math.min(2, visibleCount);
    }

    return visibleCount;
  };

  const visibleButtonCount = getVisibleButtonCount();
  const sortedActions = allActions.sort((a, b) => a.priority - b.priority);
  const visibleActions = sortedActions.slice(0, visibleButtonCount);
  const overflowActions = sortedActions.slice(visibleButtonCount);

  return (
    <div className='flex items-center space-x-2'>
      {/* Render visible actions */}
      {visibleActions.map(action => (
        <div key={action.id} className='flex-shrink-0'>{action.component}</div>
      ))}

      {/* Render overflow actions with proper portal positioning */}
      {overflowActions.map(action => (
        <div
          key={`portal-${action.id}`}
          style={{
            position: 'absolute',
            top: 54,
            left: 230,
            width: 0,
            height: 0,
            overflow: 'hidden',
            visibility: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {action.component}
        </div>
      ))}

      {/* Overflow "..." menu — rendered only when actions don't fit */}
      {overflowActions.length > 0 && (
        <Popover
          open={moreOptionsOpen || fileMenuOpen}
          onOpenChange={(open) => {
            if (!open) {
              setMoreOptionsOpen(false);
              setFileMenuOpen(false);
            } else {
              setMoreOptionsOpen(true);
            }
          }}
          disableBlur
        >
          <PopoverTrigger asChild>
            <Button
              ref={moreButtonRef}
              data-testid="chat-toolbar-more-button"
              size='icon'
              variant='ghost'
              className='h-8 w-8 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 p-0 relative'
            >
              <MoreHorizontal className='h-5 w-5' />
              <span className='sr-only'>{t('chat.actions.moreOptions')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className={cn(
              'p-0 z-[90]',
              fileMenuOpen ? 'w-[min(400px,calc(100vw-16px))] h-[min(450px,calc(100vh-96px))]' : 'w-[220px]'
            )}
            align='end'
            side='top'
            sideOffset={16}
            collisionPadding={{ left: 40, right: 8 }}
          >
            {fileMenuOpen ? (
              /* File attachment view inside the popover */
              <div className='h-full overflow-hidden'>
                <div className='flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-800'>
                  <div className='flex items-center gap-2'>
                    <Paperclip className='h-4 w-4 text-primary' />
                    <span className='text-sm font-medium'>{t('chat.actions.attachFiles')}</span>
                  </div>
                  <Button
                    variant='ghost'
                    size='sm'
                    className='h-6 w-6 p-0'
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setFileMenuOpen(false)}
                  >
                    <X className='h-3.5 w-3.5' />
                  </Button>
                </div>
                <div className='h-[calc(100%-41px)] overflow-hidden'>
                  <PopoverFileAttachment onClose={() => { setFileMenuOpen(false); setMoreOptionsOpen(false); }} onAttachmentsChange={onAttachmentsChange} />
                </div>
              </div>
            ) : (
              /* Menu list — only overflow actions */
              <div className='w-full'>
                <div className='p-1'>
                  {overflowActions.map(action => (
                    <div key={action.id}>{action.menuItem}</div>
                  ))}
                </div>
              </div>
            )}
          </PopoverContent>
        </Popover>
      )}

    </div>
  );
};
