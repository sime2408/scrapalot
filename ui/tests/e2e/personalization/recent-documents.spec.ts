/**
 * CATEGORY_08 §8.6 — Recent Documents Quick Access E2E.
 *
 * Verifies the wire from `recordDocumentView` → `/document-views`
 * → `/document-views/recent` → Command Palette "Recent documents"
 * group:
 *   1. POST a synthetic view for a known document.
 *   2. Open Cmd+K.
 *   3. Assert the document appears as a `command-recent-doc:<id>`
 *      entry inside the Recent group.
 *
 * Uses the library to grab a real document ID so the test is
 * resilient to whatever the test workspace currently has.
 */
import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

test.describe('CATEGORY_08 §8.6 — Recent Documents', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
  });

  test('recorded view shows up as a Recent entry in Cmd+K', async ({ page }) => {
    test.setTimeout(60_000);

    // Grab a document ID from the library grid. The library is the
    // most reliable place to find a `[data-testid="library-document-item-<id>"]`
    // because it renders one per visible doc.
    const knowledgeBtn = page.locator('[data-testid="sidebar-quick-tools-knowledge-button"]');
    await expect(knowledgeBtn).toBeVisible({ timeout: 15_000 });
    await knowledgeBtn.click();

    const libraryTab = page.locator('[data-testid="knowledge-tab-library"]').first();
    await expect(libraryTab).toBeVisible({ timeout: 10_000 });
    await libraryTab.click();

    const firstDoc = page.locator('[data-testid^="library-document-item-"]').first();
    await expect(firstDoc).toBeVisible({ timeout: 30_000 });
    const testid = await firstDoc.getAttribute('data-testid');
    const docId = testid?.replace('library-document-item-', '') ?? '';
    expect(docId).toMatch(/[0-9a-f-]{36}/);

    // POST a synthetic view directly. We pull the JWT from
    // sessionStorage (same key the app uses) and hit the gateway-
    // routed `/document-views` endpoint with the same body shape as
    // recordDocumentView() in src/lib/api-document-views.ts.
    const recordResult = await page.evaluate(async (id) => {
      try {
        const tokenRaw =
          sessionStorage.getItem('auth_tokens') ||
          localStorage.getItem('auth_tokens') ||
          '{}';
        const token = (JSON.parse(tokenRaw) as { access_token?: string }).access_token;
        if (!token) return 'no-token';
        const baseUrl = (window as unknown as { __SCRAPALOT_API_BASE_URL?: string }).__SCRAPALOT_API_BASE_URL
          || `${window.location.origin}/api/v1`;
        const resp = await fetch(`${baseUrl}/document-views`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ document_id: id, collection_id: null, source: 'pdf_open' }),
        });
        return resp.ok ? 'ok' : `http-${resp.status}`;
      } catch (err) {
        return String(err);
      }
    }, docId);
    expect(recordResult).toBe('ok');

    // Close the dialog so Cmd+K isn't intercepted by Knowledge Stacks.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Open the Command Palette and search for our doc id (the entry
    // testid is `command-recent-doc:<uuid>`; cmdk renders it inside
    // the 'Recent documents' group).
    await page.keyboard.press('Control+k');
    const input = page.locator('[data-testid="command-palette-input"]');
    await expect(input).toBeVisible({ timeout: 5_000 });

    // The recent group only mounts on palette open (effect on `open`),
    // so wait for the entry rather than asserting at t=0.
    const recentEntry = page.locator(`[data-testid="command-recent-doc:${docId}"]`);
    await expect(recentEntry).toBeVisible({ timeout: 10_000 });
  });
});
