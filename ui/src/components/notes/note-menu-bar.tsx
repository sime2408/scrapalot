/**
 * NoteMenuBar
 *
 * Document-scoped menu bar for the Notes editor — four lean dropdowns on
 * desktop (Datoteka / Prikaz / Alati / AI), iOS/Android convention on mobile
 * (back · Research Context pill · ✨ primary AI · ⋯ overflow).
 *
 * Action placement principle (Candidates H + D):
 *   whole-note  → this menu bar
 *   selection   → floating bubble (existing SelectionToolbar)
 *   insert block → slash menu (existing slash-commands)
 *   ambient     → suggestion strip (G Layer 2, deferred)
 *
 * All handlers are optional: consumers wire only what they have ready; items
 * with undefined handlers render disabled. This lets us ship the menu
 * structure ahead of the individual feature handlers.
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Check,
  Compass,
  Copy,
  Download,
  FileDown,
  FilePlus,
  FileText,
  FolderOpen,
  HelpCircle,
  History,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  MoreHorizontal,
  RectangleHorizontal,
  Save,
  Search,
  Share2,
  Smile,
  Sparkles,
  Trash2,
  Type,
  Wand2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from '@/components/ui/menubar';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type {
  PageHeadValue,
  PageHeadHandlers,
  PageHeadLayoutHandlers,
} from './page-head-toolbar';

export type ExportFormat = 'pdf' | 'docx' | 'markdown' | 'latex' | 'latex-zip' | 'html';

/** Quick-pick emoji set duplicated from PageHeadToolbar so the mobile overflow
 *  can offer the same shortlist without importing the toolbar (which renders
 *  a heavy floating UI). Keep in sync if either side grows. */
const PAGE_HEAD_EMOJI_QUICK = ['📝', '📌', '⭐', '🔥', '💡', '✅', '⚠️', '🚧', '📚', '🎯', '🧠', '🚀'];

export interface NoteMenuHandlers {
  // File
  onNew?: () => void;
  onNewFromTemplate?: () => void;
  /** opens the paginated, category-scoped Otvori dialog. */
  onOpen?: () => void;
  onOpenRecent?: () => void;
  onSave?: () => void;
  onSaveAsTemplate?: () => void;
  onDuplicate?: () => void;
  onExport?: (format: ExportFormat) => void;
  onPrint?: () => void;
  onShare?: () => void;
  onVersionHistory?: () => void;
  onDelete?: () => void;

  // Research Context pill (header-right) — kept even without View menu because
  // the pill popover uses this to let the caller open the context editor.
  onChangeResearchContext?: () => void;

  // Tools
  onGrammarCheck?: () => void;
  onToggleNonNativeEnglish?: () => void;
  onConsistencyCheck?: () => void;
  onWordCount?: () => void;
  onFindReplace?: () => void;
  /** 7.6 — toggle fullscreen mode for the notes drawer (hides app chrome). */
  onToggleFullscreen?: () => void;
  /** 7.6 — toggle focus mode (dims non-active paragraphs). Only meaningful
   *  inside fullscreen mode but works outside too. */
  onToggleFocusMode?: () => void;
  /** 7.10 — toggle reading-mode preview (caps line width to ~65 chars,
   *  hides slash-command hints and edit chrome, makes the editor
   *  read-only). Pure CSS state on body + editor.editable() flip. */
  onToggleReadingMode?: () => void;
  /** 7.10 — toggle sepia / parchment theme. Mutually exclusive with
   *  the global dark mode (parchment palette is unreadable on dark
   *  backgrounds). Persisted per user; turning ON forces global dark
   *  off. */
  onToggleSepiaMode?: () => void;
  /** 7.1 — toggle AI Autocomplete (ghost text). Off by default; flips
   *  the AiAutocomplete extension's `enabled` storage flag and
   *  persists to localStorage so the choice survives reload. */
  onToggleAiAutocomplete?: () => void;

  // AI — whole-note only
  onGenerateTitle?: () => void;
  onGenerateAbstract?: () => void;
  onGenerateOutline?: () => void;
  onGenerateHighlights?: () => void;
  onConnectDots?: () => void;
  onFactCheckWholeNote?: () => void;
  onShortenToTarget?: () => void;
  onTranslateWholeNote?: () => void;
  /** 7.7 — Thought Partner. Run critique-with-questions over the
   *  whole note and insert the result as a `review` callout. */
  onCritiqueWithQuestions?: () => void;
  /** 7.3 — RAG-grounded paragraph generation from picked sources. */
  onComposeFromSources?: () => void;

  // Mobile back / close
  onBack?: () => void;
}

export interface NoteMenuState {
  nonNativeEnglishMode?: boolean;
  /** Save indicator text — e.g. "Saved · 14:37". */
  saveIndicator?: string;
  /** 7.6 — currently fullscreen?  Drives the menu badge + label flip. */
  isFullscreen?: boolean;
  /** 7.6 — focus-mode (paragraph dimming) currently on? */
  isFocusMode?: boolean;
  /** 7.10 — reading-mode preview currently on? */
  isReadingMode?: boolean;
  /** 7.10 — sepia / parchment theme currently on? */
  isSepiaMode?: boolean;
  /** 7.1 — AI Autocomplete enabled?  Drives the toolbar toggle badge. */
  isAiAutocompleteEnabled?: boolean;
  /** 7.1 cost guard — sliding-window quota usage. When both fields are
   *  set, the AI Autocomplete menu entry shows a "x / N this hour"
   *  hint so the user knows they are approaching the cap. */
  autocompleteQuotaUsed?: number;
  autocompleteQuotaLimit?: number;
}

export interface NoteMenuBarProps extends React.HTMLAttributes<HTMLDivElement> {
  handlers: NoteMenuHandlers;
  state?: NoteMenuState;
  /** Left-side element (icon, brand title, etc.). Rendered before the menus
   *  on desktop; rendered before the back button on mobile when provided. */
  leading?: React.ReactNode;
  /** Right-side trailing elements (collaborator avatars, width select, close, etc.). */
  trailing?: React.ReactNode;
  /** Page-head metadata controls. On mobile the floating PageHeadToolbar is
   *  hidden (no room above the H1) — the same 7 actions appear here as a
   *  "Stranica" section inside the ⋯ overflow menu. Desktop is unaffected:
   *  the floating toolbar still owns the UX. */
  pageHead?: {
    value: PageHeadValue;
    handlers: PageHeadHandlers;
    layout: PageHeadLayoutHandlers;
  };
  /** Live autosave indicator. Renders as a tiny chip on the right
   *  side of the menu bar: spinner while saving, green check pulse
   *  on save, hidden when idle. Replaces the duplicate text label
   *  that used to live in collaboration-header. */
  saveStatus?: 'idle' | 'saving' | 'saved';
  className?: string;
}

/* --------------------------------------------------------------------- */
/* Helpers                                                                */
/* --------------------------------------------------------------------- */

interface MenuEntryData {
  key: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onClick?: () => void;
  shortcut?: string;
  destructive?: boolean;
  /** Sub-menu entries — when present, this item opens a nested menu on desktop
   *  and a full submenu sheet on mobile. */
  submenu?: MenuEntryData[];
  /** ON/OFF badge next to toggle-type items. */
  state?: boolean;
  /** Help text shown in a tooltip when the user hovers a "?" affordance.
   *  Used to explain what the action produces and what the user must
   *  prepare beforehand (selection, sources, minimum length, etc.). */
  description?: string;
}

interface MenuSection {
  key: string;
  label: string;
  entries: MenuEntryData[];
}

/* --------------------------------------------------------------------- */
/* Desktop: Menubar menu per section (uses Radix Menubar primitive so     */
/* moving the pointer between triggers auto-opens the adjacent menu once  */
/* one is open — standard MS Word / macOS menubar behaviour).             */
/* --------------------------------------------------------------------- */

const DesktopMenu: React.FC<{ section: MenuSection; testId: string }> = ({ section, testId }) => (
  <MenubarMenu>
    <MenubarTrigger
      data-testid={testId}
      className="px-2.5 py-1 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent cursor-default select-none"
    >
      {section.label}
    </MenubarTrigger>
    <MenubarContent align="start" className="min-w-56 z-[10050] notes-popover" data-notes-popover="true">
      {section.entries.map((entry, idx) => {
        if (entry.key === '__separator__') {
          return <MenubarSeparator key={`sep-${idx}`} />;
        }
        if (entry.submenu) {
          return (
            <MenubarSub key={entry.key}>
              <MenubarSubTrigger
                disabled={!entry.submenu.some((sub) => sub.onClick)}
                data-testid={`${testId}-${entry.key}`}
              >
                {entry.icon && <entry.icon className="mr-2 h-4 w-4" />}
                <span>{entry.label}</span>
              </MenubarSubTrigger>
              <MenubarSubContent className="min-w-72 z-[10051] notes-popover" data-notes-popover="true">
                {entry.submenu.map((sub, subIdx) => {
                  if (sub.key === '__separator__') {
                    return <MenubarSeparator key={`sep-${subIdx}`} />;
                  }
                  return (
                    <MenubarItem
                      key={sub.key}
                      onClick={sub.onClick}
                      disabled={!sub.onClick}
                      data-testid={`${testId}-${entry.key}-${sub.key}`}
                    >
                      {sub.icon && <sub.icon className="mr-2 h-4 w-4" />}
                      <span>{sub.label}</span>
                      {sub.shortcut && (
                        <span className="ml-auto text-xs text-muted-foreground">{sub.shortcut}</span>
                      )}
                      {sub.description && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              role="button"
                              tabIndex={0}
                              aria-label={sub.description}
                              data-testid={`${testId}-${entry.key}-${sub.key}-help`}
                              onClick={(e) => {
                                // Stop the parent MenubarItem from firing its
                                // onClick (which would close the menu and run
                                // the action). The "?" badge is purely an
                                // affordance for the tooltip; it should not
                                // trigger the action itself.
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              onPointerDown={(e) => {
                                // Radix Menubar uses pointerdown for selection
                                // ordering; without stopping it here, the
                                // menubar's own pointer handler still picks
                                // up the click on the parent item.
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                }
                              }}
                              className="ml-auto inline-flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground"
                            >
                              <HelpCircle className="h-3.5 w-3.5" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent
                            side="right"
                            align="start"
                            className="max-w-xs whitespace-normal text-xs leading-relaxed z-[10052]"
                          >
                            {sub.description}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </MenubarItem>
                  );
                })}
              </MenubarSubContent>
            </MenubarSub>
          );
        }
        return (
          <MenubarItem
            key={entry.key}
            onClick={entry.onClick}
            disabled={!entry.onClick}
            data-testid={`${testId}-${entry.key}`}
            className={cn(entry.destructive && 'text-destructive focus:text-destructive')}
          >
            {entry.icon && <entry.icon className="mr-2 h-4 w-4" />}
            <span>{entry.label}</span>
            {typeof entry.state === 'boolean' && (
              <span
                className={cn(
                  'ml-auto text-[10px] font-semibold uppercase tracking-wider',
                  entry.state ? 'text-primary' : 'text-muted-foreground'
                )}
              >
                {entry.state ? 'ON' : 'OFF'}
              </span>
            )}
            {entry.shortcut && !entry.state && (
              <span className="ml-auto text-xs text-muted-foreground">{entry.shortcut}</span>
            )}
          </MenubarItem>
        );
      })}
    </MenubarContent>
  </MenubarMenu>
);

/* --------------------------------------------------------------------- */
/* Mobile: bottom action sheet (vaul Drawer)                              */
/* --------------------------------------------------------------------- */

const MobileSheetSection: React.FC<{ section: MenuSection; testId: string; onSelect: () => void }> = ({
  section,
  testId,
  onSelect,
}) => (
  <div>
    <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground border-t border-border first:border-t-0">
      {section.label}
    </div>
    {section.entries.map((entry, idx) => {
      if (entry.key === '__separator__') {
        return <div key={`sep-${idx}`} className="h-px bg-border my-1" />;
      }
      // Submenus are flattened to a secondary row on mobile — first-level only
      if (entry.submenu) {
        return entry.submenu.map((sub) => (
          <button
            type="button"
            key={`${entry.key}-${sub.key}`}
            data-testid={`${testId}-${entry.key}-${sub.key}`}
            disabled={!sub.onClick}
            onClick={() => {
              sub.onClick?.();
              onSelect();
            }}
            className={cn(
              'flex w-full items-center gap-3 px-4 py-3 text-sm text-left text-foreground',
              'disabled:opacity-40 disabled:pointer-events-none',
              'active:bg-accent'
            )}
          >
            {sub.icon && <sub.icon className="h-4 w-4 text-muted-foreground" />}
            <span className="flex-1">
              {entry.label}: <span className="font-medium">{sub.label}</span>
            </span>
          </button>
        ));
      }
      return (
        <button
          type="button"
          key={entry.key}
          data-testid={`${testId}-${entry.key}`}
          disabled={!entry.onClick}
          onClick={() => {
            entry.onClick?.();
            onSelect();
          }}
          className={cn(
            'flex w-full items-center gap-3 px-4 py-3 text-sm text-left',
            'disabled:opacity-40 disabled:pointer-events-none',
            'active:bg-accent',
            entry.destructive ? 'text-destructive' : 'text-foreground'
          )}
        >
          {entry.icon && (
            <entry.icon
              className={cn('h-4 w-4', entry.destructive ? 'text-destructive' : 'text-muted-foreground')}
            />
          )}
          <span className="flex-1">{entry.label}</span>
          {typeof entry.state === 'boolean' && (
            <span
              className={cn(
                'text-[10px] font-semibold uppercase tracking-wider',
                entry.state ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {entry.state ? 'ON' : 'OFF'}
            </span>
          )}
          {entry.shortcut && !entry.state && (
            <span className="text-xs text-muted-foreground">{entry.shortcut}</span>
          )}
        </button>
      );
    })}
  </div>
);

/* --------------------------------------------------------------------- */
/* Save-status pill (replaces the verbose 'Saving…' / 'Saved' text that  */
/* used to live in collaboration-header). Idle = nothing. Saving = small */
/* spinner. Saved = green dot + check; auto-fades back to idle upstream  */
/* (notes-drawer flips saveStatus after 2 s).                            */
/* --------------------------------------------------------------------- */

const SaveStatusPill: React.FC<{ status: 'idle' | 'saving' | 'saved' }> = ({ status }) => {
  const { t } = useTranslation();
  if (status === 'idle') return null;

  if (status === 'saving') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="notes-menu-save-status"
            data-state="saving"
            className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground"
            aria-label={t('notes.saving', 'Saving…')}
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom"><p className="text-xs">{t('notes.saving', 'Saving…')}</p></TooltipContent>
      </Tooltip>
    );
  }

  // saved
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="notes-menu-save-status"
          data-state="saved"
          className="inline-flex h-6 w-6 items-center justify-center text-green-600 dark:text-green-400"
          aria-label={t('notes.saved', 'Saved')}
        >
          <Check className="h-3.5 w-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom"><p className="text-xs">{t('notes.saved', 'Saved')}</p></TooltipContent>
    </Tooltip>
  );
};

/* --------------------------------------------------------------------- */
/* Main component                                                          */
/* --------------------------------------------------------------------- */

export const NoteMenuBar: React.FC<NoteMenuBarProps> = ({
  handlers,
  state,
  leading,
  trailing,
  pageHead,
  saveStatus = 'idle',
  className,
  ...rest
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [mobileOverflowOpen, setMobileOverflowOpen] = React.useState(false);
  const [mobileAiOpen, setMobileAiOpen] = React.useState(false);

  /* -------- Page-head: hidden file input for "Naslovna slika" -------- */
  // Native input lets us pick + upload without dragging the heavy
  // PageHeadToolbar UI into the menu. Click flow: menu item → input.click()
  // → onUploadHeaderImage(file) → onHeaderImageChange(url).
  const headerImageInputRef = React.useRef<HTMLInputElement | null>(null);
  const pickHeaderImage = React.useCallback(() => {
    headerImageInputRef.current?.click();
  }, []);
  const onHeaderImagePicked = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file || !pageHead) return;
      try {
        const url = await pageHead.handlers.onUploadHeaderImage(file);
        if (url) pageHead.handlers.onHeaderImageChange(url);
      } catch (err) {
        console.error('[NoteMenuBar] header image upload failed:', err);
      }
    },
    [pageHead],
  );

  /* -------- Section definitions (shared desktop + mobile) ----------- */

  const fileSection: MenuSection = {
    key: 'file',
    label: t('notes.menu.file', 'Datoteka'),
    entries: [
      { key: 'new', label: t('notes.menu.newBlank', 'New blank note'), icon: FileText, onClick: handlers.onNew, shortcut: 'Ctrl+N' },
      { key: 'newFromTemplate', label: t('notes.menu.newFromTemplate', 'New from template…'), icon: FileText, onClick: handlers.onNewFromTemplate, shortcut: 'Ctrl+Shift+N' },
      { key: 'open', label: t('notes.menu.open', 'Open…'), icon: FolderOpen, onClick: handlers.onOpen, shortcut: 'Ctrl+O' },
      { key: '__separator__', label: '', entries: [] as unknown as MenuEntryData[] } as unknown as MenuEntryData,
      { key: 'save', label: t('notes.menu.save', 'Save'), icon: Save, onClick: handlers.onSave, shortcut: 'Ctrl+S' },
      { key: 'saveAsTemplate', label: t('notes.menu.saveAsTemplate', 'Save as new template…'), icon: FileText, onClick: handlers.onSaveAsTemplate },
      { key: 'duplicate', label: t('notes.menu.duplicate', 'Duplicate'), icon: Copy, onClick: handlers.onDuplicate },
      { key: '__separator__', label: '', entries: [] as unknown as MenuEntryData[] } as unknown as MenuEntryData,
      {
        key: 'export',
        label: t('notes.menu.exportLabel', 'Export'),
        icon: Download,
        submenu: [
          { key: 'pdf', label: t('notes.menu.exportPdf', 'PDF'), icon: FileDown, onClick: handlers.onExport ? () => handlers.onExport?.('pdf') : undefined },
          { key: 'docx', label: t('notes.menu.exportDocx', 'Word document (.docx)'), icon: FileDown, onClick: handlers.onExport ? () => handlers.onExport?.('docx') : undefined },
          { key: 'markdown', label: t('notes.menu.exportMarkdown', 'Markdown + BibTeX'), icon: FileDown, onClick: handlers.onExport ? () => handlers.onExport?.('markdown') : undefined },
          { key: 'latex', label: t('notes.menu.exportLatex', 'LaTeX (.tex)'), icon: FileDown, onClick: handlers.onExport ? () => handlers.onExport?.('latex') : undefined },
          { key: 'latex-zip', label: t('notes.menu.exportLatexZip', 'LaTeX project (.zip for Overleaf)'), icon: FileDown, onClick: handlers.onExport ? () => handlers.onExport?.('latex-zip') : undefined },
          { key: 'html', label: t('notes.menu.exportHtml', 'HTML'), icon: FileDown, onClick: handlers.onExport ? () => handlers.onExport?.('html') : undefined },
        ],
      },
      { key: 'share', label: t('notes.menu.share', 'Share…'), icon: Share2, onClick: handlers.onShare },
      { key: 'print', label: t('notes.menu.print', 'Print…'), onClick: handlers.onPrint, shortcut: 'Ctrl+P' },
      { key: 'versionHistory', label: t('notes.menu.versionHistory', 'Version history…'), icon: History, onClick: handlers.onVersionHistory },
      { key: '__separator__', label: '', entries: [] as unknown as MenuEntryData[] } as unknown as MenuEntryData,
      { key: 'delete', label: t('notes.menu.delete', 'Delete'), icon: Trash2, onClick: handlers.onDelete, destructive: true },
    ],
  };

  // AI-driven whole-note actions. Retained as a standalone section because
  // the mobile layout still surfaces them behind the ✨ primary button;
  // the desktop layout folds them into the Tools menu as a "Generiraj"
  // submenu (see toolsSection.entries below).
  const aiSection: MenuSection = {
    key: 'ai',
    label: t('notes.menu.ai', 'AI'),
    entries: [
      {
        key: 'generateTitle',
        label: t('notes.menu.generateTitle', 'Generate title'),
        onClick: handlers.onGenerateTitle,
        description: t(
          'notes.menu.descriptions.generateTitle',
          'Reads the note and inserts a concise H1 title at the top. Prerequisite: at least a short paragraph of body text — the title is derived from existing content.'
        ),
      },
      {
        key: 'generateAbstract',
        label: t('notes.menu.generateAbstract', 'Generate abstract'),
        onClick: handlers.onGenerateAbstract,
        description: t(
          'notes.menu.descriptions.generateAbstract',
          'Summarises the note into a short abstract (blockquote) inserted just below the title. Prerequisite: a draft of at least a few paragraphs.'
        ),
      },
      {
        key: 'generateOutline',
        label: t('notes.menu.generateOutline', 'Generate outline'),
        onClick: handlers.onGenerateOutline,
        description: t(
          'notes.menu.descriptions.generateOutline',
          'Opens a template picker (IMRaD, literature review, etc.) and appends a structured outline based on your note. Prerequisite: at least 50 characters of content.'
        ),
      },
      {
        key: 'generateHighlights',
        label: t('notes.menu.generateHighlights', 'Generate key highlights'),
        onClick: handlers.onGenerateHighlights,
        description: t(
          'notes.menu.descriptions.generateHighlights',
          'Extracts the most important points of the note into a "Key highlights" section appended at the end. Prerequisite: a draft to summarise from.'
        ),
      },
      { key: '__separator__', label: '', entries: [] as unknown as MenuEntryData[] } as unknown as MenuEntryData,
      {
        key: 'composeFromSources',
        label: t('notes.menu.composeFromSources', 'Compose from sources…'),
        onClick: handlers.onComposeFromSources,
        description: t(
          'notes.menu.descriptions.composeFromSources',
          'Opens a dialog to draft a new section grounded in selected research sources. Prerequisite: pick a research context (collections / documents) so the model has sources to cite.'
        ),
      },
      {
        key: 'connectDots',
        label: t('notes.menu.connectDots', 'Connect dots'),
        onClick: handlers.onConnectDots,
        description: t(
          'notes.menu.descriptions.connectDots',
          'Surfaces non-obvious links between claims in the note and your research sources. Prerequisite: an active research context and a draft with at least a few claims.'
        ),
      },
      {
        key: 'factCheckWholeNote',
        label: t('notes.menu.factCheckWholeNote', 'Fact-check whole note'),
        onClick: handlers.onFactCheckWholeNote,
        description: t(
          'notes.menu.descriptions.factCheckWholeNote',
          'Verifies the factual claims in the note against your research sources and returns supporting / contradicting evidence. Prerequisite: a research context with sources.'
        ),
      },
      {
        key: 'critiqueWithQuestions',
        label: t('notes.menu.critiqueWithQuestions', 'Critique with questions'),
        onClick: handlers.onCritiqueWithQuestions,
        description: t(
          'notes.menu.descriptions.critiqueWithQuestions',
          'Generates 3–5 critical questions about your draft as a "review" callout at the end of the note. Prerequisite: at least 50 characters of content.'
        ),
      },
      { key: '__separator__', label: '', entries: [] as unknown as MenuEntryData[] } as unknown as MenuEntryData,
      {
        key: 'shortenToTarget',
        label: t('notes.menu.shortenToTarget', 'Shorten to target…'),
        onClick: handlers.onShortenToTarget,
        description: t(
          'notes.menu.descriptions.shortenToTarget',
          'Opens a dialog where you choose a target word count; rewrites the note shorter while keeping its core meaning. Prerequisite: a draft long enough that shortening makes sense.'
        ),
      },
      {
        key: 'translateWholeNote',
        label: t('notes.menu.translateWholeNote', 'Translate whole note'),
        onClick: handlers.onTranslateWholeNote,
        description: t(
          'notes.menu.descriptions.translateWholeNote',
          'Replaces the note content with a translation between English and Croatian (auto-picks the opposite of your current UI language). Prerequisite: at least 20 characters of content.'
        ),
      },
    ],
  };

  const toolsSection: MenuSection = {
    key: 'tools',
    label: t('notes.menu.tools', 'Alati'),
    entries: [
      { key: 'grammarCheck', label: t('notes.menu.grammarCheck', 'Grammar check'), onClick: handlers.onGrammarCheck },
      { key: 'nonNativeEnglishMode', label: t('notes.menu.nonNativeEnglishMode', 'Non-native English mode'), onClick: handlers.onToggleNonNativeEnglish, state: state?.nonNativeEnglishMode },
      { key: 'consistencyCheck', label: t('notes.menu.consistencyCheck', 'Consistency check'), onClick: handlers.onConsistencyCheck },
      { key: '__separator__', label: '', entries: [] as unknown as MenuEntryData[] } as unknown as MenuEntryData,
      { key: 'wordCountStats', label: t('notes.menu.wordCountStats', 'Word count & stats'), onClick: handlers.onWordCount },
      { key: 'findReplace', label: t('notes.menu.findReplace', 'Find & Replace…'), icon: Search, onClick: handlers.onFindReplace, shortcut: 'Ctrl+F' },
      { key: '__separator__', label: '', entries: [] as unknown as MenuEntryData[] } as unknown as MenuEntryData,
      // 7.6 — Fullscreen + Focus mode
      {
        key: 'fullscreen',
        label: state?.isFullscreen
          ? t('notes.menu.exitFullscreen', 'Exit fullscreen')
          : t('notes.menu.enterFullscreen', 'Fullscreen'),
        onClick: handlers.onToggleFullscreen,
        shortcut: 'Ctrl+Shift+F',
        state: state?.isFullscreen,
      },
      {
        key: 'focusMode',
        label: t('notes.menu.focusMode', 'Focus mode'),
        onClick: handlers.onToggleFocusMode,
        state: state?.isFocusMode,
      },
      {
        key: 'readingMode',
        label: t('notes.menu.readingMode', 'Reading mode'),
        onClick: handlers.onToggleReadingMode,
        state: state?.isReadingMode,
      },
      {
        key: 'sepiaMode',
        label: t('notes.menu.sepiaMode', 'Sepia theme'),
        onClick: handlers.onToggleSepiaMode,
        state: state?.isSepiaMode,
      },
      {
        key: 'aiAutocomplete',
        label:
          typeof state?.autocompleteQuotaLimit === 'number' &&
          state.autocompleteQuotaLimit > 0 &&
          typeof state.autocompleteQuotaUsed === 'number'
            ? t('notes.menu.aiAutocompleteWithQuota', '{{label}} ({{used}}/{{limit}} this hour)', {
                label: t('notes.menu.aiAutocomplete', 'AI autocomplete'),
                used: state.autocompleteQuotaUsed,
                limit: state.autocompleteQuotaLimit,
              })
            : t('notes.menu.aiAutocomplete', 'AI autocomplete'),
        onClick: handlers.onToggleAiAutocomplete,
        state: state?.isAiAutocompleteEnabled,
      },
      { key: '__separator__', label: '', entries: [] as unknown as MenuEntryData[] } as unknown as MenuEntryData,
      {
        key: 'generate',
        label: t('notes.menu.generate', 'Generiraj'),
        icon: Sparkles,
        submenu: aiSection.entries,
      },
      { key: '__separator__', label: '', entries: [] as unknown as MenuEntryData[] } as unknown as MenuEntryData,
      {
        key: 'researchContext',
        label: t('notes.menu.researchContext', 'Research context…'),
        icon: Compass,
        onClick: handlers.onChangeResearchContext,
      },
    ],
  };

  /* -------- Page-head section (mobile overflow only) ---------------- */
  // Mirrors the 7 actions in the floating PageHeadToolbar. The toolbar
  // returns null on mobile (no room above H1), so this section is the
  // primary surface for those actions on touch devices. On desktop the
  // section is omitted from overflowSections — the floating toolbar
  // still owns the hover UX.
  const pageSection: MenuSection | null = pageHead
    ? {
        key: 'page',
        label: t('notes.menu.page', 'Stranica'),
        entries: [
          {
            key: 'pageWidth',
            label: t('notes.menu.pageWidth', 'Širina stranice'),
            icon: Maximize2,
            submenu: [
              {
                key: 'paper',
                label: t('notes.pageHead.pageWidth.paper', 'Default'),
                onClick: () => pageHead.layout.onScreenWidthChange('paper'),
                state: pageHead.layout.screenWidth === 'paper',
              },
              {
                key: 'wide',
                label: t('notes.pageHead.pageWidth.wide', 'Wide'),
                onClick: () => pageHead.layout.onScreenWidthChange('wide'),
                state: pageHead.layout.screenWidth === 'wide',
              },
              {
                key: 'full',
                label: t('notes.pageHead.pageWidth.full', 'Full'),
                onClick: () => pageHead.layout.onScreenWidthChange('full'),
                state: pageHead.layout.screenWidth === 'full',
              },
            ],
          },
          {
            key: 'paperSize',
            label: t('notes.menu.paperSize', 'Veličina papira'),
            icon: RectangleHorizontal,
            submenu: [
              {
                key: 'A4',
                label: 'A4',
                onClick: () => pageHead.layout.onPaperSizeChange('A4'),
                state: pageHead.layout.paperSize === 'A4',
              },
              {
                key: 'A3',
                label: 'A3',
                onClick: () => pageHead.layout.onPaperSizeChange('A3'),
                state: pageHead.layout.paperSize === 'A3',
              },
              {
                key: 'A5',
                label: 'A5',
                onClick: () => pageHead.layout.onPaperSizeChange('A5'),
                state: pageHead.layout.paperSize === 'A5',
              },
            ],
          },
          {
            key: 'orientation',
            label: t('notes.menu.orientation', 'Orijentacija'),
            icon: RectangleHorizontal,
            submenu: [
              {
                key: 'portrait',
                label: t('notes.pageHead.orientation.portrait', 'Portrait'),
                onClick: () => pageHead.layout.onOrientationChange('portrait'),
                state: pageHead.layout.orientation === 'portrait',
              },
              {
                key: 'landscape',
                label: t('notes.pageHead.orientation.landscape', 'Landscape'),
                onClick: () => pageHead.layout.onOrientationChange('landscape'),
                state: pageHead.layout.orientation === 'landscape',
              },
            ],
          },
          { key: '__separator__', label: '', entries: [] as unknown as MenuEntryData[] } as unknown as MenuEntryData,
          {
            key: 'emoji',
            label: pageHead.value.emoji
              ? t('notes.menu.changeEmoji', 'Promijeni emoji')
              : t('notes.menu.addEmoji', 'Dodaj emoji'),
            icon: Smile,
            submenu: [
              ...PAGE_HEAD_EMOJI_QUICK.map((em) => ({
                key: `em-${em}`,
                label: em,
                onClick: () => pageHead.handlers.onEmojiChange(em),
                state: pageHead.value.emoji === em,
              })),
              ...(pageHead.value.emoji
                ? [
                    { key: '__separator__', label: '', entries: [] as unknown as MenuEntryData[] } as unknown as MenuEntryData,
                    {
                      key: 'removeEmoji',
                      label: t('notes.menu.removeEmoji', 'Ukloni emoji'),
                      destructive: true,
                      onClick: () => pageHead.handlers.onEmojiChange(null),
                    } as MenuEntryData,
                  ]
                : []),
            ],
          },
          {
            key: 'headerImage',
            label: pageHead.value.headerImageUrl
              ? t('notes.menu.changeHeaderImage', 'Promijeni naslovnu sliku')
              : t('notes.menu.addHeaderImage', 'Naslovna slika'),
            icon: ImageIcon,
            onClick: pickHeaderImage,
          },
          ...(pageHead.value.headerImageUrl
            ? [
                {
                  key: 'removeHeaderImage',
                  label: t('notes.menu.removeHeaderImage', 'Ukloni naslovnu sliku'),
                  icon: Trash2,
                  destructive: true,
                  onClick: () => pageHead.handlers.onHeaderImageChange(null),
                } as MenuEntryData,
              ]
            : []),
          {
            key: 'suggestTitle',
            label: t('notes.menu.suggestTitle', 'Predloži naslov'),
            icon: Wand2,
            onClick: pageHead.handlers.onSuggestTitle,
          },
          { key: '__separator__', label: '', entries: [] as unknown as MenuEntryData[] } as unknown as MenuEntryData,
          {
            key: 'fontScale',
            label: t('notes.menu.fontScale', 'Veličina teksta'),
            icon: Type,
            submenu: [
              {
                key: 'small',
                label: t('notes.pageHead.fontScale.small', 'Small'),
                onClick: () => pageHead.handlers.onFontScaleChange('small'),
                state: pageHead.value.fontScale === 'small',
              },
              {
                key: 'default',
                label: t('notes.pageHead.fontScale.default', 'Default'),
                onClick: () => pageHead.handlers.onFontScaleChange('default'),
                state: (pageHead.value.fontScale ?? 'default') === 'default',
              },
              {
                key: 'large',
                label: t('notes.pageHead.fontScale.large', 'Large'),
                onClick: () => pageHead.handlers.onFontScaleChange('large'),
                state: pageHead.value.fontScale === 'large',
              },
              {
                key: 'xlarge',
                label: t('notes.pageHead.fontScale.xlarge', 'X-Large'),
                onClick: () => pageHead.handlers.onFontScaleChange('xlarge'),
                state: pageHead.value.fontScale === 'xlarge',
              },
            ],
          },
        ],
      }
    : null;

  // Desktop overflow stays at File + Tools. Page-head section is only
  // inserted on mobile, where the floating toolbar is hidden.
  const overflowSections =
    isMobile && pageSection
      ? [fileSection, pageSection, toolsSection]
      : [fileSection, toolsSection];

  /* -------- Desktop layout ---------------------------------------- */

  if (!isMobile) {
    return (
      <div
        data-testid="notes-menu-bar"
        {...rest}
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background',
          className
        )}
      >
        {/* Leading slot. sr-only content (e.g. the screen-reader
            drawer title) has no visible width — skip the wrapper so
            it doesn't push the menu group inward. */}
        {leading && <div className="flex items-center gap-2 flex-shrink-0">{leading}</div>}

        {/* Menus (left) — single Menubar container so hovering adjacent
            triggers while one menu is open auto-opens the next (MS Word
            convention). Override the shadcn default bordered/padded
            container since we live inside the header bar.
            -ml-2 + first:pl-1 on the trigger pulls 'Datoteka' close to
            the drawer's left edge so its inset visually matches the
            close 'X' on the right side. */}
        <Menubar className="flex items-center gap-1 flex-shrink-0 border-0 bg-transparent p-0 h-auto shadow-none -ml-2 [&>div:first-child>button]:pl-1">
          <DesktopMenu section={fileSection} testId="notes-menu-file" />
          <DesktopMenu section={toolsSection} testId="notes-menu-tools" />
        </Menubar>

        {/* Trailing (right). Save-status icon sits leftmost so it
            doesn't shift the layout when it appears / disappears. */}
        <div className="flex items-center gap-2 ml-auto text-xs text-muted-foreground">
          <SaveStatusPill status={saveStatus} />
          {state?.saveIndicator && (
            <span data-testid="notes-menu-save-indicator" className="hidden sm:inline">
              {state.saveIndicator}
            </span>
          )}
          {trailing}
        </div>
      </div>
    );
  }

  /* -------- Mobile layout ---------------------------------------- */
  //
  // Three-zone hierarchy (Apple HIG / Material 5 top-app-bar convention):
  //
  //   [ ← ] │ [ +  📁 ]      …      [ ✨ ] │ [ ⋯ ]
  //   nav     file ops      spacer    primary   overflow
  //
  // - 44 px touch targets (Apple HIG min, was 40 px).
  // - File ops grouped inside a single inset cluster with a vertical
  //   divider — reads as ONE logical unit, not two free-floating icons.
  // - Vertical hairline dividers between zones reinforce hierarchy without
  //   adding visual weight (borders > shadows per README_STYLE rule 11).
  // - Primary AI button keeps the accent tint AND gets ring emphasis so
  //   it clearly outranks the ghost neighbours (README_STYLE: one primary
  //   CTA per zone).

  return (
    <div
      data-testid="notes-menu-bar"
      {...rest}
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 border-b border-border bg-background',
        className
      )}
    >
      {/* Zone 1 — Back navigation */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-11 w-11 flex-shrink-0"
        data-testid="notes-menu-back-button"
        onClick={handlers.onBack}
        aria-label={t('notes.menu.back', 'Back')}
      >
        <ArrowLeft className="h-5 w-5" />
      </Button>

      {/* Vertical divider between Back and file-ops cluster */}
      {(handlers.onNew || handlers.onOpen) && (
        <span aria-hidden className="h-6 w-px bg-border/70 flex-shrink-0" />
      )}

      {/* Zone 2 — File ops cluster. Plain icons, no border / fill;
          the vertical hairline divider on either side already groups
          them visually without adding a frame. */}
      {(handlers.onNew || handlers.onOpen) && (
        <div className="flex items-center flex-shrink-0">
          {handlers.onNew && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-11 w-11 flex-shrink-0"
              data-testid="notes-menu-mobile-new-button"
              onClick={handlers.onNew}
              aria-label={t('notes.menu.newBlank', 'New blank note')}
            >
              <FilePlus className="h-5 w-5" />
            </Button>
          )}
          {handlers.onOpen && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-11 w-11 flex-shrink-0"
              data-testid="notes-menu-mobile-open-button"
              onClick={handlers.onOpen}
              aria-label={t('notes.menu.open', 'Open…')}
            >
              <FolderOpen className="h-5 w-5" />
            </Button>
          )}
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Zone 3 — AI + overflow. The AI button used to carry a
          filled-tint treatment (border + bg) as the primary action;
          per user feedback it now matches the rest of the row's
          ghost styling. Accent stays on the icon colour alone so the
          button is still recognisable as the "smart" affordance
          without weighing down the header. */}
      <DropdownMenu open={mobileAiOpen} onOpenChange={setMobileAiOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 flex-shrink-0 text-primary hover:text-primary hover:bg-accent"
            data-testid="notes-menu-mobile-ai-button"
            aria-label={t('notes.menu.aiActionsTitle', 'AI — whole note')}
          >
            <Sparkles className="h-5 w-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-72 max-w-[80vw] max-h-[70vh] overflow-y-auto z-[10050] notes-popover" data-notes-popover="true">
          {aiSection.entries.map((entry, idx) => {
            if (entry.key === '__separator__') {
              return <DropdownMenuSeparator key={`sep-${idx}`} />;
            }
            // Touch has no hover, so the desktop "?" tooltip carrying
            // the prerequisite + outcome description doesn't reach a
            // mobile user. Render the description inline below the
            // label so the affordance is preserved.
            return (
              <DropdownMenuItem
                key={entry.key}
                onClick={entry.onClick}
                disabled={!entry.onClick}
                data-testid={`notes-menu-mobile-ai-${entry.key}`}
                className="items-start gap-2 py-2"
              >
                {entry.icon && <entry.icon className="mt-0.5 h-4 w-4 shrink-0" />}
                <div className="min-w-0 flex flex-col">
                  <span className="text-sm leading-snug">{entry.label}</span>
                  {entry.description && (
                    <span className="text-[11px] leading-snug text-muted-foreground whitespace-normal mt-0.5">
                      {entry.description}
                    </span>
                  )}
                </div>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Save indicator — tiny pill that pops between AI and overflow
          when the autosave fires. Doesn't take up layout space when
          idle (component returns null). */}
      <SaveStatusPill status={saveStatus} />

      {/* Divider before the overflow ⋯ — keeps it visually separate from
          the primary AI button so the row reads as two distinct zones. */}
      <span aria-hidden className="h-6 w-px bg-border/70 flex-shrink-0" />

      {/* Overflow — DropdownMenu */}
      <DropdownMenu open={mobileOverflowOpen} onOpenChange={setMobileOverflowOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 flex-shrink-0"
            data-testid="notes-menu-mobile-overflow-button"
            aria-label={t('notes.menu.moreActions', 'More actions')}
          >
            <MoreHorizontal className="h-5 w-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-64 max-h-[70vh] overflow-y-auto z-[10050] notes-popover" data-notes-popover="true">
          {overflowSections.flatMap((section) => {
            const items: React.ReactElement[] = [];
            items.push(
              <div
                key={`${section.key}-label`}
                className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground"
              >
                {section.label}
              </div>
            );
            section.entries.forEach((entry, idx) => {
              if (entry.key === '__separator__') {
                items.push(<DropdownMenuSeparator key={`${section.key}-sep-${idx}`} />);
                return;
              }
              // Skip the desktop "Generiraj" submenu on mobile overflow —
              // the same entries are already surfaced by the primary ✨
              // button next to the overflow trigger. Including them here
              // would double up every AI action in the ⋯ sheet. Also drop
              // the now-orphaned separator that used to precede it.
              if (entry.key === 'generate') {
                const last = items[items.length - 1];
                if (last && (last.key || '').toString().includes('-sep-')) {
                  items.pop();
                }
                return;
              }
              if (entry.submenu) {
                entry.submenu.forEach((sub) => {
                  items.push(
                    <DropdownMenuItem
                      key={`${section.key}-${entry.key}-${sub.key}`}
                      onClick={sub.onClick}
                      disabled={!sub.onClick}
                      data-testid={`notes-menu-mobile-overflow-${section.key}-${entry.key}-${sub.key}`}
                    >
                      {sub.icon && <sub.icon className="mr-2 h-4 w-4" />}
                      <span>{sub.label}</span>
                    </DropdownMenuItem>
                  );
                });
                return;
              }
              items.push(
                <DropdownMenuItem
                  key={`${section.key}-${entry.key}`}
                  onClick={entry.onClick}
                  disabled={!entry.onClick}
                  data-testid={`notes-menu-mobile-overflow-${section.key}-${entry.key}`}
                  className={cn(entry.destructive && 'text-destructive focus:text-destructive')}
                >
                  {entry.icon && <entry.icon className="mr-2 h-4 w-4" />}
                  <span>{entry.label}</span>
                </DropdownMenuItem>
              );
            });
            return items;
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Hidden file input feeding the "Naslovna slika" overflow item.
          Rendered once so both desktop + mobile share the same picker. */}
      {pageHead && (
        <input
          ref={headerImageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onHeaderImagePicked}
          data-testid="notes-menu-header-image-input"
        />
      )}
    </div>
  );
};

export default NoteMenuBar;
