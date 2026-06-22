/**
 * Slash command menu for TipTap editor
 * Provides Notion-like / command interface for quick formatting
 */

import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Editor } from '@tiptap/react';
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Code,
  Minus,
  CheckSquare,
  Table as TableIcon,
  Type,
  ChevronRight,
  ChevronLeft,
  Info,
  AlertTriangle,
  CheckCircle,
  XCircle,
  FileText,
  Image as ImageIcon,
  FileCode,
  ListEnd,
  Search,
  BookOpen,
  ShieldCheck,
  FileSearch,
  Lightbulb,
  MessageSquare,
  Upload,
  Sparkles,
  GitBranchPlus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPageAtPos } from './extensions/page-break-decoration';
import { useTranslation } from 'react-i18next';
import { TFunction } from 'i18next';


interface CommandItem {
  /** i18n key suffix (e.g., "research", "cite") for cross-language search */
  key: string;
  title: string;
  description: string;
  icon: React.ElementType;
  /** If present, this is a leaf command that executes directly. */
  command?: (editor: Editor, openMarkdownImport?: () => void, openBibImport?: () => void) => void;
  /** If present, this is a group that opens a sub-menu. */
  children?: CommandItem[];
}

/** Flatten a tree of commands into all executable leaves (for global search). */
function flattenLeaves(items: CommandItem[]): CommandItem[] {
  const out: CommandItem[] = [];
  for (const item of items) {
    if (item.children) {
      out.push(...flattenLeaves(item.children));
    } else if (item.command) {
      out.push(item);
    }
  }
  return out;
}

/** Extract context text from the editor — uses selection when present, otherwise the current page. */
function getContextFromEditor(editor: Editor): { context: string; from: number; to: number } {
  const { from, to } = editor.state.selection;
  let context: string;
  if (to > from) {
    context = editor.state.doc.textBetween(from, to, '\n');
  } else {
    const view = editor.view;
    const pageInfo = getPageAtPos(view, from);
    context = editor.state.doc.textBetween(
      pageInfo.startPos,
      Math.min(pageInfo.endPos, editor.state.doc.content.size),
      '\n'
    );
  }
  return { context: context.trim(), from, to };
}

const getCommands = (t: TFunction): CommandItem[] => [
  {
    key: 'text',
    title: t('notes.slashCommands.text'),
    description: t('notes.slashCommands.textDesc'),
    icon: Type,
    command: (editor) => editor.chain().focus().setParagraph().run(),
  },
  {
    key: 'heading1',
    title: t('notes.slashCommands.heading1'),
    description: t('notes.slashCommands.heading1Desc'),
    icon: Heading1,
    command: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    key: 'heading2',
    title: t('notes.slashCommands.heading2'),
    description: t('notes.slashCommands.heading2Desc'),
    icon: Heading2,
    command: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    key: 'heading3',
    title: t('notes.slashCommands.heading3'),
    description: t('notes.slashCommands.heading3Desc'),
    icon: Heading3,
    command: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    key: 'bulletList',
    title: t('notes.slashCommands.bulletList'),
    description: t('notes.slashCommands.bulletListDesc'),
    icon: List,
    command: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    key: 'numberedList',
    title: t('notes.slashCommands.numberedList'),
    description: t('notes.slashCommands.numberedListDesc'),
    icon: ListOrdered,
    command: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    key: 'groupCite',
    title: t('notes.slashCommands.groupCite'),
    description: t('notes.slashCommands.groupCiteDesc'),
    icon: Quote,
    children: [
      {
        key: 'quote',
        title: t('notes.slashCommands.quote'),
        description: t('notes.slashCommands.quoteDesc'),
        icon: Quote,
        command: (editor) => {
          // Insert blockquote and show citation source chooser
          editor.chain().focus().toggleBlockquote().run();
          // Dispatch event to show the inline citation source bar
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('show-quote-citation-bar'));
          }, 50);
        },
      },
      {
        key: 'cite',
        title: t('notes.slashCommands.cite'),
        description: t('notes.slashCommands.citeDesc'),
        icon: BookOpen,
        command: (editor) => {
          const { from } = editor.state.selection;
          const lineText = editor.state.doc.textBetween(Math.max(0, from - 200), from, ' ').trim();
          const query = lineText.split('\n').pop()?.trim() || '';
          window.dispatchEvent(new CustomEvent('notes-ai-citation', {
            detail: { selectedText: query, from, to: from },
          }));
        },
      },
    ],
  },
  {
    key: 'codeBlock',
    title: t('notes.slashCommands.codeBlock'),
    description: t('notes.slashCommands.codeBlockDesc'),
    icon: Code,
    command: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    key: 'divider',
    title: t('notes.slashCommands.divider'),
    description: t('notes.slashCommands.dividerDesc'),
    icon: Minus,
    command: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
  {
    key: 'taskList',
    title: t('notes.slashCommands.taskList'),
    description: t('notes.slashCommands.taskListDesc'),
    icon: CheckSquare,
    command: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    key: 'table',
    title: t('notes.slashCommands.table'),
    description: t('notes.slashCommands.tableDesc'),
    icon: TableIcon,
    command: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    key: 'toggleList',
    title: t('notes.slashCommands.toggleList'),
    description: t('notes.slashCommands.toggleListDesc'),
    icon: ChevronRight,
    command: (editor) => editor.chain().focus().insertToggle().run(),
  },
  {
    key: 'groupCallouts',
    title: t('notes.slashCommands.groupCallouts'),
    description: t('notes.slashCommands.groupCalloutsDesc'),
    icon: MessageSquare,
    children: [
      {
        key: 'infoCallout',
        title: t('notes.slashCommands.infoCallout'),
        description: t('notes.slashCommands.infoCalloutDesc'),
        icon: Info,
        command: (editor) => editor.chain().focus().insertCallout('info').run(),
      },
      {
        key: 'warningCallout',
        title: t('notes.slashCommands.warningCallout'),
        description: t('notes.slashCommands.warningCalloutDesc'),
        icon: AlertTriangle,
        command: (editor) => editor.chain().focus().insertCallout('warning').run(),
      },
      {
        key: 'successCallout',
        title: t('notes.slashCommands.successCallout'),
        description: t('notes.slashCommands.successCalloutDesc'),
        icon: CheckCircle,
        command: (editor) => editor.chain().focus().insertCallout('success').run(),
      },
      {
        key: 'errorCallout',
        title: t('notes.slashCommands.errorCallout'),
        description: t('notes.slashCommands.errorCalloutDesc'),
        icon: XCircle,
        command: (editor) => editor.chain().focus().insertCallout('error').run(),
      },
      {
        key: 'noteCallout',
        title: t('notes.slashCommands.noteCallout'),
        description: t('notes.slashCommands.noteCalloutDesc'),
        icon: FileText,
        command: (editor) => editor.chain().focus().insertCallout('default').run(),
      },
    ],
  },
  {
    key: 'image',
    title: t('notes.slashCommands.image'),
    description: t('notes.slashCommands.imageDesc'),
    icon: ImageIcon,
    command: (editor) => {
      // Trigger file picker
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          try {
            // Import dynamically to avoid circular dependency
            const { uploadImage } = await import('./extensions/image-upload-handler');
            const { url } = await uploadImage(file);
            editor.chain().focus().setEnhancedImage({ src: url }).run();
          } catch (error) {
            console.error('Image upload failed:', error);
            alert(error instanceof Error ? error.message : t('notes.slashCommands.imageUploadFailed'));
          }
        }
      };
      input.click();
    },
  },
  {
    key: 'groupImport',
    title: t('notes.slashCommands.groupImport'),
    description: t('notes.slashCommands.groupImportDesc'),
    icon: Upload,
    children: [
      {
        key: 'importMarkdown',
        title: t('notes.slashCommands.importMarkdown'),
        description: t('notes.slashCommands.importMarkdownDesc'),
        icon: FileCode,
        command: (editor, openMarkdownImport) => {
          if (openMarkdownImport) {
            openMarkdownImport();
          }
        },
      },
      {
        key: 'importBibtex',
        title: t('notes.slashCommands.importBibtex'),
        description: t('notes.slashCommands.importBibtexDesc'),
        icon: FileText,
        command: (editor, _, openBibImport) => {
          if (openBibImport) {
            openBibImport();
          }
        },
      },
      {
        key: 'bibliography',
        title: t('notes.slashCommands.bibliography'),
        description: t('notes.slashCommands.bibliographyDesc'),
        icon: ListEnd,
        command: (editor) => {
          editor.chain().focus().insertContent({ type: 'bibliographyNode' }).run();
        },
      },
    ],
  },
  // ─── AI Research Commands ─────────────────────────────────────────────
  {
    key: 'groupAiTools',
    title: t('notes.slashCommands.groupAiTools'),
    description: t('notes.slashCommands.groupAiToolsDesc'),
    icon: Sparkles,
    children: [
      {
        key: 'research',
        title: t('notes.slashCommands.research'),
        description: t('notes.slashCommands.researchDesc'),
        icon: Search,
        command: (editor) => {
          const { from } = editor.state.selection;
          const lineText = editor.state.doc.textBetween(Math.max(0, from - 200), from, ' ').trim();
          const query = lineText.split('\n').pop()?.trim() || '';
          window.dispatchEvent(new CustomEvent('notes-ai-research', {
            detail: { selectedText: query, from, to: from },
          }));
        },
      },
      {
        key: 'verify',
        title: t('notes.slashCommands.verify'),
        description: t('notes.slashCommands.verifyDesc'),
        icon: ShieldCheck,
        command: (editor) => {
          const { from } = editor.state.selection;
          const lineText = editor.state.doc.textBetween(Math.max(0, from - 200), from, ' ').trim();
          const claim = lineText.split('\n').pop()?.trim() || '';
          window.dispatchEvent(new CustomEvent('notes-ai-verify', {
            detail: { selectedText: claim, from, to: from },
          }));
        },
      },
      {
        key: 'summarize',
        title: t('notes.slashCommands.summarize'),
        description: t('notes.slashCommands.summarizeDesc'),
        icon: FileSearch,
        command: (editor) => {
          const { from, to } = editor.state.selection;
          const text = from !== to
            ? editor.state.doc.textBetween(from, to, ' ')
            : editor.state.doc.textBetween(Math.max(0, from - 500), from, ' ');
          window.dispatchEvent(new CustomEvent('notes-ai-transform', {
            detail: { selectedText: text.trim(), from, to, transformType: 'simplify' },
          }));
        },
      },
      {
        key: 'hypothesis',
        title: t('notes.slashCommands.hypothesis'),
        description: t('notes.slashCommands.hypothesisDesc'),
        icon: Lightbulb,
        command: (editor) => {
          const { context, from } = getContextFromEditor(editor);
          window.dispatchEvent(new CustomEvent('notes-ai-hypothesis', {
            detail: { context, from, to: from },
          }));
        },
      },
      {
        key: 'what-if',
        title: t('notes.slashCommands.whatIf'),
        description: t('notes.slashCommands.whatIfDesc'),
        icon: GitBranchPlus,
        command: (editor) => {
          const { context, from } = getContextFromEditor(editor);
          window.dispatchEvent(new CustomEvent('notes-ai-what-if', {
            detail: { context, from, to: from },
          }));
        },
      },
      {
        key: 'outline',
        title: t('notes.slashCommands.outline'),
        description: t('notes.slashCommands.outlineDesc'),
        icon: List,
        command: (editor) => {
          const content = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
          window.dispatchEvent(new CustomEvent('notes-ai-outline', {
            detail: { context: content.substring(0, 4000).trim() },
          }));
        },
      },
    ],
  },
];

// eslint-disable-next-line react-refresh/only-export-components -- factory function used inside component
export { getCommands };

interface SlashCommandsProps {
  editor: Editor;
  range: { from: number; to: number };
  query: string;
  onClose: () => void;
  onOpenMarkdownImport?: () => void;
  onOpenBibImport?: () => void;
}

export const SlashCommands = forwardRef<{ onKeyDown: (props: { event: KeyboardEvent }) => boolean }, SlashCommandsProps>(
  ({ editor, range, query, onClose, onOpenMarkdownImport, onOpenBibImport }, ref) => {
    const { t, i18n } = useTranslation();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [activeGroup, setActiveGroup] = useState<CommandItem | null>(null);
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const commands = getCommands(t);

    // Normalize diacritics for search (e.g., "saz" matches "Sažmi", "cit" matches "Citiraj")
    const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const normalizedQuery = normalize(query);

    // Cross-language search: collect translations from all languages for each command's key.
    // This lets users find commands regardless of UI language (e.g., "sum" finds "Summarize" in HR mode).
    const allLanguages = (i18n.options.supportedLngs || ['en', 'hr']).filter(
      (lng): lng is string => typeof lng === 'string' && lng !== 'cimode'
    );
    const langBundles = allLanguages.map(lng => {
      const bundle = i18n.getResourceBundle(lng, 'translation');
      return bundle?.notes?.slashCommands as Record<string, string> | undefined;
    });

    const matchesQuery = (command: CommandItem): boolean => {
      if (normalize(command.title).includes(normalizedQuery) ||
          normalize(command.description).includes(normalizedQuery)) {
        return true;
      }
      // Match against all languages using the command's i18n key
      if (command.key) {
        const titleKey = command.key;
        const descKey = `${command.key}Desc`;
        for (const bundle of langBundles) {
          if (!bundle) continue;
          const title = bundle[titleKey];
          const desc = bundle[descKey];
          if ((title && normalize(title).includes(normalizedQuery)) ||
              (desc && normalize(desc).includes(normalizedQuery))) {
            return true;
          }
        }
      }
      return false;
    };

    // Decide which items to show:
    // - If the user is typing a query, search flattens the tree and shows all matching leaves.
    // - If the user has entered a group, show that group's children.
    // - Otherwise show the top-level commands + group headers.
    let filteredCommands: CommandItem[];
    if (normalizedQuery) {
      filteredCommands = flattenLeaves(commands).filter(matchesQuery);
    } else if (activeGroup && activeGroup.children) {
      filteredCommands = activeGroup.children;
    } else {
      filteredCommands = commands;
    }

    const selectItem = (index: number) => {
      const command = filteredCommands[index];
      if (!command) return;

      // Group item — enter sub-menu instead of executing
      if (command.children && command.children.length > 0) {
        setActiveGroup(command);
        setSelectedIndex(0);
        return;
      }

      if (command.command) {
        // Delete the slash + query text via a direct transaction so it
        // doesn't depend on editor focus (chain().focus().deleteRange()
        // silently no-ops when focus() fails mid-chain, e.g. when the
        // user clicks the menu and focus is still on the button).
        const { from, to } = range;
        const docSize = editor.state.doc.content.size;
        if (from >= 0 && to <= docSize && from < to) {
          editor.view.dispatch(editor.state.tr.delete(from, to));
        }
        editor.commands.focus();
        // Execute the command
        command.command(editor, onOpenMarkdownImport, onOpenBibImport);
        onClose();
      }
    };

    const exitGroup = () => {
      setActiveGroup(null);
      setSelectedIndex(0);
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === 'ArrowUp') {
          setSelectedIndex((selectedIndex + filteredCommands.length - 1) % filteredCommands.length);
          return true;
        }

        if (event.key === 'ArrowDown') {
          setSelectedIndex((selectedIndex + 1) % filteredCommands.length);
          return true;
        }

        if (event.key === 'Enter') {
          selectItem(selectedIndex);
          return true;
        }

        // Left arrow or Backspace on empty query inside a group → go back to top level
        if (activeGroup && (event.key === 'ArrowLeft' || (event.key === 'Backspace' && !normalizedQuery))) {
          exitGroup();
          return true;
        }

        // Right arrow on a group item → open the group
        if (event.key === 'ArrowRight' && !activeGroup) {
          const cmd = filteredCommands[selectedIndex];
          if (cmd?.children?.length) {
            setActiveGroup(cmd);
            setSelectedIndex(0);
            return true;
          }
        }

        if (event.key === 'Escape') {
          if (activeGroup) {
            exitGroup();
          } else {
            onClose();
          }
          return true;
        }

        return false;
      },
    }));

    useEffect(() => {
      setSelectedIndex(0);
    }, [query]);

    // Auto-scroll to selected item when using keyboard navigation
    useEffect(() => {
      const selectedElement = itemRefs.current[selectedIndex];
      if (selectedElement) {
        selectedElement.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      }
    }, [selectedIndex]);

    if (filteredCommands.length === 0) {
      return null;
    }

    const showBackHeader = activeGroup && !normalizedQuery;

    return (
      <div data-testid="notes-slash-commands" className="z-50 min-w-[280px] max-w-[320px] overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
        {showBackHeader && activeGroup && (
          <button
            onClick={exitGroup}
            className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            type="button"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            <span className="flex-1">{activeGroup.title}</span>
          </button>
        )}
        <div className="max-h-[400px] overflow-y-auto p-1">
          {filteredCommands.map((command, index) => {
            const Icon = command.icon;
            const isGroup = Boolean(command.children && command.children.length > 0);
            return (
              <button
                key={command.key}
                ref={(el) => (itemRefs.current[index] = el)}
                onClick={() => selectItem(index)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  index === selectedIndex && 'bg-accent text-accent-foreground'
                )}
                type="button"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{command.title}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {command.description}
                  </div>
                </div>
                {isGroup && (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }
);

SlashCommands.displayName = 'SlashCommands';
