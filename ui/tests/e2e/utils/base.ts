import { Page } from '@playwright/test';

export class BasePage {
  constructor(public page: Page) {}

  async login(email: string, password: string) {
    await this.page.goto('/login');
    await this.page.waitForLoadState('domcontentloaded');

    // Wait for the submit button to be visible (React hydrated)
    await this.page.waitForSelector('button[type="submit"]', { state: 'visible', timeout: 15000 });

    // Fill username/email field
    await this.page.fill('[name="username"]', email);
    await this.page.fill('[name="password"]', password);

    // Wait for React event handlers to be attached after hydration
    await this.page.waitForTimeout(1000);

    // Click Sign In button
    await this.page.click('button[type="submit"]');

    // Wait for client-side navigation (React Router uses pushState, no load event)
    await this.page.waitForURL(/\/(dashboard|workspaces)/, { timeout: 30000, waitUntil: 'commit' });
  }

  /**
   * Wait for app to be ready after navigation. Handles Error #300 (React hook violation)
   * and provider API timeouts which occur under heavy VPS load (after deep research).
   * Retries up to maxRetries times by reloading the page.
   */
  async waitForAppReady(maxRetries = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Wait for DOM to load (don't use networkidle - it hangs when APIs timeout)
      await this.page.waitForLoadState('domcontentloaded');

      // Check for Error #300 (React crash)
      const hasError = await this.page.locator('text=Something went wrong').isVisible({ timeout: 3000 }).catch(() => false);

      if (!hasError) {
        // App loaded, wait for chat input as primary readiness signal
        const chatInput = this.page.locator('[data-testid="chat-input"]');
        const isReady = await chatInput.isVisible({ timeout: 15000 }).catch(() => false);

        if (isReady) {
          // Also wait for model selector to have real content (not "No models found")
          // This ensures providers API has responded
          const modelSelector = this.page.locator('[data-testid="model-selector"]');
          const hasModels = await modelSelector.isVisible({ timeout: 20000 }).catch(() => false);

          if (hasModels) return; // Fully ready

          // Providers timed out — check if "No models found" is showing
          const noModels = await this.page.locator('text=No models found').isVisible({ timeout: 1000 }).catch(() => false);
          if (noModels && attempt < maxRetries) {
            console.log(`  ⚠️ Providers API timeout (attempt ${attempt}/${maxRetries}), reloading...`);
            await this.page.waitForTimeout(3000 * attempt);
            await this.page.reload();
            continue;
          }

          // If models loaded or this is last attempt, return anyway
          return;
        }
      }

      if (attempt < maxRetries) {
        console.log(`  ⚠️ App not ready (attempt ${attempt}/${maxRetries}), reloading...`);
        await this.page.waitForTimeout(3000 * attempt);
        await this.page.reload();
      }
    }

    // Final fallback - just wait for chat input
    await this.page.locator('[data-testid="chat-input"]').waitFor({ state: 'visible', timeout: 30000 });
  }

  async waitForElement(selector: string, timeout = 10000) {
    await this.page.waitForSelector(selector, { timeout });
  }

  async screenshot(name: string) {
    await this.page.screenshot({
      path: `screenshots/${name}-${Date.now()}.png`,
      fullPage: true
    });
  }
}
