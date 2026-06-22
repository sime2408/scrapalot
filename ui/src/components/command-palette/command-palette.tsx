/**
 * Global Command Palette (Cmd+K / Ctrl+K).
 *
 * Mounted once at the app shell so every authenticated page gets the
 * shortcut. Built on the existing `<Command>` (cmdk) primitive used by
 * library-view.tsx and slash-commands.
 *
 * Action groups (v1 — fixed registry; a future plugin-style
 * registerCommand pattern can be added later if/when feature owners
 * actually need it):
 *
 *   Navigation     Home / Library / Notes / Settings / Admin (admin-only)
 *   Workspaces     list user's workspaces, switch on click
 *   Collections    list current workspace's collections, focus chat
 *   Notes          recently-opened notes (top 8 from local recents)
 *   Actions        New chat, New note, Open Knowledge Stacks dialog
 *   Help           Documentation, Send feedback
 *
 * Recently-used commands float to the top via a simple LRU stored in
 * localStorage['scrapalot_command_palette_recent'] (top 30 entries).
 */
import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Home,
  BookOpen,
  StickyNote,
  Settings,
  Shield,
  Layers,
  FolderOpen,
  Plus,
  HelpCircle,
  type LucideIcon,
} from 'lucide-react';

import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';

import { useWorkspace } from '@/hooks/use-workspace';
import { useNotesDrawer } from '@/hooks/use-notes-drawer';
import { useAuth } from '@/hooks/use-auth';
import { useAdminCheck } from '@/hooks/use-admin-check';
import { getRecentDocuments, type RecentDocument } from '@/lib/api-document-views';
import { getDocumentById } from '@/lib/api-documents';

const RECENT_KEY = 'scrapalot_command_palette_recent';
const MAX_RECENT = 30;

type CommandKind = 'navigation' | 'recentDoc' | 'action' | 'help';

interface PaletteCommand {
  /** Stable id used by the recent-LRU; keep it deterministic across
   *  renders (don't include random data). For dynamic commands like
   *  workspace switching we encode the id (e.g. `ws:<uuid>`). */
  id: string;
  kind: CommandKind;
  /** Translated label shown in the palette. */
  label: string;
  /** Optional secondary text (e.g. workspace count, current selection). */
  hint?: string;
  /** Lucide icon component. */
  icon: LucideIcon;
  /** Extra search keywords cmdk's fuzzy matcher should consider. */
  keywords?: string[];
  /** Optional shortcut hint shown on the right (purely informational —
   *  the actual shortcut is registered separately). */
  shortcut?: string;
  /** Click handler. Receives the close callback so the action can defer
   *  visible side effects until after the palette dismisses (avoids
   *  flash-of-stale-state when navigating). */
  run: (close: () => void) => void;
}

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string): void {
  try {
    const cur = readRecent().filter(x => x !== id);
    cur.unshift(id);
    localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, MAX_RECENT)));
  } catch {
    // ignore storage errors (private mode, quota)
  }
}

export const CommandPalette: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  // Workspace context only exposes the current workspace, not the
  // multi-workspace list. v1 of the palette intentionally drops the
  // 'switch workspace' group since users have an existing selector;
  // when we want it here we'll load `getWorkspaces()` once on first
  // open and cache the result.
  useWorkspace();
  const notesDrawer = useNotesDrawer();
  const isAdmin = useAdminCheck();

  const [open, setOpen] = React.useState(false);
  // Recent docs are fetched lazily on first open and
  // re-fetched on every subsequent open. The 60s response cache in
  // api.ts means rapid re-opens don't hammer the BE.
  const [recentDocs, setRecentDocs] = React.useState<RecentDocument[]>([]);
  // Document name lookup: the /document-views/recent endpoint only
  // returns IDs (Kotlin owns recents, Python owns documents — no cheap
  // join). We hydrate the names client-side via getDocumentById() and
  // memoize the result so reopening the palette is instant.
  const [docNames, setDocNames] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const list = await getRecentDocuments(8);
      if (cancelled) return;
      setRecentDocs(list);
      // Fetch missing names in parallel; the 60 s api response cache
      // makes repeat opens free.
      const missing = list
        .map(r => r.document_id)
        .filter(id => !docNames[id]);
      if (missing.length === 0) return;
      const results = await Promise.all(
        missing.map(async id => {
          try {
            const doc = await getDocumentById(id);
            // Backend (Python) returns snake_case `file_name`; the
            // older `title` / `filename` lookups left names blank in
            // production. There's no human-friendly title field on
            // this endpoint, so the filename is the best label
            // available. We strip the extension only when the name is
            // long enough to benefit, otherwise short stems like
            // "rfc.pdf" lose useful context.
            const fileName =
              (typeof doc.file_name === 'string' && doc.file_name.trim()) ||
              (typeof doc.filename === 'string' && doc.filename.trim()) ||
              (typeof doc.title === 'string' && doc.title.trim()) ||
              null;
            return [id, fileName] as const;
          } catch {
            return [id, null] as const;
          }
        })
      );
      if (cancelled) return;
      setDocNames(prev => {
        const next = { ...prev };
        for (const [id, name] of results) {
          if (name) next[id] = name;
        }
        return next;
      });
    })();
    return () => { cancelled = true; };
  // docNames intentionally omitted: re-fetching on every name update
  // would loop. We only refresh on open changes; new IDs are detected
  // inside the effect body via the missing-filter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Cmd+K (Mac) / Ctrl+K (Win/Linux). Bound on the document so it works
  // regardless of focus. We intentionally do NOT preventDefault when
  // modifiers besides ctrl/meta are held so users can still hit
  // Ctrl+Shift+K etc. for browser shortcuts.
  React.useEffect(() => {
    if (!isAuthenticated) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isAuthenticated]);

  const close = React.useCallback(() => setOpen(false), []);

  // Resolve the full action set on every open. Recomputing on each render
  // keeps the palette in lockstep with current workspace/collection state
  // without a separate subscription.
  const commands = React.useMemo<PaletteCommand[]>(() => {
    const items: PaletteCommand[] = [];

    // ─── Navigation ───
    items.push({
      id: 'nav:dashboard',
      kind: 'navigation',
      label: t('commandPalette.nav.dashboard', 'Go to Dashboard'),
      icon: Home,
      // Cross-language keywords: cmdk's substring matcher uses these so
      // a user typing 'home' on a Croatian UI still finds 'Otvori
      // nadzornu ploču'.
      keywords: ['home', 'main', 'dashboard', 'pocetna', 'pocetni', 'nadzorna'],
      run: c => { navigate('/dashboard'); c(); },
    });
    items.push({
      id: 'nav:library',
      kind: 'navigation',
      label: t('commandPalette.nav.library', 'Open Library'),
      icon: BookOpen,
      keywords: ['library', 'books', 'documents', 'pdf', 'biblioteka', 'knjige', 'dokumenti'],
      // Library is a dialog inside Knowledge Stacks, not a route.
      // Dispatch the same CustomEvent ToolDock listens for.
      run: c => {
        window.dispatchEvent(new CustomEvent('scrapalot:open-knowledge-stacks', { detail: { tab: 'library' } }));
        c();
      },
    });
    items.push({
      id: 'nav:notes',
      kind: 'navigation',
      label: t('commandPalette.nav.notes', 'Open Notes'),
      icon: StickyNote,
      keywords: ['notes', 'notepad', 'editor', 'biljeske'],
      run: c => { notesDrawer.open(); c(); },
    });
    items.push({
      id: 'nav:settings',
      kind: 'navigation',
      label: t('commandPalette.nav.settings', 'Open Settings'),
      icon: Settings,
      keywords: ['settings', 'preferences', 'configuration', 'postavke', 'opcenito'],
      // Settings is a dialog mounted by ToolDock, not a route.
      run: c => {
        window.dispatchEvent(new CustomEvent('scrapalot:open-settings'));
        c();
      },
    });
    if (isAdmin) {
      items.push({
        id: 'nav:admin',
        kind: 'navigation',
        label: t('commandPalette.nav.admin', 'Open Admin Panel'),
        icon: Shield,
        keywords: ['admin', 'inspector', 'tracing', 'debug'],
        // Admin panel is also a dialog, not a route.
        run: c => {
          window.dispatchEvent(new CustomEvent('scrapalot:open-admin'));
          c();
        },
      });
    }

    // ─── Recent documents ───
    // Each row is a deduplicated MAX(viewed_at) per document. We open
    // the document via the existing pdf-viewer-context dispatch event;
    // unknown source types fall back to "navigate to library".
    for (const r of recentDocs) {
      const name = docNames[r.document_id];
      // While the name is loading we show the id stub so the row is not
      // empty; once getDocumentById resolves we swap in the real
      // filename / title. cmdk re-evaluates on every render so users
      // see the swap without reopening.
      const label = name || `${r.document_id.slice(0, 8)}…`;
      items.push({
        id: `recent-doc:${r.document_id}`,
        kind: 'recentDoc',
        label,
        icon: BookOpen,
        keywords: ['recent', name || '', r.document_id, r.collection_id || ''],
        run: c => {
          // The PDF viewer is opened via context dispatch. We don't
          // import that context here to avoid a circular dep with the
          // viewer; instead we fire a CustomEvent that the viewer
          // listens to (mirror of action:open-stacks pattern below).
          window.dispatchEvent(new CustomEvent('scrapalot:open-document', {
            detail: {
              documentId: r.document_id,
              collectionId: r.collection_id,
              documentTitle: name || undefined,
            },
          }));
          c();
        },
      });
    }

    // ─── Collections ───
    // v1 omitted: a 'Focus collection: X' entry would need to flip the
    // chat orchestrator's selectedCollection (lives inside the
    // useConversations hook, scoped to <Index>), which has no global
    // store yet. Adding a listener at Index.tsx level is a follow-up;
    // until then a non-functional entry is worse than no entry.

    // ─── Actions ───
    items.push({
      id: 'action:new-note',
      kind: 'action',
      label: t('commandPalette.action.newNote', 'New note'),
      icon: Plus,
      keywords: ['create', 'write', 'nova', 'biljeska'],
      run: c => { notesDrawer.open(); c(); },
    });
    items.push({
      id: 'action:open-stacks',
      kind: 'action',
      label: t('commandPalette.action.openStacks', 'Open Knowledge Stacks'),
      icon: Layers,
      keywords: ['collections', 'manage', 'baze', 'znanja'],
      run: c => {
        window.dispatchEvent(new CustomEvent('scrapalot:open-knowledge-stacks'));
        c();
      },
    });
    items.push({
      id: 'action:upload',
      kind: 'action',
      label: t('commandPalette.action.upload', 'Upload document'),
      icon: FolderOpen,
      keywords: ['file', 'pdf', 'add', 'ucitaj', 'dokument'],
      run: c => {
        window.dispatchEvent(new CustomEvent('scrapalot:open-knowledge-stacks', { detail: { tab: 'upload' } }));
        c();
      },
    });
    // 'New chat' v1 omitted: navigating to /dashboard doesn't actually
    // create a new session — it relies on the chat layout's mount
    // sequence, and a non-functional 'New chat' is more confusing
    // than not offering it at all. The Knowledge Stacks dialog gives
    // a working entry point until we wire a listener in Index.tsx.

    // ─── Help ───
    items.push({
      id: 'help:docs',
      kind: 'help',
      label: t('commandPalette.help.docs', 'Documentation'),
      icon: HelpCircle,
      keywords: ['help', 'manual', 'guide'],
      run: c => {
        window.open('https://scrapalot.app/docs', '_blank', 'noopener');
        c();
      },
    });
    items.push({
      id: 'help:feedback',
      kind: 'help',
      label: t('commandPalette.help.feedback', 'Send feedback'),
      icon: HelpCircle,
      keywords: ['bug', 'report', 'contact'],
      run: c => {
        window.location.href = 'mailto:hello@mail.scrapalot.app?subject=Scrapalot%20feedback';
        c();
      },
    });

    return items;
  }, [t, navigate, notesDrawer, isAdmin, recentDocs, docNames]);

  // Compute display order: recently-used first (filtered to those still
  // valid), then the rest in their natural order. We don't sort the
  // remaining set so users see consistent groups below their recents.
  const ordered = React.useMemo(() => {
    const recents = readRecent();
    const byId = new Map(commands.map(c => [c.id, c]));
    const recentCmds: PaletteCommand[] = [];
    for (const id of recents) {
      const cmd = byId.get(id);
      if (cmd) {
        recentCmds.push(cmd);
        byId.delete(id);
      }
      if (recentCmds.length >= 5) break;
    }
    return { recents: recentCmds, rest: Array.from(byId.values()) };
  }, [commands, open]);

  // Group the non-recent commands by kind for display.
  const groups = React.useMemo(() => {
    const buckets: Record<CommandKind, PaletteCommand[]> = {
      navigation: [],
      recentDoc: [],
      action: [],
      help: [],
    };
    for (const c of ordered.rest) buckets[c.kind].push(c);
    return buckets;
  }, [ordered.rest]);

  if (!isAuthenticated) return null;

  const renderItem = (cmd: PaletteCommand) => {
    const Icon = cmd.icon;
    return (
      <CommandItem
        key={cmd.id}
        // cmdk uses `value` (default = textContent) for fuzzy search.
        // We pre-compose label + keywords so a query for "switch" or
        // the workspace name both match a workspace switch action.
        value={`${cmd.label} ${(cmd.keywords || []).join(' ')}`}
        onSelect={() => {
          pushRecent(cmd.id);
          cmd.run(close);
        }}
        data-testid={`command-${cmd.id}`}
      >
        <Icon className='mr-2 h-4 w-4 shrink-0 opacity-70' />
        <span className='flex-1 truncate'>{cmd.label}</span>
        {cmd.hint && (
          <span className='ml-2 text-xs text-muted-foreground'>{cmd.hint}</span>
        )}
        {cmd.shortcut && <CommandShortcut>{cmd.shortcut}</CommandShortcut>}
      </CommandItem>
    );
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder={t('commandPalette.placeholder', 'Type a command or search…')}
        data-testid='command-palette-input'
      />
      <CommandList>
        <CommandEmpty>{t('commandPalette.empty', 'No results.')}</CommandEmpty>

        {ordered.recents.length > 0 && (
          <>
            <CommandGroup heading={t('commandPalette.groups.recent', 'Recent')}>
              {ordered.recents.map(renderItem)}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {groups.navigation.length > 0 && (
          <CommandGroup heading={t('commandPalette.groups.navigation', 'Navigation')}>
            {groups.navigation.map(renderItem)}
          </CommandGroup>
        )}
        {groups.action.length > 0 && (
          <CommandGroup heading={t('commandPalette.groups.actions', 'Actions')}>
            {groups.action.map(renderItem)}
          </CommandGroup>
        )}
        {groups.recentDoc.length > 0 && (
          <CommandGroup heading={t('commandPalette.groups.recentDocs', 'Recent documents')}>
            {groups.recentDoc.map(renderItem)}
          </CommandGroup>
        )}
        {groups.help.length > 0 && (
          <CommandGroup heading={t('commandPalette.groups.help', 'Help')}>
            {groups.help.map(renderItem)}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
};

export default CommandPalette;
