import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Document Viewer E2E Tests
 *
 * Tests document viewing functionality:
 * - Open PDF viewer from Knowledge Stacks
 * - Close PDF viewer
 * - Library view with document grid
 *
 * Viewers open as drawer overlays with z-index 1700.
 * PDF/EPUB/DOCX viewers use context dispatch (OPEN_PDF_VIEWER etc.)
 */
test.describe('Document Viewer', () => {
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
   * Helper: Open Knowledge Stacks dialog
   */
  async function openKnowledgeStacks(page: any) {
    const knowledgeButton = page.locator('[data-tour="knowledge-upload"]');
    await knowledgeButton.waitFor({ state: 'visible', timeout: 10000 });
    await knowledgeButton.click();
    await page.waitForTimeout(1500);

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);
    return dialog;
  }

  /**
   * Helper: Select a collection with existing documents
   */
  async function selectCollectionWithDocs(page: any, dialog: any) {
    const collectionItems = dialog.locator('[data-testid^="knowledge-collection-item-"]');
    await collectionItems.first().waitFor({ state: 'visible', timeout: 15000 });
    const count = await collectionItems.count();

    // Try known collections that likely have documents
    const targetCollections = ['astral', 'medicine', 'biology', 'physics', 'psychology'];
    for (const name of targetCollections) {
      for (let i = 0; i < count; i++) {
        const item = collectionItems.nth(i);
        const text = await item.textContent();
        if (text && text.toLowerCase().includes(name)) {
          await item.click();
          await page.waitForTimeout(2000);
          return text.trim();
        }
      }
    }

    // Fallback: click first collection
    await collectionItems.first().click();
    await page.waitForTimeout(2000);
    return 'first collection';
  }

  test('should open PDF viewer from Knowledge Stacks', async ({ page }) => {
    test.setTimeout(120000);

    console.log('Testing PDF viewer opening...\n');

    // Step 1: Open Knowledge Stacks
    console.log('Step 1/4: Opening Knowledge Stacks...');
    const dialog = await openKnowledgeStacks(page);
    const selected = await selectCollectionWithDocs(page, dialog);
    console.log(`  Selected: ${selected}\n`);

    // Step 2: Wait for documents and find preview button
    console.log('Step 2/4: Looking for PDF preview button...');
    await page.waitForTimeout(3000); // Let documents render

    // Look for preview buttons (only on PDF/EPUB/DOCX files)
    const previewButtons = page.locator('[data-testid^="knowledge-preview-button-"]');
    await previewButtons.first().waitFor({ state: 'visible', timeout: 15000 });
    const previewCount = await previewButtons.count();
    console.log(`  Found ${previewCount} preview buttons`);
    expect(previewCount).toBeGreaterThan(0);

    // Step 3: Click the first preview button
    console.log('Step 3/4: Clicking preview button...');
    await previewButtons.first().click();
    await page.waitForTimeout(3000);

    // Step 4: Verify a viewer opened (PDF, EPUB, or DOCX)
    console.log('Step 4/4: Verifying viewer...');
    const anyViewer = page.locator(
      '[data-testid="pdf-viewer-drawer"], [data-testid="epub-viewer-drawer"], [data-testid="docx-viewer-drawer"]'
    ).first();
    await expect(anyViewer).toBeVisible({ timeout: 15000 });
    console.log('  Document viewer opened');

    // Verify the viewer has a title element
    const viewerTitle = page.locator(
      '[data-testid="pdf-viewer-title"], [data-testid="epub-viewer-title"], [data-testid="docx-viewer-title"]'
    ).first();
    await expect(viewerTitle).toBeVisible({ timeout: 15000 });
    console.log('  Viewer title visible');

    await page.screenshot({
      path: 'test-results/knowledge-viewer-open.png',
      fullPage: true,
    });
    console.log('PDF viewer test completed!\n');
  });

  test('should close document viewer', async ({ page }) => {
    test.setTimeout(120000);

    console.log('Testing viewer close...\n');

    // Open Knowledge Stacks and find a previewable document
    console.log('Step 1/3: Opening viewer...');
    const dialog = await openKnowledgeStacks(page);
    await selectCollectionWithDocs(page, dialog);
    await page.waitForTimeout(3000);

    // Open a viewer
    const previewButtons = page.locator('[data-testid^="knowledge-preview-button-"]');
    await previewButtons.first().waitFor({ state: 'visible', timeout: 15000 });
    await previewButtons.first().click();
    await page.waitForTimeout(3000);

    // Verify viewer is open
    const anyViewer = page.locator(
      '[data-testid="pdf-viewer-drawer"], [data-testid="epub-viewer-drawer"], [data-testid="docx-viewer-drawer"]'
    ).first();
    await expect(anyViewer).toBeVisible({ timeout: 15000 });

    // Step 2: Close viewer via Escape (X button removed)
    console.log('Step 2/3: Closing viewer...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    // Step 3: Verify viewer closed
    console.log('Step 3/3: Verifying closed...');
    await expect(anyViewer).not.toBeVisible({ timeout: 15000 });
    console.log('  Viewer closed successfully');

    await page.screenshot({
      path: 'test-results/knowledge-viewer-closed.png',
      fullPage: true,
    });
    console.log('Viewer close test completed!\n');
  });

  test('should display Library view with document grid', async ({ page }) => {
    test.setTimeout(90000);

    console.log('Testing Library view...\n');

    // Open Knowledge Stacks
    console.log('Step 1/4: Opening Knowledge Stacks...');
    const dialog = await openKnowledgeStacks(page);
    console.log('Dialog opened\n');

    // Step 2: Switch to Library tab
    console.log('Step 2/4: Switching to Library tab...');
    const libraryTab = dialog.locator('button, div, [role="tab"]').filter({ hasText: /library/i }).first();
    await expect(libraryTab).toBeVisible({ timeout: 15000 });
    await libraryTab.click();
    await page.waitForTimeout(3000);
    console.log('  Switched to Library tab');

    // Step 3: Verify library view elements
    console.log('Step 3/4: Checking Library view...');
    const libraryContainer = page.locator('[data-testid="library-view-container"]');
    await expect(libraryContainer).toBeVisible({ timeout: 15000 });
    console.log('  Library container visible');

    // Check for document grid
    const docGrid = page.locator('[data-testid="library-document-grid"]');
    await expect(docGrid).toBeVisible({ timeout: 15000 });
    console.log('  Document grid visible');

    // Count document items
    const docItems = page.locator('[data-testid^="library-document-item-"]');
    const docCount = await docItems.count();
    console.log(`  Document items found: ${docCount}`);
    expect(docCount).toBeGreaterThan(0);

    // Check search input
    const searchInput = page.locator('[data-testid="library-search-input"]');
    await expect(searchInput).toBeVisible({ timeout: 15000 });
    console.log('  Search input visible');

    // Check collection filter
    const collectionFilter = page.locator('[data-testid="library-collection-filter"]');
    await expect(collectionFilter).toBeVisible({ timeout: 15000 });
    console.log('  Collection filter visible');

    // Step 4: Screenshot
    console.log('Step 4/4: Screenshot...');
    await page.screenshot({
      path: 'test-results/knowledge-library-view.png',
      fullPage: true,
    });
    console.log('Library view test completed!\n');
  });
});
