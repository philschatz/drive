import { defineConfig } from '@playwright/test';
import { existsSync } from 'fs';
import path from 'path';

/**
 * Playwright config for regenerating the deck's screenshots and screencasts.
 *
 * Separate from the repo's root playwright.config.ts on purpose: this one runs
 * `*.capture.ts` (not `*.spec.ts`) from this directory, which sits outside the
 * root config's testDir — so `npm run test:pw` never picks these up, and a
 * capture run never drags the test suite along with it.
 *
 * Everything else is deliberately copied from the root config: the NixOS system
 * Chromium resolution, the WASM heap bump, the WebRTC mDNS opt-out (without it
 * two local contexts stay on the relay and the "direct (P2P)" dots never fill),
 * and the build-then-serve webServer with reuseExistingServer.
 */
const chromiumPath = process.env.CHROMIUM_BIN || '/run/current-system/sw/bin/chromium';
const executablePath = existsSync(chromiumPath) ? chromiumPath : undefined;

const PORT = Number(process.env.PW_PORT) || 4445;
const baseURL = `http://localhost:${PORT}`;

/** Phone-sized frames — the app is mobile-first MD3, and the deck is portrait. */
export const VIEWPORT = { width: 430, height: 932 };

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.capture\.ts$/,
  fullyParallel: false,
  workers: 1,
  // A single asset can involve two WASM peers, a rendezvous handshake and a
  // video encode; the suite-wide 120s of the root config is not enough.
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  // Scratch space for raw .webm recordings and Playwright's own artifacts.
  // Gitignored; the finished .png/.gif land in docs/ instead.
  outputDir: '.work',
  use: {
    baseURL,
    viewport: VIEWPORT,
    // Crisp stills for slides. Ignored for video, which always records at the
    // CSS viewport size.
    deviceScaleFactor: 2,
    // Deliberately NOT isMobile/hasTouch: that switches Chromium to touch-only
    // event dispatch, and both the injected cursor overlay and the page.mouse
    // glide in cursor.ts depend on real mousemove events.
    trace: 'off',
    launchOptions: {
      executablePath,
      args: [
        '--js-flags=--max-old-space-size=8192',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    },
  },
  webServer: {
    command: `VITE_SYNC_INTERVAL_MS=250 npm run build && PORT=${PORT} npm start`,
    cwd: path.resolve(__dirname, '../..'),
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: { RELAY_QUIET: '1' },
  },
});
