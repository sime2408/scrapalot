import { test, expect } from '@playwright/test';
import path from 'path';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Media transcription (chat popover) E2E.
 *
 * The chat attachment popover's "Media" tab lets the user upload any audio/video
 * file (not just YouTube). The file is transcribed server-side with Whisper and
 * the transcript is attached as a document for the current message.
 *
 * This drives the real flow: open popover → Media tab → upload an audio fixture →
 * wait for Whisper transcription → assert the transcript attached (Done count +
 * the document chip under the Documents tab).
 */
const AUDIO_FIXTURE = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'chat', 'lecture.mp3');

test.describe('Chat media transcription', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('uploads audio in the Media tab and attaches the Whisper transcript', async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 1440, height: 900 }); // desktop popover, not the narrow dialog

    const newConversation = page.locator('[data-testid="sidebar-new-conversation-button"]');
    await expect(newConversation).toBeVisible({ timeout: 10000 });
    await newConversation.click();

    // Open the attachment popover
    const attachButton = page.locator('[data-testid="chat-toolbar-attach-files-standalone-button"]');
    await expect(attachButton).toBeVisible({ timeout: 10000 });
    await attachButton.click();

    // Switch to the Media tab (data-testid kept as 'youtube' for back-compat)
    const mediaTab = page.locator('[data-testid="chat-file-tab-youtube"]');
    await expect(mediaTab).toBeVisible({ timeout: 5000 });
    await mediaTab.click();

    // The audio/video dropzone is the top section of the Media tab
    await expect(page.locator('[data-testid="media-upload-dropzone"]')).toBeVisible();

    // Upload into the media file input (its accept includes audio/*, which
    // disambiguates it from the document and image inputs that forceMount keeps
    // in the DOM).
    const mediaInput = page.locator('input[type="file"][accept*="audio"]');
    await expect(mediaInput).toBeAttached({ timeout: 5000 });
    await mediaInput.setInputFiles(AUDIO_FIXTURE);

    // Whisper transcription runs server-side. On success the transcript attaches
    // as a document — a "lecture.mp3" pill appears (locale-independent assertion)
    // and the Documents tab shows a count badge of 1.
    await expect(page.getByText('lecture.mp3').first()).toBeVisible({ timeout: 120000 });
    await expect(page.locator('[data-testid="chat-file-tab-documents"]')).toContainText('1');
  });
});
