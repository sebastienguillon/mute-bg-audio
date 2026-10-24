import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    include: ['test/unit/**/*.test.ts'],
    // Generates the test media once before the workers start (they all read it).
    globalSetup: ['test/unit/global-setup.ts'],
    // Several files start Chromium or run the real models: leave CPU headroom for the timing checks.
    maxWorkers: '50%',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
