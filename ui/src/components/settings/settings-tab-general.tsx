import React, { useState, useEffect } from 'react';
import {Button} from '@/components/ui/button';
import {Activity, Bell, BrainCircuit, ChevronDown, Circle, Download, MessageSquare, Monitor, Moon, Settings as SettingsIcon, Sparkles, Sun, FolderOpen, HardDrive, Volume2} from 'lucide-react';
import {Switch} from '@/components/ui/switch';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue,} from '@/components/ui/select';
import {useTheme} from '@/providers/theme-provider';
import {useFontSettings} from '@/contexts/font-settings-context';
import {useTranslation} from 'react-i18next';
import {useLanguage} from '@/providers/language-provider';
import {useIsMobile} from '@/hooks/use-mobile';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {userPrefs} from '@/lib/storage-utils';
import {useNotificationSound} from '@/hooks/use-notification-sound';
import {useDesktopMode} from '@/hooks/use-desktop-mode';
import {useAdminCheck} from '@/hooks/use-admin-check';
import {getSystemAgentConfig, saveSystemAgentConfig, SystemAgentConfig} from '@/lib/api-settings';
import {Input} from '@/components/ui/input';
import {NoAutofillInput} from '@/components/ui/no-autofill-input';
import {toast} from '@/lib/toast-compat';

interface SettingsGeneralTabProps {
  enableLinks: boolean;
  setEnableLinks: (value: boolean) => void;
  appearance: 'light' | 'dark' | 'system';
  setAppearance: (value: 'light' | 'dark' | 'system') => void;
  accentColor: string;
  setAccentColor: (value: string) => void;
  fontStyle: string;
  setFontStyle: (value: string) => void;
  codeTheme: string;
  setCodeTheme: (value: string) => void;
  fontSize: number;
  setFontSize: (value: number) => void;
  showReasoningIndicators?: boolean;
  setShowReasoningIndicators?: (value: boolean) => void;
  ragStrategy?: string;
  setRagStrategy?: (value: string) => void;
  ragOrchestrator?: string;
  setRagOrchestrator?: (value: string) => void;
  useOrchestrator?: boolean;
  setUseOrchestrator?: (value: boolean) => void;
  useAgenticRouting?: boolean;
  setUseAgenticRouting?: (value: boolean) => void;
  ragTracingEnabled?: boolean;
  setRagTracingEnabled?: (value: boolean) => void;
  // Simple Mode Toggle
  simpleModeEnabled?: boolean;
  setSimpleModeEnabled?: (value: boolean) => void;
  // Agent profile slug (legal/medical/academic/technical/'')
  defaultAgentProfileSlug?: string;
  setDefaultAgentProfileSlug?: (value: string) => void;
  responseLength?: 'short' | 'medium' | 'long';
  setResponseLength?: (value: 'short' | 'medium' | 'long') => void;
  // Response Personalization
  responseFormality?: 'casual' | 'neutral' | 'academic';
  setResponseFormality?: (value: 'casual' | 'neutral' | 'academic') => void;
  responseDomainFocus?: string;
  setResponseDomainFocus?: (value: string) => void;
  renderingModules: string[];
  setRenderingModules: (value: string[]) => void;
  isSaving?: boolean;
  lastSaved?: Date;
}

export const SettingsGeneralTab: React.FC<SettingsGeneralTabProps> = ({
  enableLinks,
  setEnableLinks,
  appearance: _appearance,
  setAppearance,
  accentColor: _accentColor,
  setAccentColor,
  fontStyle,
  setFontStyle,
  codeTheme,
  setCodeTheme,
  fontSize,
  setFontSize,
  showReasoningIndicators = true,
  setShowReasoningIndicators = () => { },
  ragStrategy: _ragStrategy,
  setRagStrategy: _setRagStrategy,
  ragOrchestrator: _ragOrchestrator,
  setRagOrchestrator: _setRagOrchestrator,
  useOrchestrator: _useOrchestrator,
  setUseOrchestrator: _setUseOrchestrator,
  useAgenticRouting: _useAgenticRouting,
  setUseAgenticRouting: _setUseAgenticRouting,
  ragTracingEnabled = false,
  setRagTracingEnabled = () => { },
  simpleModeEnabled = false,
  setSimpleModeEnabled = () => { },
  defaultAgentProfileSlug = '',
  setDefaultAgentProfileSlug = () => { },
  responseLength = 'medium',
  setResponseLength = () => { },
  responseFormality = 'neutral',
  setResponseFormality = () => { },
  responseDomainFocus = '',
  setResponseDomainFocus = () => { },
  renderingModules,
  setRenderingModules,
  isSaving: _isSaving,
  lastSaved: _lastSaved,
}) => {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguage();
  const isMobile = useIsMobile();
  const { isDesktop, electronAPI } = useDesktopMode();
  const isAdmin = useAdminCheck();
  const { isSoundEnabled, toggleSound } = useNotificationSound();

  // Message notifications — per-device prefs. Toast vs bell-only is local
  // (userPrefs), read synchronously by the AdminMessagesProvider; sound reuses
  // the shared notification_sound_enabled pref via useNotificationSound.
  const [adminToastEnabled, setAdminToastEnabled] = useState<boolean>(
    () => (userPrefs.get() as { admin_messages_toast_enabled?: boolean }).admin_messages_toast_enabled ?? true
  );
  const handleAdminToastToggle = (value: boolean) => {
    setAdminToastEnabled(value);
    userPrefs.set({ admin_messages_toast_enabled: value });
  };

  // System agent config state (admin only)
  const [agentConfig, setAgentConfig] = useState<SystemAgentConfig>({
    provider_type: 'openai',
    model_name: 'gpt-4o-mini',
    api_base: '',
    has_api_key: false,
  });
  const [agentApiKey, setAgentApiKey] = useState('');
  // Separate key buffer for the synthesis (answer) model — only sent when typed.
  const [synthesisApiKey, setSynthesisApiKey] = useState('');
  const [agentConfigLoading, setAgentConfigLoading] = useState(false);
  const [agentConfigSaving, setAgentConfigSaving] = useState(false);

  // Load system agent config on mount (admin only)
  useEffect(() => {
    if (isAdmin) {
      setAgentConfigLoading(true);
      getSystemAgentConfig()
        .then(config => {
          setAgentConfig(config);
        })
        .catch(err => {
          console.error('Failed to load system agent config:', err);
        })
        .finally(() => {
          setAgentConfigLoading(false);
        });
    }
  }, [isAdmin]);

  // Save system agent config
  const handleSaveAgentConfig = async () => {
    setAgentConfigSaving(true);
    try {
      await saveSystemAgentConfig({
        ...agentConfig,
        api_key: agentApiKey || undefined,
        synthesis: agentConfig.synthesis?.model_name
          ? {
              ...agentConfig.synthesis,
              api_key: synthesisApiKey || undefined,
            }
          : undefined,
      });
      setAgentApiKey(''); // Clear after save
      setSynthesisApiKey('');
      // Reload config to get updated has_api_key
      const updated = await getSystemAgentConfig();
      setAgentConfig(updated);
      toast({
        title: t('settings.systemAgent.saveSuccess'),
        description: t('settings.systemAgent.saveSuccessDescription'),
      });
    } catch (err) {
      console.error('Failed to save system agent config:', err);
      toast({
        title: t('general.error'),
        description: t('settings.systemAgent.saveError'),
        variant: 'destructive',
      });
    } finally {
      setAgentConfigSaving(false);
    }
  };

  // Check if agent provider needs API key
  const agentNeedsApiKey = !['ollama', 'vllm', 'lmstudio'].includes(agentConfig.provider_type);
  // Check if agent provider needs endpoint
  const agentNeedsEndpoint = ['ollama', 'vllm', 'lmstudio'].includes(agentConfig.provider_type);

  // Synthesis (answer) model — optional second model for "Scrapalot AI".
  const synthesisProvider = agentConfig.synthesis?.provider_type || '';
  const synthesisNeedsApiKey = !['ollama', 'vllm', 'lmstudio'].includes(synthesisProvider);
  const synthesisNeedsEndpoint = ['ollama', 'vllm', 'lmstudio'].includes(synthesisProvider);
  // Patch the nested synthesis config, seeding sensible defaults on first edit.
  const patchSynthesis = (patch: Partial<NonNullable<SystemAgentConfig['synthesis']>>) =>
    setAgentConfig(c => ({
      ...c,
      synthesis: {
        provider_type: c.synthesis?.provider_type || 'deepseek',
        model_name: c.synthesis?.model_name || '',
        api_base: c.synthesis?.api_base ?? '',
        has_api_key: c.synthesis?.has_api_key,
        ...patch,
      },
    }));

  // Desktop-specific state
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);
  const [dataDirectory, setDataDirectory] = useState<string | null>(null);

  // Get theme context to apply changes immediately
  const themeContext = useTheme();

  // Load desktop-specific info
  useEffect(() => {
    if (isDesktop && electronAPI) {
      electronAPI.getAppVersion().then(version => {
        setDesktopVersion(version);
      }).catch(err => {
        console.error('Failed to get desktop version:', err);
      });

      electronAPI.getDataDirectory().then(dir => {
        setDataDirectory(dir);
      }).catch(err => {
        console.error('Failed to get data directory:', err);
      });
    }
  }, [isDesktop, electronAPI]);

  // Handle open data folder
  const handleOpenDataFolder = async () => {
    if (isDesktop && dataDirectory && electronAPI) {
      try {
        await electronAPI.openExternal(`file://${dataDirectory}`);
      } catch (error) {
        console.error('Failed to open data folder:', error);
      }
    }
  };

  // Note: Removed automatic synchronization to prevent circular dependency
  // Theme changes are now handled through the settings save process and
  // explicit user actions in handleThemeChange/handleAccentChange

  // Handle theme selection with immediate effect
  const handleThemeChange = (newTheme: 'light' | 'dark' | 'system') => {


    // Update local state
    setAppearance(newTheme);

    // Update the theme provider - this will handle localStorage and backend saving
    if (newTheme !== themeContext.theme) {

      themeContext.setTheme(newTheme);
    }
  };

  // Handle accent color selection with immediate effect and unified storage
  const handleAccentChange = (newColor: string) => {


    // Update local state
    setAccentColor(newColor);

    // Use unified accent color management from storage-utils
    userPrefs.setCurrentAccentColor(newColor).catch(error => {
      console.warn('Failed to set accent color:', error);
    });

    // Update theme provider if needed
    if (
      ['gray', 'blue', 'green', 'red', 'violet', 'orange'].includes(newColor) &&
      newColor !== themeContext.accentColor
    ) {

      themeContext.setAccentColor(newColor as 'gray' | 'blue' | 'green' | 'red' | 'violet' | 'orange');
    }
  };

  const { setFontSize: setGlobalFontSize, setCodeTheme: setGlobalCodeTheme } =
    useFontSettings();

  // Update both local state and global context for font size
  const handleFontSizeChange = (newSize: number) => {
    setFontSize(newSize);
    setGlobalFontSize(newSize);
    localStorage.setItem('fontSize', newSize.toString());
  };

  const handleCodeThemeChange = (newTheme: string) => {
    setCodeTheme(newTheme);
    setGlobalCodeTheme(newTheme);
    localStorage.setItem('codeTheme', newTheme);
  };

  return (
    <>
      <div className='sticky top-0 pt-0 pb-6 z-20' style={{ position: 'sticky' }}>
        <div
          className='absolute inset-0 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-xl -z-10'
          style={{ maskImage: 'linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)' }}
        />
        <div className='flex items-center justify-between'>
          <div>
            <h2 className='text-2xl font-bold text-zinc-900 dark:text-white mb-1'>
              {t('settings.tabs.general')}
            </h2>
            <p className='text-sm text-zinc-500 dark:text-zinc-400'>
              {t('settings.general.description')}
            </p>
          </div>
        </div>
      </div>
      <div className='space-y-6'>

        {/* Theme Settings Header */}
        <h2 className='text-xl font-semibold text-zinc-800 dark:text-white mb-4 hidden md:block'>
          {t('settings.theme.title')}
        </h2>
        <div className='space-y-8'>
          {/* Appearance */}
          <div data-tour="settings-appearance">
            <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-4'>
              {t('settings.appearance.title')}
            </h3>
            <div className='grid grid-cols-3 gap-4'>
              <div
                data-testid="settings-theme-light"
                className={`border rounded-lg p-4 flex flex-col items-center gap-2 cursor-pointer ${themeContext.theme === 'light'
                  ? 'border-zinc-800 dark:border-white'
                  : 'border-zinc-300 dark:border-zinc-700'
                }`}
                onClick={() => handleThemeChange('light')}
              >
                <div className='w-12 h-12 bg-zinc-100 rounded-full flex items-center justify-center'>
                  <Sun className='w-6 h-6 text-zinc-800' />
                </div>
                <span className='text-sm text-zinc-800 dark:text-white'>
                  {t('settings.appearance.light')}
                </span>
              </div>
              <div
                data-testid="settings-theme-dark"
                className={`border rounded-lg p-4 flex flex-col items-center gap-2 cursor-pointer ${themeContext.theme === 'dark'
                  ? 'border-zinc-800 dark:border-white'
                  : 'border-zinc-300 dark:border-zinc-700'
                }`}
                onClick={() => handleThemeChange('dark')}
              >
                <div className='w-12 h-12 bg-zinc-800 rounded-full flex items-center justify-center'>
                  <Moon className='w-6 h-6 text-white' />
                </div>
                <span className='text-sm text-zinc-800 dark:text-white'>
                  {t('settings.appearance.dark')}
                </span>
              </div>
              <div
                data-testid="settings-theme-system"
                className={`border rounded-lg p-4 flex flex-col items-center gap-2 cursor-pointer ${themeContext.theme === 'system'
                  ? 'border-zinc-800 dark:border-white'
                  : 'border-zinc-300 dark:border-zinc-700'
                }`}
                onClick={() => handleThemeChange('system')}
              >
                <div className='w-12 h-12 bg-gradient-to-br from-zinc-100 to-zinc-800 rounded-full flex items-center justify-center'>
                  <Monitor className='w-6 h-6 text-zinc-600' />
                </div>
                <span className='text-sm text-zinc-800 dark:text-white'>
                  {t('settings.appearance.system')}
                </span>
              </div>
            </div>
          </div>

          {/* Accent Color */}
          <div>
            <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-4'>
              {t('settings.accentColor.title')}
            </h3>
            <div className='flex flex-wrap gap-3'>
              {['gray', 'blue', 'green', 'red', 'violet', 'orange'].map(
                color => {
                  const colorMap: Record<string, string> = {
                    gray: 'bg-zinc-800 dark:bg-zinc-200',
                    blue: 'bg-blue-500',
                    green: 'bg-green-500',
                    red: 'bg-red-500',
                    violet: 'bg-purple-500',
                    orange: 'bg-orange-500',
                  };

                  // Check if this color is the active accent color
                  const isActive = themeContext.accentColor === color;

                  return (
                    <button
                      key={color}
                      data-testid={`settings-accent-${color}`}
                      onClick={() => handleAccentChange(color)}
                      className={`w-9 h-9 rounded-full flex items-center justify-center ${isActive
                        ? 'ring-2 ring-zinc-800 dark:ring-white ring-offset-2'
                        : ''
                      }`}
                    >
                      <div
                        className={`w-7 h-7 rounded-full ${colorMap[color]}`}
                      ></div>
                    </button>
                  );
                }
              )}
            </div>
          </div>

          {/* Font Style */}
          <div>
            <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-4'>
              {t('settings.appearance.fontStyle')}
            </h3>
            <div className='grid grid-cols-3 gap-4'>
              <div
                className={`border rounded-lg p-4 flex flex-col items-center gap-2 cursor-pointer ${fontStyle === 'everything-everywhere'
                  ? 'border-zinc-800 dark:border-white'
                  : 'border-zinc-300 dark:border-zinc-700'
                }`}
                onClick={() => setFontStyle('everything-everywhere')}
              >
                <div className='w-10 h-10 flex items-center justify-center'>
                  <Circle className='h-4 w-4 text-zinc-800 dark:text-white' />
                </div>
                <span className='text-sm text-zinc-800 dark:text-white'>
                  {t('settings.fontStyle.everythingEverywhere')}
                </span>
              </div>
              <div
                className={`border rounded-lg p-4 flex flex-col items-center gap-2 cursor-pointer ${fontStyle === 'galaxy-far-away'
                  ? 'border-zinc-800 dark:border-white'
                  : 'border-zinc-300 dark:border-zinc-700'
                }`}
                onClick={() => setFontStyle('galaxy-far-away')}
              >
                <div className='w-10 h-10 flex items-center justify-center'>
                  <svg
                    viewBox='0 0 24 24'
                    className='w-8 h-8 text-zinc-800 dark:text-white'
                    fill='none'
                    stroke='currentColor'
                  >
                    <path
                      d='M12 5L12 19M5 12H19'
                      strokeWidth='2'
                      strokeLinecap='round'
                    />
                  </svg>
                </div>
                <span className='text-sm text-zinc-800 dark:text-white'>
                  {t('settings.fontStyle.galaxyFarAway')}
                </span>
              </div>
              <div
                className={`border rounded-lg p-4 flex flex-col items-center gap-2 cursor-pointer ${fontStyle === 'home-alone'
                  ? 'border-zinc-800 dark:border-white'
                  : 'border-zinc-300 dark:border-zinc-700'
                }`}
                onClick={() => setFontStyle('home-alone')}
              >
                <div className='w-10 h-10 flex items-center justify-center'>
                  <svg
                    viewBox='0 0 24 24'
                    className='w-8 h-8 text-zinc-800 dark:text-white'
                    fill='none'
                    stroke='currentColor'
                  >
                    <circle cx='12' cy='12' r='8' strokeWidth='2' />
                    <circle cx='12' cy='12' r='3' strokeWidth='2' />
                  </svg>
                </div>
                <span className='text-sm text-zinc-800 dark:text-white'>
                  {t('settings.fontStyle.homeAlone')}
                </span>
              </div>
            </div>
          </div>

          {/* Code Theme */}
          <div>
            <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-4'>
              {t('settings.codeTheme.title')}
            </h3>
            <Select
              value={codeTheme || 'GitHub'}
              onValueChange={value => handleCodeThemeChange(value)}
            >
              <SelectTrigger className={`border-zinc-300 dark:border-zinc-700 ${isMobile ? 'w-full h-9 text-sm' : 'w-[180px] h-10'}`}>
                <SelectValue defaultValue='GitHub' />
              </SelectTrigger>
              <SelectContent className='z-[1100]'>
                <SelectItem value='Dark'>
                  {t('settings.codeTheme.dark')}
                </SelectItem>
                <SelectItem value='Light'>
                  {t('settings.codeTheme.light')}
                </SelectItem>
                <SelectItem value='GitHub'>
                  {t('settings.codeTheme.github')}
                </SelectItem>
                <SelectItem value='Monokai'>
                  {t('settings.codeTheme.monokai')}
                </SelectItem>
                <SelectItem value='Dracula'>
                  {t('settings.codeTheme.dracula')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Font Size */}
          <div>
            <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-4'>
              {t('settings.fontSize.title')}
            </h3>
            <div className='flex items-center gap-4'>
              <Button
                data-testid="settings-font-size-decrease"
                variant='outline'
                className='border-zinc-300 dark:border-zinc-700 h-8 w-8 p-0'
                onClick={() => handleFontSizeChange(Math.max(12, fontSize - 1))}
              >
                -
              </Button>
              <span data-testid="settings-font-size-value" className='text-zinc-800 dark:text-white min-w-[30px] text-center'>
                {fontSize}px
              </span>
              <Button
                data-testid="settings-font-size-increase"
                variant='outline'
                className='border-zinc-300 dark:border-zinc-700 h-8 w-8 p-0'
                onClick={() => handleFontSizeChange(Math.min(18, fontSize + 1))}
              >
                +
              </Button>
              <div className='ml-4 flex-1 h-1 bg-zinc-200 dark:bg-zinc-700 rounded-full'>
                <div
                  className='h-full bg-zinc-800 dark:bg-white rounded-full'
                  style={{ width: `${((fontSize - 12) / 6) * 100}%` }}
                ></div>
              </div>
            </div>
          </div>
        </div>

        {/* Rendering Modules */}
        <div>
          <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-3'>
            {t('settings.renderingModules.title')}
          </h3>
          <p className='text-sm text-zinc-600 dark:text-zinc-400 mb-4'>
            {t('settings.renderingModules.description')}
          </p>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant='outline' className='w-full justify-between'>
                <span>Rendering Modules</span>
                <ChevronDown className='h-4 w-4 opacity-50' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className='w-full min-w-[240px] z-[1100]'>
              <DropdownMenuCheckboxItem
                checked={renderingModules.includes('MARKDOWN')}
                onCheckedChange={checked => {
                  if (checked) {
                    setRenderingModules([
                      ...renderingModules.filter(m => m !== 'MARKDOWN'),
                      'MARKDOWN',
                    ]);
                  } else {
                    // Prevent removing all items
                    if (renderingModules.length > 1) {
                      setRenderingModules(
                        renderingModules.filter(m => m !== 'MARKDOWN')
                      );
                    }
                  }
                }}
              >
                {t('settings.renderingModules.markdown')}
              </DropdownMenuCheckboxItem>

              <DropdownMenuSeparator />

              <DropdownMenuLabel className='font-normal'>
                <div className='pl-6 py-1.5'>
                  <div>Mermaid Diagrams</div>
                </div>
              </DropdownMenuLabel>

              <DropdownMenuLabel className='font-normal'>
                <div className='pl-6 py-1.5'>
                  <div>Math LaTeX</div>
                </div>
              </DropdownMenuLabel>

              <DropdownMenuSeparator />

              <DropdownMenuCheckboxItem
                checked={renderingModules.includes('GITHUB_MARKDOWN')}
                onCheckedChange={checked => {
                  if (checked) {
                    setRenderingModules([
                      ...renderingModules.filter(m => m !== 'GITHUB_MARKDOWN'),
                      'GITHUB_MARKDOWN',
                    ]);
                  } else {
                    if (renderingModules.length > 1) {
                      setRenderingModules(
                        renderingModules.filter(m => m !== 'GITHUB_MARKDOWN')
                      );
                    }
                  }
                }}
              >
                {t('settings.renderingModules.githubMarkdown')}
              </DropdownMenuCheckboxItem>

              <DropdownMenuCheckboxItem
                checked={renderingModules.includes('CODE_HIGHLIGHTING')}
                onCheckedChange={checked => {
                  if (checked) {
                    setRenderingModules([
                      ...renderingModules.filter(
                        m => m !== 'CODE_HIGHLIGHTING'
                      ),
                      'CODE_HIGHLIGHTING',
                    ]);
                  } else {
                    if (renderingModules.length > 1) {
                      setRenderingModules(
                        renderingModules.filter(m => m !== 'CODE_HIGHLIGHTING')
                      );
                    }
                  }
                }}
              >
                {t('settings.renderingModules.codeHighlighting')}
              </DropdownMenuCheckboxItem>

              <DropdownMenuCheckboxItem
                checked={renderingModules.includes('COLLAPSE_TAGS')}
                onCheckedChange={checked => {
                  if (checked) {
                    setRenderingModules([
                      ...renderingModules.filter(m => m !== 'COLLAPSE_TAGS'),
                      'COLLAPSE_TAGS',
                    ]);
                  } else {
                    if (renderingModules.length > 1) {
                      setRenderingModules(
                        renderingModules.filter(m => m !== 'COLLAPSE_TAGS')
                      );
                    }
                  }
                }}
              >
                {t('settings.renderingModules.collapsingTags')}
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Enable Links */}
        <div className='flex justify-between items-center'>
          <div>
            <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-2'>
              {t('settings.enableLinks.title')}
            </h3>
            <p className='text-sm text-zinc-600 dark:text-zinc-400'>
              {t('settings.enableLinks.description')}
            </p>
          </div>
          <Switch checked={enableLinks} onCheckedChange={setEnableLinks} />
        </div>

        {/* Language & Region Card */}
        <div data-tour="settings-language" className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-start gap-3 mb-5'>
            <div className='w-10 h-10 flex items-center justify-center mt-1'>
              <BrainCircuit className='w-5 h-5 text-blue-600 dark:text-blue-400' />
            </div>
            <div className='flex-1'>
              <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                {t('settings.language.title')}
              </h3>
              <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                {t('settings.language.description')}
              </p>
            </div>
          </div>
          <div className='pl-13'>
            <Select
              value={language || 'en'}
              onValueChange={value => {
                setLanguage(value);
              }}
            >
              <SelectTrigger data-testid="settings-language-select" className={`w-full max-w-xs border-zinc-300 dark:border-zinc-700 hover:border-blue-500 dark:hover:border-blue-500 transition-colors ${isMobile ? 'h-9 text-sm' : 'h-11'}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className='z-[1100]'>
                <SelectItem value='en'>
                  {t('settings.language.english')}
                </SelectItem>
                <SelectItem value='es'>
                  {t('settings.language.spanish')}
                </SelectItem>
                <SelectItem value='fr'>
                  {t('settings.language.french')}
                </SelectItem>
                <SelectItem value='de'>
                  {t('settings.language.german')}
                </SelectItem>
                <SelectItem value='hr'>
                  {t('settings.language.croatian')}
                </SelectItem>
                <SelectItem value='mk'>
                  {t('settings.language.macedonian')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Reasoning Model Indicators Card */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-center justify-between gap-4 mb-5'>
            <div className='flex items-start gap-3'>
              <div className='w-10 h-10 flex items-center justify-center mt-1'>
                <BrainCircuit className='w-5 h-5 text-amber-600 dark:text-amber-400' />
              </div>
              <div className='flex-1'>
                <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                  {t('settings.reasoningIndicators.title')}
                </h3>
                <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                  {t('settings.reasoningIndicators.description')}
                </p>
              </div>
            </div>
            <Switch
              data-testid="settings-reasoning-toggle"
              checked={showReasoningIndicators}
              onCheckedChange={setShowReasoningIndicators}
            />
          </div>

          <div className='pl-13 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 border border-amber-200 dark:border-amber-800/50 rounded-lg p-4'>
            <div className='flex items-start gap-3'>
              <BrainCircuit className='h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5' />
              <div>
                <h4 className='text-sm font-semibold text-amber-900 dark:text-amber-200 mb-1'>
                  {t('settings.reasoningIndicators.reasoningModels')}
                </h4>
                <p className='text-xs text-amber-700 dark:text-amber-300/90'>
                  {t('settings.reasoningIndicators.reasoningDescription')}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Simple Mode card. Always visible so users
            can opt in/out. Toggling propagates to localStorage via
            useSimpleMode's setter for instant cross-component pickup. */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-center justify-between gap-4'>
            <div className='flex items-start gap-3'>
              <div className='w-10 h-10 flex items-center justify-center mt-1'>
                <Sparkles className='w-5 h-5 text-emerald-600 dark:text-emerald-400' />
              </div>
              <div className='flex-1'>
                <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                  {t('settings.general.simpleMode.title', 'Simple mode')}
                </h3>
                <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                  {t('settings.general.simpleMode.description', 'Hide advanced controls (RAG strategy, orchestrator, agentic routing, RAG tracing). The chat input and citations remain. Enable for a calmer interface; disable to surface every knob.')}
                </p>
              </div>
            </div>
            <Switch
              data-testid='settings-simple-mode-toggle'
              checked={simpleModeEnabled}
              onCheckedChange={setSimpleModeEnabled}
            />
          </div>
        </div>

        {/* Message notifications — prominent toast vs bell-only, and sound. */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm space-y-4'>
          <div className='flex items-center justify-between gap-4'>
            <div className='flex items-start gap-3'>
              <div className='w-10 h-10 flex items-center justify-center mt-1'>
                <Bell className='w-5 h-5 text-blue-600 dark:text-blue-400' />
              </div>
              <div className='flex-1'>
                <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                  {t('settings.general.messageNotifications.toastTitle', 'Prominent message popups')}
                </h3>
                <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                  {t('settings.general.messageNotifications.toastDescription', 'Show a popup in the top-right when you get a message from an admin. Turn off to receive it quietly in the bell only.')}
                </p>
              </div>
            </div>
            <Switch
              data-testid='settings-admin-toast-toggle'
              checked={adminToastEnabled}
              onCheckedChange={handleAdminToastToggle}
            />
          </div>
          <div className='flex items-center justify-between gap-4'>
            <div className='flex items-start gap-3'>
              <div className='w-10 h-10 flex items-center justify-center mt-1'>
                <Volume2 className='w-5 h-5 text-emerald-600 dark:text-emerald-400' />
              </div>
              <div className='flex-1'>
                <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                  {t('settings.general.messageNotifications.soundTitle', 'Notification sound')}
                </h3>
                <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                  {t('settings.general.messageNotifications.soundDescription', 'Play a sound when a new message arrives.')}
                </p>
              </div>
            </div>
            <Switch
              data-testid='settings-notification-sound-toggle'
              checked={isSoundEnabled}
              onCheckedChange={toggleSound}
            />
          </div>
        </div>

        {/* RAG Tracing — hidden in simple mode */}
        {!simpleModeEnabled && (
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-center justify-between gap-4'>
            <div className='flex items-start gap-3'>
              <div className='w-10 h-10 flex items-center justify-center mt-1'>
                <Activity className='w-5 h-5 text-green-600 dark:text-green-400' />
              </div>
              <div className='flex-1'>
                <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                  {t('settings.general.ragTracing')}
                </h3>
                <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                  {t('settings.general.ragTracingDescription')}
                </p>
              </div>
            </div>
            <Switch
              data-testid="settings-rag-tracing-toggle"
              checked={ragTracingEnabled}
              onCheckedChange={setRagTracingEnabled}
            />
          </div>
        </div>
        )}

        {/* Knowledge Agent profile picker. v1 = 4 system
            profiles + 'None'. Picking one biases chat answers via the
            layered system prompt (layer 2). */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-start gap-3 mb-4'>
            <div className='w-10 h-10 flex items-center justify-center mt-1'>
              <BrainCircuit className='w-5 h-5 text-indigo-600 dark:text-indigo-400' />
            </div>
            <div className='flex-1'>
              <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                {t('settings.general.agentProfile.title', 'Knowledge agent profile')}
              </h3>
              <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                {t('settings.general.agentProfile.description', 'Bias every chat toward a domain — citation style, tone, evidence hierarchy. Pick None to keep the default behavior.')}
              </p>
            </div>
          </div>
          <div className='pl-13'>
            <Select
              value={defaultAgentProfileSlug || '__none__'}
              onValueChange={(v) => setDefaultAgentProfileSlug(v === '__none__' ? '' : v)}
            >
              <SelectTrigger
                data-testid='settings-agent-profile'
                className='w-full max-w-xs border-zinc-300 dark:border-zinc-700 text-left'
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className='z-[1100]'>
                <SelectItem value='__none__'>
                  <span className='font-medium'>{t('settings.general.agentProfile.none', 'None — default behavior')}</span>
                </SelectItem>
                <SelectItem value='legal'>
                  <span className='font-medium'>⚖️ {t('settings.general.agentProfile.legal', 'Legal')}</span>
                </SelectItem>
                <SelectItem value='medical'>
                  <span className='font-medium'>⚕️ {t('settings.general.agentProfile.medical', 'Medical')}</span>
                </SelectItem>
                <SelectItem value='academic'>
                  <span className='font-medium'>🎓 {t('settings.general.agentProfile.academic', 'Academic')}</span>
                </SelectItem>
                <SelectItem value='technical'>
                  <span className='font-medium'>🛠 {t('settings.general.agentProfile.technical', 'Technical')}</span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Response Length */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-start gap-3 mb-4'>
            <div className='w-10 h-10 flex items-center justify-center mt-1'>
              <MessageSquare className='w-5 h-5 text-sky-600 dark:text-sky-400' />
            </div>
            <div className='flex-1'>
              <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                {t('settings.general.responseLength.title')}
              </h3>
              <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                {t('settings.general.responseLength.description')}
              </p>
            </div>
          </div>
          <div className='pl-13'>
            <Select
              value={responseLength}
              onValueChange={(v) => setResponseLength(v as 'short' | 'medium' | 'long')}
            >
              <SelectTrigger
                data-testid='settings-response-length'
                className='w-full max-w-xs border-zinc-300 dark:border-zinc-700 text-left'
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className='z-[1100]'>
                <SelectItem value='short'>
                  <div className='flex flex-col'>
                    <span className='font-medium'>{t('settings.general.responseLength.short')}</span>
                    <span className='text-xs text-muted-foreground'>{t('settings.general.responseLength.shortHint')}</span>
                  </div>
                </SelectItem>
                <SelectItem value='medium'>
                  <div className='flex flex-col'>
                    <span className='font-medium'>{t('settings.general.responseLength.medium')}</span>
                    <span className='text-xs text-muted-foreground'>{t('settings.general.responseLength.mediumHint')}</span>
                  </div>
                </SelectItem>
                <SelectItem value='long'>
                  <div className='flex flex-col'>
                    <span className='font-medium'>{t('settings.general.responseLength.long')}</span>
                    <span className='text-xs text-muted-foreground'>{t('settings.general.responseLength.longHint')}</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Response Personalization (formality + domain focus) */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-start gap-3 mb-4'>
            <div className='w-10 h-10 flex items-center justify-center mt-1'>
              <MessageSquare className='w-5 h-5 text-violet-600 dark:text-violet-400' />
            </div>
            <div className='flex-1'>
              <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                {t('settings.general.responseStyle.title', 'Response style')}
              </h3>
              <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                {t('settings.general.responseStyle.description', 'How AI answers should feel — tone and the domain to frame examples in. Length is set above.')}
              </p>
            </div>
          </div>
          <div className='pl-13 space-y-4'>
            <div className='space-y-2'>
              <label className='text-xs font-medium text-zinc-700 dark:text-zinc-300 block'>
                {t('settings.general.responseStyle.formalityLabel', 'Formality')}
              </label>
              <Select
                value={responseFormality}
                onValueChange={(v) => setResponseFormality(v as 'casual' | 'neutral' | 'academic')}
              >
                <SelectTrigger
                  data-testid='settings-response-formality'
                  className='w-full max-w-xs border-zinc-300 dark:border-zinc-700 text-left'
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className='z-[1100]'>
                  <SelectItem value='casual'>
                    <div className='flex flex-col'>
                      <span className='font-medium'>{t('settings.general.responseStyle.casual', 'Casual')}</span>
                      <span className='text-xs text-muted-foreground'>{t('settings.general.responseStyle.casualHint', 'Conversational tone, contractions, plain language.')}</span>
                    </div>
                  </SelectItem>
                  <SelectItem value='neutral'>
                    <div className='flex flex-col'>
                      <span className='font-medium'>{t('settings.general.responseStyle.neutral', 'Neutral')}</span>
                      <span className='text-xs text-muted-foreground'>{t('settings.general.responseStyle.neutralHint', 'Clear, factual, neither casual nor stiff.')}</span>
                    </div>
                  </SelectItem>
                  <SelectItem value='academic'>
                    <div className='flex flex-col'>
                      <span className='font-medium'>{t('settings.general.responseStyle.academic', 'Academic')}</span>
                      <span className='text-xs text-muted-foreground'>{t('settings.general.responseStyle.academicHint', 'Precise terminology, formal phrasing, hedge claims.')}</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-2'>
              <label className='text-xs font-medium text-zinc-700 dark:text-zinc-300 block'>
                {t('settings.general.responseStyle.domainFocusLabel', 'Domain focus')}
              </label>
              {/*
                NoAutofillInput: Chrome aggressively autofills any single text
                input on a long settings page with the user's email — found
                'admin@test.com' silently saved as domain_focus in prod. The
                attribute hints alone do NOT stop Chrome's native profile
                autofill; the readonly-until-focus guard inside the component does.
              */}
              <NoAutofillInput
                data-testid='settings-response-domain-focus'
                name='response-domain-focus'
                value={responseDomainFocus}
                onChange={(e) => setResponseDomainFocus(e.target.value.slice(0, 100))}
                maxLength={100}
                placeholder={t('settings.general.responseStyle.domainFocusPlaceholder', 'e.g. machine learning, Croatian legal practice') || ''}
                className='max-w-md text-sm'
              />
              <div className='flex items-center justify-between'>
                <p className='text-[11px] text-zinc-500 dark:text-zinc-400'>
                  {t('settings.general.responseStyle.domainFocusHint', 'Frames examples and analogies in this domain when possible. Optional.')}
                </p>
                <span className='text-[11px] text-zinc-500 dark:text-zinc-400'>
                  {responseDomainFocus.length} / 100
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* System Agent Configuration (Admin Only) */}
        {isAdmin && (
          <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
            <div className='flex items-start gap-3 mb-5'>
              <div className='w-10 h-10 flex items-center justify-center mt-1'>
                <BrainCircuit className='w-5 h-5 text-violet-600 dark:text-violet-400' />
              </div>
              <div className='flex-1'>
                <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                  {t('settings.systemAgent.title')}
                </h3>
                <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                  {t('settings.systemAgent.description')}
                </p>
              </div>
            </div>

            {agentConfigLoading ? (
              <div className='pl-13 text-sm text-zinc-500'>{t('general.loading')}...</div>
            ) : (
              <div className='pl-13 space-y-4'>
                {/* Provider Selection */}
                <div>
                  <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block'>
                    {t('settings.systemAgent.provider')}
                  </label>
                  <Select
                    value={agentConfig.provider_type}
                    onValueChange={value => {
                      const newConfig = { ...agentConfig, provider_type: value };
                      // Set default api_base for local providers
                      if (value === 'ollama') newConfig.api_base = 'http://localhost:11434';
                      else if (value === 'lmstudio') newConfig.api_base = 'http://localhost:1234/v1';
                      else if (value === 'vllm') newConfig.api_base = '';
                      else newConfig.api_base = '';
                      setAgentConfig(newConfig);
                    }}
                  >
                    <SelectTrigger className='w-full max-w-xs border-zinc-300 dark:border-zinc-700'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className='z-[1100]'>
                      <SelectItem value='openai'>OpenAI</SelectItem>
                      <SelectItem value='anthropic'>Anthropic (Claude)</SelectItem>
                      <SelectItem value='google'>Google (Gemini)</SelectItem>
                      <SelectItem value='ollama'>Ollama</SelectItem>
                      <SelectItem value='vllm'>vLLM</SelectItem>
                      <SelectItem value='lmstudio'>LM Studio</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Model Name */}
                <div>
                  <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block'>
                    {t('settings.systemAgent.modelName')}
                  </label>
                  <Input
                    value={agentConfig.model_name}
                    onChange={e => setAgentConfig({ ...agentConfig, model_name: e.target.value })}
                    placeholder={agentConfig.provider_type === 'anthropic' ? 'claude-sonnet-4-6-20260301' : 'gpt-4o-mini'}
                    className='w-full max-w-xs border-zinc-300 dark:border-zinc-700'
                  />
                </div>

                {/* API Key (for cloud providers) */}
                {agentNeedsApiKey && (
                  <div>
                    <div className='flex items-center gap-2 mb-1.5'>
                      <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300'>
                        {t('settings.systemAgent.apiKey')}
                      </label>
                      {agentConfig.has_api_key ? (
                        <span className='inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 border border-green-300 dark:border-green-700'>
                          ✓ {t('settings.systemAgent.keyConfigured', 'Key configured')}
                        </span>
                      ) : (
                        <span className='inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-700'>
                          ⚠ {t('settings.systemAgent.keyNotSet', 'Not set')}
                        </span>
                      )}
                    </div>
                    <div className='flex items-center gap-2 max-w-xs'>
                      <Input
                        type='password'
                        value={agentApiKey}
                        onChange={e => setAgentApiKey(e.target.value)}
                        placeholder={agentConfig.has_api_key ? '••••••••' : t('settings.systemAgent.apiKeyPlaceholder')}
                        className='flex-1 border-zinc-300 dark:border-zinc-700'
                      />
                    </div>
                  </div>
                )}

                {/* API Base (for local providers) */}
                {agentNeedsEndpoint && (
                  <div>
                    <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block'>
                      {t('settings.systemAgent.endpoint')}
                    </label>
                    <Input
                      value={agentConfig.api_base || ''}
                      onChange={e => setAgentConfig({ ...agentConfig, api_base: e.target.value })}
                      placeholder='http://localhost:11434'
                      className='w-full max-w-xs border-zinc-300 dark:border-zinc-700'
                    />
                  </div>
                )}

                {/* Info box */}
                <div className='p-3 bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800/50 text-sm text-violet-700 dark:text-violet-300'>
                  <p>{t('settings.systemAgent.info')}</p>
                </div>

                {/* Synthesis (answer) model — optional second model */}
                <div className='pt-4 mt-2 border-t border-zinc-200 dark:border-zinc-800 space-y-4'>
                  <div>
                    <h4 className='text-sm font-semibold text-zinc-800 dark:text-zinc-200'>
                      {t('settings.systemAgent.synthesis.title')}
                    </h4>
                    <p className='text-xs text-zinc-500 dark:text-zinc-400 mt-0.5'>
                      {t('settings.systemAgent.synthesis.description')}
                    </p>
                  </div>

                  {/* Synthesis provider */}
                  <div>
                    <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block'>
                      {t('settings.systemAgent.provider')}
                    </label>
                    <Select
                      value={synthesisProvider || 'deepseek'}
                      onValueChange={value => {
                        let base = '';
                        if (value === 'deepseek') base = 'https://api.deepseek.com';
                        else if (value === 'ollama') base = 'http://localhost:11434';
                        else if (value === 'lmstudio') base = 'http://localhost:1234/v1';
                        patchSynthesis({ provider_type: value, api_base: base });
                      }}
                    >
                      <SelectTrigger className='w-full max-w-xs border-zinc-300 dark:border-zinc-700'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className='z-[1100]'>
                        <SelectItem value='deepseek'>DeepSeek</SelectItem>
                        <SelectItem value='openai'>OpenAI</SelectItem>
                        <SelectItem value='anthropic'>Anthropic (Claude)</SelectItem>
                        <SelectItem value='google'>Google (Gemini)</SelectItem>
                        <SelectItem value='ollama'>Ollama</SelectItem>
                        <SelectItem value='vllm'>vLLM</SelectItem>
                        <SelectItem value='lmstudio'>LM Studio</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Synthesis model name */}
                  <div>
                    <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block'>
                      {t('settings.systemAgent.modelName')}
                    </label>
                    <Input
                      value={agentConfig.synthesis?.model_name || ''}
                      onChange={e => patchSynthesis({ model_name: e.target.value })}
                      placeholder={synthesisProvider === 'deepseek' ? 'deepseek-v4-flash' : 'gpt-4o-mini'}
                      className='w-full max-w-xs border-zinc-300 dark:border-zinc-700'
                    />
                    <p className='text-xs text-zinc-500 dark:text-zinc-400 mt-1'>
                      {t('settings.systemAgent.synthesis.modelHint')}
                    </p>
                  </div>

                  {/* Synthesis API key */}
                  {synthesisNeedsApiKey && (
                    <div>
                      <div className='flex items-center gap-2 mb-1.5'>
                        <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300'>
                          {t('settings.systemAgent.apiKey')}
                        </label>
                        {agentConfig.synthesis?.has_api_key ? (
                          <span className='inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 border border-green-300 dark:border-green-700'>
                            ✓ {t('settings.systemAgent.keyConfigured', 'Key configured')}
                          </span>
                        ) : (
                          <span className='inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-700'>
                            ⚠ {t('settings.systemAgent.keyNotSet', 'Not set')}
                          </span>
                        )}
                      </div>
                      <div className='flex items-center gap-2 max-w-xs'>
                        <Input
                          type='password'
                          value={synthesisApiKey}
                          onChange={e => setSynthesisApiKey(e.target.value)}
                          placeholder={agentConfig.synthesis?.has_api_key ? '••••••••' : t('settings.systemAgent.apiKeyPlaceholder')}
                          className='flex-1 border-zinc-300 dark:border-zinc-700'
                        />
                      </div>
                    </div>
                  )}

                  {/* Synthesis endpoint (local providers) */}
                  {synthesisNeedsEndpoint && (
                    <div>
                      <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block'>
                        {t('settings.systemAgent.endpoint')}
                      </label>
                      <Input
                        value={agentConfig.synthesis?.api_base || ''}
                        onChange={e => patchSynthesis({ api_base: e.target.value })}
                        placeholder='http://localhost:11434'
                        className='w-full max-w-xs border-zinc-300 dark:border-zinc-700'
                      />
                    </div>
                  )}
                </div>

                {/* Save button */}
                <Button
                  onClick={handleSaveAgentConfig}
                  disabled={agentConfigSaving || !agentConfig.model_name}
                  className='bg-primary text-primary-foreground'
                >
                  {agentConfigSaving ? t('general.saving') : t('settings.systemAgent.save')}
                </Button>
              </div>
            )}
          </div>
        )}


        {/* Application Info Section - Only show for desktop app */}
        {typeof window !== 'undefined' &&
          window.location.protocol === 'file:' && (
            <>
              <h2 className='text-xl font-semibold text-zinc-800 dark:text-white mb-4 hidden md:block'>
                {t('settings.applicationInfo.title')}
              </h2>

              {/* App Version */}
              <div className='space-y-2 mb-6'>
                <div className='flex justify-between items-center'>
                  <div>
                    <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-1'>
                      {t('settings.applicationInfo.appVersion.title')}
                    </h3>
                    <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                      {t('settings.applicationInfo.appVersion.description')}
                    </p>
                  </div>
                  <Button
                    variant='outline'
                    size='sm'
                    className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-white'
                  >
                    <Download className='h-4 w-4 mr-2' />
                    {t('settings.applicationInfo.appVersion.checkForUpdates')}
                  </Button>
                </div>
                <div className='flex items-center justify-between'>
                  <div className='flex items-center gap-2'>
                    <span className='text-sm font-medium text-zinc-800 dark:text-white'>
                      {t('settings.applicationInfo.appVersion.version')}:
                    </span>
                    <span className='text-sm text-zinc-600 dark:text-zinc-400'>
                      {isDesktop && desktopVersion ? desktopVersion : '1.8.1'}
                    </span>
                    {isDesktop && (
                      <span className='inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'>
                        <HardDrive className='h-3 w-3' />
                        Desktop
                      </span>
                    )}
                    <Button
                      variant='link'
                      size='sm'
                      className='p-0 h-auto text-zinc-600 dark:text-zinc-400 underline'
                    >
                      {t('settings.applicationInfo.appVersion.viewChangelog')}
                    </Button>
                  </div>
                  <div className='flex items-center gap-2'>
                    <Switch checked={true} onCheckedChange={() => { }} />
                    <span className='text-sm text-zinc-700 dark:text-zinc-300'>
                      {t(
                        'settings.applicationInfo.appVersion.enableAutoUpdates'
                      )}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}

        {/* App Settings */}
        <div className='space-y-2 mb-6'>
          <div className='flex justify-between items-center'>
            <div>
              <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-1'>
                {t('settings.applicationInfo.appSettings.title')}
              </h3>
              <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                {t('settings.applicationInfo.appSettings.description')}
              </p>
            </div>
            <Button
              variant='outline'
              size='sm'
              className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-white'
            >
              <SettingsIcon className='h-4 w-4 mr-2' />
              {t('settings.applicationInfo.appSettings.resetAppSettings')}
            </Button>
          </div>
        </div>

        {/* Desktop Data Folder (Desktop Mode Only) */}
        {isDesktop && (
          <div className='space-y-2 mb-6'>
            <div className='flex justify-between items-center'>
              <div>
                <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-1'>
                  Data Folder
                </h3>
                <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                  Access your local Scrapalot data directory containing documents, database, and AI models.
                </p>
                {dataDirectory && (
                  <p className='text-xs font-mono text-zinc-500 dark:text-zinc-500 mt-1'>
                    {dataDirectory}
                  </p>
                )}
              </div>
              <Button
                variant='outline'
                size='sm'
                className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-white'
                onClick={handleOpenDataFolder}
                disabled={!dataDirectory}
              >
                <FolderOpen className='h-4 w-4 mr-2' />
                Open Folder
              </Button>
            </div>
          </div>
        )}

        {/* Help & Discussions */}
        <div className='space-y-2 mb-6'>
          <div className='flex justify-between items-center'>
            <div>
              <h3 className='text-base font-medium text-zinc-800 dark:text-white mb-1'>
                {t('settings.applicationInfo.helpAndDiscussions.title')}
              </h3>
              <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                {t('settings.applicationInfo.helpAndDiscussions.description')}
              </p>
            </div>
            <Button
              variant='outline'
              size='sm'
              className='border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-white'
            >
              {t('settings.applicationInfo.helpAndDiscussions.sayHi')}
            </Button>
          </div>
          <div>
            <Button
              variant='link'
              size='sm'
              className='p-0 h-auto text-zinc-600 dark:text-zinc-400 underline'
              onClick={() =>
                window.open(
                  'https://docs.scrapalot.app',
                  '_blank'
                )
              }
            >
              {t('settings.applicationInfo.helpAndDiscussions.viewDocs')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
};
