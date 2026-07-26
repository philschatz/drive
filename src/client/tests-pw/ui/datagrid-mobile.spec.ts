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
    // B2:C4 selected → 2 cols × 3 rows in range, C4 the primary cell
    await expect(page.locator('.datagrid-cell.in-range')).toHaveCount(6);
    await expect(cell(2, 3)).toHaveClass(/selected/);
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
    await expect(page.locator('.datagrid-cell.in-range')).toHaveCount(6);
    await expect(page.getByTestId('focus-top-bar')).toBeVisible();
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

    // Move left swaps the tab order. Unavailable actions are omitted, not
    // disabled: Budget is last, so only "Move left" is offered.
    const moveLeft = options.locator('md-list-item', { hasText: 'Move left' });
    const moveRight = options.locator('md-list-item', { hasText: 'Move right' });
    await expect(moveRight).toHaveCount(0);
    await moveLeft.click();
    await expect(tabsBar.locator('[data-sheet-tab]').first()).toContainText('Budget');
    // Now first: "Move left" disappears and "Move right" appears
    await expect(moveLeft).toHaveCount(0);
    await expect(moveRight).toHaveCount(1);

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

  test('frozen rows pin flush under the header and cover scrolling rows', async () => {
    const page = app.page;
    const container = page.locator('.datagrid-container');
    await container.evaluate(el => { el.scrollTop = 0; });

    // Freeze the first row via the sheet options stepper
    const tabsBar = page.getByTestId('sheet-tabs-bar');
    await tabsBar.locator('[data-sheet-tab]', { hasText: 'Sheet 1' }).click();
    await page.getByRole('button', { name: 'Increase frozen rows' }).click();
    await expect(page.getByTestId('freeze-rows-stepper-value')).toHaveText('1');
    await page.keyboard.press('Escape');

    // Stored as a count on the sheet, not per-row flags
    const docId = /#\/d\/([^/?]+)/.exec(page.url())![1];
    const sheet = await page.evaluate((docId) =>
      (window as any).__drive.queryDoc(docId, '.sheets | to_entries | map(.value) | .[0]'), docId);
    expect(sheet.result.frozenRows).toBe(1);
    expect(Object.values(sheet.result.rows).some((r: any) => r.frozen)).toBe(false);

    // Measure the sticky header *cell* — the <thead> element itself isn't
    // sticky (its <th>s are), so its rect is meaningless once scrolled.
    const geom = async () => page.evaluate(() => {
      const colHeader = document.querySelector('.datagrid-col-header')!.getBoundingClientRect();
      const headers = [...document.querySelectorAll('.datagrid-row-header')];
      const r1 = headers.find(el => el.textContent === '1')!.getBoundingClientRect();
      const r2 = headers.find(el => el.textContent === '2')!.getBoundingClientRect();
      return { headerBottom: colHeader.bottom, r1Top: r1.top, r1Bottom: r1.bottom, r2Top: r2.top };
    });

    // At rest: the pinned row starts exactly where the header ends (the bug
    // pushed it ~8px lower, overlapping row 2), and row 2 follows it.
    const atRest = await geom();
    expect(Math.abs(atRest.r1Top - atRest.headerBottom)).toBeLessThanOrEqual(1);
    expect(atRest.r2Top).toBeGreaterThanOrEqual(atRest.r1Bottom - 1);

    // Scrolled: row 1 stays pinned in the same place, row 2 has moved up under it
    await container.evaluate(el => { el.scrollTop = 200; });
    await page.waitForTimeout(200);
    const scrolled = await geom();
    expect(Math.abs(scrolled.r1Top - scrolled.headerBottom)).toBeLessThanOrEqual(1);
    expect(scrolled.r2Top).toBeLessThan(atRest.r2Top);

    // Unfreeze for the following tests
    await tabsBar.locator('[data-sheet-tab]', { hasText: 'Sheet 1' }).click();
    await page.getByRole('button', { name: 'Decrease frozen rows' }).click();
    await expect(page.getByTestId('freeze-rows-stepper-value')).toHaveText('0');
    await page.keyboard.press('Escape');
    await container.evaluate(el => { el.scrollTop = 0; });
  });

  test('long-press a row header opens the context menu, resize applies', async () => {
    const page = app.page;
    await page.locator('.datagrid-container').evaluate(el => { el.scrollTop = 0; });

    // Long-press row 3's header (touch): 450ms hold without moving
    const header = page.locator('.datagrid-row-header').filter({ hasText: /^3$/ });
    const box = (await header.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.waitForTimeout(600);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();

    const menu = page.getByTestId('header-menu-row');
    await expect(menu).toBeVisible();
    // Assert on the headlines: an item's text also includes its icon's ligature
    // name (md-icon renders the glyph name as text), so substring matching on
    // the whole item is ambiguous.
    const headlines = (loc: typeof menu) => loc.locator('md-menu-item div[slot="headline"]');
    await expect(headlines(menu)).toHaveText(['Cut', 'Copy', 'Autofill', 'Clear', 'Delete', 'More']);

    // The kebab reveals the structural actions
    await page.getByTestId('header-menu-more').click();
    const more = page.getByTestId('header-menu-row-more');
    await expect(more).toBeVisible();
    await expect(headlines(more)).toHaveText(['Back', 'Freeze rows', 'Hide row', 'Resize']);

    // Resize → stepper sheet; stepping applies immediately
    await more.locator('md-menu-item', { hasText: 'Resize' }).click();
    const resize = page.getByTestId('resize-sheet');
    await expect(resize).toBeVisible();
    await expect(resize).toContainText('Applies to 1 row.');
    await page.getByTestId('resize-input').fill('60');
    await page.getByTestId('resize-input').press('Enter');
    await expect.poll(async () => (await header.boundingBox())!.height).toBeGreaterThan(50);

    // Reset restores the default height
    await resize.getByRole('button', { name: 'Reset' }).click();
    await expect.poll(async () => (await header.boundingBox())!.height).toBeLessThan(40);
    await page.keyboard.press('Escape');
    await expect(resize).not.toBeVisible();
  });

  test('autofill extends a row from its neighbour', async () => {
    const page = app.page;
    const cellText = (col: number, row: number) => cell(col, row).innerText();
    await page.locator('.datagrid-container').evaluate(el => { el.scrollTop = 0; });

    // Seed a series in rows 1-2 of column C, then autofill row 3 from row 2
    const editor = page.locator('.bottom-editor-cm .cm-content');
    const setCell = async (col: number, row: number, text: string) => {
      await cell(col, row).click();
      await editor.click();
      await editor.pressSequentially(text, { delay: 20 });
      await editor.press('Enter');
    };
    await setCell(2, 0, '5');
    await setCell(2, 1, '10');
    await page.getByRole('button', { name: 'Done' }).click();

    // Right-click row 3's header (desktop path to the same menu)
    await page.locator('.datagrid-row-header').filter({ hasText: /^3$/ }).click({ button: 'right' });
    const menu = page.getByTestId('header-menu-row');
    await expect(menu).toBeVisible();
    await menu.locator('md-menu-item', { hasText: 'Autofill' }).click();

    // Row 3 continues the +5 progression from the row above
    await expect.poll(() => cellText(2, 2), { timeout: 10_000 }).toBe('15');
  });

  test('format sheet applies formatting and opens conditional rules', async () => {
    const page = app.page;
    await page.locator('.datagrid-container').evaluate(el => { el.scrollTop = 0; });

    // Seed B2=10 / B3=20 (earlier tests in this file rewrite these rows) so the
    // conditional rule at the end has exactly one matching cell.
    const editor = page.locator('.bottom-editor-cm .cm-content');
    for (const [row, value] of [[1, '10'], [2, '20']] as const) {
      await cell(1, row).click();
      await editor.click();
      await editor.press('ControlOrMeta+a');
      await editor.pressSequentially(value, { delay: 20 });
      await editor.press('Enter');
    }

    // B2 is the cell we format
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


    // The colour buttons open the colour-only picker (not the whole sheet)
    await sheet.getByRole('button', { name: 'Text color' }).click();
    const colorSheet = page.getByTestId('color-sheet');
    await expect(colorSheet).toBeVisible();
    await expect(colorSheet).toContainText('Text color');
    await colorSheet.getByRole('button', { name: '#ff0000' }).click();
    await expect(cell(1, 1)).toHaveCSS('color', 'rgb(255, 0, 0)');
    await page.keyboard.press('Escape'); // closes only the colour sheet
    await expect(colorSheet).not.toBeVisible();
    await expect(sheet).toBeVisible();

    // The bottom bar's colour button opens the same picker directly
    await page.keyboard.press('Escape');
    await expect(sheet).not.toBeVisible();
    await page.getByTestId('quick-format_color_fill').click();
    await expect(colorSheet).toBeVisible();
    await expect(colorSheet).toContainText('Fill color');
    // Green, so it can't be confused with the conditional rule's yellow below
    await colorSheet.getByRole('button', { name: '#00ff00' }).click();
    await expect(cell(1, 1)).toHaveCSS('background-color', 'rgb(0, 255, 0)');
    await page.keyboard.press('Escape');

    // Reopen the formatting sheet for the conditional-format hand-off
    await page.getByRole('button', { name: 'Text formatting' }).click();
    await expect(sheet).toBeVisible();

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
