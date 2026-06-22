import { test, expect, Page, BrowserContext } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Helper: Start a new conversation and send a message.
 * After login, the dashboard shows "No conversation selected".
 * We must click "Start new conversation" first to get the chat input.
 */
async function startConversationAndSendMessage(page: Page, message: string) {
  const startNewBtn = page.locator('button:has-text("Start new conversation")');
  const chatInput = page.locator('[data-testid="chat-input"]');

  const inputVisible = await chatInput.isVisible({ timeout: 3000 }).catch(() => false);
  if (!inputVisible) {
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

/**
 * Helper: Set up a browser context with tour disabled and login.
 */
async function setupContext(browser: any, email: string, password: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.addInitScript(() => {
    localStorage.setItem('scrapalot_tour_completed', 'true');
  });

  const basePage = new BasePage(page);
  await basePage.login(email, password);

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  return { context, page };
}

/**
 * Helper: Open notes drawer and wait for editor to initialize.
 */
async function openNotesDrawer(page: Page): Promise<void> {
  const notesToggle = page.locator('[data-testid="notes-toggle-button"]');
  await notesToggle.waitFor({ state: 'visible', timeout: 15000 });
  await notesToggle.click();

  const drawer = page.locator('[data-testid="notes-drawer"]');
  await expect(drawer).toBeVisible({ timeout: 10000 });

  const editor = page.locator('.ProseMirror');
  await expect(editor).toBeVisible({ timeout: 15000 });

  // Wait for WebSocket connection to establish
  await page.waitForTimeout(3000);
}

test.describe('Notes WebSocket Collaboration', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('should establish WebSocket connection for collaboration', async ({ page }) => {
    test.setTimeout(120000);

    const wsLogs: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (
        text.includes('[NotesDrawer]') ||
        text.includes('CollaborationHeader') ||
        text.includes('WebSocket') ||
        text.includes('Y.js') ||
        text.includes('wsProvider')
      ) {
        wsLogs.push(text);
      }
    });

    await startConversationAndSendMessage(page, 'test websocket');

    const notesToggle = page.locator('[data-testid="notes-toggle-button"]');
    await notesToggle.waitFor({ state: 'visible', timeout: 10000 });
    await notesToggle.click();

    const notesDrawer = page.locator('[data-testid="notes-drawer"]');
    await expect(notesDrawer).toBeVisible({ timeout: 10000 });

    const editor = page.locator('.ProseMirror');
    await expect(editor).toBeVisible({ timeout: 15000 });

    await page.waitForTimeout(5000);

    const collabHeader = page.locator('[data-testid="collaboration-header"]');
    await expect(collabHeader).toBeVisible({ timeout: 10000 });

    const connectionStatus = page.locator('[data-testid="connection-status"]');
    await expect(connectionStatus).toBeVisible({ timeout: 5000 });

    console.log(`Captured ${wsLogs.length} notes-related console logs`);

    const statusText = await connectionStatus.textContent();
    expect(statusText).toBeTruthy();
    expect(statusText!.length).toBeGreaterThan(0);

    await page.screenshot({
      path: 'test-results/notes-websocket-connection.png',
      fullPage: true,
    });

    await page.keyboard.press('Escape');
  });

  test('should show user presence in collaboration header', async ({ page }) => {
    test.setTimeout(120000);

    await startConversationAndSendMessage(page, 'test presence');

    const notesToggle = page.locator('[data-testid="notes-toggle-button"]');
    await notesToggle.waitFor({ state: 'visible', timeout: 10000 });
    await notesToggle.click();

    const notesDrawer = page.locator('[data-testid="notes-drawer"]');
    await expect(notesDrawer).toBeVisible({ timeout: 10000 });

    const editor = page.locator('.ProseMirror');
    await expect(editor).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const collabHeader = page.locator('[data-testid="collaboration-header"]');
    await expect(collabHeader).toBeVisible({ timeout: 10000 });

    const headerText = await collabHeader.textContent();
    expect(headerText).toBeTruthy();
    expect(headerText!.length).toBeGreaterThan(3);

    await page.screenshot({
      path: 'test-results/notes-user-presence.png',
      fullPage: true,
    });

    await editor.click();
    await page.keyboard.type('typing indicator test', { delay: 50 });
    await page.waitForTimeout(500);

    const editorContent = await editor.textContent();
    expect(editorContent).toContain('typing indicator test');

    await page.screenshot({
      path: 'test-results/notes-typing-activity.png',
      fullPage: true,
    });

    await page.keyboard.press('Escape');
  });

  test('should sync content between two users in real-time', async ({ browser }) => {
    test.setTimeout(180000);

    // Use ONE browser context with TWO pages (simulates two browser tabs)
    // Both pages share cookies/localStorage/auth - same user, two tabs
    const context = await browser.newContext();

    try {
      // Page 1: Login and start conversation
      const page1 = await context.newPage();
      await page1.addInitScript(() => {
        localStorage.setItem('scrapalot_tour_completed', 'true');
      });
      const basePage1 = new BasePage(page1);
      await basePage1.login(TEST_EMAIL, TEST_PASSWORD);
      await page1.waitForLoadState('networkidle');
      await page1.waitForTimeout(1000);

      // Capture session ID from page1's API requests
      let capturedSessionId: string | null = null;
      page1.on('request', (request) => {
        const url = request.url();
        const match = url.match(/[?&]sessionId=([a-f0-9-]{36})/i);
        if (match) capturedSessionId = match[1];
      });

      // Page 1: Start conversation and send message
      await startConversationAndSendMessage(page1, 'collab sync test');
      expect(capturedSessionId).toBeTruthy();

      // Page 1: Open notes drawer
      await openNotesDrawer(page1);

      // CRITICAL: Save the note to create a real noteId in the database.
      // Without saving, noteId falls back to sessionId, and the backend rejects
      // WebSocket connections for IDs not found in the notes table (code 4004).
      const editor1 = page1.locator('.ProseMirror');
      await editor1.click();
      await page1.keyboard.type('Initial note content', { delay: 30 });

      const saveButton = page1.locator('[data-testid="notes-save-button"]');
      await saveButton.click();

      // Wait for save to complete and Y.js WebSocket to reconnect with real noteId
      await page1.waitForTimeout(5000);

      // Page 2: Open a new tab in the same context (shares auth tokens + localStorage)
      const page2 = await context.newPage();
      await page2.addInitScript(() => {
        localStorage.setItem('scrapalot_tour_completed', 'true');
        // Clear sessions cache so page2 fetches fresh sidebar data including the new conversation
        try {
          const cache = JSON.parse(localStorage.getItem('scrapalot_cache_data') || '{}');
          Object.keys(cache).forEach(key => {
            if (key.includes('sessions')) delete cache[key];
          });
          localStorage.setItem('scrapalot_cache_data', JSON.stringify(cache));
        } catch {}
      });

      // Navigate to dashboard and wait for sessions API to return data
      const sessionsApiPromise = page2.waitForResponse(
        resp => resp.url().includes('/sessions') && resp.status() === 200,
        { timeout: 30000 }
      );
      await page2.goto('/dashboard');
      await sessionsApiPromise;
      await page2.waitForTimeout(2000);

      // Click the topmost conversation in the sidebar list
      const sidebarItem = page2.locator('li button').first();
      let sidebarVisible = await sidebarItem.isVisible().catch(() => false);
      if (!sidebarVisible) {
        await page2.reload();
        await page2.waitForLoadState('networkidle');
        await page2.waitForTimeout(3000);
      }
      await sidebarItem.waitFor({ state: 'visible', timeout: 15000 });
      await sidebarItem.click();
      await page2.waitForTimeout(3000);

      // Verify conversation loaded (chat input visible indicates an active conversation)
      const chatInputPage2 = page2.locator('[data-testid="chat-input"]');
      await expect(chatInputPage2).toBeVisible({ timeout: 15000 });

      // Page 2: Open notes drawer (same conversation → same noteId via localStorage → same Y.js room)
      await openNotesDrawer(page2);

      // Verify both have collaboration headers with connection status
      const status1 = page1.locator('[data-testid="connection-status"]');
      const status2 = page2.locator('[data-testid="connection-status"]');
      await expect(status1).toBeVisible({ timeout: 10000 });
      await expect(status2).toBeVisible({ timeout: 10000 });

      // Extra wait for Y.js WebSocket sync to fully establish between both tabs
      await page1.waitForTimeout(5000);

      // Page 1: Clear existing content and type new sync text
      await editor1.click();
      await page1.keyboard.press('Meta+a');
      await page1.keyboard.press('Backspace');
      const syncText = `Sync test ${Date.now()}`;
      await page1.keyboard.type(syncText, { delay: 30 });

      // Wait for Y.js to propagate changes via WebSocket (poll instead of fixed timeout)
      const editor2 = page2.locator('.ProseMirror');
      await page2.waitForFunction(
        (text) => {
          const el = document.querySelector('.ProseMirror');
          return el?.textContent?.includes(text) || false;
        },
        'Sync test',
        { timeout: 15000 }
      );

      const editor2Text = await editor2.textContent();
      expect(editor2Text).toContain('Sync test');

      // Page 2: Type a reply
      await editor2.click();
      await page2.keyboard.press('End');
      await page2.keyboard.type(' | Tab2 reply', { delay: 30 });

      // Wait for Y.js to propagate back to Page 1 (poll instead of fixed timeout)
      await page1.waitForFunction(
        () => {
          const el = document.querySelector('.ProseMirror');
          return el?.textContent?.includes('Tab2 reply') || false;
        },
        undefined,
        { timeout: 15000 }
      );

      const editor1Text = await editor1.textContent();
      expect(editor1Text).toContain('Tab2 reply');

      // Screenshots of both editors showing synced content
      await page1.screenshot({
        path: 'test-results/notes-collab-tab1-synced.png',
        fullPage: true,
      });
      await page2.screenshot({
        path: 'test-results/notes-collab-tab2-synced.png',
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });
});
