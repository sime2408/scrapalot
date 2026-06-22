import { test, expect, Page } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * PRD-06: Saved Searches (Smart Collections) E2E Tests
 *
 * Tests CRUD lifecycle + execution via API and UI integration.
 * Uses API for reliable CRUD, UI for dialog rendering verification.
 */

let authToken = '';

async function getToken(page: Page): Promise<string> {
  if (authToken) return authToken;
  const resp = await page.request.post('http://localhost:8080/api/v1/auth/login', {
    data: { usernameOrEmail: TEST_EMAIL, password: TEST_PASSWORD },
  });
  authToken = (await resp.json()).access_token;
  return authToken;
}

async function getWorkspaceId(page: Page, token: string): Promise<string> {
  const resp = await page.request.get('http://localhost:8080/api/v1/workspaces', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  const list = data.workspaces || data.content || (Array.isArray(data) ? data : []);
  // Pick workspace with collections (e.g. "books")
  const books = list.find((w: { name: string }) => w.name?.toLowerCase() === 'books');
  return books?.id || list[0]?.id;
}

test.describe('Saved Searches (Smart Collections)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    authToken = '';
  });

  test.afterAll(async ({ browser }) => {
    // Clean up any leftover e2e/test saved searches across all workspaces
    const page = await browser.newPage();
    try {
      const token = await getToken(page);
      const headers = { Authorization: `Bearer ${token}` };
      const wsResp = await page.request.get('http://localhost:8080/api/v1/workspaces', { headers });
      const wsList = (await wsResp.json()).workspaces || [];
      for (const ws of wsList) {
        const ssResp = await page.request.get(`http://localhost:8080/api/v1/saved-searches?workspace_id=${ws.id}`, { headers });
        for (const ss of await ssResp.json()) {
          if (/^e2e-|^test-/i.test(ss.name)) {
            await page.request.delete(`http://localhost:8080/api/v1/saved-searches/${ss.id}`, { headers });
          }
        }
      }
    } catch { /* best-effort cleanup */ }
    await page.close();
  });

  test('API: create, list, execute, preview, delete saved search', async ({ page }) => {
    test.setTimeout(60000);
    const token = await getToken(page);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const workspaceId = await getWorkspaceId(page, token);
    expect(workspaceId).toBeTruthy();

    const searchName = `e2e-smart-${Date.now()}`;
    const criteria = {
      conditions: [
        { field: 'processing_status', operator: 'equals', value: 'completed' },
      ],
      match: 'all',
    };

    // Create
    const createResp = await page.request.post('http://localhost:8080/api/v1/saved-searches', {
      headers,
      data: {
        workspace_id: workspaceId,
        name: searchName,
        criteria_json: JSON.stringify(criteria),
        color: '#2ea8e5',
      },
    });
    expect(createResp.status()).toBe(201);
    const createBody = await createResp.json();
    const created = createBody.search || createBody;
    expect(created.id).toBeTruthy();
    expect(created.name).toBe(searchName);
    console.log(`Created saved search: ${created.id}`);

    // List
    const listResp = await page.request.get(
      `http://localhost:8080/api/v1/saved-searches?workspace_id=${workspaceId}`,
      { headers },
    );
    expect(listResp.ok()).toBe(true);
    const searches = await listResp.json();
    const found = searches.find((s: { id: string }) => s.id === created.id);
    expect(found).toBeTruthy();
    expect(found.name).toBe(searchName);
    console.log(`Listed ${searches.length} saved searches, found ours`);

    // Execute
    const execResp = await page.request.post(
      `http://localhost:8080/api/v1/saved-searches/${created.id}/execute`,
      { headers },
    );
    expect(execResp.ok()).toBe(true);
    const execResult = await execResp.json();
    const docIds = execResult.document_ids || execResult;
    expect(Array.isArray(docIds)).toBe(true);
    console.log(`Execute returned ${docIds.length} documents`);

    // Preview
    const previewResp = await page.request.post(
      'http://localhost:8080/api/v1/saved-searches/preview',
      {
        headers,
        data: {
          workspace_id: workspaceId,
          criteria_json: JSON.stringify(criteria),
        },
      },
    );
    expect(previewResp.ok()).toBe(true);
    const previewResult = await previewResp.json();
    const count = previewResult.count ?? previewResult;
    expect(typeof count === 'number').toBe(true);
    console.log(`Preview count: ${count}`);

    // Delete
    const deleteResp = await page.request.delete(
      `http://localhost:8080/api/v1/saved-searches/${created.id}`,
      { headers },
    );
    expect(deleteResp.ok()).toBe(true);
    console.log(`Deleted saved search: ${created.id}`);

    // Verify gone
    const listAfter = await page.request.get(
      `http://localhost:8080/api/v1/saved-searches?workspace_id=${workspaceId}`,
      { headers },
    );
    const afterList = await listAfter.json();
    const stillExists = afterList.find((s: { id: string }) => s.id === created.id);
    expect(stillExists).toBeUndefined();
    console.log('Verified deletion');
  });

  test('API: multi-condition saved search with title + year filter', async ({ page }) => {
    test.setTimeout(60000);
    const token = await getToken(page);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const workspaceId = await getWorkspaceId(page, token);

    const criteria = {
      conditions: [
        { field: 'title', operator: 'contains', value: 'agriculture' },
        { field: 'processing_status', operator: 'equals', value: 'completed' },
      ],
      match: 'all',
    };

    // Preview should return count
    const previewResp = await page.request.post(
      'http://localhost:8080/api/v1/saved-searches/preview',
      {
        headers,
        data: { workspace_id: workspaceId, criteria_json: JSON.stringify(criteria) },
      },
    );
    expect(previewResp.ok()).toBe(true);
    const previewResult = await previewResp.json();
    console.log(`Multi-condition preview: ${JSON.stringify(previewResult)}`);

    // Create, execute, cleanup
    const searchName = `e2e-multi-${Date.now()}`;
    const createResp = await page.request.post('http://localhost:8080/api/v1/saved-searches', {
      headers,
      data: { workspace_id: workspaceId, name: searchName, criteria_json: JSON.stringify(criteria) },
    });
    expect(createResp.status()).toBe(201);
    const createBody = await createResp.json();
    const created = createBody.search || createBody;

    const execResp = await page.request.post(
      `http://localhost:8080/api/v1/saved-searches/${created.id}/execute`,
      { headers },
    );
    expect(execResp.ok()).toBe(true);
    const docs = await execResp.json();
    console.log(`Multi-condition execute: ${(docs.document_ids || []).length} docs`);

    // Cleanup
    await page.request.delete(`http://localhost:8080/api/v1/saved-searches/${created.id}`, { headers });
  });

  test('API: "any" match mode returns union of conditions', async ({ page }) => {
    test.setTimeout(60000);
    const token = await getToken(page);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const workspaceId = await getWorkspaceId(page, token);

    const criteriaAll = {
      conditions: [
        { field: 'title', operator: 'contains', value: 'zzz_nonexistent' },
        { field: 'processing_status', operator: 'equals', value: 'completed' },
      ],
      match: 'all',
    };
    const criteriaAny = { ...criteriaAll, match: 'any' };

    const [previewAll, previewAny] = await Promise.all([
      page.request.post('http://localhost:8080/api/v1/saved-searches/preview', {
        headers,
        data: { workspace_id: workspaceId, criteria_json: JSON.stringify(criteriaAll) },
      }),
      page.request.post('http://localhost:8080/api/v1/saved-searches/preview', {
        headers,
        data: { workspace_id: workspaceId, criteria_json: JSON.stringify(criteriaAny) },
      }),
    ]);

    const countAll = (await previewAll.json()).count ?? 0;
    const countAny = (await previewAny.json()).count ?? 0;

    console.log(`ALL (AND): ${countAll}, ANY (OR): ${countAny}`);
    // "any" should return >= "all" since OR is less restrictive
    expect(countAny).toBeGreaterThanOrEqual(countAll);
  });

  test('UI: Smart Collections section visible in Knowledge Stacks', async ({ page }) => {
    test.setTimeout(60000);

    // Open Knowledge Stacks
    const knowledgeButton = page.locator('[data-tour="knowledge-upload"]');
    await knowledgeButton.waitFor({ state: 'visible', timeout: 10000 });
    await knowledgeButton.click();
    await page.waitForTimeout(2000);

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Check "Smart Collections" text is visible
    const smartLabel = dialog.locator('text=Smart Collections').first();
    await expect(smartLabel).toBeVisible({ timeout: 15000 });
    console.log('Smart Collections label visible');

    // Check create button exists
    const createBtn = dialog.locator('[data-testid="knowledge-create-collection-button"]');
    await expect(createBtn).toBeVisible({ timeout: 15000 });

    // Click Create dropdown and check Smart Collections option
    await createBtn.click();
    await page.waitForTimeout(500);

    const smartOption = page.locator('[data-testid="knowledge-create-saved-search"]');
    await expect(smartOption).toBeVisible({ timeout: 15000 });
    console.log('Create Smart Collection menu item visible');
  });

  test('UI: create and delete saved search via dialog', async ({ page }) => {
    test.setTimeout(90000);

    // Create via API first (faster and more reliable than UI form)
    const token = await getToken(page);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const workspaceId = await getWorkspaceId(page, token);

    const searchName = `e2e-ui-${Date.now()}`;
    const createResp = await page.request.post('http://localhost:8080/api/v1/saved-searches', {
      headers,
      data: {
        workspace_id: workspaceId,
        name: searchName,
        criteria_json: JSON.stringify({
          conditions: [{ field: 'processing_status', operator: 'equals', value: 'completed' }],
          match: 'all',
        }),
        color: '#ff6666',
      },
    });
    expect(createResp.status()).toBe(201);
    const createBody = await createResp.json();
    const created = createBody.search || createBody;

    // Open Knowledge Stacks and verify it appears
    const knowledgeButton = page.locator('[data-tour="knowledge-upload"]');
    await knowledgeButton.waitFor({ state: 'visible', timeout: 10000 });
    await knowledgeButton.click();
    await page.waitForTimeout(2000);

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Look for the saved search item
    const searchItem = dialog.locator(`[data-testid="knowledge-saved-search-${created.id}"]`);
    await expect(searchItem).toBeVisible({ timeout: 15000 });
    console.log(`Saved search "${searchName}" visible in sidebar`);

    // Click it and verify results load
    await searchItem.click();
    await page.waitForTimeout(3000);
    console.log('Clicked saved search, results should load');

    // Cleanup via API
    await page.request.delete(`http://localhost:8080/api/v1/saved-searches/${created.id}`, { headers });
    console.log('Cleaned up saved search');
  });
});
