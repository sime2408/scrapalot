import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Deleting the currently-open session from the sidebar must clear its messages
 * from the main chat screen and land on an empty new session. Regression: the
 * old conversation's messages stayed on screen after the session was deleted.
 */
test.describe('Delete open session clears the main screen', () => {
  const BASE_URL = 'http://localhost:8080/api/v1';

  let authToken = '';
  let sessionId = '';
  const MSG = 'Deleterepromessage';

  test.beforeEach(async ({ page, request }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const loginResponse = await request.post(`${BASE_URL}/auth/login`, {
      data: { usernameOrEmail: TEST_EMAIL, password: TEST_PASSWORD },
    });
    expect(loginResponse.ok()).toBeTruthy();
    authToken = (await loginResponse.json()).access_token;

    const sessionRes = await request.post(`${BASE_URL}/sessions`, {
      headers: { Authorization: `Bearer ${authToken}` },
      data: { conversation_name: 'delete-repro-session' },
    });
    expect(sessionRes.ok()).toBeTruthy();
    sessionId = (await sessionRes.json()).id;

    for (let i = 1; i <= 3; i++) {
      const res = await request.post(`${BASE_URL}/messages`, {
        headers: { Authorization: `Bearer ${authToken}` },
        data: {
          session_id: sessionId,
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `${MSG} ${String(i).padStart(2, '0')}`,
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

  test('removes old messages and shows an empty session after delete', async ({ page }) => {
    test.setTimeout(120000);

    // Open the seeded session.
    await page.goto(`/dashboard?session_id=${sessionId}`);
    const basePage = new BasePage(page);
    await basePage.waitForAppReady();

    // Messages are on screen.
    const firstMsg = page.getByText(`${MSG} 01`, { exact: true });
    await expect(firstMsg).toBeVisible({ timeout: 30000 });

    // Delete the session from the sidebar.
    const optionsTrigger = page.getByTestId(`sidebar-session-options-trigger-${sessionId}`);
    await expect(optionsTrigger).toBeVisible({ timeout: 15000 });
    await optionsTrigger.click();
    const deleteItem = page.getByTestId(`sidebar-session-delete-${sessionId}`);
    await expect(deleteItem).toBeVisible({ timeout: 10000 });
    await deleteItem.click();

    // The deleted conversation's messages must be gone from the main screen.
    await expect(page.getByText(`${MSG} 01`, { exact: true })).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByText(`${MSG} 03`, { exact: true })).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId('chat-message')).toHaveCount(0, { timeout: 15000 });

    // And the app should be on a usable empty session (chat input present).
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 10000 });

    // Guard against a DELAYED reappearance: a background refreshSessions merge
    // can re-add the locally-still-present (but backend-deleted) session with
    // its cached messages. Wait past that and re-assert the messages stay gone.
    await page.waitForTimeout(7000);
    await expect(page.getByText(`${MSG} 01`, { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('chat-message')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/delete-session-cleared.png', fullPage: true });
  });

  test('removes old messages when the session was opened by clicking the sidebar', async ({ page }) => {
    test.setTimeout(120000);

    // Land on the dashboard WITHOUT a session in the URL, then open the seeded
    // session by clicking it — the realistic flow (React Router navigate +
    // selectSession), which sets state differently from a direct URL load.
    await page.goto('/dashboard');
    // No session in the URL → desktop shows the welcome screen (no chat-input),
    // so wait for the sidebar item rather than waitForAppReady.
    const sessionItem = page.getByTestId(`sidebar-session-item-${sessionId}`);
    await expect(sessionItem).toBeVisible({ timeout: 30000 });
    await sessionItem.click();

    await expect(page.getByText(`${MSG} 01`, { exact: true })).toBeVisible({ timeout: 30000 });

    // Delete it from the sidebar.
    const optionsTrigger = page.getByTestId(`sidebar-session-options-trigger-${sessionId}`);
    await expect(optionsTrigger).toBeVisible({ timeout: 15000 });
    await optionsTrigger.click();
    const deleteItem = page.getByTestId(`sidebar-session-delete-${sessionId}`);
    await expect(deleteItem).toBeVisible({ timeout: 10000 });
    await deleteItem.click();

    await expect(page.getByText(`${MSG} 01`, { exact: true })).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId('chat-message')).toHaveCount(0, { timeout: 15000 });
    await page.waitForTimeout(7000);
    await expect(page.getByText(`${MSG} 01`, { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('chat-message')).toHaveCount(0);
  });

  test.describe('mobile viewport', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('removes old messages after delete on mobile', async ({ page }) => {
      test.setTimeout(120000);

      // Realistic mobile flow: land on the dashboard, open the drawer, CLICK the
      // session to open it (drawer closes), then reopen the drawer to delete.
      await page.goto('/dashboard');

      const toggle = page.getByTestId('sidebar-toggle-button');
      await expect(toggle).toBeVisible({ timeout: 30000 });
      await toggle.click();

      const sessionItem = page.getByTestId(`sidebar-session-item-${sessionId}`);
      await expect(sessionItem).toBeVisible({ timeout: 20000 });
      await sessionItem.click();

      // Wait for the whole conversation to load (mobile click-open is slower);
      // asserting the count is steadier than a single message's visibility.
      await expect(page.getByTestId('chat-message')).toHaveCount(3, { timeout: 30000 });
      await expect(page.getByText(`${MSG} 01`, { exact: true })).toBeVisible({ timeout: 10000 });

      // Reopen the drawer to delete the now-open session.
      await expect(toggle).toBeVisible({ timeout: 15000 });
      await toggle.click();

      const optionsTrigger = page.getByTestId(`sidebar-session-options-trigger-${sessionId}`);
      await expect(optionsTrigger).toBeVisible({ timeout: 15000 });
      await optionsTrigger.click();
      const deleteItem = page.getByTestId(`sidebar-session-delete-${sessionId}`);
      await expect(deleteItem).toBeVisible({ timeout: 10000 });
      await deleteItem.click();

      // Old messages must be gone, now and after a background refresh.
      await expect(page.getByText(`${MSG} 01`, { exact: true })).toHaveCount(0, { timeout: 15000 });
      await expect(page.getByTestId('chat-message')).toHaveCount(0, { timeout: 15000 });
      await page.waitForTimeout(7000);
      await expect(page.getByText(`${MSG} 01`, { exact: true })).toHaveCount(0);
      await expect(page.getByTestId('chat-message')).toHaveCount(0);

      await page.screenshot({ path: 'test-results/delete-session-cleared-mobile.png', fullPage: true });
    });
  });
});
