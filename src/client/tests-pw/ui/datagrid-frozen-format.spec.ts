import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openApp } from './support';

/**
 * Regression: a frozen cell must still paint its own format background.
 *
 * Frozen cells get an opaque backdrop so scrolled content doesn't show through,
 * but that fallback used to test only the `background` shorthand while
 * `formatToCss` writes the `backgroundColor` longhand — so a formatted frozen
 * cell looked unset, had the shorthand appended, and the shorthand reset
 * background-color. Frozen header rows rendered surface-white instead of their
 * fill. See the isFrozenCol/isFrozenRow branch in DataGrid.tsx.
 */

const HEADER_FILL = 'rgb(26, 115, 232)'; // #1a73e8
const BODY_FILL = 'rgb(230, 244, 234)';  // #e6f4ea

const FIXTURE = {
  '@type': 'DataGrid',
  name: 'Frozen fill',
  sheets: {
    s1: {
      '@type': 'Sheet',
      name: 'S',
      index: 0,
      frozenRows: 1,
      frozenCols: 1,
      columns: { c1: { index: 0 }, c2: { index: 1 } },
      rows: { r1: { index: 0 }, r2: { index: 1 } },
      cells: {
        'r1:c1': { value: 'Head A' }, 'r1:c2': { value: 'Head B' },
        'r2:c1': { value: 'Row label' }, 'r2:c2': { value: 'Body' },
      },
      formats: {
        // The frozen header row, filled.
        hdr: {
          index: 0,
          rangeRowStart: 'r1', rangeRowEnd: 'r1', rangeColStart: 'c1', rangeColEnd: 'c2',
          format: { bgColor: '#1a73e8', textColor: '#ffffff', bold: true },
        },
        // A non-frozen cell with a fill — the control, which always worked.
        body: {
          index: 1,
          rangeRowStart: 'r2', rangeRowEnd: 'r2', rangeColStart: 'c2', rangeColEnd: 'c2',
          format: { bgColor: '#e6f4ea' },
        },
      },
    },
  },
};

test('a frozen cell paints its format background', async ({ browser }) => {
  const app = await openApp(browser, 'frozen-format');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drive-frozen-')), 'frozen-fill.json');
  fs.writeFileSync(file, JSON.stringify(FIXTURE));

  try {
    await app.page.getByRole('button', { name: 'New document' }).click();
    const chooser = app.page.waitForEvent('filechooser');
    await app.page.getByTestId('create-doc-sheet').locator('md-list-item', { hasText: 'Import .json' }).click();
    (await chooser).setFiles(file);

    await expect(app.page).toHaveURL(/#\/d\//, { timeout: 60_000 });
    await expect(app.page.locator('.datagrid-table')).toBeVisible({ timeout: 30_000 });

    const cell = (row: number, col: number) =>
      app.page.locator(`td.datagrid-cell[data-cell-row="${row}"][data-cell-col="${col}"]`);
    const styleOf = (row: number, col: number) => cell(row, col).evaluate((el: Element) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, position: s.position };
    });

    await expect(cell(0, 0)).toContainText('Head A', { timeout: 15_000 });

    // Frozen row ∩ frozen column, and frozen row alone.
    expect(await styleOf(0, 0)).toEqual({ bg: HEADER_FILL, position: 'sticky' });
    expect(await styleOf(0, 1)).toEqual({ bg: HEADER_FILL, position: 'sticky' });

    // Control: an ordinary cell's fill was never affected.
    expect((await styleOf(1, 1)).bg).toBe(BODY_FILL);

    // A frozen cell with no fill of its own still needs an opaque backdrop,
    // otherwise scrolled rows show through it.
    const frozenPlain = await styleOf(1, 0);
    expect(frozenPlain.position).toBe('sticky');
    expect(frozenPlain.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(frozenPlain.bg).not.toBe('transparent');

    app.assertNoFatalErrors();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    await app.close();
  }
});
