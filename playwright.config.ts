import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for two-peer async communication tests.
 *
 * These tests open two fully-isolated browser contexts (separate IndexedDB +
 * localStorage = separate peers) against the built app served by the production
 * server (`npm start`), which also attaches the in-memory WebSocket relay. Tests
 * drive the worker API directly via `window.__drive.*` (exposed by
 * src/client/test-bridge.ts, which is included in production builds).
 *
 * On NixOS the browsers Playwright downloads won't run, so we point at the
 * system Chromium. Override with CHROMIUM_BIN if it lives elsewhere.
 */
const chromiumPath =
  process.env.CHROMIUM_BIN || '/run/current-system/sw/bin/chromium';

// Run against the built app served by the production server (like Cypress),
// on a non-3000 port so it never collides with a running `npm run dev`.
const PORT = Number(process.env.PW_PORT) || 4445;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './src/client/tests-pw',
  // Each spec orchestrates two heavy WASM peers; keep them serial and give
  // generous time for keyhive init + eventual cross-peer sync.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // The fast `test:pw` run is strict (0 retries). The E2E_COVERAGE run serves an
  // istanbul-instrumented build that is several times slower, which can race the
  // WASM-heavy editor UI — allow retries there only.
  retries: process.env.E2E_COVERAGE ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL,
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
  // Build the frontend, then serve the built app (dist/) via the production
  // server — which also attaches the in-memory WebSocket relay the peers sync
  // through. Mirrors `test:cy`. `reuseExistingServer` lets a developer pre-run
  // `PORT=4445 npm start` (after a build) to skip the rebuild while iterating.
  webServer: {
    command: `npm run build && PORT=${PORT} npm start`,
    url: baseURL,
    // Reuse a developer's pre-built server while iterating — but never for a
    // coverage run, which needs a fresh E2E_COVERAGE-instrumented build.
    reuseExistingServer: !process.env.CI && !process.env.E2E_COVERAGE,
    // Forward the coverage flag so `npm run build` instruments via
    // vite-plugin-istanbul (window.__coverage__).
    env: process.env.E2E_COVERAGE ? { E2E_COVERAGE: '1' } : undefined,
    timeout: 300_000,
  },
});
