import { test, expect, Page } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';
import { selectScrapalotModel, assertSubstantiveResponse } from '../utils/rag-helpers';

/**
 * Agentic Conversation Memory E2E Test
 *
 * Verifies a just-deployed fix to the AGENTIC chat path in scrapalot-chat
 * (commit dcc438f "fix(agentic): inject conversation history into agentic chat").
 *
 * THE BUG (fixed):
 *   The agentic RAG path (`process_agentic_rag`) never read `conversation_history`.
 *   Only the standard chat path built memory + summary via
 *   `_standardize_model_and_get_history`, which agentic bypassed. So a follow-up
 *   message in the SAME conversation got a reply like
 *     "I have no context from the previous conversation" /
 *     "nemam pristup prethodnom razgovoru".
 *
 * THE FIX (what this test proves through the LIVE UI):
 *   `build_conversation_memory()` is now shared by both paths; in the agentic
 *   path the prior summary + recent exchange are formatted and prepended to the
 *   generation prompt. A second-turn, context-dependent follow-up must now
 *   continue the topic instead of disclaiming "no context".
 *
 * TEST DATA:
 *   - workspace "books" (admin), collection "ufo" (Roswell books incl.
 *     "(2017) Donald R. Schmitt - Cover-Up at Roswell").
 *   - Agentic mode is the default chat mode (auto collection discovery).
 *
 * FLOW (one conversation, two turns):
 *   Turn 1: ask about the Roswell cover-up book (agentic).
 *   Turn 2 (SAME session): a context-dependent follow-up that names neither the
 *     book nor the author — "Nastavi — reci mi više o toj knjizi i autoru."
 *     It only makes sense if turn-1 context is remembered.
 *
 * PRIMARY assertions on turn 2 (strict):
 *   - NO "no context / no previous conversation" disclaimer.
 *   - On-topic: continues the Roswell / book / author thread.
 *
 * Pipeline: UI -> Gateway (8080) -> Kotlin BE (8091) -> gRPC -> Python AI (8090)
 *           Python: process_agentic_rag -> build_conversation_memory ->
 *                   prepend summary + recent exchange -> generate.
 */

const TURN_1_QUERY =
  'O čemu priča knjiga koja prikriva što se stvarno dogodilo u Roswellu?';

// Context-dependent follow-up: names neither the book nor the author, so it can
// ONLY be answered correctly if turn-1 context is remembered.
const TURN_2_QUERY = 'Nastavi — reci mi više o toj knjizi i autoru.';

/**
 * Disclaimer patterns that prove the agentic path LOST conversation context.
 * If turn 2 matches any of these, the fix is NOT working — that is a hard
 * failure and must NOT be retried away.
 */
const NO_CONTEXT_DISCLAIMER =
  /nemam (pristup|kontekst)|no context|previous conversation|prethodn(om|og) razgovor|ne mogu se sjetiti|don'?t have (access|context)/i;

/**
 * On-topic keywords proving turn 2 continued the Roswell / book / author thread.
 * gpt-4o-mini wording varies, so any one match is sufficient (case-insensitive).
 */
const TOPIC_KEYWORDS = [
  'roswell',
  'schmitt',
  'cover-up',
  'cover up',
  'knjig', // knjiga / knjizi / knjige
  'autor', // autor / autoru / autora
  '1947',
  'ufo',
  'vanzemaljc', // vanzemaljci / vanzemaljaca
];

function containsTopicKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return TOPIC_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Locale-agnostic "start new conversation".
 *
 * The admin user's UI runs in Croatian, so we use the stable sidebar testid
 * instead of matching English "New Conversation" text.
 */
async function startNewConversationLocaleAgnostic(page: Page): Promise<void> {
  const newConvButton = page
    .locator('[data-testid="sidebar-new-conversation-button"]')
    .first();
  await newConvButton.waitFor({ state: 'visible', timeout: 10000 });
  await newConvButton.click();
  await page.waitForTimeout(1000);
}

/**
 * Ensure agentic routing is ON (it is the default mode). If the app happens to
 * be in manual mode, the collection selector exposes a
 * `chat-switch-to-agentic-button`. No-op when already agentic.
 */
async function ensureAgenticMode(page: Page): Promise<void> {
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
 * Send a chat message and wait for the streaming response to truly complete,
 * then return the text of the assistant message at index `assistantIndex`
 * (0-based across the conversation). We assert by index — not `.last()` — so
 * each turn's text is read deterministically even while the next turn streams.
 *
 * The agentic path streams for a long time and does NOT reliably disable the
 * chat input. The send button toggles to a Stop (Square) icon while streaming
 * and back to a Send icon when done; we use that as the primary completion
 * signal, then wait for the target assistant message text to stabilize.
 *
 * @param expectedAssistantCount how many assistant messages must exist once
 *        this turn completes (1 after turn 1, 2 after turn 2).
 */
async function sendTurnAndWaitForCompletion(
  page: Page,
  query: string,
  expectedAssistantCount: number,
  timeout = 240000,
): Promise<string> {
  const assistantIndex = expectedAssistantCount - 1;

  const chatInput = page.locator('[data-testid="chat-input"]');
  await chatInput.waitFor({ state: 'visible', timeout: 15000 });
  await chatInput.fill(query);
  await page.waitForTimeout(500);

  const sendButton = page.locator('[data-testid="chat-send-button"]');
  await sendButton.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="chat-send-button"]');
      return btn && !btn.hasAttribute('disabled');
    },
    { timeout: 10000 },
  );
  await sendButton.click();

  // Streaming started: the send button shows a Stop (Square) icon. Wait until it
  // disappears (streaming finished) — the authoritative "complete" signal for
  // the agentic path.
  const stopIcon = sendButton.locator('svg.lucide-square, svg.lucide-Square');
  await stopIcon.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {
    // Completed extremely fast (or errored) — fall through to stabilization.
  });
  await stopIcon.waitFor({ state: 'hidden', timeout }).catch(() => {
    // Tolerate: fall through to content stabilization as a backstop.
  });

  // Wait until this turn's assistant bubble has mounted (the agentic path can
  // spend >60s "thinking" before the bubble appears).
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll(
        '[data-testid="chat-message"][data-role="assistant"]',
      ).length >= count,
    expectedAssistantCount,
    { timeout: 120000 },
  );

  const assistantMessage = page
    .locator('[data-testid="chat-message"][data-role="assistant"]')
    .nth(assistantIndex);
  await expect(assistantMessage).toBeVisible({ timeout: 90000 });

  // Wait for this assistant message text to stabilize (stop changing) for ~6s,
  // so we never capture a mid-stream snapshot.
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
 * Switch the active workspace to "books" via Settings -> Workspaces tab.
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

  const booksHeading = page
    .locator('[data-testid^="settings-workspace-item-"] h3', { hasText: 'books' })
    .first();
  await booksHeading.waitFor({ state: 'visible', timeout: 10000 });
  const booksItem = page
    .locator('[data-testid^="settings-workspace-item-"]')
    .filter({ has: page.locator('h3', { hasText: 'books' }) })
    .first();

  const isActive = await booksItem
    .locator('text=Active')
    .first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);

  if (!isActive) {
    console.log('  "books" not active — switching...');
    const actionsButton = booksItem.locator('button:has(svg)').last();
    await actionsButton.click({ force: true });
    await page.waitForTimeout(500);

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

  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  await expect(dialog).not.toBeVisible({ timeout: 10000 });
}

/**
 * Run ONE two-turn agentic conversation and return both responses + the final
 * message count. Used inside a retry loop that only re-runs to absorb topic
 * wording variance — the no-context disclaimer is asserted by the caller after
 * each attempt and is NEVER retried away.
 */
async function runTwoTurnConversation(page: Page): Promise<{
  turn1: string;
  turn2: string;
  userCount: number;
  assistantCount: number;
}> {
  // Start a NEW conversation ONCE. Both turns go in this SAME session.
  await startNewConversationLocaleAgnostic(page);
  await selectScrapalotModel(page);
  await ensureAgenticMode(page);

  // Turn 1.
  console.log('Turn 1 (agentic):');
  console.log(`  "${TURN_1_QUERY}"`);
  const turn1 = await sendTurnAndWaitForCompletion(page, TURN_1_QUERY, 1, 240000);
  console.log(`  Turn-1 response length: ${turn1.length} chars`);
  console.log(`  Turn-1 response (first 400): ${turn1.substring(0, 400)}\n`);

  // Turn 2 — SAME conversation, context-dependent follow-up.
  console.log('Turn 2 (SAME conversation, context-dependent follow-up):');
  console.log(`  "${TURN_2_QUERY}"`);
  const turn2 = await sendTurnAndWaitForCompletion(page, TURN_2_QUERY, 2, 240000);
  console.log(`  Turn-2 response length: ${turn2.length} chars`);
  console.log(`  Turn-2 response (first 600): ${turn2.substring(0, 600)}\n`);

  const userCount = await page
    .locator('[data-testid="chat-message"][data-role="user"]')
    .count();
  const assistantCount = await page
    .locator('[data-testid="chat-message"][data-role="assistant"]')
    .count();

  return { turn1, turn2, userCount, assistantCount };
}

test.describe('Agentic Conversation Memory', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('agentic chat remembers conversation history across turns', async ({ page }) => {
    // Two full agentic round-trips per attempt; retry once for topic variance.
    test.setTimeout(300000);

    console.log('Agentic conversation memory test\n');

    // Step 1: make "books" the active workspace.
    await ensureBooksWorkspaceActive(page);

    // Step 2: run the two-turn conversation, retrying ONLY for topic-continuation
    // wording variance. The no-context disclaimer is a hard failure, asserted
    // every attempt and never retried away.
    const maxAttempts = 2;
    let result: Awaited<ReturnType<typeof runTwoTurnConversation>> | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`=== Attempt ${attempt}/${maxAttempts} ===\n`);
      result = await runTwoTurnConversation(page);

      // Screenshot proof of both turns in this attempt.
      await page.screenshot({
        path: `test-results/agentic-conversation-memory-attempt${attempt}.png`,
        fullPage: true,
      });

      // --- Conversation integrity: 4 messages in ONE session ---
      // (turn-1 user, turn-1 assistant, turn-2 user, turn-2 assistant)
      console.log(
        `  Message counts — user: ${result.userCount}, assistant: ${result.assistantCount}`,
      );
      expect(
        result.userCount,
        'Both turns must be in the SAME conversation: expected 2 user messages',
      ).toBe(2);
      expect(
        result.assistantCount,
        'Both turns must be in the SAME conversation: expected 2 assistant messages',
      ).toBe(2);

      // --- Turn 1 sanity: substantive + mentions Roswell ---
      assertSubstantiveResponse(result.turn1, 50);
      expect(
        result.turn1.toLowerCase().includes('roswell'),
        'Turn-1 response must mention Roswell (establishes the topic in this session)',
      ).toBe(true);

      // --- PRIMARY assertion #1 (STRICT, never retried): no "no context" disclaimer ---
      const turn2Disclaimer = result.turn2.match(NO_CONTEXT_DISCLAIMER);
      if (turn2Disclaimer) {
        console.log(
          '  HARD FAILURE: turn-2 response contains a "no context" disclaimer.',
        );
        console.log(`  Matched: "${turn2Disclaimer[0]}"`);
        console.log(`  Full turn-2 response:\n${result.turn2}\n`);
      }
      expect(
        turn2Disclaimer,
        'Turn-2 response must NOT claim it has no context / no previous conversation ' +
          '(this is the exact bug the fix addresses — agentic must remember prior turns). ' +
          `Actual turn-2 response: "${result.turn2.substring(0, 600)}"`,
      ).toBeNull();

      // --- PRIMARY assertion #2 (topic continuation, retryable for wording) ---
      assertSubstantiveResponse(result.turn2, 50);
      if (containsTopicKeyword(result.turn2)) {
        console.log('  PASS: turn-2 continued the topic with context.\n');
        break;
      }

      if (attempt < maxAttempts) {
        console.log(
          '  Turn-2 had no on-topic keyword (wording variance) — retrying conversation...\n',
        );
        await page.waitForTimeout(2000);
      }
    }

    // Final strict topic-continuation assertion on the last attempt's turn 2.
    expect(result, 'conversation must have run at least once').not.toBeNull();
    const finalTurn2 = result!.turn2;
    expect(
      containsTopicKeyword(finalTurn2),
      'Turn-2 response must stay on the Roswell/book/author topic — one of ' +
        `[${TOPIC_KEYWORDS.join(', ')}] (proves it continued with context). ` +
        `Actual turn-2 response: "${finalTurn2.substring(0, 600)}"`,
    ).toBe(true);

    console.log('\nRESULT: Turn 2 continued the topic WITH context (no disclaimer).');
    console.log('Screenshots: test-results/agentic-conversation-memory-attempt*.png');
  });
});
