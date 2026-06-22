import { useEffect, useState } from 'react';
import { getNativeAppVersion } from '@/lib/native-app';

/**
 * Small running-app-version label for the Android app. Shows the version the
 * OTA updater last applied (falls back to the APK versionName before any OTA)
 * so users can confirm at a glance which build they're on. Renders nothing on
 * the regular web. Meant to be dropped into an absolutely-positioned slot so
 * it never shifts the surrounding layout.
 */
export function AppVersionBadge({ className }: { className?: string }) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void getNativeAppVersion().then(setVersion);
  }, []);

  if (!version) return null;

  return (
    <span
      data-testid="app-version-badge"
      className={
        'font-mono text-[10px] tracking-wide text-zinc-400 dark:text-zinc-600 select-none ' +
        (className ?? '')
      }
    >
      v{version}
    </span>
  );
}
