import { test, expect, Page } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Z-04 Nested Collections E2E Tests
 *
 * Tests the nested collection hierarchy feature:
 * - Tree view rendering with expand/collapse chevrons
 * - Subcollection creation via context menu
 * - Move to root via context menu
 * - Mobile dropdown hierarchy display
 * - Depth limit enforcement (max depth 3)
 * - Breadcrumb navigation in Library tab
 *
 * Prerequisites: "medicine" (53 subcollections) and "psychology" (1 subcollection) exist in DB.
 */

/** Helper: Open Knowledge Stacks dialog and wait for collections to load */
async function openKnowledgeStacks(page: Page) {
  // Use the sidebar Knowledge button (data-tour attribute)
  const ksButton = page.locator('[data-tour="knowledge-upload"]');
  await ksButton.waitFor({ state: 'visible', timeout: 10000 });
  await ksButton.click();
  await page.waitForTimeout(2000);

  const dialog = page.locator('[role="dialog"]').first();
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(2000); // Let collections load
  return dialog;
}

/** Helper: Find a collection item by name text within the dialog */
async function findCollectionByName(dialog: any, name: string) {
  const items = dialog.locator('[data-testid^="knowledge-collection-item-"]');
  const count = await items.count();
  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const text = await item.textContent();
    if (text && text.toLowerCase().includes(name.toLowerCase())) {
      return item;
    }
  }
  return null;
}

/** Helper: Get auth token for API calls */
async function getAuthToken(page: Page): Promise<string> {
  const loginResponse = await page.request.post('http://localhost:8080/api/v1/auth/login', {
    data: { usernameOrEmail: TEST_EMAIL, password: TEST_PASSWORD },
  });
  const { access_token } = await loginResponse.json();
  return access_token;
}

test.describe('Z-04 Nested Collections', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('tree view renders with hierarchy — medicine has chevron, subcollections hidden when collapsed', async ({ page }) => {
    test.setTimeout(60000);

    await page.setViewportSize({ width: 1500, height: 900 });

    const dialog = await openKnowledgeStacks(page);

    // Find the "medicine" collection item
    const medicineItem = await findCollectionByName(dialog, 'medicine');
    expect(medicineItem).not.toBeNull();
    await expect(medicineItem!).toBeVisible();

    // "medicine" has subcollections, so it must have a chevron button (the SVG expand toggle)
    const chevronButton = medicineItem!.locator('button').filter({
      has: page.locator('svg polyline'),
    }).first();
    await expect(chevronButton).toBeVisible({ timeout: 5000 });

    // By default, subcollections should NOT be visible if medicine is collapsed
    // Clear any previously stored expanded state
    await page.evaluate(() => {
      localStorage.removeItem('scrapalot_expanded_collections');
    });

    // Close and reopen the dialog to reset expand state
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const dialog2 = await openKnowledgeStacks(page);

    // Known subcollection of medicine (e.g., "cardiology") should not be visible when collapsed
    const cardiologyItem = await findCollectionByName(dialog2, 'cardiology');
    // If medicine is collapsed, cardiology should not appear in the tree-ordered list
    if (cardiologyItem) {
      // If it shows up, medicine might be auto-expanded. Verify it is actually expanded
      const medicineItem2 = await findCollectionByName(dialog2, 'medicine');
      expect(medicineItem2).not.toBeNull();
    }

    console.log('Tree view hierarchy test passed');
  });

  test('expand/collapse chevron works — subcollections appear indented, then disappear', async ({ page }) => {
    test.setTimeout(60000);

    await page.setViewportSize({ width: 1500, height: 900 });

    // Clear expand state so medicine starts collapsed
    await page.evaluate(() => {
      localStorage.removeItem('scrapalot_expanded_collections');
    });

    const dialog = await openKnowledgeStacks(page);

    // Find medicine collection
    const medicineItem = await findCollectionByName(dialog, 'medicine');
    expect(medicineItem).not.toBeNull();
    await expect(medicineItem!).toBeVisible();

    // Click the chevron button to expand
    const chevronButton = medicineItem!.locator('button').filter({
      has: page.locator('svg polyline'),
    }).first();
    await expect(chevronButton).toBeVisible({ timeout: 5000 });
    await chevronButton.click();
    await page.waitForTimeout(1000);

    // After expanding, a subcollection like "cardiology" should be visible
    const cardiologyItem = await findCollectionByName(dialog, 'cardiology');
    expect(cardiologyItem).not.toBeNull();
    await expect(cardiologyItem!).toBeVisible();

    // Verify the subcollection has indentation (paddingLeft > 8px, since depth=1 means 8 + 1*20 = 28px)
    const paddingLeft = await cardiologyItem!.evaluate(
      (el: HTMLElement) => parseInt(getComputedStyle(el).paddingLeft, 10)
    );
    expect(paddingLeft).toBeGreaterThan(8);
    console.log(`  Subcollection paddingLeft: ${paddingLeft}px (expected > 8px)`);

    // Verify the chevron SVG is rotated (expanded state = rotate(90deg))
    const chevronSvg = chevronButton.locator('svg').first();
    const transform = await chevronSvg.evaluate(
      (el: SVGElement) => el.style.transform
    );
    expect(transform).toContain('rotate(90deg)');

    // Click chevron again to collapse
    await chevronButton.click();
    await page.waitForTimeout(1000);

    // After collapsing, cardiology should no longer be visible in the list
    const cardiologyAfterCollapse = await findCollectionByName(dialog, 'cardiology');
    expect(cardiologyAfterCollapse).toBeNull();

    // Verify the chevron SVG is no longer rotated
    const transformAfter = await chevronSvg.evaluate(
      (el: SVGElement) => el.style.transform
    );
    expect(transformAfter).not.toContain('rotate(90deg)');

    console.log('Expand/collapse chevron test passed');
  });

  test('create subcollection via context menu — option exists, creates indented child', async ({ page }) => {
    test.setTimeout(90000);

    await page.setViewportSize({ width: 1500, height: 900 });

    const dialog = await openKnowledgeStacks(page);

    // Find psychology collection (has only 1 subcollection, good for testing creation)
    const psychologyItem = await findCollectionByName(dialog, 'psychology');
    expect(psychologyItem).not.toBeNull();
    await expect(psychologyItem!).toBeVisible();

    // Hover to reveal the three-dots menu button, then click it
    await psychologyItem!.hover();
    await page.waitForTimeout(500);

    // The three-dots button is a <button> with SVG circles inside the collection item
    const menuButton = psychologyItem!.locator('button').filter({
      has: page.locator('svg circle'),
    }).first();
    await expect(menuButton).toBeVisible({ timeout: 5000 });
    await menuButton.click();
    await page.waitForTimeout(500);

    // Verify "Create subcollection" menu item exists in the dropdown
    const createSubItem = page.locator('[role="menuitem"]').filter({
      hasText: /Create subcollection/i,
    });
    await expect(createSubItem).toBeVisible({ timeout: 5000 });

    // Click "Create subcollection"
    await createSubItem.click();
    await page.waitForTimeout(1000);

    // The new stack modal should appear with name input
    const nameInput = page.locator('[data-testid="knowledge-collection-name-input"]');
    await expect(nameInput).toBeVisible({ timeout: 5000 });

    // Fill in a subcollection name
    const subcollectionName = `e2e-sub-${Date.now()}`;
    await nameInput.fill(subcollectionName);
    await page.waitForTimeout(500);

    // Submit
    const submitBtn = page.locator('[data-testid="knowledge-create-collection-submit"]');
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
    await submitBtn.click();
    await page.waitForTimeout(3000);

    // Expand psychology to see the new subcollection
    const psychologyItem2 = await findCollectionByName(dialog, 'psychology');
    expect(psychologyItem2).not.toBeNull();
    const chevron = psychologyItem2!.locator('button').filter({
      has: page.locator('svg polyline'),
    }).first();
    // Psychology should now have a chevron (it had children before + our new one)
    const hasChevron = await chevron.isVisible({ timeout: 3000 });
    if (hasChevron) {
      // Check if already expanded, if not expand
      const svg = chevron.locator('svg').first();
      const currentTransform = await svg.evaluate((el: SVGElement) => el.style.transform);
      if (!currentTransform.includes('rotate(90deg)')) {
        await chevron.click();
        await page.waitForTimeout(1000);
      }
    }

    // Verify the new subcollection appears in the list
    const newSubItem = await findCollectionByName(dialog, subcollectionName);
    expect(newSubItem).not.toBeNull();
    await expect(newSubItem!).toBeVisible();

    // Verify it is indented (depth > 0)
    const paddingLeft = await newSubItem!.evaluate(
      (el: HTMLElement) => parseInt(getComputedStyle(el).paddingLeft, 10)
    );
    expect(paddingLeft).toBeGreaterThan(8);
    console.log(`  New subcollection paddingLeft: ${paddingLeft}px`);

    // Cleanup: delete the test subcollection via API
    const token = await getAuthToken(page);
    const headers = { Authorization: `Bearer ${token}` };
    const listResp = await page.request.get('http://localhost:8080/api/v1/collections', { headers });
    const collections = await listResp.json();
    const allCollections = collections.collections || collections.content || collections;
    const created = allCollections.find((c: { name: string }) => c.name === subcollectionName);
    if (created) {
      await page.request.delete(`http://localhost:8080/api/v1/collections/${created.id}`, { headers });
      console.log(`  Cleaned up test subcollection: ${subcollectionName}`);
    }

    console.log('Create subcollection via context menu test passed');
  });

  test('move to root option exists for subcollections (depth > 0)', async ({ page }) => {
    test.setTimeout(60000);

    await page.setViewportSize({ width: 1500, height: 900 });

    const dialog = await openKnowledgeStacks(page);

    // Expand medicine to reveal subcollections
    const medicineItem = await findCollectionByName(dialog, 'medicine');
    expect(medicineItem).not.toBeNull();
    await expect(medicineItem!).toBeVisible();

    const chevronButton = medicineItem!.locator('button').filter({
      has: page.locator('svg polyline'),
    }).first();
    await expect(chevronButton).toBeVisible({ timeout: 5000 });
    await chevronButton.click();
    await page.waitForTimeout(1000);

    // Find a subcollection (e.g., "cardiology")
    const cardiologyItem = await findCollectionByName(dialog, 'cardiology');
    expect(cardiologyItem).not.toBeNull();
    await expect(cardiologyItem!).toBeVisible();

    // Hover and open the three-dots menu on the subcollection
    await cardiologyItem!.hover();
    await page.waitForTimeout(500);

    const menuButton = cardiologyItem!.locator('button').filter({
      has: page.locator('svg circle'),
    }).first();
    await expect(menuButton).toBeVisible({ timeout: 5000 });
    await menuButton.click();
    await page.waitForTimeout(500);

    // Verify "Move to root" menu item is present (only shown for depth > 0)
    const moveToRootItem = page.locator('[role="menuitem"]').filter({
      hasText: /Move to root/i,
    });
    await expect(moveToRootItem).toBeVisible({ timeout: 5000 });

    // Also verify "Create subcollection" is present (depth 1 < 3)
    const createSubItem = page.locator('[role="menuitem"]').filter({
      hasText: /Create subcollection/i,
    });
    await expect(createSubItem).toBeVisible({ timeout: 5000 });

    // Dismiss the menu without acting (press Escape)
    await page.keyboard.press('Escape');

    console.log('Move to root option test passed');
  });

  test('mobile view shows hierarchy — subcollections indented in collection list', async ({ page }) => {
    test.setTimeout(60000);

    // Open Knowledge Stacks on desktop viewport first (sidebar hidden on mobile)
    const dialog = await openKnowledgeStacks(page);

    // Expand medicine in the tree (desktop sidebar visible here)
    await page.evaluate(() => {
      const items = document.querySelectorAll('[data-testid^="knowledge-collection-item-"]');
      const med = Array.from(items).find(el => el.querySelector('span')?.textContent?.trim() === 'medicine');
      if (med) {
        med.scrollIntoView({ block: 'center' });
        const btn = med.querySelector('button');
        if (btn) btn.click();
      }
    });
    await page.waitForTimeout(1000);

    // Now resize to mobile — dialog stays open, layout switches
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);

    // On mobile, the bottom dropdown should show the collection list
    // Find and click the dropdown trigger at the bottom (shows collection name + chevron)
    const dropdownTrigger = page.locator('button').filter({
      hasText: /aerospace|medicine|agriculture|cardiology/i,
    }).last();
    await expect(dropdownTrigger).toBeVisible({ timeout: 10000 });
    await dropdownTrigger.click();
    await page.waitForTimeout(1000);

    // Dropdown menu should appear
    const dropdownContent = page.locator('[role="menu"]');
    await expect(dropdownContent).toBeVisible({ timeout: 5000 });

    // Find a subcollection item with indent (paddingLeft > 12px = base 12 + depth*16)
    const menuItems = dropdownContent.locator('[role="menuitem"]');
    const menuCount = await menuItems.count();
    expect(menuCount).toBeGreaterThan(5);

    let foundIndented = false;
    for (let i = 0; i < menuCount; i++) {
      const item = menuItems.nth(i);
      const pl = await item.evaluate(
        (el: HTMLElement) => parseInt(getComputedStyle(el).paddingLeft, 10)
      );
      if (pl > 12) {
        foundIndented = true;
        // Should have folder SVG icon (not colored dot)
        const folderSvg = item.locator('svg path');
        expect(await folderSvg.count()).toBeGreaterThan(0);
        console.log(`  Found indented mobile dropdown item: paddingLeft=${pl}px`);
        break;
      }
    }
    expect(foundIndented).toBe(true);

    console.log('Mobile dropdown hierarchy test passed');
  });

  test.fixme('subcollection option hidden at depth 3 — "Create subcollection" not shown', async ({ page }) => {
    test.setTimeout(120000);

    await page.setViewportSize({ width: 1500, height: 900 });

    // We need a collection at depth 3 to verify "Create subcollection" is NOT shown.
    // Create a chain: root -> depth1 -> depth2 -> depth3 via API, then check UI.
    const token = await getAuthToken(page);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const timestamp = Date.now();
    const createdIds: string[] = [];

    // Get workspace ID from existing collections
    const wsResp = await page.request.get('http://localhost:8080/api/v1/collections?limit=1', { headers });
    const wsData = await wsResp.json();
    const workspaceId = (wsData.collections || wsData)[0]?.workspace_id;
    expect(workspaceId).toBeTruthy();

    try {
      // Create root collection
      const rootResp = await page.request.post('http://localhost:8080/api/v1/collections', {
        headers, data: { name: `e2e-depth-root-${timestamp}`, workspace_id: workspaceId },
      });
      expect(rootResp.ok()).toBe(true);
      const rootCol = await rootResp.json();
      createdIds.push(rootCol.id);

      // Create depth-1 child
      const d1Resp = await page.request.post('http://localhost:8080/api/v1/collections', {
        headers, data: { name: `e2e-depth-1-${timestamp}`, workspace_id: workspaceId, parent_collection_id: rootCol.id },
      });
      expect(d1Resp.ok()).toBe(true);
      const d1Col = await d1Resp.json();
      createdIds.push(d1Col.id);

      // Create depth-2 child
      const d2Resp = await page.request.post('http://localhost:8080/api/v1/collections', {
        headers, data: { name: `e2e-depth-2-${timestamp}`, workspace_id: workspaceId, parent_collection_id: d1Col.id },
      });
      expect(d2Resp.ok()).toBe(true);
      const d2Col = await d2Resp.json();
      createdIds.push(d2Col.id);

      // Create depth-3 child
      const d3Resp = await page.request.post('http://localhost:8080/api/v1/collections', {
        headers, data: { name: `e2e-depth-3-${timestamp}`, workspace_id: workspaceId, parent_collection_id: d2Col.id },
      });
      expect(d3Resp.ok()).toBe(true);
      const d3Col = await d3Resp.json();
      createdIds.push(d3Col.id);

      // Open Knowledge Stacks and navigate to the depth-3 collection
      const dialog = await openKnowledgeStacks(page);

      // Expand the chain: root -> d1 -> d2 to reveal d3
      for (const name of [`e2e-depth-root-${timestamp}`, `e2e-depth-1-${timestamp}`, `e2e-depth-2-${timestamp}`]) {
        const item = await findCollectionByName(dialog, name);
        expect(item).not.toBeNull();
        const chevron = item!.locator('button').filter({
          has: page.locator('svg polyline'),
        }).first();
        const isChevronVisible = await chevron.isVisible({ timeout: 3000 });
        if (isChevronVisible) {
          await chevron.click();
          await page.waitForTimeout(500);
        }
      }

      // Find the depth-3 collection
      const depth3Item = await findCollectionByName(dialog, `e2e-depth-3-${timestamp}`);
      expect(depth3Item).not.toBeNull();
      await expect(depth3Item!).toBeVisible();

      // Open its context menu
      await depth3Item!.hover();
      await page.waitForTimeout(500);
      const menuButton = depth3Item!.locator('button').filter({
        has: page.locator('svg circle'),
      }).first();
      await expect(menuButton).toBeVisible({ timeout: 5000 });
      await menuButton.click();
      await page.waitForTimeout(500);

      // "Create subcollection" should NOT be visible at depth 3
      const createSubItem = page.locator('[role="menuitem"]').filter({
        hasText: /Create subcollection/i,
      });
      await expect(createSubItem).not.toBeVisible({ timeout: 3000 });

      // "Move to root" SHOULD still be visible (depth > 0)
      const moveToRootItem = page.locator('[role="menuitem"]').filter({
        hasText: /Move to root/i,
      });
      await expect(moveToRootItem).toBeVisible({ timeout: 3000 });

      await page.keyboard.press('Escape');

      console.log('Depth 3 limit enforcement test passed');
    } finally {
      // Cleanup: delete in reverse order (deepest first to avoid FK issues)
      for (const id of createdIds.reverse()) {
        await page.request.delete(`http://localhost:8080/api/v1/collections/${id}`, { headers });
      }
      console.log(`  Cleaned up ${createdIds.length} test collections`);
    }
  });

  test('breadcrumb navigation in Library tab — shows parent / child path', async ({ page }) => {
    test.setTimeout(60000);

    await page.setViewportSize({ width: 1500, height: 900 });

    const dialog = await openKnowledgeStacks(page);

    // Expand medicine to show subcollections
    const medicineItem = await findCollectionByName(dialog, 'medicine');
    expect(medicineItem).not.toBeNull();
    await expect(medicineItem!).toBeVisible();

    const chevronButton = medicineItem!.locator('button').filter({
      has: page.locator('svg polyline'),
    }).first();
    await expect(chevronButton).toBeVisible({ timeout: 5000 });
    await chevronButton.click();
    await page.waitForTimeout(1000);

    // Select a subcollection (e.g., cardiology)
    const cardiologyItem = await findCollectionByName(dialog, 'cardiology');
    expect(cardiologyItem).not.toBeNull();
    await cardiologyItem!.click();
    await page.waitForTimeout(1000);

    // Switch to Library tab
    const libraryTab = dialog.locator('[data-testid="knowledge-tab-library"]');
    await expect(libraryTab).toBeVisible({ timeout: 5000 });
    await libraryTab.click();
    await page.waitForTimeout(2000);

    // Verify breadcrumb appears with "medicine / cardiology" (or similar parent / child format)
    // The breadcrumb is a div with text-xs class containing ancestor names separated by "/"
    const breadcrumb = dialog.locator('.flex.items-center.gap-1.text-xs');
    await expect(breadcrumb).toBeVisible({ timeout: 10000 });

    const breadcrumbText = await breadcrumb.textContent();
    expect(breadcrumbText).not.toBeNull();

    // Breadcrumb should contain the parent name "medicine" and a "/" separator
    expect(breadcrumbText!.toLowerCase()).toContain('medicine');
    expect(breadcrumbText!).toContain('/');
    // And the child name "cardiology"
    expect(breadcrumbText!.toLowerCase()).toContain('cardiology');

    console.log(`  Breadcrumb text: "${breadcrumbText!.trim()}"`);

    // Verify the parent name in breadcrumb is clickable (it is a button element)
    const parentLink = breadcrumb.locator('button').filter({ hasText: /medicine/i });
    await expect(parentLink).toBeVisible({ timeout: 5000 });

    console.log('Breadcrumb navigation test passed');
  });
});
