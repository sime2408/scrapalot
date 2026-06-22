import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Z-01/Z-02: Citation Generation & BibTeX Export E2E Tests
 *
 * Tests the citation workflow: copy citation from library, /cite slash command
 * in notes editor, citation picker dialog, and BibTeX export.
 *
 * Prerequisites: Integration Test collection with croatia_benefits.pdf
 * (must have enriched metadata from PRD-02 auto-enrichment).
 */

async function openKnowledgeLibrary(page: any) {
  const knowledgeBtn = page.locator('[data-testid="sidebar-quick-tools-knowledge-button"]');
  await expect(knowledgeBtn).toBeVisible({ timeout: 10000 });
  await knowledgeBtn.click();
  await page.waitForTimeout(1000);

  // Click Integration Test collection - MUST find it
  const items = page.locator('[data-testid^="knowledge-collection-item"]');
  await expect(items.first()).toBeVisible({ timeout: 10000 });
  const count = await items.count();
  let found = false;
  for (let i = 0; i < count; i++) {
    const text = await items.nth(i).textContent();
    if (text?.includes('Integration Test')) {
      await items.nth(i).click();
      found = true;
      break;
    }
  }
  expect(found).toBe(true);
  await page.waitForTimeout(1000);

  // Switch to Library tab
  const libraryTab = page.locator('[data-testid="knowledge-tab-library"]');
  await expect(libraryTab).toBeVisible({ timeout: 10000 });
  await libraryTab.click();
  await page.waitForTimeout(2000);
}

async function startConversationAndSendMessage(page: any, message: string) {
  const startNewBtn = page.locator('button:has-text("Start new conversation")');
  const chatInput = page.locator('[data-testid="chat-input"]');

  // Try waiting for chat input first; if not visible, start a new conversation
  try {
    await chatInput.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    await startNewBtn.waitFor({ state: 'visible', timeout: 10000 });
    await startNewBtn.click();
  }

  await chatInput.waitFor({ state: 'visible', timeout: 15000 });
  await chatInput.fill(message);
  const sendButton = page.locator('[data-testid="chat-send-button"]');
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="chat-send-button"]');
      return btn && !btn.hasAttribute('disabled');
    },
    { timeout: 10000 }
  );
  await sendButton.click();
  await expect(chatInput).not.toBeDisabled({ timeout: 60000 });
  await page.waitForTimeout(2000);
}

test.describe('Citation & Export', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('should show Copy Citation submenu for document with metadata', async ({ page }) => {
    test.setTimeout(60000);

    await openKnowledgeLibrary(page);

    // Find a document and open its context menu
    const docMenuButton = page.locator('[data-testid^="library-document-menu-"]').first();
    const docs = page.locator('[data-testid^="library-document-item-"]');

    // Documents MUST exist in the library
    await expect(docs.first()).toBeVisible({ timeout: 15000 });

    // Open context menu - try testid first, then hover approach
    try {
      await docMenuButton.waitFor({ state: 'visible', timeout: 3000 });
      await docMenuButton.click();
    } catch {
      // Hover on first document to reveal menu button
      await docs.first().hover();
      await page.waitForTimeout(500);
      const menuBtn = docs.first().locator('button').last();
      await menuBtn.click();
    }
    await page.waitForTimeout(500);

    // "Copy Citation" menu item MUST be visible
    const copyCitationItem = page.locator('text=Copy Citation').or(page.locator('[data-testid="copy-citation-menu"]'));
    await expect(copyCitationItem).toBeVisible({ timeout: 10000 });
    await copyCitationItem.click();

    // Citation style submenu MUST show APA option
    const apaOption = page.locator('text=APA');
    await expect(apaOption).toBeVisible({ timeout: 10000 });
  });

  test('should open citation picker via /cite slash command in notes', async ({ page }) => {
    test.setTimeout(120000);

    // Send a message first (notes button only visible after chat message)
    await startConversationAndSendMessage(page, 'test for citation feature');

    // Open notes drawer
    const notesToggle = page.locator('[data-testid="notes-toggle-button"]');
    await expect(notesToggle).toBeVisible({ timeout: 15000 });
    await notesToggle.click();
    await page.waitForTimeout(2000);

    // Create new note
    const newNoteBtn = page.locator('[data-testid="notes-new-button"]');
    await expect(newNoteBtn).toBeVisible({ timeout: 10000 });
    await newNoteBtn.click();
    await page.waitForTimeout(1000);

    // Focus the editor and type / to trigger slash command menu
    const editor = page.locator('[data-testid="notes-editor"] .tiptap, [data-testid="notes-editor"] .ProseMirror');
    await expect(editor).toBeVisible({ timeout: 15000 });
    await editor.click();
    await page.waitForTimeout(500);

    // Press Enter to create a new empty line, then type /
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('/');
    await page.waitForTimeout(1500);

    // Slash command menu MUST appear
    const slashMenu = page.locator('[data-testid^="slash-command-"]').first()
      .or(page.locator('.slash-command-menu, [role="listbox"]').first());
    await expect(slashMenu).toBeVisible({ timeout: 15000 });

    // Type 'cite' to filter to Citation command
    await page.keyboard.type('cite');
    await page.waitForTimeout(500);

    // Citation option MUST be visible
    const citationOption = page.locator('text=Citation').first();
    await expect(citationOption).toBeVisible({ timeout: 10000 });
    await citationOption.click();
    await page.waitForTimeout(1000);

    // Citation picker dialog MUST open
    const pickerDialog = page.locator('[data-testid="citation-picker-dialog"]');
    await expect(pickerDialog).toBeVisible({ timeout: 15000 });
  });

  test('should export documents as BibTeX', async ({ page }) => {
    test.setTimeout(60000);

    await openKnowledgeLibrary(page);

    // Documents MUST exist
    const docs = page.locator('[data-testid^="library-document-item-"]');
    await expect(docs.first()).toBeVisible({ timeout: 15000 });

    // Hover on first document to reveal context menu
    await docs.first().hover();
    await page.waitForTimeout(500);

    // Click context menu button
    const menuBtn = docs.first().locator('button').last();
    await menuBtn.click();
    await page.waitForTimeout(500);

    // Export menu item MUST be visible
    const exportItem = page.locator('text=Export').or(page.locator('[data-testid="export-menu-item"]'));
    await expect(exportItem).toBeVisible({ timeout: 10000 });
    await exportItem.click();
    await page.waitForTimeout(1000);

    // Export dialog MUST open
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 10000 });

    // BibTeX format option MUST be available
    const bibtexOption = page.locator('text=BibTeX');
    await expect(bibtexOption).toBeVisible({ timeout: 10000 });
  });
});
