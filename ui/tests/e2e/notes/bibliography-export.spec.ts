import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Z-02: Bibliography Export E2E Tests
 *
 * Tests bibliography export buttons in notes editor, export dialog format options
 * (BibTeX, RIS, CSV, Markdown), and the Markdown+BibTeX download from notes toolbar.
 *
 * Prerequisites: Integration Test collection with at least one document.
 */

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

async function openNotesDrawer(page: any) {
  const notesToggle = page.locator('[data-testid="notes-toggle-button"]');
  await notesToggle.waitFor({ state: 'visible', timeout: 15000 });
  await notesToggle.click();
  const drawer = page.locator('[data-testid="notes-drawer"]');
  await expect(drawer).toBeVisible({ timeout: 10000 });
  const editor = page.locator('.ProseMirror');
  await expect(editor).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(2000);
}

async function triggerSlashCommandAndSelect(page: any, filterText: string, optionText: string) {
  const editor = page.locator('[data-testid="notes-editor"] .tiptap, [data-testid="notes-editor"] .ProseMirror');
  await editor.click();
  await page.waitForTimeout(500);

  // Ensure we are on an empty line
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  // Type / to trigger slash command menu
  await page.keyboard.type('/');
  await page.waitForTimeout(1500);

  // Slash menu MUST appear - strict assertion
  const slashMenu = page.locator('[data-testid^="slash-command-"]').first()
    .or(page.locator('.slash-command-menu, [role="listbox"]').first());
  await expect(slashMenu).toBeVisible({ timeout: 15000 });

  // Filter to the desired command
  await page.keyboard.type(filterText);
  await page.waitForTimeout(500);

  // The option MUST be visible - strict assertion
  const option = page.locator(`text=${optionText}`).first();
  await expect(option).toBeVisible({ timeout: 10000 });
  await option.click();
  await page.waitForTimeout(1000);
}

async function openKnowledgeLibraryAndDocument(page: any) {
  // Open knowledge library
  const knowledgeBtn = page.locator('[data-testid="sidebar-quick-tools-knowledge-button"]');
  await expect(knowledgeBtn).toBeVisible({ timeout: 10000 });
  await knowledgeBtn.click();
  await page.waitForTimeout(1000);

  // Click first collection - MUST have at least one
  const items = page.locator('[data-testid^="knowledge-collection-item"]');
  await expect(items.first()).toBeVisible({ timeout: 10000 });
  await items.first().click();
  await page.waitForTimeout(1000);

  // Switch to Library tab
  const libraryTab = page.locator('[data-testid="knowledge-tab-library"]');
  await expect(libraryTab).toBeVisible({ timeout: 10000 });
  await libraryTab.click();
  await page.waitForTimeout(2000);

  // Documents MUST exist
  const docs = page.locator('[data-testid^="library-document-item-"]');
  await expect(docs.first()).toBeVisible({ timeout: 15000 });
  return docs;
}

async function openDocumentExportDialog(page: any) {
  const docs = await openKnowledgeLibraryAndDocument(page);

  // Hover on first document to reveal menu
  await docs.first().hover();
  await page.waitForTimeout(500);

  // Click the context menu button
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
  return exportDialog;
}

test.describe('Bibliography Export (Z-02)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('should render bibliography node with no-citations message', async ({ page }) => {
    test.setTimeout(120000);

    await startConversationAndSendMessage(page, 'test bibliography export');
    await openNotesDrawer(page);

    // Insert bibliography via slash command - MUST succeed
    await triggerSlashCommandAndSelect(page, 'biblio', 'Bibliography');

    // Wait for the node to render
    await page.waitForTimeout(2000);

    // Bibliography node MUST be visible
    const bibNode = page.locator('[data-testid="bibliography-node"]');
    await expect(bibNode).toBeVisible({ timeout: 15000 });

    // MUST show "no citations" message since we have not inserted any
    const noCitations = bibNode.locator('text=No citations');
    await expect(noCitations).toBeVisible({ timeout: 10000 });

    // Export buttons MUST NOT be visible when there are no citations
    const exportBtn = page.locator('[data-testid="bibliography-export-button"]');
    await expect(exportBtn).not.toBeVisible({ timeout: 5000 });
  });

  test('should show Markdown format in export dialog', async ({ page }) => {
    test.setTimeout(60000);

    const exportDialog = await openDocumentExportDialog(page);

    // Open format selector
    const formatSelect = page.locator('[data-testid="export-format-select"]');
    await expect(formatSelect).toBeVisible({ timeout: 10000 });
    await formatSelect.click();
    await page.waitForTimeout(500);

    // Markdown option MUST be available
    const markdownOption = page.locator('text=Markdown (.md)');
    await expect(markdownOption).toBeVisible({ timeout: 10000 });

    // BibTeX option MUST also be available
    const bibtexOption = page.locator('text=BibTeX (.bib)');
    await expect(bibtexOption).toBeVisible({ timeout: 10000 });

    // Select Markdown and verify preview updates
    await markdownOption.click();
    await page.waitForTimeout(2000);

    // Preview MUST have content
    const preview = exportDialog.locator('pre');
    await expect(preview).toBeVisible({ timeout: 10000 });
    const previewText = await preview.textContent();
    expect(previewText).toBeTruthy();
    expect(previewText!.length).toBeGreaterThan(0);
  });

  test('should have download markdown button in notes toolbar', async ({ page }) => {
    test.setTimeout(120000);

    await startConversationAndSendMessage(page, 'test markdown download');
    await openNotesDrawer(page);

    // The Markdown download button MUST be accessible - either directly or via mobile menu
    const mdButton = page.locator('[data-testid="notes-download-markdown-button"]');
    const mobileMenu = page.locator('[data-testid="notes-mobile-menu-button"]');

    // Try desktop button first, then mobile menu
    try {
      await mdButton.waitFor({ state: 'visible', timeout: 5000 });
      await expect(mdButton).toBeVisible();
    } catch {
      // In mobile layout, open the menu first
      await expect(mobileMenu).toBeVisible({ timeout: 10000 });
      await mobileMenu.click();
      await page.waitForTimeout(500);

      // Markdown button MUST be in the mobile menu
      const mdMenuItem = page.locator('[data-testid="notes-download-markdown-button"]');
      await expect(mdMenuItem).toBeVisible({ timeout: 10000 });
    }
  });

  test('should have export formats: BibTeX, RIS, CSV, Markdown', async ({ page }) => {
    test.setTimeout(60000);

    const exportDialog = await openDocumentExportDialog(page);

    // Open format dropdown
    const formatSelect = page.locator('[data-testid="export-format-select"]');
    await expect(formatSelect).toBeVisible({ timeout: 10000 });
    await formatSelect.click();
    await page.waitForTimeout(500);

    // All 4 formats MUST be present - strict assertions
    await expect(page.locator('text=BibTeX (.bib)')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=RIS (.ris)')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=CSV (.csv)')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Markdown (.md)')).toBeVisible({ timeout: 10000 });
  });

  test('should open import BibTeX dialog via slash command', async ({ page }) => {
    test.setTimeout(120000);

    await startConversationAndSendMessage(page, 'test bibtex import');
    await openNotesDrawer(page);

    // Insert "Import BibTeX" via slash command - MUST succeed
    await triggerSlashCommandAndSelect(page, 'import bib', 'Import BibTeX');

    // BibTeX import dialog MUST open
    const dialog = page.locator('[data-testid="bibtex-import-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    // Paste textarea MUST be present
    const textarea = page.locator('[data-testid="bibtex-paste-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 10000 });
  });

  test('should parse pasted BibTeX and show preview', async ({ page }) => {
    test.setTimeout(120000);

    await startConversationAndSendMessage(page, 'test bibtex parse');
    await openNotesDrawer(page);

    // Open import dialog via slash command - MUST succeed
    await triggerSlashCommandAndSelect(page, 'import bib', 'Import BibTeX');

    // Dialog MUST be visible
    const dialog = page.locator('[data-testid="bibtex-import-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    // Paste sample BibTeX into the textarea
    const textarea = page.locator('[data-testid="bibtex-paste-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 10000 });
    const sampleBibtex = '@article{Smith2023,\n  author = {John Smith and Jane Doe},\n  title = {A Study on AI},\n  journal = {Nature},\n  year = {2023},\n  volume = {42},\n  pages = {1-10}\n}';
    await textarea.fill(sampleBibtex);
    await page.waitForTimeout(500);

    // Click Parse button - MUST exist
    const parseBtn = dialog.locator('button:has-text("Parse")');
    await expect(parseBtn).toBeVisible({ timeout: 10000 });
    await parseBtn.click();
    await page.waitForTimeout(2000);

    // Preview table MUST appear with the parsed entry
    const previewTable = page.locator('[data-testid="bibtex-preview-table"]');
    await expect(previewTable).toBeVisible({ timeout: 15000 });

    // Verify the parsed entry contains the expected content
    const entryText = await previewTable.textContent();
    expect(entryText).toContain('A Study on AI');

    // Import button MUST be visible after successful parse
    const importBtn = page.locator('[data-testid="bibtex-import-button"]');
    await expect(importBtn).toBeVisible({ timeout: 10000 });
  });
});
