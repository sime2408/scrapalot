/**
 * Simple Mode Toggle.
 *
 * `useSimpleMode()` returns the current value as a synchronous boolean
 * read from settings_general.simple_mode_enabled (mirrored to
 * localStorage on every change so cold-load doesn't flicker between
 * showing-all and hiding-advanced).
 *
 * Components that should hide in simple mode wrap their root:
 *
 *   const simpleMode = useSimpleMode();
 *   if (simpleMode) return null;
 *   return <AdvancedThing />;
 *
 * Default for NEW users will be `true` (simpler onboarding); existing
 * users keep the un-gated experience until they explicitly opt in.
 * Distinguishing 'never set' from 'set to false' is what the
 * localStorage tri-state ("missing" vs "false" vs "true") encodes.
 */
import { useEffect, useState } from 'react';

const KEY = 'scrapalot_simple_mode_enabled';

function readLocal(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true';
  } catch {
    return false;
  }
}

export function useSimpleMode(): boolean {
  const [enabled, setEnabled] = useState<boolean>(readLocal);

  useEffect(() => {
    const onChange = (e: StorageEvent) => {
      if (e.key === KEY) setEnabled(readLocal());
    };
    const onCustom = () => setEnabled(readLocal());
    window.addEventListener('storage', onChange);
    window.addEventListener('scrapalot:simple-mode-changed', onCustom);
    return () => {
      window.removeEventListener('storage', onChange);
      window.removeEventListener('scrapalot:simple-mode-changed', onCustom);
    };
  }, []);

  return enabled;
}

/** Imperative setter — used by the settings page; fires a custom
 *  event so other tabs/components pick up the change without a full
 *  reload (storage event only fires across tabs). */
export function setSimpleModeEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, String(enabled));
    window.dispatchEvent(new CustomEvent('scrapalot:simple-mode-changed'));
  } catch {
    // ignore storage quota errors
  }
}
