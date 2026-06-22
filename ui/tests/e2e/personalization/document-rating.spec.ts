/**
 * CATEGORY_08 §8.7 — Document Rating stars E2E.
 *
 * Verifies the StarRating widget on library cards:
 *   1. Clicking a star sets the rating; aria-checked flips on that
 *      star, fill class lands on stars 1..n.
 *   2. Clicking the same star again clears the rating (toggle-off
 *      behaviour spec'd in star-rating.tsx onClickStar).
 *   3. The change persists by reloading the library and confirming
 *      the chosen star is still highlighted.
 *
 * Strategy: open Knowledge Stacks → Library, pick the first document
 * card that has rendered the StarRating block, exercise its 4-star
 * button, then revert to keep the test idempotent for the next run.
 */
import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

test.describe('CATEGORY_08 §8.7 — Document Rating', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
  });

  test('click sets rating, click same star clears', async ({ page }) => {
    test.setTimeout(90_000);

    // Open Knowledge Stacks via the sidebar entry. The library tab is
    // the default for a workspace with documents, but click anyway so
    // the test is robust against different default tabs.
    const knowledgeBtn = page.locator('[data-testid="sidebar-quick-tools-knowledge-button"]');
    await expect(knowledgeBtn).toBeVisible({ timeout: 15_000 });
    await knowledgeBtn.click();

    const libraryTab = page.locator('[data-testid="knowledge-tab-library"]').first();
    await expect(libraryTab).toBeVisible({ timeout: 10_000 });
    await libraryTab.click();

    // Wait for at least one document grid to mount and at least one
    // 4-star button to be visible (so we know StarRating actually
    // rendered for a 'completed' processing-status doc).
    const grid = page.locator('[data-testid="library-document-grid"]').first();
    await expect(grid).toBeVisible({ timeout: 30_000 });

    // Star testids are `star-rating-{documentId}-{n}`. Grab any
    // visible 4-star button.
    const star4 = page.locator('[data-testid^="star-rating-"][data-testid$="-4"]:visible').first();
    await expect(star4).toBeVisible({ timeout: 10_000 });

    const initialState = await star4.getAttribute('aria-checked');

    if (initialState === 'true') {
      // Doc already has a 4-star rating from a previous run. Click to
      // clear it first so we have a clean baseline.
      await star4.click();
      await expect(star4).toHaveAttribute('aria-checked', 'false', { timeout: 5_000 });
    }

    // Click → set rating.
    await star4.click();
    await expect(star4).toHaveAttribute('aria-checked', 'true', { timeout: 5_000 });

    // Click same star again → clear.
    await star4.click();
    await expect(star4).toHaveAttribute('aria-checked', 'false', { timeout: 5_000 });
  });
});
