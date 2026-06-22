import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, HelpCircle, Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Label for the confirm button. Defaults to i18n 'common.confirm'. */
  confirmLabel?: string;
  /** Label for the cancel button. Defaults to i18n 'common.cancel'. */
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  /** Shows a red destructive confirm button. */
  isDangerous?: boolean;
  /** Shows a spinner on the confirm button and disables both buttons. */
  isLoading?: boolean;
  /** Optional data-testid for the confirm button. */
  confirmButtonTestId?: string;
  className?: string;
}

/**
 * Reusable confirmation dialog built on top of AlertDialog.
 *
 * Usage:
 *   <ConfirmDialog
 *     open={open} onOpenChange={setOpen}
 *     title="Delete document?" description="This cannot be undone."
 *     onConfirm={handleDelete} isDangerous
 *   />
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  isDangerous = false,
  isLoading = false,
  confirmButtonTestId,
  className,
}: ConfirmDialogProps) {
  const { t } = useTranslation();

  const handleConfirm = async (e: React.MouseEvent) => {
    e.preventDefault();
    await onConfirm();
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    // Enter confirms the action. Radix focuses Cancel by default on
    // destructive dialogs, so we intercept at the content level and
    // prevent the focused button from also handling the key.
    if (e.key === 'Enter' && !e.shiftKey && !isLoading) {
      e.preventDefault();
      await onConfirm();
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={className} onKeyDown={handleKeyDown}>
        <div className='flex items-start gap-4'>
          {/* Leading icon chip anchors the question visually */}
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center border',
              isDangerous
                ? 'border-destructive/30 bg-destructive/10 text-destructive'
                : 'border-primary/30 bg-primary/10 text-primary'
            )}
          >
            {isDangerous ? (
              <AlertTriangle className='h-5 w-5' />
            ) : (
              <HelpCircle className='h-5 w-5' />
            )}
          </div>
          <AlertDialogHeader className='min-w-0 flex-1 pt-0.5'>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description && (
              <AlertDialogDescription>{description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>
            {cancelLabel ?? t('common.cancel', 'Cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isLoading}
            data-testid={confirmButtonTestId}
            className={cn(isDangerous && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            {confirmLabel ?? t('common.confirm', 'Confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
