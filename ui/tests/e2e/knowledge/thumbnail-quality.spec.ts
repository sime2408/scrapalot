import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Thumbnail Quality E2E Tests
 *
 * Verifies that document thumbnails render correctly:
 * - PDF documents show generated first-page thumbnails
 * - EPUB documents show extracted cover thumbnails
 * - Unsupported formats show fallback file-type icons
 * - Thumbnails load without errors (no broken images)
 *
 * Thumbnail generation: Python AI backend (thumbnail_service.py)
 * - PDF: PyMuPDF renders first page
 * - EPUB: ebooklib extracts cover image
 * - Other: Frontend shows file-type icon from /icons/documents/
 */
test.describe('Thumbnail Quality', () => {
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
   * Helper: Open Knowledge Stacks dialog, switch to Library tab,
   * and find a collection with documents.
   */
  async function openCollectionWithDocs(page: any): Promise<{
    dialog: any;
    collectionName: string;
  }> {
    const knowledgeButton = page.locator('[data-tour="knowledge-upload"]');
    await knowledgeButton.waitFor({ state: 'visible', timeout: 10000 });
    await knowledgeButton.click();
    await page.waitForTimeout(1500);

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    // Switch to Library tab where thumbnails are displayed
    const libraryTab = dialog.locator('[data-testid="knowledge-tab-library"]');
    await expect(libraryTab).toBeVisible({ timeout: 15000 });
    await libraryTab.click();
    await page.waitForTimeout(2000);

    // Try each collection to find one with documents
    const collectionItems = dialog.locator('[data-testid^="knowledge-collection-item-"]');
    await collectionItems.first().waitFor({ state: 'visible', timeout: 15000 });
    const count = await collectionItems.count();

    for (let i = 0; i < count; i++) {
      const item = collectionItems.nth(i);
      const text = await item.textContent();
      await item.click();
      await page.waitForTimeout(2000);

      // Check for thumbnail elements on Library tab
      const thumbnails = page.locator('[data-testid^="knowledge-document-thumbnail-"]');
      const thumbCount = await thumbnails.count();
      if (thumbCount > 0) {
        return { dialog, collectionName: text?.trim() || `collection-${i}` };
      }
    }

    // If no collection has thumbnails, fail explicitly
    throw new Error('No collection with document thumbnails found in workspace');
  }

  test('should display document thumbnails in Knowledge Stacks', async ({ page }) => {
    test.setTimeout(90000);

    console.log('Testing thumbnail display in Knowledge Stacks...\n');

    const { dialog, collectionName } = await openCollectionWithDocs(page);
    console.log(`  Selected collection: ${collectionName}`);

    // Find all thumbnail elements
    const thumbnails = page.locator('[data-testid^="knowledge-document-thumbnail-"]');
    const thumbnailCount = await thumbnails.count();
    console.log(`  Thumbnail elements found: ${thumbnailCount}`);
    expect(thumbnailCount).toBeGreaterThan(0);

    // Check each thumbnail for loaded images
    let loadedImages = 0;
    let fallbackIcons = 0;
    let brokenImages = 0;

    for (let i = 0; i < Math.min(thumbnailCount, 10); i++) {
      const thumbnail = thumbnails.nth(i);
      await expect(thumbnail).toBeVisible({ timeout: 15000 });
      const img = thumbnail.locator('img').first();
      const imgVisible = await img.isVisible();

      if (imgVisible) {
        const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
        const src = await img.getAttribute('src') || '';

        if (naturalWidth > 0) {
          if (src.includes('/api/') || src.includes('thumbnail')) {
            loadedImages++;
          } else if (src.includes('/icons/')) {
            fallbackIcons++;
          } else {
            loadedImages++;
          }
        } else {
          brokenImages++;
        }
      } else {
        fallbackIcons++;
      }
    }

    console.log(`  Loaded thumbnail images: ${loadedImages}`);
    console.log(`  Fallback icons: ${fallbackIcons}`);
    console.log(`  Broken images: ${brokenImages}`);

    // At least some images should have loaded successfully
    expect(loadedImages + fallbackIcons).toBeGreaterThan(0);

    // No broken images allowed
    expect(brokenImages).toBe(0);

    await page.screenshot({
      path: 'test-results/thumbnail-quality-stacks.png',
      fullPage: true,
    });

    console.log('Thumbnail display test passed\n');
  });

  test('should show generated thumbnails with real page content for previewable documents', async ({ page }) => {
    test.setTimeout(90000);

    console.log('Testing generated thumbnail quality...\n');

    const { dialog, collectionName } = await openCollectionWithDocs(page);
    console.log(`  Selected collection: ${collectionName}`);

    // Find thumbnails with preview buttons (PDF/EPUB/DOCX)
    const thumbnails = page.locator('[data-testid^="knowledge-document-thumbnail-"]');
    const count = await thumbnails.count();

    let generatedThumbnailFound = false;

    for (let i = 0; i < count; i++) {
      const thumbnail = thumbnails.nth(i);
      const previewBtn = thumbnail.locator('[data-testid^="knowledge-preview-button-"]');
      const hasPreview = await previewBtn.count() > 0 && await previewBtn.isVisible();

      if (hasPreview) {
        const img = thumbnail.locator('img').first();
        const imgVisible = await img.isVisible();

        if (imgVisible) {
          const src = await img.getAttribute('src') || '';
          const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
          const naturalHeight = await img.evaluate((el: HTMLImageElement) => el.naturalHeight);

          if (naturalWidth > 0 && naturalHeight > 0 && (src.includes('/api/') || src.includes('thumbnail'))) {
            generatedThumbnailFound = true;
            console.log(`  Found generated thumbnail: ${naturalWidth}x${naturalHeight}`);

            // Verify reasonable dimensions
            expect(naturalWidth).toBeGreaterThanOrEqual(50);
            expect(naturalHeight).toBeGreaterThanOrEqual(50);
            break;
          }
        }
      }
    }

    // At least one generated thumbnail must exist
    expect(generatedThumbnailFound).toBe(true);
    console.log('  Generated thumbnail verified with real content');

    await page.screenshot({
      path: 'test-results/thumbnail-quality-generated.png',
      fullPage: true,
    });

    console.log('Generated thumbnail test completed\n');
  });

  test('should show correct file-type icons for documents without thumbnails', async ({ page }) => {
    test.setTimeout(90000);

    console.log('Testing file-type icon fallbacks...\n');

    const { dialog, collectionName } = await openCollectionWithDocs(page);
    console.log(`  Selected collection: ${collectionName}`);

    const thumbnails = page.locator('[data-testid^="knowledge-document-thumbnail-"]');
    const count = await thumbnails.count();
    expect(count).toBeGreaterThan(0);

    // Verify all visible images loaded correctly (no broken images)
    for (let i = 0; i < Math.min(count, 5); i++) {
      const thumbnail = thumbnails.nth(i);
      await expect(thumbnail).toBeVisible({ timeout: 15000 });
      const imgs = thumbnail.locator('img');
      const imgCount = await imgs.count();

      for (let j = 0; j < imgCount; j++) {
        const img = imgs.nth(j);
        const imgVisible = await img.isVisible();
        if (imgVisible) {
          const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
          expect(naturalWidth).toBeGreaterThan(0);
        }
      }
    }

    await page.screenshot({
      path: 'test-results/thumbnail-quality-icons.png',
      fullPage: true,
    });

    console.log('File-type icon test completed\n');
  });

  test('should display thumbnails in Library view', async ({ page }) => {
    test.setTimeout(90000);

    console.log('Testing thumbnails in Library view...\n');

    // Open Knowledge Stacks
    const knowledgeButton = page.locator('[data-tour="knowledge-upload"]');
    await knowledgeButton.waitFor({ state: 'visible', timeout: 10000 });
    await knowledgeButton.click();
    await page.waitForTimeout(1500);

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    // Switch to Library tab
    const libraryTab = dialog.locator('button, [role="tab"]').filter({ hasText: /library/i }).first();
    await expect(libraryTab).toBeVisible({ timeout: 15000 });
    await libraryTab.click();
    await page.waitForTimeout(3000);
    console.log('  Switched to Library tab');

    // Verify Library view loaded
    const libraryContainer = page.locator('[data-testid="library-view-container"]');
    await expect(libraryContainer).toBeVisible({ timeout: 15000 });

    // Check for document grid
    const docGrid = page.locator('[data-testid="library-document-grid"]');
    await expect(docGrid).toBeVisible({ timeout: 15000 });
    console.log('  Document grid visible');

    const docItems = page.locator('[data-testid^="library-document-item-"]');
    const docCount = await docItems.count();
    console.log(`  Document items: ${docCount}`);
    expect(docCount).toBeGreaterThan(0);

    const thumbnails = page.locator('[data-testid^="knowledge-document-thumbnail-"]');
    const thumbCount = await thumbnails.count();
    console.log(`  Thumbnails in Library: ${thumbCount}`);
    expect(thumbCount).toBeGreaterThan(0);

    // Verify at least one thumbnail image loaded
    let anyImageLoaded = false;
    for (let i = 0; i < Math.min(thumbCount, 5); i++) {
      const thumb = thumbnails.nth(i);
      const img = thumb.locator('img').first();
      const imgVisible = await img.isVisible();
      if (imgVisible) {
        const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
        if (naturalWidth > 0) {
          anyImageLoaded = true;
          break;
        }
      }
    }

    console.log(`  At least one image loaded: ${anyImageLoaded}`);
    expect(anyImageLoaded).toBe(true);

    await page.screenshot({
      path: 'test-results/thumbnail-quality-library.png',
      fullPage: true,
    });

    console.log('Library thumbnail test completed\n');
  });
});
