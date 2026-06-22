/**
 * NotePageMetaRow
 *
 * Confluence-style metadata strip rendered just below the H1 title of the
 * note. Always visible (not hover-gated like the page-head toolbar) and
 * surfaces:
 *
 *   By <Author name> · <reading time> · Listen · Add a reaction
 *   · <status badge> · Share
 *
 * Anchoring uses the same approach as PageHeadToolbar: query
 * `.ProseMirror > h1:first-of-type` inside the scroll container, listen to
 * resize + scroll events, position absolutely above the editor body. The
 * row sits in the padding gap created by H1 first-child styling (the
 * editor stylesheet pads the title's bottom for exactly this row to land
 * on).
 *
 * Listen + reactions are intentionally placeholder buttons in this
 * iteration — TTS and reactions require their own backend pipelines
 * (Edge-TTS + `note_reactions` table) that are out of scope for the
 * migration-116 page-head delivery.
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Headphones, Loader2, Share2, SmilePlus, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { UserAvatar } from './user-avatar';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast-compat';
import { synthesizeSpeech, base64ToAudioBlob } from '@/lib/api-tts';
import { LANGUAGE_VOICE_MAP } from '@/lib/tts-constants';
import {
  addNoteReaction,
  listNoteReactions,
  removeNoteReaction,
  type NoteReactionGroup,
} from '@/lib/api-notes-reactions';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface NotePageMetaRowAuthor {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  color?: string;
}

export interface NotePageMetaRowProps {
  /** The scrollable .notes-container that wraps `.ProseMirror`. */
  scrollContainer: HTMLElement | null;
  /** Note author surfaced as "By <name>". */
  author: NotePageMetaRowAuthor;
  /** Plain-text editor content used to compute reading time. */
  bodyText: string;
  /** Share affordance. Hidden when undefined. */
  onShare?: () => void;
  /** The note's UUID. When set, the reactions chip strip + picker
   *  fetch from /notes/{id}/reactions; when undefined (note not yet
   *  persisted), the reaction button stays disabled. */
  noteId?: string | null;
  /** Current viewer's user id — used as the optimistic addition to
   *  the `includes_viewer` chip state until the refetch returns. */
  viewerUserId?: string;
}

interface AnchorPosition {
  top: number;
  left: number;
  width: number;
  visible: boolean;
}

function useAnchorBelowH1(scrollContainer: HTMLElement | null): AnchorPosition {
  const [pos, setPos] = React.useState<AnchorPosition>({ top: 0, left: 0, width: 0, visible: false });

  React.useEffect(() => {
    if (!scrollContainer) return;

    let h1: HTMLElement | null = null;
    let resizeObs: ResizeObserver | null = null;
    let mutObs: MutationObserver | null = null;
    let rafHandle = 0;

    const measure = () => {
      if (!h1 || !scrollContainer) return;
      const h1Rect = h1.getBoundingClientRect();
      const parentRect = scrollContainer.getBoundingClientRect();
      // The H1 first-child reserves a padding-bottom block for this
      // row (the editor stylesheet sets it to 2.75rem ≈ 44 px). Read
      // it at runtime rather than hard-coding so the row stays glued
      // to the text baseline even if the stylesheet ever changes.
      //
      // Layout: H1 text content → padding-bottom block (border-bottom
      // was removed for the Confluence-style look). Place the row
      // 24 px below the title baseline so it visibly clears the H1
      // instead of hugging it — Confluence-style breathing room.
      const paddingBottom = parseFloat(getComputedStyle(h1).paddingBottom) || 0;
      const textContentBottom = h1Rect.bottom - paddingBottom;
      const top =
        textContentBottom - parentRect.top + scrollContainer.scrollTop + 24;
      const left = h1Rect.left - parentRect.left + scrollContainer.scrollLeft;
      const width = h1Rect.width;
      // Hide the row when the H1 has scrolled out of view, so it
      // stops drawing on top of the menu bar or trailing the user
      // down the page. We give a small slack (8 px) so the row
      // doesn't flicker at the exact scroll boundary.
      const h1IsInView = h1Rect.bottom > parentRect.top + 8;
      setPos((prev) => {
        const next = { top, left, width, visible: h1IsInView };
        return next.top === prev.top &&
          next.left === prev.left &&
          next.width === prev.width &&
          prev.visible === next.visible
          ? prev
          : next;
      });
    };

    const scheduleMeasure = () => {
      if (rafHandle) cancelAnimationFrame(rafHandle);
      rafHandle = requestAnimationFrame(measure);
    };

    const attach = () => {
      const found = scrollContainer.querySelector<HTMLElement>('.ProseMirror > h1:first-of-type');
      if (found === h1) return;

      if (resizeObs) resizeObs.disconnect();

      h1 = found;
      if (!h1) {
        setPos((p) => ({ ...p, visible: false }));
        return;
      }

      resizeObs = new ResizeObserver(scheduleMeasure);
      resizeObs.observe(h1);
      resizeObs.observe(scrollContainer);
      scheduleMeasure();
    };

    mutObs = new MutationObserver(attach);
    mutObs.observe(scrollContainer, { childList: true, subtree: true });
    attach();

    const onScroll = () => scheduleMeasure();
    scrollContainer.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', scheduleMeasure);

    return () => {
      if (rafHandle) cancelAnimationFrame(rafHandle);
      if (mutObs) mutObs.disconnect();
      if (resizeObs) resizeObs.disconnect();
      scrollContainer.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [scrollContainer]);

  return pos;
}

function readingMinutesFromText(text: string): number {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  // 200 wpm — same constant the Word-count menu action uses.
  return Math.max(1, Math.ceil(words / 200));
}

/** Quick-pick emoji set for the reactions popover. Same vocabulary as
 *  the page-head emoji picker so users don't have to context-switch. */
const REACTION_QUICK_EMOJIS = ['👍', '❤️', '🎉', '🚀', '🤔', '👀', '💯', '🔥'];

export const NotePageMetaRow: React.FC<NotePageMetaRowProps> = ({
  scrollContainer,
  author,
  bodyText,
  onShare,
  noteId,
  viewerUserId,
}) => {
  const { t, i18n } = useTranslation();
  const pos = useAnchorBelowH1(scrollContainer);
  const minutes = React.useMemo(() => readingMinutesFromText(bodyText), [bodyText]);
  const avatar = author.avatar ?? undefined;

  // ---- Reactions ----
  const [reactions, setReactions] = React.useState<NoteReactionGroup[]>([]);
  const [reactionPickerOpen, setReactionPickerOpen] = React.useState(false);

  const refreshReactions = React.useCallback(async () => {
    if (!noteId) {
      setReactions([]);
      return;
    }
    try {
      const groups = await listNoteReactions(noteId);
      setReactions(groups);
    } catch (err) {
      console.error('[NotePageMetaRow] listReactions failed', err);
    }
  }, [noteId]);

  React.useEffect(() => {
    void refreshReactions();
  }, [refreshReactions]);

  const toggleReaction = React.useCallback(
    async (emoji: string) => {
      if (!noteId) {
        toast({
          title: t('notes.pageMeta.reactionNotSaved.title', 'Save the note first'),
          description: t(
            'notes.pageMeta.reactionNotSaved.description',
            'Type at least a title — the note has to exist before you can react.',
          ),
        });
        return;
      }
      const existingGroup = reactions.find((r) => r.emoji === emoji);
      const includesViewer = existingGroup?.includes_viewer ?? false;
      // Optimistic update so the chip flips instantly.
      setReactions((prev) => {
        if (existingGroup) {
          return prev
            .map((r) => {
              if (r.emoji !== emoji) return r;
              return {
                ...r,
                count: includesViewer ? r.count - 1 : r.count + 1,
                includes_viewer: !includesViewer,
                user_ids: includesViewer
                  ? r.user_ids.filter((u) => u !== viewerUserId)
                  : viewerUserId
                  ? [...r.user_ids, viewerUserId]
                  : r.user_ids,
              };
            })
            .filter((r) => r.count > 0);
        }
        // Brand-new emoji — append optimistically.
        return [
          ...prev,
          {
            emoji,
            count: 1,
            user_ids: viewerUserId ? [viewerUserId] : [],
            includes_viewer: true,
          },
        ];
      });
      try {
        if (includesViewer) {
          await removeNoteReaction(noteId, emoji);
        } else {
          await addNoteReaction(noteId, emoji);
        }
        await refreshReactions();
      } catch (err) {
        console.error('[NotePageMetaRow] toggleReaction failed', err);
        // Roll back by refetching.
        await refreshReactions();
        toast({
          title: t('general.error', 'Error'),
          description: t('notes.pageMeta.reactionError', 'Could not save reaction.'),
          variant: 'destructive',
        });
      }
    },
    [noteId, reactions, refreshReactions, t, viewerUserId],
  );

  // TTS — Edge-TTS via /tts/synthesize. Mirrors the toggle pattern in
  // chat-message.tsx so the same play / stop semantics apply: click to
  // start, click again to interrupt and reset. Voice is picked from the
  // current i18n language (Croatian by default for this app), falling
  // back to English. Audio object lives in a ref so the cleanup effect
  // can stop playback if the user navigates away mid-utterance.
  const [isTTSLoading, setIsTTSLoading] = React.useState(false);
  const [isTTSPlaying, setIsTTSPlaying] = React.useState(false);
  const ttsAudioRef = React.useRef<HTMLAudioElement | null>(null);

  const handleListen = React.useCallback(async () => {
    if (isTTSPlaying && ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current.currentTime = 0;
      setIsTTSPlaying(false);
      return;
    }
    const text = bodyText.trim();
    if (!text) {
      toast({
        title: t('notes.pageMeta.ttsEmpty.title', 'Nothing to read'),
        description: t('notes.pageMeta.ttsEmpty.description', 'Add some content to the note first.'),
      });
      return;
    }
    const langCode = (i18n.language || 'en').split('-')[0];
    const voice = LANGUAGE_VOICE_MAP[langCode] || LANGUAGE_VOICE_MAP['en'];
    setIsTTSLoading(true);
    try {
      const res = await synthesizeSpeech(text, voice);
      const blob = base64ToAudioBlob(res.audio);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      ttsAudioRef.current = audio;
      audio.onended = () => {
        setIsTTSPlaying(false);
        URL.revokeObjectURL(url);
        ttsAudioRef.current = null;
      };
      audio.onerror = () => {
        setIsTTSPlaying(false);
        URL.revokeObjectURL(url);
        ttsAudioRef.current = null;
        toast({
          title: t('general.error', 'Error'),
          description: t('notes.pageMeta.ttsError', 'Failed to play audio.'),
          variant: 'destructive',
        });
      };
      await audio.play();
      setIsTTSPlaying(true);
    } catch (err) {
      console.error('[NotePageMetaRow] TTS error:', err);
      toast({
        title: t('general.error', 'Error'),
        description: t('notes.pageMeta.ttsError', 'Failed to synthesize speech.'),
        variant: 'destructive',
      });
    } finally {
      setIsTTSLoading(false);
    }
  }, [bodyText, i18n.language, isTTSPlaying, t]);

  React.useEffect(() => {
    return () => {
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        ttsAudioRef.current = null;
      }
    };
  }, []);

  return (
    <TooltipProvider>
      <div
        data-testid="notes-page-meta-row"
        data-notes-popover="true"
        style={{
          position: 'absolute',
          top: pos.top,
          left: pos.left,
          width: pos.width,
          opacity: pos.visible ? 1 : 0,
          pointerEvents: pos.visible ? 'auto' : 'none',
          transition: 'opacity 120ms ease',
          // Keep below the menu bar (header z-20), the floating table
          // alignment toolbar (z-11), the page-head hover toolbar
          // (z-40), and the selection toolbar (z-10001). z-1 is only
          // above raw editor body content — exactly where the meta
          // row belongs.
          zIndex: 1,
        }}
        className="flex items-center gap-1.5 sm:gap-3 text-xs text-muted-foreground flex-wrap"
      >
        {/* By <author name> — avatar always, name hidden on narrow */}
        <div className="flex items-center gap-1.5" data-testid="notes-meta-author">
          <UserAvatar
            name={author.name}
            email={author.email}
            avatar={avatar}
            color={author.color}
            size="sm"
          />
          <span className="hidden sm:inline font-medium text-foreground/80">
            {t('notes.pageMeta.by', 'By {{name}}', { name: author.name })}
          </span>
        </div>

        <span className="hidden sm:inline text-border">·</span>

        {/* Reading time — Confluence puts a small book glyph next to
            the duration to make the row scannable at a glance. */}
        <span data-testid="notes-meta-reading-time" className="whitespace-nowrap inline-flex items-center gap-1">
          <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          {t('notes.pageMeta.readingTime', '{{minutes}} min', { minutes })}
        </span>

        <span className="hidden sm:inline text-border">·</span>

        {/* Listen — TTS via /tts/synthesize. Click to start, click again
            to stop. Loader replaces the headphones icon during synthesis. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-6 px-1.5 gap-1 text-xs hover:text-foreground',
                isTTSPlaying ? 'text-primary' : 'text-muted-foreground',
              )}
              data-testid="notes-meta-listen-button"
              disabled={isTTSLoading}
              onClick={handleListen}
            >
              {isTTSLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : isTTSPlaying ? (
                <Square className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Headphones className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">
                {isTTSLoading
                  ? t('notes.pageMeta.listenLoading', 'Loading…')
                  : isTTSPlaying
                  ? t('notes.pageMeta.listenStop', 'Stop')
                  : t('notes.pageMeta.listen', 'Listen')}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">
              {isTTSPlaying
                ? t('notes.pageMeta.listenStopTooltip', 'Stop playback')
                : t('notes.pageMeta.listenTooltip', 'Read the note aloud')}
            </p>
          </TooltipContent>
        </Tooltip>

        <span className="hidden sm:inline text-border">·</span>

        {/* Reaction chips + add-reaction picker. Chips render existing
            (emoji, count) groups; clicking one toggles the viewer's
            own entry. The Add-reaction button opens a small popover
            with a fixed quick-pick palette. Disabled state surfaces
            when the note hasn't been persisted yet. */}
        {reactions.map((group) => (
          <Tooltip key={group.emoji}>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid={`notes-meta-reaction-chip-${group.emoji}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void toggleReaction(group.emoji)}
                className={cn(
                  'inline-flex items-center gap-1 h-6 px-1.5 text-xs border transition-colors',
                  group.includes_viewer
                    ? 'bg-primary/15 border-primary/40 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent',
                )}
              >
                <span className="text-sm leading-none">{group.emoji}</span>
                <span className="tabular-nums">{group.count}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">
                {group.includes_viewer
                  ? t('notes.pageMeta.reactionRemoveTooltip', 'Click to remove your reaction')
                  : t('notes.pageMeta.reactionAddTooltip', 'Click to react with {{emoji}}', { emoji: group.emoji })}
              </p>
            </TooltipContent>
          </Tooltip>
        ))}
        <Popover open={reactionPickerOpen} onOpenChange={setReactionPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 gap-1 text-xs text-muted-foreground hover:text-foreground"
              data-testid="notes-meta-reaction-button"
              disabled={!noteId}
              // Prevent ProseMirror from stealing focus on mousedown —
              // otherwise the editor blurs, the meta-row re-renders,
              // and the popover snaps shut before the click resolves.
              onMouseDown={(e) => e.preventDefault()}
              title={
                noteId
                  ? t('notes.pageMeta.addReactionTooltip', 'React with an emoji')
                  : t('notes.pageMeta.reactionNotSaved.title', 'Save the note first')
              }
            >
              <SmilePlus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('notes.pageMeta.addReaction', 'Add a reaction')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="w-auto z-[10050] p-2 notes-popover"
            collisionPadding={8}
            data-notes-popover="true"
            data-testid="notes-meta-reaction-picker"
          >
            <div className="flex gap-1">
              {REACTION_QUICK_EMOJIS.map((e) => (
                <Button
                  key={e}
                  variant="ghost"
                  size="sm"
                  className="h-9 w-9 text-lg p-0"
                  data-testid={`notes-meta-reaction-quick-${e}`}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => {
                    void toggleReaction(e);
                    setReactionPickerOpen(false);
                  }}
                >
                  {e}
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {/* Share — aligned with the other meta actions instead of
            flex-pushed to the right edge. Keeps the row reading as a
            single inline group like Confluence does. */}
        {onShare && (
          <>
            <span className="hidden sm:inline text-border">·</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 gap-1 text-xs text-muted-foreground hover:text-foreground"
                  data-testid="notes-meta-share-button"
                  onClick={onShare}
                >
                  <Share2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{t('notes.pageMeta.share', 'Share')}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">{t('notes.toolbar.shareThisNote', 'Share this note')}</p>
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </TooltipProvider>
  );
};

export default NotePageMetaRow;
