import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  HardDrive,
  MonitorSmartphone,
  Shield,
  Zap,
} from 'lucide-react';
import { useTheme } from '@/providers/theme-provider';
import SharedHeader from '@/components/shared/header';
import { api } from '@/lib/api';
import {
  AuroraBackground,
  LandingFooter,
  SectionHeading,
  SpotlightCard,
} from '@/components/landing';

// Direct APK download served from /downloads/ on the npm proxy volume
// (published by scrapalot-mobile/scripts/publish-apk.sh). Not on Play Store yet.
const ANDROID_APP = {
  // Kept in sync with android/app/build.gradle versionName by
  // scrapalot-mobile/scripts/build-web.sh on every release build.
  version: '0.2.21',
  url: 'https://scrapalot.app/downloads/scrapalot-mobile.apk',
  size: '~41 MB',
};

// Android robot head (Material Design Icons path) — lucide has no brand icons
const AndroidIcon = ({ className }: { className?: string }) => (
  <svg viewBox='0 0 24 24' fill='currentColor' className={className} aria-hidden='true'>
    <path d='M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24c-2.86-1.21-6.08-1.21-8.94 0L5.65 5.67c-.19-.29-.58-.38-.87-.2-.28.18-.37.54-.22.83L6.4 9.48C3.3 11.25 1.28 14.44 1 18h22c-.28-3.56-2.3-6.75-5.4-8.52zM7 15.25c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25 1.25.56 1.25 1.25-.56 1.25-1.25 1.25zm10 0c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25 1.25.56 1.25 1.25-.56 1.25-1.25 1.25z' />
  </svg>
);

interface DesktopRelease {
  version: string;
  releaseDate: string;
  windows: {
    url: string;
    size: string;
    sha256?: string;
  };
  mac: {
    url: string;
    size: string;
    sha256?: string;
  };
  changelog: string[];
}

const DESKTOP_FEATURES = [
  {
    icon: Shield,
    title: '100% Private',
    description:
      'All data stored locally on your machine. No cloud storage, no data transmission. Complete privacy.',
  },
  {
    icon: Zap,
    title: 'Offline First',
    description:
      'Works completely offline with local AI models. Internet only needed for updates.',
  },
  {
    icon: HardDrive,
    title: 'Single User',
    description:
      'Optimized for personal research. No login required, auto-starts to your workspace.',
  },
];

export default function DesktopPage() {
  const navigate = useNavigate();
  const { theme, accentColor } = useTheme();
  const isDarkMode = theme === 'dark';

  const [latestRelease, setLatestRelease] = useState<DesktopRelease | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch latest release info
  useEffect(() => {
    const fetchLatestRelease = async () => {
      try {
        setIsLoading(true);
        const response = await api.get<DesktopRelease>('/desktop/releases/latest');
        setLatestRelease(response.data);
      } catch (error) {
        console.error('Failed to fetch desktop release:', error);
        // Set fallback data if API fails
        setLatestRelease({
          version: '1.0.0',
          releaseDate: new Date().toISOString(),
          windows: {
            url: 'https://api.scrapalot.app/api/v1/desktop/download/windows',
            size: '~250 MB',
          },
          mac: {
            url: 'https://api.scrapalot.app/api/v1/desktop/download/mac',
            size: '~200 MB',
          },
          changelog: [
            'Initial desktop release',
            'Local SQLite database with auto-login',
            'Embedded Python backend',
            'Auto-update system',
          ],
        });
      } finally {
        setIsLoading(false);
      }
    };

    void fetchLatestRelease();
  }, []);

  const handleDownload = (platform: 'windows' | 'mac') => {
    if (!latestRelease) return;

    const downloadUrl = platform === 'windows'
      ? latestRelease.windows.url
      : latestRelease.mac.url;

    // Track download
    try {
      void api.post('/desktop/downloads/track', {
        platform,
        version: latestRelease.version,
      });
    } catch (error) {
      console.error('Failed to track download:', error);
    }

    // Start download
    window.location.href = downloadUrl;
  };

  return (
    <div data-testid='page-desktop-container' className='landing-page flex min-h-screen flex-col'>
      <SharedHeader isDarkMode={isDarkMode} accentColor={accentColor} />

      <main className='flex-1'>
        {/* Hero Section */}
        <section className='relative overflow-hidden'>
          <AuroraBackground variant='hero' />
          <div className='relative mx-auto max-w-6xl px-4 pb-16 pt-36 text-center sm:px-6 sm:pt-40'>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
            >
              <div className='mx-auto mb-7 inline-flex h-16 w-16 items-center justify-center border border-primary/25 bg-primary/10'>
                <HardDrive className='h-8 w-8 text-primary' />
              </div>

              <h1 className='font-display text-5xl font-medium leading-[1.05] tracking-tight sm:text-6xl'>
                Scrapalot <span className='landing-gradient-text italic'>Apps</span>
              </h1>

              <p className='mx-auto mt-6 max-w-2xl text-base leading-relaxed opacity-70 sm:text-lg'>
                The private desktop app for fully local research — and the
                Android app for your Scrapalot cloud workspace, anywhere.
              </p>

              {!isLoading && latestRelease && (
                <div className='mt-7 inline-flex items-center gap-2 border border-emerald-500/30 bg-emerald-500/10 px-4 py-1.5 font-mono text-[11px] tracking-wide text-emerald-600 dark:text-emerald-400'>
                  <CheckCircle2 className='h-3.5 w-3.5' />
                  Desktop {latestRelease.version}
                  <span className='opacity-60'>
                    ({new Date(latestRelease.releaseDate).toLocaleDateString()})
                  </span>
                </div>
              )}
            </motion.div>

            {/* Download Cards */}
            <div className='mx-auto mt-14 grid max-w-4xl gap-4 md:grid-cols-3'>
              {([
                {
                  platform: 'windows' as const,
                  title: 'Windows',
                  subtitle: 'Windows 10, 11 (64-bit)',
                  size: latestRelease?.windows.size,
                  testId: 'desktop-download-windows-button',
                  label: 'Download for Windows',
                  // Desktop builds are not published yet — disabled until ready
                  comingSoon: true,
                },
                {
                  platform: 'mac' as const,
                  title: 'macOS',
                  subtitle: 'macOS 11+',
                  size: latestRelease?.mac.size,
                  testId: 'desktop-download-mac-button',
                  label: 'Download for macOS',
                  comingSoon: true,
                },
              ]).map((card, index) => (
                <motion.div
                  key={card.platform}
                  initial={{ opacity: 0, y: 24 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.2 + index * 0.1, ease: 'easeOut' }}
                >
                  <SpotlightCard className='flex h-full flex-col p-7 text-left'>
                    <div className='flex items-center gap-3'>
                      <div className='flex h-11 w-11 items-center justify-center border border-primary/25 bg-primary/10'>
                        <MonitorSmartphone className='h-5 w-5 text-primary' />
                      </div>
                      <div>
                        <h3 className='font-display text-2xl font-medium tracking-tight'>
                          {card.title}
                        </h3>
                        <p className='text-xs opacity-60'>{card.subtitle}</p>
                      </div>
                    </div>

                    <div className='mt-4 min-h-[1rem] font-mono text-[10px] uppercase tracking-wider opacity-50'>
                      {!card.comingSoon && card.size ? `Size: ${card.size}` : ''}
                    </div>

                    <Button
                      data-testid={card.testId}
                      onClick={() => handleDownload(card.platform)}
                      disabled={card.comingSoon || isLoading || !latestRelease}
                      className='landing-btn-primary mt-5 w-full py-3 text-sm font-medium'
                      size='lg'
                    >
                      {card.comingSoon ? (
                        'Coming soon'
                      ) : (
                        <>
                          <Download className='mr-2 h-4 w-4' />
                          {card.label}
                        </>
                      )}
                    </Button>
                  </SpotlightCard>
                </motion.div>
              ))}

              {/* Android — direct APK download (not on Play Store yet) */}
              <motion.div
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.4, ease: 'easeOut' }}
              >
                <SpotlightCard className='flex h-full flex-col p-7 text-left'>
                  <div className='flex items-center gap-3'>
                    <div className='flex h-11 w-11 items-center justify-center border border-primary/25 bg-primary/10'>
                      <AndroidIcon className='h-5 w-5 text-primary' />
                    </div>
                    <div>
                      <h3 className='font-display text-2xl font-medium tracking-tight'>
                        Android
                      </h3>
                      <p className='text-xs opacity-60'>Android 6.0+ (direct APK)</p>
                    </div>
                  </div>

                  <div className='mt-4 min-h-[1rem] font-mono text-[10px] uppercase tracking-wider opacity-50'>
                    Size: {ANDROID_APP.size} · v{ANDROID_APP.version} beta
                  </div>

                  <Button
                    asChild
                    data-testid='desktop-download-android-button'
                    className='landing-btn-primary mt-5 w-full py-3 text-sm font-medium'
                    size='lg'
                  >
                    <a href={ANDROID_APP.url}>
                      <Download className='mr-2 h-4 w-4' />
                      Download for Android
                    </a>
                  </Button>

                  <p className='mt-3 text-center font-mono text-[10px] uppercase tracking-wider opacity-50'>
                    Play Store — coming soon
                  </p>
                </SpotlightCard>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className='relative py-20'>
          <div className='landing-hairline absolute inset-x-0 top-0 mx-auto max-w-5xl' />
          <div className='mx-auto max-w-6xl px-4 sm:px-6'>
            <SectionHeading
              eyebrow='Why desktop'
              title={
                <>
                  Research that <span className='landing-gradient-text italic'>stays yours</span>
                </>
              }
            />

            <div className='mx-auto mt-12 grid max-w-5xl gap-4 md:grid-cols-3'>
              {DESKTOP_FEATURES.map((feature, index) => (
                <motion.div
                  key={feature.title}
                  initial={{ opacity: 0, y: 24 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-60px' }}
                  transition={{ duration: 0.5, delay: index * 0.1 }}
                >
                  <SpotlightCard className='h-full p-7'>
                    <div className='inline-flex h-11 w-11 items-center justify-center border border-primary/25 bg-primary/10'>
                      <feature.icon className='h-5 w-5 text-primary' />
                    </div>
                    <h3 className='mt-5 text-lg font-semibold tracking-tight'>{feature.title}</h3>
                    <p className='mt-2 text-sm leading-relaxed opacity-65'>
                      {feature.description}
                    </p>
                  </SpotlightCard>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Changelog */}
        {latestRelease && latestRelease.changelog.length > 0 && (
          <section className='pb-16'>
            <div className='mx-auto max-w-3xl px-4 sm:px-6'>
              <h2 className='font-display text-3xl font-medium tracking-tight'>
                What&apos;s new in{' '}
                <span className='landing-gradient-text italic'>{latestRelease.version}</span>
              </h2>

              <div className='landing-glass mt-6 p-7'>
                <ul className='space-y-3'>
                  {latestRelease.changelog.map((item, index) => (
                    <motion.li
                      key={index}
                      className='flex items-start gap-3'
                      initial={{ opacity: 0, x: -12 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.4, delay: index * 0.06 }}
                    >
                      <CheckCircle2 className='mt-0.5 h-4 w-4 shrink-0 text-primary' />
                      <span className='text-sm opacity-80'>{item}</span>
                    </motion.li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        )}

        {/* Installation Instructions */}
        <section className='pb-20'>
          <div className='mx-auto max-w-3xl px-4 sm:px-6'>
            <div className='landing-glass p-8'>
              <h2 className='font-display text-3xl font-medium tracking-tight'>Installation</h2>

              <div className='mt-6 grid gap-8 sm:grid-cols-2'>
                <div>
                  <div className='landing-eyebrow mb-3 text-primary'>Windows</div>
                  <ol className='list-inside list-decimal space-y-1.5 text-sm opacity-75'>
                    <li>Download Scrapalot-Setup-{latestRelease?.version || '1.0.0'}-x64.exe</li>
                    <li>Run the installer (accept SmartScreen warning if not signed)</li>
                    <li>Follow installation wizard</li>
                    <li>Launch Scrapalot from Start Menu or Desktop</li>
                  </ol>
                </div>

                <div>
                  <div className='landing-eyebrow mb-3 text-primary'>macOS</div>
                  <ol className='list-inside list-decimal space-y-1.5 text-sm opacity-75'>
                    <li>Download Scrapalot-{latestRelease?.version || '1.0.0'}-x64.dmg</li>
                    <li>Open the DMG file</li>
                    <li>Drag Scrapalot to Applications folder</li>
                    <li>Launch from Applications (right-click → Open first time)</li>
                  </ol>
                </div>

                <div>
                  <div className='landing-eyebrow mb-3 text-primary'>Android</div>
                  <ol className='list-inside list-decimal space-y-1.5 text-sm opacity-75'>
                    <li>Download scrapalot-mobile.apk on your phone</li>
                    <li>Open the downloaded file from the notification</li>
                    <li>Allow installing from your browser when prompted</li>
                    <li>Sign in — new accounts get the free Researcher plan</li>
                  </ol>
                </div>
              </div>

              <div className='mt-7 border border-primary/25 bg-primary/5 p-4'>
                <p className='text-sm opacity-80'>
                  <strong className='text-primary'>Note:</strong> First launch may take 1-2
                  minutes while the database initializes and Python backend starts.
                </p>
              </div>
            </div>

            {/* Back to Home */}
            <div className='mt-12 text-center'>
              <Button
                data-testid='desktop-back-home-button'
                variant='outline'
                onClick={() => navigate('/')}
                className='landing-btn-ghost border-0'
              >
                <ArrowLeft className='mr-2 h-4 w-4' />
                Back to Home
              </Button>
            </div>
          </div>
        </section>
      </main>

      <LandingFooter testId='desktop-footer' />
    </div>
  );
}
