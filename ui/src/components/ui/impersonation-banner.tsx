import React from 'react';
import { UserCog, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { exitImpersonation, getImpersonationState } from '@/lib/impersonation';
import { useAuth } from '@/hooks/use-auth';

/**
 * Top-of-page banner that's only visible while an admin is operating
 * inside another user's session. Clicking "Exit" swaps the admin's
 * stashed tokens back in and reloads to /dashboard so every context
 * (workspace, collections, settings, models) re-bootstraps under the
 * admin identity.
 *
 * Re-rendering on storage events lets the banner appear/disappear
 * without a manual reload after impersonation actions performed in
 * other tabs (e.g. exiting impersonation in tab A while tab B is open).
 */
export function ImpersonationBanner() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [state, setState] = React.useState(getImpersonationState());

  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (
        e.key === 'scrapalot_impersonation' ||
        e.key === 'auth_tokens' ||
        e.key === null
      ) {
        setState(getImpersonationState());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Stale-state cleanup: if the impersonation key still says we are
  // pretending to be X, but the currently authenticated user is
  // someone else, the session must have expired and the admin re-
  // logged in fresh. The banner has nothing to point at any longer
  // and the "Exit impersonation" button would just stash the new
  // admin tokens under their own — wipe the state and bail.
  React.useEffect(() => {
    if (!state) return;
    if (!user) return;
    const currentUserId = (user as { id?: string }).id;
    if (currentUserId && currentUserId !== state.target_user.id) {
      try {
        localStorage.removeItem('scrapalot_impersonation');
      } catch {
        // ignore quota / private-mode failures
      }
      setState(null);
    }
  }, [user, state]);

  if (!state) return null;

  const handleExit = () => {
    exitImpersonation();
    // Hard reload to /dashboard so AuthContext, workspace, collections
    // and every settings cache rehydrates under the restored admin
    // identity. A simple navigate() would keep stale React state.
    window.location.href = '/dashboard';
  };

  const targetLabel = state.target_user.username || state.target_user.email;

  return (
    <>
      {/* Breathing glow keyframe — animates the inset ring thickness + glow
          so the frame "pulses" like the Claude-in-Chrome control indicator.
          Scoped inline (only mounted during impersonation) to avoid touching
          global CSS / the Tailwind config. */}
      <style>{`@keyframes scrapalot-impersonate-glow {
        0%, 100% { box-shadow: inset 0 0 16px 2px rgba(245,158,11,0.40); }
        50%      { box-shadow: inset 0 0 32px 6px rgba(245,158,11,0.70); }
      }`}</style>

      {/* App-wide pulsing amber frame — the ambient "you are impersonating"
          signal. Full-viewport but pointer-events-none with an edges-only
          inset glow (transparent center), so it never covers, dims, or blocks
          any control anywhere in the app. */}
      <div
        aria-hidden
        data-testid='impersonation-frame'
        className='fixed inset-0 z-[99998] pointer-events-none'
        style={{ animation: 'scrapalot-impersonate-glow 2.4s ease-in-out infinite' }}
      />

      {/* Identity + exit (✕) chip, just below the header so the top nav stays
          clear. The frame signals the mode; this names who is being
          impersonated and carries the exit control. Wrapper is
          pointer-events-none; only the ✕ button is interactive. */}
      <div
        data-testid='impersonation-banner'
        className='fixed top-16 left-1/2 -translate-x-1/2 z-[99999] pointer-events-none flex justify-center max-w-[calc(100vw-1rem)]'
      >
        <div className='pointer-events-none flex items-center gap-1.5 bg-amber-500/90 dark:bg-amber-600/90 backdrop-blur-sm pl-2.5 pr-1 py-0.5 border border-amber-700/50 dark:border-amber-800/50 shadow-sm max-w-full'>
          <UserCog className='h-3.5 w-3.5 text-amber-950 dark:text-amber-50 shrink-0' />
          <p className='text-xs text-amber-950 dark:text-amber-50 truncate min-w-0 opacity-50'>
            <span className='font-semibold'>
              {t('impersonation.banner.label', 'Impersonating')}:
            </span>{' '}
            {targetLabel}
          </p>
          <button
            onClick={handleExit}
            data-testid='impersonation-exit-button'
            aria-label={t('impersonation.banner.exit', 'Exit impersonation')}
            title={t('impersonation.banner.exit', 'Exit impersonation')}
            className='pointer-events-auto shrink-0 flex items-center justify-center bg-amber-700 hover:bg-amber-800 dark:bg-amber-900 dark:hover:bg-amber-950 p-1 text-amber-50'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        </div>
      </div>
    </>
  );
}
