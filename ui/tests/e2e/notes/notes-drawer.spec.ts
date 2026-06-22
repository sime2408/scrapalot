import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Helper: Start a new conversation and send a message.
 * After login, the dashboard shows "No conversation selected".
 * We must click "Start new conversation" first to get the chat input.
 */
async function startConversationAndSendMessage(page: any, message: string) {
  const startNewBtn = page.locator('button:has-text("Start new conversation")');
  const chatInput = page.locator('[data-testid="chat-input"]');

  // Try waiting for chat input first; if not visible, start a new conversation
  try {
    await chatInput.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    await startNewBtn.waitFor({ state: 'visible', timeout: 10000 });
    await startNewBtn.click();
  }

  await chatInput.waitFor({ state: 'visible', timeout: 15000 });
  await chatInput.fill(message);

  // Wait for send button to be enabled
  const sendButton = page.locator('[data-testid="chat-send-button"]');
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="chat-send-button"]');
      return btn && !btn.hasAttribute('disabled');
    },
    { timeout: 10000 }
  );
  await sendButton.click();

  // Wait for response to complete (input re-enables)
  await expect(chatInput).not.toBeDisabled({ timeout: 60000 });
  await page.waitForTimeout(2000);
}

test.describe('Notes Drawer', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('should open and close notes drawer', async ({ page }) => {
    test.setTimeout(120000);

    await startConversationAndSendMessage(page, 'test for notes drawer');

    // Notes toggle button MUST be visible after sending a message
    const notesToggle = page.locator('[data-testid="notes-toggle-button"]');
    await expect(notesToggle).toBeVisible({ timeout: 15000 });
    await notesToggle.click();

    // Drawer MUST open
    const notesDrawer = page.locator('[data-testid="notes-drawer"]');
    await expect(notesDrawer).toBeVisible({ timeout: 10000 });

    // Title element MUST be present
    const drawerTitle = page.locator('[data-testid="notes-drawer-title"]');
    await expect(drawerTitle).toBeAttached({ timeout: 5000 });

    // Editor MUST initialize (ProseMirror div appears)
    const editor = page.locator('.ProseMirror');
    await expect(editor).toBeVisible({ timeout: 15000 });

    // Verify the drawer has proper z-index (should be above chat content)
    const zIndex = await notesDrawer.evaluate((el: HTMLElement) => {
      return getComputedStyle(el).zIndex;
    });
    expect(zIndex).not.toBe('auto');
    expect(Number(zIndex)).toBeGreaterThanOrEqual(1);

    await page.screenshot({
      path: 'test-results/notes-drawer-open.png',
      fullPage: true,
    });

    // Close the drawer via Escape (X button removed)
    await page.keyboard.press('Escape');

    // Drawer MUST be gone
    await expect(notesDrawer).not.toBeVisible({ timeout: 5000 });
  });

  test('should type content in notes editor', async ({ page }) => {
    test.setTimeout(120000);

    await startConversationAndSendMessage(page, 'hello');

    // Open notes drawer
    const notesToggle = page.locator('[data-testid="notes-toggle-button"]');
    await expect(notesToggle).toBeVisible({ timeout: 15000 });
    await notesToggle.click();

    const notesDrawer = page.locator('[data-testid="notes-drawer"]');
    await expect(notesDrawer).toBeVisible({ timeout: 10000 });

    // Wait for ProseMirror editor to be ready
    const editor = page.locator('.ProseMirror');
    await expect(editor).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1000);

    // Click editor and type content
    await editor.click();
    const testContent = `E2E test note ${Date.now()}`;
    await page.keyboard.type(testContent, { delay: 30 });

    // Verify content was typed - MUST contain the text
    const editorText = await editor.textContent();
    expect(editorText).toContain('E2E test note');

    // Verify toolbar buttons MUST exist
    const saveButton = page.locator('[data-testid="notes-save-button"]');
    await expect(saveButton).toBeVisible({ timeout: 5000 });

    const newButton = page.locator('[data-testid="notes-new-button"]');
    await expect(newButton).toBeVisible({ timeout: 5000 });

    await page.screenshot({
      path: 'test-results/notes-content-typed.png',
      fullPage: true,
    });

    // Close drawer via Escape (X button removed)
    await page.keyboard.press('Escape');
    await expect(notesDrawer).not.toBeVisible({ timeout: 5000 });
  });

  test('should show collaboration header with connection status', async ({ page }) => {
    test.setTimeout(120000);

    await startConversationAndSendMessage(page, 'test notes collab');

    // Open notes drawer
    const notesToggle = page.locator('[data-testid="notes-toggle-button"]');
    await expect(notesToggle).toBeVisible({ timeout: 15000 });
    await notesToggle.click();

    const notesDrawer = page.locator('[data-testid="notes-drawer"]');
    await expect(notesDrawer).toBeVisible({ timeout: 10000 });

    // Wait for editor to initialize
    const editor = page.locator('.ProseMirror');
    await expect(editor).toBeVisible({ timeout: 15000 });

    // Collaboration header MUST appear
    const collabHeader = page.locator('[data-testid="collaboration-header"]');
    await expect(collabHeader).toBeVisible({ timeout: 15000 });

    // Connection status indicator MUST exist
    const connectionStatus = page.locator('[data-testid="connection-status"]');
    await expect(connectionStatus).toBeVisible({ timeout: 15000 });

    // Status text MUST be one of the expected values
    const statusText = await connectionStatus.textContent();
    expect(statusText).toBeTruthy();
    const validStatuses = ['LIVE', 'SYNCHRONIZING', 'OFFLINE'];
    const hasValidStatus = validStatuses.some(s => statusText?.includes(s));
    expect(hasValidStatus).toBe(true);

    await page.screenshot({
      path: 'test-results/notes-collaboration-header.png',
      fullPage: true,
    });

    // Close via Escape (X button removed)
    await page.keyboard.press('Escape');
    await expect(notesDrawer).not.toBeVisible({ timeout: 5000 });
  });
});
