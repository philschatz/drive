import {
  parseHtmlClipboard,
  buildClipboardData,
} from '../../src/client/datagrid/clipboard';
import {
  a1ToInternal,
  internalToA1,
} from '../../src/client/datagrid/helpers';

const rowIds = ['r0', 'r1', 'r2', 'r3', 'r4'];
const colIds = ['c0', 'c1', 'c2', 'c3', 'c4'];

/** Simulate the paste storage logic from commands.ts */
function simulatePaste(
  values: string[][],
  destRow: number,
  destCol: number,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (let dr = 0; dr < values.length; dr++) {
    for (let dc = 0; dc < values[dr].length; dc++) {
      const r = destRow + dr;
      const c = destCol + dc;
      if (r >= rowIds.length || c >= colIds.length) continue;
      const val = values[dr][dc];
      const stored = val.startsWith('=')
        ? a1ToInternal(val, r, c, rowIds, colIds)
        : val;
      result[`${rowIds[r]}:${colIds[c]}`] = stored;
    }
  }
  return result;
}

describe('parseHtmlClipboard', () => {
  it('extracts plain text values from HTML table', () => {
    const html = '<table><tr><td>10</td><td>20</td></tr><tr><td>30</td><td>40</td></tr></table>';
    expect(parseHtmlClipboard(html)).toEqual([['10', '20'], ['30', '40']]);
  });

  it('extracts formulas from data-sheets-formula attribute', () => {
    const html = `<table><tr>
      <td data-sheets-formula="=R[-1]C[0]+1">11</td>
      <td data-sheets-formula="=SUM(R1C1:R1C2)">30</td>
    </tr></table>`;
    const rows = parseHtmlClipboard(html);
    expect(rows).toEqual([['=R[-1]C[0]+1', '=SUM(R1C1:R1C2)']]);
  });

  it('prefers formula attribute over text content', () => {
    const html = `<table><tr>
      <td data-sheets-formula="=RC[-1]+RC[-2]">42</td>
    </tr></table>`;
    const rows = parseHtmlClipboard(html);
    expect(rows![0][0]).toBe('=RC[-1]+RC[-2]');
  });

  it('mixes formula and plain cells', () => {
    const html = `<table><tr>
      <td>plain</td>
      <td data-sheets-formula="=R[-1]C[0]">5</td>
    </tr></table>`;
    const rows = parseHtmlClipboard(html);
    expect(rows).toEqual([['plain', '=R[-1]C[0]']]);
  });
});

describe('paste pipeline: HTML with formulas → stored values', () => {
  it('converts R1C1 formulas from HTML clipboard to internal format', () => {
    const html = `<table><tbody>
      <tr><td>100</td><td data-sheets-formula="=RC[-1]*2">200</td></tr>
      <tr><td data-sheets-formula="=R[-1]C[0]+1">101</td><td data-sheets-formula="=RC[-1]*2">202</td></tr>
    </tbody></table>`;

    const parsed = parseHtmlClipboard(html);
    expect(parsed).not.toBeNull();
    const result = simulatePaste(parsed!, 0, 0);

    expect(result['r0:c0']).toBe('100');

    const a1_01 = internalToA1(result['r0:c1'], 0, 1, rowIds, colIds);
    expect(a1_01).toBe('=A1*2');

    const a1_10 = internalToA1(result['r1:c0'], 1, 0, rowIds, colIds);
    expect(a1_10).toBe('=A1+1');

    const a1_11 = internalToA1(result['r1:c1'], 1, 1, rowIds, colIds);
    expect(a1_11).toBe('=A2*2');
  });

  it('roundtrips buildClipboardData → parseHtmlClipboard → paste at offset', () => {
    const cells: Record<string, { value: string }> = {
      'r0:c0': { value: a1ToInternal('=B1+C1', 0, 0, rowIds, colIds) },
      'r0:c1': { value: '42' },
    };
    const range = { minRow: 0, maxRow: 0, minCol: 0, maxCol: 1 };
    const clipData = buildClipboardData(cells, null, range, rowIds, colIds);
    expect(clipData).not.toBeNull();

    const parsed = parseHtmlClipboard(clipData!.html);
    expect(parsed).not.toBeNull();

    const result = simulatePaste(parsed!, 2, 0);

    const a1 = internalToA1(result['r2:c0'], 2, 0, rowIds, colIds);
    expect(a1).toBe('=B3+C3');
    expect(result['r2:c1']).toBe('42');
  });
});
