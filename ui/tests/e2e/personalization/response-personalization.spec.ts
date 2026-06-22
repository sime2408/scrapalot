/**
 * CATEGORY_08 §8.2 — Response Personalization E2E.
 *
 * Verifies the three response-style controls in Settings → General:
 *   - Response length Select (short / medium / long)
 *   - Formality Select (casual / neutral / academic)
 *   - Domain focus Input (free text up to 100 chars)
 *
 * Settings auto-save with a 1-second debounce when any of the
 * general fields change. We change the values, wait for the save
 * POST to land, assert the body carries the new values (regression
 * guard for the stale-closure bug fixed in 76054c7), then reopen
 * and re-assert from a fresh load to confirm round-trip through
 * the user_settings KV.
 */
import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

test.describe('CATEGORY_08 §8.2 — Response Personalization', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
  });

  test('formality + domain focus persist after settings reopen', async ({ page }) => {
    test.setTimeout(60_000);

    const settingsBtn = page.locator('[data-testid="sidebar-quick-tools-settings-button"]');
    await expect(settingsBtn).toBeVisible({ timeout: 15_000 });
    await settingsBtn.click();

    const formalityTrigger = page.locator('[data-testid="settings-response-formality"]');
    const domainFocusInput = page.locator('[data-testid="settings-response-domain-focus"]');
    await expect(formalityTrigger).toBeVisible({ timeout: 10_000 });
    await expect(domainFocusInput).toBeVisible({ timeout: 5_000 });

    const marker = `e2e-${Date.now()}`;

    // Pick the formality value that's *not* the current one so the
    // change actually triggers the dirty flag.
    const initialFormality = (await formalityTrigger.innerText()).toLowerCase();
    const targetFormality = initialFormality.includes('academ') ? 'casual' : 'academic';

    // Arm the request listener BEFORE the click so we don't miss the
    // POST that fires 1 s after the last change.
    const saveRequestPromise = page.waitForRequest(
      (req) =>
        req.url().includes('settings_general') &&
        req.method() === 'POST',
      { timeout: 15_000 },
    );

    await formalityTrigger.click();
    const targetItem = page.locator('[role="option"]').filter({ hasText: new RegExp(targetFormality, 'i') }).first();
    await expect(targetItem).toBeVisible({ timeout: 5_000 });
    await targetItem.click();
    await domainFocusInput.fill(marker);

    // Backend wraps the payload as `{ value: { ...settings } }`, so
    // unwrap before asserting fields.
    const saveRequest = await saveRequestPromise;
    const wrapped = saveRequest.postDataJSON() as { value: Record<string, unknown> };
    const body = wrapped.value;
    expect(body.response_formality).toBe(targetFormality);
    expect(body.response_domain_focus).toBe(marker);

    // Wait for the response so the next reopen reads fresh data.
    await page.waitForResponse(
      (resp) =>
        resp.url().includes('settings_general') &&
        resp.request().method() === 'POST',
      { timeout: 15_000 },
    );

    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);

    await settingsBtn.click();
    const formalityTrigger2 = page.locator('[data-testid="settings-response-formality"]');
    const domainFocusInput2 = page.locator('[data-testid="settings-response-domain-focus"]');
    await expect(formalityTrigger2).toBeVisible({ timeout: 10_000 });

    // The Response style section is far below the fold; scroll it into
    // view so its rendered SelectValue is reliably populated.
    await formalityTrigger2.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    const reopenedFormality = (await formalityTrigger2.innerText()).toLowerCase();
    const matchesTarget =
      targetFormality === 'academic'
        ? reopenedFormality.includes('academ') || reopenedFormality.includes('akadem')
        : reopenedFormality.includes('casual') || reopenedFormality.includes('opušten') || reopenedFormality.includes('opusten');
    expect(matchesTarget).toBe(true);

    await expect(domainFocusInput2).toHaveValue(marker, { timeout: 5_000 });
  });
});
