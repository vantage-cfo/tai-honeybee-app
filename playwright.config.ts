import { defineConfig } from '@playwright/test';
import 'dotenv/config';

// Headed by default so the demo is visible. Override with HEADLESS=1.
export default defineConfig({
  testDir: '.',
  testMatch: /playwright-script\.spec\.ts/,
  timeout: 5 * 60 * 1000, // 5 min: downloads + splitting + batched uploads
  expect: { timeout: 15 * 1000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    headless: process.env.HEADLESS === '1',
    acceptDownloads: true,
    actionTimeout: 30 * 1000,
    navigationTimeout: 60 * 1000,
    viewport: { width: 1440, height: 900 },
  },
});
