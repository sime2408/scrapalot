/**
 * CATEGORY_08 §8.5 — Command Palette E2E.
 *
 * Verifies:
 *   1. Cmd+K / Ctrl+K opens the palette (input gets focus).
 *   2. Input filters entries (typing "settings" narrows results).
 *   3. Pressing Enter on a navigation entry triggers the bound side-effect
 *      (Settings dialog opens — listening for `scrapalot:open-settings`).
 *   4. Escape closes the palette.
 *
 * The palette is mounted at App level and listens to a `keydown` on the
 * document, so it is reachable from any page once authenticated.
 */
import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

test.describe('CATEGORY_08 §8.5 — Command Palette', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
  });

  test('opens with Ctrl+K, filters input, Escape closes', async ({ page }) => {
    test.setTimeout(60_000);

    // The palette listens for `e.metaKey || e.ctrlKey`, so Control+K
    // works on both Mac and Linux runners.
    await page.keyboard.press('Control+k');

    const input = page.locator('[data-testid="command-palette-input"]');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await expect(input).toBeFocused();

    // Type a narrow query and assert the relevant nav entry shows up.
    await input.fill('settings');
    const settingsItem = page.locator('[data-testid="command-nav:settings"]');
    await expect(settingsItem).toBeVisible({ timeout: 3_000 });

    // Escape should close the dialog.
    await page.keyboard.press('Escape');
    await expect(input).not.toBeVisible({ timeout: 3_000 });
  });

  test('Enter on nav:settings dispatches open-settings event', async ({ page }) => {
    test.setTimeout(60_000);

    // Hook the custom event before triggering the palette so the test
    // captures the dispatch deterministically (no relying on the
    // settings dialog actually rendering).
    await page.evaluate(() => {
      (window as unknown as { __settingsOpened?: boolean }).__settingsOpened = false;
      window.addEventListener('scrapalot:open-settings', () => {
        (window as unknown as { __settingsOpened?: boolean }).__settingsOpened = true;
      });
    });

    await page.keyboard.press('Control+k');
    const input = page.locator('[data-testid="command-palette-input"]');
    await expect(input).toBeVisible({ timeout: 5_000 });

    await input.fill('settings');
    const settingsItem = page.locator('[data-testid="command-nav:settings"]');
    await expect(settingsItem).toBeVisible({ timeout: 3_000 });

    // cmdk highlights the first match; Enter triggers its `onSelect`.
    await page.keyboard.press('Enter');

    await expect.poll(
      async () =>
        page.evaluate(() => (window as unknown as { __settingsOpened?: boolean }).__settingsOpened ?? false),
      { timeout: 5_000 },
    ).toBe(true);

    // Palette should auto-close after selection.
    await expect(input).not.toBeVisible({ timeout: 3_000 });
  });
});
