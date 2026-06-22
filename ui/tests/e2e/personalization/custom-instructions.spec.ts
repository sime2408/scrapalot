/**
 * CATEGORY_08 §8.1 — Per-Collection Custom AI Instructions E2E.
 *
 * Verifies the round-trip:
 *   1. Open Knowledge Stacks → pick the first collection → 3-dot menu
 *      → Edit. Edit dialog opens with the existing custom_instructions
 *      pre-filled in the testid'd textarea.
 *   2. Set a unique marker string into the textarea, click Save.
 *   3. Reopen the same collection's edit dialog. The marker is still
 *      there → proves the value persisted to the backend (Kotlin
 *      collection.custom_instructions column).
 *
 * The backend layering of the prompt (system_prompt_builder priority
 * chain) is asserted in pytest integration tests, not here. This test
 * is the UI-storage round-trip only.
 */
import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

test.describe('CATEGORY_08 §8.1 — Custom Instructions', () => {
  // Knowledge Stacks switches to a small-screen layout below 1400 px
  // (CLAUDE.md frontend rule #27). On the small-screen path, the
  // collection-edit dialog *closes* the parent Knowledge Stacks dialog
  // before re-mounting itself, so neither the collection list nor the
  // edit textarea remain visible long enough to test reliably. Force a
  // wide viewport so we exercise the desktop nested-dialog path.
  test.use({ viewport: { width: 1600, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
  });

  test('write + save + reopen preserves custom_instructions', async ({ page }) => {
    test.setTimeout(90_000);

    const knowledgeBtn = page.locator('[data-testid="sidebar-quick-tools-knowledge-button"]');
    await expect(knowledgeBtn).toBeVisible({ timeout: 15_000 });
    await knowledgeBtn.click();

    // Wait for at least one collection to be visible. The hover-to-show
    // 3-dot menu trigger needs the row hovered before the click.
    const collectionItem = page.locator('[data-testid^="knowledge-collection-item-"]').first();
    await expect(collectionItem).toBeVisible({ timeout: 15_000 });
    await collectionItem.hover();

    const collectionId = (await collectionItem.getAttribute('data-testid'))?.replace(
      'knowledge-collection-item-',
      '',
    );
    expect(collectionId).toBeTruthy();

    const menuTrigger = page.locator(`[data-testid="knowledge-collection-menu-${collectionId}"]`);
    await expect(menuTrigger).toBeVisible({ timeout: 5_000 });
    await menuTrigger.click({ force: true });

    const editItem = page.locator(`[data-testid="knowledge-collection-edit-${collectionId}"]`);
    await expect(editItem).toBeVisible({ timeout: 5_000 });
    await editItem.click();

    const textarea = page.locator('[data-testid="knowledge-stack-custom-instructions"]');
    await expect(textarea).toBeVisible({ timeout: 10_000 });

    // Write a unique marker so we can detect persistence on reopen
    // without colliding with whatever value was already there.
    const marker = `e2e-marker-${Date.now()}`;
    await textarea.fill(marker);

    const submit = page.locator('[data-testid="knowledge-create-collection-submit"]');
    await expect(submit).toBeVisible({ timeout: 5_000 });
    await submit.click();

    // Dialog should close on a successful save.
    await expect(textarea).not.toBeVisible({ timeout: 10_000 });

    // Reopen the same collection's edit dialog and assert the marker
    // round-tripped through the backend.
    await page.waitForTimeout(1_000);
    const collectionItem2 = page.locator(`[data-testid="knowledge-collection-item-${collectionId}"]`);
    await collectionItem2.hover();
    await page.locator(`[data-testid="knowledge-collection-menu-${collectionId}"]`).click({ force: true });
    await page.locator(`[data-testid="knowledge-collection-edit-${collectionId}"]`).click();

    const textarea2 = page.locator('[data-testid="knowledge-stack-custom-instructions"]');
    await expect(textarea2).toBeVisible({ timeout: 10_000 });
    await expect(textarea2).toHaveValue(marker, { timeout: 5_000 });
  });
});
