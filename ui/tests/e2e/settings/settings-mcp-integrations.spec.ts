import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * MCP Integrations settings E2E.
 *
 * Full flow: open Settings → Integrations, add a remote MCP server, see it in
 * the list, toggle it off, then delete it. Strict assertions — a missing
 * element fails the test. Cleans up after itself (deletes what it creates).
 */
test.describe('Settings — MCP Integrations', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  async function openMcpTab(page: import('@playwright/test').Page) {
    const settingsButton = page.locator('[data-tour="settings-button"]');
    await settingsButton.waitFor({ state: 'visible', timeout: 10000 });
    await settingsButton.click();

    const dialog = page.locator('[data-testid="settings-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Settings renders both mobile + desktop tab elements; click the visible one.
    const tab = page.locator('[data-testid="settings-tab-mcp-integrations"]');
    const count = await tab.count();
    let clicked = false;
    for (let i = 0; i < count; i++) {
      if (await tab.nth(i).isVisible({ timeout: 1000 }).catch(() => false)) {
        await tab.nth(i).click();
        clicked = true;
        break;
      }
    }
    if (!clicked) await tab.last().click({ force: true });
    await page.waitForTimeout(800);
  }

  test('add, toggle and delete an MCP integration', async ({ page }) => {
    test.setTimeout(90000);
    const name = `E2E MCP ${Date.now()}`;

    await openMcpTab(page);

    // The tab content is visible (add button present).
    const addButton = page.locator('[data-testid="settings-mcp-add-button"]');
    await expect(addButton).toBeVisible({ timeout: 10000 });

    // Add a server.
    await addButton.click();
    const nameInput = page.locator('[data-testid="settings-mcp-name-input"]');
    await nameInput.fill(name);
    await page.locator('[data-testid="settings-mcp-url-input"]').fill('https://example.com/mcp');
    await page.locator('[data-testid="settings-mcp-save-button"]').click();

    // Dialog closes on success, then the list reloads.
    await expect(nameInput).toBeHidden({ timeout: 15000 });

    // Settings renders the tab content in both a mobile and a desktop layout
    // container (a known dialog behaviour — the providers spec loops tabs the
    // same way), so each row appears twice in the DOM. Operate on .first().
    // Both copies share React state, so a single interaction updates both.
    const byName = () =>
      page.locator('[data-testid^="settings-mcp-item-"]').filter({ hasText: name });
    const item = byName().first();
    await expect(item).toBeVisible({ timeout: 20000 });

    // Toggle it off (Radix Switch exposes data-state).
    const toggle = item.locator('[data-testid^="settings-mcp-toggle-"]');
    await expect(toggle).toHaveAttribute('data-state', 'checked', { timeout: 5000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'unchecked', { timeout: 5000 });

    // Delete it.
    await item.locator('[data-testid^="settings-mcp-delete-"]').click();
    await page.locator('[data-testid="settings-mcp-delete-confirm"]').first().click();

    // Gone from the list (every copy removed).
    await expect(byName()).toHaveCount(0, { timeout: 15000 });
  });

  test('test connection reports an unreachable server', async ({ page }) => {
    test.setTimeout(90000);
    await openMcpTab(page);

    await page.locator('[data-testid="settings-mcp-add-button"]').click();
    await page.locator('[data-testid="settings-mcp-name-input"]').fill('Unreachable');
    // Connection-refused inside the chat container → ok=false → error result.
    await page.locator('[data-testid="settings-mcp-url-input"]').fill('http://127.0.0.1:2/mcp');
    await page.locator('[data-testid="settings-mcp-test-button"]').click();

    // The result panel appears (error branch); the button re-enables when done.
    const result = page.locator('[data-testid="settings-mcp-test-result"]');
    await expect(result).toBeVisible({ timeout: 30000 });
  });
});
