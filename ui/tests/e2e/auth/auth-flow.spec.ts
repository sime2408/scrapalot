import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Authentication Flow E2E Tests
 *
 * Tests login and logout functionality:
 * - Successful login with valid credentials
 * - Logout redirects to login page
 */
test.describe('Authentication Flow', () => {
  test('should login successfully with valid credentials', async ({ page }) => {
    // Disable welcome tour
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    console.log('🧪 Starting login E2E test...\n');

    // Step 1: Navigate to login page
    console.log('Step 1/4: Navigating to login page...');
    await page.goto('/login');
    await page.waitForSelector('[name="username"]', { timeout: 10000 });
    console.log('Login form visible\n');

    // Step 2: Fill in credentials
    console.log('Step 2/4: Filling credentials...');
    await page.fill('[name="username"]', TEST_EMAIL);
    await page.fill('[name="password"]', TEST_PASSWORD);
    console.log('Credentials filled\n');

    // Step 3: Submit form
    console.log('Step 3/4: Submitting login form...');
    await page.click('button[type="submit"]');
    console.log('Form submitted\n');

    // Step 4: Verify redirect to dashboard
    console.log('Step 4/4: Waiting for dashboard redirect...');
    await page.waitForURL(/\/(dashboard|workspaces)/, { timeout: 15000 });

    // Verify dashboard is loaded (shows "No conversation selected" or chat input)
    const dashboard = page.locator('text=No conversation selected').or(page.locator('[data-testid="chat-input"]'));
    await dashboard.first().waitFor({ state: 'visible', timeout: 20000 });
    console.log('Dashboard loaded\n');

    await expect(dashboard.first()).toBeVisible();
  });

  test('should logout and redirect to login page', async ({ page }) => {
    // Disable welcome tour
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    console.log('🧪 Starting logout E2E test...\n');

    // Step 1: Login first
    console.log('Step 1/4: Logging in...');
    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    console.log('Logged in\n');

    // Step 2: Verify we're on dashboard
    console.log('Step 2/4: Verifying dashboard...');
    const dashboard = page.locator('text=No conversation selected').or(page.locator('[data-testid="chat-input"]'));
    await dashboard.first().waitFor({ state: 'visible', timeout: 20000 });
    console.log('Dashboard confirmed\n');

    // Step 3: Click user menu and logout
    console.log('Step 3/4: Opening user menu and clicking logout...');
    const userMenuButton = page.locator('[data-testid="user-menu-button"]');
    await userMenuButton.waitFor({ state: 'visible', timeout: 15000 });
    await userMenuButton.click();
    await page.waitForTimeout(500);

    const logoutButton = page.locator('[data-testid="user-menu-logout"]');
    await logoutButton.waitFor({ state: 'visible', timeout: 5000 });
    await logoutButton.click();
    console.log('Logout clicked\n');

    // Step 4: Verify redirect to login or landing page
    console.log('Step 4/4: Waiting for redirect after logout...');
    // Logout may redirect to /login or / (landing page)
    await page.waitForURL(/\/(login)?$/, { timeout: 15000 });

    // Verify we're logged out by checking for login form or landing page
    const loginForm = page.locator('[name="username"]');
    const landingPage = page.locator('text=Get Started');
    const loggedOut = loginForm.or(landingPage);
    await loggedOut.first().waitFor({ state: 'visible', timeout: 10000 });
    console.log('Redirected after logout\n');

    await expect(loggedOut.first()).toBeVisible();
  });
});
