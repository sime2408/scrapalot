import { useTranslation } from 'react-i18next';
import { Pin, PinOff, PanelLeft, PanelRight, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import type { WindowMode } from '@/types/floating-window';

interface WindowPinMenuProps {
  mode: WindowMode;
  onSetMode: (mode: WindowMode) => void;
  className?: string;
  /** When false, the maximize entry is hidden (parent handles it elsewhere). */
  showMaximize?: boolean;
  /** When false, the floating entry is hidden (window cannot float). */
  showFloating?: boolean;
  testId?: string;
}

export function WindowPinMenu({
  mode,
  onSetMode,
  className,
  showMaximize = true,
  showFloating = true,
  testId = 'window-pin-menu',
}: WindowPinMenuProps) {
  const { t } = useTranslation();
  const isPinned = mode === 'pinned-left' || mode === 'pinned-right';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t('windowControls.pin', 'Pin window')}
          data-testid={testId}
          className={cn(
            'h-6 w-6 inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors',
            isPinned && 'text-primary',
            className,
          )}
        >
          {isPinned ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 z-[10000]">
        <DropdownMenuItem onClick={() => onSetMode('pinned-left')} data-testid={`${testId}-left`}>
          <PanelLeft className="h-3.5 w-3.5 mr-2" />
          {t('windowControls.pinLeft', 'Pin to left')}
          {mode === 'pinned-left' && <span className="ml-auto text-[10px] text-muted-foreground">●</span>}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSetMode('pinned-right')} data-testid={`${testId}-right`}>
          <PanelRight className="h-3.5 w-3.5 mr-2" />
          {t('windowControls.pinRight', 'Pin to right')}
          {mode === 'pinned-right' && <span className="ml-auto text-[10px] text-muted-foreground">●</span>}
        </DropdownMenuItem>
        {showFloating && (
          <DropdownMenuItem onClick={() => onSetMode('floating')} data-testid={`${testId}-floating`}>
            <PinOff className="h-3.5 w-3.5 mr-2" />
            {t('windowControls.floating', 'Floating')}
            {mode === 'floating' && <span className="ml-auto text-[10px] text-muted-foreground">●</span>}
          </DropdownMenuItem>
        )}
        {showMaximize && (
          <DropdownMenuItem onClick={() => onSetMode('maximized')} data-testid={`${testId}-max`}>
            <Maximize2 className="h-3.5 w-3.5 mr-2" />
            {t('windowControls.maximize', 'Maximize')}
            {mode === 'maximized' && <span className="ml-auto text-[10px] text-muted-foreground">●</span>}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
