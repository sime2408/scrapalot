import { test, expect, Page } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Regression: on mobile, selecting a collection that HAS sub-collections must
 * still show the books uploaded directly to that (parent) collection. The mobile
 * dropdown handler used to ONLY toggle expansion for a parent and never select
 * it, so a parent collection's own documents were unreachable.
 *
 * This test creates a parent + child collection, then on a mobile viewport taps
 * the parent in the collection dropdown and asserts:
 *   1. the parent's documents are fetched (GET /documents/collection/<parentId>)
 *      — i.e. it actually got selected, and
 *   2. the child collection is revealed (the expand still happens).
 */
const BASE_URL = 'http://localhost:8080/api/v1';

async function api(page: Page, method: 'post' | 'delete', path: string, token: string, data?: unknown) {
  const res = await page.request[method](`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...(data ? { data } : {}),
  });
  return res;
}

test.describe('Parent collection is selectable on mobile (shows its own books)', () => {
  let token = '';
  let workspaceId = '';
  let parentId = '';
  let childId = '';
  const stamp = Date.now();
  const parentName = `zz-parent-${stamp}`;
  const childName = `zz-child-${stamp}`;

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const login = await page.request.post(`${BASE_URL}/auth/login`, {
      data: { usernameOrEmail: TEST_EMAIL, password: TEST_PASSWORD },
    });
    token = (await login.json()).access_token;

    // Use the first workspace — the same default the UI falls back to.
    const ws = await (await page.request.get(`${BASE_URL}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    workspaceId = ws.workspaces[0].id;

    const parent = await (await api(page, 'post', '/collections', token, {
      name: parentName, workspace_id: workspaceId, parent_collection_id: null,
    })).json();
    parentId = parent.id;

    const child = await (await api(page, 'post', '/collections', token, {
      name: childName, workspace_id: workspaceId, parent_collection_id: parentId,
    })).json();
    childId = child.id;

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test.afterEach(async ({ page }) => {
    if (childId) await api(page, 'delete', `/collections/${childId}`, token).catch(() => {});
    if (parentId) await api(page, 'delete', `/collections/${parentId}`, token).catch(() => {});
    childId = parentId = '';
  });

  test('tapping a parent with sub-collections selects it AND reveals the child', async ({ page }) => {
    test.setTimeout(90000);

    // Open Knowledge Stacks on desktop (sidebar button is hidden on mobile).
    const ksButton = page.locator('[data-tour="knowledge-upload"]');
    await ksButton.waitFor({ state: 'visible', timeout: 15000 });
    await ksButton.click();
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    // Switch to mobile — the dialog stays open and swaps to the dropdown layout.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);

    // Open the collection dropdown.
    const trigger = page.getByTestId('knowledge-mobile-collection-trigger');
    await expect(trigger).toBeVisible({ timeout: 10000 });
    await trigger.click();
    await page.waitForTimeout(500);

    // Scroll the menu until our freshly-created parent is rendered (the list
    // paginates as you scroll).
    const parentItem = page.getByTestId(`knowledge-mobile-collection-item-${parentId}`);
    const menu = page.locator('[role="menu"]').first();
    for (let i = 0; i < 25 && (await parentItem.count()) === 0; i++) {
      await menu.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(400);
    }
    await expect(parentItem).toBeVisible({ timeout: 10000 });

    // The child must NOT be visible yet (parent collapsed).
    await expect(page.getByTestId(`knowledge-mobile-collection-item-${childId}`)).toHaveCount(0);

    // Tap the parent. It must fetch the parent's own documents (proves it got
    // selected) — this is exactly what previously never happened.
    const docsReq = page.waitForRequest(
      (req) => req.url().includes(`/documents/collection/${parentId}`) && req.method() === 'GET',
      { timeout: 15000 }
    );
    await parentItem.click();
    await docsReq;

    // And the child is now revealed (expand still works).
    await expect(page.getByTestId(`knowledge-mobile-collection-item-${childId}`)).toBeVisible({ timeout: 10000 });
  });
});
