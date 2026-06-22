import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Sidebar Re-ordering E2E Test
 *
 * Verifies that after sending a message to an older session, that session
 * moves to the top of the sidebar list (sorted by updated_at DESC).
 *
 * Regression test for:
 * - Kotlin: session.updated_at not updating when same model reused (Hibernate dirty-check skipping UPDATE)
 * - Frontend: sidebarRefreshCount not propagating from use-conversations to sessions-list
 */
test.describe('Sidebar Session Re-ordering', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    // Capture browser console logs for debugging
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('[sidebar-debug]')) {
        console.log(`[BROWSER] ${text}`);
      }
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
  });

  test('should move session to top of sidebar after receiving chat response', async ({ page }) => {
    test.setTimeout(180000);

    console.log('Testing sidebar re-ordering after chat response...\n');

    // Step 1: Get all sidebar sessions (li buttons, exclude "New Conversation")
    console.log('Step 1: Loading sidebar sessions...');
    await page.waitForTimeout(2000);

    const sidebarSessions = page.locator('li button').filter({
      hasNot: page.locator('text=New Conversation'),
    });
    const sessionCount = await sidebarSessions.count();
    console.log(`  Found ${sessionCount} sessions in sidebar`);

    if (sessionCount < 2) {
      console.log('  Need at least 2 sessions to test re-ordering, skipping');
      test.skip();
      return;
    }

    // Step 2: Get the name of the SECOND session (not the top one)
    console.log('Step 2: Identifying second session (not top)...');
    const secondSession = sidebarSessions.nth(1);
    const secondSessionName = await secondSession.textContent();
    console.log(`  Second session: "${secondSessionName?.trim()}"`);

    // Step 3: Click the second session to open it
    console.log('Step 3: Opening second session...');
    await secondSession.click();
    await page.waitForTimeout(1500);

    // Verify chat input is ready
    const chatInput = page.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 10000 });
    console.log('  Chat input visible');

    // Step 4: Log message count for reference (not used for assertion)
    const messagesBefore = await page.getByTestId('chat-message').count();
    console.log(`Step 4: Messages visible before send: ${messagesBefore}`);

    // Step 5: Send a unique message (timestamp ensures no false match from previous runs)
    const testTimestamp = Date.now().toString();
    const testMessage = `Kratko odgovori: što je AI? [${testTimestamp}]`;
    console.log('Step 5: Sending message...');
    await chatInput.click();
    await chatInput.fill(testMessage);
    // Use send button instead of Enter key (more reliable in E2E tests)
    const sendButton = page.getByTestId('chat-send-button');
    await sendButton.click();
    console.log('  Message sent');

    // Step 6: Wait for user message to appear in DOM
    // NOTE: Count-based check fails with virtual scrolling (old msgs removed = count doesn't increase).
    // Instead, wait for the unique timestamp token to appear in any chat-message element.
    console.log('Step 6: Waiting for user message to appear...');
    await page.waitForFunction(
      (token) => {
        const msgs = document.querySelectorAll('[data-testid="chat-message"]');
        return Array.from(msgs).some(m => (m.textContent || '').includes(token));
      },
      testTimestamp,
      { timeout: 30000 }
    );

    // Step 7: Wait for the AI response to complete — stop button disappears when done
    console.log('Step 7: Waiting for AI stream to fully complete...');
    // The stop/cancel button (red button bottom-right) is only visible during streaming
    // When streaming ends, it disappears and the send button becomes active again
    await page.waitForFunction(
      () => {
        const msgs = document.querySelectorAll('[data-testid="chat-message"][data-role="assistant"]');
        if (msgs.length === 0) return false;
        const lastMsg = msgs[msgs.length - 1];
        const text = lastMsg.textContent || '';
        // Response is done when it has actual content (not just the "Analyzing..." status)
        return text.length > 50 && !text.includes('Analyzing');
      },
      { timeout: 90000 }
    );
    console.log('  AI response completed with actual content');

    // Step 8: Wait extra time for the 5s refresh timer to fire and sidebar to update
    console.log('Step 8: Waiting for sidebar refresh timer (up to 12s)...');
    await page.waitForTimeout(10000);

    // Step 9: Check the sidebar — the second session should now be first
    console.log('Step 9: Verifying session moved to top...');

    // Wait for the sidebar to re-sort (poll every 500ms for up to 8 more seconds)
    let firstSessionNameAfter = '';
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const updatedSessions = page.locator('li button').filter({
        hasNot: page.locator('text=New Conversation'),
      });
      firstSessionNameAfter = (await updatedSessions.first().textContent())?.trim() ?? '';
      if (firstSessionNameAfter === secondSessionName?.trim()) {
        break;
      }
      await page.waitForTimeout(500);
    }

    console.log(`  First session after re-sort: "${firstSessionNameAfter}"`);
    console.log(`  Expected: "${secondSessionName?.trim()}"`);

    expect(firstSessionNameAfter).toBe(secondSessionName?.trim());
    console.log('  ✓ Session successfully moved to top of sidebar!');
  });
});
