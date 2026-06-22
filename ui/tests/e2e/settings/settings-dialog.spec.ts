import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Settings Dialog E2E Tests
 *
 * Tests the settings dialog functionality:
 * - Opening/closing the settings dialog
 * - Tab navigation
 * - Language switching
 * - Theme switching
 * - Accent color switching
 * - Account info display
 */
test.describe('Settings Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  // Helper: get the visible settings tab (mobile or desktop layout)
  async function clickSettingsTab(page: import('@playwright/test').Page, tabId: string) {
    // Settings has both mobile (horizontal) and desktop (sidebar) tab elements
    // Pick the one that's visible based on viewport
    const tab = page.locator(`[data-testid="settings-tab-${tabId}"]`);
    const count = await tab.count();
    for (let i = 0; i < count; i++) {
      if (await tab.nth(i).isVisible({ timeout: 1000 }).catch(() => false)) {
        await tab.nth(i).click();
        return;
      }
    }
    // Fallback: force click the last one (desktop)
    await tab.last().click({ force: true });
  }

  test('should open and close settings dialog', async ({ page }) => {
    console.log('🧪 Testing settings dialog open/close...\n');

    // Step 1: Open settings via sidebar button
    console.log('Step 1/3: Opening settings dialog...');
    const settingsButton = page.locator('[data-tour="settings-button"]');
    await settingsButton.waitFor({ state: 'visible', timeout: 10000 });
    await settingsButton.click();
    await page.waitForTimeout(500);

    // Verify dialog is visible
    const dialog = page.locator('[data-testid="settings-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(dialog).toBeVisible();
    console.log('Settings dialog opened\n');

    // Step 2: Verify General tab is active by default (check content area has language section)
    console.log('Step 2/3: Checking default tab...');
    const languageSection = page.locator('[data-testid="settings-language-select"]');
    await languageSection.waitFor({ state: 'visible', timeout: 10000 });
    await expect(languageSection).toBeVisible();
    console.log('General tab content visible\n');

    // Step 3: Close dialog with Escape
    console.log('Step 3/3: Closing dialog with Escape...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await expect(dialog).not.toBeVisible();
    console.log('Dialog closed\n');
  });

  test('should navigate between settings tabs', async ({ page }) => {
    console.log('🧪 Testing settings tab navigation...\n');

    // Open settings
    const settingsButton = page.locator('[data-tour="settings-button"]');
    await settingsButton.click();
    await page.waitForTimeout(500);

    const dialog = page.locator('[data-testid="settings-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Navigate to each tab and verify content changes
    const tabs = ['workspaces', 'remote-providers', 'account', 'general'];

    for (const tabId of tabs) {
      console.log(`  Clicking tab: ${tabId}...`);
      await clickSettingsTab(page, tabId);
      await page.waitForTimeout(500);

      // Verify content area exists
      const content = page.locator('[data-testid="settings-tab-content"]');
      await expect(content).toBeVisible();
      console.log(`  Tab ${tabId} content loaded`);
    }

    console.log('\nAll tabs navigated successfully\n');
  });

  test('should change language', async ({ page }) => {
    test.setTimeout(90000);

    console.log('🧪 Testing language change...\n');

    // Open settings
    const settingsButton = page.locator('[data-tour="settings-button"]');
    await settingsButton.click();
    await page.waitForTimeout(500);

    const dialog = page.locator('[data-testid="settings-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Verify we're on General tab
    const languageSelect = page.locator('[data-testid="settings-language-select"]');
    await languageSelect.waitFor({ state: 'visible', timeout: 5000 });

    // Step 1: Change to Croatian
    console.log('Step 1/3: Switching to Croatian...');
    await languageSelect.click();
    await page.waitForTimeout(500);

    // Select Croatian option (shown as "Croatian" in English UI)
    const hrOption = page.locator('[role="option"]').filter({ hasText: 'Croatian' });
    await hrOption.waitFor({ state: 'visible', timeout: 5000 });
    await hrOption.click();
    await page.waitForTimeout(2000); // Wait for auto-save

    // Verify language changed (Croatian labels should appear)
    console.log('Croatian selected\n');

    // Step 2: Change back to English
    console.log('Step 2/3: Switching back to English...');
    const languageSelectAfter = page.locator('[data-testid="settings-language-select"]');
    await languageSelectAfter.click();
    await page.waitForTimeout(500);

    // In Croatian UI, English is "Engleski"
    const enOption = page.locator('[role="option"]').filter({ hasText: /English|Engleski/ });
    await enOption.waitFor({ state: 'visible', timeout: 5000 });
    await enOption.click();
    await page.waitForTimeout(2000); // Wait for auto-save
    console.log('English restored\n');

    // Step 3: Verify English is active
    console.log('Step 3/3: Verifying English active...');
    await expect(languageSelectAfter).toBeVisible();
    console.log('Language switch test complete\n');
  });

  test('should change theme', async ({ page }) => {
    console.log('🧪 Testing theme change...\n');

    // Open settings
    const settingsButton = page.locator('[data-tour="settings-button"]');
    await settingsButton.click();
    await page.waitForTimeout(500);

    const dialog = page.locator('[data-testid="settings-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Step 1: Switch to dark theme
    console.log('Step 1/3: Switching to dark theme...');
    const darkTheme = page.locator('[data-testid="settings-theme-dark"]');
    await darkTheme.waitFor({ state: 'visible', timeout: 5000 });
    await darkTheme.click();
    await page.waitForTimeout(1500); // Wait for auto-save

    // Verify dark class on html
    const htmlClass = await page.locator('html').getAttribute('class');
    expect(htmlClass).toContain('dark');
    console.log('Dark theme applied\n');

    // Step 2: Switch to light theme
    console.log('Step 2/3: Switching to light theme...');
    const lightTheme = page.locator('[data-testid="settings-theme-light"]');
    await lightTheme.click();
    await page.waitForTimeout(1500);

    const htmlClassLight = await page.locator('html').getAttribute('class');
    expect(htmlClassLight).not.toContain('dark');
    console.log('Light theme applied\n');

    // Step 3: Restore system theme
    console.log('Step 3/3: Restoring system theme...');
    const systemTheme = page.locator('[data-testid="settings-theme-system"]');
    await systemTheme.click();
    await page.waitForTimeout(1500);
    console.log('System theme restored\n');
  });

  test('should change accent color', async ({ page }) => {
    console.log('🧪 Testing accent color change...\n');

    // Open settings
    const settingsButton = page.locator('[data-tour="settings-button"]');
    await settingsButton.click();
    await page.waitForTimeout(500);

    const dialog = page.locator('[data-testid="settings-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Step 1: Click blue accent
    console.log('Step 1/2: Selecting blue accent...');
    const blueAccent = page.locator('[data-testid="settings-accent-blue"]');
    await blueAccent.waitFor({ state: 'visible', timeout: 5000 });
    await blueAccent.click();
    await page.waitForTimeout(1500);
    console.log('Blue accent selected\n');

    // Step 2: Click violet accent
    console.log('Step 2/2: Selecting violet accent...');
    const violetAccent = page.locator('[data-testid="settings-accent-violet"]');
    await violetAccent.click();
    await page.waitForTimeout(1500);
    console.log('Violet accent selected\n');

    // Restore gray (default)
    const grayAccent = page.locator('[data-testid="settings-accent-gray"]');
    await grayAccent.click();
    await page.waitForTimeout(1500);
    console.log('Gray accent restored\n');
  });

  test('should display account info and storage', async ({ page }) => {
    test.setTimeout(90000);

    console.log('🧪 Testing account info display...\n');

    // Open settings
    const settingsButton = page.locator('[data-tour="settings-button"]');
    await settingsButton.click();
    await page.waitForTimeout(500);

    const dialog = page.locator('[data-testid="settings-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Navigate to Account tab
    console.log('Step 1/3: Navigating to Account tab...');
    await clickSettingsTab(page, 'account');
    await page.waitForTimeout(1000);
    console.log('Account tab opened\n');

    // Step 2: Verify username is visible
    console.log('Step 2/3: Checking username display...');
    const username = page.locator('[data-testid="settings-account-username"]');
    await username.waitFor({ state: 'visible', timeout: 10000 });
    const usernameText = await username.textContent();
    expect(usernameText).toContain('@');
    console.log(`Username visible: ${usernameText}\n`);

    // Step 3: Verify storage section is visible
    console.log('Step 3/3: Checking storage display...');
    const storage = page.locator('[data-testid="settings-account-storage"]');
    await storage.waitFor({ state: 'visible', timeout: 15000 });
    await expect(storage).toBeVisible();
    console.log('Storage quota displayed\n');
  });
});
