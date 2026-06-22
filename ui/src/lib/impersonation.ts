/**
 * Admin impersonation client-side state.
 *
 * When an admin steps into another user's session we need to be able
 * to step back out without losing their own login. The flow:
 *
 *   1. Admin clicks "Impersonate X" → `enterImpersonation()`
 *      stashes the admin's current `auth_tokens` JSON under a separate
 *      key, then writes the target user's tokens into `auth_tokens`.
 *   2. App reloads. From this point on every API call carries the
 *      target user's JWT — the admin literally is that user as far as
 *      the backend is concerned.
 *   3. The impersonation banner reads `getImpersonationState()` and
 *      renders an "Exit impersonation" button.
 *   4. `exitImpersonation()` swaps the admin's stashed tokens back in
 *      and clears the impersonation key.
 *
 * Tokens are stored as raw JSON strings to preserve whichever shape
 * the backend produced (axios stores `{access_token, refresh_token,
 * expires_in}`); we never inspect them client-side, so transparent
 * pass-through is the safest option.
 */

const TOKENS_KEY = 'auth_tokens';
const IMPERSONATION_KEY = 'scrapalot_impersonation';
// The locale lives in TWO places that both have to be kept in sync:
//   1. `i18nextLng` (root key) — read by i18next-browser-languagedetector
//      on the very first init pass before any provider mounts.
//   2. `scrapalot_settings.i18nextLng` — read by `LanguageProvider`
//      on mount, which then calls `i18n.changeLanguage()` and silently
//      overwrites whatever (1) had picked up.
// Updating only (1) makes the swap visible for ~1 ms before the
// provider clobbers it. Updating only (2) skips the cold-load picker.
// We always touch both.
const I18N_KEY = 'i18nextLng';
const SCRAPALOT_SETTINGS_KEY = 'scrapalot_settings';
// Transient locale applied the instant impersonation starts, before the
// reload. It only prevents the admin's UI language from flashing into the
// target's session during the brief bootstrap window — `SettingsPreloader`
// then applies the TARGET user's saved `settings_general.language` from the
// backend (e.g. Croatian) once their settings load, so this neutral default
// is overwritten with the real per-user locale a moment later.
const IMPERSONATION_DEFAULT_LOCALE = 'en';

function writeLocaleEverywhere(locale: string): void {
  localStorage.setItem(I18N_KEY, locale);
  // Merge into the existing scrapalot_settings blob rather than
  // overwrite, so unrelated fields (theme, fontSize, …) survive.
  let blob: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(SCRAPALOT_SETTINGS_KEY);
    if (raw) blob = JSON.parse(raw);
  } catch {
    blob = {};
  }
  blob.i18nextLng = locale;
  localStorage.setItem(SCRAPALOT_SETTINGS_KEY, JSON.stringify(blob));
}

/**
 * Snapshot every `scrapalot_*` localStorage key (excluding the
 * impersonation key itself) and clear it. Anything that survives is
 * non-Scrapalot state we shouldn't touch. The captured map is what
 * `exitImpersonation()` writes back.
 */
function stashAndClearScrapalotStorage(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (!key.startsWith('scrapalot_')) continue;
    if (key === IMPERSONATION_KEY) continue;
    const value = localStorage.getItem(key);
    if (value != null) snapshot[key] = value;
    toRemove.push(key);
  }
  toRemove.forEach(k => localStorage.removeItem(k));
  return snapshot;
}

/**
 * Restore the stashed `scrapalot_*` keys, then drop anything the
 * target user wrote during their session that the admin didn't have
 * (so the admin doesn't inherit, say, the target's expanded-
 * collections list).
 */
function restoreScrapalotStorage(stash: Record<string, string>): void {
  // First, clear any scrapalot_* the target may have written.
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (!key.startsWith('scrapalot_')) continue;
    if (key === IMPERSONATION_KEY) continue;
    toRemove.push(key);
  }
  toRemove.forEach(k => localStorage.removeItem(k));
  // Then write the admin's snapshot back.
  Object.entries(stash).forEach(([k, v]) => localStorage.setItem(k, v));
}

/**
 * Clear transient scrapalot state held in sessionStorage that must NOT survive
 * an identity switch. sessionStorage persists across the same-tab hard reload
 * that enter/exit trigger, so neither path cleared it before — most importantly
 * the deep-research panel snapshot (`scrapalot:deepResearch:v1`), which carried
 * one account's "research in progress" state (and the red stuck Cancel button it
 * drives, blocking the chat input) into the other account. Covers both the
 * colon (`scrapalot:`) and underscore (`scrapalot_`) namespaces. The auth-token
 * and theme sessionStorage flags are managed explicitly by the callers.
 */
function clearScrapalotSessionStorage(): void {
  const toRemove: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key) continue;
    if (key.startsWith('scrapalot:') || key.startsWith('scrapalot_')) {
      toRemove.push(key);
    }
  }
  toRemove.forEach(k => sessionStorage.removeItem(k));
}

export interface ImpersonationTargetUser {
  id: string;
  username: string;
  email: string;
  role: string;
}

interface ImpersonationStateRaw {
  /** Admin's own `auth_tokens` JSON, captured before the swap. */
  original_tokens: string;
  /** Target user metadata, used by the banner only. */
  target_user: ImpersonationTargetUser;
  /** ISO timestamp of when impersonation started, for diagnostics. */
  started_at: string;
  /**
   * Admin's `i18nextLng` value before we swapped in the target's
   * locale. Restored on exit so the admin returns to their chosen UI
   * language without having to flip the language picker again.
   * Optional for backward-compat with sessions that started before
   * this field existed.
   */
  original_locale?: string | null;
  /**
   * Snapshot of every `scrapalot_*` localStorage key the admin had
   * before the swap. Keys are restored verbatim on exit. Without
   * this, admin-scoped state (cached user record, last selected
   * collection, expanded collection list, recent palette entries)
   * leaks into the impersonated session and triggers 403 / 404s the
   * moment the target tries to load anything that referenced an
   * admin-only resource.
   */
  stashed_storage?: Record<string, string>;
}

export function getImpersonationState(): ImpersonationStateRaw | null {
  try {
    const raw = localStorage.getItem(IMPERSONATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImpersonationStateRaw;
    if (!parsed?.original_tokens || !parsed?.target_user?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isImpersonating(): boolean {
  return getImpersonationState() !== null;
}

/**
 * Swap the admin's tokens out for the target user's tokens. The caller
 * is responsible for triggering the navigation/reload that picks up
 * the new identity.
 *
 * Side effect: snapshots `i18nextLng` and switches the UI to the
 * impersonation default locale so the admin's UI language doesn't
 * carry into the target's session.
 */
export function enterImpersonation(
  targetUser: ImpersonationTargetUser,
  newTokensJson: string
): void {
  const adminTokens = localStorage.getItem(TOKENS_KEY);
  if (!adminTokens) {
    throw new Error('No admin tokens to stash; refusing to impersonate');
  }
  const adminLocale = localStorage.getItem(I18N_KEY);
  // Snapshot before any writes so we capture the admin's exact state.
  // The snapshot is intentionally taken BEFORE we set the
  // impersonation key (the function excludes that key anyway, but
  // ordering keeps the intent obvious).
  const stash = stashAndClearScrapalotStorage();
  const state: ImpersonationStateRaw = {
    original_tokens: adminTokens,
    target_user: targetUser,
    started_at: new Date().toISOString(),
    original_locale: adminLocale,
    stashed_storage: stash,
  };
  localStorage.setItem(IMPERSONATION_KEY, JSON.stringify(state));
  localStorage.setItem(TOKENS_KEY, newTokensJson);
  writeLocaleEverywhere(IMPERSONATION_DEFAULT_LOCALE);
  // sessionStorage may also hold a stale copy used by the auth bootstrap
  // path; clearing it guarantees the next page load reads from
  // localStorage.
  sessionStorage.removeItem(TOKENS_KEY);
  // Don't let the admin's transient research/UI sessionStorage state (the
  // deep-research snapshot etc.) bleed into the impersonated identity.
  clearScrapalotSessionStorage();
  // The admin's `themeChangedThisSession` flag would otherwise persist
  // through the reload and silently suppress `SettingsPreloader` from
  // applying the target user's saved appearance. Clearing it lets the
  // impersonated session render in the target's preferred theme.
  sessionStorage.removeItem('themeChangedThisSession');
}

/**
 * Restore the admin's tokens. Caller triggers the reload. Returns
 * true when there was something to restore so the caller can decide
 * whether to navigate or just no-op.
 *
 * Side effect: restores the admin's previous `i18nextLng` so they
 * land back in their chosen UI language.
 */
export function exitImpersonation(): boolean {
  const state = getImpersonationState();
  if (!state) return false;
  localStorage.setItem(TOKENS_KEY, state.original_tokens);
  if (state.stashed_storage) {
    restoreScrapalotStorage(state.stashed_storage);
  }
  if (state.original_locale != null) {
    writeLocaleEverywhere(state.original_locale);
  }
  localStorage.removeItem(IMPERSONATION_KEY);
  sessionStorage.removeItem(TOKENS_KEY);
  // Symmetric to enter: drop the impersonated user's transient research/UI
  // sessionStorage state so it can't bleed back into the admin's session.
  clearScrapalotSessionStorage();
  // Force the "user touched the theme" flag so `SettingsPreloader`
  // skips re-applying the admin's backend `appearance` on the next
  // load. Without this, the post-exit reload races between the
  // restored `scrapalot_user_prefs.theme` (which we just wrote) and
  // the backend value — when the two disagree the preloader wins and
  // the admin's tab silently flips theme on every Exit. The restored
  // prefs already encode the admin's last-seen theme, so locking the
  // preloader out is the correct behaviour.
  sessionStorage.setItem('themeChangedThisSession', '1');
  return true;
}
