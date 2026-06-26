import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, type App } from './support';

/**
 * DataGrid editor UI test (ported from cypress/e2e/datagrid.cy.ts). CodeMirror
 * cell/formula editors are contenteditable, so values are entered with
 * pressSequentially (real keystrokes), not fill().
 */
test.describe.configure({ mode: 'serial' });

test.describe('DataGrid', () => {
  let app: App;

  /** Type into the active CodeMirror cell editor. */
  const typeInCell = (text: string) =>
    app.page.locator('.cell-editor-cm .cm-content').pressSequentially(text, { delay: 30 });

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

    // A1 = Hello
    await cell(0, 0).dblclick();
    await typeInCell('Hello');
    await page.locator('.cell-editor-cm .cm-content').press('Enter');
    await expect(cell(0, 0)).toContainText('Hello');

    // B1 = 42
    await cell(1, 0).dblclick();
    await typeInCell('42');
    await page.locator('.cell-editor-cm .cm-content').press('Enter');
    await expect(cell(1, 0)).toContainText('42');

    // B2 = 8
    await cell(1, 1).dblclick();
    await typeInCell('8');
    await page.locator('.cell-editor-cm .cm-content').press('Enter');
    await expect(cell(1, 1)).toContainText('8');

    // Let the HF worker process the cell values via automerge sync
    await page.waitForTimeout(500);

    // B3 = =B1+B2 -> 50 (async HF evaluation; allow extra time)
    await cell(1, 2).dblclick();
    await typeInCell('=B1+B2');
    await page.locator('.cell-editor-cm .cm-content').press('Enter');
    await expect(cell(1, 2)).toContainText('50', { timeout: 10_000 });

    // Edit A1 via the formula bar
    await cell(0, 0).click();
    const formulaBar = page.locator('.formula-bar-cm .cm-content');
    await formulaBar.click();
    await formulaBar.press('ControlOrMeta+a');
    await formulaBar.pressSequentially('Updated', { delay: 30 });
    await formulaBar.press('Enter');
    await expect(cell(0, 0)).toContainText('Updated');

    // Rename the spreadsheet
    const nameInput = page.locator('input.text-lg');
    await nameInput.fill('Renamed Sheet');
    await nameInput.blur();
    await expect(nameInput).toHaveValue('Renamed Sheet');
  });
});
