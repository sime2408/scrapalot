import React, { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PlusCircle, Edit, Trash2, Copy, FlaskConical, BookOpen, Briefcase, Cpu, Sparkles, MessageSquare, X } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  getPromptTemplates,
  getResearchTemplates,
  saveResearchTemplates,
  ResearchTemplate,
  DEFAULT_RESEARCH_TEMPLATES,
  getAdminDefaultSystemPrompt,
  saveAdminDefaultSystemPrompt,
} from '@/lib/api-settings';
import { toast } from '@/lib/toast-compat';
import { useAdminCheck } from '@/hooks/use-admin-check';
import CodeMirror from '@uiw/react-codemirror';
import { yaml as yamlLang } from '@codemirror/lang-yaml';
import { githubLight, githubDark } from '@uiw/codemirror-theme-github';
import { useTheme } from '@/providers/theme-provider';
import { SETTINGS_Z_INDEX } from './settings-z-index';

interface FewShotExample {
  input: string;
  output: string;
}

interface SettingsPromptsTabProps {
  // defaultSystemPrompt and defaultTemplate are legacy per-user fields
  // that the parent still passes for backward compat. They are no
  // longer rendered: the global system prompt now lives in Python's
  // server_settings (admin-only, Layer 1 of the layered builder), and
  // "Default Message Template" was redundant with it (option c3).
  defaultSystemPrompt: string;
  setDefaultSystemPrompt: (value: string) => void;
  defaultTemplate: string;
  setDefaultTemplate: (value: string) => void;
  customTemplates: { name: string; content: string; examples?: FewShotExample[] }[];
  addCustomTemplate: (name: string, content: string, examples?: FewShotExample[]) => void;
  updateCustomTemplate: (index: number, name: string, content: string, examples?: FewShotExample[]) => void;
  deleteCustomTemplate: (index: number) => void;
  isMobile: boolean;
}

export const SettingsPromptsTab: React.FC<SettingsPromptsTabProps> = ({
  defaultSystemPrompt: _defaultSystemPromptUnused,
  setDefaultSystemPrompt: _setDefaultSystemPromptUnused,
  defaultTemplate: _defaultTemplateUnused,
  setDefaultTemplate: _setDefaultTemplateUnused,
  customTemplates,
  addCustomTemplate,
  updateCustomTemplate,
  deleteCustomTemplate,
  isMobile: _isMobile,
}) => {
  const { t } = useTranslation();
  const isAdmin = useAdminCheck();

  // Theme — drives the CodeMirror editor's color scheme so it matches
  // the rest of the settings panel in light / dark / system mode.
  const { theme: themeMode } = useTheme();
  const isDarkEditor =
    themeMode === 'dark' ||
    (themeMode === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  // Placeholder body shown when the admin hasn't yet saved a prompt.
  // YAML-shaped on purpose: the syntax highlighter has something to
  // colorize even on a fresh install, and it serves as a hint for
  // the structure admins typically use (role + style + safety + tone).
  const adminPromptPlaceholder = `# Layer 1 — admin global system prompt
# Saved to server_settings(setting_key='admin_default_system_prompt').
# Applies to every chat, every user. Edit and it auto-saves.

role: |
  You are Scrapalot, a research-focused assistant.

style:
  citations: required
  hedge_uncertainty: true
  language: match_user

safety:
  - "Refuse harmful or illegal content."
  - "Stay in scope of the loaded collections."
`;

  // Admin global system prompt (Layer 1 of Python's system_prompt_builder).
  // Stored in server_settings(setting_key='admin_default_system_prompt')
  // — system-wide, applies to every user's chat. Editable by admins only.
  // Save-on-change (debounced ~1.2s after last keystroke) — no explicit
  // save button. The original ref keeps the last persisted body so we
  // don't fire a save during the initial load or for no-op edits.
  const [adminDefaultSystemPrompt, setAdminDefaultSystemPrompt] = useState('');
  const [adminPromptLoading, setAdminPromptLoading] = useState(true);
  const [adminPromptSaveState, setAdminPromptSaveState] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const lastPersistedAdminPromptRef = useRef('');
  const adminPromptDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isAdmin) {
      setAdminPromptLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await getAdminDefaultSystemPrompt();
        if (!cancelled) {
          setAdminDefaultSystemPrompt(data.prompt);
          lastPersistedAdminPromptRef.current = data.prompt;
        }
      } finally {
        if (!cancelled) setAdminPromptLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  // Save-on-change. Debounce 1.2s after last keystroke — long enough
  // to feel automatic without spamming the backend, short enough that
  // the user sees their save indicator within ~2s of stopping.
  useEffect(() => {
    if (!isAdmin || adminPromptLoading) return;
    if (adminDefaultSystemPrompt === lastPersistedAdminPromptRef.current) return;

    if (adminPromptDebounceRef.current) {
      clearTimeout(adminPromptDebounceRef.current);
    }
    adminPromptDebounceRef.current = setTimeout(() => {
      void (async () => {
        setAdminPromptSaveState('saving');
        try {
          await saveAdminDefaultSystemPrompt(adminDefaultSystemPrompt);
          lastPersistedAdminPromptRef.current = adminDefaultSystemPrompt;
          setAdminPromptSaveState('saved');
          // Drop back to idle after a moment so the indicator doesn't
          // sit there forever.
          setTimeout(() => setAdminPromptSaveState('idle'), 1500);
        } catch (error) {
          console.error('Error saving admin system prompt:', error);
          setAdminPromptSaveState('error');
          toast.error(
            t('settings.prompts.adminSystemPrompt.saveFailed', 'Failed to save')
          );
        }
      })();
    }, 1200);

    return () => {
      if (adminPromptDebounceRef.current) {
        clearTimeout(adminPromptDebounceRef.current);
      }
    };
  }, [adminDefaultSystemPrompt, isAdmin, adminPromptLoading, t]);
  const [isAddPromptOpen, setIsAddPromptOpen] = useState(false);
  const [newPromptName, setNewPromptName] = useState('');
  const [newPromptContent, setNewPromptContent] = useState('');
  const [newPromptExamples, setNewPromptExamples] = useState<FewShotExample[]>([]);
  const [editingPrompt, setEditingPrompt] = useState<{
    index: number;
    name: string;
    content: string;
    examples: FewShotExample[];
  } | null>(null);

  // Research template state
  const [researchTemplates, setResearchTemplates] = useState<ResearchTemplate[]>([]);
  const [isResearchDialogOpen, setIsResearchDialogOpen] = useState(false);
  const [editingResearchTemplate, setEditingResearchTemplate] = useState<ResearchTemplate | null>(null);
  const [newResearchTemplate, setNewResearchTemplate] = useState<ResearchTemplate>({
    name: '',
    description: '',
    methodology: 'analytical',
    quality_standards: { accuracy: 0.8, completeness: 0.8, citation: 0.8 },
    citation_style: 'APA',
    tone: 'objective',
    report_type: 'standard',
  });

  // Refs to track initial values for comparison. The system_prompt and
  // message_template ones were tied to the legacy per-user textareas
  // that are no longer rendered (the global system prompt is now an
  // admin-only Layer 1 setting in server_settings, and the message
  // template card was option c3 — removed as redundant).
  const initialCustomTemplatesRef = useRef<{ name: string; content: string }[]>(
    []
  );

  // This useEffect was causing unnecessary saves - removed as it's redundant
  // The parent component already handles state updates properly

  const handleAddPrompt = () => {
    if (!newPromptName) {
      toast.error(t('settings.prompts.errors.nameRequired'));
      return;
    }

    if (!newPromptContent) {
      toast.error(t('settings.prompts.errors.contentRequired'));
      return;
    }

    const examples = newPromptExamples.filter(ex => ex.input.trim() || ex.output.trim());
    addCustomTemplate(newPromptName, newPromptContent, examples.length > 0 ? examples : undefined);
    setNewPromptName('');
    setNewPromptContent('');
    setNewPromptExamples([]);
    setIsAddPromptOpen(false);
  };

  const handleEditPrompt = () => {
    if (!editingPrompt) return;

    if (!editingPrompt.name) {
      toast.error(t('settings.prompts.errors.nameRequired'));
      return;
    }

    if (!editingPrompt.content) {
      toast.error(t('settings.prompts.errors.contentRequired'));
      return;
    }

    const examples = editingPrompt.examples.filter(ex => ex.input.trim() || ex.output.trim());
    updateCustomTemplate(
      editingPrompt.index,
      editingPrompt.name,
      editingPrompt.content,
      examples.length > 0 ? examples : undefined
    );
    setEditingPrompt(null);
  };

  // Research template handlers
  const resetNewResearchTemplate = () => {
    setNewResearchTemplate({
      name: '',
      description: '',
      methodology: 'analytical',
      quality_standards: { accuracy: 0.8, completeness: 0.8, citation: 0.8 },
      citation_style: 'APA',
      tone: 'objective',
      report_type: 'standard',
    });
  };

  const handleAddResearchTemplate = async () => {
    if (!newResearchTemplate.name) {
      toast.error(t('settings.prompts.errors.nameRequired'));
      return;
    }

    const templateToAdd: ResearchTemplate = {
      ...newResearchTemplate,
      id: `user-${Date.now()}`,
      is_default: false,
    };

    const updatedTemplates = [...researchTemplates, templateToAdd];
    setResearchTemplates(updatedTemplates);

    try {
      await saveResearchTemplates(updatedTemplates);
      toast.success(t('settings.prompts.researchTemplates.addSuccess'));
    } catch (error) {
      console.error('Error saving research template:', error);
      toast.error(t('settings.prompts.researchTemplates.saveFailed'));
    }

    resetNewResearchTemplate();
    setIsResearchDialogOpen(false);
  };

  const handleEditResearchTemplate = async () => {
    if (!editingResearchTemplate) return;

    if (!editingResearchTemplate.name) {
      toast.error(t('settings.prompts.errors.nameRequired'));
      return;
    }

    const updatedTemplates = researchTemplates.map(t =>
      t.id === editingResearchTemplate.id ? editingResearchTemplate : t
    );
    setResearchTemplates(updatedTemplates);

    try {
      await saveResearchTemplates(updatedTemplates);
      toast.success(t('settings.prompts.researchTemplates.updateSuccess'));
    } catch (error) {
      console.error('Error updating research template:', error);
      toast.error(t('settings.prompts.researchTemplates.saveFailed'));
    }

    setEditingResearchTemplate(null);
  };

  const handleDeleteResearchTemplate = async (templateId: string) => {
    const updatedTemplates = researchTemplates.filter(t => t.id !== templateId);
    setResearchTemplates(updatedTemplates);

    try {
      await saveResearchTemplates(updatedTemplates);
      toast.success(t('settings.prompts.researchTemplates.deleteSuccess'));
    } catch (error) {
      console.error('Error deleting research template:', error);
      toast.error(t('settings.prompts.researchTemplates.saveFailed'));
    }
  };

  const handleCloneResearchTemplate = (template: ResearchTemplate) => {
    setNewResearchTemplate({
      name: `${template.name} (Copy)`,
      description: template.description,
      methodology: template.methodology,
      quality_standards: { ...template.quality_standards },
      citation_style: template.citation_style,
    });
    setIsResearchDialogOpen(true);
  };

  const getMethodologyIcon = (methodology: string) => {
    switch (methodology) {
      case 'analytical':
        return <FlaskConical className="w-4 h-4" />;
      case 'systematic':
        return <BookOpen className="w-4 h-4" />;
      case 'comparative':
        return <Briefcase className="w-4 h-4" />;
      case 'thematic':
        return <Sparkles className="w-4 h-4" />;
      case 'narrative':
        return <Edit className="w-4 h-4" />;
      default:
        return <Cpu className="w-4 h-4" />;
    }
  };

  // Load research templates on mount
  useEffect(() => {
    const loadResearchTemplates = async () => {
      try {
        const templates = await getResearchTemplates();
        setResearchTemplates(templates);
      } catch (error) {
        console.error('Error loading research templates:', error);
        // Fall back to defaults
        setResearchTemplates(DEFAULT_RESEARCH_TEMPLATES);
      }
    };

    void loadResearchTemplates();
  }, []);

  // Load saved prompt templates from backend on mount
  useEffect(() => {
    const loadPromptTemplates = async () => {
      try {
        const data = await getPromptTemplates();
        if (
          data &&
          data.setting_value &&
          Array.isArray(data.setting_value.templates)
        ) {
          // Store templates in a local array first to avoid multiple state updates
          const templates: { name: string; content: string; examples?: FewShotExample[] }[] = [];
          data.setting_value.templates.forEach((template: { name?: string; content?: string; examples?: FewShotExample[] }) => {
            if (template.name && template.content) {
              templates.push({
                name: template.name,
                content: template.content,
                examples: Array.isArray(template.examples) ? template.examples : undefined,
              });
            }
          });

          // Update initial refs with loaded data
          if (templates.length > 0) {
            initialCustomTemplatesRef.current = [...templates];

            // Don't call addCustomTemplate during initial load as it triggers change detection
            // The parent component should handle loading templates from the backend
          }

          // Note: legacy `default_system_prompt` and `default_template`
          // fields under user_settings.prompt_templates are no longer
          // surfaced. Layer 1 is admin-only via server_settings, and
          // the message-template textarea was option c3 (removed).
        }
      } catch (error) {
        console.error('Error loading prompt templates:', error);
        toast.error(t('general.errors.loadFailed') + ' prompt templates');
      }
    };

    // Only load templates if we don't already have any (to prevent duplicate loading)
    if (customTemplates.length === 0) {
      void loadPromptTemplates();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [customTemplates.length]);

  return (
    <>
      <div className='sticky top-0 pt-0 pb-6 z-20' style={{ position: 'sticky' }}>
        <div 
          className='absolute inset-0 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-xl -z-10'
          style={{ maskImage: 'linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)' }}
        />
        <div>
          <h2 className='text-2xl font-bold text-zinc-900 dark:text-white mb-1'>
            Prompt Settings
          </h2>
          <p className='text-sm text-zinc-500 dark:text-zinc-400'>
            Configure system prompts and custom templates
          </p>
        </div>
      </div>

      <div className='space-y-6'>
        {/* Default System Prompt Card — admin only.
            Stored in Python's server_settings(setting_key='admin_default_system_prompt')
            and read by Layer 1 of the layered system-prompt builder on every chat. */}
        {isAdmin && (
          <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
            <div className='flex items-start gap-3 mb-4'>
              <div className='w-10 h-10 flex items-center justify-center mt-1'>
                <Edit className='w-5 h-5 text-blue-600 dark:text-blue-400' />
              </div>
              <div className='flex-1'>
                <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                  {t('settings.prompts.systemPrompt.title')}
                </h3>
                <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                  {t(
                    'settings.prompts.adminSystemPrompt.description',
                    'System-wide system prompt prepended to every chat as Layer 1 of the prompt chain. Applies to all users.'
                  )}
                </p>
              </div>
            </div>
            {/* CodeMirror editor (YAML-flavored — works for plain text
                too, gives line numbers + monospace + dark mode parity).
                Save-on-change: 1.2s after the user stops typing the
                value is PUT to the admin endpoint. The status pill
                under the editor shows idle / saving / saved / error so
                the user knows when their edits are persisted. */}
            {/* `resize-y` + min/max heights make the wrapper drag-
                resizable from its bottom edge. CodeMirror inside takes
                100% so it tracks the wrapper. `overflow: auto` is
                required for the browser to render the resize grip;
                `overflow-hidden` would suppress it. CodeMirror's own
                scrollbars stay scoped to its viewport. */}
            <div
              className={`border rounded-md bg-white dark:bg-zinc-950 resize-y overflow-auto min-h-[200px] max-h-[80vh] ${
                adminPromptLoading
                  ? 'border-zinc-200 dark:border-zinc-800 opacity-60'
                  : 'border-zinc-300 dark:border-zinc-700'
              }`}
              style={{ height: '320px' }}
              data-testid='settings-prompts-system-prompt-textarea'
            >
              <CodeMirror
                // `key` flips when loading completes so CodeMirror
                // remounts with the freshly-fetched DB value. Without
                // it the editor sometimes keeps showing its initial
                // empty state when the GET resolves after first paint.
                key={adminPromptLoading ? 'loading' : 'ready'}
                value={adminDefaultSystemPrompt}
                height='100%'
                theme={isDarkEditor ? githubDark : githubLight}
                extensions={[yamlLang()]}
                editable={!adminPromptLoading}
                placeholder={adminPromptPlaceholder}
                basicSetup={{
                  lineNumbers: true,
                  highlightActiveLine: true,
                  foldGutter: true,
                  highlightSelectionMatches: false,
                  bracketMatching: true,
                  closeBrackets: false,
                  autocompletion: false,
                  searchKeymap: true,
                  tabSize: 2,
                }}
                onChange={value => {
                  if (adminPromptLoading) return;
                  setAdminDefaultSystemPrompt(value);
                }}
              />
            </div>
            <div className='flex items-center justify-between mt-2 text-xs'>
              <span className='text-zinc-500 dark:text-zinc-400'>
                {adminPromptLoading
                  ? t('general.loading', 'Loading…')
                  : t(
                      'settings.prompts.adminSystemPrompt.autosaveHint',
                      'Saved automatically as you type.'
                    )}
              </span>
              <span
                className={`font-medium ${
                  adminPromptSaveState === 'saving'
                    ? 'text-blue-600 dark:text-blue-400'
                    : adminPromptSaveState === 'saved'
                      ? 'text-green-600 dark:text-green-400'
                      : adminPromptSaveState === 'error'
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-transparent'
                }`}
                data-testid='settings-prompts-system-prompt-save-status'
              >
                {adminPromptSaveState === 'saving' &&
                  t('general.saving', 'Saving…')}
                {adminPromptSaveState === 'saved' &&
                  t('general.saved', 'Saved')}
                {adminPromptSaveState === 'error' &&
                  t('general.error', 'Error')}
                {adminPromptSaveState === 'idle' && '·'}
              </span>
            </div>
          </div>
        )}

        {/* Custom Templates Card */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-center justify-between mb-5'>
            <div className='flex items-start gap-3'>
              <div className='w-10 h-10 flex items-center justify-center mt-1'>
                <PlusCircle className='w-5 h-5 text-green-600 dark:text-green-400' />
              </div>
              <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                {t('settings.prompts.customTemplates.title')}
              </h3>
            </div>
            <Button
              onClick={() => setIsAddPromptOpen(true)}
              className='bg-green-600 hover:bg-green-700 text-white font-semibold'
              size='sm'
              data-testid="settings-prompts-add-template-button"
            >
              <PlusCircle className='h-4 w-4 mr-2' />
              {t('settings.prompts.customTemplates.addButton')}
            </Button>
          </div>

          {/* Custom templates list */}
          <div className='space-y-3'>
            {customTemplates.length === 0 ? (
              <div className='text-center py-12 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800'>
                <p className='text-sm text-zinc-500 dark:text-zinc-400'>
                  {t('settings.prompts.customTemplates.noTemplates')}
                </p>
              </div>
            ) : (
              customTemplates.map((template, index) => (
                <div
                  key={index}
                  className='border border-zinc-200 dark:border-zinc-700 p-4 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors'
                  data-testid={`settings-prompts-template-item-${index}`}
                >
                  <div className='flex justify-between items-center mb-2'>
                    <div className='flex items-center gap-2'>
                      <h4 className='font-medium text-zinc-800 dark:text-zinc-200'>
                        {template.name}
                      </h4>
                      {template.examples && template.examples.length > 0 && (
                        <span className='text-xs px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 rounded flex items-center gap-1'>
                          <MessageSquare className='h-3 w-3' />
                          {template.examples.length}
                        </span>
                      )}
                    </div>
                    <div className='flex gap-2'>
                      <Button
                        variant='ghost'
                        size='icon'
                        onClick={() => {
                          setEditingPrompt({
                            index,
                            name: template.name,
                            content: template.content,
                            examples: template.examples || [],
                          });
                        }}
                        className='h-8 w-8 text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white'
                      >
                        <Edit className='h-4 w-4' />
                      </Button>
                      <Button
                        variant='ghost'
                        size='icon'
                        onClick={() => deleteCustomTemplate(index)}
                        className='h-8 w-8 text-zinc-600 hover:text-red-500 dark:text-zinc-400 dark:hover:text-red-400'
                      >
                        <Trash2 className='h-4 w-4' />
                      </Button>
                    </div>
                  </div>
                  <div className='text-sm text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap'>
                    {template.content}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Research Templates Card */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-center justify-between mb-5'>
            <div className='flex items-start gap-3'>
              <div className='w-10 h-10 flex items-center justify-center mt-1'>
                <FlaskConical className='w-5 h-5 text-primary' />
              </div>
              <div>
                <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                  {t('settings.prompts.researchTemplates.title')}
                </h3>
                <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                  {t('settings.prompts.researchTemplates.description')}
                </p>
              </div>
            </div>
            <Button
              onClick={() => {
                resetNewResearchTemplate();
                setIsResearchDialogOpen(true);
              }}
              className='bg-primary hover:bg-primary/90 text-primary-foreground font-semibold'
              size='sm'
              data-testid="settings-prompts-add-research-template-button"
            >
              <PlusCircle className='h-4 w-4 mr-2' />
              {t('settings.prompts.researchTemplates.addButton')}
            </Button>
          </div>

          {/* Research templates list */}
          <div className='space-y-3'>
            {researchTemplates.length === 0 ? (
              <div className='text-center py-12 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800'>
                <p className='text-sm text-zinc-500 dark:text-zinc-400'>
                  {t('settings.prompts.researchTemplates.noTemplates')}
                </p>
              </div>
            ) : (
              researchTemplates.map((template) => (
                <div
                  key={template.id}
                  className={`border p-4 transition-colors ${
                    template.is_default
                      ? 'border-primary/30 bg-primary/5'
                      : 'border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                  }`}
                >
                  <div className='flex justify-between items-start mb-2'>
                    <div className='flex items-center gap-2'>
                      <div className={`p-1.5 ${
                        template.is_default
                          ? 'bg-primary/10 text-primary'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
                      }`}>
                        {getMethodologyIcon(template.methodology)}
                      </div>
                      <div>
                        <h4 className='font-medium text-zinc-800 dark:text-zinc-200 flex items-center gap-2'>
                          {template.name}
                          {template.is_default && (
                            <span className='text-xs px-1.5 py-0.5 bg-primary/10 text-primary'>
                              {t('settings.prompts.researchTemplates.default')}
                            </span>
                          )}
                        </h4>
                        <p className='text-sm text-zinc-500 dark:text-zinc-400'>
                          {template.description}
                        </p>
                      </div>
                    </div>
                    <div className='flex gap-1'>
                      <Button
                        variant='ghost'
                        size='icon'
                        onClick={() => handleCloneResearchTemplate(template)}
                        className='h-8 w-8 text-zinc-600 hover:text-primary dark:text-zinc-400 dark:hover:text-primary'
                        title={t('settings.prompts.researchTemplates.clone')}
                      >
                        <Copy className='h-4 w-4' />
                      </Button>
                      {!template.is_default && (
                        <>
                          <Button
                            variant='ghost'
                            size='icon'
                            onClick={() => setEditingResearchTemplate(template)}
                            className='h-8 w-8 text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white'
                          >
                            <Edit className='h-4 w-4' />
                          </Button>
                          <Button
                            variant='ghost'
                            size='icon'
                            onClick={() => template.id && handleDeleteResearchTemplate(template.id)}
                            className='h-8 w-8 text-zinc-600 hover:text-red-500 dark:text-zinc-400 dark:hover:text-red-400'
                          >
                            <Trash2 className='h-4 w-4' />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Template details */}
                  <div className='mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-zinc-500 dark:text-zinc-400'>
                    <span className='flex items-center gap-1'>
                      <span className='font-medium'>{t('settings.prompts.researchTemplates.methodology')}:</span>
                      <span className='capitalize'>{template.methodology}</span>
                    </span>
                    <span className='flex items-center gap-1'>
                      <span className='font-medium'>{t('settings.prompts.researchTemplates.citation')}:</span>
                      {template.citation_style}
                    </span>
                    {template.tone && (
                      <span className='flex items-center gap-1'>
                        <span className='font-medium'>{t('settings.prompts.researchTemplates.tone', 'Tone')}:</span>
                        <span className='capitalize'>{template.tone}</span>
                      </span>
                    )}
                    {template.report_type && (
                      <span className='flex items-center gap-1'>
                        <span className='font-medium'>{t('settings.prompts.researchTemplates.reportType', 'Report')}:</span>
                        <span className='capitalize'>{template.report_type.replace(/_/g, ' ')}</span>
                      </span>
                    )}
                  </div>

                  {/* Quality standards */}
                  <div className='mt-3 grid grid-cols-3 gap-2'>
                    <div className='text-xs'>
                      <div className='flex justify-between text-zinc-500 dark:text-zinc-400 mb-1'>
                        <span>{t('settings.prompts.researchTemplates.accuracy')}</span>
                        <span>{Math.round(template.quality_standards.accuracy * 100)}%</span>
                      </div>
                      <div className='h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden'>
                        <div
                          className='h-full bg-green-500 dark:bg-green-400 rounded-full'
                          style={{ width: `${template.quality_standards.accuracy * 100}%` }}
                        />
                      </div>
                    </div>
                    <div className='text-xs'>
                      <div className='flex justify-between text-zinc-500 dark:text-zinc-400 mb-1'>
                        <span>{t('settings.prompts.researchTemplates.completeness')}</span>
                        <span>{Math.round(template.quality_standards.completeness * 100)}%</span>
                      </div>
                      <div className='h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden'>
                        <div
                          className='h-full bg-blue-500 dark:bg-blue-400 rounded-full'
                          style={{ width: `${template.quality_standards.completeness * 100}%` }}
                        />
                      </div>
                    </div>
                    <div className='text-xs'>
                      <div className='flex justify-between text-zinc-500 dark:text-zinc-400 mb-1'>
                        <span>{t('settings.prompts.researchTemplates.citationQuality')}</span>
                        <span>{Math.round(template.quality_standards.citation * 100)}%</span>
                      </div>
                      <div className='h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden'>
                        <div
                          className='h-full bg-primary rounded-full'
                          style={{ width: `${template.quality_standards.citation * 100}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Add/Edit Prompt Dialog */}
      <Dialog
        open={isAddPromptOpen || editingPrompt !== null}
        onOpenChange={open => {
          if (!open) {
            setIsAddPromptOpen(false);
            setEditingPrompt(null);
            setNewPromptName('');
            setNewPromptContent('');
            setNewPromptExamples([]);
          }
        }}
      >
        <DialogContent
          className='sm:max-w-[600px]'
          disableBackdropClose={true}
          dialogOpen={isAddPromptOpen || editingPrompt !== null}
          // Settings dialog itself sits at z-1050; without an explicit
          // overlay z-index here the Add/Edit Prompt dialog renders
          // *behind* it and looks broken. CHILD_DIALOG (1550) lifts the
          // overlay above the settings panel; DialogContent stacks on
          // overlay+1, child controls on +2 internally.
          overlayZIndex={String(SETTINGS_Z_INDEX.CHILD_DIALOG)}
          onOpenChange={open => {
            if (!open) {
              setIsAddPromptOpen(false);
              setEditingPrompt(null);
              setNewPromptName('');
              setNewPromptContent('');
              setNewPromptExamples([]);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editingPrompt
                ? t('settings.prompts.editDialog.title')
                : t('settings.prompts.addDialog.title')}
            </DialogTitle>
            <DialogDescription>
              {editingPrompt
                ? t('settings.prompts.editDialog.description')
                : t('settings.prompts.addDialog.description')}
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-4 py-4 max-h-[60vh] overflow-y-auto'>
            <div className='grid grid-cols-4 items-center gap-4'>
              <Label htmlFor='name' className='text-right'>
                {t('settings.prompts.dialog.nameLabel')}
              </Label>
              <Input
                id='name'
                value={editingPrompt ? editingPrompt.name : newPromptName}
                onChange={e =>
                  editingPrompt
                    ? setEditingPrompt({
                        ...editingPrompt,
                        name: e.target.value,
                      })
                    : setNewPromptName(e.target.value)
                }
                className='col-span-3 border-zinc-300 dark:border-zinc-700'
                placeholder={t('settings.prompts.dialog.namePlaceholder')}
              />
            </div>
            <div className='grid grid-cols-4 items-start gap-4'>
              <Label htmlFor='content' className='text-right pt-2'>
                {t('settings.prompts.dialog.contentLabel')}
              </Label>
              <Textarea
                id='content'
                value={editingPrompt ? editingPrompt.content : newPromptContent}
                onChange={e =>
                  editingPrompt
                    ? setEditingPrompt({
                        ...editingPrompt,
                        content: e.target.value,
                      })
                    : setNewPromptContent(e.target.value)
                }
                className='col-span-3 h-40 border-zinc-300 dark:border-zinc-700 resize-none'
                placeholder={t('settings.prompts.dialog.contentPlaceholder')}
              />
            </div>

            {/* Few-Shot Examples */}
            <div className='border-t border-zinc-200 dark:border-zinc-700 pt-4'>
              <div className='flex items-center justify-between mb-3'>
                <div className='flex items-center gap-2'>
                  <MessageSquare className='h-4 w-4 text-amber-600 dark:text-amber-400' />
                  <Label className='text-sm font-medium'>
                    {t('settings.prompts.fewShot.title')}
                  </Label>
                </div>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() => {
                    const example = { input: '', output: '' };
                    if (editingPrompt) {
                      setEditingPrompt({ ...editingPrompt, examples: [...editingPrompt.examples, example] });
                    } else {
                      setNewPromptExamples([...newPromptExamples, example]);
                    }
                  }}
                  className='h-7 text-xs'
                >
                  <PlusCircle className='h-3 w-3 mr-1' />
                  {t('settings.prompts.fewShot.addExample')}
                </Button>
              </div>
              <p className='text-xs text-zinc-500 dark:text-zinc-400 mb-3'>
                {t('settings.prompts.fewShot.description')}
              </p>
              <div className='space-y-3 max-h-[200px] overflow-y-auto'>
                {(editingPrompt ? editingPrompt.examples : newPromptExamples).map((example, idx) => (
                  <div key={idx} className='relative border border-zinc-200 dark:border-zinc-700 p-3 bg-zinc-50 dark:bg-zinc-900'>
                    <Button
                      type='button'
                      variant='ghost'
                      size='icon'
                      className='absolute top-1 right-1 h-6 w-6 text-zinc-400 hover:text-red-500'
                      onClick={() => {
                        if (editingPrompt) {
                          const updated = editingPrompt.examples.filter((_, i) => i !== idx);
                          setEditingPrompt({ ...editingPrompt, examples: updated });
                        } else {
                          setNewPromptExamples(newPromptExamples.filter((_, i) => i !== idx));
                        }
                      }}
                    >
                      <X className='h-3 w-3' />
                    </Button>
                    <div className='space-y-2 pr-6'>
                      <div>
                        <Label className='text-xs text-zinc-500 dark:text-zinc-400'>
                          {t('settings.prompts.fewShot.inputLabel')}
                        </Label>
                        <Textarea
                          value={example.input}
                          onChange={e => {
                            if (editingPrompt) {
                              const updated = [...editingPrompt.examples];
                              updated[idx] = { ...updated[idx], input: e.target.value };
                              setEditingPrompt({ ...editingPrompt, examples: updated });
                            } else {
                              const updated = [...newPromptExamples];
                              updated[idx] = { ...updated[idx], input: e.target.value };
                              setNewPromptExamples(updated);
                            }
                          }}
                          className='h-16 text-sm border-zinc-300 dark:border-zinc-700 resize-none'
                          placeholder={t('settings.prompts.fewShot.inputPlaceholder')}
                        />
                      </div>
                      <div>
                        <Label className='text-xs text-zinc-500 dark:text-zinc-400'>
                          {t('settings.prompts.fewShot.outputLabel')}
                        </Label>
                        <Textarea
                          value={example.output}
                          onChange={e => {
                            if (editingPrompt) {
                              const updated = [...editingPrompt.examples];
                              updated[idx] = { ...updated[idx], output: e.target.value };
                              setEditingPrompt({ ...editingPrompt, examples: updated });
                            } else {
                              const updated = [...newPromptExamples];
                              updated[idx] = { ...updated[idx], output: e.target.value };
                              setNewPromptExamples(updated);
                            }
                          }}
                          className='h-16 text-sm border-zinc-300 dark:border-zinc-700 resize-none'
                          placeholder={t('settings.prompts.fewShot.outputPlaceholder')}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='ghost'
              onClick={() =>
                editingPrompt
                  ? setEditingPrompt(null)
                  : setIsAddPromptOpen(false)
              }
            >
              {t('general.cancel')}
            </Button>
            <Button
              onClick={editingPrompt ? handleEditPrompt : handleAddPrompt}
            >
              {editingPrompt
                ? t('settings.prompts.editDialog.saveButton')
                : t('settings.prompts.addDialog.addButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add/Edit Research Template Dialog */}
      <Dialog
        open={isResearchDialogOpen || editingResearchTemplate !== null}
        onOpenChange={open => {
          if (!open) {
            setIsResearchDialogOpen(false);
            setEditingResearchTemplate(null);
            resetNewResearchTemplate();
          }
        }}
      >
        <DialogContent
          className='sm:max-w-[600px]'
          disableBackdropClose={true}
          dialogOpen={isResearchDialogOpen || editingResearchTemplate !== null}
          // Same z-index lift as the Custom Templates dialog so the
          // research-template dialog also renders above the settings
          // panel (which sits at z-1050).
          overlayZIndex={String(SETTINGS_Z_INDEX.CHILD_DIALOG)}
          onOpenChange={open => {
            if (!open) {
              setIsResearchDialogOpen(false);
              setEditingResearchTemplate(null);
              resetNewResearchTemplate();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editingResearchTemplate
                ? t('settings.prompts.researchTemplates.editTitle')
                : t('settings.prompts.researchTemplates.addTitle')}
            </DialogTitle>
            <DialogDescription>
              {editingResearchTemplate
                ? t('settings.prompts.researchTemplates.editDescription')
                : t('settings.prompts.researchTemplates.addDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-4 py-4 max-h-[60vh] overflow-y-auto'>
            {/* Name */}
            <div className='grid grid-cols-4 items-center gap-4'>
              <Label htmlFor='research-name' className='text-right'>
                {t('settings.prompts.dialog.nameLabel')}
              </Label>
              <Input
                id='research-name'
                value={editingResearchTemplate ? editingResearchTemplate.name : newResearchTemplate.name}
                onChange={e => {
                  const value = e.target.value;
                  if (editingResearchTemplate) {
                    setEditingResearchTemplate({ ...editingResearchTemplate, name: value });
                  } else {
                    setNewResearchTemplate({ ...newResearchTemplate, name: value });
                  }
                }}
                className='col-span-3 border-zinc-300 dark:border-zinc-700'
                placeholder={t('settings.prompts.researchTemplates.namePlaceholder')}
              />
            </div>

            {/* Description */}
            <div className='grid grid-cols-4 items-start gap-4'>
              <Label htmlFor='research-description' className='text-right pt-2'>
                {t('settings.prompts.researchTemplates.descriptionLabel')}
              </Label>
              <Textarea
                id='research-description'
                value={editingResearchTemplate ? editingResearchTemplate.description : newResearchTemplate.description}
                onChange={e => {
                  const value = e.target.value;
                  if (editingResearchTemplate) {
                    setEditingResearchTemplate({ ...editingResearchTemplate, description: value });
                  } else {
                    setNewResearchTemplate({ ...newResearchTemplate, description: value });
                  }
                }}
                className='col-span-3 h-20 border-zinc-300 dark:border-zinc-700 resize-none'
                placeholder={t('settings.prompts.researchTemplates.descriptionPlaceholder')}
              />
            </div>

            {/* Methodology */}
            <div className='grid grid-cols-4 items-center gap-4'>
              <Label htmlFor='research-methodology' className='text-right'>
                {t('settings.prompts.researchTemplates.methodology')}
              </Label>
              <Select
                value={editingResearchTemplate ? editingResearchTemplate.methodology : newResearchTemplate.methodology}
                onValueChange={(value: ResearchTemplate['methodology']) => {
                  if (editingResearchTemplate) {
                    setEditingResearchTemplate({ ...editingResearchTemplate, methodology: value });
                  } else {
                    setNewResearchTemplate({ ...newResearchTemplate, methodology: value });
                  }
                }}
              >
                <SelectTrigger className='col-span-3'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className='z-[1600]'>
                  <SelectItem value='analytical'>{t('settings.prompts.researchTemplates.methodologies.analytical')}</SelectItem>
                  <SelectItem value='comparative'>{t('settings.prompts.researchTemplates.methodologies.comparative')}</SelectItem>
                  <SelectItem value='narrative'>{t('settings.prompts.researchTemplates.methodologies.narrative')}</SelectItem>
                  <SelectItem value='thematic'>{t('settings.prompts.researchTemplates.methodologies.thematic')}</SelectItem>
                  <SelectItem value='systematic'>{t('settings.prompts.researchTemplates.methodologies.systematic')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Citation Style */}
            <div className='grid grid-cols-4 items-center gap-4'>
              <Label htmlFor='research-citation' className='text-right'>
                {t('settings.prompts.researchTemplates.citationStyle')}
              </Label>
              <Select
                value={editingResearchTemplate ? editingResearchTemplate.citation_style : newResearchTemplate.citation_style}
                onValueChange={(value: ResearchTemplate['citation_style']) => {
                  if (editingResearchTemplate) {
                    setEditingResearchTemplate({ ...editingResearchTemplate, citation_style: value });
                  } else {
                    setNewResearchTemplate({ ...newResearchTemplate, citation_style: value });
                  }
                }}
              >
                <SelectTrigger className='col-span-3'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className='z-[1600]'>
                  <SelectItem value='APA'>APA (7th Edition)</SelectItem>
                  <SelectItem value='MLA'>MLA (9th Edition)</SelectItem>
                  <SelectItem value='Chicago'>Chicago/Turabian</SelectItem>
                  <SelectItem value='IEEE'>IEEE</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Writing Tone */}
            <div className='grid grid-cols-4 items-center gap-4'>
              <Label className='text-right'>
                {t('settings.prompts.researchTemplates.tone', 'Tone')}
              </Label>
              <Select
                value={editingResearchTemplate ? (editingResearchTemplate.tone || 'objective') : newResearchTemplate.tone}
                onValueChange={(value: ResearchTemplate['tone']) => {
                  if (editingResearchTemplate) {
                    setEditingResearchTemplate({ ...editingResearchTemplate, tone: value });
                  } else {
                    setNewResearchTemplate({ ...newResearchTemplate, tone: value });
                  }
                }}
              >
                <SelectTrigger className='col-span-3'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className='z-[1600]'>
                  <SelectItem value='objective'>{t('deepResearch.v2.toneObjective', 'Objective')}</SelectItem>
                  <SelectItem value='formal'>{t('deepResearch.v2.toneFormal', 'Formal')}</SelectItem>
                  <SelectItem value='analytical'>{t('deepResearch.v2.toneAnalytical', 'Analytical')}</SelectItem>
                  <SelectItem value='informative'>Informative</SelectItem>
                  <SelectItem value='explanatory'>Explanatory</SelectItem>
                  <SelectItem value='descriptive'>Descriptive</SelectItem>
                  <SelectItem value='critical'>Critical</SelectItem>
                  <SelectItem value='comparative'>Comparative</SelectItem>
                  <SelectItem value='speculative'>Speculative</SelectItem>
                  <SelectItem value='reflective'>Reflective</SelectItem>
                  <SelectItem value='narrative'>{t('deepResearch.v2.toneNarrative', 'Narrative')}</SelectItem>
                  <SelectItem value='simple'>{t('deepResearch.v2.toneSimple', 'Simple')}</SelectItem>
                  <SelectItem value='casual'>{t('deepResearch.v2.toneCasual', 'Casual')}</SelectItem>
                  <SelectItem value='optimistic'>Optimistic</SelectItem>
                  <SelectItem value='pessimistic'>Pessimistic</SelectItem>
                  <SelectItem value='persuasive'>Persuasive</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Report Type */}
            <div className='grid grid-cols-4 items-center gap-4'>
              <Label className='text-right'>
                {t('settings.prompts.researchTemplates.reportType', 'Report Type')}
              </Label>
              <Select
                value={editingResearchTemplate ? (editingResearchTemplate.report_type || 'standard') : newResearchTemplate.report_type}
                onValueChange={(value: ResearchTemplate['report_type']) => {
                  if (editingResearchTemplate) {
                    setEditingResearchTemplate({ ...editingResearchTemplate, report_type: value });
                  } else {
                    setNewResearchTemplate({ ...newResearchTemplate, report_type: value });
                  }
                }}
              >
                <SelectTrigger className='col-span-3'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className='z-[1600]'>
                  <SelectItem value='standard'>{t('deepResearch.v2.reportStandard', 'Standard Report')}</SelectItem>
                  <SelectItem value='outline'>{t('deepResearch.v2.reportOutline', 'Outline Only')}</SelectItem>
                  <SelectItem value='executive_summary'>{t('deepResearch.v2.reportExecutiveSummary', 'Executive Summary')}</SelectItem>
                  <SelectItem value='bibliography'>{t('deepResearch.v2.reportBibliography', 'Annotated Bibliography')}</SelectItem>
                  <SelectItem value='detailed'>{t('deepResearch.v2.reportDetailed', 'Detailed Analysis')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Quality Standards */}
            <div className='mt-2'>
              <Label className='text-sm font-medium mb-3 block'>
                {t('settings.prompts.researchTemplates.qualityStandards')}
              </Label>
              <div className='space-y-4 pl-4'>
                {/* Accuracy */}
                <div className='space-y-2'>
                  <div className='flex justify-between text-sm'>
                    <span className='text-zinc-600 dark:text-zinc-400'>{t('settings.prompts.researchTemplates.accuracy')}</span>
                    <span className='font-medium'>
                      {Math.round((editingResearchTemplate ? editingResearchTemplate.quality_standards.accuracy : newResearchTemplate.quality_standards.accuracy) * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[editingResearchTemplate ? editingResearchTemplate.quality_standards.accuracy * 100 : newResearchTemplate.quality_standards.accuracy * 100]}
                    onValueChange={([value]) => {
                      const normalized = value / 100;
                      if (editingResearchTemplate) {
                        setEditingResearchTemplate({
                            ...editingResearchTemplate,
                            quality_standards: { ...editingResearchTemplate.quality_standards, accuracy: normalized },
                          });
                      } else {
                        setNewResearchTemplate({
                            ...newResearchTemplate,
                            quality_standards: { ...newResearchTemplate.quality_standards, accuracy: normalized },
                          });
                      }
                    }}
                    min={50}
                    max={100}
                    step={5}
                    className='w-full'
                  />
                </div>

                {/* Completeness */}
                <div className='space-y-2'>
                  <div className='flex justify-between text-sm'>
                    <span className='text-zinc-600 dark:text-zinc-400'>{t('settings.prompts.researchTemplates.completeness')}</span>
                    <span className='font-medium'>
                      {Math.round((editingResearchTemplate ? editingResearchTemplate.quality_standards.completeness : newResearchTemplate.quality_standards.completeness) * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[editingResearchTemplate ? editingResearchTemplate.quality_standards.completeness * 100 : newResearchTemplate.quality_standards.completeness * 100]}
                    onValueChange={([value]) => {
                      const normalized = value / 100;
                      if (editingResearchTemplate) {
                        setEditingResearchTemplate({
                            ...editingResearchTemplate,
                            quality_standards: { ...editingResearchTemplate.quality_standards, completeness: normalized },
                          });
                      } else {
                        setNewResearchTemplate({
                            ...newResearchTemplate,
                            quality_standards: { ...newResearchTemplate.quality_standards, completeness: normalized },
                          });
                      }
                    }}
                    min={50}
                    max={100}
                    step={5}
                    className='w-full'
                  />
                </div>

                {/* Citation Quality */}
                <div className='space-y-2'>
                  <div className='flex justify-between text-sm'>
                    <span className='text-zinc-600 dark:text-zinc-400'>{t('settings.prompts.researchTemplates.citationQuality')}</span>
                    <span className='font-medium'>
                      {Math.round((editingResearchTemplate ? editingResearchTemplate.quality_standards.citation : newResearchTemplate.quality_standards.citation) * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[editingResearchTemplate ? editingResearchTemplate.quality_standards.citation * 100 : newResearchTemplate.quality_standards.citation * 100]}
                    onValueChange={([value]) => {
                      const normalized = value / 100;
                      if (editingResearchTemplate) {
                        setEditingResearchTemplate({
                            ...editingResearchTemplate,
                            quality_standards: { ...editingResearchTemplate.quality_standards, citation: normalized },
                          });
                      } else {
                        setNewResearchTemplate({
                            ...newResearchTemplate,
                            quality_standards: { ...newResearchTemplate.quality_standards, citation: normalized },
                          });
                      }
                    }}
                    min={50}
                    max={100}
                    step={5}
                    className='w-full'
                  />
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='ghost'
              onClick={() => {
                setIsResearchDialogOpen(false);
                setEditingResearchTemplate(null);
                resetNewResearchTemplate();
              }}
            >
              {t('general.cancel')}
            </Button>
            <Button
              onClick={editingResearchTemplate ? handleEditResearchTemplate : handleAddResearchTemplate}
              className='bg-primary hover:bg-primary/90'
            >
              {editingResearchTemplate
                ? t('settings.prompts.editDialog.saveButton')
                : t('settings.prompts.addDialog.addButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
