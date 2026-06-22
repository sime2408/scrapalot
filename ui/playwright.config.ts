import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Run tests sequentially for stability
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Single worker for VPS
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results.json' }],
    ['list']
  ],
  // Test execution order: lightest first, heaviest last (VPS load sensitivity)
  // auth → settings → workspace → chat → knowledge → notes → research
  testMatch: [
    'auth/**/*.spec.ts',
    'settings/**/*.spec.ts',
    'personalization/**/*.spec.ts',
    'admin/**/*.spec.ts',
    'workspace/**/*.spec.ts',
    'chat/**/*.spec.ts',
    'knowledge/**/*.spec.ts',
    'notes/**/*.spec.ts',
    'research/**/*.spec.ts',
    'regression/**/*.spec.ts',
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: true, // VPS mode (no GUI)
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  timeout: 60000, // 1 minute per test
  expect: {
    timeout: 10000, // 10 seconds for assertions
  },
});
