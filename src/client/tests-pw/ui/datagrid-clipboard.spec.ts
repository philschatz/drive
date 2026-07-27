import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, type App } from './support';

/**
 * Grid clipboard round trips, in a real browser (the only place a native
 * ClipboardEvent and the async Clipboard API exist at all).
 *
 * The asymmetry these guard: Ctrl+C is handled entirely in the grid's keydown
 * handler, while Ctrl+V used to depend *solely* on a native `paste` event
 * reaching one conditionally-rendered container. Whenever that event didn't
 * arrive, copy kept working and paste silently did nothing.
 */
test.describe.configure({ mode: 'serial' });

test.describe('DataGrid clipboard', () => {
  let app: App;

  test.beforeAll(async ({ browser }) => {
    app = await openApp(browser, 'datagrid-clipboard');
    await createDocViaUI(app, 'Spreadsheet', 'Clipboard');
    await expect(app.page.locator('.datagrid-table')).toBeVisible({ timeout: 10_000 });
  });

  test.afterAll(async () => {
    app.assertNoFatalErrors();
    await app.close();
  });

  const cell = (c: number, r: number) =>
    app.page.locator(`[data-cell-col="${c}"][data-cell-row="${r}"]`);

  /** Select a cell and type a value through the bottom editor bar. */
  const setCell = async (c: number, r: number, text: string) => {
    const editor = app.page.locator('.bottom-editor-cm .cm-content');
    await cell(c, r).click();
    await editor.click();
    await editor.pressSequentially(text, { delay: 20 });
    await editor.press('Enter');
    await expect(cell(c, r)).toContainText(text);
  };

  test('copy a cell, then paste it more than once', async () => {
    const page = app.page;
    await setCell(0, 0, 'Src');

    // Re-select the source: committing with Enter advances the selection.
    await cell(0, 0).click();
    await page.keyboard.press('ControlOrMeta+c');

    await cell(1, 1).click();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(cell(1, 1)).toContainText('Src');

    // Copy once, paste many — the internal clipboard is consumed by the first
    // paste, so this second one proves the OS-clipboard path works too.
    await cell(2, 2).click();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(cell(2, 2)).toContainText('Src');
  });

  test('paste TSV from another app', async () => {
    const page = app.page;
    // Put tab/newline-separated text on the clipboard the way a spreadsheet or
    // text editor would, with nothing copied in-app.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('ext1\text2\next3\text4'));
    await page.reload();
    await expect(page.locator('.datagrid-table')).toBeVisible({ timeout: 20_000 });

    await cell(0, 4).click();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(cell(0, 4)).toContainText('ext1');
    await expect(cell(1, 4)).toContainText('ext2');
    await expect(cell(0, 5)).toContainText('ext3');
    await expect(cell(1, 5)).toContainText('ext4');
  });

  test('a paste into the formula editor is left alone', async () => {
    const page = app.page;
    // The grid's listener is on `document`, so it must ignore an event whose
    // target is outside the grid container — otherwise typing a formula and
    // pasting into it would splatter cells instead.
    const editor = page.locator('.bottom-editor-cm .cm-content');
    await cell(2, 6).click();
    await editor.click();
    await page.keyboard.press('ControlOrMeta+v');
    await page.waitForTimeout(300);
    // Whatever the editor did with it, the grid must not have written C7's
    // neighbours as if it were a grid-level paste.
    await expect(cell(0, 6)).toHaveText('');
  });
});
