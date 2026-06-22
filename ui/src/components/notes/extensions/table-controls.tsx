/**
 * Table Controls Component
 * Floating toolbar for table manipulation (add/delete rows/columns, toggle header)
 */

import React from 'react';
import { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import {
  Plus,
  Trash2,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

interface TableControlsProps {
  editor: Editor;
}

export const TableControls: React.FC<TableControlsProps> = ({ editor }) => {
  if (!editor.isActive('table')) return null;

  return (
    <div className="flex gap-1 p-2 bg-background border rounded-md shadow-lg">
      {/* Column Controls */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 px-2">
            <Plus className="h-3.5 w-3.5 mr-1" />
            <span className="text-xs">Column</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1" align="start">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => editor.chain().focus().addColumnBefore().run()}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Insert before
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => editor.chain().focus().addColumnAfter().run()}
          >
            <ArrowRight className="h-4 w-4 mr-2" />
            Insert after
          </Button>
        </PopoverContent>
      </Popover>

      {/* Row Controls */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 px-2">
            <Plus className="h-3.5 w-3.5 mr-1" />
            <span className="text-xs">Row</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1" align="start">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => editor.chain().focus().addRowBefore().run()}
          >
            <ArrowUp className="h-4 w-4 mr-2" />
            Insert before
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => editor.chain().focus().addRowAfter().run()}
          >
            <ArrowDown className="h-4 w-4 mr-2" />
            Insert after
          </Button>
        </PopoverContent>
      </Popover>

      <div className="w-px h-6 bg-border mx-1" />

      {/* Delete Column */}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        onClick={() => editor.chain().focus().deleteColumn().run()}
        title="Delete column"
      >
        <Trash2 className="h-3.5 w-3.5 mr-1" />
        <span className="text-xs">Col</span>
      </Button>

      {/* Delete Row */}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        onClick={() => editor.chain().focus().deleteRow().run()}
        title="Delete row"
      >
        <Trash2 className="h-3.5 w-3.5 mr-1" />
        <span className="text-xs">Row</span>
      </Button>

      <div className="w-px h-6 bg-border mx-1" />

      {/* Toggle Header */}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        onClick={() => editor.chain().focus().toggleHeaderRow().run()}
        title="Toggle header row"
      >
        <span className="text-xs">Header</span>
      </Button>
    </div>
  );
};
