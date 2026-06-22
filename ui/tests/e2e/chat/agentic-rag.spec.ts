import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';
import {
  sendAgenticRagQuery,
  sendAgenticRagQueryWithRetry,
  assertSubstantiveResponse,
  assertContainsKeywords,
  assertResponseRichness,
} from '../utils/rag-helpers';

/**
 * Agentic RAG E2E Tests
 *
 * Tests agentic routing mode where the AI agent dynamically selects collections,
 * retrieval strategies, and decides whether to use document context or answer directly.
 *
 * All tests enable agentic routing (no manual collection selection).
 *
 * Pipeline: UI -> Gateway (8080) -> Kotlin BE (8091) -> gRPC -> Python AI (8090)
 *           Python: agentic_routing.py -> strategy_router -> tools -> LLM generation
 */
test.describe('Agentic RAG', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('should discover collections and return document-based response', async ({ page }) => {
    test.setTimeout(240000);

    console.log('Testing agentic collection discovery...\n');

    const responseText = await sendAgenticRagQueryWithRetry(
      page,
      'What are the main strategic themes in the Art of War by Sun Tzu?',
      3,
      240000,
    );

    console.log(`  Response length: ${responseText.length} chars`);
    console.log(`  First 300 chars: ${responseText.substring(0, 300)}...\n`);

    assertSubstantiveResponse(responseText);

    assertContainsKeywords(responseText, [
      'art of war', 'sun tzu', 'strategy', 'warfare', 'military',
      'deception', 'enemy', 'war', 'tactics',
    ], 2);

    await page.screenshot({
      path: 'test-results/agentic-rag-collection-discovery.png',
      fullPage: true,
    });

    console.log('Agentic collection discovery test passed\n');
  });

  test('should include citations in agentic document mode', async ({ page }) => {
    test.setTimeout(240000);

    console.log('Testing agentic RAG citations...\n');

    const responseText = await sendAgenticRagQueryWithRetry(
      page,
      'Explain strategic planning as described in these documents.',
      2,
      240000,
    );

    console.log(`  Response length: ${responseText.length} chars`);

    assertSubstantiveResponse(responseText);

    // Check for citations section - agentic RAG with document query must produce citations
    await page.waitForTimeout(5000);
    const citationsSection = page.locator('[data-testid="message-citations-section"]');
    await expect(citationsSection).toBeVisible({ timeout: 30000 });
    console.log('  Citations section found');

    await page.screenshot({
      path: 'test-results/agentic-rag-citations.png',
      fullPage: true,
    });

    console.log('Agentic RAG citations test passed\n');
  });

  test('should produce entity-focused agentic response', async ({ page }) => {
    test.setTimeout(240000);

    console.log('Testing entity-focused agentic query...\n');

    const responseText = await sendAgenticRagQueryWithRetry(
      page,
      'Who is Sun Tzu and what are his key teachings?',
      2,
      240000,
    );

    console.log(`  Response length: ${responseText.length} chars`);

    assertContainsKeywords(responseText, [
      'sun tzu', 'strategy', 'military', 'war', 'art of war',
    ], 3);

    assertResponseRichness(responseText);

    await page.screenshot({
      path: 'test-results/agentic-rag-entity-focused.png',
      fullPage: true,
    });

    console.log('Entity-focused agentic test passed\n');
  });

  test('should answer general knowledge without injecting document content', async ({ page }) => {
    test.setTimeout(180000);

    console.log('Testing general knowledge routing...\n');

    const responseText = await sendAgenticRagQuery(
      page,
      'Explain the theory of general relativity in simple terms.',
      180000,
    );

    console.log(`  Response length: ${responseText.length} chars`);

    // Should contain physics-related content
    assertContainsKeywords(responseText, [
      'einstein', 'relativity', 'gravity', 'space', 'time',
    ], 2);

    // Should NOT inject unrelated document content
    const lowerText = responseText.toLowerCase();
    expect(lowerText).not.toContain('sun tzu');
    expect(lowerText).not.toContain('art of war');

    await page.screenshot({
      path: 'test-results/agentic-rag-general-knowledge.png',
      fullPage: true,
    });

    console.log('General knowledge routing test passed\n');
  });

  test('should handle complex queries without errors', async ({ page }) => {
    test.setTimeout(240000);

    console.log('Testing error resilience with complex query...\n');

    const responseText = await sendAgenticRagQuery(
      page,
      'Give me a detailed analysis comparing ancient military strategies with modern ones.',
      240000,
    );

    console.log(`  Response length: ${responseText.length} chars`);

    // Must produce a meaningful response
    assertSubstantiveResponse(responseText, 50);

    // Must not contain error messages
    const errorIndicators = [
      'error occurred',
      'unable to process',
      'something went wrong',
      'internal server error',
      'failed to',
    ];
    const lowerText = responseText.toLowerCase();
    const hasError = errorIndicators.some(indicator => lowerText.includes(indicator));
    expect(hasError).toBe(false);

    await page.screenshot({
      path: 'test-results/agentic-rag-error-resilience.png',
      fullPage: true,
    });

    console.log('Error resilience test passed\n');
  });
});
