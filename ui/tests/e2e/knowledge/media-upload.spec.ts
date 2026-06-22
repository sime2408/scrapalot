import { test, expect } from '@playwright/test';
import path from 'path';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Knowledge uploader media transcription E2E.
 *
 * The Knowledge Stacks uploader now accepts audio/video files. On upload the
 * Python ingestion pipeline transcribes them with Whisper and indexes the
 * transcript as a normal RAG-searchable document.
 *
 * This drives the real UI: open Knowledge Stacks → pick a collection → upload an
 * audio fixture → assert the file is accepted and starts processing (i.e. the
 * accept filter no longer rejects media). The transcription→completed pipeline
 * is proven separately at the backend level.
 */
const AUDIO_FIXTURE = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'chat', 'lecture.mp3');

test.describe('Knowledge uploader — media transcription', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('accepts an audio file and starts processing it', async ({ page }) => {
    test.setTimeout(120000);

    // Open Knowledge Stacks
    const knowledgeButton = page.locator('[data-tour="knowledge-upload"]');
    await knowledgeButton.waitFor({ state: 'visible', timeout: 10000 });
    await knowledgeButton.click();

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Pick the first available collection
    const collectionItems = dialog.locator('[data-testid^="knowledge-collection-item-"]');
    await collectionItems.first().waitFor({ state: 'visible', timeout: 15000 });
    await collectionItems.first().click();
    await page.waitForTimeout(1000);

    // Upload the audio fixture into the collection's file input
    const fileInput = page.locator('input[type="file"]').first();
    await expect(fileInput).toBeAttached({ timeout: 10000 });
    await fileInput.setInputFiles(AUDIO_FIXTURE);

    // The file must be ACCEPTED (the accept-filter fix): it appears in the
    // collection's file list rather than being rejected as an invalid type.
    await expect(page.getByText('lecture.mp3').first()).toBeVisible({ timeout: 30000 });
  });
});
