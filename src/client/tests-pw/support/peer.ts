import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { DriveBridge } from '../../ui/test-bridge';

/**
 * The callable members of `window.__drive` (the worker API). Filters `DriveBridge`
 * down to its function-valued keys, dropping non-callable members like the
 * `workerReady` / `keyhiveReady` promises — so `peer.call` only accepts real
 * method names and derives their argument/return types automatically.
 */
type DriveApi = {
  [K in keyof DriveBridge as DriveBridge[K] extends (...args: any[]) => any ? K : never]: DriveBridge[K];
};

/**
 * A Peer is one isolated browser context (its own IndexedDB + localStorage =
 * its own keyhive identity / device) running the real app, plus a thin proxy
 * for calling the worker API exposed on `window.__drive`.
 *
 * Tests drive flows by calling `peer.call('<fnName>', ...args)`, which invokes
 * `window.__drive.<fnName>(...args)` inside that context and returns the awaited
 * result. Payloads moved between peers (contact cards, group ids, doc ids) are
 * plain strings/JSON, so they cross the test boundary cleanly.
 */
export interface Peer {
  name: string;
  context: BrowserContext;
  page: Page;
  /**
   * Invoke window.__drive[fn](...args) in this context and return the result.
   * `fn` is constrained to the real worker-API method names, and its arguments
   * and return type are inferred from the method's signature (see DriveApi).
   */
  call<K extends keyof DriveApi>(
    fn: K,
    ...args: Parameters<DriveApi[K]>
  ): Promise<Awaited<ReturnType<DriveApi[K]>>>;
  close(): Promise<void>;
}

/** Create a fresh, fully-isolated peer and wait for the worker + keyhive to be ready. */
export async function newPeer(browser: Browser, name: string): Promise<Peer> {
  const context = await browser.newContext();
  const page = await context.newPage();

  // Surface in-page errors to the test runner output for debugging.
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[${name}] console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`[${name}] pageerror: ${err.message}`));

  await page.goto('/');

  // Wait for the dev-only bridge to attach, then for worker + keyhive init.
  await page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
  await page.evaluate(() =>
    Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady])
  );

  const call = <K extends keyof DriveApi>(
    fn: K,
    ...args: Parameters<DriveApi[K]>
  ): Promise<Awaited<ReturnType<DriveApi[K]>>> =>
    page.evaluate(
      ({ fn, args }) => {
        const api = (window as any).__drive;
        if (typeof api[fn] !== 'function') {
          throw new Error(`window.__drive.${fn} is not a function`);
        }
        return Promise.resolve(api[fn](...args));
      },
      { fn, args }
    ) as Promise<Awaited<ReturnType<DriveApi[K]>>>;

  return {
    name,
    context,
    page,
    call,
    close: () => context.close(),
  };
}

/**
 * Block until each page can see the other's presence, i.e. both workers hold the
 * document and have exchanged readable presence.
 *
 * Any test that asserts on a peer's presence needs this barrier first. Presence is
 * ephemeral with no replay, so a broadcast sent before the other side's worker has
 * joined is gone for good — and the sender has no reason to send another unless
 * something changes on its side. The capture suite hit exactly this and measured
 * it: see the `bothSeeEachOther` doc comment in docs/capture/assets.capture.ts.
 *
 * A peer-dot is the right signal because it only renders off the `viewing`
 * channel, which means that channel decrypted — so the doc's keyhive epoch has
 * converged far enough for any other channel to be readable too.
 */
export async function bothSeeEachOther(a: Page, b: Page, timeout = 90_000): Promise<void> {
  for (const page of [a, b]) {
    await expect(page.getByTestId('peer-dot').first()).toBeVisible({ timeout });
  }
}

/**
 * Poll an async producer until `predicate` is satisfied (or time out).
 * Used to assert eventual cross-peer convergence — sync is not instantaneous.
 */
export async function waitFor<T>(
  produce: () => Promise<T>,
  predicate: (value: T) => boolean,
  opts: { timeout?: number; interval?: number; label?: string } = {}
): Promise<T> {
  const timeout = opts.timeout ?? 30_000;
  const interval = opts.interval ?? 300;
  const start = Date.now();
  let last: T | undefined;
  let lastErr: unknown;
  while (Date.now() - start < timeout) {
    try {
      last = await produce();
      if (predicate(last)) return last;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  const detail = lastErr
    ? `last error: ${(lastErr as Error).message}`
    : `last value: ${JSON.stringify(last)}`;
  throw new Error(`waitFor(${opts.label ?? 'condition'}) timed out after ${timeout}ms; ${detail}`);
}
