import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Workspace Management E2E Tests
 *
 * Tests workspace CRUD operations:
 * - Displaying workspaces in settings
 * - Creating a new workspace
 * - Deleting a test workspace
 */
test.describe('Workspace Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('should display workspaces in settings', async ({ page }) => {
    test.setTimeout(90000);

    console.log('🧪 Testing workspace list display...\n');

    // Step 1: Open settings
    console.log('Step 1/3: Opening settings...');
    const settingsButton = page.locator('[data-tour="settings-button"]');
    await settingsButton.waitFor({ state: 'visible', timeout: 10000 });
    await settingsButton.click();
    await page.waitForTimeout(500);

    const dialog = page.locator('[data-testid="settings-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    console.log('Settings opened\n');

    // Step 2: Navigate to Workspaces tab
    console.log('Step 2/3: Navigating to Workspaces tab...');
    // Settings has both mobile and desktop tab elements; pick the visible one
    const wsTabLocator = page.locator('[data-testid="settings-tab-workspaces"]');
    const wsTabCount = await wsTabLocator.count();
    for (let i = 0; i < wsTabCount; i++) {
      if (await wsTabLocator.nth(i).isVisible({ timeout: 1000 }).catch(() => false)) {
        await wsTabLocator.nth(i).click();
        break;
      }
    }
    await page.waitForTimeout(1000);
    console.log('Workspaces tab opened\n');

    // Step 3: Verify workspace list with at least 1 workspace
    console.log('Step 3/3: Checking workspace list...');
    const workspaceList = page.locator('[data-testid="settings-workspace-list"]');
    await workspaceList.waitFor({ state: 'visible', timeout: 15000 });

    const workspaceItems = page.locator('[data-testid^="settings-workspace-item-"]');
    const count = await workspaceItems.count();
    expect(count).toBeGreaterThan(0);
    console.log(`Found ${count} workspaces\n`);
  });

  test('should create a new workspace', async ({ page }) => {
    test.setTimeout(90000);

    const timestamp = Date.now();
    const workspaceName = `e2e-test-ws-${timestamp}`;

    console.log('🧪 Testing workspace creation...\n');

    // Step 1: Open settings → Workspaces tab
    console.log('Step 1/4: Opening Workspaces settings...');
    const settingsButton = page.locator('[data-tour="settings-button"]');
    await settingsButton.waitFor({ state: 'visible', timeout: 10000 });
    await settingsButton.click();
    await page.waitForTimeout(500);

    const dialog = page.locator('[data-testid="settings-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Settings has both mobile and desktop tab elements; pick the visible one
    const wsTabLocator = page.locator('[data-testid="settings-tab-workspaces"]');
    const wsTabCount = await wsTabLocator.count();
    for (let i = 0; i < wsTabCount; i++) {
      if (await wsTabLocator.nth(i).isVisible({ timeout: 1000 }).catch(() => false)) {
        await wsTabLocator.nth(i).click();
        break;
      }
    }
    await page.waitForTimeout(1000);
    console.log('Workspaces tab opened\n');

    // Step 2: Click create button
    console.log('Step 2/4: Clicking create workspace button...');
    const createButton = page.locator('[data-testid="settings-workspace-create-button"]');
    await createButton.waitFor({ state: 'visible', timeout: 5000 });
    await createButton.click();
    await page.waitForTimeout(500);
    console.log('Create dialog opened\n');

    // Step 3: Fill name and submit
    console.log(`Step 3/4: Creating workspace "${workspaceName}"...`);
    const nameInput = page.locator('[data-testid="settings-workspace-name-input"]');
    await nameInput.waitFor({ state: 'visible', timeout: 5000 });
    await nameInput.fill(workspaceName);

    const submitButton = page.locator('[data-testid="settings-workspace-create-submit"]');
    await submitButton.click();
    await page.waitForTimeout(2000);
    console.log('Workspace created\n');

    // Step 4: Verify workspace appears in list
    console.log('Step 4/4: Verifying workspace in list...');
    const newWorkspace = page.locator(`text=${workspaceName}`);
    await newWorkspace.waitFor({ state: 'visible', timeout: 10000 });
    await expect(newWorkspace).toBeVisible();
    console.log(`Workspace "${workspaceName}" visible in list\n`);
  });

  test('should delete a test workspace', async ({ page }) => {
    test.setTimeout(90000);

    console.log('🧪 Testing workspace deletion...\n');

    // Step 1: Open settings → Workspaces tab
    console.log('Step 1/4: Opening Workspaces settings...');
    const settingsButton = page.locator('[data-tour="settings-button"]');
    await settingsButton.waitFor({ state: 'visible', timeout: 10000 });
    await settingsButton.click();
    await page.waitForTimeout(500);

    const dialog = page.locator('[data-testid="settings-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Settings has both mobile and desktop tab elements; pick the visible one
    const wsTabLocator = page.locator('[data-testid="settings-tab-workspaces"]');
    const wsTabCount = await wsTabLocator.count();
    for (let i = 0; i < wsTabCount; i++) {
      if (await wsTabLocator.nth(i).isVisible({ timeout: 1000 }).catch(() => false)) {
        await wsTabLocator.nth(i).click();
        break;
      }
    }
    await page.waitForTimeout(1000);
    console.log('Workspaces tab opened\n');

    // Step 2: Find a test workspace (with e2e-test-ws prefix)
    console.log('Step 2/4: Finding test workspace to delete...');
    const testWorkspace = page.locator('text=e2e-test-ws').first();
    const exists = await testWorkspace.isVisible({ timeout: 5000 }).catch(() => false);

    if (!exists) {
      console.log('⚠️ No test workspace found, skipping deletion test');
      test.skip();
      return;
    }

    // Get the workspace item containing the test workspace name
    const workspaceItem = page.locator('[data-testid^="settings-workspace-item-"]')
      .filter({ hasText: 'e2e-test-ws' })
      .first();
    console.log('Found test workspace\n');

    // Step 3: Click delete button within the workspace item
    console.log('Step 3/4: Clicking delete...');
    const deleteButton = workspaceItem.locator('button').filter({ hasText: /delete|trash/i }).first();
    // Fallback: look for any button with a Trash icon or destructive variant
    if (await deleteButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await deleteButton.click();
    } else {
      // Try finding the delete button by its icon (Trash2)
      const trashButton = workspaceItem.locator('button:has(svg)').last();
      await trashButton.click();
    }
    await page.waitForTimeout(500);
    console.log('Delete initiated\n');

    // Step 4: Confirm deletion
    console.log('Step 4/4: Confirming deletion...');
    const confirmButton = page.locator('[data-testid="settings-workspace-delete-confirm"]');
    const confirmVisible = await confirmButton.isVisible({ timeout: 3000 }).catch(() => false);
    if (confirmVisible) {
      await confirmButton.click();
      await page.waitForTimeout(2000);
      console.log('Deletion confirmed\n');
    } else {
      // Some delete flows use AlertDialog with "Continue" or "Delete" text
      const alertConfirm = page.locator('[role="alertdialog"] button').filter({ hasText: /delete|continue|confirm/i }).first();
      if (await alertConfirm.isVisible({ timeout: 3000 }).catch(() => false)) {
        await alertConfirm.click();
        await page.waitForTimeout(2000);
        console.log('Deletion confirmed via alert dialog\n');
      }
    }
  });
});
