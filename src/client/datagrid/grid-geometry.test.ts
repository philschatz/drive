import { pointToCell, buildRowOffsets, rowAtOffset, type GridGeometry } from './grid-geometry';
import { nextChromeState } from '../shared/useHideOnScroll';

const base: GridGeometry = {
  containerLeft: 0,
  containerTop: 0,
  scrollLeft: 0,
  scrollTop: 0,
  colWidths: [100, 100, 100],
  rowOffsets: buildRowOffsets(new Array(10).fill(28)),
  headerHeight: 28,
  rowHeaderWidth: 48,
  frozenRowCount: 0,
  frozenColCount: 0,
};

describe('pointToCell', () => {
  it('resolves the first cell just past the headers', () => {
    expect(pointToCell(48 + 10, 28 + 10, base)).toEqual([0, 0]);
  });

  it('resolves interior cells from cumulative widths and uniform height', () => {
    // x: 48 + 100 + 50 → col 1; y: 28 + 2*28 + 5 → row 2
    expect(pointToCell(198, 89, base)).toEqual([1, 2]);
  });

  it('offsets by scroll position', () => {
    const g = { ...base, scrollTop: 56, scrollLeft: 100 };
    // y = 33 → content row (33 + 56 - 28) / 28 = 2
    // x = 158 → content (158 + 100 - 48) = 210 → col 2
    expect(pointToCell(158, 33, g)).toEqual([2, 2]);
  });

  it('accounts for the container position', () => {
    const g = { ...base, containerLeft: 20, containerTop: 40 };
    expect(pointToCell(20 + 48 + 10, 40 + 28 + 10, g)).toEqual([0, 0]);
  });

  it('clamps pointers over the headers to the first row/col', () => {
    expect(pointToCell(10, 10, base)).toEqual([0, 0]);
  });

  it('clamps pointers past the grid to the last row/col', () => {
    expect(pointToCell(10_000, 10_000, base)).toEqual([2, 9]);
  });

  it('maps the sticky frozen-row band to frozen indices while scrolled', () => {
    const g = { ...base, rowOffsets: buildRowOffsets(new Array(30).fill(28)), frozenRowCount: 2, scrollTop: 280 };
    // Within the frozen band: second frozen row
    expect(pointToCell(58, 28 + 28 + 5, g)[1]).toBe(1);
    // Below the band: scrolled content row
    expect(pointToCell(58, 28 + 2 * 28 + 5, g)[1]).toBe(Math.floor((89 + 280 - 28) / 28));
  });

  it('maps the sticky frozen-col band to frozen indices while scrolled', () => {
    const g = { ...base, frozenColCount: 1, scrollLeft: 200 };
    // Within the frozen band (first 100px after the row header)
    expect(pointToCell(48 + 50, 40, g)[0]).toBe(0);
    // Past the band: scrolled content column
    expect(pointToCell(160, 40, g)[0]).toBe(2);
  });
});

describe('buildRowOffsets / rowAtOffset', () => {
  it('accumulates heights with a trailing total', () => {
    expect(buildRowOffsets([28, 60, 28])).toEqual([0, 28, 88, 116]);
  });

  it('handles an empty grid', () => {
    expect(buildRowOffsets([])).toEqual([0]);
    expect(rowAtOffset([0], 50)).toBe(0);
  });

  it('finds the row containing an offset with mixed heights', () => {
    const offsets = buildRowOffsets([28, 60, 28, 100]);
    expect(rowAtOffset(offsets, 0)).toBe(0);
    expect(rowAtOffset(offsets, 27)).toBe(0);
    expect(rowAtOffset(offsets, 28)).toBe(1);
    expect(rowAtOffset(offsets, 87)).toBe(1);
    expect(rowAtOffset(offsets, 88)).toBe(2);
    expect(rowAtOffset(offsets, 116)).toBe(3);
  });

  it('clamps out-of-range offsets', () => {
    const offsets = buildRowOffsets([28, 28]);
    expect(rowAtOffset(offsets, -10)).toBe(0);
    expect(rowAtOffset(offsets, 10_000)).toBe(1);
  });
});

describe('pointToCell with variable row heights', () => {
  it('resolves rows by cumulative offset, not a constant height', () => {
    const g: GridGeometry = { ...base, rowOffsets: buildRowOffsets([28, 100, 28]) };
    // Row 1 is 100px tall: y just past the header lands in row 0 …
    expect(pointToCell(58, 28 + 5, g)[1]).toBe(0);
    // … 50px further down is still row 1, which a uniform 28px would call row 2
    expect(pointToCell(58, 28 + 28 + 50, g)[1]).toBe(1);
    expect(pointToCell(58, 28 + 128 + 5, g)[1]).toBe(2);
  });
});

describe('nextChromeState', () => {
  it('always shows chrome near the top', () => {
    expect(nextChromeState(true, 100, 0)).toBe(false);
    expect(nextChromeState(true, 100, 10)).toBe(false);
  });

  it('hides after accumulating a downward scroll', () => {
    expect(nextChromeState(false, 20, 500)).toBe(true);
  });

  it('reveals after accumulating an upward scroll', () => {
    expect(nextChromeState(true, -20, 500)).toBe(false);
  });

  it('keeps the previous state under the threshold', () => {
    expect(nextChromeState(true, 5, 500)).toBe(true);
    expect(nextChromeState(false, -5, 500)).toBe(false);
  });
});
