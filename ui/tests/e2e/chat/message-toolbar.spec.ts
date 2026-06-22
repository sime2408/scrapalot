import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';
import { sendMessageAndWait, startNewConversation, selectScrapalotModel } from '../utils/rag-helpers';

test.describe('Chat Message Toolbar', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await basePage.waitForAppReady();
    await startNewConversation(page);
    await selectScrapalotModel(page);
  });

  test('user message toolbar shows edit, copy, repeat buttons', async ({ page }) => {
    await sendMessageAndWait(page, 'Hello, this is a test message.');

    // Find the user message
    const userMessage = page.locator('[data-testid="chat-message"][data-role="user"]').first();
    await expect(userMessage).toBeVisible();

    // Verify always-visible buttons
    const editButton = userMessage.locator('[data-testid="message-edit-button"]');
    const copyButton = userMessage.locator('[data-testid="message-copy-button"]');
    const repeatButton = userMessage.locator('[data-testid="message-repeat-button"]');

    await expect(editButton).toBeVisible();
    await expect(copyButton).toBeVisible();
    await expect(repeatButton).toBeVisible();
  });

  test('user more options reveals analyze, forward, delete buttons', async ({ page }) => {
    await sendMessageAndWait(page, 'Hello, this is a test message.');

    const userMessage = page.locator('[data-testid="chat-message"][data-role="user"]').first();
    await expect(userMessage).toBeVisible();

    // Click more button
    const moreButton = userMessage.locator('[data-testid="message-more-button"]');
    await expect(moreButton).toBeVisible();
    await moreButton.click();
    await page.waitForTimeout(300);

    // Verify expandable buttons appear
    const analyzeButton = userMessage.locator('[data-testid="message-analyze-button"]');
    const forwardButton = userMessage.locator('[data-testid="message-forward-button"]');
    const deleteButton = userMessage.locator('[data-testid="message-delete-button"]');

    await expect(analyzeButton).toBeVisible();
    await expect(forwardButton).toBeVisible();
    await expect(deleteButton).toBeVisible();
  });

  test('analyze button opens message analysis popover', async ({ page }) => {
    await sendMessageAndWait(page, 'This is a test message with several words and two sentences. Here is another one.');

    const userMessage = page.locator('[data-testid="chat-message"][data-role="user"]').first();
    const moreButton = userMessage.locator('[data-testid="message-more-button"]');
    await moreButton.click();
    await page.waitForTimeout(300);

    const analyzeButton = userMessage.locator('[data-testid="message-analyze-button"]');
    await analyzeButton.click();
    await page.waitForTimeout(500);

    // Verify popover appears with analysis data
    const popoverContent = page.locator('[data-radix-popper-content-wrapper]');
    await expect(popoverContent).toBeVisible({ timeout: 3000 });

    // Should show word count, character count, etc.
    const popoverText = await popoverContent.innerText();
    expect(popoverText).toContain('Words');
    expect(popoverText).toContain('Characters');
  });

  test('AI message toolbar shows edit, copy, continue buttons', async ({ page }) => {
    await sendMessageAndWait(page, 'Hello, this is a test message.');

    const assistantMessage = page.locator('[data-testid="chat-message"][data-role="assistant"]').first();
    await expect(assistantMessage).toBeVisible();

    // Verify always-visible AI buttons
    const editButton = assistantMessage.locator('[data-testid="message-ai-edit-button"]');
    const copyButton = assistantMessage.locator('[data-testid="message-ai-copy-button"]');
    const continueButton = assistantMessage.locator('[data-testid="message-continue-button"]');

    await expect(editButton).toBeVisible();
    await expect(copyButton).toBeVisible();
    await expect(continueButton).toBeVisible();
  });

  test('AI more options reveals regenerate and token metrics buttons', async ({ page }) => {
    await sendMessageAndWait(page, 'Hello, this is a test message.');

    const assistantMessage = page.locator('[data-testid="chat-message"][data-role="assistant"]').first();
    await expect(assistantMessage).toBeVisible();

    // Click more button on AI message
    const moreButton = assistantMessage.locator('[data-testid="message-ai-more-button"]');
    await expect(moreButton).toBeVisible();
    await moreButton.click();
    await page.waitForTimeout(300);

    // Verify expandable buttons appear
    const regenerateButton = assistantMessage.locator('[data-testid="message-regenerate-button"]');
    const tokenMetricsButton = assistantMessage.locator('[data-testid="message-token-metrics-button"]');
    const deleteButton = assistantMessage.locator('[data-testid="message-ai-delete-button"]');

    await expect(regenerateButton).toBeVisible();
    await expect(tokenMetricsButton).toBeVisible();
    await expect(deleteButton).toBeVisible();
  });

  test('AI message delete button removes the message', async ({ page }) => {
    await sendMessageAndWait(page, 'Hello, this is a test message.');

    const assistantMessage = page.locator('[data-testid="chat-message"][data-role="assistant"]').first();
    await expect(assistantMessage).toBeVisible();

    // Reveal the delete button (collapsed under "more options" by default)
    const moreButton = assistantMessage.locator('[data-testid="message-ai-more-button"]');
    await moreButton.click();
    await page.waitForTimeout(300);

    const deleteButton = assistantMessage.locator('[data-testid="message-ai-delete-button"]');
    await expect(deleteButton).toBeVisible();

    // Deleting an assistant message removes only that message (no confirmation dialog).
    await deleteButton.click();

    // The AI response must be gone; the user message stays.
    await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveCount(0, {
      timeout: 10000,
    });
    await expect(page.locator('[data-testid="chat-message"][data-role="user"]')).toHaveCount(1);
  });

  test('token metrics popover shows real data', async ({ page }) => {
    await sendMessageAndWait(page, 'Hello, tell me something interesting.');

    const assistantMessage = page.locator('[data-testid="chat-message"][data-role="assistant"]').first();
    const moreButton = assistantMessage.locator('[data-testid="message-ai-more-button"]');
    await moreButton.click();
    await page.waitForTimeout(300);

    const tokenMetricsButton = assistantMessage.locator('[data-testid="message-token-metrics-button"]');
    await tokenMetricsButton.click();

    // Wait for popover to appear and metrics to load (API call)
    const popoverContent = page.locator('[data-radix-popper-content-wrapper]');
    await expect(popoverContent).toBeVisible({ timeout: 5000 });

    // Wait for loading spinner to disappear (metrics API call completes)
    await page.waitForFunction(
      () => {
        const popover = document.querySelector('[data-radix-popper-content-wrapper]');
        if (!popover) return false;
        const text = popover.textContent || '';
        // Wait until loading is done - content should show real data or error
        return !text.includes('Loading');
      },
      { timeout: 15000 },
    );

    const popoverText = await popoverContent.innerText();
    console.log(`  Token metrics popover content: "${popoverText.replace(/\n/g, ' | ')}"`);

    // Verify real token metrics data is present
    // New compact design shows: model name, Output/Total token counts, latency, tok/s
    const hasModelInfo = popoverText.includes('gpt-') || popoverText.includes('llama') || popoverText.includes('claude');
    const hasOutputTokens = (popoverText.includes('Output') || popoverText.includes('Izlaz'));
    const hasTotalTokens = (popoverText.includes('Total') || popoverText.includes('Ukupno'));
    const hasPerformance = popoverText.includes('tok/s') || popoverText.includes('ms') || popoverText.includes('s');

    const hasNoMetrics =
      popoverText.includes('No metrics') ||
      popoverText.includes('Nema metrika') ||
      popoverText.includes('Failed');

    // Real metrics MUST be present - "No metrics" means the pipeline is broken
    expect(hasOutputTokens || hasTotalTokens).toBeTruthy();
    expect(hasModelInfo).toBeTruthy();
    expect(hasNoMetrics).toBeFalsy();
  });

  test('copy button copies message to clipboard', async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await sendMessageAndWait(page, 'Hello clipboard test.');

    const userMessage = page.locator('[data-testid="chat-message"][data-role="user"]').first();
    const copyButton = userMessage.locator('[data-testid="message-copy-button"]');
    await copyButton.click();
    await page.waitForTimeout(500);

    // Verify a toast notification appeared after copy
    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible({ timeout: 5000 });
  });

  test('streaming delivers tokens incrementally (not batched)', async ({ page }) => {
    // Intercept the chat streaming request to count NDJSON chunks
    const ndjsonChunks: string[] = [];

    // Listen for the chat API response and capture raw response chunks
    page.on('response', async (response) => {
      if (response.url().includes('/chat') && response.request().method() === 'POST') {
        try {
          const body = await response.body();
          const text = body.toString('utf-8');
          // Each NDJSON line is a separate packet
          const lines = text.split('\n').filter((l: string) => l.trim());
          ndjsonChunks.push(...lines);
        } catch {
          // Response body may not be available for streaming responses
        }
      }
    });

    // Alternative: count how many times the assistant message text changes during streaming
    // This directly proves token-by-token delivery to the UI
    let textChangeCount = 0;
    let lastText = '';

    // Start observing the DOM before sending the message
    await page.evaluate(() => {
      (window as any).__streamingUpdates = 0;
      (window as any).__lastContent = '';

      const observer = new MutationObserver(() => {
        const assistantMsg = document.querySelector('[data-testid="chat-message"][data-role="assistant"]');
        if (assistantMsg) {
          const currentText = assistantMsg.textContent || '';
          if (currentText !== (window as any).__lastContent && currentText.length > 0) {
            (window as any).__streamingUpdates++;
            (window as any).__lastContent = currentText;
          }
        }
      });

      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      (window as any).__streamObserver = observer;
    });

    // Send a message that requires a multi-token response
    const chatInput = page.locator('[data-testid="chat-input"]');
    await chatInput.fill('Write a short paragraph about the importance of water.');
    await page.waitForTimeout(300);
    const sendButton = page.locator('[data-testid="chat-send-button"]');
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="chat-send-button"]');
        return btn && !btn.hasAttribute('disabled');
      },
      { timeout: 10000 },
    );
    await sendButton.click();

    // Wait for streaming to complete
    await expect(page.locator('[data-testid="chat-input"]')).not.toBeDisabled({ timeout: 120000 });
    await page.waitForTimeout(1000);

    // Get the count of DOM updates during streaming
    textChangeCount = await page.evaluate(() => {
      const observer = (window as any).__streamObserver;
      if (observer) observer.disconnect();
      return (window as any).__streamingUpdates || 0;
    });

    // Token-by-token streaming should produce multiple DOM updates
    // A batched response would produce only 1-2 updates (message appears all at once)
    // A properly streaming response produces many updates (one per token or small group)
    console.log(`  Streaming DOM updates: ${textChangeCount}`);
    expect(textChangeCount).toBeGreaterThanOrEqual(5);
  });

  test('continue generation sends a follow-up message', async ({ page }) => {
    await sendMessageAndWait(page, 'Hello, tell me a short story.');

    const assistantMessage = page.locator('[data-testid="chat-message"][data-role="assistant"]').first();
    const continueButton = assistantMessage.locator('[data-testid="message-continue-button"]');
    await continueButton.click();

    // Wait for new message to be sent (chat input should become disabled briefly)
    await page.waitForTimeout(2000);

    // Should have more messages now (the continue prompt + new response)
    const allMessages = page.locator('[data-testid="chat-message"]');
    const count = await allMessages.count();
    expect(count).toBeGreaterThanOrEqual(3); // user + assistant + continue prompt (at minimum)
  });
});
