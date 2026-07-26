/**
 * Pure coordinate math for the grid: map a pointer position to the visible
 * cell under it. Used by the touch selection-resize drag, where pointer
 * capture makes `event.target` useless and DOM hit-testing
 * (elementFromPoint) is deliberately avoided.
 *
 * Mirrors the assumptions of `scrollCellIntoView`: uniform row height,
 * a 48px sticky row-header column, a sticky header row, and contiguous
 * frozen row/column prefixes rendered with `position: sticky`.
 */

export interface GridGeometry {
  /** Bounding client rect origin of the scroll container. */
  containerLeft: number;
  containerTop: number;
  scrollLeft: number;
  scrollTop: number;
  /** Visible column widths, in order. */
  colWidths: number[];
  /** Number of visible rows. */
  rowCount: number;
  rowHeight: number;
  /** Height of the sticky `<thead>` row. */
  headerHeight: number;
  rowHeaderWidth: number;
  frozenRowCount: number;
  frozenColCount: number;
}

/**
 * Visible [col, row] under the client point, clamped into the grid — a
 * pointer over the headers or outside the table resolves to the nearest
 * cell, which is what a selection drag wants.
 */
export function pointToCell(clientX: number, clientY: number, g: GridGeometry): [number, number] {
  // Viewport-relative position inside the container
  const x = clientX - g.containerLeft;
  const y = clientY - g.containerTop;

  // -- Row --
  const frozenRowsBottom = g.headerHeight + g.frozenRowCount * g.rowHeight;
  let row: number;
  if (y < frozenRowsBottom) {
    // Over the sticky header/frozen band: resolve within the frozen prefix
    row = Math.floor((y - g.headerHeight) / g.rowHeight);
    row = Math.max(0, Math.min(row, Math.max(0, g.frozenRowCount - 1)));
  } else {
    row = Math.floor((y + g.scrollTop - g.headerHeight) / g.rowHeight);
  }
  row = Math.max(0, Math.min(row, g.rowCount - 1));

  // -- Column --
  let frozenColsRight = g.rowHeaderWidth;
  for (let i = 0; i < g.frozenColCount; i++) frozenColsRight += g.colWidths[i];
  let col: number;
  if (x < frozenColsRight) {
    // Over the sticky row-header/frozen band: resolve within the frozen prefix
    col = 0;
    let acc = g.rowHeaderWidth;
    for (let i = 0; i < g.frozenColCount; i++) {
      if (x >= acc) col = i;
      acc += g.colWidths[i];
    }
  } else {
    const contentX = x + g.scrollLeft - g.rowHeaderWidth;
    col = 0;
    let acc = 0;
    for (let i = 0; i < g.colWidths.length; i++) {
      if (contentX >= acc) col = i;
      else break;
      acc += g.colWidths[i];
    }
  }
  col = Math.max(0, Math.min(col, g.colWidths.length - 1));

  return [col, row];
}
