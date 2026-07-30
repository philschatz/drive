import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, renameDocViaUI, type App } from './support';

/**
 * The DataGrid on a desktop viewport: the two things about it that only a real
 * browser has. CodeMirror is a contenteditable, so values go in with
 * pressSequentially rather than fill(); and clipboard work needs a native
 * ClipboardEvent and the async Clipboard API, which exist nowhere else.
 *
 * The formula semantics behind all of it are covered exhaustively in Jest
 * (datagrid.test.ts, formula-parser.test.ts, commands.test.ts) — including the
 * parse and dispatch halves of paste. The asymmetry the clipboard cases guard is
 * the wiring: Ctrl+C is handled entirely in the grid's keydown handler, while
 * Ctrl+V used to depend *solely* on a native `paste` event reaching one
 * conditionally-rendered container. Whenever that event didn't arrive, copy kept
 * working and paste silently did nothing.
 *
 * One app boot for both concerns; the grid CRUD runs first so the clipboard cases
 * inherit a populated sheet.
 */
test.describe.configure({ mode: 'serial' });

test.describe('DataGrid (desktop)', () => {
  let app: App;

  test.beforeAll(async ({ browser }) => {
    app = await openApp(browser, 'datagrid');
    await createDocViaUI(app, 'Spreadsheet', 'Test Spreadsheet');
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

  test('spreadsheet CRUD', async () => {
    const page = app.page;
    const editor = page.locator('.bottom-editor-cm .cm-content');

    // Selecting a cell enters focus mode and shows the bottom editor bar
    await cell(0, 0).click();
    await expect(page.getByTestId('focus-top-bar')).toBeVisible();
    await expect(page.getByTestId('bottom-editor-bar')).toBeVisible();
    await expect(page.getByTestId('quick-actions-row')).toBeVisible();

    // A1 = Hello, B1 = 42, B2 = 8 (setCell asserts each landed)
    await setCell(0, 0, 'Hello');
    await setCell(1, 0, '42');
    await setCell(1, 1, '8');

    // Let the HF worker process the cell values via automerge sync
    await page.waitForTimeout(500);

    // B3 = =B1+B2 -> 50, using the char strip's "=" key (which replaces the
    // quick actions while the editor is focused)
    await cell(1, 2).click();
    await editor.click();
    await expect(page.getByTestId('formula-char-strip')).toBeVisible();
    await expect(page.getByTestId('quick-actions-row')).toHaveCount(0);
    await page.getByRole('button', { name: 'Insert =' }).click();
    await editor.pressSequentially('B1+B2', { delay: 30 });
    await editor.press('Enter');
    await expect(cell(1, 2)).toContainText('50', { timeout: 10_000 });

    // Edit A1 in place: selecting it shows its value in the bottom editor
    await cell(0, 0).click();
    await editor.click();
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('Updated', { delay: 30 });
    await editor.press('Enter');
    await expect(cell(0, 0)).toContainText('Updated');

    // Done exits focus mode; rename the spreadsheet from the overview bar's
    // kebab (the title is plain text now — renaming is deliberate).
    await page.getByRole('button', { name: 'Done' }).click();
    await renameDocViaUI(app, 'Renamed Sheet');
  });

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
