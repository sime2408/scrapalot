import React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

export interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Called on form submit. Return a rejected promise to keep dialog open. */
  onSubmit: (e: React.FormEvent) => void | Promise<void>;
  /** Label for the submit button. Defaults to i18n 'common.save'. */
  submitLabel?: string;
  /** Label for the cancel button. Defaults to i18n 'common.cancel'. */
  cancelLabel?: string;
  /** Disables submit button and shows spinner. */
  isLoading?: boolean;
  /** Shown in an error alert above the footer. */
  error?: string | null;
  children: React.ReactNode;
  className?: string;
  /** Extra content to render in the footer alongside the buttons. */
  footerExtra?: React.ReactNode;
}

/**
 * Reusable form dialog with standardized header, footer, loading and error states.
 *
 * Usage:
 *   <FormDialog open={open} onOpenChange={setOpen}
 *     title="New connector" onSubmit={handleSubmit}
 *     isLoading={saving} error={error}>
 *     <Input ... />
 *   </FormDialog>
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  onSubmit,
  submitLabel,
  cancelLabel,
  isLoading = false,
  error,
  children,
  className,
  footerExtra,
}: FormDialogProps) {
  const { t } = useTranslation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSubmit(e);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {children}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            {footerExtra}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              {cancelLabel ?? t('common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {submitLabel ?? t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
