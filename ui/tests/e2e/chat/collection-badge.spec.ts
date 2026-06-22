import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Collection Badge E2E Test
 *
 * Verifies the pinned-collection badge on the chat collection-selector button:
 *  1. No badge before a collection is pinned.
 *  2. Pinning a collection shows a count badge ("1") on the selector button.
 *  3. The pin survives reopening the selector (badge persists, collection stays
 *     checked) — i.e. the store↔local collection sync holds without flickering.
 *
 * (Session-level restore — badge reflecting sessions.collection_id when a session
 * is re-opened — is exercised manually; reload lands on the welcome view before
 * the conversation hydrates, so it is not asserted here.)
 */
test.describe('Collection badge', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('shows a count badge when a collection is pinned and keeps it across reopen', async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 1440, height: 900 }); // desktop popover, not the narrow dialog

    const chatInput = page.locator('[data-testid="chat-input"]');
    const collectionButton = page.locator('[data-testid="collection-selector"]');
    const badge = page.locator('[data-testid="collection-count-badge"]');

    // Start a fresh conversation
    const newConversation = page.locator('[data-testid="sidebar-new-conversation-button"]');
    await expect(newConversation).toBeVisible({ timeout: 10000 });
    await newConversation.click();
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    // Use the Scrapalot AI system provider (project rule for all E2E)
    const modelSelector = page.locator('[data-testid="model-selector"]');
    await expect(modelSelector).toBeVisible({ timeout: 10000 });
    await modelSelector.click();
    const scrapalotOption = page.locator('[role="option"]').filter({ hasText: 'Scrapalot AI' }).first();
    await expect(scrapalotOption).toBeVisible({ timeout: 5000 });
    await scrapalotOption.click();
    await page.waitForTimeout(500);

    // (1) No badge before pinning anything
    await expect(badge).toHaveCount(0);

    // Open the collection selector
    await expect(collectionButton).toBeVisible({ timeout: 10000 });
    await collectionButton.click();
    await page.waitForTimeout(800);

    // The collection list (checkboxes) lives in MANUAL mode. If agentic routing
    // is on, the popover only offers "Switch to Manual" — switch, then reopen.
    const switchToManual = page.locator('[data-testid="chat-switch-to-manual-button"]');
    if (await switchToManual.isVisible({ timeout: 2000 }).catch(() => false)) {
      await switchToManual.click();
      await page.waitForTimeout(800);
      await collectionButton.click();
      await page.waitForTimeout(800);
    }

    // Pin the first ENABLED collection
    const checkboxes = page.locator('[role="checkbox"]');
    await expect(checkboxes.first()).toBeVisible({ timeout: 10000 });
    const count = await checkboxes.count();
    let picked = false;
    for (let i = 0; i < count; i++) {
      const cb = checkboxes.nth(i);
      const disabled = await cb.getAttribute('data-disabled');
      const ariaDisabled = await cb.getAttribute('aria-disabled');
      if (disabled === null && ariaDisabled !== 'true') {
        await cb.click({ force: true });
        picked = true;
        break;
      }
    }
    expect(picked).toBe(true);
    await page.waitForTimeout(800);

    // Close the popover
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // (2) Badge now reflects the pinned collection
    await expect(badge).toBeVisible({ timeout: 5000 });
    await expect(badge).toHaveText('1');

    // (3) The pin survives reopening the collection selector (the badge persists
    // and the same collection is still checked).
    await collectionButton.click();
    await page.waitForTimeout(800);
    const checkedBoxes = page.locator('[role="checkbox"][data-state="checked"], [role="checkbox"][aria-checked="true"]');
    await expect(checkedBoxes.first()).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('1');
  });
});
