import React from 'react';
import { useTheme } from '@/providers/theme-provider';
import SharedHeader from '@/components/shared/header';
import { AuroraBackground, LandingFooter } from '@/components/landing';

const SECTIONS: { title: string; body: React.ReactNode }[] = [
  {
    title: '1. Who we are',
    body: (
      <>
        Scrapalot AI (&quot;Scrapalot&quot;, &quot;we&quot;) provides an AI research
        assistant for your documents, available at{' '}
        <a className='underline' href='https://scrapalot.app'>scrapalot.app</a>{' '}
        and as desktop and Android applications. This policy describes what data
        we process and why. Contact:{' '}
        <a className='underline' href='mailto:hello@mail.scrapalot.app'>hello@mail.scrapalot.app</a>.
      </>
    ),
  },
  {
    title: '2. Data we collect',
    body: (
      <>
        <strong>Account data</strong>: email address, optional name and profile
        picture — entered at registration or provided by Google when you choose
        Google Sign-In (we receive your basic Google profile: email, name,
        picture; we never receive your Google password).{' '}
        <strong>Your content</strong>: documents, notes, and chat messages you
        upload or create — stored so the service can work for you.{' '}
        <strong>Technical data</strong>: standard server logs (IP address,
        timestamps, requests) kept for security and debugging, and usage
        counters (e.g. monthly token usage) used to enforce plan quotas.
      </>
    ),
  },
  {
    title: '3. How we use it',
    body: (
      <>
        Only to provide and improve the service: authenticating you, storing and
        searching your library, generating AI answers, and enforcing plan
        limits. Parts of your content are sent to the AI model providers
        configured for your account (for example OpenAI) strictly to produce
        the answers you request. We do not sell your data and we do not use
        your documents to train models.
      </>
    ),
  },
  {
    title: '4. Storage and retention',
    body: (
      <>
        Data is stored on our servers in the European Union (Hetzner, Germany).
        Your content remains yours and stays available until you delete it
        in the app, or request account deletion (see{' '}
        <a className='underline' href='/delete-account'>How to delete your account</a>);
        deleting your account removes your personal data and content from
        active systems. Server logs rotate automatically.
      </>
    ),
  },
  {
    title: '5. Sharing',
    body: (
      <>
        We share data only with the processors required to run the service: AI
        model providers (to generate answers from the text you submit), our
        hosting provider (Hetzner, EU), Stripe (payments, when you purchase a
        plan — we never see your full card number), and Google (when you sign
        in with Google). We never share your library with other users unless
        you explicitly use a sharing feature.
      </>
    ),
  },
  {
    title: '6. Your rights',
    body: (
      <>
        You can manage and delete individual documents and notes at any time
        from within the app. To access, correct, export, or delete your account
        and all associated data, email{' '}
        <a className='underline' href='mailto:hello@mail.scrapalot.app'>hello@mail.scrapalot.app</a>{' '}
        (see <a className='underline' href='/delete-account'>How to delete your account</a>).
        EU/EEA users have the rights provided by the GDPR, including the right
        to lodge a complaint with a supervisory authority.
      </>
    ),
  },
  {
    title: '7. Children',
    body: (
      <>
        Scrapalot is not directed at children under 13 and we do not knowingly
        collect data from them.
      </>
    ),
  },
  {
    title: '8. Changes',
    body: (
      <>
        We will post any changes to this policy on this page and update the
        date below. Material changes will be announced in the app.
      </>
    ),
  },
];

export default function PrivacyPage() {
  const { theme, accentColor } = useTheme();
  const isDarkMode = theme === 'dark';

  return (
    <div data-testid='page-privacy-container' className='landing-page flex min-h-screen flex-col'>
      <SharedHeader isDarkMode={isDarkMode} accentColor={accentColor} />

      <main className='flex-1'>
        <section className='relative overflow-hidden'>
          <AuroraBackground variant='hero' />
          <div className='relative mx-auto max-w-3xl px-4 pb-20 pt-36 sm:px-6 sm:pt-40'>
            <h1 className='font-display text-4xl font-medium tracking-tight sm:text-5xl'>
              Privacy <span className='landing-gradient-text italic'>Policy</span>
            </h1>
            <p className='mt-4 font-mono text-[11px] uppercase tracking-wider opacity-50'>
              Last updated: June 11, 2026
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

      <LandingFooter testId='privacy-footer' />
    </div>
  );
}
