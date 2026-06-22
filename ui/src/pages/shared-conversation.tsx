import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getSharedConversation, type SharedConversationDTO } from '@/lib/api-session-shares';
import { Loader2, MessageSquare } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { mdUrlTransform } from '@/lib/native-app';

export default function SharedConversationPage() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const { t } = useTranslation();
  const [conversation, setConversation] = useState<SharedConversationDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!shareToken) return;
    setLoading(true);
    getSharedConversation(shareToken)
      .then(setConversation)
      .catch((err) => {
        const status = err?.response?.status;
        if (status === 404) {
          setError(t('share.notFound'));
        } else {
          setError(t('share.errorLoading'));
        }
      })
      .finally(() => setLoading(false));
  }, [shareToken, t]);

  if (loading) {
    return (
      <div className='flex items-center justify-center min-h-screen bg-background'>
        <Loader2 className='h-8 w-8 animate-spin text-muted-foreground' />
      </div>
    );
  }

  if (error || !conversation) {
    return (
      <div className='flex flex-col items-center justify-center min-h-screen bg-background text-center px-4'>
        <MessageSquare className='h-12 w-12 text-muted-foreground mb-4' />
        <h1 className='text-xl font-semibold mb-2'>{error || t('share.notFound')}</h1>
        <a href='/' className='text-primary hover:underline text-sm mt-4'>
          {t('share.backToHome')}
        </a>
      </div>
    );
  }

  return (
    <div className='min-h-screen bg-background'>
      <header className='sticky top-0 z-10 border-b border-border bg-background/85 px-4 py-3 backdrop-blur-md'>
        <div className='max-w-3xl mx-auto flex items-center justify-between'>
          <div>
            <h1 className='font-display text-xl font-medium tracking-tight'>
              {conversation.conversation_name || t('share.untitledConversation')}
            </h1>
            <p className='text-xs text-muted-foreground'>
              {t('share.sharedOn', { date: new Date(conversation.shared_at).toLocaleDateString() })}
            </p>
          </div>
          <a href='/' className='flex items-center gap-1.5 text-xs text-primary hover:underline'>
            <img src='/logo512.png' alt='' className='h-4 w-4 object-contain dark:invert' />
            Scrapalot AI
          </a>
        </div>
      </header>

      <main className='max-w-3xl mx-auto px-4 py-6'>
        <div className='space-y-4'>
          {conversation.messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] px-4 py-3 text-sm ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted'
                }`}
              >
                {msg.role === 'user' ? (
                  <p className='whitespace-pre-wrap'>{msg.content}</p>
                ) : (
                  <div className='prose prose-sm dark:prose-invert max-w-none'>
                    <ReactMarkdown urlTransform={mdUrlTransform}>{msg.content}</ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </main>

      <footer className='border-t border-border px-4 py-3 mt-8'>
        <div className='max-w-3xl mx-auto text-center text-xs text-muted-foreground'>
          {t('share.footer')}
        </div>
      </footer>
    </div>
  );
}
