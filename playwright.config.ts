import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for two-peer async communication tests.
 *
 * These tests open two fully-isolated browser contexts (separate IndexedDB +
 * localStorage = separate peers) against the real app served by `npm run dev`,
 * which also attaches the in-memory WebSocket relay. Tests drive the worker API
 * directly via `window.__drive.*` (exposed dev-only by src/client/test-bridge.ts).
 *
 * On NixOS the browsers Playwright downloads won't run, so we point at the
 * system Chromium. Override with CHROMIUM_BIN if it lives elsewhere.
 */
const chromiumPath =
  process.env.CHROMIUM_BIN || '/run/current-system/sw/bin/chromium';

export default defineConfig({
  testDir: './tests-pw',
  // Each spec orchestrates two heavy WASM peers; keep them serial and give
  // generous time for keyhive init + eventual cross-peer sync.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: chromiumPath,
      // The combined automerge + keyhive WASM modules exceed the default
      // renderer heap (~4 GB). Mirror cypress.config.ts.
      args: [
        '--js-flags=--max-old-space-size=8192',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
