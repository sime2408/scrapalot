import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Session Loading E2E Test
 *
 * Tests clicking on sidebar sessions and verifying:
 * - Model selector stays stable (no infinite refresh loop)
 * - Messages load or gracefully show empty state
 * - No console errors indicating loops
 *
 * Regression test for: model refreshing non-stop when loading session messages (404 loop)
 */
test.describe('Session Loading', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
  });

  test('should load session from sidebar without model selector flickering', async ({ page }) => {
    test.setTimeout(120000);

    console.log('Testing session loading from sidebar...\n');

    // Step 1: Verify sidebar has real sessions (exclude "New Conversation" entries)
    console.log('Step 1: Checking sidebar sessions...');
    const sidebarSessions = page.locator('li button').filter({ hasNot: page.locator('text=New Conversation') });
    const sessionCount = await sidebarSessions.count();
    console.log(`  Found ${sessionCount} real sessions in sidebar`);

    if (sessionCount === 0) {
      console.log('  No sessions found, skipping test');
      return;
    }

    // Step 2: Click first real session to load it
    console.log('Step 2: Clicking first sidebar session...');
    const firstSession = sidebarSessions.first();
    await firstSession.click();
    console.log('  Clicked first session');

    // Step 3: Wait for chat view to load (chat-input becomes visible)
    console.log('Step 3: Waiting for chat view to load...');
    const chatInput = page.locator('[data-testid="chat-input"]');
    await chatInput.waitFor({ state: 'visible', timeout: 15000 });
    console.log('  Chat input visible');

    // Step 4: Wait for model selector to appear and stabilize
    console.log('Step 4: Waiting for model selector...');
    const modelSelector = page.locator('[data-testid="model-selector"]');
    await modelSelector.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1000); // Let initial load settle
    console.log('  Model selector visible');

    // Step 5: Monitor model selector stability for 5 seconds
    console.log('Step 5: Monitoring model selector stability for 5 seconds...');
    const modelTexts: string[] = [];
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(500);
      const text = await modelSelector.innerText();
      modelTexts.push(text.trim());
    }

    // Count unique model texts (excluding empty/error)
    const validTexts = modelTexts.filter(t => t && t !== 'ERROR');
    const uniqueTexts = [...new Set(validTexts)];
    console.log(`  Model selector values over 5s: ${uniqueTexts.length} unique states`);
    uniqueTexts.forEach(t => console.log(`    - "${t}"`));

    // Normal behavior: 1-2 unique states (initial + resolved model)
    // Bug behavior: many rapid changes indicating infinite loop
    expect(uniqueTexts.length).toBeLessThanOrEqual(3);
    console.log('  Model selector is stable (not flickering)');

    // Step 6: Verify page is usable
    console.log('Step 6: Verifying page is still usable...');
    await expect(chatInput).toBeVisible({ timeout: 10000 });
    console.log('  Chat input is visible');

    await page.screenshot({
      path: 'test-results/session-loading-success.png',
      fullPage: true
    });

    console.log('\nSession loading works without model flickering\n');
  });

  test('should handle clicking multiple sidebar sessions without crash', async ({ page }) => {
    test.setTimeout(180000);

    console.log('Testing session switching...\n');

    // Get real sessions (exclude "New Conversation" entries)
    const sessions = page.locator('li button').filter({ hasNot: page.locator('text=New Conversation') });
    const sessionCount = await sessions.count();
    console.log(`  Found ${sessionCount} real sessions`);

    if (sessionCount < 2) {
      console.log('  Need at least 2 sessions, skipping test');
      return;
    }

    // Click first session and wait for chat view to fully load
    await sessions.first().click();
    console.log('  Clicked session 1');
    const chatInput = page.locator('[data-testid="chat-input"]');
    await chatInput.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Click second session and wait for it to settle
    await sessions.nth(1).click();
    console.log('  Clicked session 2');
    await page.waitForTimeout(3000);

    // Click third session if available
    if (sessionCount >= 3) {
      await sessions.nth(2).click();
      console.log('  Clicked session 3');
      await page.waitForTimeout(3000);
    }

    // Wait for any pending async operations to settle
    await page.waitForTimeout(5000);

    // Verify page didn't crash - chat input should be visible
    await expect(chatInput).toBeVisible({ timeout: 15000 });
    console.log('  Chat input still visible after switching');

    // Verify model selector is visible and has content
    const modelSelector = page.locator('[data-testid="model-selector"]');
    await expect(modelSelector).toBeVisible({ timeout: 15000 });

    const modelText = await modelSelector.innerText();
    expect(modelText.trim().length).toBeGreaterThan(0);
    console.log(`  Model after switching: "${modelText.trim()}"`);

    await page.screenshot({
      path: 'test-results/rapid-session-switch-success.png',
      fullPage: true
    });

    console.log('\nSession switching works without crash\n');
  });
});

/**
 * Session Performance E2E Test
 *
 * Single consolidated test that verifies sidebar performance, infinite scroll,
 * and API efficiency. Creates 25 sessions (1+ pages), runs all checks, cleans up.
 * Kept lightweight to avoid OOM on 16GB VPS with all Docker containers running.
 */
test.describe('Session Performance', () => {
  const TEST_SESSION_PREFIX = 'perf-test-session';
  const BASE_URL = 'http://localhost:8080/api/v1';
  let createdSessionIds: string[] = [];
  let authToken = '';

  test.beforeEach(async ({ page, request }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    // Get auth token for API calls
    const loginResponse = await request.post(`${BASE_URL}/auth/login`, {
      data: { usernameOrEmail: TEST_EMAIL, password: TEST_PASSWORD },
    });
    const loginData = await loginResponse.json();
    authToken = loginData.access_token;

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ request }) => {
    // Always clean up test sessions
    if (createdSessionIds.length > 0) {
      console.log(`Cleaning up ${createdSessionIds.length} test sessions...`);
      for (const id of createdSessionIds) {
        await request.delete(`${BASE_URL}/sessions/${id}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        }).catch(() => {});
      }
      createdSessionIds = [];
      console.log('Cleanup complete');
    }
  });

  test('should handle 25 sessions with responsive sidebar and no excessive API calls', async ({ page, request }) => {
    test.setTimeout(120000);

    // Step 1: Create 25 sessions sequentially (avoid API overload on VPS)
    console.log('Step 1: Creating 25 test sessions...');
    for (let i = 0; i < 25; i++) {
      try {
        const res = await request.post(`${BASE_URL}/sessions`, {
          headers: { Authorization: `Bearer ${authToken}` },
          data: { conversation_name: `${TEST_SESSION_PREFIX}-${i}` },
        });
        if (res.ok()) {
          const data = await res.json();
          createdSessionIds.push(data.id);
        }
      } catch {
        // Ignore individual failures
      }
    }
    console.log(`  Created ${createdSessionIds.length} sessions`);
    expect(createdSessionIds.length).toBeGreaterThanOrEqual(20);

    // Step 2: Reload page
    console.log('Step 2: Reloading page...');
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Step 3: Verify sidebar has sessions and is responsive
    console.log('Step 3: Checking sidebar...');
    const sidebarButtons = page.locator('.sessions-list button');
    const domNodeCount = await sidebarButtons.count();
    console.log(`  DOM button nodes in sidebar: ${domNodeCount}`);
    expect(domNodeCount).toBeGreaterThan(0);

    // Step 4: Click responsiveness
    console.log('Step 4: Testing click responsiveness...');
    const startTime = Date.now();
    await sidebarButtons.first().click();
    const chatInput = page.locator('[data-testid="chat-input"]');
    await chatInput.waitFor({ state: 'visible', timeout: 10000 });
    const clickLatency = Date.now() - startTime;
    console.log(`  Click response time: ${clickLatency}ms`);
    expect(clickLatency).toBeLessThan(5000);

    // Step 5: Monitor API efficiency for 5 seconds (reduced from 10s)
    console.log('Step 5: Monitoring API calls for 5 seconds...');
    let messageApiCalls = 0;
    page.on('request', (req) => {
      if (req.url().includes('/messages') && req.method() === 'GET') {
        messageApiCalls++;
      }
    });
    await page.waitForTimeout(5000);
    console.log(`  Message API calls in 5s: ${messageApiCalls}`);
    // After removing preload spam: should be minimal (<=5 from hook preload)
    expect(messageApiCalls).toBeLessThanOrEqual(8);

    // Step 6: Scroll test
    console.log('Step 6: Scrolling sidebar...');
    const sessionsList = page.locator('.sessions-list');
    await sessionsList.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(2000);
    const afterScrollCount = await sidebarButtons.count();
    console.log(`  Buttons after scroll: ${afterScrollCount}`);
    expect(afterScrollCount).toBeGreaterThan(0);

    await page.screenshot({
      path: 'test-results/session-performance.png',
      fullPage: true,
    });

    console.log('Session performance test passed');
  });
});
