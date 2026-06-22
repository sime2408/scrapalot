import React from 'react';
import { useTheme } from '@/providers/theme-provider';
import SharedHeader from '@/components/shared/header';
import { AuroraBackground, LandingFooter } from '@/components/landing';

const SECTIONS: { title: string; body: React.ReactNode }[] = [
  {
    title: '1. How to request deletion',
    body: (
      <>
        To delete your Scrapalot account and the data associated with it, send
        an email from the address registered on your account to{' '}
        <a className='underline' href='mailto:hello@mail.scrapalot.app?subject=Account%20deletion%20request'>
          hello@mail.scrapalot.app
        </a>{' '}
        with the subject &quot;Account deletion request&quot;. We verify the
        request comes from the account owner and then permanently delete the
        account. You can also reach us at the same address with any question
        about this process.
      </>
    ),
  },
  {
    title: '2. What gets deleted',
    body: (
      <>
        Deleting your account permanently removes your{' '}
        <strong>account data</strong> (email address, name, and profile
        picture) and all of your <strong>content</strong> (documents, notes,
        and chat messages you uploaded or created) from our active systems. Your
        content is yours — none of it is shared or transferred when the account
        is deleted.
      </>
    ),
  },
  {
    title: '3. What may be retained',
    body: (
      <>
        We retain only what we are legally required to keep: billing and invoice
        records associated with past purchases are kept for the period required
        by tax and accounting law, and standard server logs (which rotate
        automatically) may persist for a short time for security and fraud
        prevention. These records do not include your documents, notes, or chat
        messages.
      </>
    ),
  },
  {
    title: '4. Timeline',
    body: (
      <>
        Deletion requests are processed within 30 days. Once complete, the
        account can no longer be used to sign in and the deletion is
        irreversible. If you only want to remove specific documents or notes
        without deleting your account, you can delete them individually from
        within the app at any time.
      </>
    ),
  },
];

export default function DeleteAccountPage() {
  const { theme, accentColor } = useTheme();
  const isDarkMode = theme === 'dark';

  return (
    <div data-testid='page-delete-account-container' className='landing-page flex min-h-screen flex-col'>
      <SharedHeader isDarkMode={isDarkMode} accentColor={accentColor} />

      <main className='flex-1'>
        <section className='relative overflow-hidden'>
          <AuroraBackground variant='hero' />
          <div className='relative mx-auto max-w-3xl px-4 pb-20 pt-36 sm:px-6 sm:pt-40'>
            <h1 className='font-display text-4xl font-medium tracking-tight sm:text-5xl'>
              Delete <span className='landing-gradient-text italic'>Account</span>
            </h1>
            <p className='mt-4 font-mono text-[11px] uppercase tracking-wider opacity-50'>
              Last updated: June 14, 2026
            </p>

            <div className='mt-10 space-y-8'>
              {SECTIONS.map(section => (
                <div key={section.title}>
                  <h2 className='text-lg font-semibold tracking-tight'>
                    {section.title}
                  </h2>
                  <p className='mt-2 text-sm leading-relaxed opacity-75'>
                    {section.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <LandingFooter testId='delete-account-footer' />
    </div>
  );
}
