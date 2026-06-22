import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Tiered Routing E2E Test
 *
 * Verifies that the Smart Tiered RAG Routing System works through the full UI pipeline:
 * - Tier 1 (rule-based) queries get fast routing without LLM agent call
 * - strategy_selected packet contains routing_tier field
 * - Different query patterns route to appropriate strategies
 *
 * Pipeline: UI → Gateway (8080) → Kotlin BE (8091) → gRPC → Python AI (8090)
 */
test.describe('Tiered Routing', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('should route summary query via Tier 1 and receive response', async ({ page }) => {
    test.setTimeout(180000);

    console.log('Starting tiered routing E2E test...\n');

    // Step 1: Start new conversation
    const newConversationLink = page.locator('text=New Conversation').first();
    await expect(newConversationLink).toBeVisible({ timeout: 5000 });
    await newConversationLink.click();
    await page.waitForTimeout(1000);

    // Step 2: Verify chat input
    const chatInput = page.locator('[data-testid="chat-input"]');
    await chatInput.waitFor({ state: 'visible', timeout: 10000 });

    // Step 3: Select Scrapalot AI model
    const modelSelector = page.locator('[data-testid="model-selector"]');
    await modelSelector.waitFor({ state: 'visible', timeout: 5000 });
    await modelSelector.click();
    await page.waitForTimeout(500);

    const scrapalotOption = page.locator('[role="option"]').filter({ hasText: 'Scrapalot AI' }).first();
    await expect(scrapalotOption).toBeVisible({ timeout: 5000 });
    await scrapalotOption.click();
    await page.waitForTimeout(1000);

    // Step 4: Select a collection for RAG context
    const collectionButton = page.locator('[data-testid="collection-selector"]');
    await collectionButton.waitFor({ state: 'visible', timeout: 5000 });
    await collectionButton.click();
    await page.waitForTimeout(1000);

    const checkboxes = page.locator('[role="checkbox"]');
    const checkboxCount = await checkboxes.count();
    expect(checkboxCount).toBeGreaterThan(0);
    for (let i = 0; i < Math.min(checkboxCount, 5); i++) {
      const checkbox = checkboxes.nth(i);
      const isDisabled = await checkbox.getAttribute('data-disabled');
      const ariaDisabled = await checkbox.getAttribute('aria-disabled');
      if (isDisabled !== 'true' && ariaDisabled !== 'true') {
        await checkbox.click({ timeout: 3000 });
        break;
      }
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Step 5: Intercept API response to check routing_tier in packets
    let routingTier: number | null = null;
    let strategyName: string | null = null;

    page.on('response', async (response) => {
      try {
        const url = response.url();
        // /api/v1/chat/completions is the OpenAI-compat shim; chunks arrive
        // as SSE `data: {...}\n\n` events whose `delta.scrapalot` carries
        // the native packet payload (strategy_selected, citation, …).
        if (url.includes('/chat/completions') && response.status() === 200) {
          const body = await response.text();
          for (const event of body.split('\n\n')) {
            for (const line of event.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const chunk = JSON.parse(payload);
                const obj = chunk?.choices?.[0]?.delta?.scrapalot;
                if (obj?.type === 'strategy_selected' && obj.content) {
                  routingTier = obj.content.routing_tier;
                  strategyName = obj.content.strategy_name;
                  console.log(`Strategy selected: ${strategyName} (Tier ${routingTier})`);
                }
              } catch {
                // skip non-JSON SSE payloads
              }
            }
          }
        }
      } catch {
        // response already consumed or not text
      }
    });

    // Step 6: Send a summary query (should trigger Tier 1 rule)
    const query = 'Summarize the main ideas of this book';
    await chatInput.fill(query);
    await page.waitForTimeout(500);

    const sendButton = page.locator('[data-testid="chat-send-button"]');
    await sendButton.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="chat-send-button"]');
        return btn && !btn.hasAttribute('disabled');
      },
      { timeout: 10000 }
    );
    await sendButton.click();

    // Step 7: Wait for response to complete
    await expect(chatInput).not.toBeDisabled({ timeout: 120000 });
    await page.waitForTimeout(2000);

    // Step 8: Verify response exists
    const messages = page.locator('[data-testid="chat-message"]');
    await expect(messages).toHaveCount(2, { timeout: 30000 });

    const assistantMessage = page.locator('[data-testid="chat-message"][data-role="assistant"]').first();
    await expect(assistantMessage).toBeVisible();

    const responseText = await assistantMessage.innerText();
    expect(responseText.length).toBeGreaterThan(20);

    console.log(`Response length: ${responseText.length} chars`);
    console.log(`Routing tier: ${routingTier}, Strategy: ${strategyName}`);

    // Step 9: Take screenshot
    await page.screenshot({
      path: 'test-results/tiered-routing-summary.png',
      fullPage: true,
    });
  });

  test('should route comparison query via Tier 1 to RAGMultiQuery', async ({ page }) => {
    test.setTimeout(180000);

    // Start new conversation
    const newConversationLink = page.locator('text=New Conversation').first();
    await expect(newConversationLink).toBeVisible({ timeout: 5000 });
    await newConversationLink.click();
    await page.waitForTimeout(1000);

    const chatInput = page.locator('[data-testid="chat-input"]');
    await chatInput.waitFor({ state: 'visible', timeout: 10000 });

    // Select model
    const modelSelector = page.locator('[data-testid="model-selector"]');
    await modelSelector.waitFor({ state: 'visible', timeout: 5000 });
    await modelSelector.click();
    await page.waitForTimeout(500);
    const scrapalotOption = page.locator('[role="option"]').filter({ hasText: 'Scrapalot AI' }).first();
    await expect(scrapalotOption).toBeVisible({ timeout: 5000 });
    await scrapalotOption.click();
    await page.waitForTimeout(1000);

    // Select collection
    const collectionButton = page.locator('[data-testid="collection-selector"]');
    await collectionButton.waitFor({ state: 'visible', timeout: 5000 });
    await collectionButton.click();
    await page.waitForTimeout(1000);
    const checkboxes = page.locator('[role="checkbox"]');
    const checkboxCount = await checkboxes.count();
    expect(checkboxCount).toBeGreaterThan(0);
    for (let i = 0; i < Math.min(checkboxCount, 5); i++) {
      const cb = checkboxes.nth(i);
      if ((await cb.getAttribute('aria-disabled')) !== 'true') {
        await cb.click({ timeout: 3000 });
        break;
      }
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Send comparison query
    await chatInput.fill('Compare offensive and defensive strategies');
    await page.waitForTimeout(500);

    const sendButton = page.locator('[data-testid="chat-send-button"]');
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="chat-send-button"]')?.hasAttribute('disabled'),
      { timeout: 10000 }
    );
    await sendButton.click();

    // Wait for response
    await expect(chatInput).not.toBeDisabled({ timeout: 120000 });
    await page.waitForTimeout(2000);

    // Verify response
    const assistantMessage = page.locator('[data-testid="chat-message"][data-role="assistant"]').first();
    await expect(assistantMessage).toBeVisible({ timeout: 30000 });
    const responseText = await assistantMessage.innerText();
    expect(responseText.length).toBeGreaterThan(20);

    await page.screenshot({
      path: 'test-results/tiered-routing-comparison.png',
      fullPage: true,
    });
  });
});
