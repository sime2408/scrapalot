import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';
import {
  sendRagQuery,
  sendRagQueryWithRetry,
  assertSubstantiveResponse,
  waitForCitations,
  getCitationText,
  clickCitationAndVerifyViewer,
  closeDocumentViewer,
  mockDocumentFileRoutes,
} from '../utils/rag-helpers';

/**
 * RAG Quality E2E Tests
 *
 * These tests verify the QUALITY of RAG responses, not just that the UI works.
 * They check that:
 * - Responses contain relevant content based on the collection
 * - Citations are present and functional (when LLM produces citation markers)
 * - Citation click opens the document viewer
 * - Response length is adequate (not truncated)
 * - Agentic RAG produces entity-aware responses
 *
 * Pipeline: UI -> Gateway (8080) -> Kotlin BE (8091) -> gRPC -> Python AI (8090)
 */
test.describe('RAG Quality', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('should return substantive RAG response with relevant content', async ({ page }) => {
    test.setTimeout(180000);

    console.log('Testing RAG response quality...\n');

    const responseText = await sendRagQueryWithRetry(
      page,
      'What are the main topics covered in these documents? Give a detailed summary.',
      'Integration Test',
    );

    console.log(`  Response length: ${responseText.length} chars`);
    console.log(`  First 200 chars: ${responseText.substring(0, 200)}...\n`);

    // Quality assertions
    assertSubstantiveResponse(responseText);

    // Multiple sentences check
    const sentenceCount = (responseText.match(/[.!?]\s/g) || []).length + 1;
    expect(sentenceCount).toBeGreaterThanOrEqual(2);
    console.log(`  Sentence count: ${sentenceCount}`);

    // Dodge detection
    const dodgeIndicators = ["i don't have access", 'no documents found', 'no relevant information'];
    const isDodge = dodgeIndicators.some(indicator =>
      responseText.toLowerCase().includes(indicator)
    );
    expect(isDodge).toBe(false);

    await page.screenshot({
      path: 'test-results/rag-quality-substantive.png',
      fullPage: true,
    });

    console.log('RAG quality test passed\n');
  });

  test('should display citations and open document viewer on click', async ({ page }) => {
    test.setTimeout(180000);

    console.log('Testing citations and viewer click...\n');

    // Use retry to handle cases where RAG returns empty context (VPS load, LLM non-determinism)
    const responseText = await sendRagQueryWithRetry(
      page,
      'What are the main topics covered in these documents? Provide a comprehensive overview with references.',
      'Integration Test',
    );

    console.log(`  Response length: ${responseText.length} chars`);
    assertSubstantiveResponse(responseText);

    // Wait for citation_info packets to be processed into message_metadata
    await page.waitForTimeout(5000);

    // Citations section must appear
    const citationsSection = page.locator('[data-testid="message-citations-section"]');
    await expect(citationsSection).toBeVisible({ timeout: 30000 });

    // Expand and verify citations
    const citationCount = await waitForCitations(page, 15000);
    console.log(`  Citations found: ${citationCount}`);
    expect(citationCount).toBeGreaterThanOrEqual(1);

    const firstCitationText = await getCitationText(page, 0);
    expect(firstCitationText.length).toBeGreaterThan(0);
    console.log(`  First citation: ${firstCitationText.substring(0, 100)}`);

    // Mock document file endpoints before clicking
    await mockDocumentFileRoutes(page);

    // Click first citation → viewer must open
    const viewerType = await clickCitationAndVerifyViewer(page, 0);
    console.log(`  Viewer opened: ${viewerType}`);
    expect(viewerType).not.toBeNull();

    await page.screenshot({
      path: 'test-results/rag-quality-citation-click.png',
      fullPage: true,
    });

    await closeDocumentViewer(page);

    console.log('Citations click test passed\n');
  });

  test('should return entity-aware response with agentic RAG', async ({ page }) => {
    test.setTimeout(180000);

    console.log('Testing agentic RAG entity-aware response...\n');

    const responseText = await sendRagQueryWithRetry(
      page,
      'Who are the key people mentioned in these documents and what concepts do they discuss?',
      'Integration Test',
    );

    console.log(`  Response length: ${responseText.length} chars`);

    // Should be substantive
    assertSubstantiveResponse(responseText);

    // Should mention people or concepts (entity awareness)
    const entityKeywords = [
      'sun tzu', 'author', 'strategist', 'general',
      'strategy', 'warfare', 'military', 'concept',
    ];
    const lowerText = responseText.toLowerCase();
    const matched = entityKeywords.filter(kw => lowerText.includes(kw));
    console.log(`  Entity keywords matched: ${matched.join(', ')}`);

    // At least some entity-related content
    expect(matched.length).toBeGreaterThanOrEqual(1);

    await page.screenshot({
      path: 'test-results/rag-quality-entity-aware.png',
      fullPage: true,
    });

    console.log('Agentic RAG entity-aware test passed\n');
  });
});
