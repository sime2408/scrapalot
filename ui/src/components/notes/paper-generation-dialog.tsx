import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, GripVertical, Loader2, Plus, Trash2 } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/lib/toast-compat';
import {
  generatePaper,
  listPaperTemplates,
  listPaperVenues,
  getPaperDownloadUrl,
  type PaperTemplate,
  type PaperVenue,
  type GeneratePaperRequest,
} from '@/lib/api-papers';

interface PaperGenerationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled from deep research panel */
  researchPlanId?: string;
  synthesisReport?: string;
  /** Pre-filled from notes editor */
  notesContent?: string;
  /** Discovery JSON from deep research */
  discoveriesJson?: string;
}

export function PaperGenerationDialog({
  open,
  onOpenChange,
  researchPlanId,
  synthesisReport,
  notesContent,
  discoveriesJson,
}: PaperGenerationDialogProps) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<PaperTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState('scientific_paper');
  const [outputFormat, setOutputFormat] = useState<'pdf' | 'docx' | 'markdown'>('pdf');
  const [authorName, setAuthorName] = useState('');
  const [authorAffiliation, setAuthorAffiliation] = useState('');
  const [keywords, setKeywords] = useState('');
  const [citationStyle, setCitationStyle] = useState('apa');
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState('template');
  // Feature 8: Venue-specific templates
  const [venues, setVenues] = useState<PaperVenue[]>([]);
  const [selectedVenue, setSelectedVenue] = useState<string>('');

  useEffect(() => {
    if (open) {
      listPaperVenues().then(setVenues).catch(() => setVenues([]));
      listPaperTemplates()
        .then(setTemplates)
        .catch(() => {
          // Fallback templates if API not yet available
          setTemplates([
            { key: 'scientific_paper', name: 'Scientific Paper', section_titles: ['Abstract', 'Introduction', 'Methodology', 'Results', 'Discussion', 'Conclusion'] },
            { key: 'literature_review', name: 'Literature Review', section_titles: ['Abstract', 'Introduction', 'Thematic Analysis', 'Critical Discussion', 'Conclusion'] },
            { key: 'research_report', name: 'Research Report', section_titles: ['Executive Summary', 'Background', 'Findings', 'Analysis', 'Recommendations'] },
            { key: 'thesis_chapter', name: 'Thesis Chapter', section_titles: ['Introduction', 'Literature Review', 'Methodology', 'Results', 'Discussion'] },
          ]);
        });
    }
  }, [open]);

  const selectedTemplateData = templates.find(t => t.key === selectedTemplate);

  // Editable section list (initialized from template, user can reorder/add/remove)
  const [customSections, setCustomSections] = useState<Array<{ title: string; instructions: string }>>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  useEffect(() => {
    if (selectedTemplateData) {
      setCustomSections(selectedTemplateData.section_titles.map(title => ({ title, instructions: '' })));
    }
  }, [selectedTemplateData]);

  const moveSection = useCallback((from: number, to: number) => {
    setCustomSections(prev => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const removeSection = useCallback((idx: number) => {
    setCustomSections(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const addSection = useCallback(() => {
    setCustomSections(prev => [...prev, { title: 'New Section', instructions: '' }]);
  }, []);

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const venue = venues.find(v => v.key === selectedVenue);
      const request: GeneratePaperRequest = {
        // Use venue's base template if venue selected, else user's chosen template
        template_key: venue?.base_template || selectedTemplate,
        output_format: outputFormat,
        // Venue's citation style takes precedence
        citation_style: venue?.citation_style || citationStyle,
      };

      // Apply venue section overrides when venue is selected
      if (venue && venue.section_overrides?.length > 0) {
        request.section_overrides = venue.section_overrides;
      }

      if (researchPlanId) request.research_plan_id = researchPlanId;
      if (synthesisReport) request.synthesis_report = synthesisReport;
      if (notesContent) request.notes_content = notesContent;
      if (discoveriesJson) request.discoveries_json = discoveriesJson;
      if (authorName.trim()) request.author_name = authorName.trim();
      if (authorAffiliation.trim()) request.author_affiliation = authorAffiliation.trim();
      if (keywords.trim()) request.keywords = keywords.split(',').map(k => k.trim()).filter(Boolean);

      const result = await generatePaper(request);

      if (result.status === 'completed') {
        toast.success(t('paper.generateSuccess', 'Paper generated successfully! {{words}} words, {{citations}} citations.', {
          words: result.total_words,
          citations: result.total_citations,
        }));

        // Trigger download
        const downloadUrl = getPaperDownloadUrl(result.paper_id, outputFormat);
        window.open(downloadUrl, '_blank');
        onOpenChange(false);
      } else if (result.status === 'failed') {
        toast.error(result.error_message || t('paper.generateFailed', 'Paper generation failed.'));
      }
    } catch (err) {
      toast.error(t('paper.generateError', 'Failed to generate paper. Please try again.'));
    } finally {
      setIsGenerating(false);
    }
  };

  const hasSources = !!(synthesisReport || notesContent || discoveriesJson);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[540px]" data-testid="paper-generation-dialog" overlayZIndex="1400" disableFullscreenOnMobile>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t('paper.title', 'Generate Paper')}
          </DialogTitle>
          <DialogDescription>
            {t('paper.description', 'Create a formatted paper from your research and notes.')}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="template" data-testid="paper-tab-template">
              {t('paper.tabs.template', 'Template')}
            </TabsTrigger>
            <TabsTrigger value="sections" data-testid="paper-tab-sections">
              {t('paper.tabs.sections', 'Sections')}
            </TabsTrigger>
            <TabsTrigger value="metadata" data-testid="paper-tab-metadata">
              {t('paper.tabs.metadata', 'Metadata')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="template" className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label>{t('paper.templateLabel', 'Paper Template')}</Label>
              <Select value={selectedTemplate} onValueChange={setSelectedTemplate} disabled={!!selectedVenue}>
                <SelectTrigger data-testid="paper-template-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[1500]">
                  {templates.map(tmpl => (
                    <SelectItem key={tmpl.key} value={tmpl.key}>
                      {tmpl.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedVenue && (
                <p className="text-[10px] text-muted-foreground">
                  {t('paper.templateLockedByVenue', 'Template is set by the selected venue.')}
                </p>
              )}
            </div>

            {/* Feature 8: Target Venue */}
            {venues.length > 0 && (
              <div className="space-y-2">
                <Label>{t('paper.targetVenue', 'Target Venue')}</Label>
                <Select
                  value={selectedVenue}
                  onValueChange={(v) => {
                    const newVenue = v === '__none__' ? '' : v;
                    setSelectedVenue(newVenue);
                    const venueCfg = venues.find(ven => ven.key === newVenue);
                    if (venueCfg) {
                      setCitationStyle(venueCfg.citation_style);
                      setSelectedTemplate(venueCfg.base_template);
                    }
                  }}
                >
                  <SelectTrigger data-testid="paper-venue-select">
                    <SelectValue placeholder={t('paper.noVenue', 'No venue (use template defaults)')} />
                  </SelectTrigger>
                  <SelectContent className="z-[1500]">
                    <SelectItem value="__none__">
                      {t('paper.noVenue', 'No venue (use template defaults)')}
                    </SelectItem>
                    {/* Group by type */}
                    {(['journals', 'conferences', 'preprints'] as const).map(group => {
                      const groupVenues = venues.filter(v => v.group === group);
                      if (groupVenues.length === 0) return null;
                      return (
                        <React.Fragment key={group}>
                          <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-t border-border/40 mt-1 pt-2 first:mt-0 first:border-t-0 first:pt-0">
                            {t(`paper.venueGroups.${group}`, group.charAt(0).toUpperCase() + group.slice(1))}
                          </div>
                          {groupVenues.map(v => (
                            <SelectItem key={v.key} value={v.key}>
                              {v.name}
                              <span className="text-[10px] text-muted-foreground ml-2">
                                {v.citation_style.toUpperCase()}
                                {v.word_limit ? ` · ${v.word_limit}w` : ''}
                              </span>
                            </SelectItem>
                          ))}
                        </React.Fragment>
                      );
                    })}
                  </SelectContent>
                </Select>
                {selectedVenue && (() => {
                  const venue = venues.find(v => v.key === selectedVenue);
                  if (!venue) return null;
                  return (
                    <div className="text-[11px] text-muted-foreground border border-border/40 bg-muted/20 p-2 space-y-0.5">
                      <p><strong className="text-foreground">{venue.name}</strong> · {venue.citation_style.toUpperCase()} · {venue.tone}</p>
                      {venue.word_limit && <p>{t('paper.wordLimit', 'Word limit')}: {venue.word_limit}</p>}
                      {venue.section_overrides.length > 0 && (
                        <p>{t('paper.sectionOverrides', 'Custom sections')}: {venue.section_overrides.map(o => o.title).join(', ')}</p>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            <div className="space-y-2">
              <Label>{t('paper.outputFormat', 'Output Format')}</Label>
              <Select value={outputFormat} onValueChange={(v) => setOutputFormat(v as 'pdf' | 'docx' | 'markdown')}>
                <SelectTrigger data-testid="paper-format-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[1500]">
                  <SelectItem value="pdf">PDF</SelectItem>
                  <SelectItem value="docx">DOCX (Word)</SelectItem>
                  <SelectItem value="markdown">Markdown</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>{t('paper.citationStyle', 'Citation Style')}</Label>
              <Select value={citationStyle} onValueChange={setCitationStyle} disabled={!!selectedVenue}>
                <SelectTrigger data-testid="paper-citation-style-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[1500]">
                  <SelectItem value="apa">APA 7th Edition</SelectItem>
                  <SelectItem value="ieee">IEEE</SelectItem>
                  <SelectItem value="chicago">Chicago</SelectItem>
                  <SelectItem value="mla">MLA 9th Edition</SelectItem>
                  <SelectItem value="harvard">Harvard</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Sources indicator */}
            <div className="text-xs text-muted-foreground border border-border p-3 space-y-1">
              <p className="font-medium text-foreground">{t('paper.sources', 'Sources')}</p>
              {synthesisReport && <p>- {t('paper.sourceResearch', 'Deep research synthesis report')}</p>}
              {notesContent && <p>- {t('paper.sourceNotes', 'Notes editor content')}</p>}
              {discoveriesJson && <p>- {t('paper.sourceDiscoveries', 'Research discoveries')}</p>}
              {!hasSources && <p className="text-yellow-600 dark:text-yellow-400">{t('paper.noSources', 'No sources selected. Paper will be generated from template structure only.')}</p>}
            </div>
          </TabsContent>

          <TabsContent value="sections" className="mt-4">
            {customSections.length > 0 ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('paper.sectionEditor', 'Sections')}</Label>
                  <button
                    onClick={addSection}
                    onMouseDown={(e) => e.preventDefault()}
                    className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
                  >
                    <Plus className="h-3 w-3" />
                    {t('paper.addSection', 'Add Section')}
                  </button>
                </div>
                <div className="border border-border divide-y divide-border">
                  {customSections.map((section, idx) => (
                    <div
                      key={idx}
                      draggable
                      onDragStart={() => setDragIdx(idx)}
                      onDragOver={(e) => { e.preventDefault(); }}
                      onDrop={() => { if (dragIdx !== null && dragIdx !== idx) moveSection(dragIdx, idx); setDragIdx(null); }}
                      onDragEnd={() => setDragIdx(null)}
                      className={`px-3 py-2 text-sm flex items-start gap-2 ${dragIdx === idx ? 'opacity-50' : ''}`}
                    >
                      <GripVertical className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5 cursor-grab" />
                      <div className="flex-1 min-w-0 space-y-1">
                        <input
                          type="text"
                          value={section.title}
                          onChange={(e) => {
                            const val = e.target.value;
                            setCustomSections(prev => prev.map((s, i) => i === idx ? { ...s, title: val } : s));
                          }}
                          className="w-full text-sm font-medium bg-transparent border-none p-0 focus:outline-none focus:ring-0"
                        />
                        <input
                          type="text"
                          value={section.instructions}
                          onChange={(e) => {
                            const val = e.target.value;
                            setCustomSections(prev => prev.map((s, i) => i === idx ? { ...s, instructions: val } : s));
                          }}
                          placeholder={t('paper.sectionInstructions', 'Custom instructions for this section (optional)')}
                          className="w-full text-[10px] text-muted-foreground bg-transparent border-none p-0 focus:outline-none focus:ring-0 placeholder:text-muted-foreground/50"
                        />
                      </div>
                      {customSections.length > 1 && (
                        <button
                          onClick={() => removeSection(idx)}
                          onMouseDown={(e) => e.preventDefault()}
                          className="p-0.5 text-muted-foreground hover:text-destructive shrink-0"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  {t('paper.sectionNote', 'Drag to reorder. Each section builds on the previous ones.')}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('paper.selectTemplate', 'Select a template to preview sections.')}</p>
            )}
          </TabsContent>

          <TabsContent value="metadata" className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="author-name">{t('paper.authorName', 'Author Name')}</Label>
              <Input
                id="author-name"
                data-testid="paper-author-name"
                value={authorName}
                onChange={e => setAuthorName(e.target.value)}
                placeholder={t('paper.authorNamePlaceholder', 'Your name')}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="author-affiliation">{t('paper.authorAffiliation', 'Affiliation')}</Label>
              <Input
                id="author-affiliation"
                data-testid="paper-author-affiliation"
                value={authorAffiliation}
                onChange={e => setAuthorAffiliation(e.target.value)}
                placeholder={t('paper.affiliationPlaceholder', 'University or organization')}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="keywords">{t('paper.keywords', 'Keywords')}</Label>
              <Input
                id="keywords"
                data-testid="paper-keywords"
                value={keywords}
                onChange={e => setKeywords(e.target.value)}
                placeholder={t('paper.keywordsPlaceholder', 'Comma-separated keywords')}
              />
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isGenerating}>
            {t('general.cancel', 'Cancel')}
          </Button>
          <Button
            onClick={handleGenerate}
            disabled={isGenerating}
            data-testid="paper-generate-button"
          >
            {isGenerating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('paper.generating', 'Generating...')}
              </>
            ) : (
              <>
                <FileText className="h-4 w-4 mr-2" />
                {t('paper.generate', 'Generate Paper')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
