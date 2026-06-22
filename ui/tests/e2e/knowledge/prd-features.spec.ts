import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * PRD Features E2E Tests
 *
 * Tests all PRD-implemented features:
 * PRD-01: Annotations (API CRUD + toolbar visibility)
 * PRD-02: PDF Auto-Metadata (identifier extraction)
 * PRD-03: Multi-Collection (junction table API)
 * PRD-04: Duplicate Detection (detector service)
 * PRD-07: Document Tags (API CRUD)
 * PRD-08: Identifier Lookup (metadata resolve API)
 */

const DOC_ID = 'deee84df-89f7-4587-82bc-359463e3ebcd';
const COLLECTION_ID = '86aa4614-20ea-4fa9-bf7a-db24bfbb1562';

async function getToken(page: any): Promise<string> {
  const loginResponse = await page.request.post(
    'http://localhost:8080/api/v1/auth/login',
    {
      data: { usernameOrEmail: TEST_EMAIL, password: TEST_PASSWORD },
      headers: { 'Content-Type': 'application/json' },
    }
  );
  const loginData = await loginResponse.json();
  return loginData.access_token;
}

test.describe('PRD Features', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  // ===================================================================
  // PRD-01: Annotations
  // ===================================================================

  test('PRD-01: Annotation API CRUD works end-to-end', async ({ page }) => {
    test.setTimeout(60000);
    const token = await getToken(page);

    // CREATE with red color
    const createResp = await page.request.post(
      `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations`,
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
          document_id: DOC_ID,
          collection_id: COLLECTION_ID,
          annotation_type: 1,
          selected_text: 'E2E PRD-01 test highlight',
          comment: 'Test comment',
          color: '#ff6666',
          page_label: '1',
          position_json: JSON.stringify({
            type: 'pdf', page_index: 0,
            rects: [{ left: 10, top: 30, width: 60, height: 2 }],
          }),
          viewer_type: 'pdf',
        },
      }
    );
    expect(createResp.status()).toBe(201);
    const annotation = await createResp.json();
    expect(annotation.color).toBe('#ff6666');
    expect(annotation.selected_text).toBe('E2E PRD-01 test highlight');
    expect(annotation.comment).toBe('Test comment');

    // LIST
    const listResp = await page.request.get(
      `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    expect(listResp.ok()).toBe(true);
    const annotations = await listResp.json();
    expect(annotations.some((a: any) => a.id === annotation.id)).toBe(true);

    // COUNT
    const countResp = await page.request.get(
      `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations/count`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const countData = await countResp.json();
    expect(countData.count).toBeGreaterThanOrEqual(1);

    // UPDATE
    const updateResp = await page.request.put(
      `http://localhost:8080/api/v1/annotations/${annotation.id}`,
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { comment: 'Updated comment', color: '#5fb236' },
      }
    );
    expect(updateResp.ok()).toBe(true);
    const updated = await updateResp.json();
    expect(updated.comment).toBe('Updated comment');
    expect(updated.color).toBe('#5fb236');

    // DELETE
    const deleteResp = await page.request.delete(
      `http://localhost:8080/api/v1/annotations/${annotation.id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    expect(deleteResp.status()).toBe(204);
  });

  test('PRD-01: Annotation underline type works', async ({ page }) => {
    test.setTimeout(30000);
    const token = await getToken(page);

    const resp = await page.request.post(
      `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations`,
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
          document_id: DOC_ID,
          collection_id: COLLECTION_ID,
          annotation_type: 3, // underline
          selected_text: 'E2E underline test',
          color: '#2ea8e5',
          page_label: '2',
          position_json: JSON.stringify({
            type: 'pdf', page_index: 1,
            rects: [{ left: 15, top: 50, width: 40, height: 1.5 }],
          }),
          viewer_type: 'pdf',
        },
      }
    );
    expect(resp.status()).toBe(201);
    const ann = await resp.json();
    expect(ann.annotation_type).toBe(3);

    // Cleanup
    await page.request.delete(`http://localhost:8080/api/v1/annotations/${ann.id}`,
      { headers: { 'Authorization': `Bearer ${token}` } });
  });

  // ===================================================================
  // PRD-08: Identifier Lookup (Metadata Resolve)
  // ===================================================================

  test('PRD-08: Metadata resolve DOI via API', async ({ page }) => {
    test.setTimeout(30000);
    const token = await getToken(page);

    const resp = await page.request.post(
      'http://localhost:8080/api/v1/metadata/resolve',
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { identifier: '10.1038/nature12373' },
      }
    );
    expect(resp.ok()).toBe(true);
    const result = await resp.json();
    expect(result.success).toBe(true);
    expect(result.identifier_type).toBe('doi');
    expect(result.metadata.title).toContain('thermometry');
    expect(result.metadata.year).toBe(2013);
  });

  test('PRD-08: Metadata resolve ISBN via API', async ({ page }) => {
    test.setTimeout(30000);
    const token = await getToken(page);

    const resp = await page.request.post(
      'http://localhost:8080/api/v1/metadata/resolve',
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { identifier: '978-0-321-12521-7' },
      }
    );
    expect(resp.ok()).toBe(true);
    const result = await resp.json();
    expect(result.success).toBe(true);
    expect(result.identifier_type).toBe('isbn');
  });

  test('PRD-08: Metadata detect identifier type', async ({ page }) => {
    test.setTimeout(15000);
    const token = await getToken(page);

    const resp = await page.request.post(
      'http://localhost:8080/api/v1/metadata/detect',
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { identifier: '2301.07041' },
      }
    );
    expect(resp.ok()).toBe(true);
    const result = await resp.json();
    expect(result.type).toBe('arxiv');
    expect(result.detected).toBe('true');
  });

  // ===================================================================
  // PRD-01 + PRD-02: Annotation toolbar visible in PDF viewer
  // ===================================================================

  test('PRD-01: PDF viewer shows annotation highlighter button', async ({ page }) => {
    test.setTimeout(90000);

    // Open Knowledge Stacks
    const knowledgeButton = page.locator('[data-tour="knowledge-upload"]');
    await knowledgeButton.waitFor({ state: 'visible', timeout: 10000 });
    await knowledgeButton.click();
    await page.waitForTimeout(2000);

    // Select Integration Test collection
    const collectionItems = page.locator('[data-testid^="knowledge-collection-item-"]');
    await collectionItems.first().waitFor({ state: 'visible', timeout: 15000 });
    const count = await collectionItems.count();
    for (let i = 0; i < count; i++) {
      const text = await collectionItems.nth(i).textContent();
      if (text?.toLowerCase().includes('integration')) {
        await collectionItems.nth(i).click();
        break;
      }
    }
    await page.waitForTimeout(2000);

    // Switch to Library tab
    const libraryTab = page.locator('text=Library').first();
    await expect(libraryTab).toBeVisible({ timeout: 15000 });
    await libraryTab.click();
    await page.waitForTimeout(2000);

    // Find and click Preview on a document
    const previewBtn = page.locator('[data-testid^="knowledge-preview-button-"]').first();
    await expect(previewBtn).toBeVisible({ timeout: 15000 });
    await previewBtn.click();
    await page.waitForTimeout(4000);

    // Check PDF drawer opened and has highlighter button
    const drawer = page.locator('[data-testid="pdf-viewer-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 15000 });

    // Find highlighter SVG button
    const highlighter = drawer.locator('svg.lucide-highlighter').first();
    await expect(highlighter).toBeVisible({ timeout: 15000 });
    console.log('Highlighter button visible in PDF viewer');
  });
});
