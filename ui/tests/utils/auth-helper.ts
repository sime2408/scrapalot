import { Page, expect } from '@playwright/test';

export interface TestUser {
  email: string;
  password: string;
  name?: string;
}

export class AuthHelper {
  constructor(private page: Page) {}

  /**
   * Ensure user exists by registering if needed, then login
   */
  async ensureUserExistsAndLogin(user: TestUser) {
    console.log(`🔍 Ensuring user ${user.email} exists...`);
    
    try {
      // Try to register the user first (will fail if user exists, which is fine)
      const registrationResponse = await this.page.evaluate(async (userData) => {
        const response = await fetch('http://localhost:8090/api/v1/users/register', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: userData.email,
            password: userData.password,
            name: userData.name || userData.email.split('@')[0]
          })
        });
        
        return {
          ok: response.ok,
          status: response.status,
          text: await response.text()
        };
      }, user);
      
      if (registrationResponse.ok) {
        console.log('User registered successfully');
      } else if (registrationResponse.status === 409) {
        console.log('📋 User already exists (409), proceeding to login');
      } else {
        console.log(`⚠️ Registration response: ${registrationResponse.status} - ${registrationResponse.text}`);
      }
      
    } catch (error) {
      console.log(`⚠️ Registration check failed: ${error.message}`);
    }
    
    // Now proceed with login
    await this.login(user);
  }

  /**
   * Login with test credentials
   */
  async login(user: TestUser = { email: 'test@example.com', password: 'testpass123' }) {
    await this.page.goto('http://localhost:3000/login');
    
    // Wait for page to load and check what's available
    await this.page.waitForLoadState('networkidle');
    console.log('🔍 Page loaded. URL:', this.page.url());
    console.log('🔍 Page title:', await this.page.title());
    
    // Try different ways to detect login form
    await this.page.waitForTimeout(2000); // Give page time to render
    
    // Check for email/username field (based on screenshot - placeholder "Username or Email")
    const emailField = this.page.locator('input[placeholder*="Username or Email" i], input[placeholder*="email" i], input[name="email"], input[name="username"]').first();
    await expect(emailField).toBeVisible({ timeout: 10000 });
    
    // Fill email
    await emailField.fill(user.email);
    console.log(`✉️ Filled email: ${user.email}`);
    
    // Find password field (based on screenshot - placeholder "Password")
    const passwordField = this.page.locator('input[placeholder*="Password" i], input[type="password"], input[name="password"]').first();
    await passwordField.fill(user.password);
    console.log('🔐 Filled password');
    
    // Find and click submit button (blue "Sign In" button in screenshot)
    const submitButton = this.page.locator('button:has-text("Sign In")').first();
    await submitButton.click();
    console.log('🚀 Clicked login button');
    
    // Wait for navigation or success indicator
    try {
      await this.page.waitForURL(/\/(dashboard|workspace)/, { timeout: 15000 });
      console.log('Successfully redirected after login');
    } catch (error) {
      console.log('⏰ Timeout waiting for redirect, checking current state...');
      console.log('Current URL:', this.page.url());
      
      // Check for error messages or other indicators
      const errorMsg = await this.page.locator('[class*="error"], [class*="alert"], [data-testid*="error"]').first().textContent().catch(() => null);
      if (errorMsg) {
        console.log('❌ Login error:', errorMsg);
        throw new Error(`Login failed: ${errorMsg}`);
      }
      
      // If we're still on login page, assume login failed
      if (this.page.url().includes('/login')) {
        throw new Error('Login failed - still on login page');
      }
    }
    
    // Verify auth state
    await this.waitForAuthReady();
    
    // Create a workspace for the user to ensure Knowledge Stacks functionality works
    console.log('🏗️ Creating workspace for test user...');
    try {
      const workspaceResponse = await this.page.evaluate(async () => {
        // Create workspace using the frontend API
        const response = await fetch('http://localhost:8090/api/v1/workspace', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            name: 'Test Workspace'
          })
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Failed to create workspace: ${response.status} - ${error}`);
        }
        
        return await response.json();
      });
      
      console.log(`Created workspace: ${workspaceResponse.workspace_id}`);
      
      // Wait for the workspace context to be ready in the frontend
      await this.page.waitForTimeout(2000);
      
    } catch (error) {
      console.log(`⚠️ Failed to create workspace: ${error.message}`);
      console.log('📋 Continuing test - workspace might already exist');
    }
  }

  /**
   * Sign up with new user credentials
   */
  async signUp(user: TestUser) {
    await this.page.goto('/sign-up');
    
    // Wait for signup form
    await expect(this.page.getByTestId('signup-form')).toBeVisible({ timeout: 10000 });
    
    // Fill signup form
    if (user.name) {
      await this.page.getByRole('textbox', { name: /name|full name/i }).fill(user.name);
    }
    await this.page.getByRole('textbox', { name: /email/i }).fill(user.email);
    await this.page.getByRole('textbox', { name: /password/i }).fill(user.password);
    
    // Submit signup
    await this.page.getByRole('button', { name: /sign up|register/i }).click();
    
    // Wait for successful signup
    await this.page.waitForURL(/\/(dashboard|home)/, { timeout: 15000 });
    
    // Verify auth state
    await this.waitForAuthReady();
  }

  /**
   * Logout current user
   */
  async logout() {
    // Look for logout button in header or user menu
    const logoutButton = this.page.getByRole('button', { name: /logout|sign out/i });
    
    if (await logoutButton.isVisible()) {
      await logoutButton.click();
    } else {
      // Try to open user menu first
      const userMenu = this.page.getByTestId('user-menu');
      if (await userMenu.isVisible()) {
        await userMenu.click();
        await this.page.getByRole('button', { name: /logout|sign out/i }).click();
      }
    }
    
    // Wait for redirect to login or home page
    await this.page.waitForURL(/\/(login|home)/, { timeout: 10000 });
  }

  /**
   * Wait for authentication to be ready
   */
  async waitForAuthReady() {
    // Wait for auth context to be initialized
    await this.page.waitForFunction(() => {
      return window.localStorage.getItem('scrapalot_user_prefs') !== null;
    }, { timeout: 10000 });
    
    // Additional wait for any loading states
    await this.page.waitForTimeout(1000);
  }

  /**
   * Check if user is currently authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      // Check for auth indicators in the UI
      const dashboardLink = this.page.getByRole('link', { name: /dashboard/i });
      const loginLink = this.page.getByRole('link', { name: /login|sign in/i });
      
      return (await dashboardLink.isVisible()) && !(await loginLink.isVisible());
    } catch {
      return false;
    }
  }

  /**
   * Get current user info from localStorage
   */
  async getCurrentUser() {
    return await this.page.evaluate(() => {
      const userPrefs = localStorage.getItem('scrapalot_user_prefs');
      return userPrefs ? JSON.parse(userPrefs) : null;
    });
  }

  /**
   * Clear all authentication data
   */
  async clearAuth() {
    await this.page.evaluate(() => {
      localStorage.removeItem('scrapalot_user_prefs');
      localStorage.removeItem('scrapalot_model_selections');
      localStorage.removeItem('scrapalot_ui_state');
      localStorage.removeItem('scrapalot_cache_data');
      localStorage.removeItem('scrapalot_settings');
    });
  }
}