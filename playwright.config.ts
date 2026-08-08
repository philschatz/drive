import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

/**
 * Playwright config for two-peer async communication tests.
 *
 * These tests open two fully-isolated browser contexts (separate IndexedDB +
 * localStorage = separate peers) against the built app served by the production
 * server (`npm start`), which also attaches the in-memory WebSocket relay. Tests
 * drive the worker API directly via `window.__drive.*` (exposed by
 * src/client/ui/test-bridge.ts, which is included in production builds).
 *
 * On NixOS the browsers Playwright downloads won't run, so we point at the
 * system Chromium. Override with CHROMIUM_BIN if it lives elsewhere. When
 * neither exists (e.g. CI, where `npx playwright install chromium` provides the
 * bundled browser), leave executablePath undefined so Playwright uses its own.
 */
const chromiumPath =
  process.env.CHROMIUM_BIN || '/run/current-system/sw/bin/chromium';
const executablePath = existsSync(chromiumPath) ? chromiumPath : undefined;

// Run against the built app served by the production server, on a non-3000 port
// so it never collides with a running `npm run dev`.
//
// With no PW_PORT we probe for a port nothing is listening on. That is what makes
// `reuseExistingServer` below safe: a free port has no server to reuse, so every
// run rebuilds. Setting PW_PORT explicitly is therefore the deliberate opt-in to
// reuse — pre-run `PORT=4445 npm start` after a build, then `PW_PORT=4445
// playwright test` to iterate without the multi-minute rebuild.
function pickPort(): number {
  const explicit = Number(process.env.PW_PORT);
  if (explicit) return explicit;
  // Node has no synchronous bind, and Playwright never awaits an async default
  // export — so probe in a child process. Candidates sit below Linux's ephemeral
  // range (32768+) so the kernel never hands one out to an outgoing socket.
  const probe = `
    const net = require('net');
    const free = (p) => new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, '0.0.0.0', () => s.close(() => res(true)));
    });
    (async () => {
      for (let i = 0; i < 100; i++) {
        const p = 4500 + Math.floor(Math.random() * 500);
        if (await free(p)) return process.stdout.write(String(p));
      }
      process.exit(1);
    })();
  `;
  const out = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim();
  const port = Number(out);
  if (!port) throw new Error('playwright.config: found no free port in 4500-4999');
  // Playwright re-requires this config in the loader and in every worker process,
  // all forked with the parent's env — so publish the choice or they would each
  // roll their own port and point baseURL somewhere the server is not.
  process.env.PW_PORT = String(port);
  console.log(`[playwright] auto-selected port ${port}`);
  return port;
}

const PORT = pickPort();
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './src/client/tests-pw',
  // Each spec orchestrates two heavy WASM peers; keep them serial and give
  // generous time for keyhive init + eventual cross-peer sync.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath,
      // The combined automerge + keyhive WASM modules exceed the default
      // renderer heap (~4 GB).
      args: [
        '--js-flags=--max-old-space-size=8192',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        // Expose real loopback ICE candidates instead of mDNS `.local` ones so
        // two local contexts can establish a direct WebRTC channel reliably
        // (the webrtc-direct spec); only affects WebRTC, unused by other specs.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
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
  // through. `reuseExistingServer` lets a developer pre-run
  // `PORT=4445 npm start` (after a build) and then `PW_PORT=4445 playwright test`
  // to skip the rebuild while iterating. That shortcut is opt-in by port: a run
  // without PW_PORT gets a port that was free a moment ago, so there is nothing
  // to reuse and it always rebuilds.
  webServer: {
    // VITE_SYNC_INTERVAL_MS shrinks keyhive's cross-peer sync round from the 2000ms
    // production default so the two-peer specs converge in a fraction of the time
    // (build-time only — the deploy build never sets it, keeping the prod default).
    command: `VITE_SYNC_INTERVAL_MS=250 npm run build && PORT=${PORT} npm start`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    // Silence the relay's per-message firehose + expected-hardening logs during
    // tests; genuine internal-failure logs (raw console.error) still print. See
    // RELAY_QUIET in src/relay/relay-log.ts.
    env: { RELAY_QUIET: '1' },
  },
});
