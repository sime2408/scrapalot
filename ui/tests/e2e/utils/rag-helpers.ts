import { Page, expect } from '@playwright/test';

/**
 * Shared RAG test helpers.
 *
 * Consolidates common patterns used across rag-chat.spec.ts, rag-quality.spec.ts,
 * and graph-rag.spec.ts to eliminate code duplication.
 */

/**
 * Start a new conversation. Clicks "New Conversation" link if visible.
 */
export async function startNewConversation(page: Page): Promise<void> {
  const newConversationLink = page.locator('text=New Conversation').first();
  await newConversationLink.waitFor({ state: 'visible', timeout: 5000 });
  await newConversationLink.click();
  await page.waitForTimeout(1000);
}

/**
 * Select Scrapalot AI model from the model selector dropdown.
 * Falls back gracefully if the model is not available.
 */
export async function selectScrapalotModel(page: Page): Promise<void> {
  const modelSelector = page.locator('[data-testid="model-selector"]');
  await modelSelector.waitFor({ state: 'visible', timeout: 10000 });
  await modelSelector.click();
  await page.waitForTimeout(500);

  const scrapalotOption = page.locator('[role="option"]').filter({ hasText: 'Scrapalot AI' }).first();
  await scrapalotOption.waitFor({ state: 'visible', timeout: 5000 });
  await scrapalotOption.click();
  await page.waitForTimeout(1000);
}

/**
 * Select a collection from the collection selector.
 * Tries enabled checkboxes first, then falls back to force-clicking.
 *
 * @param collectionName - Optional specific collection name to select
 * @returns true if a collection was selected
 */
export async function selectCollection(page: Page, collectionName?: string): Promise<boolean> {
  const collectionButton = page.locator('[data-testid="collection-selector"]');
  await collectionButton.waitFor({ state: 'visible', timeout: 5000 });
  await collectionButton.click();

  // Wait for popover content to appear
  await page.waitForTimeout(1500);

  // Disable agentic routing if it's ON (it disables collection checkboxes)
  const agenticSwitch = page.locator('#use-agentic-routing-popover');
  const agenticVisible = await agenticSwitch.isVisible({ timeout: 3000 });
  if (agenticVisible) {
    const isChecked = await agenticSwitch.getAttribute('data-state');
    if (isChecked === 'checked') {
      await agenticSwitch.click();
      await page.waitForTimeout(1000);
    }
  }

  // Wait for checkboxes to appear and become enabled
  const checkboxes = page.locator('[role="checkbox"]');
  await checkboxes.first().waitFor({ state: 'visible', timeout: 10000 });

  await page.waitForTimeout(500);
  const checkboxCount = await checkboxes.count();
  let selected = false;

  // Helper: click checkbox and verify it becomes checked
  async function clickAndVerify(checkbox: ReturnType<typeof checkboxes.nth>): Promise<boolean> {
    const stateBefore = await checkbox.getAttribute('data-state');
    if (stateBefore === 'checked') return true; // Already selected
    await checkbox.click({ timeout: 3000 });
    await page.waitForTimeout(300);
    const stateAfter = await checkbox.getAttribute('data-state');
    return stateAfter === 'checked';
  }

  // Try to find specific collection by name
  if (collectionName && checkboxCount > 0) {
    for (let i = 0; i < Math.min(checkboxCount, 10); i++) {
      const checkbox = checkboxes.nth(i);
      const parent = checkbox.locator('..');
      const parentText = await parent.textContent() ?? '';
      if (parentText && parentText.toLowerCase().includes(collectionName.toLowerCase())) {
        const isDisabled = await checkbox.getAttribute('data-disabled');
        if (isDisabled === null) {
          selected = await clickAndVerify(checkbox);
          if (selected) break;
        }
      }
    }
  }

  // Fallback: select first enabled checkbox
  if (!selected && checkboxCount > 0) {
    for (let i = 0; i < Math.min(checkboxCount, 5); i++) {
      const checkbox = checkboxes.nth(i);
      const isDisabled = await checkbox.getAttribute('data-disabled');
      const ariaDisabled = await checkbox.getAttribute('aria-disabled');
      if (isDisabled === null && ariaDisabled !== 'true') {
        selected = await clickAndVerify(checkbox);
        if (selected) break;
      }
    }
  }

  // Force-click fallback for disabled collections (may have embeddings but no computed state)
  if (!selected && checkboxCount > 0) {
    await checkboxes.first().click({ force: true, timeout: 3000 });
    await page.waitForTimeout(300);
    selected = true;
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  return selected;
}

/**
 * Send a message via the chat input and wait for the response to complete.
 *
 * @param page - Playwright page
 * @param query - The message to send
 * @param timeout - Max wait time for response (default: 120s)
 * @returns The assistant response text
 */
export async function sendMessageAndWait(
  page: Page,
  query: string,
  timeout = 120000,
): Promise<string> {
  const chatInput = page.locator('[data-testid="chat-input"]');
  await chatInput.waitFor({ state: 'visible', timeout: 10000 });
  await chatInput.fill(query);
  await page.waitForTimeout(500);

  const sendButton = page.locator('[data-testid="chat-send-button"]');
  await sendButton.waitFor({ state: 'visible', timeout: 5000 });

  // Wait for send button to be enabled
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="chat-send-button"]');
      return btn && !btn.hasAttribute('disabled');
    },
    { timeout: 10000 },
  );

  await sendButton.click();

  // Wait for streaming to complete (chat input becomes enabled)
  const chatInputForWait = page.locator('[data-testid="chat-input"]');
  await expect(chatInputForWait).not.toBeDisabled({ timeout });
  await page.waitForTimeout(2000);

  // Get assistant response
  const assistantMessage = page.locator('[data-testid="chat-message"][data-role="assistant"]').first();
  await expect(assistantMessage).toBeVisible({ timeout: 30000 });
  return await assistantMessage.innerText();
}

/**
 * Complete RAG query flow: start conversation, select model, select collection, send query.
 *
 * @param page - Playwright page
 * @param query - The RAG query to send
 * @param collectionName - Optional specific collection name
 * @returns The assistant response text
 */
export async function sendRagQuery(
  page: Page,
  query: string,
  collectionName?: string,
): Promise<string> {
  await startNewConversation(page);
  await selectScrapalotModel(page);
  await selectCollection(page, collectionName);
  return await sendMessageAndWait(page, query);
}

/**
 * Send a RAG query and retry once if the response indicates no context was retrieved.
 * Useful for tests that depend on RAG returning results (citations, entity awareness).
 *
 * @param page - Playwright page
 * @param query - The RAG query to send
 * @param collectionName - Optional specific collection name
 * @param maxAttempts - Number of attempts (default: 2)
 * @returns The assistant response text
 */
export async function sendRagQueryWithRetry(
  page: Page,
  query: string,
  collectionName?: string,
  maxAttempts = 2,
): Promise<string> {
  const noContextIndicators = [
    'do not contain any specific information',
    'no relevant information',
    'no documents found',
    "i don't have access to",
    'no specific content',
    'cannot find any relevant',
    'currently empty',
    "don't have specific information",
    'no context available',
    'no information to summarize',
  ];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const responseText = await sendRagQuery(page, query, collectionName);

    const hasNoContext = noContextIndicators.some(indicator =>
      responseText.toLowerCase().includes(indicator),
    );

    if (!hasNoContext || attempt === maxAttempts) {
      return responseText;
    }

    console.log(`  Attempt ${attempt}: RAG returned no context, retrying...`);
    await page.waitForTimeout(2000);
  }

  // Unreachable, but TypeScript needs it
  return '';
}

/**
 * Assert that a response is substantive (not empty, not an error, not a dodge).
 */
export function assertSubstantiveResponse(responseText: string, minLength = 100): void {
  // Length check
  expect(responseText.length).toBeGreaterThan(minLength);

  // Not an error message
  const errorIndicators = ['error occurred', 'unable to process', 'something went wrong', 'i cannot'];
  const hasError = errorIndicators.some(indicator =>
    responseText.toLowerCase().includes(indicator),
  );
  expect(hasError).toBe(false);
}

/**
 * Assert that a response contains at least one of the expected keywords.
 */
export function assertContainsKeywords(
  responseText: string,
  keywords: string[],
  minMatches = 1,
): void {
  const lowerText = responseText.toLowerCase();
  const matched = keywords.filter(kw => lowerText.includes(kw.toLowerCase()));
  expect(matched.length).toBeGreaterThanOrEqual(minMatches);
}

/**
 * Wait for the citations section to appear on the assistant message.
 * Returns the number of citation items found.
 *
 * @param page - Playwright page
 * @param timeout - Max wait time for citations section (default: 15s)
 * @returns Number of citation items
 */
export async function waitForCitations(page: Page, timeout = 15000): Promise<number> {
  const citationsSection = page.locator('[data-testid="message-citations-section"]').first();
  await citationsSection.waitFor({ state: 'visible', timeout });

  // Expand citations by clicking the toggle button
  const toggleButton = page.locator('[data-testid="citations-toggle-button"]').first();
  await toggleButton.waitFor({ state: 'visible', timeout: 5000 });
  await toggleButton.click();
  await page.waitForTimeout(1000);

  const citationItems = page.locator('[data-testid^="citation-item-"]');
  return await citationItems.count();
}

/**
 * Get citation item details (title text and index).
 *
 * @param page - Playwright page
 * @param index - Citation item index (0-based)
 * @returns Citation title text
 */
export async function getCitationText(page: Page, index: number): Promise<string> {
  const citationItem = page.locator(`[data-testid="citation-item-${index}"]`);
  await citationItem.waitFor({ state: 'visible', timeout: 5000 });
  return await citationItem.innerText();
}

/**
 * Set up route interception for document file requests.
 * The citation URLs from the backend point to endpoints that may not exist
 * (backend generates internal file paths as URLs). This intercepts those
 * requests and returns a minimal valid PDF so the viewer can open.
 *
 * Call this BEFORE clicking any citation.
 */
export async function mockDocumentFileRoutes(page: Page): Promise<void> {
  // Minimal valid PDF (1 page, blank)
  const minimalPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n' +
    '0000000058 00000 n \n0000000115 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF',
  );

  await page.route('**/documents/file/**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: minimalPdf,
    });
  });
}

/**
 * Click a citation item and verify the document viewer opens.
 * Returns the viewer type that opened ('pdf' | 'epub' | 'docx' | null).
 *
 * IMPORTANT: Call mockDocumentFileRoutes() before this function to prevent
 * 404 errors on document file endpoints (citation URLs use internal paths).
 *
 * @param page - Playwright page
 * @param index - Citation item index (0-based)
 * @returns Viewer type or null if no viewer opened
 */
export async function clickCitationAndVerifyViewer(
  page: Page,
  index: number,
): Promise<'pdf' | 'epub' | 'docx' | null> {
  const citationItem = page.locator(`[data-testid="citation-item-${index}"]`);
  await citationItem.waitFor({ state: 'visible', timeout: 5000 });

  // Click the button inside the citation item
  const citationButton = citationItem.locator('button').first();
  await citationButton.click();

  // Wait for viewer to appear (PDF loading may take a moment)
  const pdfViewer = page.locator('[data-testid="pdf-viewer-drawer"]');
  const epubViewer = page.locator('[data-testid="epub-viewer-drawer"]');
  const docxViewer = page.locator('[data-testid="docx-viewer-drawer"]');

  // Wait for any viewer to appear (up to 15s)
  const anyViewer = pdfViewer.or(epubViewer).or(docxViewer);
  await anyViewer.waitFor({ state: 'visible', timeout: 15000 });

  if (await pdfViewer.isVisible()) return 'pdf';
  if (await epubViewer.isVisible()) return 'epub';
  if (await docxViewer.isVisible()) return 'docx';
  return null;
}

/**
 * Enable agentic routing in the collection selector popover.
 * Opens the popover, checks the agentic routing switch, and closes it.
 */
export async function enableAgenticRouting(page: Page): Promise<void> {
  const collectionButton = page.locator('[data-testid="collection-selector"]');
  await collectionButton.waitFor({ state: 'visible', timeout: 5000 });
  await collectionButton.click();

  await page.waitForTimeout(1500);

  const agenticSwitch = page.locator('#use-agentic-routing-popover');
  await agenticSwitch.waitFor({ state: 'visible', timeout: 5000 });
  const isChecked = await agenticSwitch.getAttribute('data-state');
  if (isChecked !== 'checked') {
    await agenticSwitch.click();
    await page.waitForTimeout(1000);
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

/**
 * Complete agentic RAG query flow: start conversation, select model, enable agentic routing, send query.
 */
export async function sendAgenticRagQuery(
  page: Page,
  query: string,
  timeout = 180000,
): Promise<string> {
  await startNewConversation(page);
  await selectScrapalotModel(page);
  await enableAgenticRouting(page);
  return await sendMessageAndWait(page, query, timeout);
}

/**
 * Send an agentic RAG query with retry if no context was retrieved.
 */
export async function sendAgenticRagQueryWithRetry(
  page: Page,
  query: string,
  maxAttempts = 2,
  timeout = 180000,
): Promise<string> {
  const noContextIndicators = [
    'do not contain any specific information',
    'no relevant information',
    'no documents found',
    "i don't have access to",
    'no specific content',
    'cannot find any relevant',
    'currently empty',
    "don't have specific information",
    'no context available',
    'no information to summarize',
  ];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const responseText = await sendAgenticRagQuery(page, query, timeout);

    const hasNoContext = noContextIndicators.some(indicator =>
      responseText.toLowerCase().includes(indicator),
    );

    if (!hasNoContext || attempt === maxAttempts) {
      return responseText;
    }

    console.log(`  Attempt ${attempt}: Agentic RAG returned no context, retrying...`);
    await page.waitForTimeout(2000);
  }

  return '';
}

/**
 * Assert that a response contains contrast/comparison language.
 */
export function assertContainsContrastLanguage(responseText: string): void {
  const contrastWords = [
    'while', 'whereas', 'in contrast', 'however', 'differs',
    'unlike', 'compared to', 'both', 'similarly', 'on the other hand',
  ];
  const lowerText = responseText.toLowerCase();
  const matched = contrastWords.filter(w => lowerText.includes(w));
  expect(matched.length).toBeGreaterThanOrEqual(1);
}

/**
 * Assert response richness by checking length and sentence count.
 */
export function assertResponseRichness(
  responseText: string,
  minLength = 200,
  minSentences = 3,
): void {
  const sentenceCount = (responseText.match(/[.!?]\s/g) || []).length + 1;
  console.log(`  Response richness: ${responseText.length} chars, ${sentenceCount} sentences`);
  expect(responseText.length).toBeGreaterThan(minLength);
  expect(sentenceCount).toBeGreaterThanOrEqual(minSentences);
}

/**
 * Close the currently open document viewer.
 * X buttons were removed — viewers close via Escape (desktop) or mobile back.
 */
export async function closeDocumentViewer(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}
