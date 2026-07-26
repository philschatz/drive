import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, type App } from './support';

/**
 * DataGrid editor UI test. Editing is mobile-first: tapping a cell enters
 * focus mode and all typing happens in the bottom editor bar's CodeMirror
 * (contenteditable, so values are entered with pressSequentially, not fill()).
 */
test.describe.configure({ mode: 'serial' });

test.describe('DataGrid', () => {
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

  test('spreadsheet CRUD', async () => {
    const page = app.page;
    const cell = (col: number, row: number) =>
      page.locator(`[data-cell-col="${col}"][data-cell-row="${row}"]`);
    const editor = page.locator('.bottom-editor-cm .cm-content');

    /** Select a cell, type a value into the bottom editor, commit with Enter. */
    const setCell = async (col: number, row: number, text: string) => {
      await cell(col, row).click();
      await editor.click();
      await editor.pressSequentially(text, { delay: 30 });
      await editor.press('Enter');
    };

    // Selecting a cell enters focus mode and shows the bottom editor bar
    await cell(0, 0).click();
    await expect(page.getByTestId('focus-top-bar')).toBeVisible();
    await expect(page.getByTestId('bottom-editor-bar')).toBeVisible();
    await expect(page.getByTestId('quick-actions-row')).toBeVisible();

    // A1 = Hello
    await setCell(0, 0, 'Hello');
    await expect(cell(0, 0)).toContainText('Hello');

    // B1 = 42, B2 = 8
    await setCell(1, 0, '42');
    await expect(cell(1, 0)).toContainText('42');
    await setCell(1, 1, '8');
    await expect(cell(1, 1)).toContainText('8');

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

    // Done exits focus mode; rename the spreadsheet from the overview bar
    await page.getByRole('button', { name: 'Done' }).click();
    const nameInput = page.getByTestId('doc-title-input');
    await nameInput.fill('Renamed Sheet');
    await nameInput.blur();
    await expect(nameInput).toHaveValue('Renamed Sheet');
  });
});
