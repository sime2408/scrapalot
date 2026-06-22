import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Settings Providers E2E Tests
 *
 * Tests remote AI provider management:
 * - Viewing remote providers list
 * - Model selector showing loaded providers
 */
test.describe('Settings Providers', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('should display remote providers list in settings', async ({ page }) => {
    test.setTimeout(90000);

    console.log('🧪 Testing remote providers display...\n');

    // Step 1: Open settings
    console.log('Step 1/3: Opening settings...');
    const settingsButton = page.locator('[data-tour="settings-button"]');
    await settingsButton.waitFor({ state: 'visible', timeout: 10000 });
    await settingsButton.click();
    await page.waitForTimeout(500);

    const dialog = page.locator('[data-testid="settings-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    console.log('Settings opened\n');

    // Step 2: Navigate to Remote Providers tab
    console.log('Step 2/3: Navigating to Remote Providers tab...');
    // Settings has both mobile and desktop tab elements; pick the visible one
    const providersTab = page.locator('[data-testid="settings-tab-remote-providers"]');
    const tabCount = await providersTab.count();
    let clicked = false;
    for (let i = 0; i < tabCount; i++) {
      if (await providersTab.nth(i).isVisible({ timeout: 1000 }).catch(() => false)) {
        await providersTab.nth(i).click();
        clicked = true;
        break;
      }
    }
    if (!clicked) await providersTab.last().click({ force: true });
    await page.waitForTimeout(1000);
    console.log('Remote Providers tab opened\n');

    // Step 3: Verify providers list is visible with at least 1 provider
    console.log('Step 3/3: Checking providers list...');
    const providersList = page.locator('[data-testid="settings-providers-list"]');
    await providersList.waitFor({ state: 'visible', timeout: 15000 });

    // Check at least 1 provider item exists
    const providerItems = page.locator('[data-testid^="settings-provider-item-"]');
    const count = await providerItems.count();
    expect(count).toBeGreaterThan(0);
    console.log(`Found ${count} providers\n`);
  });

  test('should show model selector with loaded providers on dashboard', async ({ page }) => {
    console.log('🧪 Testing model selector with providers...\n');

    // Step 1: Start a new conversation to make model selector visible
    console.log('Step 1/3: Starting new conversation...');
    const startButton = page.locator('text=Start new conversation').or(page.locator('text=New Conversation').first());
    if (await startButton.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await startButton.first().click();
      await page.waitForTimeout(1000);
    }

    // Step 2: Verify model selector is visible
    console.log('Step 2/3: Checking model selector...');
    const modelSelector = page.locator('[data-testid="model-selector"]');
    await modelSelector.waitFor({ state: 'visible', timeout: 20000 });
    console.log('Model selector visible\n');

    // Step 3: Click to open and verify options exist
    console.log('Step 3/3: Opening model selector...');
    await modelSelector.click();
    await page.waitForTimeout(500);

    // Check for model options in dropdown
    const options = page.locator('[role="option"]');
    const optionCount = await options.count().catch(() => 0);

    // Close with Escape
    await page.keyboard.press('Escape');

    expect(optionCount).toBeGreaterThan(0);
    console.log(`Model selector has ${optionCount} options\n`);
  });
});
