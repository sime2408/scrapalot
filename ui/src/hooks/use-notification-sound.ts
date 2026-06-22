import { useCallback, useRef, useEffect, useState } from 'react';
import { userPrefs } from '@/lib/storage-utils';

const PREFS_KEY = 'notification_sound_enabled';

function createBeep(
  ctx: AudioContext,
  frequency: number,
  duration: number,
  volume = 0.15,
  type: OscillatorType = 'sine'
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

export function useNotificationSound() {
  const ctxRef = useRef<AudioContext | null>(null);
  const [isSoundEnabled, setIsSoundEnabled] = useState(() => {
    const stored = userPrefs.get(PREFS_KEY);
    return stored !== false;
  });

  const getCtx = useCallback(() => {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      ctxRef.current = new AudioContext();
    }
    if (ctxRef.current.state === 'suspended') {
      ctxRef.current.resume().catch(() => {});
    }
    return ctxRef.current;
  }, []);

  const playMessageSound = useCallback(() => {
    if (!isSoundEnabled) return;
    try {
      const ctx = getCtx();
      // Two-tone ping: high-low
      createBeep(ctx, 880, 0.12, 0.12, 'sine');
      setTimeout(() => createBeep(ctx, 660, 0.15, 0.1, 'sine'), 120);
    } catch { /* autoplay blocked */ }
  }, [isSoundEnabled, getCtx]);

  const playCallSound = useCallback(() => {
    if (!isSoundEnabled) return;
    try {
      const ctx = getCtx();
      // Ring pattern: three ascending tones
      createBeep(ctx, 523, 0.2, 0.15, 'sine');
      setTimeout(() => createBeep(ctx, 659, 0.2, 0.15, 'sine'), 250);
      setTimeout(() => createBeep(ctx, 784, 0.3, 0.15, 'sine'), 500);
    } catch { /* autoplay blocked */ }
  }, [isSoundEnabled, getCtx]);

  const toggleSound = useCallback(() => {
    setIsSoundEnabled(prev => {
      const next = !prev;
      userPrefs.set(PREFS_KEY, next);
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (ctxRef.current && ctxRef.current.state !== 'closed') {
        ctxRef.current.close().catch(() => {});
      }
    };
  }, []);

  return { playMessageSound, playCallSound, isSoundEnabled, toggleSound };
}
