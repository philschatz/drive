/**
 * The scrubbing rule, with no DOM: 8 versions newest-first, 40px rows, a 120px
 * viewport (three rows visible) and 320px of content.
 */
import { placementFor, scrubTarget, type ScrubRow } from './version-scrub';

const rows: ScrubRow[] = Array.from({ length: 8 }, (_, i) => ({ version: 7 - i, top: i * 40, height: 40 }));
const view = (scrollTop: number) => ({ scrollTop, clientHeight: 120, scrollHeight: 320 });

describe('scrubTarget', () => {
  it('scrolling down hands the selection to the top edge once the selected row has left', () => {
    // Row 0 (version 7) has its midpoint at 20; scrolled to 30 it is gone, row 1 is at the edge.
    expect(scrubTarget(rows, view(30), 7)).toBe(6);
    expect(scrubTarget(rows, view(80), 7)).toBe(5);
  });

  it('keeps the selected row while it is still (half) visible', () => {
    // Row 2 (version 5) spans 80–120, midpoint 100.
    expect(scrubTarget(rows, view(60), 5)).toBeNull();
    expect(scrubTarget(rows, view(100), 5)).toBeNull();
  });

  it('scrolling up hands the selection to the bottom edge once the selected row has left', () => {
    // From the bottom (oldest selected, row 7 at 280–320) up to 160: the viewport is
    // 160–280, row 7's midpoint 300 is below it, row 6's (260) is the last that fits.
    expect(scrubTarget(rows, view(160), 0)).toBe(1);
  });

  it('the top selects the newest and the bottom the oldest', () => {
    expect(scrubTarget(rows, view(0), 5)).toBe(7);
    expect(scrubTarget(rows, view(200), 5)).toBe(0);
    // Within a pixel of the end counts as the end (fractional scroll positions).
    expect(scrubTarget(rows, { scrollTop: 199.5, clientHeight: 120, scrollHeight: 320 }, 5)).toBe(0);
  });

  it('a selection the list does not contain falls back to the top edge', () => {
    expect(scrubTarget(rows, view(80), 42)).toBe(5);
  });

  it('an empty list selects nothing', () => {
    expect(scrubTarget([], view(0), 0)).toBeNull();
  });
});

describe('placementFor', () => {
  it('leaves a visible row where it is', () => {
    expect(placementFor(rows[1], view(0))).toBeNull();
    // Half visible is visible: row 2 spans 80–120, viewport 100–220.
    expect(placementFor(rows[2], view(100))).toBeNull();
  });

  it('puts a row below the viewport at the top edge, clamped to the end of the list', () => {
    expect(placementFor(rows[4], view(0))).toBe(160);
    expect(placementFor(rows[7], view(0))).toBe(200);
  });

  it('puts a row above the viewport at the bottom edge, clamped to the start', () => {
    expect(placementFor(rows[4], view(200))).toBe(80);
    expect(placementFor(rows[1], view(200))).toBe(0);
  });
});
