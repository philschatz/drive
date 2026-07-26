import { test, expect, type Page } from '@playwright/test';
import { openApp, createDocViaUI, type App } from './support';

/**
 * Mobile (touch) interactions for the DataGrid editor: focus mode via tap,
 * selection resize by dragging from inside the selection, panning from
 * outside it, hide-on-scroll chrome, and the aggregates row.
 *
 * Touch drags are synthesized over CDP (Playwright's touchscreen only taps);
 * Chromium turns dispatchTouchEvent sequences into pointer events with
 * pointerType "touch", which is exactly what the grid handlers key on.
 */
test.describe.configure({ mode: 'serial' });

async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y }],
  });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test.describe('DataGrid mobile', () => {
  let app: App;

  const cell = (col: number, row: number) =>
    app.page.locator(`[data-cell-col="${col}"][data-cell-row="${row}"]`);

  test.beforeAll(async ({ browser }) => {
    app = await openApp(browser, 'datagrid-mobile', {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    await createDocViaUI(app, 'Spreadsheet', 'Mobile Grid');
    await expect(app.page.locator('.datagrid-table')).toBeVisible({ timeout: 10_000 });
  });

  test.afterAll(async () => {
    app.assertNoFatalErrors();
    await app.close();
  });

  test('tap enters focus mode and highlights headers', async () => {
    const page = app.page;
    const box = (await cell(1, 1).boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page.getByTestId('focus-top-bar')).toBeVisible();
    await expect(page.getByTestId('bottom-editor-bar')).toBeVisible();
    await expect(cell(1, 1)).toHaveClass(/selected/);
    // Row 2 / column B headers highlighted
    await expect(page.locator('.datagrid-col-header.active')).toHaveText('B');
    await expect(page.locator('.datagrid-row-header.active')).toHaveText('2');
    // Corner decorations (visual-only; the BR corner doubles as the autofill
    // handle when editing is allowed)
    await expect(page.locator('.selection-handle.handle-tl')).toBeVisible();
    await expect(page.locator('.selection-handle.handle-br, .autofill-handle')).toBeVisible();
  });

  test('touch drag from inside the selection resizes it', async () => {
    const page = app.page;
    const from = (await cell(1, 1).boundingBox())!;
    const to = (await cell(2, 3).boundingBox())!;
    await touchDrag(
      page,
      { x: from.x + from.width / 2, y: from.y + from.height / 2 },
      { x: to.x + to.width / 2, y: to.y + to.height / 2 },
    );
    // B2:C4 selected → 2 cols × 3 rows in range
    await expect(page.locator('.datagrid-cell.in-range')).toHaveCount(6);
    await expect(page.getByTestId('focus-top-bar')).toContainText('B2:C4');
    // Multi-cell selection hides the formula editor (no numeric cells → no aggregates either)
    await expect(page.locator('.bottom-editor-cm')).toHaveCount(0);
  });

  test('touch drag outside the selection pans and keeps it', async () => {
    const page = app.page;

    // Give the grid enough rows to overflow the viewport (initial docs have
    // only 10) — through the worker API, mutation callbacks are serialized so
    // the function must not close over anything.
    const docId = /#\/d\/([^/?]+)/.exec(page.url())![1];
    await page.evaluate((docId) => {
      return (window as any).__drive.updateDoc(docId, (doc: any) => {
        const sheet = doc.sheets[Object.keys(doc.sheets)[0]];
        let maxIdx = 0;
        for (const r of Object.values(sheet.rows) as any[]) maxIdx = Math.max(maxIdx, r.index);
        for (let i = 1; i <= 60; i++) {
          sheet.rows['trow' + String(i).padStart(4, '0')] = { index: maxIdx + i };
        }
      });
    }, docId);
    await expect(page.locator('.datagrid-row-header').filter({ hasText: /^30$/ })).toHaveCount(1, { timeout: 10_000 });

    const container = page.locator('.datagrid-container');
    const scrollBefore = await container.evaluate(el => el.scrollTop);

    // Start over an unselected cell well below the selection and swipe up
    const start = (await cell(0, 8).boundingBox())!;
    await touchDrag(
      page,
      { x: start.x + start.width / 2, y: start.y + start.height / 2 },
      { x: start.x + start.width / 2, y: start.y - 120 },
    );

    const scrollAfter = await container.evaluate(el => el.scrollTop);
    expect(scrollAfter).toBeGreaterThan(scrollBefore);
    // Selection survived the pan
    await expect(page.getByTestId('focus-top-bar')).toContainText('B2:C4');
  });

  test('aggregates replace the editor for numeric selections', async () => {
    const page = app.page;
    const editor = page.locator('.bottom-editor-cm .cm-content');

    // The pan test left the grid scrolled — B2 would sit under the sticky
    // headers and a tap would hit the header instead of the cell.
    await page.locator('.datagrid-container').evaluate(el => { el.scrollTop = 0; });

    // Exit back to a single cell and enter two numbers
    const b2 = (await cell(1, 1).boundingBox())!;
    await page.touchscreen.tap(b2.x + 5, b2.y + 5);
    await editor.click();
    await editor.pressSequentially('10', { delay: 30 });
    await editor.press('Enter'); // commits, selection advances to B3
    await editor.click();
    await editor.pressSequentially('20', { delay: 30 });
    await editor.press('Enter');

    // Select B2:B3 by touch-dragging from B2 (tap first to select it)
    const from = (await cell(1, 1).boundingBox())!;
    await page.touchscreen.tap(from.x + 5, from.y + 5);
    const to = (await cell(1, 2).boundingBox())!;
    await touchDrag(
      page,
      { x: from.x + from.width / 2, y: from.y + from.height / 2 },
      { x: to.x + to.width / 2, y: to.y + to.height / 2 },
    );

    const strip = page.getByTestId('aggregates-strip');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText('Sum: 30');
    await expect(strip).toContainText('Avg: 15');
    await expect(strip).toContainText('Count: 2');
    await expect(page.locator('.bottom-editor-cm')).toHaveCount(0);
  });

  test('sheet management: tabs, list, options, freeze steppers', async () => {
    const page = app.page;

    // Back to overview mode → sheet tabs bar visible
    await page.getByRole('button', { name: 'Done' }).click();
    const tabsBar = page.getByTestId('sheet-tabs-bar');
    await expect(tabsBar).toBeVisible();

    // Add a second sheet (becomes active)
    await page.getByRole('button', { name: 'Add sheet' }).click();
    await expect(tabsBar.locator('[data-sheet-tab]')).toHaveCount(2);

    // Tap the active tab → options sheet; rename it
    await tabsBar.locator('[data-sheet-tab]', { hasText: 'Sheet 2' }).click();
    const options = page.getByTestId('sheet-options-sheet');
    await expect(options).toBeVisible();
    const nameInput = page.getByTestId('sheet-name-input');
    await nameInput.fill('Budget');
    await nameInput.press('Enter');
    await expect(tabsBar.locator('[data-sheet-tab]', { hasText: 'Budget' })).toBeVisible();

    // Move left swaps the tab order (md-list-item rows, not buttons)
    const moveLeft = options.locator('md-list-item', { hasText: 'Move left' });
    const moveRight = options.locator('md-list-item', { hasText: 'Move right' });
    await expect.poll(() => moveRight.evaluate((el: any) => el.disabled)).toBe(true);
    await moveLeft.click();
    await expect(tabsBar.locator('[data-sheet-tab]').first()).toContainText('Budget');
    await expect.poll(() => moveLeft.evaluate((el: any) => el.disabled)).toBe(true);

    // Freeze 2 rows via the stepper; down disabled at 0, value updates
    const rowsUp = page.getByRole('button', { name: 'Increase frozen rows' });
    const rowsDown = page.getByRole('button', { name: 'Decrease frozen rows' });
    await expect(rowsDown).toBeDisabled();
    await rowsUp.click();
    await rowsUp.click();
    await expect(page.getByTestId('freeze-rows-stepper-value')).toHaveText('2');
    // Frozen rows render (boundary indicator on the last frozen row)
    await expect(page.locator('.frozen-row-last').first()).toBeVisible();

    // Hide the active sheet from options → falls back to the other sheet
    await options.locator('md-list-item', { hasText: 'Hide sheet' }).click();
    await expect(options).not.toBeVisible();
    await expect(tabsBar.locator('[data-sheet-tab]')).toHaveCount(1);

    // The all-sheets list shows the hidden sheet in italics; the active one has a check
    await page.getByRole('button', { name: 'All sheets' }).click();
    const list = page.getByTestId('sheet-list-sheet');
    await expect(list).toBeVisible();
    const hiddenRow = list.locator('md-list-item', { hasText: 'Budget' });
    await expect(hiddenRow.locator('div.italic')).toBeVisible();
    await expect(list.locator('md-list-item', { hasText: 'Sheet 1' }).locator('md-icon').first()).toHaveText('check');

    // Picking the hidden sheet unhides and selects it
    await hiddenRow.click();
    await expect(list).not.toBeVisible();
    await expect(tabsBar.locator('[data-sheet-tab]')).toHaveCount(2);
    await expect(tabsBar.locator('[data-sheet-tab]', { hasText: 'Budget' })).toHaveClass(/bg-secondary-container/);
  });

  test('scrolling down hides the chrome, scrolling up reveals it', async () => {
    const page = app.page;

    // Overview mode (no chrome hiding in focus mode), back on the tall sheet
    await page.getByTestId('sheet-tabs-bar').locator('[data-sheet-tab]', { hasText: 'Sheet 1' }).click();
    await expect(page.getByTestId('doc-title-input')).toBeVisible();
    const pageEl = page.locator('.datagrid-page');

    const container = page.locator('.datagrid-container');
    // Scroll down within the grid
    await container.evaluate(el => { el.scrollTop = 200; });
    await expect(pageEl).toHaveClass(/chrome-hidden/);

    // Scroll back up
    await container.evaluate(el => { el.scrollTop = 150; });
    await expect(pageEl).not.toHaveClass(/chrome-hidden/);
  });

  test('format sheet applies formatting and opens conditional rules', async () => {
    const page = app.page;
    await page.locator('.datagrid-container').evaluate(el => { el.scrollTop = 0; });

    // B2 (value 10 from the aggregates test)
    const b2 = (await cell(1, 1).boundingBox())!;
    await page.touchscreen.tap(b2.x + 5, b2.y + 5);
    await expect(page.getByTestId('focus-top-bar')).toBeVisible();

    await page.getByRole('button', { name: 'Text formatting' }).click();
    const sheet = page.getByTestId('format-sheet');
    await expect(sheet).toBeVisible();

    // Bold applies immediately; the sheet stays open (formatting is iterative)
    await sheet.getByRole('button', { name: 'Bold' }).click();
    await expect(cell(1, 1)).toHaveCSS('font-weight', '700');
    await expect(sheet).toBeVisible();

    // Number format: Percent
    await sheet.locator('md-list-item', { hasText: 'Percent' }).click();
    await expect(cell(1, 1)).toContainText('1000.00%');

    // Clear formatting resets both
    await sheet.locator('md-list-item', { hasText: 'Clear formatting' }).click();
    await expect(cell(1, 1)).toHaveCSS('font-weight', '400');
    await expect(cell(1, 1)).toContainText('10');

    // Conditional formatting swaps to its own sheet
    await sheet.locator('md-list-item', { hasText: 'Conditional formatting' }).click();
    const cond = page.getByTestId('cond-format-sheet');
    await expect(cond).toBeVisible();
    await expect(sheet).toHaveCount(0);

    // Add a rule: B2:B3 greater than 15 → default yellow fill on B3 (20) only
    await cond.getByRole('button', { name: 'Add rule' }).click();
    await page.getByPlaceholder('A1:C10, E1:E20').fill('B2:B3');
    await page.getByPlaceholder('Enter value...').fill('15');
    await cond.getByRole('button', { name: 'Save' }).click();
    await expect(cell(1, 2)).toHaveCSS('background-color', 'rgb(255, 255, 0)', { timeout: 10_000 });
    await expect(cell(1, 1)).not.toHaveCSS('background-color', 'rgb(255, 255, 0)');

    await page.keyboard.press('Escape');
    await expect(cond).not.toBeVisible();
  });
});
