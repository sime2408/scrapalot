import { Loader2 } from 'lucide-react';
import { useLoading } from '@/contexts/loading-context';
import { Progress } from '@/components/ui/progress';

export function ProcessingOverlay() {
  const { isProcessingDocuments, processingMessage, processingProgress } =
    useLoading();

  if (!isProcessingDocuments) return null;

  return (
    <div className='fixed bottom-4 right-4 z-5 bg-background/95 border border-border rounded-lg shadow-lg p-4 w-80'>
      <div className='flex flex-col space-y-3'>
        <div className='flex items-center space-x-2'>
          <Loader2 className='h-5 w-5 animate-spin text-primary' />
          <h3 className='text-sm font-medium'>Document Processing</h3>
        </div>

        <p className='text-xs text-muted-foreground'>
          {processingMessage || 'Please wait while we process your document...'}
        </p>

        <div className='w-full'>
          <Progress value={processingProgress} className='h-2' />
          <p className='text-xs text-right mt-1 text-muted-foreground'>
            {processingProgress.toFixed(1)}%
          </p>
        </div>

        <p className='text-xs text-muted-foreground italic'>
          You can continue using the application while processing completes.
        </p>
      </div>
    </div>
  );
}
