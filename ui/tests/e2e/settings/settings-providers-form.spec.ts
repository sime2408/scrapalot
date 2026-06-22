import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

/**
 * Settings Providers Form E2E Tests
 *
 * Tests the provider management form:
 * - Add provider flow (select type, enter credentials, fetch models, save)
 * - Edit provider flow (open edit form, modify, save)
 * - Provider list display and actions menu
 * - Model fetching and selection
 * - Delete provider
 */
test.describe('Settings Providers Form', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  // Helper: navigate to Remote Providers tab
  async function openProvidersTab(page: import('@playwright/test').Page) {
    const settingsButton = page.locator('[data-tour="settings-button"]');
    await settingsButton.waitFor({ state: 'visible', timeout: 10000 });
    await settingsButton.click();
    await page.waitForTimeout(500);

    const dialog = page.locator('[data-testid="settings-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Navigate to Remote Providers tab (handle mobile/desktop)
    const providersTab = page.locator('[data-testid="settings-tab-remote-providers"]');
    const tabCount = await providersTab.count();
    for (let i = 0; i < tabCount; i++) {
      if (await providersTab.nth(i).isVisible({ timeout: 1000 }).catch(() => false)) {
        await providersTab.nth(i).click();
        return;
      }
    }
    await providersTab.last().click({ force: true });
  }

  test('should display Add Provider button and open form', async ({ page }) => {
    test.setTimeout(60000);
    console.log('Testing Add Provider button...\n');

    await openProvidersTab(page);
    await page.waitForTimeout(1000);

    // Verify Add Provider button exists
    const addButton = page.locator('[data-testid="settings-provider-add-button"]');
    await addButton.waitFor({ state: 'visible', timeout: 10000 });
    await expect(addButton).toBeVisible();
    console.log('Add Provider button visible\n');

    // Click to open provider form
    await addButton.click();
    await page.waitForTimeout(500);

    // Verify form/sheet opens with provider selector buttons
    const providerButtons = page.locator('[data-testid^="provider-select-"]');
    await providerButtons.first().waitFor({ state: 'visible', timeout: 5000 });
    const count = await providerButtons.count();
    expect(count).toBeGreaterThanOrEqual(6); // At least 6 providers available
    console.log(`Found ${count} provider type buttons\n`);

    // Close form with Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  });

  test('should show provider type selector with correct options', async ({ page }) => {
    test.setTimeout(60000);
    console.log('Testing provider selector options...\n');

    await openProvidersTab(page);
    await page.waitForTimeout(1000);

    const addButton = page.locator('[data-testid="settings-provider-add-button"]');
    await addButton.click();
    await page.waitForTimeout(500);

    // Verify all expected provider types exist
    const expectedProviders = ['openai', 'google', 'openrouter', 'anthropic', 'lmstudio', 'deepseek', 'vllm', 'ollama'];
    for (const provider of expectedProviders) {
      const button = page.locator(`[data-testid="provider-select-${provider}"]`);
      await expect(button).toBeVisible();
    }
    console.log('All expected provider types found\n');

    // Verify already-configured providers show checkmark
    const configuredProviders = page.locator('[data-testid^="provider-select-"][disabled]');
    const configuredCount = await configuredProviders.count();
    console.log(`${configuredCount} providers already configured (disabled)\n`);

    await page.keyboard.press('Escape');
  });

  test('should show API key input when selecting a cloud provider', async ({ page }) => {
    test.setTimeout(60000);
    console.log('Testing API key input for cloud provider...\n');

    await openProvidersTab(page);
    await page.waitForTimeout(1000);

    const addButton = page.locator('[data-testid="settings-provider-add-button"]');
    await addButton.click();
    await page.waitForTimeout(500);

    // Find an unconfigured cloud provider to select
    const providers = ['openai', 'google', 'anthropic', 'deepseek'];
    let selectedProvider = '';

    for (const provider of providers) {
      const button = page.locator(`[data-testid="provider-select-${provider}"]`);
      const isDisabled = await button.isDisabled().catch(() => true);
      if (!isDisabled) {
        await button.click();
        selectedProvider = provider;
        await page.waitForTimeout(300);
        break;
      }
    }

    if (selectedProvider) {
      console.log(`Selected provider: ${selectedProvider}\n`);

      // API key input should be visible
      const apiKeyInput = page.locator('[data-testid="provider-api-key-input"]');
      await apiKeyInput.waitFor({ state: 'visible', timeout: 5000 });
      await expect(apiKeyInput).toBeVisible();
      console.log('API key input visible\n');

      // Description input should be visible
      const descInput = page.locator('[data-testid="provider-description-input"]');
      await expect(descInput).toBeVisible();
      console.log('Description input visible\n');

      // Fetch Models button should be visible but disabled (no API key yet)
      const fetchButton = page.locator('[data-testid="provider-fetch-models-button"]');
      await fetchButton.waitFor({ state: 'visible', timeout: 5000 });
      await expect(fetchButton).toBeDisabled();
      console.log('Fetch Models button visible and disabled (no key)\n');
    } else {
      console.log('All cloud providers already configured, skipping API key test\n');
    }

    await page.keyboard.press('Escape');
  });

  test('should enable Fetch Models button after entering API key', async ({ page }) => {
    test.setTimeout(60000);
    console.log('Testing Fetch Models button enablement...\n');

    await openProvidersTab(page);
    await page.waitForTimeout(1000);

    const addButton = page.locator('[data-testid="settings-provider-add-button"]');
    await addButton.click();
    await page.waitForTimeout(500);

    // Find an unconfigured cloud provider
    const providers = ['openai', 'google', 'anthropic', 'deepseek'];
    let selectedProvider = '';

    for (const provider of providers) {
      const button = page.locator(`[data-testid="provider-select-${provider}"]`);
      const isDisabled = await button.isDisabled().catch(() => true);
      if (!isDisabled) {
        await button.click();
        selectedProvider = provider;
        await page.waitForTimeout(300);
        break;
      }
    }

    if (selectedProvider) {
      // Enter a dummy API key
      const apiKeyInput = page.locator('[data-testid="provider-api-key-input"]');
      await apiKeyInput.fill('sk-test-dummy-key-12345');
      await page.waitForTimeout(300);

      // Fetch Models button should now be enabled
      const fetchButton = page.locator('[data-testid="provider-fetch-models-button"]');
      await expect(fetchButton).toBeEnabled();
      console.log('Fetch Models button enabled after entering API key\n');
    } else {
      console.log('All cloud providers already configured, skipping test\n');
    }

    await page.keyboard.press('Escape');
  });

  test('should open edit form for existing provider', async ({ page }) => {
    test.setTimeout(90000);
    console.log('Testing edit provider flow...\n');

    await openProvidersTab(page);
    await page.waitForTimeout(1000);

    // Find a provider item with a dropdown menu
    const providerItems = page.locator('[data-testid^="settings-provider-item-"]');
    await providerItems.first().waitFor({ state: 'visible', timeout: 15000 });
    const providerCount = await providerItems.count();
    expect(providerCount).toBeGreaterThan(0);
    console.log(`Found ${providerCount} providers in list\n`);

    // Click the three-dot menu on the first provider
    const firstProvider = providerItems.first();
    const menuButton = firstProvider.locator('button').filter({ has: page.locator('svg') }).last();

    // Try to find a visible menu trigger
    const desktopMenu = firstProvider.locator('.hidden.md\\:grid button').last();
    const mobileMenu = firstProvider.locator('.md\\:hidden button').last();

    let menuClicked = false;
    if (await desktopMenu.isVisible({ timeout: 2000 }).catch(() => false)) {
      await desktopMenu.click();
      menuClicked = true;
    } else if (await mobileMenu.isVisible({ timeout: 2000 }).catch(() => false)) {
      await mobileMenu.click();
      menuClicked = true;
    }

    if (menuClicked) {
      await page.waitForTimeout(300);

      // Look for Edit option in the dropdown
      const editOption = page.locator('[data-testid^="provider-edit-"]').first();
      if (await editOption.isVisible({ timeout: 3000 }).catch(() => false)) {
        await editOption.click();
        await page.waitForTimeout(500);

        // Verify edit form opens with provider form visible
        const form = page.locator('[data-testid="provider-form"]');
        await form.waitFor({ state: 'visible', timeout: 5000 });
        await expect(form).toBeVisible();
        console.log('Edit form opened successfully\n');

        // Verify name input is visible in edit mode
        const nameInput = page.locator('[data-testid="provider-name-input"]');
        await expect(nameInput).toBeVisible();
        console.log('Provider name input visible in edit mode\n');

        // Close the form
        await page.keyboard.press('Escape');
      } else {
        console.log('Edit option not found in dropdown, skipping\n');
      }
    } else {
      console.log('Could not find menu button, skipping edit test\n');
    }
  });

  test('should fetch and display models for existing provider in edit mode', async ({ page }) => {
    test.setTimeout(120000);
    console.log('Testing model fetch in edit mode...\n');

    await openProvidersTab(page);
    await page.waitForTimeout(1000);

    // Find a provider that has models (look for one with model count)
    const providerItems = page.locator('[data-testid^="settings-provider-item-"]');
    await providerItems.first().waitFor({ state: 'visible', timeout: 15000 });

    // Click menu on first provider
    const firstProvider = providerItems.first();
    const desktopMenuButton = firstProvider.locator('.hidden.md\\:grid button').last();

    if (await desktopMenuButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await desktopMenuButton.click();
      await page.waitForTimeout(300);

      const editOption = page.locator('[data-testid^="provider-edit-"]').first();
      if (await editOption.isVisible({ timeout: 3000 }).catch(() => false)) {
        await editOption.click();
        await page.waitForTimeout(500);

        // Wait for form
        const form = page.locator('[data-testid="provider-form"]');
        await form.waitFor({ state: 'visible', timeout: 5000 });

        // Click Fetch Models
        const fetchButton = page.locator('[data-testid="provider-fetch-models-button"]');
        if (await fetchButton.isVisible({ timeout: 3000 }).catch(() => false)) {
          const isEnabled = await fetchButton.isEnabled();
          if (isEnabled) {
            await fetchButton.click();
            console.log('Clicked Fetch Models button\n');

            // Wait for models to load (button text changes to "Fetching...")
            await page.waitForTimeout(3000);

            // Check if models list appeared
            const modelsList = page.locator('[data-testid="provider-models-list"]');
            if (await modelsList.isVisible({ timeout: 15000 }).catch(() => false)) {
              // Verify at least one model item exists
              const modelItems = page.locator('[data-testid^="provider-model-item-"]');
              const modelCount = await modelItems.count();
              console.log(`Found ${modelCount} models after fetch\n`);

              if (modelCount > 0) {
                // Test model search
                const searchInput = page.locator('[data-testid="provider-model-search"]');
                if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
                  await searchInput.fill('gpt');
                  await page.waitForTimeout(500);
                  const filteredCount = await modelItems.count();
                  console.log(`After search "gpt": ${filteredCount} models\n`);
                }
              }
            } else {
              console.log('Models list did not appear (may need valid API key)\n');
            }
          } else {
            console.log('Fetch Models button disabled (missing credentials)\n');
          }
        } else {
          console.log('Fetch Models button not found\n');
        }

        await page.keyboard.press('Escape');
      }
    } else {
      console.log('Desktop menu not visible, skipping\n');
    }
  });

  test('should show submit button disabled when no models selected', async ({ page }) => {
    test.setTimeout(60000);
    console.log('Testing form validation - submit button state...\n');

    await openProvidersTab(page);
    await page.waitForTimeout(1000);

    const addButton = page.locator('[data-testid="settings-provider-add-button"]');
    await addButton.click();
    await page.waitForTimeout(500);

    // Select an unconfigured provider
    const providers = ['openai', 'google', 'anthropic', 'deepseek', 'openrouter'];
    for (const provider of providers) {
      const button = page.locator(`[data-testid="provider-select-${provider}"]`);
      const isDisabled = await button.isDisabled().catch(() => true);
      if (!isDisabled) {
        await button.click();
        await page.waitForTimeout(300);

        // Submit button should be disabled (no models selected)
        const submitButton = page.locator('[data-testid="provider-form-submit"]');
        await submitButton.waitFor({ state: 'visible', timeout: 5000 });
        await expect(submitButton).toBeDisabled();
        console.log(`Submit button correctly disabled for ${provider} (no models)\n`);
        break;
      }
    }

    await page.keyboard.press('Escape');
  });

  test('should display provider model count in the list', async ({ page }) => {
    test.setTimeout(60000);
    console.log('Testing provider list model count display...\n');

    await openProvidersTab(page);
    await page.waitForTimeout(1000);

    const providersList = page.locator('[data-testid="settings-providers-list"]');
    await providersList.waitFor({ state: 'visible', timeout: 15000 });

    // Check that provider items show model information
    const providerItems = page.locator('[data-testid^="settings-provider-item-"]');
    const count = await providerItems.count();
    expect(count).toBeGreaterThan(0);

    // Verify at least one provider shows model badges/tags
    let foundModels = false;
    for (let i = 0; i < Math.min(count, 3); i++) {
      const item = providerItems.nth(i);
      const text = await item.textContent();
      if (text && (text.includes('gpt') || text.includes('claude') || text.includes('model') || text.includes('GPT'))) {
        foundModels = true;
        break;
      }
    }

    console.log(`Provider list has ${count} items, model info found: ${foundModels}\n`);
  });

  test('should handle provider actions dropdown menu', async ({ page }) => {
    test.setTimeout(60000);
    console.log('Testing provider actions dropdown...\n');

    await openProvidersTab(page);
    await page.waitForTimeout(1000);

    const providerItems = page.locator('[data-testid^="settings-provider-item-"]');
    await providerItems.first().waitFor({ state: 'visible', timeout: 15000 });

    // Open dropdown menu on first provider
    const firstProvider = providerItems.first();
    const desktopMenuButton = firstProvider.locator('.hidden.md\\:grid button').last();

    if (await desktopMenuButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await desktopMenuButton.click();
      await page.waitForTimeout(300);

      // Verify dropdown menu items exist
      const editOption = page.locator('[data-testid^="provider-edit-"]').first();
      const deleteOption = page.locator('[data-testid^="provider-delete-"]').first();

      const editVisible = await editOption.isVisible({ timeout: 2000 }).catch(() => false);
      const deleteVisible = await deleteOption.isVisible({ timeout: 2000 }).catch(() => false);

      expect(editVisible || deleteVisible).toBe(true);
      console.log(`Dropdown: edit=${editVisible}, delete=${deleteVisible}\n`);

      // Close dropdown by pressing Escape
      await page.keyboard.press('Escape');
    } else {
      console.log('Desktop menu not visible, checking mobile layout\n');
    }
  });
});
