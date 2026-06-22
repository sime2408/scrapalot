import { test, expect, Page } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Pin Session To Top — E2E
 *
 * Feature: a chat session can be pinned from its three-dots (⋮) menu. Pinned
 * sessions float to the TOP of their sidebar group (the unfiled list here),
 * independent of recency/marker ordering. A pin indicator shows on the row,
 * the menu label toggles Pin↔Unpin, and pin state persists server-side
 * (survives reload). The chosen UX is "float within own group" — NOT a
 * separate global Pinned section.
 *
 * Backend contract: PUT /api/v1/sessions/{id}/pin { is_pinned: boolean }.
 * Session objects carry is_pinned: boolean.
 *
 * data-testids (set in session-item.tsx / sessions-list.tsx):
 *   sidebar-session-item-${id}
 *   sidebar-session-options-trigger-${id}
 *   sidebar-session-menu-${id}
 *   sidebar-session-pin-${id}          (label toggles Pin to top / Unpin)
 *   sidebar-session-pin-indicator-${id}
 *   sidebar-sessions-list              (primary / unfiled list container)
 *   sidebar-new-conversation-button
 */

const ITEM_SELECTOR = '[data-testid^="sidebar-session-item-"]';

/** Read the ordered session ids currently rendered in the unfiled list. */
async function listSessionIds(page: Page): Promise<string[]> {
  return page.evaluate((sel) => {
    const list = document.querySelector('[data-testid="sidebar-sessions-list"]');
    if (!list) return [];
    const items = Array.from(list.querySelectorAll(sel));
    return items
      .map((el) => (el.getAttribute('data-testid') || '').replace('sidebar-session-item-', ''))
      .filter(Boolean);
  }, ITEM_SELECTOR);
}

/** Scroll the unfiled list back to the very top so index 0 is on screen. */
async function scrollListToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const list = document.querySelector('[data-testid="sidebar-sessions-list"]');
    if (list) list.scrollTop = 0;
  });
  await page.waitForTimeout(300);
}

/**
 * Open the ⋮ menu for a session and click its Pin/Unpin item, then wait for the
 * PUT /sessions/{id}/pin response so we assert against persisted server state,
 * not just the optimistic UI. Fails loudly if the backend rejects the call.
 */
async function togglePinViaMenu(
  page: Page,
  sessionId: string,
  expectPinned: boolean
): Promise<void> {
  const row = page.getByTestId(`sidebar-session-item-${sessionId}`);
  await row.scrollIntoViewIfNeeded();
  await page.getByTestId(`sidebar-session-options-trigger-${sessionId}`).click();

  const menu = page.getByTestId(`sidebar-session-menu-${sessionId}`);
  await expect(menu).toBeVisible({ timeout: 5000 });

  const pinItem = page.getByTestId(`sidebar-session-pin-${sessionId}`);
  await expect(pinItem).toBeVisible({ timeout: 5000 });
  await expect(pinItem).toHaveText(expectPinned ? /pin to top/i : /unpin/i);

  const pinResponse = page.waitForResponse(
    (res) =>
      res.url().includes(`/sessions/${sessionId}/pin`) &&
      res.request().method() === 'PUT',
    { timeout: 20000 }
  );
  await pinItem.click();
  const res = await pinResponse;
  expect(
    res.ok(),
    `PUT /sessions/${sessionId}/pin returned ${res.status()} (expected 2xx)`
  ).toBeTruthy();
}

/**
 * Create a fresh session by opening a new conversation and sending one message.
 * Returns once the AI response has actual content so the session row is real
 * and persisted (it gets a title + updated_at server-side).
 */
async function createSessionWithMessage(page: Page, prompt: string): Promise<void> {
  await page.getByTestId('sidebar-new-conversation-button').click();
  await page.waitForTimeout(1500);

  const chatInput = page.getByTestId('chat-input');
  await expect(chatInput).toBeVisible({ timeout: 15000 });
  await chatInput.click();
  await chatInput.fill(prompt);

  const sendButton = page.getByTestId('chat-send-button');
  await expect(sendButton).toBeEnabled({ timeout: 10000 });
  await sendButton.click();

  // Wait for the AI response to complete (real content, not the status line).
  await page.waitForFunction(
    () => {
      const msgs = document.querySelectorAll(
        '[data-testid="chat-message"][data-role="assistant"]'
      );
      if (msgs.length === 0) return false;
      const last = msgs[msgs.length - 1];
      const text = last.textContent || '';
      return text.length > 40 && !text.includes('Analyzing');
    },
    { timeout: 90000 }
  );

  // Let the sidebar refresh timer fire so the new session row materializes.
  await page.waitForTimeout(6000);
}

test.describe('Pin session to top', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    // `load`, not `networkidle`: the open STOMP/socket.io connection keeps the
    // network busy so it never goes idle (see BasePage.login's own comment).
    await page.waitForLoadState('load');
    await page.waitForTimeout(2000);
  });

  test('pin floats a non-top session to the top, persists, and unpins back', async ({
    page,
  }) => {
    test.setTimeout(300000);

    // Surface any uncaught page errors as test failures.
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Ensure the unfiled list exists and has at least 2 sessions ──────────
    const list = page.getByTestId('sidebar-sessions-list');
    await expect(list).toBeVisible({ timeout: 15000 });

    let ids = await listSessionIds(page);
    console.log(`Initial unfiled session count: ${ids.length}`);

    // Create sessions until we have at least 2 in the unfiled list.
    while (ids.length < 2) {
      const n = ids.length;
      await createSessionWithMessage(
        page,
        `Pin test seed #${n + 1}: reply with one short word. [${Date.now()}]`
      );
      ids = await listSessionIds(page);
      console.log(`After creating a session, unfiled count: ${ids.length}`);
    }

    // Scroll to the very top so the first two rows are on screen, then pick the
    // SECOND row as the target. It is a non-top session whose float to index 0
    // stays inside the rendered viewport (the list can hold 100+ sessions).
    await scrollListToTop(page);
    ids = await listSessionIds(page);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const topIdBefore = ids[0];
    const targetId = ids[1]; // second row → not the top, adjacent to it
    // Snapshot the pre-pin order of the other on-screen rows (target removed).
    // The invariant for unpin is: pinning then unpinning the target must NOT
    // reorder any of the OTHER sessions — their relative order is preserved and
    // the target simply drops out of the pinned tier. This is immune to the
    // target's own updated_at being bumped by the pin/reload flow (recency would
    // otherwise legitimately keep a freshly-touched target at the top).
    const otherIdsBefore = ids.filter(id => id !== targetId);
    console.log(`Top session before pin:  ${topIdBefore}`);
    console.log(`Target (2nd row) to pin: ${targetId}`);
    expect(targetId).not.toBe(topIdBefore);

    const targetRow = page.getByTestId(`sidebar-session-item-${targetId}`);
    await expect(targetRow).toBeVisible({ timeout: 10000 });

    // No pin indicator yet on the target row.
    await expect(
      page.getByTestId(`sidebar-session-pin-indicator-${targetId}`)
    ).toHaveCount(0);

    // ── (a) Pin the non-top session (menu → Pin to top), confirm PUT 2xx ────
    await togglePinViaMenu(page, targetId, /* expectPinned */ true);

    // Pinned session floats to the top of the unfiled list.
    await scrollListToTop(page);
    await expect(async () => {
      const orderedNow = await listSessionIds(page);
      expect(orderedNow[0]).toBe(targetId);
    }).toPass({ timeout: 10000 });

    // Pin indicator now shows on the row.
    await expect(
      page.getByTestId(`sidebar-session-pin-indicator-${targetId}`)
    ).toBeVisible({ timeout: 10000 });
    console.log('✓ (a) pinned session floated to top with indicator');

    // ── (b) The ⋮ menu now shows "Unpin" for that session ──────────────────
    const menu = page.getByTestId(`sidebar-session-menu-${targetId}`);
    const pinItem = page.getByTestId(`sidebar-session-pin-${targetId}`);
    await page.getByTestId(`sidebar-session-options-trigger-${targetId}`).click();
    await expect(menu).toBeVisible({ timeout: 5000 });
    await expect(pinItem).toBeVisible({ timeout: 5000 });
    await expect(pinItem).toHaveText(/unpin/i);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden({ timeout: 5000 });
    console.log('✓ (b) menu now offers Unpin');

    // ── (c) Reload — proves server-side persistence ─────────────────────────
    // Wait for `load` (DOM + assets), NOT `networkidle`: the app holds a STOMP /
    // socket.io connection open and reconnects, so the network never goes idle
    // and `networkidle` would hang. The sessions list becoming visible is the
    // real, deterministic readiness signal (matches BasePage.login's pattern).
    await page.reload({ waitUntil: 'load' });
    await expect(list).toBeVisible({ timeout: 30000 });
    // The list re-fetches sessions after reload; give the pinned-float effect a
    // moment to apply before we read the order.
    await expect(async () => {
      const reloaded = await listSessionIds(page);
      expect(reloaded.length).toBeGreaterThan(0);
    }).toPass({ timeout: 30000 });
    await scrollListToTop(page);

    await expect(async () => {
      const orderedAfterReload = await listSessionIds(page);
      expect(orderedAfterReload[0]).toBe(targetId);
    }).toPass({ timeout: 15000 });

    await expect(
      page.getByTestId(`sidebar-session-pin-indicator-${targetId}`)
    ).toBeVisible({ timeout: 10000 });
    console.log('✓ (c) pin survived reload (server-side persistence)');

    // ── (d) Unpin — indicator gone, no longer forced to the top ────────────
    await togglePinViaMenu(page, targetId, /* expectPinned */ false);

    // Indicator removed.
    await expect(
      page.getByTestId(`sidebar-session-pin-indicator-${targetId}`)
    ).toHaveCount(0, { timeout: 10000 });

    // No longer pin-floated: the pinned tier is gone, so the relative order of
    // the OTHER sessions is exactly what it was before the pin. We assert that
    // the on-screen rows minus the target preserve their pre-pin relative order
    // (a still-floated target would shift every other row down by one, breaking
    // this). topIdBefore must therefore precede every session that originally
    // sat below it. This proves "pin float removed" without depending on the
    // target's own (now-bumped) recency timestamp.
    await scrollListToTop(page);
    await expect(async () => {
      const orderedAfterUnpin = await listSessionIds(page);
      const otherIdsAfter = orderedAfterUnpin.filter(id => id !== targetId);
      // Restrict to the rows we snapshotted pre-pin so virtualization of the
      // long (138-row) list can't introduce rows we never observed.
      const observed = otherIdsAfter.filter(id => otherIdsBefore.includes(id));
      const expectedOrder = otherIdsBefore.filter(id => observed.includes(id));
      expect(observed).toEqual(expectedOrder);
      // topIdBefore is the original index-0 row; with the pin tier gone it must
      // lead the other (non-target) rows again.
      expect(observed[0]).toBe(topIdBefore);
    }).toPass({ timeout: 15000 });
    console.log('✓ (d) unpinned — indicator gone, pin float removed, order preserved');

    expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toHaveLength(0);
  });
});
