import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';

test.describe('Delete Empty Session', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login('admin', 'admin123');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('should delete an empty session via confirmation dialog', async ({ page }) => {
    // Step 1: Click "Start new conversation" button from the dashboard
    const startNewBtn = page.locator('button', { hasText: /start new conversation|započni novi razgovor/i });
    await expect(startNewBtn).toBeVisible({ timeout: 5000 });
    console.log('  Dashboard visible - clicking "Start new conversation"');
    await startNewBtn.click();

    await page.waitForTimeout(2000);

    // Step 2: Verify chat input is visible (indicates a session view)
    const url = page.url();
    console.log(`  Current URL: ${url}`);

    const chatInput = page.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 10000 });
    console.log('  Chat input visible: true');

    // Step 3: The delete empty session button must be visible for an empty session
    const deleteLink = page.locator('button', { hasText: /delete.*empty.*session|obriši.*praznu.*sesiju/i });
    await expect(deleteLink).toBeVisible({ timeout: 10000 });
    console.log('  Found delete empty session button');
    await deleteLink.click();

    // Step 4: Confirmation dialog should appear
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    console.log('  Confirmation dialog appeared');

    // Verify dialog has destructive Delete button
    const deleteButton = dialog.locator('button', { hasText: /^(delete|obriši)$/i });
    await expect(deleteButton).toBeVisible();

    // Step 5: Click Delete to confirm
    console.log('  Clicking Delete to confirm');
    await deleteButton.click();

    // Step 6: Wait for dialog to close
    await expect(dialog).toBeHidden({ timeout: 5000 });
    console.log('  Dialog closed - session deleted');

    // Step 7: Verify we're back on a valid state (either dashboard or new session)
    await page.waitForTimeout(1000);
    const finalChatInput = page.getByTestId('chat-input');
    const finalDashboard = page.locator('text=No conversation selected');
    // Either chat input or dashboard should be visible (both are valid states after delete)
    await expect(finalChatInput.or(finalDashboard)).toBeVisible({ timeout: 10000 });
    console.log('  After delete: valid state confirmed');
    console.log('  Delete empty session test passed');
  });
});
