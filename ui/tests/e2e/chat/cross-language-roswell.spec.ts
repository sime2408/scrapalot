import { test, expect, Page } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';
import {
  selectScrapalotModel,
  assertSubstantiveResponse,
} from '../utils/rag-helpers';

/**
 * Cross-Lingual RAG Retrieval E2E Test (Roswell)
 *
 * Verifies a just-deployed fix to `translate_query_if_needed` in scrapalot-chat.
 * A dead `if llm is None: return` guard previously disabled the translate-then-retrieve
 * pipeline, so a Croatian query against an English/mixed document collection retrieved
 * the wrong book (Italian "Apocalisse Aliena") instead of the correct English book
 * ("Cover-Up at Roswell" by Donald R. Schmitt). With the guard removed, Croatian queries
 * are translated to English before embedding. Verified at the embedding level the target
 * book rose from retrieval rank 1849 -> rank 3.
 *
 * This test reproduces the original report through the LIVE UI:
 *   - workspace "books" (admin), collection "ufo" (~153 docs)
 *   - Croatian query about "the book that covers up what really happened at Roswell"
 *   - PRIMARY assertion: the response/citations name the Schmitt "Cover-Up at Roswell" book.
 *
 * Pipeline: UI -> Gateway (8080) -> Kotlin BE (8091) -> gRPC -> Python AI (8090)
 *           Python: agentic_routing -> translate_query_if_needed -> embed -> retrieve
 */

const CROATIAN_QUERY =
  'O čemu priča knjiga koja prikriva što se stvarno dogodilo u Roswellu?';

// The correct book that the corrected retrieval must surface.
const SCHMITT_KEYWORDS = ['schmitt', 'cover-up at roswell', 'cover up at roswell'];

/**
 * Strict assertion: the response text mentions the correct Schmitt book.
 * No tolerant fallbacks — a miss must fail the test.
 */
function assertNamesSchmittBook(responseText: string): boolean {
  const lower = responseText.toLowerCase();
  return SCHMITT_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Locale-agnostic "start new conversation".
 *
 * The shared rag-helpers `startNewConversation` matches the English text
 * "New Conversation", but the admin user's UI runs in Croatian. Use the
 * stable sidebar testid instead.
 */
async function startNewConversationLocaleAgnostic(page: Page): Promise<void> {
  const newConvButton = page.locator('[data-testid="sidebar-new-conversation-button"]').first();
  await newConvButton.waitFor({ state: 'visible', timeout: 10000 });
  await newConvButton.click();
  await page.waitForTimeout(1000);
}

/**
 * Send a chat message and wait for the streaming response to truly complete.
 *
 * The agentic/RAG path streams for a long time and, unlike a plain chat, does
 * NOT reliably disable the chat input — the send button instead toggles to a
 * Stop (Square) icon while streaming and back to a Send icon when done. We use
 * that as the primary completion signal, then additionally wait for the
 * assistant message text to stabilize (stop growing).
 *
 * @returns the final assistant message innerText
 */
async function sendAndWaitForCompletion(
  page: Page,
  query: string,
  timeout = 240000,
): Promise<string> {
  const chatInput = page.locator('[data-testid="chat-input"]');
  await chatInput.waitFor({ state: 'visible', timeout: 15000 });
  await chatInput.fill(query);
  await page.waitForTimeout(500);

  const sendButton = page.locator('[data-testid="chat-send-button"]');
  await sendButton.waitFor({ state: 'visible', timeout: 5000 });
  // Wait for send to be enabled (input non-empty).
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="chat-send-button"]');
      return btn && !btn.hasAttribute('disabled');
    },
    { timeout: 10000 },
  );
  await sendButton.click();

  // Streaming started: the send button shows a Stop (Square) icon.
  // Wait until that icon disappears (streaming finished) — this is the
  // authoritative "response complete" signal for the agentic path.
  const stopIcon = sendButton.locator('svg.lucide-square, svg.lucide-Square');
  // It may appear quickly; give it a moment to mount.
  await stopIcon.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {
    // If we never saw the stop icon, the request may have completed extremely
    // fast (or errored); fall through to content-stabilization below.
  });
  await stopIcon
    .waitFor({ state: 'hidden', timeout })
    .catch(() => {
      // Tolerate: fall through to content stabilization as a backstop.
    });

  // Locate the latest assistant message. The agentic path can spend >60s in a
  // "thinking" phase before the assistant bubble mounts, so allow a generous
  // window here.
  const assistantMessage = page
    .locator('[data-testid="chat-message"][data-role="assistant"]')
    .last();
  await expect(assistantMessage).toBeVisible({ timeout: 90000 });

  // Wait for the assistant text to stabilize (stop changing) for ~6s, so we
  // never capture a mid-stream snapshot.
  let last = '';
  let stableFor = 0;
  const pollStart = Date.now();
  while (Date.now() - pollStart < timeout) {
    const current = (await assistantMessage.innerText().catch(() => '')) || '';
    if (current.length > 0 && current === last) {
      stableFor += 1500;
      if (stableFor >= 6000) break;
    } else {
      stableFor = 0;
      last = current;
    }
    await page.waitForTimeout(1500);
  }

  await page.waitForTimeout(1000);
  return (await assistantMessage.innerText().catch(() => '')) || last;
}

/**
 * Ensure agentic routing is ON.
 *
 * Agentic routing is the default mode (the toolbar shows a BrainCircuit icon and,
 * when opened, an "AI routing active" popover with a "switch to manual" button).
 * If the app happens to be in manual mode, the collection selector exposes a
 * `chat-switch-to-agentic-button`. This helper switches to agentic if needed and
 * is a no-op when already agentic.
 */
async function ensureAgenticMode(page: Page): Promise<void> {
  // If the manual-mode "switch to agentic" button is reachable, click it.
  // Otherwise we're already in agentic mode (default).
  const collectionButton = page.locator('[data-testid="collection-selector"]');
  await collectionButton.waitFor({ state: 'visible', timeout: 10000 });
  await collectionButton.click();
  await page.waitForTimeout(1000);

  const switchToAgentic = page.locator('[data-testid="chat-switch-to-agentic-button"]');
  if (await switchToAgentic.isVisible({ timeout: 2000 }).catch(() => false)) {
    await switchToAgentic.click();
    await page.waitForTimeout(1000);
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

/**
 * Agentic-mode query flow (auto collection discovery), locale-agnostic.
 */
async function sendAgenticQuery(page: Page, query: string, timeout = 240000): Promise<string> {
  await startNewConversationLocaleAgnostic(page);
  await selectScrapalotModel(page);
  await ensureAgenticMode(page);
  return await sendAndWaitForCompletion(page, query, timeout);
}

/**
 * Explicit-collection (non-agentic / manual) query flow, locale-agnostic.
 *
 * Switches the collection selector to manual mode (if currently agentic), then
 * selects the named collection. `selectCollection` already disables agentic
 * routing via its in-popover switch when present, and selects the named
 * collection's checkbox.
 */
async function sendExplicitCollectionQuery(
  page: Page,
  query: string,
  collectionName: string,
  timeout = 240000,
): Promise<string> {
  await startNewConversationLocaleAgnostic(page);
  await selectScrapalotModel(page);

  const collectionButton = page.locator('[data-testid="collection-selector"]');
  await collectionButton.waitFor({ state: 'visible', timeout: 10000 });
  await collectionButton.click();
  await page.waitForTimeout(1000);

  // Step 1: leave agentic routing -> manual mode (exposes the collection list).
  const switchToManual = page.locator('[data-testid="chat-switch-to-manual-button"]');
  if (await switchToManual.isVisible({ timeout: 3000 }).catch(() => false)) {
    await switchToManual.click();
    await page.waitForTimeout(1500);
  }

  // The collection selector may have re-rendered/closed after switching modes.
  // Re-open it if necessary.
  const collectionsTab = page.locator('[data-testid="chat-collection-tab-collections"]');
  if (!(await collectionsTab.isVisible({ timeout: 2000 }).catch(() => false))) {
    // Re-open the selector.
    if (await collectionButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await collectionButton.click();
      await page.waitForTimeout(1000);
    }
  }

  // Step 2: navigate to the Collections tab (desktop tabbed layout).
  if (await collectionsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await collectionsTab.click();
    await page.waitForTimeout(800);
  }

  // Step 3: find the "ufo" collection by its visible label and check it.
  const ufoItem = page
    .locator('[data-testid^="chat-collection-item-"]')
    .filter({ has: page.locator(`label:text-is("${collectionName}")`) })
    .first();
  await ufoItem.waitFor({ state: 'visible', timeout: 10000 });
  const ufoCheckbox = ufoItem.locator('[data-testid^="chat-collection-checkbox-"]').first();
  const before = await ufoCheckbox.getAttribute('data-state');
  if (before !== 'checked') {
    await ufoCheckbox.click();
    await page.waitForTimeout(500);
  }
  const after = await ufoCheckbox.getAttribute('data-state');
  console.log(`  Explicit collection "${collectionName}" checkbox state: ${after}`);
  expect(after, `"${collectionName}" collection must be selected`).toBe('checked');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  return await sendAndWaitForCompletion(page, query, timeout);
}

/**
 * Switch the active workspace to "books" via Settings -> Workspaces tab.
 * The settings list renders one item per workspace; the active one shows an
 * "Active" badge. If "books" is not already active, open its actions menu
 * (MoreVertical) and click "Switch to".
 */
async function ensureBooksWorkspaceActive(page: Page): Promise<void> {
  const settingsButton = page.locator('[data-tour="settings-button"]');
  await settingsButton.waitFor({ state: 'visible', timeout: 15000 });
  await settingsButton.click();

  const dialog = page.locator('[data-testid="settings-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });

  // Navigate to Workspaces tab (settings renders both mobile + desktop tabs).
  const wsTabLocator = page.locator('[data-testid="settings-tab-workspaces"]');
  const wsTabCount = await wsTabLocator.count();
  let clickedTab = false;
  for (let i = 0; i < wsTabCount; i++) {
    if (await wsTabLocator.nth(i).isVisible({ timeout: 1000 }).catch(() => false)) {
      await wsTabLocator.nth(i).click();
      clickedTab = true;
      break;
    }
  }
  expect(clickedTab, 'Workspaces settings tab must be visible').toBe(true);
  await page.waitForTimeout(1500);

  const workspaceList = page.locator('[data-testid="settings-workspace-list"]');
  await workspaceList.waitFor({ state: 'visible', timeout: 15000 });

  // Find the "books" workspace card by its heading text (strict: it must exist).
  // The card renders an <h3> with the workspace name.
  const booksHeading = page
    .locator('[data-testid^="settings-workspace-item-"] h3', { hasText: 'books' })
    .first();
  await booksHeading.waitFor({ state: 'visible', timeout: 10000 });
  const booksItem = page
    .locator('[data-testid^="settings-workspace-item-"]')
    .filter({ has: page.locator('h3', { hasText: 'books' }) })
    .first();

  // If already active, the card shows an "Active" badge — nothing to do.
  const isActive = await booksItem
    .locator('text=Active')
    .first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);

  if (!isActive) {
    console.log('  "books" not active — switching...');
    // Open the per-workspace actions menu (MoreVertical button).
    const actionsButton = booksItem.locator('button:has(svg)').last();
    await actionsButton.click({ force: true });
    await page.waitForTimeout(500);

    // Click the "Switch to" menu item.
    const switchItem = page
      .locator('[role="menuitem"]')
      .filter({ hasText: /switch to/i })
      .first();
    await switchItem.waitFor({ state: 'visible', timeout: 5000 });
    await switchItem.click();
    await page.waitForTimeout(2500);
    console.log('  Switched active workspace to "books"');
  } else {
    console.log('  "books" workspace already active');
  }

  // Close settings dialog.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  // Ensure dialog is gone before continuing.
  await expect(dialog).not.toBeVisible({ timeout: 10000 });
}

/**
 * Read the citations on the latest assistant message (if a citations section exists).
 * Returns the concatenated citation text, or '' if no citations are rendered.
 */
async function readCitationsText(page: Page): Promise<string> {
  const citationsSection = page
    .locator('[data-testid="message-citations-section"]')
    .first();
  const hasCitations = await citationsSection
    .isVisible({ timeout: 8000 })
    .catch(() => false);
  if (!hasCitations) return '';

  // Try to expand the citations list.
  const toggle = page.locator('[data-testid="citations-toggle-button"]').first();
  if (await toggle.isVisible({ timeout: 3000 }).catch(() => false)) {
    await toggle.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  return (await citationsSection.innerText().catch(() => '')) || '';
}

test.describe('Cross-Lingual RAG (Roswell)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('Croatian Roswell query surfaces the Schmitt "Cover-Up at Roswell" book', async ({ page }) => {
    // Two full agentic/RAG round-trips (agentic + explicit fallback) can each
    // take ~60-90s of thinking, so allow a generous overall budget.
    test.setTimeout(420000);

    console.log('Cross-lingual Roswell retrieval test\n');

    // Step 1: make "books" the active workspace.
    await ensureBooksWorkspaceActive(page);

    // Step 2: send the Croatian query in AGENTIC mode (auto collection discovery),
    // reproducing the original bug report.
    console.log('Sending Croatian query (agentic mode):');
    console.log(`  "${CROATIAN_QUERY}"\n`);

    const agenticResponse = await sendAgenticQuery(page, CROATIAN_QUERY, 240000);

    const agenticCitations = await readCitationsText(page);

    console.log(`  Agentic response length: ${agenticResponse.length} chars`);
    console.log(`  Agentic response (first 500): ${agenticResponse.substring(0, 500)}\n`);
    if (agenticCitations) {
      console.log(`  Agentic citations (first 300): ${agenticCitations.substring(0, 300)}\n`);
    }

    assertSubstantiveResponse(agenticResponse, 50);

    const agenticHasSchmitt =
      assertNamesSchmittBook(agenticResponse) ||
      assertNamesSchmittBook(agenticCitations);

    // Screenshot proof of the agentic attempt.
    await page.screenshot({
      path: 'test-results/cross-language-roswell-agentic.png',
      fullPage: true,
    });

    if (agenticHasSchmitt) {
      console.log('  PASS via AGENTIC mode: response/citations name the Schmitt book\n');
      // Strict primary assertion against combined response + citations.
      const combined = `${agenticResponse}\n${agenticCitations}`;
      expect(assertNamesSchmittBook(combined)).toBe(true);
      return;
    }

    // Step 3 (fallback): agentic auto-discovery did NOT surface the Schmitt book.
    // Retry with the "ufo" collection explicitly selected in non-agentic mode.
    console.log('  Agentic mode did not name the Schmitt book — falling back to');
    console.log('  explicit "ufo" collection (non-agentic mode)...\n');

    const explicitResponse = await sendExplicitCollectionQuery(page, CROATIAN_QUERY, 'ufo', 240000);
    const explicitCitations = await readCitationsText(page);

    console.log(`  Explicit response length: ${explicitResponse.length} chars`);
    console.log(`  Explicit response (first 500): ${explicitResponse.substring(0, 500)}\n`);
    if (explicitCitations) {
      console.log(`  Explicit citations (first 300): ${explicitCitations.substring(0, 300)}\n`);
    }

    await page.screenshot({
      path: 'test-results/cross-language-roswell-explicit.png',
      fullPage: true,
    });

    assertSubstantiveResponse(explicitResponse, 50);

    const combinedExplicit = `${explicitResponse}\n${explicitCitations}`;
    const explicitHasSchmitt = assertNamesSchmittBook(combinedExplicit);

    if (explicitHasSchmitt) {
      console.log('  PASS via EXPLICIT "ufo" collection (non-agentic) mode\n');
    } else {
      console.log('  FAIL: neither agentic nor explicit mode named the Schmitt book.');
      console.log('  This is a real signal the cross-lingual fix is insufficient through the live path.\n');
    }

    // PRIMARY assertion (strict): the corrected retrieval must surface the right book
    // in at least one of the two modes.
    expect(
      explicitHasSchmitt,
      'Response/citations must reference "Schmitt" or "Cover-Up at Roswell" ' +
        '(proves cross-lingual retrieval surfaced the correct book)',
    ).toBe(true);
  });
});
