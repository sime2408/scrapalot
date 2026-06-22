import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Chat history infinite-scroll pagination E2E.
 *
 * Regression for the stubbed-out pagination (hasMoreMessages hardcoded false,
 * empty load-more placeholder, dropped total_pages). Verifies the full flow:
 *  - opening a long session shows the NEWEST window first (not the oldest),
 *  - scrolling to the top auto-loads the next older page,
 *  - the viewport stays anchored (no yank to the bottom) when older history
 *    prepends.
 *
 * Seeds messages directly via the API so the read-side pagination is exercised
 * deterministically without 25 real LLM round-trips.
 */
test.describe('Chat history pagination', () => {
  const BASE_URL = 'http://localhost:8080/api/v1';
  // Must match `messagesPerPage` in use-conversations.tsx. 25 seeded messages →
  // newest 20 on open, remaining 5 after one load-more.
  const PER_PAGE = 20;
  const TOTAL_MESSAGES = 25;

  let authToken = '';
  let sessionId = '';

  // Zero-padded so substring matches stay unambiguous (e.g. "...01" vs "...10").
  const seedText = (n: number) => `Pagination seed message ${String(n).padStart(2, '0')}`;

  test.beforeEach(async ({ page, request }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    // Auth token for API seeding.
    const loginResponse = await request.post(`${BASE_URL}/auth/login`, {
      data: { usernameOrEmail: TEST_EMAIL, password: TEST_PASSWORD },
    });
    expect(loginResponse.ok()).toBeTruthy();
    authToken = (await loginResponse.json()).access_token;
    expect(authToken).toBeTruthy();

    // Fresh session.
    const sessionRes = await request.post(`${BASE_URL}/sessions`, {
      headers: { Authorization: `Bearer ${authToken}` },
      data: { conversation_name: 'pagination-e2e-session' },
    });
    expect(sessionRes.ok()).toBeTruthy();
    sessionId = (await sessionRes.json()).id;
    expect(sessionId).toBeTruthy();

    // Seed messages sequentially so createdAt is strictly increasing — message
    // 01 is the oldest, message 25 the newest.
    for (let i = 1; i <= TOTAL_MESSAGES; i++) {
      const res = await request.post(`${BASE_URL}/messages`, {
        headers: { Authorization: `Bearer ${authToken}` },
        data: {
          session_id: sessionId,
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: seedText(i),
        },
      });
      expect(res.ok()).toBeTruthy();
    }

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
  });

  test.afterEach(async ({ request }) => {
    if (sessionId) {
      await request
        .delete(`${BASE_URL}/sessions/${sessionId}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        })
        .catch(() => {});
      sessionId = '';
    }
  });

  test('opens on the newest window and loads older history on scroll up', async ({ page }) => {
    test.setTimeout(120000);

    // Open the seeded session directly.
    await page.goto(`/dashboard?session_id=${sessionId}`);
    const basePage = new BasePage(page);
    await basePage.waitForAppReady();

    const messages = page.getByTestId('chat-message');
    const scroll = page.getByTestId('chat-messages-scroll');

    // Step 1: initial load is exactly the newest page (not all 25, not the oldest).
    await expect(messages).toHaveCount(PER_PAGE, { timeout: 30000 });
    await expect(page.getByText(seedText(TOTAL_MESSAGES), { exact: true })).toBeVisible();
    // Newest window is messages 06..25; the oldest ones are NOT in the DOM yet.
    await expect(page.getByText(seedText(1), { exact: true })).toHaveCount(0);
    await expect(page.getByText(seedText(5), { exact: true })).toHaveCount(0);

    // Let the open-scroll settle (smooth scroll-to-bottom + re-pin window).
    await page.waitForTimeout(1500);

    // Step 1b: opening a paginated session must land at the BOTTOM (newest
    // message), not stick at the top. Regression guard: a spurious load-more
    // during the initial scroll-to-bottom used to strand the view at the first
    // message.
    await expect
      .poll(
        () => scroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
        { timeout: 10000 }
      )
      .toBeLessThan(80);

    // Step 2: scroll to the top → auto load-more fires.
    await scroll.evaluate((el) => { el.scrollTop = 0; });

    // Step 3: the older page is now appended above — all 25 are present.
    await expect(messages).toHaveCount(TOTAL_MESSAGES, { timeout: 20000 });
    await expect(page.getByText(seedText(1), { exact: true })).toBeVisible();

    // Step 4: the viewport stayed anchored near the top — it was NOT yanked to
    // the bottom when older history prepended.
    const atBottom = await scroll.evaluate(
      (el) => el.scrollHeight - el.clientHeight - el.scrollTop < 50
    );
    expect(atBottom).toBe(false);

    // Step 5: no further history → the trigger disarms (no extra page loads).
    await page.waitForTimeout(1000);
    await expect(messages).toHaveCount(TOTAL_MESSAGES);

    await page.screenshot({
      path: 'test-results/chat-pagination-success.png',
      fullPage: true,
    });
  });
});
