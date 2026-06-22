/**
 * 7.2 — Outline template picker.
 *
 * Lets the writer pick a discipline-specific scaffold before
 * `generate_outline` runs. Each card maps to a `template_type` value
 * which the backend turns into a different prompt
 * (generate_outline_imrad / lit_review / thesis / grant in
 * prompts.yaml). The "Generic" option preserves the legacy behavior
 * for users who don't yet know what kind of paper they're writing.
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ListChecks, FlaskConical, BookOpen, GraduationCap, FileText } from 'lucide-react';
import type { OutlineTemplate } from '@/lib/api-notes-assistant';

interface TemplateOption {
  value: OutlineTemplate;
  icon: typeof ListChecks;
  titleKey: string;
  titleFallback: string;
  descKey: string;
  descFallback: string;
}

const OPTIONS: TemplateOption[] = [
  {
    value: '',
    icon: ListChecks,
    titleKey: 'notes.outlineTemplate.generic.title',
    titleFallback: 'Generic outline',
    descKey: 'notes.outlineTemplate.generic.desc',
    descFallback: 'Free-form scaffold based purely on what is already in the notes.',
  },
  {
    value: 'imrad',
    icon: FlaskConical,
    titleKey: 'notes.outlineTemplate.imrad.title',
    titleFallback: 'IMRAD (research paper)',
    descKey: 'notes.outlineTemplate.imrad.desc',
    descFallback: 'Introduction · Methods · Results · Discussion. Empirical paper conventions.',
  },
  {
    value: 'lit_review',
    icon: BookOpen,
    titleKey: 'notes.outlineTemplate.litReview.title',
    titleFallback: 'Literature review (PRISMA)',
    descKey: 'notes.outlineTemplate.litReview.desc',
    descFallback: 'Search strategy · selection · synthesis · quality assessment.',
  },
  {
    value: 'thesis',
    icon: GraduationCap,
    titleKey: 'notes.outlineTemplate.thesis.title',
    titleFallback: 'Doctoral thesis',
    descKey: 'notes.outlineTemplate.thesis.desc',
    descFallback: 'Chapter scaffold from Abstract through Conclusions and Appendices.',
  },
  {
    value: 'grant',
    icon: FileText,
    titleKey: 'notes.outlineTemplate.grant.title',
    titleFallback: 'Grant proposal',
    descKey: 'notes.outlineTemplate.grant.desc',
    descFallback: 'Specific Aims · Significance · Innovation · Approach · Timeline.',
  },
];

export interface OutlineTemplatePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: OutlineTemplate) => void;
}

export const OutlineTemplatePickerDialog: React.FC<OutlineTemplatePickerDialogProps> = ({
  open,
  onOpenChange,
  onSelect,
}) => {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // overlayZIndex bypasses the inline z-71 the DialogContent
        // primitive sets for itself — without it the dialog renders
        // BEHIND the notes drawer (which sits well above z-71). Same
        // 10049/10050 layering as VersionHistoryDialog and
        // ComposeFromSourcesDialog.
        overlayZIndex="10049"
        className="max-w-2xl"
        data-testid="outline-template-picker"
      >
        <DialogHeader>
          <DialogTitle>{t('notes.outlineTemplate.title', 'Pick an outline template')}</DialogTitle>
          <DialogDescription>
            {t('notes.outlineTemplate.subtitle', 'Each template biases the AI toward a specific scaffold. You can always edit the generated outline.')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 sm:grid-cols-2">
          {OPTIONS.map((opt) => {
            const Icon = opt.icon;
            return (
              <Button
                key={opt.value || 'generic'}
                variant="outline"
                type="button"
                className="h-auto flex flex-col items-start gap-1 p-3 text-left whitespace-normal"
                data-testid={`outline-template-${opt.value || 'generic'}`}
                onClick={() => {
                  onSelect(opt.value);
                  onOpenChange(false);
                }}
              >
                <div className="flex items-center gap-2 font-medium">
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  <span>{t(opt.titleKey, opt.titleFallback)}</span>
                </div>
                <span className="text-xs text-muted-foreground font-normal">
                  {t(opt.descKey, opt.descFallback)}
                </span>
              </Button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
};
