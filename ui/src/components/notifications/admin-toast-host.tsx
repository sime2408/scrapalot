import { useTranslation } from 'react-i18next';
import { Megaphone, MessageSquare } from 'lucide-react';
import {
  ToastProvider,
  ToastViewport,
  Toast,
  ToastContent,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
} from '@/components/ui/toast';
import { ProfileImg } from '@/components/ui/profile-img';
import { useAdminMessages } from '@/contexts/admin-messages-context';

/**
 * Prominent, PERSISTENT admin-message toasts, top-right (Slack/WhatsApp style).
 *
 * Mounts the otherwise-unused Radix toast layer with `duration={Infinity}` so a
 * toast never auto-dismisses — it stays until the user clicks the X or "Clear"
 * (which marks the thread read via the context's `dismiss`). Rendered only when
 * the per-user "prominent toast" preference is on (the context decides what goes
 * into `toasts`); when off, messages still arrive silently in the bell.
 */
export function AdminToastHost() {
  const { t } = useTranslation();
  const { toasts, dismiss, dismissToast } = useAdminMessages();

  return (
    <ToastProvider duration={Infinity} swipeDirection="right">
      {toasts.map((item) => {
        const isBroadcast = item.kind === 'admin_broadcast';
        return (
          <Toast
            key={item.conversationId}
            variant={isBroadcast ? 'warning' : 'info'}
            // Swiping or any close → just hide the toast (keep it unread in the bell).
            onOpenChange={(open) => {
              if (!open) dismissToast(item.conversationId);
            }}
          >
            <div className="flex-shrink-0 mt-0.5">
              {item.senderProfilePicture ? (
                <ProfileImg
                  pic={item.senderProfilePicture}
                  alt=""
                  className="h-8 w-8 rounded-full object-cover border border-border"
                />
              ) : isBroadcast ? (
                <Megaphone className="h-5 w-5" />
              ) : (
                <MessageSquare className="h-5 w-5" />
              )}
            </div>
            <ToastContent>
              <ToastTitle>
                {isBroadcast ? t('notifications.toast.announcement', 'Announcement') : item.senderName}
              </ToastTitle>
              <ToastDescription className="line-clamp-4 whitespace-pre-wrap">{item.content}</ToastDescription>
              <div className="mt-2 flex gap-2">
                <ToastAction
                  altText={t('notifications.toast.clear', 'Clear')}
                  onClick={() => void dismiss(item.conversationId)}
                >
                  {t('notifications.toast.clear', 'Clear')}
                </ToastAction>
              </div>
            </ToastContent>
            <ToastClose onClick={() => dismissToast(item.conversationId)} />
          </Toast>
        );
      })}
      {/* Mobile (Android WebView incl.): full-width with side margins so the toast
          never overflows the left edge. Desktop (sm+): right-anchored 420px box.
          top-anchored on all sizes (overrides the component's default bottom-4).
          Top uses the safe-area inset so it clears the Android status bar / notch
          (degrades to 1rem when viewport-fit=cover isn't set). */}
      <ToastViewport className="top-[calc(env(safe-area-inset-top,0px)+1rem)] right-4 left-4 bottom-auto w-auto max-w-none sm:left-auto sm:w-full sm:max-w-[420px]" />
    </ToastProvider>
  );
}
