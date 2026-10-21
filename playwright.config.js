import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 }, colorScheme: 'dark' },
});
