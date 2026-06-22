import { defineConfig, devices } from '@playwright/test';

// Dedicated config for marketing screenshot capture. Does not alter the
// main playwright.config.ts testMatch ordering. Run with:
//   npx playwright test --config=playwright.marketing.config.ts
export default defineConfig({
  testDir: './tests/e2e/screenshots',
  testMatch: ['marketing-screenshots.spec.ts'],
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  timeout: 420000, // 7 min per test (test C has ~12 captures incl. settings tabs)
  expect: {
    timeout: 12000,
  },
});
