import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Verifies the workspace-share email deep-link:
 *   /dashboard?workspace=<id>&view=library
 * lands the recipient on the shared workspace AND auto-opens the Knowledge
 * Stacks dialog on the "library" tab. Implemented in src/pages/Index.tsx
 * (deep-link effect) + KnowledgeStacksDialog `defaultTab` prop.
 */
test.describe('Workspace share deep-link', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('switches workspace and opens the library tab', async ({ page }) => {
    test.setTimeout(90000);
    // Dialog needs a wide viewport (>1400px) or it takes the mobile path.
    await page.setViewportSize({ width: 1500, height: 900 });

    // Resolve the workspaces this account can access via the API, then target
    // the one that is NOT currently active so the switch is observable
    // (selectWorkspace no-ops on the already-active workspace).
    const loginResp = await page.request.post(
      'http://localhost:8080/api/v1/auth/login',
      { data: { usernameOrEmail: TEST_EMAIL, password: TEST_PASSWORD } },
    );
    expect(loginResp.ok()).toBeTruthy();
    const token = (await loginResp.json()).access_token as string;

    const wsResp = await page.request.get(
      'http://localhost:8080/api/v1/workspaces?page=1&page_size=20',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(wsResp.ok()).toBeTruthy();
    const workspaces = (await wsResp.json()).workspaces as Array<{ id: string; name: string }>;
    expect(workspaces.length).toBeGreaterThan(1);

    const activeId = await page.evaluate(() => {
      try {
        const ui = JSON.parse(localStorage.getItem('scrapalot_ui_state') || '{}');
        return ui?.currentWorkspace?.id ?? null;
      } catch {
        return null;
      }
    });
    const target = workspaces.find((w) => w.id !== activeId) ?? workspaces[0];

    // Hit the deep-link exactly as the share email would.
    await page.goto(`/dashboard?workspace=${target.id}&view=library`);
    await page.waitForLoadState('networkidle');

    // 1. Knowledge Stacks dialog opens automatically.
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 15000 });

    // 2. The active workspace switches to the deep-linked one. This is the
    // slow step (backend select + workspace reload), and the library content
    // below depends on it, so assert it first with a generous timeout.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            try {
              const ui = JSON.parse(localStorage.getItem('scrapalot_ui_state') || '{}');
              return ui?.currentWorkspace?.id ?? null;
            } catch {
              return null;
            }
          }),
        { timeout: 30000 },
      )
      .toBe(target.id);

    // 3. The dialog is on the library tab (not the default upload tab).
    // Assert the active tab rather than its content: the library document
    // grid lazy-loads every doc in the (large) switched workspace and is
    // slow/flaky, whereas the active-tab state is set synchronously.
    await expect(
      page.locator('[data-testid="knowledge-tab-library"][aria-selected="true"]').first(),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator('[data-testid="knowledge-tab-upload"][aria-selected="true"]'),
    ).toHaveCount(0);

    // 4. The deep-link params are consumed (stripped) from the URL.
    await expect.poll(async () => new URL(page.url()).search).not.toContain('view=library');
    expect(new URL(page.url()).searchParams.get('workspace')).toBeNull();
  });
});
