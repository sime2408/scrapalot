import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * AI Tutor Mode E2E Test (Curriculum Mode)
 *
 * Verifies the full tutor pipeline:
 *   UI toolbar (search menu → tutor toggle)
 *     → Gateway /v1/chat/completions
 *         { model, messages, scrapalot: { mode: "tutor", collection_ids: [<anthropology>] } }
 *     → Kotlin OpenAICompatibleService → ChatService.routeToGrpc → Python GenerateChatTutor
 *     → SSE chat.completion.chunk events back to chat UI
 *
 * Plus the tutor-progress-badge that appears when tutor mode is on
 * and exactly one collection is selected. The badge calls
 * GET /chat/tutor/progress and renders "Lesson N of 182 · <title> · <state>".
 *
 * Fixture: anthropology collection (5eeec701-511d-4f85-b8b5-6cbcd64e4467)
 * is pre-seeded with 182 Leiden communities + 182 tutor lessons.
 */

const ANTHROPOLOGY_COLLECTION_NAME = 'anthropology';

test.describe('AI Tutor Mode (curriculum)', () => {
  test.beforeEach(async ({ page }) => {
    // Tour must be disabled BEFORE navigation, per docs/README_E2E_TESTING.md.
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
      // Reset persisted tutor toggle so the test always starts from a known
      // "off" state — the toolbar persists this across page loads.
      localStorage.removeItem('scrapalot_chat_tutor_mode');
      localStorage.removeItem('scrapalot_chat_thought_partner_mode');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('tutor mode + 1 collection streams a tutor turn and shows progress badge', async ({ page }) => {
    test.setTimeout(180000);

    // Step 1: Open a new conversation. After login the workspace
    // page shows a sidebar list with "Start new conversation" CTA in
    // the empty state — click it so the chat surface mounts.
    const startNew = page.locator('button', { hasText: 'Start new conversation' }).first();
    if (await startNew.isVisible({ timeout: 3000 }).catch(() => false)) {
      await startNew.click();
    } else {
      // Fall back to the "New Conversation" sidebar entry.
      const newConv = page.locator('text="New Conversation"').first();
      await expect(newConv).toBeVisible({ timeout: 5000 });
      await newConv.click();
    }
    await page.waitForTimeout(1000);

    // Step 2: Chat input ready.
    const chatInput = page.locator('[data-testid="chat-input"]');
    await chatInput.waitFor({ state: 'visible', timeout: 15000 });

    // Step 3: Pick the system "Scrapalot AI" model so we hit the
    // gpt-4o-mini system provider (PRD rule for tests).
    const modelSelector = page.locator('[data-testid="model-selector"]');
    await expect(modelSelector).toBeVisible({ timeout: 5000 });
    await modelSelector.click();
    await page.waitForTimeout(500);

    const scrapalotOption = page
      .locator('[role="option"]')
      .filter({ hasText: 'Scrapalot AI' })
      .first();
    await expect(scrapalotOption).toBeVisible({ timeout: 5000 });
    await scrapalotOption.click();
    await page.waitForTimeout(800);

    // Step 4: Pick the anthropology collection (1 collection only —
    // tutor curriculum mode requires exactly one).
    //
    // Default UI mode is "AI Routing Active" (agenticRagEnabled=true)
    // which shows a stub popover with only a "Switch to Manual"
    // button — the real collection picker only renders after we
    // disable agentic routing. Click the manual switch first if
    // present.
    const collectionButton = page.locator('[data-testid="collection-selector"]').first();
    await expect(collectionButton).toBeVisible({ timeout: 5000 });
    await collectionButton.click();
    await page.waitForTimeout(800);

    const switchToManual = page.locator('[data-testid="chat-switch-to-manual-button"]');
    if (await switchToManual.isVisible({ timeout: 2000 }).catch(() => false)) {
      await switchToManual.click();
      await page.waitForTimeout(800);
      // Reopen the (now-manual) collection popover.
      await collectionButton.click();
      await page.waitForTimeout(800);
    }

    // Click the row label for the anthropology collection. We use
    // `force: true` because the checkbox wraps the row and Radix may
    // intercept pointer events on first paint.
    const anthropologyRow = page
      .locator('[data-testid^="chat-collection-item-"]')
      .filter({ hasText: ANTHROPOLOGY_COLLECTION_NAME })
      .first();
    await expect(anthropologyRow).toBeVisible({ timeout: 10000 });

    const checkbox = anthropologyRow.locator('[role="checkbox"]').first();
    await checkbox.click({ force: true, timeout: 5000 });
    await page.waitForTimeout(500);

    // Close the popover.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Step 5: Open the search menu and enable tutor mode.
    const searchMenuButton = page.locator('[data-testid="search-menu-button"]');
    await expect(searchMenuButton).toBeVisible({ timeout: 5000 });
    await searchMenuButton.click();
    await page.waitForTimeout(500);

    const tutorToggle = page.locator('[data-testid="chat-search-tutor-mode-button"]');
    await expect(tutorToggle).toBeVisible({ timeout: 5000 });
    await tutorToggle.click();
    await page.waitForTimeout(500);

    // Close the search menu.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Step 6: The tutor progress badge must appear once tutor mode
    // is on AND exactly 1 collection is selected. It polls
    // /chat/tutor/progress and renders curriculum status.
    const progressBadge = page.locator('[data-testid="tutor-progress-badge"]');
    await expect(progressBadge).toBeVisible({ timeout: 15000 });

    const badgeText = (await progressBadge.innerText()).trim();
    expect(badgeText.length).toBeGreaterThan(0);

    // Step 7: Send "Start the curriculum" — Kotlin routes to
    // GenerateChatTutor, the orchestrator state machine streams a
    // tutor turn back as message_delta tokens.
    await chatInput.fill('Start the curriculum');
    await page.waitForTimeout(300);

    const sendButton = page.locator('[data-testid="chat-send-button"]');
    await expect(sendButton).toBeVisible({ timeout: 5000 });
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="chat-send-button"]');
        return !!btn && !btn.hasAttribute('disabled');
      },
      { timeout: 10000 },
    );
    await sendButton.click();

    // Step 8: Wait for streaming to finish (chat input re-enables).
    await page.waitForTimeout(2000);
    await expect(chatInput).not.toBeDisabled({ timeout: 120000 });
    await page.waitForTimeout(1500);

    // Step 9: User message + assistant message must both be present.
    const messages = page.locator('[data-testid="chat-message"]');
    await expect(messages).toHaveCount(2, { timeout: 30000 });

    const assistantMessage = page
      .locator('[data-testid="chat-message"][data-role="assistant"]')
      .first();
    await expect(assistantMessage).toBeVisible();

    const responseText = (await assistantMessage.innerText()).trim();
    expect(responseText.length).toBeGreaterThan(20);
  });

  test('tutor progress badge surfaces lesson count + state for the seeded curriculum', async ({ page }) => {
    test.setTimeout(60000);

    // Open a new conversation (same pattern as the streaming test).
    const startNew = page.locator('button', { hasText: 'Start new conversation' }).first();
    if (await startNew.isVisible({ timeout: 3000 }).catch(() => false)) {
      await startNew.click();
    } else {
      const newConv = page.locator('text="New Conversation"').first();
      await expect(newConv).toBeVisible({ timeout: 5000 });
      await newConv.click();
    }
    await page.waitForTimeout(1000);

    const chatInput = page.locator('[data-testid="chat-input"]');
    await chatInput.waitFor({ state: 'visible', timeout: 15000 });

    // Pick anthropology so the 1-collection branch fires.
    const collectionButton = page.locator('[data-testid="collection-selector"]').first();
    await expect(collectionButton).toBeVisible({ timeout: 5000 });
    await collectionButton.click();
    await page.waitForTimeout(800);

    // Default mode is agentic routing — switch to manual to unlock
    // the real collection picker.
    const switchToManual = page.locator('[data-testid="chat-switch-to-manual-button"]');
    if (await switchToManual.isVisible({ timeout: 2000 }).catch(() => false)) {
      await switchToManual.click();
      await page.waitForTimeout(800);
      await collectionButton.click();
      await page.waitForTimeout(800);
    }

    const anthropologyRow = page
      .locator('[data-testid^="chat-collection-item-"]')
      .filter({ hasText: ANTHROPOLOGY_COLLECTION_NAME })
      .first();
    await expect(anthropologyRow).toBeVisible({ timeout: 10000 });
    const checkbox = anthropologyRow.locator('[role="checkbox"]').first();
    await checkbox.click({ force: true, timeout: 5000 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // Toggle tutor mode on.
    const searchMenuButton = page.locator('[data-testid="search-menu-button"]');
    await expect(searchMenuButton).toBeVisible({ timeout: 5000 });
    await searchMenuButton.click();
    await page.waitForTimeout(400);

    const tutorToggle = page.locator('[data-testid="chat-search-tutor-mode-button"]');
    await expect(tutorToggle).toBeVisible({ timeout: 5000 });
    await tutorToggle.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Badge must render with the seeded curriculum data.
    const progressBadge = page.locator('[data-testid="tutor-progress-badge"]');
    await expect(progressBadge).toBeVisible({ timeout: 15000 });

    // Once /chat/tutor/progress resolves, the badge contains
    // "Lesson 1 of 182" (i18n default in tutor-progress-badge.tsx).
    // We assert on the lesson count rather than the localized
    // wording so this holds for both en + hr translations.
    await expect(progressBadge).toContainText('182', { timeout: 15000 });

    // Lesson title for lesson_ord=0 in the seeded curriculum.
    // We check the badge has SOME title text after the lesson
    // counter — "·" separates counter from title in the component.
    await expect(progressBadge).toContainText('·', { timeout: 5000 });
  });
});
