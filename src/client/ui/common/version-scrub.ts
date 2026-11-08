/**
 * The version list as a scrubber: the pure geometry behind `useVersionScrub`.
 *
 * The list is newest-first. The selected (rendered) version is dragged by the
 * viewport's edges rather than pinned to one of them:
 *
 *  - the selected row stays selected while its midpoint is inside the viewport;
 *  - once it leaves through the top (scrolling down, toward older) the row now
 *    at the top edge takes over; once it leaves through the bottom (scrolling
 *    up, toward newer) the row at the bottom edge does;
 *  - at the very bottom the oldest row is selected and at the very top the
 *    newest — the two deliberate discontinuities that make both ends reachable
 *    without padding the list.
 *
 * So a steady scroll down walks the versions one by one ("the top visible item
 * is the current version"), a steady scroll up walks them back, and reversing
 * mid-list never jumps: the opposite edge has to catch the selected row first.
 * The slider mirrors this (`placementFor`): a version whose row is below the
 * viewport lands at the top edge, as scrolling down would have put it; one
 * above lands at the bottom edge; a visible one is left where it is.
 */

export interface ScrubRow {
  version: number;
  /** Offset of the row's top from the scroll container's content top. */
  top: number;
  height: number;
}

export interface ScrubView {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

const mid = (r: ScrubRow) => r.top + r.height / 2;

/**
 * The version a user scroll landed on, or null to keep `current`. `rows` are in
 * document order (newest first); `current` is the version selected before the
 * scroll.
 */
export function scrubTarget(rows: ScrubRow[], view: ScrubView, current: number): number | null {
  if (rows.length === 0) return null;
  const { scrollTop, clientHeight, scrollHeight } = view;
  const bottom = scrollTop + clientHeight;
  if (scrollTop <= 0) return rows[0].version;
  if (bottom >= scrollHeight - 1) return rows[rows.length - 1].version;

  const topVisible = rows.find(r => mid(r) >= scrollTop) ?? rows[rows.length - 1];
  const cur = rows.find(r => r.version === current);
  if (!cur) return topVisible.version;

  const m = mid(cur);
  if (m < scrollTop) return topVisible.version;
  if (m > bottom) {
    let bottomVisible = rows[0];
    for (const r of rows) {
      if (mid(r) <= bottom) bottomVisible = r;
      else break;
    }
    return bottomVisible.version;
  }
  return null;
}

/**
 * Where to scroll so `row` sits where scrolling would have put it, or null when
 * any of it is already visible and it should be left alone (a row the mouse is
 * over is always partly visible, so a hover never moves the list).
 */
export function placementFor(row: ScrubRow, view: ScrubView): number | null {
  const { scrollTop, clientHeight, scrollHeight } = view;
  const bottom = scrollTop + clientHeight;
  if (row.top + row.height > scrollTop && row.top < bottom) return null;
  const max = Math.max(0, scrollHeight - clientHeight);
  // Below the viewport (older): top edge. Above (newer): bottom edge.
  if (row.top >= bottom) return Math.min(row.top, max);
  return Math.max(0, row.top + row.height - clientHeight);
}
