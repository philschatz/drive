import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

/**
 * Single-browser UI harness for the editor specs (calendar / tasks / datagrid).
 *
 * The peer harness in ./peer.ts drives the worker API on `window.__drive`; these
 * editor tests instead drive the rendered DOM. This module reuses the same
 * readiness wait (bridge present, worker + keyhive initialized) but hands back
 * the `page` so specs can click and type, and ports the fatal-worker detection
 * + benign-error ignore list that cypress/support/e2e.ts used to enforce.
 */

/** Fatal worker/keyhive failures arrive via console.error, not page errors. */
const FATAL_WORKER_RE =
  /(Automerge worker (failed to load|error)|Module load failed|\[worker\] Failed to load modules|Keyhive init failed)/i;

/** Background-sync noise that must NOT fail a UI test (mirrors cypress e2e.ts). */
function isBenignError(msg: string): boolean {
  if (msg.includes('is unavailable')) return true; // stale doc handle from a prior session
  if (msg.includes("'__k'") || msg.includes("'__c'")) return true; // preact lifecycle race on nav
  if (/^[a-zA-Z_$]{1,3} is not defined$/.test(msg)) return true; // minified sync-worker var
  if (msg.includes('is not defined')) return true;
  return false;
}

export interface App {
  page: Page;
  context: BrowserContext;
  /** Set the string the next window.prompt() (doc-name dialog) resolves to. */
  setPromptAnswer(answer: string): void;
  /** Throw if any fatal worker error was seen (call in afterAll). */
  assertNoFatalErrors(): void;
  close(): Promise<void>;
}

/**
 * Open a fresh, fully-isolated app page and wait for the worker + keyhive to be
 * ready. Registers a dialog handler (the home-page "New" flow uses window.prompt
 * for the doc name) and records fatal worker errors so a failed worker load fails
 * the test instead of silently passing.
 */
export async function openApp(browser: Browser, name = 'ui'): Promise<App> {
  const context = await browser.newContext();
  const page = await context.newPage();

  const fatalErrors: string[] = [];
  const record = (msg: string) => {
    if (FATAL_WORKER_RE.test(msg)) fatalErrors.push(msg);
  };
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      record(text);
      if (!isBenignError(text)) console.log(`[${name}] console.error: ${text}`);
    }
  });
  page.on('pageerror', (err) => {
    record(err.message);
    if (!isBenignError(err.message)) console.log(`[${name}] pageerror: ${err.message}`);
  });

  // The doc-name prompt: default to "Untitled"; specs override via setPromptAnswer.
  let promptAnswer = 'Untitled';
  page.on('dialog', (dialog) => {
    if (dialog.type() === 'prompt') void dialog.accept(promptAnswer);
    else void dialog.dismiss();
  });

  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
  await page.evaluate(() =>
    Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady])
  );

  return {
    page,
    context,
    setPromptAnswer: (answer: string) => {
      promptAnswer = answer;
    },
    assertNoFatalErrors: () => {
      if (fatalErrors.length) {
        const errs = [...new Set(fatalErrors)];
        throw new Error('Automerge worker reported fatal error(s):\n' + errs.join('\n'));
      }
    },
    close: () => context.close(),
  };
}

/** Hash route fragment each document type lands on after creation. */
const URL_FRAGMENT = {
  Calendar: /#\/calendars\//,
  'Task list': /#\/tasks\//,
  Spreadsheet: /#\/datagrids\//,
} as const;

/**
 * Create a document through the home page "New" menu (mirrors the Cypress
 * before() hooks): set the prompt answer, open the dropdown, pick the type, and
 * wait for the editor route.
 */
export async function createDocViaUI(
  app: App,
  type: keyof typeof URL_FRAGMENT,
  name: string
): Promise<void> {
  app.setPromptAnswer(name);
  await app.page.getByRole('button', { name: 'New' }).click();
  await app.page.getByRole('menuitem', { name: type }).click();
  await expect(app.page).toHaveURL(URL_FRAGMENT[type], { timeout: 15_000 });
}

/** Select a value from a Radix UI Select by trigger id (ports cypress radixSelect). */
export async function radixSelect(page: Page, triggerId: string, label: string): Promise<void> {
  await page.locator(`#${triggerId}`).click();
  await expect(page.locator('[role="listbox"]')).toBeVisible();
  await page.locator('[role="option"]', { hasText: label }).click();
}

/**
 * Collect istanbul coverage (window.__coverage__, present only in instrumented
 * E2E_COVERAGE builds) and write it under coverage/playwright/ so the existing
 * `coverage:merge` (`nyc merge coverage ...`) picks it up alongside jest output.
 * No-op when the page is not instrumented.
 */
export async function collectCoverage(page: Page, label: string): Promise<void> {
  const coverage = await page.evaluate(() => (window as any).__coverage__ ?? null);
  if (!coverage) return;
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.resolve(process.cwd(), 'coverage', 'playwright');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `pw-${label}.json`), JSON.stringify(coverage));
}
