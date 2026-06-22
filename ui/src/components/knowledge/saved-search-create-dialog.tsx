/**
 * Create/Edit Saved Search dialog — criteria builder with field/operator/value rows.
 * Creates or edits "smart collections" that auto-filter documents by metadata criteria.
 */

import React, { useEffect, useState } from 'react';
import { CircleHelp, Eye, FileSearch, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ColorPalette } from '@/components/ui/color-palette';
import {
  createSavedSearch,
  updateSavedSearch,
  previewSavedSearch,
  type SavedSearch,
  type SearchCondition,
  type SearchCriteria,
} from '@/lib/api-saved-searches';

const FIELD_HINTS: Record<string, string> = {
  title: 'Document title or resolved metadata title (from DOI/ISBN lookup)',
  filename: 'Original uploaded filename',
  author: 'Authors from auto-enriched metadata (CrossRef, Open Library, PubMed)',
  year: 'Publication year from resolved metadata',
  doi: 'Digital Object Identifier — auto-extracted from PDF first pages',
  source_type: 'Document type: journal article, book, thesis, report...',
  processing_status: 'Embedding status: pending, processing, completed, failed',
  tag: 'User-assigned tags (Important, Key Finding, Methodology...)',
  file_type: 'File format: PDF, EPUB, DOCX, TXT...',
  created_at: 'Date when document was uploaded',
  updated_at: 'Date of last document update or reprocessing',
  page_count: 'Total page count of the document',
  file_size: 'File size in bytes',
  has_summary: 'Whether an AI-generated summary exists for this document',
  graph_status: 'Knowledge graph entity extraction status',
};

const FIELDS = [
  { value: 'title', label: 'Title', category: 'text' },
  { value: 'filename', label: 'Filename', category: 'text' },
  { value: 'author', label: 'Author', category: 'text' },
  { value: 'year', label: 'Year', category: 'numeric' },
  { value: 'doi', label: 'DOI', category: 'existence' },
  { value: 'source_type', label: 'Document Type', category: 'category' },
  { value: 'processing_status', label: 'Processing Status', category: 'category' },
  { value: 'tag', label: 'Tag', category: 'text' },
  { value: 'file_type', label: 'File Type', category: 'category' },
  { value: 'created_at', label: 'Created Date', category: 'date' },
  { value: 'updated_at', label: 'Updated Date', category: 'date' },
  { value: 'page_count', label: 'Page Count', category: 'numeric' },
  { value: 'file_size', label: 'File Size (bytes)', category: 'numeric' },
  { value: 'has_summary', label: 'Has Summary', category: 'boolean' },
  { value: 'graph_status', label: 'Graph Status', category: 'category' },
  { value: 'fulltextContent', label: 'Document Text', category: 'text' },
  { value: 'chunkContent', label: 'Chunk Content', category: 'text' },
] as const;

const OPERATORS: Record<string, Array<{ value: string; label: string }>> = {
  text: [
    { value: 'contains', label: 'contains' },
    { value: 'equals', label: 'equals' },
    { value: 'isNot', label: 'is not' },
    { value: 'doesNotContain', label: 'does not contain' },
    { value: 'beginsWith', label: 'begins with' },
  ],
  numeric: [
    { value: 'equals', label: '=' },
    { value: 'gte', label: '\u2265' },
    { value: 'lte', label: '\u2264' },
    { value: 'isGreaterThan', label: '>' },
    { value: 'isLessThan', label: '<' },
  ],
  date: [
    { value: 'isBefore', label: 'is before' },
    { value: 'isAfter', label: 'is after' },
    { value: 'isInTheLast', label: 'is in the last (days)' },
  ],
  existence: [
    { value: 'contains', label: 'contains' },
    { value: 'equals', label: 'equals' },
    { value: 'exists', label: 'exists' },
    { value: 'not_exists', label: 'does not exist' },
  ],
  category: [
    { value: 'equals', label: 'is' },
    { value: 'isNot', label: 'is not' },
  ],
  boolean: [
    { value: 'exists', label: 'yes' },
    { value: 'not_exists', label: 'no' },
  ],
};

function getFieldCategory(field: string): string {
  const found = FIELDS.find(f => f.value === field);
  return found?.category ?? 'text';
}

function getOperatorsForField(field: string) {
  const category = getFieldCategory(field);
  return OPERATORS[category] ?? OPERATORS.text;
}

function needsValue(operator: string) {
  return operator !== 'exists' && operator !== 'not_exists';
}

function HelpIcon({ tooltip, side = 'right', className = 'w-3 h-3' }: { tooltip: string; side?: 'top' | 'right' | 'bottom' | 'left'; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <CircleHelp className={`${className} text-muted-foreground/40 hover:text-muted-foreground transition-colors cursor-help flex-shrink-0`} />
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-[260px] text-xs leading-relaxed">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

interface ConditionRow {
  field: string;
  operator: string;
  value: string;
}

interface SavedSearchCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onCreated?: () => void;
  editSearch?: SavedSearch | null;
}

export function SavedSearchCreateDialog({
  open,
  onOpenChange,
  workspaceId,
  onCreated,
  editSearch,
}: SavedSearchCreateDialogProps) {
  const { t } = useTranslation();
  const isEdit = !!editSearch;

  const [name, setName] = useState('');
  const [matchMode, setMatchMode] = useState<'all' | 'any'>('all');
  const [color, setColor] = useState<string>('#2ea8e5');
  const [conditions, setConditions] = useState<ConditionRow[]>([
    { field: 'title', operator: 'contains', value: '' },
  ]);
  const [saving, setSaving] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (editSearch && open) {
      setName(editSearch.name);
      setMatchMode(editSearch.criteria?.match ?? 'all');
      setColor(editSearch.color ?? '#2ea8e5');
      const conds = editSearch.criteria?.conditions;
      if (conds && conds.length > 0) {
        setConditions(conds.map(c => ({ field: c.field, operator: c.operator, value: c.value })));
      } else {
        setConditions([{ field: 'title', operator: 'contains', value: '' }]);
      }
      setPreviewCount(null);
    } else if (!editSearch && open) {
      setName('');
      setMatchMode('all');
      setColor('#2ea8e5');
      setConditions([{ field: 'title', operator: 'contains', value: '' }]);
      setPreviewCount(null);
    }
  }, [editSearch, open]);

  const addCondition = () => {
    setConditions(prev => [...prev, { field: 'title', operator: 'contains', value: '' }]);
  };

  const removeCondition = (idx: number) => {
    setConditions(prev => prev.filter((_, i) => i !== idx));
  };

  const updateConditionRow = (idx: number, updates: Partial<ConditionRow>) => {
    setConditions(prev => prev.map((c, i) => i === idx ? { ...c, ...updates } : c));
    setPreviewCount(null);
  };

  const buildCriteria = (): SearchCriteria => ({
    conditions: conditions
      .filter(c => c.field && c.operator && (needsValue(c.operator) ? c.value.trim() : true))
      .map(c => ({ field: c.field, operator: c.operator, value: c.value } as SearchCondition)),
    match: matchMode,
  });

  const handlePreview = async () => {
    const criteria = buildCriteria();
    if (criteria.conditions.length === 0) return;
    setPreviewing(true);
    const count = await previewSavedSearch(workspaceId, criteria);
    setPreviewCount(count);
    setPreviewing(false);
  };

  const handleSave = async () => {
    if (!name.trim() || conditions.length === 0) return;
    setSaving(true);
    const criteria = buildCriteria();

    let success: boolean;
    if (isEdit && editSearch) {
      const result = await updateSavedSearch(editSearch.id, { name: name.trim(), criteria, color });
      success = !!result;
    } else {
      const result = await createSavedSearch(workspaceId, name.trim(), criteria, color);
      success = !!result;
    }

    setSaving(false);
    if (success) {
      onOpenChange(false);
      onCreated?.();
    }
  };

  const matchLabel = matchMode === 'all'
    ? t('knowledge.savedSearch.matchAll', 'all')
    : t('knowledge.savedSearch.matchAny', 'any');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl z-[1250]" overlayZIndex="1220">
        <TooltipProvider delayDuration={200}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div
                className="flex items-center justify-center w-7 h-7 rounded-md"
                style={{ backgroundColor: `${color}18` }}
              >
                <FileSearch className="w-4 h-4" style={{ color }} />
              </div>
              {isEdit
                ? t('knowledge.savedSearch.editTitle', 'Edit Smart Collection')
                : t('knowledge.savedSearch.createTitle', 'Create Smart Collection')}
              <HelpIcon
                className="w-4 h-4"
                side="bottom"
                tooltip={t('knowledge.savedSearch.featureTooltip',
                  'Smart Collections auto-filter your documents by metadata criteria. They update dynamically — when new documents match your conditions, they appear automatically. Use them to organize research by year, author, tags, or any document property.'
                )}
              />
            </DialogTitle>
            <DialogDescription>
              {t('knowledge.savedSearch.createDesc', 'Define criteria to automatically filter documents.')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-1">
            {/* ── Name & Color ── */}
            <div className="space-y-2.5">
              <div className="flex items-center gap-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('knowledge.savedSearch.nameLabel', 'Name & Color')}
                </Label>
                <HelpIcon tooltip={t('knowledge.savedSearch.nameColorTooltip',
                  'Name appears in the Knowledge sidebar under Smart Collections. Color helps visually distinguish this collection at a glance.'
                )} />
              </div>
              <div className="space-y-2.5">
                <Input
                  data-testid="saved-search-name-input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('knowledge.savedSearch.namePlaceholder', 'Collection name...')}
                />
                <ColorPalette value={color} onChange={setColor} size="sm" />
              </div>
            </div>

            {/* ── Conditions ── */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {t('knowledge.savedSearch.conditionsLabel', 'Filter Conditions')}
                  </Label>
                  <HelpIcon tooltip={t('knowledge.savedSearch.conditionsTooltip',
                    'Each condition filters by a document property. Fields like Author, Year, and DOI use auto-enriched metadata resolved from CrossRef, PubMed, and Open Library. Combine multiple conditions to narrow results precisely.'
                  )} />
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span>{t('knowledge.savedSearch.match', 'Match')}</span>
                      <button
                        type="button"
                        onClick={() => { setMatchMode(matchMode === 'all' ? 'any' : 'all'); setPreviewCount(null); }}
                        className="px-1.5 py-0.5 rounded font-medium text-primary bg-primary/10 hover:bg-primary/20 transition-colors cursor-pointer"
                      >
                        {matchLabel}
                      </button>
                      <span>{t('knowledge.savedSearch.conditions', 'conditions')}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[220px] text-xs">
                    {matchMode === 'all'
                      ? t('knowledge.savedSearch.matchAllTooltip', '"All" = AND logic. Documents must satisfy every condition to appear.')
                      : t('knowledge.savedSearch.matchAnyTooltip', '"Any" = OR logic. Documents matching at least one condition will appear.')}
                  </TooltipContent>
                </Tooltip>
              </div>

              <div className="space-y-0 max-h-64 overflow-y-auto rounded-md border border-border bg-muted/30">
                {conditions.map((cond, idx) => (
                  <div key={idx}>
                    {idx > 0 && (
                      <div className="flex items-center px-3">
                        <div className="flex-1 border-t border-border/50" />
                        <span className="px-2 text-[10px] font-medium text-muted-foreground/60 uppercase">
                          {matchLabel}
                        </span>
                        <div className="flex-1 border-t border-border/50" />
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 px-3 py-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex-shrink-0">
                            <Select
                              value={cond.field}
                              onValueChange={v => {
                                const ops = getOperatorsForField(v);
                                updateConditionRow(idx, { field: v, operator: ops[0].value, value: '' });
                              }}
                            >
                              <SelectTrigger className="w-[140px] h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="z-[1300]">
                                {FIELDS.map(f => (
                                  <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </TooltipTrigger>
                        {FIELD_HINTS[cond.field] && (
                          <TooltipContent side="bottom" className="max-w-[220px] text-xs">
                            {t(`knowledge.savedSearch.hint_${cond.field}`, FIELD_HINTS[cond.field])}
                          </TooltipContent>
                        )}
                      </Tooltip>

                      <Select value={cond.operator} onValueChange={v => updateConditionRow(idx, { operator: v })}>
                        <SelectTrigger className="w-[130px] h-8 text-xs flex-shrink-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="z-[1300]">
                          {getOperatorsForField(cond.field).map(op => (
                            <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {needsValue(cond.operator) && (
                        <Input
                          value={cond.value}
                          onChange={e => updateConditionRow(idx, { value: e.target.value })}
                          placeholder={getFieldCategory(cond.field) === 'date' ? 'YYYY-MM-DD' : 'Value...'}
                          className="flex-1 h-8 text-xs min-w-0"
                          type={getFieldCategory(cond.field) === 'numeric' ? 'number' : 'text'}
                        />
                      )}

                      {conditions.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 flex-shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeCondition(idx)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}

                <div className="px-3 py-2 border-t border-border/50">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs gap-1 h-7 text-muted-foreground hover:text-foreground"
                    onClick={addCondition}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {t('knowledge.savedSearch.addCondition', 'Add condition')}
                  </Button>
                </div>
              </div>
            </div>

            {/* ── Preview ── */}
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 h-8 text-xs"
                    onClick={handlePreview}
                    disabled={previewing || conditions.length === 0}
                  >
                    <Eye className="w-3.5 h-3.5" />
                    {previewing
                      ? t('knowledge.savedSearch.previewing', 'Counting...')
                      : t('knowledge.savedSearch.preview', 'Preview')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[220px] text-xs">
                  {t('knowledge.savedSearch.previewTooltip',
                    'Test your criteria before saving. Shows how many documents currently match these conditions.'
                  )}
                </TooltipContent>
              </Tooltip>
              {typeof previewCount === 'number' && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">
                  {t('knowledge.savedSearch.previewResult', '{{count}} documents match', { count: previewCount })}
                </span>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2 pt-2 border-t border-border">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              data-testid="saved-search-create-button"
              onClick={handleSave}
              disabled={saving || !name.trim() || conditions.length === 0}
            >
              {saving
                ? t('common.saving', 'Saving...')
                : isEdit
                  ? t('common.save', 'Save')
                  : t('knowledge.savedSearch.create', 'Create')}
            </Button>
          </DialogFooter>
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  );
}
