/**
 * Table Grip Menu - Confluence-style popover for row/column operations
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Editor } from '@tiptap/react';
import {
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Trash2,
  Eraser,
  Paintbrush,
  MoveUp,
  MoveDown,
  MoveLeft,
  MoveRight,
  ToggleLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  focusCell,
  clearRowCells,
  clearColumnCells,
  selectRow,
  selectColumn,
  setRowBackground,
  setColumnBackground,
  moveRowUp,
  moveRowDown,
  moveColumnLeft,
  moveColumnRight,
  TABLE_CELL_COLORS,
} from './table-commands';
import { TextSelect } from 'lucide-react';

interface TableGripMenuProps {
  editor: Editor;
  type: 'row' | 'column';
  index: number;
  onClose: () => void;
}

const MenuItem: React.FC<{
  onClick: () => void;
  icon: React.ElementType;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}> = ({ onClick, icon: Icon, label, destructive, disabled }) => (
  <button
    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
    onClick={(e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) onClick();
    }}
    disabled={disabled}
    className={cn(
      'w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors',
      destructive
        ? 'text-destructive hover:bg-destructive/10 cursor-pointer'
        : 'hover:bg-accent hover:text-accent-foreground cursor-pointer',
      disabled && 'opacity-40 cursor-not-allowed'
    )}
    type="button"
  >
    <Icon className="h-3.5 w-3.5 flex-shrink-0" />
    <span>{label}</span>
  </button>
);

const Separator = () => <div className="h-px bg-border my-1" />;

/**
 * Focus cell synchronously, then run command synchronously, then close.
 * No setTimeout — everything in one event handler tick.
 */
function runCommand(editor: Editor, row: number, col: number, command: () => void, onClose: () => void) {
  focusCell(editor, row, col);
  command();
  onClose();
}

export const TableGripMenu: React.FC<TableGripMenuProps> = ({
  editor,
  type,
  index,
  onClose,
}) => {
  const { t } = useTranslation();
  const [showColors, setShowColors] = useState(false);

  if (type === 'row') {
    return (
      <div
        className="w-52 bg-popover border border-border shadow-lg py-1 z-50"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <MenuItem
          icon={TextSelect}
          label={t('notes.table.selectRow', 'Select row')}
          onClick={() => { selectRow(editor, index); onClose(); }}
        />
        <Separator />
        <MenuItem
          icon={ArrowUp}
          label={t('notes.table.addRowAbove')}
          onClick={() => runCommand(editor, index, 0,
            () => editor.chain().focus().addRowBefore().run(), onClose)}
        />
        <MenuItem
          icon={ArrowDown}
          label={t('notes.table.addRowBelow')}
          onClick={() => runCommand(editor, index, 0,
            () => editor.chain().focus().addRowAfter().run(), onClose)}
        />
        <Separator />
        <MenuItem
          icon={Eraser}
          label={t('notes.table.clearCells')}
          onClick={() => { clearRowCells(editor, index); onClose(); }}
        />
        <MenuItem
          icon={Trash2}
          label={t('notes.table.deleteRow')}
          destructive
          onClick={() => runCommand(editor, index, 0,
            () => editor.chain().focus().deleteRow().run(), onClose)}
        />
        <Separator />
        <div>
          <button
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowColors(!showColors); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
            type="button"
          >
            <Paintbrush className="h-3.5 w-3.5 flex-shrink-0" />
            {t('notes.table.backgroundColor')}
          </button>
          {showColors && (
            <div className="px-3 py-2 grid grid-cols-4 gap-1.5">
              {TABLE_CELL_COLORS.map((color) => (
                <button
                  key={color.label}
                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onClick={() => { setRowBackground(editor, index, color.value); onClose(); }}
                  className={cn(
                    'w-7 h-7 border border-border hover:ring-2 hover:ring-primary transition-all',
                    !color.value && 'bg-background relative'
                  )}
                  style={color.value ? { backgroundColor: color.value } : undefined}
                  title={color.label}
                  type="button"
                >
                  {!color.value && <span className="text-xs text-muted-foreground">✕</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <Separator />
        <MenuItem
          icon={MoveUp}
          label={t('notes.table.moveRowUp')}
          disabled={index === 0}
          onClick={() => { moveRowUp(editor, index); onClose(); }}
        />
        <MenuItem
          icon={MoveDown}
          label={t('notes.table.moveRowDown')}
          onClick={() => { moveRowDown(editor, index); onClose(); }}
        />
        <Separator />
        <MenuItem
          icon={ToggleLeft}
          label={t('notes.table.toggleHeaderRow')}
          onClick={() => runCommand(editor, index, 0,
            () => editor.chain().focus().toggleHeaderRow().run(), onClose)}
        />
      </div>
    );
  }

  // Column menu
  return (
    <div
      className="w-52 bg-popover border border-border shadow-lg py-1 z-50"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MenuItem
        icon={TextSelect}
        label={t('notes.table.selectColumn', 'Select column')}
        onClick={() => { selectColumn(editor, index); onClose(); }}
      />
      <Separator />
      <MenuItem
        icon={ArrowLeft}
        label={t('notes.table.addColumnLeft')}
        onClick={() => runCommand(editor, 0, index,
          () => editor.chain().focus().addColumnBefore().run(), onClose)}
      />
      <MenuItem
        icon={ArrowRight}
        label={t('notes.table.addColumnRight')}
        onClick={() => runCommand(editor, 0, index,
          () => editor.chain().focus().addColumnAfter().run(), onClose)}
      />
      <Separator />
      <MenuItem
        icon={Eraser}
        label={t('notes.table.clearCells')}
        onClick={() => { clearColumnCells(editor, index); onClose(); }}
      />
      <MenuItem
        icon={Trash2}
        label={t('notes.table.deleteColumn')}
        destructive
        onClick={() => runCommand(editor, 0, index,
          () => editor.chain().focus().deleteColumn().run(), onClose)}
      />
      <Separator />
      <div>
        <button
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowColors(!showColors); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
          type="button"
        >
          <Paintbrush className="h-3.5 w-3.5 flex-shrink-0" />
          {t('notes.table.backgroundColor')}
        </button>
        {showColors && (
          <div className="px-3 py-2 grid grid-cols-4 gap-1.5">
            {TABLE_CELL_COLORS.map((color) => (
              <button
                key={color.label}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onClick={() => { setColumnBackground(editor, index, color.value); onClose(); }}
                className={cn(
                  'w-7 h-7 border border-border hover:ring-2 hover:ring-primary transition-all',
                  !color.value && 'bg-background relative'
                )}
                style={color.value ? { backgroundColor: color.value } : undefined}
                title={color.label}
                type="button"
              >
                {!color.value && <span className="text-xs text-muted-foreground">✕</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <Separator />
      <MenuItem
        icon={MoveLeft}
        label={t('notes.table.moveColumnLeft')}
        disabled={index === 0}
        onClick={() => { moveColumnLeft(editor, index); onClose(); }}
      />
      <MenuItem
        icon={MoveRight}
        label={t('notes.table.moveColumnRight')}
        onClick={() => { moveColumnRight(editor, index); onClose(); }}
      />
    </div>
  );
};
