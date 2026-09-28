import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  outputDir: '.test-data/browser-results',
  use: {
    baseURL: 'http://127.0.0.1:19643',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pwsh -NoProfile -File ./scripts/project.ps1 exec tsx tests/e2e/serve.ts',
    url: 'http://127.0.0.1:19643/api/auth',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
