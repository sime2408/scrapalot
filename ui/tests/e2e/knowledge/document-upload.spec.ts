import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Document Upload E2E Test
 *
 * Tests the document upload flow through Knowledge Stacks:
 * - Open Knowledge Stacks dialog
 * - Select or create a collection
 * - Upload a test document
 * - Verify the document appears in the collection
 *
 * Pipeline: UI -> Gateway (8080) -> Kotlin BE (8091) -> upload storage
 */
test.describe('Document Upload', () => {
  test.beforeEach(async ({ page }) => {
    // Disable welcome tour before navigation
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('should open Knowledge Stacks and verify collections are loaded', async ({ page }) => {
    test.setTimeout(60000);

    console.log('Testing Knowledge Stacks dialog...\n');

    // Step 1: Find and click Knowledge Stacks button in sidebar
    console.log('Step 1/4: Opening Knowledge Stacks...');
    const knowledgeButton = page.locator('[data-tour="knowledge-upload"]');
    await knowledgeButton.waitFor({ state: 'visible', timeout: 10000 });
    await knowledgeButton.click();
    await page.waitForTimeout(1000);
    console.log('Knowledge Stacks button clicked\n');

    // Step 2: Verify dialog opened
    console.log('Step 2/4: Verifying dialog...');
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10000 });
    console.log('Dialog opened\n');

    // Step 3: Verify dialog structure loaded correctly
    console.log('Step 3/4: Checking dialog structure...');
    await page.waitForTimeout(2000); // Allow collections to load

    // Verify key UI elements are present in the dialog
    const dialogTitle = dialog.locator('text=Knowledge Stacks').first();
    const createButton = dialog.locator('[data-testid="knowledge-create-collection-button"], button:has-text("Add New Knowledge Stack")').first();

    await expect(dialogTitle).toBeVisible({ timeout: 15000 });
    console.log('  Dialog title visible');

    await expect(createButton).toBeVisible({ timeout: 15000 });
    console.log('  Create button visible');

    // Check for collection items (may be 0 if workspace has no collections)
    const collectionItems = dialog.locator('[data-testid^="knowledge-collection-item-"]');
    const itemCount = await collectionItems.count();
    console.log(`  Collection items found: ${itemCount}`);

    console.log('Dialog structure loaded successfully\n');

    // Step 4: Take screenshot
    console.log('Step 4/4: Taking screenshot...');
    await page.screenshot({
      path: 'test-results/knowledge-stacks-dialog.png',
      fullPage: true
    });
    console.log('  Screenshot saved\n');

    console.log('Knowledge Stacks test completed!\n');
  });

  test('should upload a test document to a collection', async ({ page }) => {
    test.setTimeout(120000);

    const consoleLogs: string[] = [];
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('upload') || text.includes('Upload') || text.includes('document') || text.includes('Document') || text.includes('progress') || text.includes('error') || text.includes('Error')) {
        console.log(`  Browser: ${text}`);
        consoleLogs.push(text);
      }
    });

    console.log('Testing document upload...\n');

    // Step 1: Create test file
    console.log('Step 1/7: Creating test document...');
    const testContent = `# E2E Test Document - ${Date.now()}

## Introduction
This is an automated test document created by the Playwright E2E test suite.
It tests the complete document upload pipeline through the Knowledge Stacks dialog.

## Content Section
The Scrapalot AI system uses Retrieval-Augmented Generation (RAG) to provide
contextually relevant answers based on uploaded documents.

## Key Features
- Document chunking and embedding
- Vector similarity search
- Multi-strategy RAG orchestration
- Knowledge graph integration

## Conclusion
This test verifies that the upload pipeline functions correctly from
the frontend through the gateway to the backend services.
`;

    const testDir = path.join(process.cwd(), 'test-results');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    const testFilePath = path.join(testDir, `e2e-test-upload-${Date.now()}.txt`);
    fs.writeFileSync(testFilePath, testContent);
    console.log(`Test file created: ${testFilePath}\n`);

    try {
      // Step 2: Open Knowledge Stacks
      console.log('Step 2/7: Opening Knowledge Stacks...');
      const knowledgeButton = page.locator('[data-tour="knowledge-upload"]');
      await knowledgeButton.waitFor({ state: 'visible', timeout: 10000 });
      await knowledgeButton.click();
      await page.waitForTimeout(1500);

      const dialog = page.locator('[role="dialog"]').first();
      await expect(dialog).toBeVisible({ timeout: 10000 });
      console.log('Knowledge Stacks dialog opened\n');

      // Step 3: Select a collection
      console.log('Step 3/7: Selecting collection...');
      const collectionItems = dialog.locator('[data-testid^="knowledge-collection-item-"]');
      await collectionItems.first().waitFor({ state: 'visible', timeout: 15000 });
      await collectionItems.first().click();
      await page.waitForTimeout(1000);
      console.log('  Selected first available collection\n');

      // Step 4: Find the file input
      console.log('Step 4/7: Locating file input...');
      const fileInput = page.locator('input[type="file"]').first();
      await expect(fileInput).toBeAttached({ timeout: 10000 });
      console.log('File input found\n');

      // Step 5: Upload the test file
      console.log('Step 5/7: Uploading test file...');
      await fileInput.setInputFiles(testFilePath);
      await page.waitForTimeout(2000);
      console.log('File selected for upload\n');

      // Step 6: Wait for upload indicator in UI
      console.log('Step 6/7: Monitoring upload...');
      // Wait for any upload indicator: filename, progress bar, status text, or toast
      const uploadIndicator = page.locator(
        'text=e2e-test-upload, [role="progressbar"], text=Processing, text=Uploading, text=pending, text=Upload complete, text=successfully, text=uploaded'
      ).first();
      await expect(uploadIndicator).toBeVisible({ timeout: 30000 });
      console.log('  Upload detected in UI\n');

      // Step 7: Take final screenshot
      console.log('Step 7/7: Final verification...');
      await page.screenshot({
        path: 'test-results/document-upload-result.png',
        fullPage: true
      });
      console.log('  Screenshot saved\n');

      console.log('Document upload E2E test completed!\n');
    } finally {
      // Cleanup test file
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath);
        console.log('  Test file cleaned up');
      }
    }
  });
});
