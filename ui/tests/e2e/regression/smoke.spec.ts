import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Regression Smoke Tests
 *
 * Quick tests that verify core features still work after changes.
 * Each test should complete in under 30 seconds.
 * Runs LAST in the test suite to catch regressions.
 *
 * Uses strict assertions only — no tolerant patterns.
 */
test.describe('Regression Smoke Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
  });

  test('login works', async ({ page }) => {
    test.setTimeout(30000);

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    // Verify we landed on the dashboard or workspaces page
    await page.waitForURL(/\/(dashboard|workspaces)/, { timeout: 15000 });

    // Verify the page has loaded with core UI elements
    const body = page.locator('body');
    await expect(body).toBeVisible();

    // Sidebar or main content area should be present
    const mainContent = page.locator('main, [role="main"], #root');
    await expect(mainContent).toBeVisible({ timeout: 10000 });
  });

  test('Knowledge Stacks opens and shows collections', async ({ page }) => {
    test.setTimeout(30000);

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Start a new conversation to get the chat toolbar visible
    const newConv = page.locator('[data-testid="sidebar-new-session-button"]').first();
    await expect(newConv).toBeVisible({ timeout: 5000 });
    await newConv.click();
    await page.waitForTimeout(1000);

    // Open collection selector (Knowledge Stacks)
    const collectionSelector = page.locator('[data-testid="collection-selector"]');
    await expect(collectionSelector).toBeVisible({ timeout: 10000 });
    await collectionSelector.click();
    await page.waitForTimeout(1000);

    // Verify the popover opened — either AI routing card (testid) or manual collection checkboxes
    const switchToManual = page.locator('[data-testid="chat-switch-to-manual-button"]');
    const checkboxes = page.locator('[role="checkbox"]');
    await expect(switchToManual.or(checkboxes.first())).toBeVisible({ timeout: 10000 });

    // Close the popover
    await page.keyboard.press('Escape');
  });

  test('Library tab loads documents', async ({ page }) => {
    test.setTimeout(30000);

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Open Knowledge Stacks dialog via sidebar quick-tools button
    const knowledgeButton = page.locator('[data-testid="sidebar-quick-tools-knowledge-button"]');
    await expect(knowledgeButton).toBeVisible({ timeout: 10000 });
    await knowledgeButton.click();
    await page.waitForTimeout(1000);

    // Click the Library tab inside the dialog
    const libraryTab = page.locator('[data-testid="knowledge-tab-library"]');
    await expect(libraryTab).toBeVisible({ timeout: 10000 });
    await libraryTab.click();
    await page.waitForTimeout(1500);

    // Verify library view loaded
    const libraryContainer = page.locator('[data-testid="library-view-container"]');
    await expect(libraryContainer).toBeVisible({ timeout: 10000 });
  });

  test('Notes drawer opens', async ({ page }) => {
    test.setTimeout(30000);

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Notes button is only visible after sending a message, so start a conversation first
    const newConv = page.locator('[data-testid="sidebar-new-session-button"]').first();
    await expect(newConv).toBeVisible({ timeout: 5000 });
    await newConv.click();
    await page.waitForTimeout(1000);

    // Send a quick message to activate the notes button
    const chatInput = page.locator('[data-testid="chat-input"]');
    await expect(chatInput).toBeVisible({ timeout: 10000 });
    await chatInput.fill('Hello');
    await page.waitForTimeout(300);
    await chatInput.press('Enter');

    // Wait for streaming to complete
    await expect(chatInput).not.toBeDisabled({ timeout: 60000 });
    await page.waitForTimeout(2000);

    // Click notes toggle button
    const notesToggle = page.locator('[data-testid="notes-toggle-button"]');
    await expect(notesToggle).toBeVisible({ timeout: 10000 });
    await notesToggle.click();
    await page.waitForTimeout(500);

    // Verify notes drawer opened
    const notesDrawer = page.locator('[data-testid="notes-drawer"]');
    await expect(notesDrawer).toBeVisible({ timeout: 5000 });
  });

  test('chat input is functional', async ({ page }) => {
    test.setTimeout(30000);

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Start a new conversation
    const newConv = page.locator('[data-testid="sidebar-new-session-button"]').first();
    await expect(newConv).toBeVisible({ timeout: 5000 });
    await newConv.click();
    await page.waitForTimeout(1000);

    // Verify chat input is visible and can accept text
    const chatInput = page.locator('[data-testid="chat-input"]');
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    const testText = 'Smoke test input';
    await chatInput.fill(testText);
    await page.waitForTimeout(300);

    // Verify the text was entered
    const inputValue = await chatInput.inputValue();
    expect(inputValue).toBe(testText);

    // Verify send button is visible
    const sendButton = page.locator('[data-testid="chat-send-button"]');
    await expect(sendButton).toBeVisible({ timeout: 5000 });
  });

  test('settings dialog opens', async ({ page }) => {
    test.setTimeout(30000);

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Click settings button
    const settingsButton = page.locator('[data-tour="settings-button"]');
    await expect(settingsButton).toBeVisible({ timeout: 10000 });
    await settingsButton.click();
    await page.waitForTimeout(500);

    // Verify settings dialog opened
    const settingsDialog = page.locator('[data-testid="settings-dialog"]');
    await expect(settingsDialog).toBeVisible({ timeout: 5000 });

    // Verify at least one settings tab is visible
    const settingsTabs = settingsDialog.locator('[data-testid^="settings-tab-"]');
    await expect(settingsTabs.first()).toBeVisible({ timeout: 5000 });
  });
});
