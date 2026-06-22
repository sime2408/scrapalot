/**
 * Annotation colour-label card. Renders inside the Documents settings
 * tab and follows the same card layout (sticky header + outlined card
 * + pl-13 indented content) as the embedding-model card so the page
 * stays visually consistent.
 *
 * Workspace member with edit permission can rename each highlight
 * colour to match the team's reading conventions
 * (red = critical, yellow = insight, …); other members see the labels
 * read-only via swatch tooltips in the PDF / EPUB selection popovers.
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ANNOTATION_COLORS } from '@/types/annotations';
import { useAnnotationColorSemantics } from '@/hooks/use-annotation-color-semantics';
import { useWorkspace } from '@/hooks/use-workspace';

const PRESETS: Record<string, Record<string, string>> = {
  criticalReading: {
    '#ff6666': 'Critical',
    '#ffd400': 'Insight',
    '#5fb236': 'Cite this',
    '#2ea8e5': 'Question',
    '#a28ae5': 'Background',
    '#aaaaaa': 'Skip',
  },
  literatureReview: {
    '#ffd400': 'Method',
    '#5fb236': 'Result',
    '#2ea8e5': 'Definition',
    '#ff6666': 'Conflict',
    '#a28ae5': 'Hypothesis',
    '#f19837': 'Revisit',
  },
};

export function SettingsCardAnnotationColors() {
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  const { map, save, loading } = useAnnotationColorSemantics();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const lastSavedRef = useRef<string>('');

  // Sync the draft once the workspace map arrives. Track the saved
  // snapshot so the auto-save effect knows when nothing has changed.
  useEffect(() => {
    setDraft(map);
    lastSavedRef.current = JSON.stringify(map);
  }, [map]);

  // Auto-save (debounced) — mirrors the documents tab pattern. No
  // explicit Save button; the user just edits and the card persists
  // 1.5 s after the last keystroke / preset click.
  useEffect(() => {
    if (loading) return;
    const serialised = JSON.stringify(draft);
    if (serialised === lastSavedRef.current) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      try {
        await save(draft);
        lastSavedRef.current = serialised;
      } catch (e) {
        console.warn('[AnnotationColors] auto-save failed:', e);
      } finally {
        setSaving(false);
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [draft, loading, save]);

  const setLabel = (hex: string, label: string) => {
    setDraft(d => ({ ...d, [hex]: label }));
  };

  const applyPreset = (key: string) => setDraft({ ...PRESETS[key] });

  return (
    <div
      data-testid="settings-card-annotation-colors"
      className="relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-6 shadow-sm"
    >
      <div className="flex items-start gap-3 mb-5">
        <div className="w-10 h-10 flex items-center justify-center mt-1">
          <Palette className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-white">
            {t('settings.annotationColors.title', 'Annotation colour labels')}
          </h3>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {t(
              'settings.annotationColors.description',
              'Map each highlight colour to a label everyone in the workspace will see. Empty fields fall back to the built-in palette description.',
            )}
          </p>
        </div>
      </div>

      {!currentWorkspace ? (
        <div className="pl-13">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {t('settings.annotationColors.noWorkspace', 'Select a workspace to configure annotation colour labels.')}
          </p>
        </div>
      ) : (
        <div className="pl-13 space-y-5">
          {/* Presets row */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-zinc-900 dark:text-white">
              {t('settings.annotationColors.presets', 'Presets:')}
            </span>
            {Object.keys(PRESETS).map(key => (
              <Button
                key={key}
                variant="outline"
                size="sm"
                type="button"
                data-testid={`annotation-color-preset-${key}`}
                onClick={() => applyPreset(key)}
                disabled={saving}
              >
                {t(`settings.annotationColors.preset.${key}`, key)}
              </Button>
            ))}
          </div>

          {/* Color → label grid */}
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {ANNOTATION_COLORS.map(({ hex, name, label }) => (
                <div key={hex} className="flex items-center gap-2">
                  <span
                    className="w-8 h-8 border border-zinc-300 dark:border-zinc-700 flex-shrink-0"
                    style={{ backgroundColor: hex }}
                    aria-hidden
                  />
                  <span className="text-xs w-16 flex-shrink-0 text-zinc-600 dark:text-zinc-400">
                    {name}
                  </span>
                  <Input
                    data-testid={`annotation-color-label-${hex.replace('#', '')}`}
                    value={draft[hex] ?? ''}
                    onChange={e => setLabel(hex, e.target.value)}
                    placeholder={label}
                    maxLength={64}
                    disabled={saving}
                    className="h-9 text-sm"
                  />
                </div>
              ))}
            </div>
          )}

          {/* Auto-save indicator — mirrors the documents tab; no
              explicit Save button. */}
          <div
            className="flex items-center justify-end gap-1 text-xs text-zinc-500 dark:text-zinc-400 h-5"
            data-testid="annotation-colors-autosave-indicator"
          >
            {saving && (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>{t('settings.annotationColors.saving', 'Saving…')}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
