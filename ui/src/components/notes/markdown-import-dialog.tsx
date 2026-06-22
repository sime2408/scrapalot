/**
 * Markdown Import Dialog
 * Allows users to import Markdown content either by pasting text or uploading a file
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Editor } from '@tiptap/react';
import { FileUp, FileText } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/lib/toast-compat';
import { markdownToHtml } from './utils/markdown-converter';

interface MarkdownImportDialogProps {
  editor: Editor | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const MarkdownImportDialog: React.FC<MarkdownImportDialogProps> = ({
  editor,
  open,
  onOpenChange,
}) => {
  const { t } = useTranslation();
  const [markdownText, setMarkdownText] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  const handleImportText = async () => {
    if (!editor || !markdownText.trim()) {
      toast({
        title: t('common.error'),
        description: t('notes.markdownImport.enterText'),
        variant: 'destructive',
      });
      return;
    }

    setIsImporting(true);
    try {
      // Convert Markdown to HTML
      const html = markdownToHtml(markdownText);

      // Use insertContent command which handles large content better than replaceSelection
      // This uses TipTap's optimized insertion which batches changes for Y.js collaboration
      const success = editor.chain().focus().insertContent(html).run();

      if (!success) {
        toast({
          title: t('common.error'),
          description: t('notes.markdownImport.importError'),
          variant: 'destructive',
        });
        return;
      }

      toast({
        title: t('common.success'),
        description: t('notes.markdownImport.pasteSuccess'),
      });

      // Reset and close
      setMarkdownText('');
      onOpenChange(false);
    } catch (error) {
      console.error('[MarkdownImport] Error importing markdown:', error);
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('notes.markdownImport.importError'),
        variant: 'destructive',
      });
    } finally {
      setIsImporting(false);
    }
  };

  const handleImportFile = () => {
    if (!editor) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.txt';

    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      setIsImporting(true);
      try {
        const text = await file.text();

        // Convert Markdown to HTML
        const html = markdownToHtml(text);

        // Use insertContent command which handles large content better than replaceSelection
        // This uses TipTap's optimized insertion which batches changes for Y.js collaboration
        const success = editor.chain().focus().insertContent(html).run();

        if (!success) {
          toast({
            title: t('common.error'),
            description: t('notes.markdownImport.fileReadError'),
            variant: 'destructive',
          });
          return;
        }

        toast({
          title: t('common.success'),
          description: t('notes.markdownImport.fileSuccess', { filename: file.name }),
        });

        onOpenChange(false);
      } catch (error) {
        console.error('[MarkdownImport] Error reading file:', error);
        toast({
          title: t('common.error'),
          description: error instanceof Error ? error.message : t('notes.markdownImport.fileReadError'),
          variant: 'destructive',
        });
      } finally {
        setIsImporting(false);
      }
    };

    input.click();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="notes-markdown-import-dialog" className="sm:max-w-[600px]" overlayZIndex="10100" dialogOpen={open} onOpenChange={onOpenChange}>
        <DialogHeader>
          <DialogTitle>{t('notes.markdownImport.title')}</DialogTitle>
          <DialogDescription>
            {t('notes.markdownImport.description')}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="paste" className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-4">
            <TabsTrigger data-testid="notes-markdown-tab-paste" value="paste">
              <FileText className="mr-2 h-4 w-4" />
              {t('notes.markdownImport.pasteTab')}
            </TabsTrigger>
            <TabsTrigger data-testid="notes-markdown-tab-file" value="file">
              <FileUp className="mr-2 h-4 w-4" />
              {t('notes.markdownImport.uploadTab')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="paste" className="space-y-4 min-h-[420px]">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('notes.markdownImport.contentLabel')}</label>
              <Textarea
                data-testid="notes-markdown-paste-textarea"
                placeholder={t('notes.markdownImport.pastePlaceholder')}
                value={markdownText}
                onChange={(e) => setMarkdownText(e.target.value)}
                className="min-h-[300px] font-mono text-sm"
                disabled={isImporting}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isImporting}
              >
                {t('common.cancel')}
              </Button>
              <Button
                data-testid="notes-markdown-import-button"
                onClick={handleImportText}
                disabled={isImporting || !markdownText.trim()}
              >
                {isImporting ? t('notes.markdownImport.importing') : t('notes.markdownImport.import')}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="file" className="space-y-4 min-h-[420px]">
            <div className="flex flex-col items-center justify-center h-full space-y-4">
              <div className="rounded-full bg-muted p-4">
                <FileUp className="h-8 w-8 text-muted-foreground" />
              </div>
              <div className="text-center space-y-2">
                <p className="text-sm font-medium">{t('notes.markdownImport.selectFile')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('notes.markdownImport.supportedFormats')}
                </p>
              </div>
              <Button
                data-testid="notes-markdown-upload-button"
                onClick={handleImportFile}
                disabled={isImporting}
                size="lg"
              >
                <FileUp className="mr-2 h-4 w-4" />
                {isImporting ? t('notes.markdownImport.importing') : t('notes.markdownImport.chooseFile')}
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};
