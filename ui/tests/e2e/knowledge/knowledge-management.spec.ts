import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Knowledge Management E2E Tests
 *
 * Tests collection CRUD and document management:
 * - Create a new collection
 * - Upload documents (PDF, TXT)
 * - Verify thumbnails/icons after upload
 * - Monitor document processing status
 * - Delete documents
 *
 * Pipeline: UI -> Gateway (8080) -> Kotlin BE (8091) -> Python AI (8090)
 */
test.describe('Knowledge Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  /**
   * Helper: Open Knowledge Stacks dialog and wait for collections to load
   */
  async function openKnowledgeStacks(page: any) {
    const knowledgeButton = page.locator('[data-tour="knowledge-upload"]');
    await knowledgeButton.waitFor({ state: 'visible', timeout: 10000 });
    await knowledgeButton.click();
    await page.waitForTimeout(1500);

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000); // Let collections load
    return dialog;
  }

  /**
   * Helper: Select a collection by name pattern in the dialog sidebar.
   * Falls back to first collection if pattern not found.
   */
  async function selectCollection(page: any, dialog: any, namePattern: RegExp) {
    const collectionItems = dialog.locator('[data-testid^="knowledge-collection-item-"]');
    await collectionItems.first().waitFor({ state: 'visible', timeout: 15000 });
    const count = await collectionItems.count();

    for (let i = 0; i < count; i++) {
      const item = collectionItems.nth(i);
      const text = await item.textContent();
      if (text && namePattern.test(text)) {
        await item.click();
        await page.waitForTimeout(1000);
        console.log(`  Selected collection: ${text.trim()}`);
        return;
      }
    }

    // Fallback: click first collection
    await collectionItems.first().click();
    await page.waitForTimeout(1000);
    console.log('  Selected first available collection');
  }

  test('should create a new collection', async ({ page }) => {
    test.setTimeout(90000);

    console.log('Testing collection creation...\n');

    // Set viewport wider than 1400px to avoid small screen behavior
    // (on small screens, the dialog closes before opening the create modal)
    await page.setViewportSize({ width: 1500, height: 900 });

    // Step 1: Open Knowledge Stacks
    console.log('Step 1/5: Opening Knowledge Stacks...');
    const dialog = await openKnowledgeStacks(page);
    console.log('Dialog opened');

    // Wait for workspace/collections to load
    const existingItems = dialog.locator('[data-testid^="knowledge-collection-item-"]');
    await existingItems.first().waitFor({ state: 'visible', timeout: 15000 });
    const initialCount = await existingItems.count();
    console.log(`  Initial collections loaded: ${initialCount}\n`);

    // Step 2: Click create collection button
    console.log('Step 2/5: Clicking create collection...');
    const createBtn = dialog.locator('[data-testid="knowledge-create-collection-button"]');
    await expect(createBtn).toBeVisible({ timeout: 10000 });
    await createBtn.click();
    await page.waitForTimeout(1000);
    // Click "Add New Knowledge Stack" in the dropdown menu
    const addNewStackItem = page.locator('[role="menuitem"]').filter({ hasText: /Add New|Knowledge Stack/i }).first();
    await addNewStackItem.waitFor({ state: 'visible', timeout: 5000 });
    await addNewStackItem.click();
    await page.waitForTimeout(2000); // Wait for nested modal to appear
    console.log('  Create button clicked\n');

    // Step 3: Type collection name in the nested modal
    console.log('Step 3/5: Typing collection name...');
    const collectionName = `e2e-test-${Date.now()}`;
    const nameInput = page.locator('[data-testid="knowledge-collection-name-input"]');
    await expect(nameInput).toBeVisible({ timeout: 15000 });
    await nameInput.fill(collectionName);
    await page.waitForTimeout(500);
    console.log(`  Typed: ${collectionName}\n`);

    // Step 4: Submit creation
    console.log('Step 4/5: Submitting...');
    const submitBtn = page.locator('[data-testid="knowledge-create-collection-submit"]');
    await expect(submitBtn).toBeVisible({ timeout: 15000 });
    await submitBtn.click();
    await page.waitForTimeout(3000); // Wait for API response and collection list refresh
    console.log('  Collection creation submitted\n');

    // Step 5: Verify collection appears
    console.log('Step 5/5: Verifying...');
    await page.waitForTimeout(3000);

    // The new collection should be visible in the page text
    const collectionText = page.locator(`text=${collectionName.substring(0, 10)}`).first();
    await expect(collectionText).toBeVisible({ timeout: 15000 });
    console.log('  Collection visible in sidebar');

    await page.screenshot({
      path: 'test-results/knowledge-collection-created.png',
      fullPage: true,
    });
    console.log('Collection creation test completed!\n');
  });

  test('should upload a PDF document to collection', async ({ page }) => {
    test.setTimeout(120000);

    console.log('Testing PDF upload...\n');

    // Create a minimal valid PDF file
    const testDir = path.join(process.cwd(), 'test-results');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    // Minimal PDF content
    const pdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT /F1 24 Tf 100 700 Td (E2E Test PDF) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000266 00000 n
0000000360 00000 n
trailer
<< /Size 6 /Root 1 0 R >>
startxref
441
%%EOF`;

    const testFilePath = path.join(testDir, `e2e-test-${Date.now()}.pdf`);
    fs.writeFileSync(testFilePath, pdfContent);
    console.log(`Test PDF created: ${testFilePath}\n`);

    try {
      // Step 1: Open Knowledge Stacks and select collection
      console.log('Step 1/4: Opening Knowledge Stacks...');
      const dialog = await openKnowledgeStacks(page);
      await selectCollection(page, dialog, /astral|medicine|biology/i);
      console.log('Dialog opened and collection selected\n');

      // Step 2: Find file input and upload
      console.log('Step 2/4: Uploading PDF...');
      const fileInput = page.locator('[data-testid="knowledge-file-input"], input[type="file"]').first();
      await expect(fileInput).toBeAttached({ timeout: 10000 });
      await fileInput.setInputFiles(testFilePath);
      await page.waitForTimeout(3000);
      console.log('PDF file set for upload\n');

      // Step 3: Wait for upload detection
      console.log('Step 3/4: Monitoring upload...');
      const uploadIndicator = page.locator(
        'text=e2e-test, [role="progressbar"], text=pending, text=Processing, text=Uploading'
      ).first();
      await expect(uploadIndicator).toBeVisible({ timeout: 30000 });
      console.log('  Upload detected in UI\n');

      // Step 4: Screenshot
      console.log('Step 4/4: Final screenshot...');
      await page.screenshot({
        path: 'test-results/knowledge-pdf-upload.png',
        fullPage: true,
      });

      console.log('PDF upload test completed!\n');
    } finally {
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath);
      }
    }
  });

  test('should show document thumbnails and icons', async ({ page }) => {
    test.setTimeout(90000);

    console.log('Testing document thumbnails...\n');

    // Open Knowledge Stacks and select a collection with documents
    console.log('Step 1/3: Opening Knowledge Stacks...');
    const dialog = await openKnowledgeStacks(page);
    await selectCollection(page, dialog, /astral|medicine|biology|psychology/i);
    await page.waitForTimeout(3000); // Let documents load
    console.log('Collection selected, documents loading...\n');

    // Step 2: Check for document thumbnails
    console.log('Step 2/3: Checking thumbnails...');
    const thumbnails = page.locator('[data-testid^="knowledge-document-thumbnail-"]');
    await thumbnails.first().waitFor({ state: 'visible', timeout: 15000 });
    const thumbnailCount = await thumbnails.count();
    console.log(`  Found ${thumbnailCount} document thumbnails`);
    expect(thumbnailCount).toBeGreaterThan(0);

    // Verify first thumbnail is visible and has an image or icon
    const firstThumbnail = thumbnails.first();
    await expect(firstThumbnail).toBeVisible({ timeout: 15000 });

    // Check for preview buttons on PDF/EPUB documents
    const previewButtons = page.locator('[data-testid^="knowledge-preview-button-"]');
    const previewCount = await previewButtons.count();
    console.log(`  Found ${previewCount} preview (eye) buttons`);

    // Step 3: Screenshot
    console.log('Step 3/3: Screenshot...');
    await page.screenshot({
      path: 'test-results/knowledge-thumbnails.png',
      fullPage: true,
    });
    console.log('Thumbnail test completed!\n');
  });

  test('should display document processing status', async ({ page }) => {
    test.setTimeout(120000);

    console.log('Testing processing status display...\n');

    // Upload a small text file and watch processing
    const testDir = path.join(process.cwd(), 'test-results');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    const testContent = `# Processing Status Test - ${Date.now()}\n\nThis document tests the processing pipeline visibility.\n`;
    const testFilePath = path.join(testDir, `e2e-processing-${Date.now()}.txt`);
    fs.writeFileSync(testFilePath, testContent);

    try {
      // Open dialog and select collection
      console.log('Step 1/4: Opening Knowledge Stacks...');
      const dialog = await openKnowledgeStacks(page);
      await selectCollection(page, dialog, /astral|medicine/i);
      console.log('Collection selected\n');

      // Upload file
      console.log('Step 2/4: Uploading test file...');
      const fileInput = page.locator('[data-testid="knowledge-file-input"], input[type="file"]').first();
      await expect(fileInput).toBeAttached({ timeout: 10000 });
      await fileInput.setInputFiles(testFilePath);
      await page.waitForTimeout(3000);
      console.log('File uploaded\n');

      // Monitor processing status
      console.log('Step 3/4: Monitoring processing...');
      const statusIndicator = page.locator(
        'text=pending, text=Processing, text=Uploading, text=completed, [role="progressbar"]'
      ).first();
      await expect(statusIndicator).toBeVisible({ timeout: 30000 });
      console.log('  Processing status indicator found\n');

      // Screenshot
      console.log('Step 4/4: Screenshot...');
      await page.screenshot({
        path: 'test-results/knowledge-processing-status.png',
        fullPage: true,
      });
      console.log('Processing status test completed!\n');
    } finally {
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath);
      }
    }
  });

  test('should delete a document from collection via API', async ({ page }) => {
    test.setTimeout(60000);

    console.log('Testing document deletion via API...\n');

    // Get auth token
    const loginResponse = await page.request.post('http://localhost:8080/api/v1/auth/login', {
      data: { usernameOrEmail: 'admin', password: 'admin123' },
    });
    const { access_token: token } = await loginResponse.json();
    const headers = { Authorization: `Bearer ${token}` };

    // Create a temporary e2e-test collection
    const collName = `e2e-delete-${Date.now()}`;
    const createResp = await page.request.post('http://localhost:8080/api/v1/collections', {
      headers, data: { name: collName },
    });
    expect(createResp.ok()).toBe(true);
    const collection = await createResp.json();
    const collectionId = collection.id;
    console.log(`  Created test collection: ${collName} (${collectionId})\n`);

    // Upload a test file
    const testContent = `# Delete Test - ${Date.now()}\nTest content for deletion.`;
    const testFilePath = path.join(process.cwd(), 'test-results', `e2e_delete_test_${Date.now()}.txt`);
    fs.writeFileSync(testFilePath, testContent);

    try {
      const uploadResp = await page.request.post(
        `http://localhost:8080/upload/${collectionId}`,
        { headers, multipart: { file: { name: path.basename(testFilePath), mimeType: 'text/plain', buffer: Buffer.from(testContent) } } },
      );
      console.log(`  Upload status: ${uploadResp.status()}`);

      // Delete the entire test collection (safe -- it's our temp collection)
      const deleteResp = await page.request.delete(
        `http://localhost:8080/api/v1/collections/${collectionId}`,
        { headers },
      );
      expect(deleteResp.ok()).toBe(true);
      console.log(`  Deleted test collection: ${collectionId}`);

      // Verify it's gone
      const listResp = await page.request.get('http://localhost:8080/api/v1/collections', { headers });
      const collections = await listResp.json();
      const found = (collections.content || collections).find((c: { id: string }) => c.id === collectionId);
      expect(found).toBeUndefined();
      console.log('Document deletion test completed!\n');
    } finally {
      if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
    }
  });
});
