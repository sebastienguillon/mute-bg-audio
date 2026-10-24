import { defineConfig } from '@playwright/test';

// End-to-end tests load the e2e build of the extension (.output/chrome-mv3-e2e, which has the
// debug bridge) into Playwright's Chromium. Run `pnpm build:e2e` first (pnpm test:e2e does it).
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
