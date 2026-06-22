/**
 * CATEGORY_08 §8.3 — Simple Mode toggle E2E.
 *
 * Verifies:
 *   1. Toggle in Settings → General mirrors to
 *      localStorage[scrapalot_simple_mode_enabled] immediately
 *      (no need to click Save first).
 *   2. Window event `scrapalot:simple-mode-changed` fires on toggle.
 *   3. Enabling the toggle hides the "RAG Tracing" card on the same
 *      tab (proves the simple-mode gate is wired through to the UI).
 *   4. Disabling restores the card.
 */
import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

test.describe('CATEGORY_08 §8.3 — Simple Mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
  });

  test('toggle mirrors to localStorage and gates advanced cards', async ({ page }) => {
    test.setTimeout(60_000);

    // Open Settings via the sidebar button. The CustomEvent path is
    // tested separately in 8.5; here we want a path that doesn't depend
    // on which sidebar component holds the listener.
    const settingsBtn = page.locator('[data-testid="sidebar-quick-tools-settings-button"]');
    await expect(settingsBtn).toBeVisible({ timeout: 15_000 });
    await settingsBtn.click();

    // Settings dialog mounts the General tab by default. Wait for the
    // simple-mode switch to be visible.
    const toggle = page.locator('[data-testid="settings-simple-mode-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 15_000 });

    // Hook the change event before clicking so we can prove it fired.
    await page.evaluate(() => {
      (window as unknown as { __simpleModeChanged?: number }).__simpleModeChanged = 0;
      window.addEventListener('scrapalot:simple-mode-changed', () => {
        const w = window as unknown as { __simpleModeChanged?: number };
        w.__simpleModeChanged = (w.__simpleModeChanged ?? 0) + 1;
      });
    });

    // Capture initial state of the toggle so the assertions are
    // independent of whatever the test account had stored.
    const initialState = await toggle.getAttribute('data-state');
    const initiallyOff = initialState === 'unchecked';

    // RAG Tracing heading is rendered only when simple mode is OFF.
    // We anchor on the i18n string because there's no testid yet on
    // the wrapping card.
    const ragTracingHeading = page.getByRole('heading', { name: /RAG Tracing|Praćenje RAG/i });

    if (initiallyOff) {
      await expect(ragTracingHeading).toBeVisible({ timeout: 5_000 });
    }

    // Toggle ON.
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'checked', { timeout: 3_000 });

    const stored = await page.evaluate(() => localStorage.getItem('scrapalot_simple_mode_enabled'));
    expect(stored).toBe('true');

    const events = await page.evaluate(
      () => (window as unknown as { __simpleModeChanged?: number }).__simpleModeChanged ?? 0,
    );
    expect(events).toBeGreaterThan(0);

    // Advanced card disappears.
    await expect(ragTracingHeading).toHaveCount(0, { timeout: 3_000 });

    // Toggle OFF — card returns, localStorage flips back.
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'unchecked', { timeout: 3_000 });
    await expect(ragTracingHeading).toBeVisible({ timeout: 5_000 });

    const storedOff = await page.evaluate(() => localStorage.getItem('scrapalot_simple_mode_enabled'));
    expect(storedOff).toBe('false');
  });
});
