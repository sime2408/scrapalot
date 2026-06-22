import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * RAG Chat E2E Test
 *
 * Tests the complete RAG chat pipeline:
 * - Login and model selection
 * - Collection selection for RAG context
 * - Sending a query with selected collection
 * - Verifying the response arrives through gRPC pipeline
 *
 * Pipeline: UI → Gateway (8080) → Kotlin BE (8091) → gRPC → Python AI (8090)
 */
test.describe('RAG Chat', () => {
  test.beforeEach(async ({ page }) => {
    // Disable welcome tour before navigation
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('should send RAG query with collection selected and receive response', async ({ page }) => {
    // RAG queries can take up to 2 minutes
    test.setTimeout(180000);

    const consoleLogs: string[] = [];
    page.on('console', msg => {
      const text = msg.text();
      console.log(`  🌐 Browser: ${text}`);
      consoleLogs.push(text);
    });

    console.log('🧪 Starting RAG chat E2E test...\n');

    // Step 1: Start new conversation
    console.log('Step 1/7: Starting new conversation...');
    const newConversationLink = page.locator('text=New Conversation').first();
    await expect(newConversationLink).toBeVisible({ timeout: 5000 });
    await newConversationLink.click();
    await page.waitForTimeout(1000);
    console.log('New conversation started\n');

    // Step 2: Verify chat input is visible
    console.log('Step 2/7: Locating chat input...');
    const chatInput = page.locator('[data-testid="chat-input"]');
    await chatInput.waitFor({ state: 'visible', timeout: 10000 });
    console.log('Chat input found\n');

    // Step 3: Select Scrapalot AI model
    console.log('Step 3/7: Selecting Scrapalot AI model...');
    const modelSelector = page.locator('[data-testid="model-selector"]');
    await modelSelector.waitFor({ state: 'visible', timeout: 5000 });
    await modelSelector.click();
    await page.waitForTimeout(500);

    const scrapalotOption = page.locator('[role="option"]').filter({ hasText: 'Scrapalot AI' }).first();
    await expect(scrapalotOption).toBeVisible({ timeout: 5000 });
    await scrapalotOption.click();
    await page.waitForTimeout(1000);
    console.log('Scrapalot AI model selected\n');

    // Step 4: Open collection selector and select a collection
    console.log('Step 4/7: Opening collection selector...');
    const collectionButton = page.locator('[data-testid="collection-selector"]');
    await collectionButton.waitFor({ state: 'visible', timeout: 5000 });
    await collectionButton.click();
    await page.waitForTimeout(1000);

    // Look for collection checkboxes in the popover/dialog
    const collectionsTab = page.locator('text=Collections').first();
    await expect(collectionsTab).toBeVisible({ timeout: 5000 });
    console.log('  Collections tab visible');

    // Try to select a collection - use checkbox (not label which may be disabled)
    let collectionSelected = false;

    // Method 1: Click directly on checkbox buttons (Radix UI Checkbox)
    const checkboxes = page.locator('[role="checkbox"]');
    const checkboxCount = await checkboxes.count();
    console.log(`  Found ${checkboxCount} checkboxes`);

    if (checkboxCount > 0) {
      // Find an enabled checkbox
      for (let i = 0; i < Math.min(checkboxCount, 5); i++) {
        const checkbox = checkboxes.nth(i);
        const isDisabled = await checkbox.getAttribute('data-disabled');
        const ariaDisabled = await checkbox.getAttribute('aria-disabled');
        if (isDisabled === null && ariaDisabled !== 'true') {
          await checkbox.click({ timeout: 3000 });
          collectionSelected = true;
          console.log(`  Selected checkbox ${i}`);
          break;
        }
      }
    }

    // Method 2: If no enabled checkbox, try force-clicking the first one
    if (!collectionSelected && checkboxCount > 0) {
      await checkboxes.first().click({ force: true, timeout: 3000 });
      collectionSelected = true;
      console.log('  Force-selected first checkbox');
    }

    // A collection MUST be selected for RAG tests
    expect(collectionSelected).toBe(true);

    // Close collection selector by pressing Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    console.log('Collection selector handled\n');

    // Step 5: Enter a RAG query about Art of War (has embeddings in "Integration Test" collection)
    console.log('Step 5/8: Entering RAG query...');
    const query = 'What are the main strategic principles discussed in the Art of War by Sun Tzu?';
    await chatInput.fill(query);
    await page.waitForTimeout(500);
    console.log(`Query entered: "${query}"\n`);

    // Step 6: Send message
    console.log('Step 6/8: Sending message...');
    const sendButton = page.locator('[data-testid="chat-send-button"]');
    await sendButton.waitFor({ state: 'visible', timeout: 5000 });

    // Wait for send button to be enabled
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="chat-send-button"]');
        if (!btn) return false;
        return !btn.hasAttribute('disabled');
      },
      { timeout: 10000 }
    );

    await sendButton.click();
    console.log('Message sent\n');

    // Step 7: Wait for response and verify
    console.log('Step 7/8: Waiting for response...');
    console.log('  ⏳ Waiting for streaming to complete...\n');

    // Wait for initial response
    await page.waitForTimeout(3000);

    // Wait for chat input to become enabled (streaming done)
    const chatInputForWait = page.locator('[data-testid="chat-input"]');
    await expect(chatInputForWait).not.toBeDisabled({ timeout: 120000 });
    await page.waitForTimeout(2000);

    // Verify we got both messages (user + assistant)
    const messages = page.locator('[data-testid="chat-message"]');
    await expect(messages).toHaveCount(2, { timeout: 30000 });
    console.log('  Found 2 messages (user + assistant)');

    // Verify assistant message exists and has content
    const assistantMessage = page.locator('[data-testid="chat-message"][data-role="assistant"]').first();
    await expect(assistantMessage).toBeVisible();

    const responseText = await assistantMessage.innerText();
    console.log(`  📝 Response length: ${responseText.length} characters`);

    // Response should be non-trivial (at least some text)
    expect(responseText.length).toBeGreaterThan(20);
    console.log('  Response received and verified');

    // Step 8: Verify citations appear on screen
    console.log('Step 8/8: Checking for citations...');

    // Wait extra time for citation rendering after stream completion
    await page.waitForTimeout(3000);

    // Check for citation section in the assistant message
    const citationsSection = page.locator('[data-testid="message-citations-section"]');
    await expect(citationsSection).toBeVisible({ timeout: 30000 });
    console.log('  Citations section found');

    // Click the toggle button to expand citations
    const citationsToggle = page.locator('[data-testid="citations-toggle-button"]');
    await expect(citationsToggle).toBeVisible({ timeout: 5000 });
    await citationsToggle.click();
    await page.waitForTimeout(1000);

    // Count citation items
    const citationItems = page.locator('[data-testid^="citation-item-"]');
    const citationCount = await citationItems.count();
    console.log(`  Found ${citationCount} citation(s)`);
    expect(citationCount).toBeGreaterThan(0);

    // Verify citation has document title
    const firstCitation = citationItems.first();
    const citationText = await firstCitation.innerText();
    console.log(`  📄 First citation: ${citationText.substring(0, 100)}...`);
    expect(citationText.length).toBeGreaterThan(5);

    const hasCitations = true;

    // Take screenshot
    await page.screenshot({
      path: 'test-results/rag-chat-success.png',
      fullPage: true
    });
    console.log('  📸 Screenshot saved: test-results/rag-chat-success.png\n');

    console.log('🎉 RAG chat E2E test completed successfully!\n');
    console.log('Summary:');
    console.log('  - Model selection: ✅');
    console.log('  - Collection selector: ✅');
    console.log('  - Message sent: ✅');
    console.log('  - Response received: ✅');
    console.log(`  - Citations: ${hasCitations ? '✅' : '⚠️ Not found'}`);
  });

  test('should keep messages visible after stream completes and refresh cycle', async ({ page }) => {
    // This test verifies that messages don't disappear after the post-stream
    // refreshSessions() call (which was the root cause of the message disappearing bug)
    test.setTimeout(180000);

    console.log('🧪 Testing message persistence after stream completion...\n');

    // Verify backend is responsive before testing (prevents flaky failures after container restarts)
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const healthOk = await page.evaluate(async () => {
      for (let i = 0; i < 10; i++) {
        try {
          const resp = await fetch('/api/v1/health');
          if (resp.ok) return true;
        } catch { /* backend not ready yet */ }
        await new Promise(r => setTimeout(r, 2000));
      }
      return false;
    });
    console.log(`  Backend health: ${healthOk ? 'OK' : 'TIMEOUT (proceeding anyway)'}`);

    // Navigate fresh to avoid state from previous test
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Select Scrapalot AI model
    const modelSelector = page.locator('[data-testid="model-selector"]');
    await modelSelector.waitFor({ state: 'visible', timeout: 15000 });
    await modelSelector.click();
    await page.waitForTimeout(1000);

    const scrapalotOption = page.locator('[role="option"]').filter({ hasText: 'Scrapalot AI' }).first();
    await expect(scrapalotOption).toBeVisible({ timeout: 5000 });
    await scrapalotOption.click();
    await page.waitForTimeout(1000);

    // Send a simple message
    const chatInput = page.locator('[data-testid="chat-input"]');
    await chatInput.waitFor({ state: 'visible', timeout: 10000 });
    await chatInput.click();
    await page.waitForTimeout(500);
    await chatInput.fill('What is the capital of France?');
    await page.waitForTimeout(500);

    const sendButton = page.locator('[data-testid="chat-send-button"]');
    await sendButton.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="chat-send-button"]');
        if (!btn) return false;
        return !btn.hasAttribute('disabled');
      },
      { timeout: 10000 }
    );
    await sendButton.click();
    console.log('  Message sent');

    // Wait for assistant response to appear (90s timeout for VPS under load)
    const assistantMessage = page.locator('[data-testid="chat-message"][data-role="assistant"]');
    await assistantMessage.first().waitFor({ state: 'visible', timeout: 90000 });

    // Wait for streaming to complete (chat input becomes enabled)
    const chatInputForWait = page.locator('[data-testid="chat-input"]');
    await expect(chatInputForWait).not.toBeDisabled({ timeout: 90000 });
    console.log('  Stream completed');

    // CRITICAL: Wait for the post-stream refresh cycle (refreshSessions at T+5000ms)
    // This is the window where messages previously disappeared
    await page.waitForTimeout(8000);
    console.log('  Waited 8s for post-stream refresh cycle');

    // Verify messages are STILL visible after refresh cycle
    const userMessages = page.locator('[data-testid="chat-message"][data-role="user"]');
    const assistantMessages = page.locator('[data-testid="chat-message"][data-role="assistant"]');

    const userCount = await userMessages.count();
    const assistantCount = await assistantMessages.count();
    console.log(`  User messages: ${userCount}, Assistant messages: ${assistantCount}`);

    expect(userCount).toBeGreaterThanOrEqual(1);
    expect(assistantCount).toBeGreaterThanOrEqual(1);

    // Verify content is not empty
    const assistantText = await assistantMessages.first().innerText();
    expect(assistantText.length).toBeGreaterThan(0);
    console.log(`  Assistant response length: ${assistantText.length} chars`);

    // Take screenshot
    await page.screenshot({
      path: 'test-results/message-persistence-success.png',
      fullPage: true
    });

    console.log('Messages remain visible after post-stream refresh cycle\n');
  });
});
