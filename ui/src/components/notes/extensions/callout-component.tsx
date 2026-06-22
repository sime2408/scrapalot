/**
 * Callout Component - React NodeView for Callout Extension
 * Renders styled alert boxes with type selection dropdown
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { NodeViewWrapper, NodeViewContent } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/core';
import { CALLOUT_TYPES, CalloutType } from './callout-types';
import { useTheme } from '@/providers/theme-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { ChevronDown } from 'lucide-react';

export const CalloutComponent: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
}) => {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const calloutType = (node.attrs.type || 'default') as CalloutType;
  const config = CALLOUT_TYPES[calloutType] || CALLOUT_TYPES.default;

  const bgColor = theme === 'dark' ? config.bgDark : config.bgLight;
  const borderColor = theme === 'dark' ? config.borderDark : config.borderLight;

  return (
    <NodeViewWrapper
      className="callout-wrapper my-4"
      style={{
        backgroundColor: bgColor,
        borderLeft: `4px solid ${borderColor}`,
        padding: '12px 16px',
        borderRadius: '6px',
      }}
    >
      <div className="flex items-start gap-3">
        <span className="text-xl select-none flex-shrink-0 mt-0.5">{config.icon}</span>
        <div className="flex-1 min-w-0">
          <NodeViewContent />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Change callout type"
            >
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {Object.entries(CALLOUT_TYPES).map(([type, typeConfig]) => (
              <DropdownMenuItem
                key={type}
                onClick={() => updateAttributes({ type })}
                className="flex items-center gap-2"
              >
                <span className="text-base">{typeConfig.icon}</span>
                <span>{t(typeConfig.labelKey)}</span>
                {type === calloutType && (
                  <span className="ml-auto text-primary">✓</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </NodeViewWrapper>
  );
};
