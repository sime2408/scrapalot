import { cn } from '@/lib/utils';
import { useFloatingWindowManager } from '@/contexts/floating-window-context';

export function EdgeSnapOverlay() {
  const { edgeSnapActive, edgeSnapZone } = useFloatingWindowManager();
  if (!edgeSnapActive) return null;
  return (
    <div className="fixed inset-0 z-[55] pointer-events-none" aria-hidden>
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-1/2 transition-opacity duration-100',
          'bg-muted-foreground/10 border-2 border-dashed border-muted-foreground/40',
          edgeSnapZone === 'left' ? 'opacity-100 bg-primary/15 border-primary/60' : 'opacity-30',
        )}
      />
      <div
        className={cn(
          'absolute right-0 top-0 bottom-0 w-1/2 transition-opacity duration-100',
          'bg-muted-foreground/10 border-2 border-dashed border-muted-foreground/40',
          edgeSnapZone === 'right' ? 'opacity-100 bg-primary/15 border-primary/60' : 'opacity-30',
        )}
      />
    </div>
  );
}
