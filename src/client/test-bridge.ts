/**
 * Dev-only test bridge.
 *
 * Exposes the worker API on `window.__drive` so Playwright tests can drive the
 * real running app at the worker-message layer (no DOM clicking) — see
 * tests-pw/. Importing this module also boots the worker singleton (it does so
 * already via the app, but importing here makes the dependency explicit).
 *
 * This is imported from main.tsx behind `if (import.meta.env.DEV)`, so it is
 * never included in production builds.
 */

import * as workerApi from './worker-api';
import { workerReady, keyhiveReady } from './worker-api';
import {
  removeDocId,
  getDocList,
  onDocListUpdated,
} from './doc-storage';

const bridge = {
  ...workerApi,
  // doc-list helpers (these live in doc-storage, not worker-api)
  removeDocId,
  getDocList,
  onDocListUpdated,
  // readiness promises so tests can await a fully-initialized peer
  workerReady,
  keyhiveReady,
};

(window as any).__drive = bridge;

export type DriveBridge = typeof bridge;
