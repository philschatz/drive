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
export async function openApp(
  browser: Browser,
  name = 'ui',
  contextOptions?: Parameters<Browser['newContext']>[0]
): Promise<App> {
  const context = await browser.newContext(contextOptions);
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
    else if (dialog.type() === 'confirm') void dialog.accept(); // proceed on confirm() (e.g. Archive)
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

/** Home Create-sheet item labels. */
type CreateLabel = 'Calendar' | 'Task list' | 'Spreadsheet' | 'Habit Tracker' | 'Sentences';

/**
 * Create a document through the home page FAB → Create sheet. Docs are created
 * as "Untitled", so the requested name is applied afterwards through the
 * editor's kebab → Rename → rename sheet (the title bar is plain text now, and
 * renaming is deliberate).
 */
export async function createDocViaUI(
  app: App,
  type: CreateLabel,
  name: string
): Promise<void> {
  await app.page.getByRole('button', { name: 'New document' }).click();
  // The Create bottom sheet lists one md-list-item per doc type. Scope to the
  // sheet (Home rows are md-list-items too) and match by substring — an
  // end-anchored regex fails against the shadow-DOM innerText's trailing
  // newline. The create labels don't contain each other, so substring is safe.
  await app.page
    .getByTestId('create-doc-sheet')
    .locator('md-list-item', { hasText: type })
    .click();
  // Every document type lands on the consolidated `#/d/<docId>` route.
  await expect(app.page).toHaveURL(/#\/d\//, { timeout: 15_000 });

  await expect(app.page.getByTestId('doc-title')).toBeVisible({ timeout: 15_000 });
  await renameDocViaUI(app, name);
}

/** Editor kebab → Rename → type → Save. */
export async function renameDocViaUI(app: App, name: string): Promise<void> {
  const page = app.page;
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByTitle('Rename').click();
  await expect(page.getByTestId('doc-rename-sheet')).toBeVisible({ timeout: 10_000 });
  await mdField(page, 'rename-input').fill(name);
  await page.getByTestId('rename-save').click();
  await expect(page.getByTestId('doc-title')).toHaveText(name, { timeout: 10_000 });
}

/** Select a value from a Radix UI Select by trigger id (ports cypress radixSelect). */
export async function radixSelect(page: Page, triggerId: string, label: string): Promise<void> {
  await page.locator(`#${triggerId}`).click();
  await expect(page.locator('[role="listbox"]')).toBeVisible();
  await page.locator('[role="option"]', { hasText: label }).click();
}

/**
 * The `md-outlined-select` twin of `radixSelect`. The menu renders in the top
 * layer (menuPositioning: 'popover'), so the options are not nested inside the
 * select — query them page-wide. Substring match, since shadow-DOM innerText
 * carries a trailing newline that defeats an anchored regex.
 */
export async function mdSelect(page: Page, selectId: string, label: string): Promise<void> {
  await page.locator(`#${selectId}`).click();
  const option = page.locator('md-select-option', { hasText: label }).first();
  await expect(option).toBeVisible();
  await option.click();
  // The menu animates out; waiting avoids the next click landing on it.
  await expect(option).toBeHidden();
}

/**
 * Open a PropertySheet property's detail pane. Editors show a property list
 * first, so a field is only in the DOM once its row has been tapped.
 */
export async function openProperty(page: Page, rowId: string): Promise<void> {
  await page.getByTestId(`${rowId}-row`).click();
}

/** Return to a PropertySheet's property list from a detail pane. */
export async function backToProperties(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Back' }).click();
}

/**
 * Fill an MdTextField. In the browser it renders `md-outlined-text-field`, whose
 * host `.fill()` would throw — Playwright's CSS engine pierces the open shadow
 * root, so target the inner control instead.
 */
export function mdField(page: Page, id: string) {
  return page.locator(`#${id} input, #${id} textarea`);
}
