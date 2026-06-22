import { test, expect } from '@playwright/test';
import { BasePage } from '../utils/base';
import { TEST_EMAIL, TEST_PASSWORD } from '../utils/test-config';

test.describe('Citation PDF on Mobile', () => {
  test('should scroll to citation page on mobile', async ({ page }) => {
    test.setTimeout(180000);

    await page.addInitScript(() => {
      localStorage.setItem('scrapalot_tour_completed', 'true');
    });

    // Set mobile viewport BEFORE login
    await page.setViewportSize({ width: 390, height: 844 });

    const basePage = new BasePage(page);
    await basePage.login(TEST_EMAIL, TEST_PASSWORD);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const consoleLogs: string[] = [];
    page.on('console', msg => {
      const text = msg.text();
      consoleLogs.push(text);
      if (text.includes('PDF') || text.includes('citationPage') || text.includes('initialPage') || text.includes('Error')) {
        console.log(`  🌐 ${text}`);
      }
    });

    // Start conversation
    const newConv = page.locator('text=New Conversation').first();
    await expect(newConv).toBeVisible({ timeout: 5000 });
    await newConv.click();
    await page.waitForTimeout(1000);

    // Select model
    const modelSelector = page.locator('[data-testid="model-selector"]');
    await modelSelector.waitFor({ state: 'visible', timeout: 15000 });
    await modelSelector.click();
    await page.waitForTimeout(500);
    const opt = page.locator('[role="option"]').filter({ hasText: 'Scrapalot AI' }).first();
    await expect(opt).toBeVisible({ timeout: 5000 });
    await opt.click();
    await page.waitForTimeout(1000);

    // Select collection
    const collBtn = page.locator('[data-testid="collection-selector"]');
    await collBtn.waitFor({ state: 'visible', timeout: 5000 });
    await collBtn.click();
    await page.waitForTimeout(1000);
    const checkboxes = page.locator('[role="checkbox"]');
    for (let i = 0; i < Math.min(await checkboxes.count(), 5); i++) {
      const cb = checkboxes.nth(i);
      if (!(await cb.getAttribute('data-disabled')) && (await cb.getAttribute('aria-disabled')) !== 'true') {
        await cb.click({ timeout: 3000 });
        break;
      }
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Send RAG query
    const chatInput = page.locator('[data-testid="chat-input"]');
    await chatInput.waitFor({ state: 'visible', timeout: 10000 });
    await chatInput.fill('Summarize the key topics from the documents.');
    // Use Enter key to send - send button may be blocked by admin debug button on mobile
    await page.waitForTimeout(500);
    await chatInput.press('Enter');

    // Wait for response
    await expect(page.locator('[data-testid="chat-input"]')).not.toBeDisabled({ timeout: 120000 });
    await page.waitForTimeout(2000);

    // Expand citations
    const citToggle = page.locator('[data-testid="citations-toggle-button"]').first();
    await expect(citToggle).toBeVisible({ timeout: 15000 });
    await citToggle.click();
    await page.waitForTimeout(500);

    const citItems = page.locator('[data-testid^="citation-item-"]');
    await expect(citItems.first()).toBeVisible({ timeout: 10000 });
    const citCount = await citItems.count();
    console.log(`Found ${citCount} citations`);
    expect(citCount).toBeGreaterThan(0);

    // Get citation page number from title
    const title = await citItems.first().locator('div.font-medium').first().innerText();
    console.log(`Clicking citation: "${title}"`);
    const pageMatch = title.match(/\[Page (\d+)\]/);
    const expectedPage = pageMatch ? parseInt(pageMatch[1]) : null;
    console.log(`Expected page: ${expectedPage}`);

    // Screenshot before click
    await page.screenshot({ path: 'test-results/mobile-before-click.png' });

    // Click citation
    await citItems.first().locator('button').first().click();
    await page.waitForTimeout(5000);

    // Check PDF viewer
    const pdfDrawer = page.locator('[data-testid="pdf-viewer-drawer"]');
    await expect(pdfDrawer).toBeVisible({ timeout: 15000 });
    console.log('PDF viewer visible: true');

    // Screenshot after click
    await page.screenshot({ path: 'test-results/mobile-pdf-open.png' });

    {
      // Check what page the viewer is showing
      const pageLogs = consoleLogs.filter(l => l.includes('citationPage') || l.includes('effectiveInitialPage') || l.includes('Saving position'));
      console.log('\nPage-related logs:');
      pageLogs.forEach(l => console.log(`  ${l}`));

      // Check for the actual current page displayed
      // Look for page indicator in the PDF viewer
      const pageIndicator = pdfDrawer.locator('input[type="number"], [class*="page-number"], [class*="currentPage"]');
      const pageIndicatorCount = await pageIndicator.count();
      console.log(`Page indicators found: ${pageIndicatorCount}`);

      // Check the scroll position and page dimensions
      const scrollInfo = await page.evaluate(() => {
        const pdfContainer = document.querySelector('[data-testid="pdf-viewer-drawer"]');
        if (!pdfContainer) return 'no drawer';

        const info: string[] = [];

        // rpv inner container
        const rpvInner = pdfContainer.querySelector('.rpv-core__inner-container');
        if (rpvInner) {
          const htmlRpv = rpvInner as HTMLElement;
          info.push(`rpv-inner: top=${htmlRpv.scrollTop}, height=${htmlRpv.scrollHeight}, client=${htmlRpv.clientHeight}`);
        }

        const rpvPages = pdfContainer.querySelector('.rpv-core__inner-pages');
        if (rpvPages) {
          const htmlPages = rpvPages as HTMLElement;
          info.push(`rpv-pages: top=${htmlPages.scrollTop}, height=${htmlPages.scrollHeight}, client=${htmlPages.clientHeight}`);

          // Get actual heights of first 5 pages
          const children = rpvPages.children;
          for (let i = 0; i < Math.min(children.length, 5); i++) {
            const child = children[i] as HTMLElement;
            const pageLayer = child.querySelector('.rpv-core__page-layer');
            const dpn = pageLayer?.getAttribute('data-page-number') || 'none';
            info.push(`  page-${i}: offsetTop=${child.offsetTop}, height=${child.offsetHeight}, data-page-number=${dpn}`);
          }
        }

        return info.length > 0 ? info.join('\n') : 'no scrollable elements found';
      });
      console.log('\nScroll state:');
      console.log(scrollInfo);

      // Wait a bit more for potential scroll animation
      await page.waitForTimeout(3000);
      await page.screenshot({ path: 'test-results/mobile-pdf-scrolled.png' });

      // Close PDF via Escape (X button removed in favor of Esc + mobile back)
      await page.keyboard.press('Escape');
    }

    // Print all PDF-related console logs
    console.log('\nAll PDF logs:');
    consoleLogs.filter(l => l.includes('PDF') || l.includes('page') || l.includes('Page') || l.includes('scroll') || l.includes('jump'))
      .slice(-25)
      .forEach(l => console.log(`  ${l}`));

    console.log('\nDone');
  });
});
