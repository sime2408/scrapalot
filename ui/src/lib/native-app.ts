// Runtime integration with the Capacitor-wrapped Android/iOS app
// (scrapalot-mobile). Capacitor injects window.Capacitor into its WebView, so
// the same production web bundle serves both the website and the native shell —
// everything here is a no-op on the regular web.
import { defaultUrlTransform } from 'react-markdown';
import { PROD_STATIC_BASE_URL } from '@/lib/api';

interface CapacitorPlugin {
  addListener?: (
    event: string,
    cb: (data: { canGoBack?: boolean; percent?: number }) => void
  ) => void;
  minimizeApp?: () => Promise<void>;
  initialize?: (opts: unknown) => Promise<void>;
  login?: (opts: unknown) => Promise<{ result?: { idToken?: string | null } }>;
  setColors?: (opts: { color: string; dark: boolean }) => Promise<void>;
  // @capacitor/app
  getInfo?: () => Promise<{ version?: string }>;
  // @capgo/capacitor-updater (self-hosted manual mode)
  notifyAppReady?: () => Promise<unknown>;
  current?: () => Promise<{ bundle?: { version?: string } }>;
  download?: (opts: { url: string; version: string }) => Promise<{ id?: string }>;
  set?: (opts: { id: string }) => Promise<void>;
  // next() stages the bundle WITHOUT reloading — it activates on the next time
  // the app is backgrounded / relaunched, so an update never interrupts an
  // active session (vs set(), which reloads immediately).
  next?: (opts: { id: string }) => Promise<void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, CapacitorPlugin | undefined>;
}

const getCapacitor = (): CapacitorGlobal | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (window as { Capacitor?: CapacitorGlobal }).Capacitor;

export const isNativeApp = (): boolean =>
  getCapacitor()?.isNativePlatform?.() === true;

/**
 * The version to show in the app UI. In the native app this is the RUNNING
 * web-bundle version (what OTA last applied), falling back to the installed
 * APK versionName before any OTA. Returns null on the regular web (no
 * meaningful single app version there).
 */
export const getNativeAppVersion = async (): Promise<string | null> => {
  if (!isNativeApp()) return null;
  const plugins = getCapacitor()?.Plugins;
  try {
    const current = await plugins?.CapacitorUpdater?.current?.();
    const bundleVersion = current?.bundle?.version;
    if (bundleVersion && bundleVersion !== 'builtin') return bundleVersion;
    const info = await plugins?.App?.getInfo?.();
    return info?.version ?? null;
  } catch {
    return null;
  }
};

/**
 * react-markdown urlTransform for backend-relative assets. The WebView serves
 * the bundle from the https://scrapalot.app origin, so same-origin paths like
 * /upload/... would hit the LOCAL bundle (404) instead of the server. Rewrite
 * them to the API host, which the gateway serves publicly. No-op on the web.
 */
export const mdUrlTransform = (url: string): string => {
  const rewritten =
    isNativeApp() && url.startsWith('/upload/')
      ? `${PROD_STATIC_BASE_URL}${url}`
      : url;
  return defaultUrlTransform(rewritten);
};

/** Numeric dotted-version compare: true when `a` is strictly newer than `b`. */
const isNewerVersion = (a: string, b: string): boolean => {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
};

/**
 * Self-hosted OTA updates for the web bundle inside the Android app
 * (@capgo/capacitor-updater in manual mode, no Capgo cloud).
 *
 * On every native startup:
 *  1. notifyAppReady() — confirms the current bundle boots; without it the
 *     plugin auto-rolls-back to the previous bundle after an update (this is
 *     the crash safety net).
 *  2. Fetch downloads/mobile-latest.json (via the API host — same-origin
 *     scrapalot.app paths are intercepted by the local bundle) and compare
 *     with the running bundle version (the APK's versionName when still on
 *     the built-in bundle).
 *  3. If newer: download the zip (published by scrapalot-mobile
 *     scripts/publish-bundle.sh) and set() it — the WebView reloads straight
 *     into the new version.
 *
 * Web-only changes therefore reach installed apps without a new APK; native
 * changes (plugins, manifest, icons) still ship as an APK. No-op on the web.
 */
/**
 * Minimal DOM banner for OTA feedback. Built directly (not React) because the
 * updater runs at startup, outside the React tree, and must remain visible
 * right up to the WebView reload. Fixed top strip, theme-agnostic colors.
 */
const otaBanner = (() => {
  let el: HTMLDivElement | null = null;
  const ensure = (): HTMLDivElement => {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'scrapalot-ota-banner';
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'padding:10px 14px', 'font:600 13px system-ui,sans-serif',
      'text-align:center', 'color:#fff', 'background:#2563eb',
      'box-shadow:0 1px 6px rgba(0,0,0,.3)',
      // Click-through: the progress strip is a passive status indicator,
      // so taps reach the app controls underneath it. The error variant
      // (tap-to-dismiss) re-enables pointer events explicitly below.
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(el);
    return el;
  };
  return {
    show: (text: string, bg = '#2563eb') => {
      const node = ensure();
      node.textContent = text;
      node.style.background = bg;
    },
    hideAfter: (ms: number) => {
      setTimeout(() => { el?.remove(); el = null; }, ms);
    },
    // Persistent error banner: stays until tapped, so the reason can be read
    // off the screen without chrome://inspect.
    error: (text: string) => {
      const node = ensure();
      node.textContent = text;
      node.style.background = '#dc2626';
      node.style.whiteSpace = 'normal';
      node.style.cursor = 'pointer';
      node.style.pointerEvents = 'auto';
      node.onclick = () => { el?.remove(); el = null; };
    },
  };
})();

/**
 * Self-hosted OTA updates for the web bundle inside the Android app
 * (@capgo/capacitor-updater in manual mode, no Capgo cloud). Shows a visible
 * banner + logs every branch under the [OTA] tag so the whole flow is
 * observable from chrome://inspect. See initNativeBundleUpdater doc above for
 * the lifecycle. No-op on the regular web.
 */
const initNativeBundleUpdater = (): void => {
  const plugins = getCapacitor()?.Plugins;
  const updater = plugins?.CapacitorUpdater;
  if (!updater?.notifyAppReady) {
    console.warn('[OTA] CapacitorUpdater plugin unavailable — skipping update check');
    return;
  }

  void (async () => {
    try {
      await updater.notifyAppReady();

      const res = await fetch(`${PROD_STATIC_BASE_URL}/downloads/mobile-latest.json`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        console.warn('[OTA] latest.json fetch failed:', res.status);
        return;
      }
      const latest = (await res.json()) as { version?: string; url?: string };
      if (!latest.version || !latest.url) {
        console.warn('[OTA] latest.json missing version/url');
        return;
      }

      const current = await updater.current?.();
      let runningVersion = current?.bundle?.version;
      if (!runningVersion || runningVersion === 'builtin') {
        runningVersion = (await plugins?.App?.getInfo?.())?.version ?? '0.0.0';
      }

      if (!isNewerVersion(latest.version, runningVersion)) {
        console.log(`[OTA] up to date (running ${runningVersion}, latest ${latest.version})`);
        return;
      }

      console.log(`[OTA] update available: ${runningVersion} -> ${latest.version}, downloading…`);
      otaBanner.show(`Ažuriranje aplikacije ${latest.version}…`);

      // Live download progress, if the plugin emits it.
      updater.addListener?.('download', (info) => {
        if (typeof info.percent === 'number') {
          otaBanner.show(`Ažuriranje ${latest.version}… ${Math.round(info.percent)}%`);
        }
      });

      const downloaded = await updater.download?.({ url: latest.url, version: latest.version });
      if (!downloaded?.id) {
        console.warn('[OTA] download returned no bundle id');
        otaBanner.error('OTA: download nije vratio bundle (tap)');
        return;
      }

      console.log(`[OTA] downloaded ${latest.version} (id=${downloaded.id}), staging for next launch…`);
      // Stage the bundle with next() instead of set(): next() activates the
      // update the next time the app is backgrounded / relaunched, so it never
      // reloads mid-session. set() would reload the WebView the instant the
      // background download finished — closing whatever dialog the user has
      // open and dropping them back on the initial chat.
      await updater.next?.({ id: downloaded.id });
      // next() does NOT reload, so nothing clears the banner — auto-dismiss it
      // after a few seconds (set() used to vanish with the immediate reload).
      otaBanner.show(`Ažuriranje ${latest.version} spremno — aktivira se na sljedeće otvaranje`, '#16a34a');
      otaBanner.hideAfter(6000);
    } catch (err) {
      // Never let the updater break app startup — worst case the user stays
      // on the bundled version until the next launch. Surface the actual
      // reason on-screen (tap to dismiss) so it can be read without a debugger.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn('[OTA] bundle update check failed:', err);
      otaBanner.error(`OTA greška: ${reason.slice(0, 160)} (tap)`);
    }
  })();
};

/**
 * Sync the Android system-bar strips (status bar + navigation bar areas) with
 * the app theme. The mobile shell insets the WebView by the bar heights
 * (adjustMarginsForEdgeToEdge), so the strips show the native window
 * background — the local SystemBars plugin paints it with the app's real
 * background color and flips the bar icon contrast so the clock/battery/
 * signal and the navigation buttons stay readable on both themes. No-op on
 * the regular web.
 */
export const syncNativeSystemBars = (isDark: boolean): void => {
  if (!isNativeApp()) return;
  const bars = getCapacitor()?.Plugins?.SystemBars;
  if (!bars?.setColors) return;

  // Wait one frame so the theme class flip has been applied to the DOM
  // before we read the effective background color.
  requestAnimationFrame(() => {
    const toHex = (cssColor: string): string | null => {
      const m = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!m) return null;
      if (m[4] !== undefined && parseFloat(m[4]) === 0) return null; // transparent
      const hex = (v: string) => parseInt(v, 10).toString(16).padStart(2, '0');
      return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
    };
    const color =
      toHex(getComputedStyle(document.body).backgroundColor) ??
      toHex(getComputedStyle(document.documentElement).backgroundColor) ??
      (isDark ? '#14171f' : '#ffffff');
    void bars.setColors({ color, dark: isDark });
  });
};

/** True when a Radix overlay (dialog, popover, dropdown, sheet) is open. */
const hasOpenOverlay = (): boolean =>
  document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [data-radix-popper-content-wrapper]'
  ) !== null;

/**
 * Android hardware/gesture back button: close the topmost overlay first (via
 * the Escape key Radix listens for), then navigate history, then minimize the
 * app (never exit — Android UX guideline). Registering the listener disables
 * Capacitor's default back behaviour. Call once at app startup.
 */
export const initNativeAppShell = (): void => {
  if (!isNativeApp()) return;

  // Kick off the OTA web-bundle check (fire-and-forget, never blocks boot).
  initNativeBundleUpdater();

  const app = getCapacitor()?.Plugins?.App;
  if (!app?.addListener) return;

  app.addListener('backButton', ({ canGoBack }) => {
    if (hasOpenOverlay()) {
      // Dispatch from an Element (not document): keydown handlers commonly do
      // event.target.closest(...), and HTMLDocument has no .closest — that
      // crashed with "closest is not a function". Bubbling still reaches the
      // document-level Radix escape listeners.
      const target = (document.activeElement as HTMLElement | null) ?? document.body;
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        })
      );
    } else if (canGoBack !== false && window.history.length > 1) {
      window.history.back();
    } else {
      void app.minimizeApp?.();
    }
  });
};

/**
 * Native Google Sign-In via the Credential Manager bottom sheet
 * (@capgo/capacitor-social-login, registered by the mobile shell). Resolves
 * with the Google ID token; the backend verifies it and issues Scrapalot JWTs.
 * webClientId comes from GET /auth/google/config (the existing web client id —
 * Credential Manager uses it as serverClientId, so the token audience matches
 * what the backend expects).
 */
export const nativeGoogleSignIn = async (webClientId: string): Promise<string> => {
  const social = getCapacitor()?.Plugins?.SocialLogin;
  if (!social?.initialize || !social.login) {
    throw new Error('SocialLogin plugin unavailable');
  }
  await social.initialize({ google: { webClientId } });
  const response = await social.login({ provider: 'google', options: {} });
  const idToken = response?.result?.idToken;
  if (!idToken) {
    throw new Error('Google sign-in returned no ID token');
  }
  return idToken;
};

// ---------------------------------------------------------------------------
// Durable native token storage (Android "stay logged in")
// ---------------------------------------------------------------------------
// The Capacitor WebView keeps auth tokens in localStorage, which Android can
// evict under storage pressure, on "Clear cache", or when the WebView data is
// wiped — silently logging the user out. We mirror the token keys into
// @capacitor/preferences (backed by Android SharedPreferences, which survives
// those events) and rehydrate them into localStorage on cold start. The whole
// module is a no-op on the regular web, where localStorage is already durable.

interface PreferencesPlugin {
  get(opts: { key: string }): Promise<{ value: string | null }>;
  set(opts: { key: string; value: string }): Promise<void>;
  remove(opts: { key: string }): Promise<void>;
}

// Keys whose every write/removal must be mirrored to native storage. These are
// exactly the values the auth layer reads at boot to decide "am I logged in?".
const DURABLE_TOKEN_KEYS = ['auth_tokens', 'token_expiry'] as const;
const NATIVE_TOKEN_PREFIX = 'native_';

const getPreferences = (): PreferencesPlugin | undefined =>
  getCapacitor()?.Plugins?.Preferences as unknown as PreferencesPlugin | undefined;

const isDurableTokenKey = (key: string): boolean =>
  (DURABLE_TOKEN_KEYS as readonly string[]).includes(key);

/**
 * Restore token keys from native storage into localStorage when the WebView
 * lost them (cache wipe, eviction). MUST run before the auth context reads
 * localStorage at boot. Only fills keys that are currently MISSING — a present
 * localStorage value is always newer (it was just written this session), so we
 * never clobber it. No-op on the web.
 */
export const rehydrateNativeTokens = async (): Promise<void> => {
  if (!isNativeApp()) return;
  const prefs = getPreferences();
  if (!prefs) return;
  for (const key of DURABLE_TOKEN_KEYS) {
    try {
      if (localStorage.getItem(key)) continue;
      const { value } = await prefs.get({ key: NATIVE_TOKEN_PREFIX + key });
      if (value) localStorage.setItem(key, value);
    } catch {
      // best effort — a failed restore just means a normal re-login
    }
  }
};

/**
 * Wrap localStorage so every write/removal of a token key is mirrored into
 * native storage. All other keys pass straight through untouched. Installing
 * this once at boot covers every token write site (login, refresh, logout)
 * without threading a helper through each of them. No-op on the web.
 */
export const installNativeTokenMirror = (): void => {
  if (!isNativeApp()) return;
  const prefs = getPreferences();
  if (!prefs) return;
  const origSet = localStorage.setItem.bind(localStorage);
  const origRemove = localStorage.removeItem.bind(localStorage);
  localStorage.setItem = (key: string, value: string): void => {
    origSet(key, value);
    if (isDurableTokenKey(key)) {
      void prefs.set({ key: NATIVE_TOKEN_PREFIX + key, value }).catch(() => {});
    }
  };
  localStorage.removeItem = (key: string): void => {
    origRemove(key);
    if (isDurableTokenKey(key)) {
      void prefs.remove({ key: NATIVE_TOKEN_PREFIX + key }).catch(() => {});
    }
  };
};
