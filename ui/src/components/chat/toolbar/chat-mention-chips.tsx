import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FolderOpen, FileText, FileX, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MentionItem } from '@/hooks/use-chat-mentions';
import { useOpenCitationInViewer } from '@/hooks/use-open-citation-in-viewer';
import { probeDocumentFile, useDocumentFileStatusStore } from '@/hooks/use-document-file-status';

interface ChatMentionChipsProps {
  mentions: MentionItem[];
  onRemove: (id: string, type: 'collection' | 'document') => void;
}

const MAX_CHIP_NAME = 35;

function truncateName(name: string): string {
  return name.length > MAX_CHIP_NAME ? name.slice(0, MAX_CHIP_NAME) + '...' : name;
}

const DocumentChip = ({
  mention,
  onRemove,
}: {
  mention: MentionItem;
  onRemove: () => void;
}) => {
  const { t } = useTranslation();
  const openInViewer = useOpenCitationInViewer();
  const fileStatus = useDocumentFileStatusStore(
    (s) => s.status[mention.id] ?? 'unknown'
  );
  useEffect(() => {
    if (mention.id && fileStatus === 'unknown') void probeDocumentFile(mention.id);
  }, [mention.id, fileStatus]);
  const missing = fileStatus === 'missing';

  const openViewer = () => {
    if (missing) return;
    void openInViewer({
      document_id: mention.id,
      document_title: mention.name,
      title: mention.name,
    });
  };

  return (
    <span
      data-testid={`chat-mention-chip-document-${mention.id}`}
      title={mention.name}
      className={cn(
        'inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 text-[11px] font-medium rounded-md border',
        'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700/50 text-blue-700 dark:text-blue-300'
      )}
    >
      <button
        type='button'
        data-testid={`chat-mention-chip-open-${mention.id}`}
        disabled={missing}
        onMouseDown={(e) => e.preventDefault()}
        onClick={openViewer}
        title={
          missing
            ? t(
                'smartCitations.fileMissing.description',
                'The source file for this citation is no longer on disk and cannot be opened.'
              )
            : t('chat.mentions.openDocument', { name: mention.name, defaultValue: `Otvori ${mention.name}` })
        }
        className={cn(
          'inline-flex items-center gap-1 leading-tight',
          missing
            ? 'opacity-50 cursor-not-allowed'
            : 'cursor-pointer hover:opacity-80 transition-opacity'
        )}
      >
        {missing ? (
          <FileX className='h-3 w-3 flex-shrink-0' />
        ) : (
          <FileText className='h-3 w-3 flex-shrink-0' />
        )}
        <span className={cn(missing && 'line-through decoration-current/60')}>
          {truncateName(mention.name)}
        </span>
      </button>
      {typeof mention.pageCount === 'number' && mention.pageCount < 20 && (
        <span className='text-[9px] opacity-50 font-normal' title={t('chat.mentions.directContext')}>
          ctx
        </span>
      )}
      {!missing && (
        <button
          type='button'
          data-testid={`chat-mention-chip-maximize-${mention.id}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            openViewer();
          }}
          title={t('chat.mentions.openDocument', { name: mention.name, defaultValue: `Otvori ${mention.name}` })}
          className='ml-0.5 opacity-50 hover:opacity-100 transition-opacity'
        >
          <Maximize2 className='h-3 w-3' />
        </button>
      )}
      <button
        data-testid={`chat-mention-chip-remove-${mention.id}`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        onMouseDown={e => e.preventDefault()}
        className='ml-0.5 opacity-50 hover:opacity-100 hover:text-red-500 transition-all'
      >
        <X className='h-3 w-3' />
      </button>
    </span>
  );
};

export const ChatMentionChips = ({ mentions, onRemove }: ChatMentionChipsProps) => {
  if (mentions.length === 0) return null;

  return (
    <div data-testid="chat-mention-chips" className='flex flex-wrap gap-1.5 px-2 pt-2 pb-1 border-b border-border/40'>
      {mentions.map(m => {
        if (m.type === 'document') {
          return (
            <DocumentChip
              key={`${m.type}-${m.id}`}
              mention={m}
              onRemove={() => onRemove(m.id, m.type)}
            />
          );
        }
        return (
          <span
            key={`${m.type}-${m.id}`}
            data-testid={`chat-mention-chip-collection-${m.id}`}
            title={m.name}
            className={cn(
              'inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 text-[11px] font-medium rounded-md border',
              'bg-primary/10 dark:bg-primary/15 border-primary/30 text-primary dark:text-primary/90'
            )}
          >
            <FolderOpen className='h-3 w-3 flex-shrink-0' />
            <span className='leading-tight'>{truncateName(m.name)}</span>
            <button
              data-testid={`chat-mention-chip-remove-${m.id}`}
              onClick={() => onRemove(m.id, m.type)}
              onMouseDown={e => e.preventDefault()}
              className='ml-0.5 opacity-50 hover:opacity-100 hover:text-red-500 transition-all'
            >
              <X className='h-3 w-3' />
            </button>
          </span>
        );
      })}
    </div>
  );
};
