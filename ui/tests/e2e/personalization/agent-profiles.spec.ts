/**
 * CATEGORY_08 §8.8 — Knowledge Agents (Domain-Specific RAG profiles) E2E.
 *
 * Verifies the workspace-default profile picker in Settings → General.
 * Picking a system profile (Legal / Medical / Academic / Technical):
 *   1. fires a save POST whose body carries the new
 *      `default_agent_profile_slug` (regression guard for the same
 *      stale-closure family fixed in 76054c7);
 *   2. persists across a close+reopen of the dialog (proves both the
 *      backend write and the cache-invalidation flow are wired).
 *
 * The picker is currently the user-default; the per-collection picker
 * and the chat-time profile chip are tracked in 8.8 follow-ups.
 */
import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

test.describe('CATEGORY_08 §8.8 — Agent Profiles', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
  });

  test('selecting Academic profile saves + persists across reopen', async ({ page }) => {
    test.setTimeout(60_000);

    const settingsBtn = page.locator('[data-testid="sidebar-quick-tools-settings-button"]');
    await expect(settingsBtn).toBeVisible({ timeout: 15_000 });
    await settingsBtn.click();

    const profileTrigger = page.locator('[data-testid="settings-agent-profile"]');
    await expect(profileTrigger).toBeVisible({ timeout: 10_000 });
    await profileTrigger.scrollIntoViewIfNeeded();

    // Pick a profile that's *not* the current selection. Settings load
    // from `general.default_agent_profile_slug`; default is empty
    // (None). Choose 'academic' if currently None / non-academic, else
    // 'technical'.
    const initialLabel = (await profileTrigger.innerText()).toLowerCase();
    const targetSlug = initialLabel.includes('academic') || initialLabel.includes('akadem')
      ? 'technical'
      : 'academic';

    const saveRequestPromise = page.waitForRequest(
      (req) =>
        req.url().includes('settings_general') &&
        req.method() === 'POST',
      { timeout: 15_000 },
    );

    await profileTrigger.click();
    const targetItem = page.locator(`[role="option"][data-value="${targetSlug}"]`).or(
      page.locator('[role="option"]').filter({ hasText: new RegExp(targetSlug, 'i') }).first(),
    );
    await expect(targetItem.first()).toBeVisible({ timeout: 5_000 });
    await targetItem.first().click();

    const saveRequest = await saveRequestPromise;
    const wrapped = saveRequest.postDataJSON() as { value: Record<string, unknown> };
    expect(wrapped.value.default_agent_profile_slug).toBe(targetSlug);

    await page.waitForResponse(
      (resp) =>
        resp.url().includes('settings_general') &&
        resp.request().method() === 'POST',
      { timeout: 15_000 },
    );

    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);

    await settingsBtn.click();
    const profileTrigger2 = page.locator('[data-testid="settings-agent-profile"]');
    await expect(profileTrigger2).toBeVisible({ timeout: 10_000 });
    await profileTrigger2.scrollIntoViewIfNeeded();

    const reopenedLabel = (await profileTrigger2.innerText()).toLowerCase();
    const slugMatchers: Record<string, RegExp> = {
      academic: /academic|akadem/i,
      technical: /technical|tehnič|tehnic/i,
      legal: /legal|pravn/i,
      medical: /medical|medicin/i,
    };
    expect(reopenedLabel).toMatch(slugMatchers[targetSlug]);
  });
});
