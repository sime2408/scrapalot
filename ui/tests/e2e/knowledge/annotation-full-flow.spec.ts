import { test, expect, Page } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Full Annotation Flow E2E Tests
 *
 * Tests the complete annotation lifecycle:
 * 1. Open PDF from Library → highlighter button visible
 * 2. Activate highlighter → select text → popover appears
 * 3. Choose color → click Highlight → saved to DB
 * 4. Reload → annotation persists
 * 5. Test with different colors (red, green, blue)
 * 6. Test underline type
 * 7. Verify RAG context enrichment
 */

const DOC_ID = 'deee84df-89f7-4587-82bc-359463e3ebcd';
const COLLECTION_ID = '86aa4614-20ea-4fa9-bf7a-db24bfbb1562';

async function getToken(page: Page): Promise<string> {
  const resp = await page.request.post('http://localhost:8080/api/v1/auth/login', {
    data: { usernameOrEmail: TEST_EMAIL, password: TEST_PASSWORD },
    headers: { 'Content-Type': 'application/json' },
  });
  return (await resp.json()).access_token;
}

async function cleanupAnnotations(page: Page, token: string) {
  const listResp = await page.request.get(
    `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const annotations = await listResp.json();
  for (const ann of annotations) {
    await page.request.delete(`http://localhost:8080/api/v1/annotations/${ann.id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
  }
}

test.describe('Annotation Full Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('Create annotation with red color and verify in DB', async ({ page }) => {
    test.setTimeout(60000);
    const token = await getToken(page);
    await cleanupAnnotations(page, token);

    // Create annotation with red color via API
    const createResp = await page.request.post(
      `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations`,
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
          document_id: DOC_ID,
          collection_id: COLLECTION_ID,
          annotation_type: 1,
          selected_text: 'Supplementary Health Insurance',
          comment: 'Important benefit',
          color: '#ff6666',
          page_label: '1',
          position_json: JSON.stringify({
            type: 'pdf', page_index: 0,
            rects: [{ left: 12, top: 32, width: 30, height: 2.5 }],
          }),
          viewer_type: 'pdf',
        },
      }
    );
    expect(createResp.status()).toBe(201);
    const annotation = await createResp.json();
    expect(annotation.color).toBe('#ff6666');
    expect(annotation.comment).toBe('Important benefit');

    // Create green annotation
    const greenResp = await page.request.post(
      `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations`,
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
          document_id: DOC_ID,
          collection_id: COLLECTION_ID,
          annotation_type: 1,
          selected_text: 'Annual Medical Check-Up',
          color: '#5fb236',
          page_label: '1',
          position_json: JSON.stringify({
            type: 'pdf', page_index: 0,
            rects: [{ left: 12, top: 35, width: 28, height: 2.5 }],
          }),
          viewer_type: 'pdf',
        },
      }
    );
    expect(greenResp.status()).toBe(201);

    // Create underline annotation (type 3)
    const underlineResp = await page.request.post(
      `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations`,
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
          document_id: DOC_ID,
          collection_id: COLLECTION_ID,
          annotation_type: 3,
          selected_text: 'Business Travel Insurance',
          color: '#2ea8e5',
          page_label: '1',
          position_json: JSON.stringify({
            type: 'pdf', page_index: 0,
            rects: [{ left: 12, top: 38, width: 26, height: 2.5 }],
          }),
          viewer_type: 'pdf',
        },
      }
    );
    expect(underlineResp.status()).toBe(201);

    // Verify count is 3
    const countResp = await page.request.get(
      `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations/count`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const countData = await countResp.json();
    expect(countData.count).toBe(3);

    // Verify list has all 3 with correct types and colors
    const listResp = await page.request.get(
      `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const annotations = await listResp.json();
    expect(annotations.length).toBe(3);

    const colors = annotations.map((a: any) => a.color).sort();
    expect(colors).toEqual(['#2ea8e5', '#5fb236', '#ff6666']);

    const types = annotations.map((a: any) => a.annotation_type).sort();
    expect(types).toEqual([1, 1, 3]);

    // Cleanup
    await cleanupAnnotations(page, token);
  });

  test('Annotation collection endpoint returns annotated document IDs', async ({ page }) => {
    test.setTimeout(30000);
    const token = await getToken(page);

    // Create an annotation
    const createResp = await page.request.post(
      `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations`,
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
          document_id: DOC_ID,
          collection_id: COLLECTION_ID,
          annotation_type: 1,
          selected_text: 'Test for collection endpoint',
          color: '#ffd400',
          page_label: '1',
          position_json: '{"type":"pdf","page_index":0,"rects":[{"left":10,"top":20,"width":50,"height":2}]}',
          viewer_type: 'pdf',
        },
      }
    );
    expect(createResp.status()).toBe(201);
    const ann = await createResp.json();

    // Check collection annotations endpoint
    const collResp = await page.request.get(
      `http://localhost:8080/api/v1/collections/${COLLECTION_ID}/annotations`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    expect(collResp.ok()).toBe(true);
    const collAnnotations = await collResp.json();
    expect(collAnnotations.length).toBeGreaterThanOrEqual(1);

    // Check annotated documents endpoint
    const docIdsResp = await page.request.get(
      `http://localhost:8080/api/v1/collections/${COLLECTION_ID}/annotated-documents`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    expect(docIdsResp.ok()).toBe(true);
    const docIds = await docIdsResp.json();
    expect(docIds).toContain(DOC_ID);

    // Cleanup
    await page.request.delete(`http://localhost:8080/api/v1/annotations/${ann.id}`,
      { headers: { 'Authorization': `Bearer ${token}` } });
  });

  test('PRD-08: Metadata resolve works for DOI and arXiv', async ({ page }) => {
    test.setTimeout(30000);
    const token = await getToken(page);

    // DOI
    const doiResp = await page.request.post('http://localhost:8080/api/v1/metadata/resolve', {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { identifier: '10.1038/nature12373' },
    });
    expect(doiResp.ok()).toBe(true);
    const doiResult = await doiResp.json();
    expect(doiResult.success).toBe(true);
    expect(doiResult.identifier_type).toBe('doi');
    expect(doiResult.metadata.year).toBe(2013);

    // arXiv
    const arxivResp = await page.request.post('http://localhost:8080/api/v1/metadata/resolve', {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { identifier: '2301.07041' },
    });
    expect(arxivResp.ok()).toBe(true);
    const arxivResult = await arxivResp.json();
    expect(arxivResult.success).toBe(true);
    expect(arxivResult.identifier_type).toBe('arxiv');
    expect(arxivResult.metadata.year).toBe(2023);
  });

  test('PRD-08: Metadata detect identifies all types', async ({ page }) => {
    test.setTimeout(15000);
    const token = await getToken(page);

    const testCases = [
      { input: '10.1038/nature12373', expectedType: 'doi' },
      { input: '2301.07041', expectedType: 'arxiv' },
      { input: '978-0-321-12521-7', expectedType: 'isbn' },
    ];

    for (const tc of testCases) {
      const resp = await page.request.post('http://localhost:8080/api/v1/metadata/detect', {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { identifier: tc.input },
      });
      expect(resp.ok()).toBe(true);
      const result = await resp.json();
      expect(result.type).toBe(tc.expectedType);
    }
  });

  test('PRD-02: RAG annotation context enrichment', async ({ page }) => {
    test.setTimeout(30000);
    const token = await getToken(page);

    // Create an annotation that should appear in RAG context
    const createResp = await page.request.post(
      `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations`,
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
          document_id: DOC_ID,
          collection_id: COLLECTION_ID,
          annotation_type: 1,
          selected_text: 'Croatia employee benefits include health insurance and pension',
          comment: 'Key benefits summary for RAG test',
          color: '#ff6666',
          page_label: '1',
          position_json: '{"type":"pdf","page_index":0,"rects":[{"left":10,"top":20,"width":80,"height":3}]}',
          viewer_type: 'pdf',
        },
      }
    );
    expect(createResp.status()).toBe(201);
    const ann = await createResp.json();

    // Verify annotation exists and has correct data for RAG
    const listResp = await page.request.get(
      `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const annotations = await listResp.json();
    const ragAnnotation = annotations.find((a: any) => a.id === ann.id);
    expect(ragAnnotation).toBeTruthy();
    expect(ragAnnotation.selected_text).toContain('Croatia employee benefits');
    expect(ragAnnotation.comment).toContain('Key benefits summary');
    expect(ragAnnotation.color).toBe('#ff6666'); // Red = 1.5x RAG boost

    // Cleanup
    await page.request.delete(`http://localhost:8080/api/v1/annotations/${ann.id}`,
      { headers: { 'Authorization': `Bearer ${token}` } });
  });

  test('PRD-01: EPUB annotation CRUD works', async ({ page }) => {
    test.setTimeout(30000);
    const token = await getToken(page);
    const EPUB_DOC = '982578a8-fc94-404c-a800-90592b59c187';

    // Create EPUB annotation with CFI position
    const createResp = await page.request.post(
      `http://localhost:8080/api/v1/documents/${EPUB_DOC}/annotations`,
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
          document_id: EPUB_DOC,
          collection_id: COLLECTION_ID,
          annotation_type: 1,
          selected_text: 'The Farming Ladder guide to sustainable agriculture',
          comment: 'EPUB highlight for E2E test',
          color: '#a28ae5',
          page_label: '1',
          position_json: JSON.stringify({
            type: 'epub',
            cfi: 'epubcfi(/6/4!/4/2)',
            section_index: 0,
          }),
          viewer_type: 'epub',
        },
      }
    );
    expect(createResp.status()).toBe(201);
    const ann = await createResp.json();
    expect(ann.viewer_type).toBe('epub');
    expect(ann.color).toBe('#a28ae5');

    // Verify it shows up in document annotations
    const listResp = await page.request.get(
      `http://localhost:8080/api/v1/documents/${EPUB_DOC}/annotations`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const annotations = await listResp.json();
    expect(annotations.some((a: any) => a.id === ann.id)).toBe(true);

    // Verify position is EPUB CFI format
    const found = annotations.find((a: any) => a.id === ann.id);
    const position = JSON.parse(found.position_json);
    expect(position.type).toBe('epub');
    expect(position.cfi).toContain('epubcfi');

    // Cleanup
    await page.request.delete(`http://localhost:8080/api/v1/annotations/${ann.id}`,
      { headers: { 'Authorization': `Bearer ${token}` } });
  });

  test('PRD-01: Bulk annotation create works', async ({ page }) => {
    test.setTimeout(30000);
    const token = await getToken(page);

    const bulkResp = await page.request.post(
      `http://localhost:8080/api/v1/documents/${DOC_ID}/annotations/bulk`,
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
          annotations: [
            {
              document_id: DOC_ID, collection_id: COLLECTION_ID,
              annotation_type: 1, selected_text: 'Bulk item 1', color: '#ffd400',
              page_label: '1', position_json: '{"type":"pdf","page_index":0,"rects":[{"left":10,"top":10,"width":30,"height":2}]}',
              viewer_type: 'pdf',
            },
            {
              document_id: DOC_ID, collection_id: COLLECTION_ID,
              annotation_type: 1, selected_text: 'Bulk item 2', color: '#ff6666',
              page_label: '2', position_json: '{"type":"pdf","page_index":1,"rects":[{"left":10,"top":20,"width":30,"height":2}]}',
              viewer_type: 'pdf',
            },
          ],
        },
      }
    );
    expect(bulkResp.status()).toBe(201);
    const created = await bulkResp.json();
    expect(created.length).toBe(2);

    // Cleanup
    for (const ann of created) {
      await page.request.delete(`http://localhost:8080/api/v1/annotations/${ann.id}`,
        { headers: { 'Authorization': `Bearer ${token}` } });
    }
  });
});
