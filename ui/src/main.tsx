// Import polyfills first
import './polyfills';

// Initialize console error capture and admin debug button BEFORE React
// This ensures the debug button survives React crashes
import { consoleErrorCapture } from './lib/console-error-capture';
import { initAdminDebugButton } from './lib/admin-debug-standalone';

consoleErrorCapture.initialize();
initAdminDebugButton();

// Auto-reload when a lazy-loaded chunk fails after a deployment (a stale
// index referencing chunk hashes that no longer exist). Guard against reload
// loops: if the chunk keeps failing for another reason (offline, a genuinely
// missing chunk), an unconditional reload would loop forever — each reload
// throwing the user back to the initial route. Reload at most once per window.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  const RELOAD_KEY = 'vite_preload_reloaded_at';
  const last = Number(sessionStorage.getItem(RELOAD_KEY) || '0');
  const now = Date.now();
  if (now - last < 15000) {
    // Already reloaded recently for the same reason — let the import reject so
    // the calling component's error boundary handles it, instead of looping.
    console.warn('[preloadError] suppressing reload (reloaded <15s ago)');
    return;
  }
  sessionStorage.setItem(RELOAD_KEY, String(now));
  window.location.reload();
});

// Import i18n
import './i18n';

// Other imports follow
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import './App.css';
import './lib/theme-colors.css';
import {
  installNativeTokenMirror,
  rehydrateNativeTokens,
} from './lib/native-app';

const renderApp = () =>
  ReactDOM.createRoot(document.getElementById('root')!).render(
    // <React.StrictMode>
    <App />
    // </React.StrictMode>
  );

// On the native app, restore tokens from durable native storage into
// localStorage (and keep them mirrored) BEFORE React mounts, so the auth
// context sees a logged-in session even after a WebView cache wipe. On the web
// both calls are no-ops, so the render path is unchanged.
installNativeTokenMirror();
rehydrateNativeTokens().finally(renderApp);
