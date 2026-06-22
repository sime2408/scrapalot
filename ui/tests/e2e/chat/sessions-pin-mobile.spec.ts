import { test, expect, Page } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Pin Session From ⋮ Menu Does Not Collapse The Sidebar (MOBILE viewport) — E2E
 *
 * Regression guard for the mobile sidebar "click-outside" bug.
 *
 * THE BUG (now fixed): `sessions-sidebar-message.tsx` registers a
 *   document.addEventListener('mousedown', handleClickOutside)
 * that, at `window.innerWidth < 1080`, closes the sidebar whenever the mousedown
 * target sits OUTSIDE `sidebarRef`. A session row's ⋮ menu is a Radix
 * DropdownMenu PORTALED to document.body — i.e. structurally outside the sidebar
 * — so a mousedown on ANY menu item (Pin, Delete, Rename…) used to satisfy
 * "outside" and collapse the whole sidebar. Pinning closed the drawer.
 *
 * THE FIX: an `isInsidePortalLayer` guard
 *   target.closest('[data-radix-popper-content-wrapper],[data-radix-menu-content],[role="menu"],[role="dialog"]')
 * so menu/dialog interactions no longer count as an outside tap and the sidebar
 * stays open.
 *
 * WHY A NORMAL MOUSE CLICK REPRODUCES IT: the handler fires on `mousedown` (a
 * mouse event Playwright produces on a normal click) and is gated ONLY by
 * viewport width — no touch emulation required. At a sub-1080 viewport, a
 * `mousedown` on the portaled Pin item is the exact event the bug keyed on.
 * Pre-fix: clicking Pin collapses the sidebar (`[data-sidebar]` →
 * `-translate-x-full opacity-0 invisible`). Post-fix: it stays `translate-x-0`.
 *
 * The assertions in step 4 target precisely that collapse behaviour, so this
 * spec would FAIL against the pre-fix bundle (no `isInsidePortalLayer` guard →
 * mousedown closes the drawer) and PASS against the deployed fix.
 *
 * data-testids:
 *   [data-sidebar]                       sidebar drawer element
 *   sidebar-toggle-button                global open/close control ([data-global-sidebar-toggle])
 *   sidebar-sessions-list                unfiled sessions list
 *   sidebar-session-item-${id}           a session row
 *   sidebar-session-options-trigger-${id}  the ⋮ trigger on the row
 *   sidebar-session-menu-${id}           the portaled menu content
 *   sidebar-session-pin-${id}            the Pin / Unpin menu item
 *   sidebar-session-pin-indicator-${id}  the pin glyph on the row when pinned
 */

// Sub-1080 viewport: triggers the mobile/tablet "click-outside collapses
// sidebar" codepath (window.innerWidth < 1080 inside handleClickOutside) WITHOUT
// any touch emulation — a plain mouse click's mousedown is all that's needed.
test.use({ viewport: { width: 800, height: 1000 } });

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

/**
 * Read the live state of the sidebar drawer element directly from the DOM:
 * whether it exists/visible and its exact className (so we can assert on the
 * open/closed transform tokens, which is what the bug flips).
 */
async function readSidebarState(
  page: Page
): Promise<{ found: boolean; visible: boolean; className: string }> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-sidebar]') as HTMLElement | null;
    if (!el) return { found: false, visible: false, className: '' };
    const style = window.getComputedStyle(el);
    const visible =
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      parseFloat(style.opacity || '1') > 0;
    return { found: true, visible, className: el.className };
  });
}

/**
 * Open the mobile sidebar via the global toggle if it isn't already open.
 * At width 800 the sidebar context force-collapses (auto-collapse < 1200px), so
 * we must open it through the toggle, which flips `mobileMenuOpen` → the drawer
 * gets `translate-x-0 opacity-100 visible`.
 */
async function ensureSidebarOpen(page: Page): Promise<void> {
  const sidebar = page.locator('[data-sidebar]');
  const toggle = page.getByTestId('sidebar-toggle-button');
  await expect(toggle).toBeVisible({ timeout: 15000 });

  // closest open signal: the drawer carries `translate-x-0` and is visible.
  let state = await readSidebarState(page);
  if (!state.visible || !state.className.includes('translate-x-0')) {
    await toggle.click();
    await expect(async () => {
      const s = await readSidebarState(page);
      expect(s.found).toBeTruthy();
      expect(s.visible).toBeTruthy();
      expect(s.className).toContain('translate-x-0');
      expect(s.className).not.toContain('-translate-x-full');
    }).toPass({ timeout: 10000 });
  }
  await expect(sidebar).toBeVisible({ timeout: 10000 });
}

/**
 * Create a fresh session by opening a new conversation and sending one message.
 * Mirrors the desktop sessions-pin spec's seeding path. Only used as a fallback
 * if the account has no sessions; on the seeded VPS there are plenty.
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

  await page.waitForTimeout(6000);
}

test.describe('Pin from ⋮ menu does not collapse the mobile sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    // `load`, not `networkidle`: the app keeps a STOMP/socket.io connection open
    // so the network never goes idle (mirrors the desktop sessions-pin spec).
    await page.waitForLoadState('load');
    await page.waitForTimeout(2000);
  });

  test('clicking Pin keeps the sidebar open, pins the row, and does not open the session', async ({
    page,
  }) => {
    test.setTimeout(240000);

    // Surface any uncaught page errors as test failures.
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── 1. Open the mobile sidebar; assert it is OPEN (translate-x-0) ─────────
    await ensureSidebarOpen(page);

    const list = page.getByTestId('sidebar-sessions-list');
    await expect(list).toBeVisible({ timeout: 15000 });

    const stateOpen = await readSidebarState(page);
    console.log(`Sidebar className when open: ${stateOpen.className}`);
    expect(stateOpen.found).toBeTruthy();
    expect(stateOpen.visible).toBeTruthy();
    expect(stateOpen.className).toContain('translate-x-0');
    expect(stateOpen.className).not.toContain('-translate-x-full');
    expect(stateOpen.className).not.toContain('invisible');

    // Ensure ≥1 session exists (seed one if the account is empty).
    let ids = await listSessionIds(page);
    console.log(`Initial unfiled session count: ${ids.length}`);
    if (ids.length === 0) {
      await createSessionWithMessage(
        page,
        `Pin-mobile test seed: reply with one short word. [${Date.now()}]`
      );
      await ensureSidebarOpen(page);
      ids = await listSessionIds(page);
      console.log(`After seeding, unfiled count: ${ids.length}`);
    }
    expect(ids.length).toBeGreaterThanOrEqual(1);

    const targetId = ids[0];
    console.log(`Target session to pin: ${targetId}`);

    const targetRow = page.getByTestId(`sidebar-session-item-${targetId}`);
    await targetRow.scrollIntoViewIfNeeded();
    await expect(targetRow).toBeVisible({ timeout: 10000 });

    // Not pinned yet — no indicator on the row.
    await expect(
      page.getByTestId(`sidebar-session-pin-indicator-${targetId}`)
    ).toHaveCount(0);

    // Snapshot the URL so we can prove the Pin action does NOT navigate/open it.
    const urlBefore = page.url();
    console.log(`URL before pin: ${urlBefore}`);
    expect(urlBefore).not.toContain(`session_id=${targetId}`);

    // ── 2. Open the row's ⋮ menu; assert the portaled menu is visible ────────
    await page.getByTestId(`sidebar-session-options-trigger-${targetId}`).click();
    const menu = page.getByTestId(`sidebar-session-menu-${targetId}`);
    await expect(menu).toBeVisible({ timeout: 5000 });

    const pinItem = page.getByTestId(`sidebar-session-pin-${targetId}`);
    await expect(pinItem).toBeVisible({ timeout: 5000 });
    // The account's UI language may be EN ("Pin to top") or HR ("Prikvači na
    // vrh"); match both so the assertion checks the Pin (not Unpin) state
    // without being brittle to the active locale.
    await expect(pinItem).toHaveText(/pin to top|prikvači na vrh/i);

    // Sanity: opening the menu alone must not have collapsed the sidebar.
    const stateMenuOpen = await readSidebarState(page);
    expect(stateMenuOpen.visible).toBeTruthy();
    expect(stateMenuOpen.className).toContain('translate-x-0');

    // ── 3. Click the Pin item (this is the mousedown that USED to collapse) ───
    // Wait for the PUT /sessions/{id}/pin so we also assert persisted state.
    const pinResponse = page.waitForResponse(
      (res) =>
        res.url().includes(`/sessions/${targetId}/pin`) &&
        res.request().method() === 'PUT',
      { timeout: 20000 }
    );
    await pinItem.click();
    const res = await pinResponse;
    expect(
      res.ok(),
      `PUT /sessions/${targetId}/pin returned ${res.status()} (expected 2xx)`
    ).toBeTruthy();

    // ── 4. THE FIX: the sidebar must STILL be open after the Pin click ───────
    // This is the precise behaviour the bug flips: pre-fix the portaled
    // mousedown collapsed the drawer (`-translate-x-full opacity-0 invisible`);
    // post-fix the isInsidePortalLayer guard keeps it `translate-x-0`.
    await expect(async () => {
      const s = await readSidebarState(page);
      expect(s.found, 'sidebar element should still exist').toBeTruthy();
      expect(s.visible, `sidebar collapsed after Pin (className=${s.className})`).toBeTruthy();
      expect(
        s.className,
        `sidebar should keep translate-x-0 after Pin (className=${s.className})`
      ).toContain('translate-x-0');
      expect(
        s.className,
        `sidebar must NOT have -translate-x-full after Pin (className=${s.className})`
      ).not.toContain('-translate-x-full');
      expect(
        s.className,
        `sidebar must NOT be invisible after Pin (className=${s.className})`
      ).not.toContain('invisible');
    }).toPass({ timeout: 5000 });

    const stateAfterPin = await readSidebarState(page);
    console.log(`Sidebar className AFTER Pin click: ${stateAfterPin.className}`);
    await expect(list).toBeVisible({ timeout: 5000 });
    console.log('✓ sidebar stayed open after Pin click (fix verified)');

    // The pin took effect on the row.
    await expect(
      page.getByTestId(`sidebar-session-pin-indicator-${targetId}`)
    ).toBeVisible({ timeout: 10000 });
    console.log('✓ pin indicator visible on the row');

    // The Pin action must NOT have navigated to / opened the session.
    const urlAfter = page.url();
    console.log(`URL after pin: ${urlAfter}`);
    expect(
      urlAfter,
      `clicking Pin must not open the session (url=${urlAfter})`
    ).not.toContain(`session_id=${targetId}`);
    expect(urlAfter).toBe(urlBefore);
    console.log('✓ URL unchanged — Pin did not open the session');

    // ── 5. Clean up: unpin so the account is left as found ───────────────────
    // The menu closes after the Pin click; the row now offers "Unpin". Pinning
    // floats the row to the top (re-sort + re-render), so a single trigger click
    // can land mid-render and miss. Settle the row into view, then retry the
    // open until the menu shows — still strict (fails if it never opens).
    await page.getByTestId(`sidebar-session-item-${targetId}`).scrollIntoViewIfNeeded();
    await expect(async () => {
      await page.getByTestId(`sidebar-session-options-trigger-${targetId}`).click();
      await expect(menu).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 10000 });
    await expect(pinItem).toBeVisible({ timeout: 5000 });
    // EN "Unpin" or HR "Otkvači" — the row is now pinned, so the item toggled.
    await expect(pinItem).toHaveText(/unpin|otkvači/i);

    const unpinResponse = page.waitForResponse(
      (r) =>
        r.url().includes(`/sessions/${targetId}/pin`) &&
        r.request().method() === 'PUT',
      { timeout: 20000 }
    );
    await pinItem.click();
    const unpinRes = await unpinResponse;
    expect(
      unpinRes.ok(),
      `PUT /sessions/${targetId}/pin (unpin) returned ${unpinRes.status()} (expected 2xx)`
    ).toBeTruthy();

    // Indicator removed.
    await expect(
      page.getByTestId(`sidebar-session-pin-indicator-${targetId}`)
    ).toHaveCount(0, { timeout: 10000 });
    console.log('✓ unpinned — account left as found');

    expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toHaveLength(0);
  });
});
