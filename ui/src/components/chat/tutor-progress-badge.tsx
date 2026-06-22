/**
 * 7.8 v3 — Tutor curriculum progress badge.
 *
 * Renders a thin pill above the chat input when AI Tutor mode is on
 * AND exactly ONE collection is selected. Shows the current lesson
 * (e.g. "Lesson 3 of 12 · Phonological loop · check understanding")
 * so the user can tell where they are in the curriculum without
 * opening a separate sidebar.
 *
 * Polls progress on mount + after every assistant message lands —
 * the parent passes a `pollKey` that bumps after each chat turn so
 * we re-fetch without subscribing to the streaming events directly.
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { GraduationCap, Loader2 } from 'lucide-react';
import { getTutorProgress, type TutorProgress } from '@/lib/api-tutor';
import { cn } from '@/lib/utils';

export interface TutorProgressBadgeProps {
  collectionId: string | null;
  /** Bumped after each assistant turn to trigger a refresh. */
  pollKey?: number;
  className?: string;
}

const STATE_LABEL: Record<TutorProgress['current_state'], string> = {
  lesson_intro: 'lessonIntro',
  check_understanding: 'checkUnderstanding',
  drill_in: 'drillIn',
  quiz: 'quiz',
  lesson_recap: 'lessonRecap',
};

export const TutorProgressBadge: React.FC<TutorProgressBadgeProps> = ({
  collectionId,
  pollKey,
  className,
}) => {
  const { t } = useTranslation();
  const [progress, setProgress] = React.useState<TutorProgress | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!collectionId) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getTutorProgress(collectionId)
      .then((p) => {
        if (!cancelled) setProgress(p);
      })
      .catch(() => {
        if (!cancelled) setProgress(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [collectionId, pollKey]);

  if (!collectionId) return null;

  if (loading && !progress) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 text-xs border border-border bg-muted/30 max-w-max',
          className,
        )}
        data-testid="tutor-progress-badge"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>{t('chat.tutor.loadingProgress', 'Loading curriculum…')}</span>
      </div>
    );
  }

  if (!progress) return null;

  if (progress.curriculum_status === 'missing') {
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 text-xs border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 max-w-max',
          className,
        )}
        data-testid="tutor-progress-badge"
      >
        <GraduationCap className="h-3.5 w-3.5" />
        <span>{t('chat.tutor.curriculumMissing', 'Run community detection on this collection to enable Tutor mode.')}</span>
      </div>
    );
  }

  if (progress.curriculum_status === 'building') {
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 text-xs border border-border bg-muted/30 max-w-max',
          className,
        )}
        data-testid="tutor-progress-badge"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>{t('chat.tutor.buildingCurriculum', 'Building curriculum from communities…')}</span>
      </div>
    );
  }

  const lesson = progress.lessons.find((l) => l.lesson_ord === progress.current_lesson_ord);
  const stateKey = STATE_LABEL[progress.current_state];
  const stateLabel = t(`chat.tutor.state.${stateKey}`, stateKey);

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 text-xs border border-border bg-violet-500/10 text-violet-700 dark:text-violet-300 max-w-full',
        className,
      )}
      data-testid="tutor-progress-badge"
      title={lesson?.summary}
    >
      <GraduationCap className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="font-medium whitespace-nowrap">
        {t('chat.tutor.lessonOf', 'Lesson {{n}} of {{total}}', {
          n: progress.current_lesson_ord + 1,
          total: progress.lesson_count,
        })}
      </span>
      {lesson && (
        <>
          <span className="opacity-60">·</span>
          <span className="truncate">{lesson.title}</span>
        </>
      )}
      <span className="opacity-60">·</span>
      <span className="text-[10px] uppercase tracking-wide opacity-80 whitespace-nowrap">{stateLabel}</span>
    </div>
  );
};
