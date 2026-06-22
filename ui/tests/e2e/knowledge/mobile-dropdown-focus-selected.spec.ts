import { test, expect, Page } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * The mobile collection dropdown should auto-scroll the currently-selected
 * collection into view when opened, so the user doesn't have to scroll down to
 * find it when it sits far down the list.
 */
const BASE_URL = 'http://localhost:8080/api/v1';

test.describe('Mobile collection dropdown focuses the selected collection', () => {
  let token = '';
  let targetId = '';
  const stamp = Date.now();
  // Name it so it sorts LAST under the default name-ascending order → far down.
  const targetName = `zzz-focus-${stamp}`;

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    token = (await (await page.request.post(`${BASE_URL}/auth/login`, {
      data: { usernameOrEmail: TEST_EMAIL, password: TEST_PASSWORD },
    })).json()).access_token;

    const ws = await (await page.request.get(`${BASE_URL}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    const workspaceId = ws.workspaces[0].id;

    targetId = (await (await page.request.post(`${BASE_URL}/collections`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: targetName, workspace_id: workspaceId, parent_collection_id: null },
    })).json()).id;

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test.afterEach(async ({ page }) => {
    if (targetId) {
      await page.request.delete(`${BASE_URL}/collections/${targetId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
      targetId = '';
    }
  });

  test('reopening the dropdown scrolls the selected collection into view', async ({ page }) => {
    test.setTimeout(90000);

    // Open Knowledge Stacks (desktop), then switch to the mobile layout.
    const ksButton = page.locator('[data-tour="knowledge-upload"]');
    await ksButton.waitFor({ state: 'visible', timeout: 15000 });
    await ksButton.click();
    await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1500);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);

    const trigger = page.getByTestId('knowledge-mobile-collection-trigger');
    const targetItem = page.getByTestId(`knowledge-mobile-collection-item-${targetId}`);

    // Select the far-down target (a leaf → tapping it also closes the menu).
    await trigger.click();
    await expect(targetItem).toBeAttached({ timeout: 10000 });
    await targetItem.click(); // Playwright scrolls it into view to click it
    await page.waitForTimeout(500);

    // Reopen — the feature should now auto-scroll the selection into view.
    await trigger.click();
    await page.waitForTimeout(700);

    const menu = page.locator('[role="menu"]').first();
    await expect(menu).toBeVisible({ timeout: 5000 });
    await expect(targetItem).toBeVisible({ timeout: 5000 });

    // The menu scrolled down (target is last in a long list)...
    const scrollTop = await menu.evaluate((el) => el.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);

    // ...and the selected item is within the menu's visible viewport.
    const box = await targetItem.boundingBox();
    const menuBox = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(menuBox).not.toBeNull();
    const itemCenter = box!.y + box!.height / 2;
    expect(itemCenter).toBeGreaterThanOrEqual(menuBox!.y);
    expect(itemCenter).toBeLessThanOrEqual(menuBox!.y + menuBox!.height);
  });
});
