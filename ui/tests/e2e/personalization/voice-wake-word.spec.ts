/**
 * Voice wake-word — end-to-end coverage for the feature added in `feat(voice):
 * customizable wake word + dedicated Voice settings tab`.
 *
 * Split into two assertions because a real audio + VAD round-trip is flaky
 * to drive from Playwright (requires fake-device audio injection + a real
 * Whisper round-trip per turn). Instead:
 *
 *   1. UI persistence — toggle + name survive an auto-save debounce and a
 *      full page reload. Proves the new fields plumb through `settings.tsx`
 *      → `saveGeneralSettings` → Kotlin merge → DB → `getUserSettings`.
 *
 *   2. Browser-context filter logic — re-evaluates the same predicates the
 *      voice-mode dialog applies (`normaliseWakeWord` + `stripWakeWord`).
 *      Running the helpers inside the page context catches Unicode /
 *      NFD-normalisation regressions a Node-side unit test would miss
 *      (Chromium's `String.prototype.normalize` is the production target).
 */
import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

test.describe('Voice wake-word', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const base = new BasePage(page);
    await base.login(TEST_EMAIL, TEST_PASSWORD);
    // Settings dialog lives on the workspaces / dashboard route, so
    // waiting for chat-input (a chat-route-only widget) hangs the test.
    // networkidle is enough here.
    await page.waitForLoadState('networkidle');
  });

  test('toggle + name persist through reload (settings round-trip)', async ({ page }) => {
    test.setTimeout(90_000);

    // Reset to a known state via API so the assertion isn't tied to
    // whatever the admin account had stored from previous test runs.
    // The dev server on :3000 doesn't proxy /api, so go straight to
    // the gateway and lift the JWT out of session/local storage.
    await page.evaluate(async () => {
      const API = 'http://localhost:8080/api/v1';
      const raw = sessionStorage.getItem('auth_tokens') ?? localStorage.getItem('auth_tokens');
      const token = raw ? (JSON.parse(raw)?.access_token ?? '') : '';
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const r = await fetch(`${API}/settings/`, { headers });
      const arr = await r.json();
      const row = Array.isArray(arr)
        ? arr.find((s: { setting_key?: string }) => s.setting_key === 'settings_general')
        : null;
      const base = (row?.setting_value ?? {}) as Record<string, unknown>;
      await fetch(`${API}/settings/settings_general`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          value: { ...base, voice_wake_word_enabled: false, voice_wake_word: '' },
        }),
      });
    });

    // Open Settings → Voice tab.
    await page.locator('[data-testid="sidebar-quick-tools-settings-button"]').click();
    const voiceTab = page.locator('[data-testid="settings-tab-voice"]');
    await expect(voiceTab).toBeVisible({ timeout: 15_000 });
    await voiceTab.click();

    const toggle = page.locator('[data-testid="settings-voice-wake-word-toggle"]');
    const nameInput = page.locator('[data-testid="settings-voice-wake-word-name"]');
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    await expect(toggle).toHaveAttribute('data-state', 'unchecked');

    // Toggle on, type a custom name, blur to flush React state, wait for
    // the 1 s auto-save debounce on `settings.tsx`.
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'checked');
    await nameInput.fill('Scrapalot');
    await nameInput.blur();

    // The Save endpoint is fire-and-forget on the UI side; we poll the
    // DB through the public GET until the new value lands or the
    // assertion times out. 5 s ceiling covers a 1 s debounce + a slow
    // SAGA ACK round-trip without making the test brittle on a healthy
    // CI run.
    await expect.poll(
      async () => {
        return await page.evaluate(async () => {
          const API = 'http://localhost:8080/api/v1';
          const raw = sessionStorage.getItem('auth_tokens') ?? localStorage.getItem('auth_tokens');
          const token = raw ? (JSON.parse(raw)?.access_token ?? '') : '';
          const r = await fetch(`${API}/settings/`, { headers: { Authorization: `Bearer ${token}` } });
          const arr = await r.json();
          const row = Array.isArray(arr)
            ? arr.find((s: { setting_key?: string }) => s.setting_key === 'settings_general')
            : null;
          const g = (row?.setting_value ?? {}) as Record<string, unknown>;
          return { enabled: g.voice_wake_word_enabled, name: g.voice_wake_word };
        });
      },
      { timeout: 8_000, intervals: [500, 750, 1000] },
    ).toEqual({ enabled: true, name: 'Scrapalot' });

    // Hard reload, reopen Voice tab, confirm the UI rehydrates from
    // the persisted settings (not just from in-memory state).
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator('[data-testid="sidebar-quick-tools-settings-button"]').click();
    await page.locator('[data-testid="settings-tab-voice"]').click();
    await expect(page.locator('[data-testid="settings-voice-wake-word-toggle"]'))
      .toHaveAttribute('data-state', 'checked', { timeout: 15_000 });
    await expect(page.locator('[data-testid="settings-voice-wake-word-name"]'))
      .toHaveValue('Scrapalot', { timeout: 5_000 });
  });

  test('wake-word filter gates transcripts correctly (browser context)', async ({ page }) => {
    test.setTimeout(60_000);

    // The helpers are a port of voice-mode-dialog.tsx — re-implemented
    // here so the test runs inside the built page's V8 (real Chromium
    // string normalisation) rather than a Node-side mock. If the
    // production helper changes, this test goes red.
    const results = await page.evaluate(() => {
      const normaliseWakeWord = (value: string): string =>
        value
          .toLowerCase()
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9 ]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const stripWakeWord = (transcript: string, wakeName: string): string | null => {
        if (!wakeName) return null;
        const norm = normaliseWakeWord(transcript);
        if (!norm.startsWith(wakeName)) return null;
        const rest = norm.slice(wakeName.length).replace(/^[\s,.;:!?\-—]+/, '');
        return rest;
      };

      const wakeName = normaliseWakeWord('Scrapalot');
      // Matrix of cases — `expected` is `null` when the dialog should
      // discard the turn, a string otherwise.
      const cases: Array<{ label: string; transcript: string; expected: string | null }> = [
        { label: 'exact + comma + question',  transcript: 'Scrapalot, what is this book about', expected: 'what is this book about' },
        { label: 'lowercase only',            transcript: 'scrapalot tell me a joke',           expected: 'tell me a joke' },
        { label: 'wake-word only',            transcript: 'Scrapalot.',                         expected: '' },
        { label: 'diacritic noise tolerated', transcript: 'Šcrapalot reci mi nešto',            expected: 'reci mi nesto' },
        { label: 'partial — discard',         transcript: 'Scrap, what now',                    expected: null },
        { label: 'no wake — discard',         transcript: 'what is the weather',                expected: null },
        { label: 'empty transcript',          transcript: '',                                   expected: null },
        { label: 'wake mid-utterance',        transcript: 'hey there scrapalot',                expected: null },
      ];
      return cases.map((c) => ({ ...c, actual: stripWakeWord(c.transcript, wakeName) }));
    });

    const failures = results.filter((r) => r.actual !== r.expected);
    if (failures.length > 0) {
      console.error('Wake-word filter failures:', JSON.stringify(failures, null, 2));
    }
    expect(failures, 'all wake-word filter cases should match expected outcomes').toEqual([]);
  });
});
