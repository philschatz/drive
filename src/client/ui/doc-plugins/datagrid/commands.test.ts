import {
  useGridCommands, commitReorder, commitAutofill,
  type GridCommandState, type GridCommandContext,
} from './commands';

// ============================================================
// Test harness
//
// Builds a minimal in-memory document + GridCommandContext so the command
// execute() bodies can run outside of Preact. `mutate` applies the mutation
// callback directly to the plain-object doc (the same shape the worker sees),
// so we can assert on the resulting rows/cols/cells.
//
// The critical property under test (H4): selection indices are in VISIBLE
// space, but the doc's rows/columns include hidden entries. A correct command
// must resolve visible indices through visibleRowIds/visibleColIds, never index
// the full sorted list directly.
// ============================================================

interface RowSpec { id: string; index: number; hidden?: boolean }
interface ColSpec { id: string; index: number; hidden?: boolean }

function makeHarness(opts: {
  rows: RowSpec[];
  cols: ColSpec[];
  cells?: Record<string, string>;
  selectedCell?: [number, number] | null;
  selectionAnchor?: [number, number] | null;
  currentRowIndices?: number[];
  currentColIndices?: number[];
  selectedRows?: number[];
  selectedCols?: number[];
  clipboard?: GridCommandContext['clipboardRef']['current'];
  pasteEvent?: any;
}) {
  const sheetId = 's1';
  const rowMap: Record<string, any> = {};
  for (const r of opts.rows) rowMap[r.id] = { index: r.index, ...(r.hidden ? { hidden: true } : {}) };
  const colMap: Record<string, any> = {};
  for (const c of opts.cols) colMap[c.id] = { index: c.index, name: '', ...(c.hidden ? { hidden: true } : {}) };
  const cells: Record<string, any> = {};
  for (const [k, v] of Object.entries(opts.cells ?? {})) cells[k] = { value: v };

  const doc: any = {
    sheets: { [sheetId]: { '@type': 'Sheet', name: 'S', index: 1, rows: rowMap, columns: colMap, cells } },
  };

  const sortedRowIds = [...opts.rows].sort((a, b) => a.index - b.index).map(r => r.id);
  const sortedColIds = [...opts.cols].sort((a, b) => a.index - b.index).map(c => c.id);
  const visibleRowIds = sortedRowIds.filter(id => !rowMap[id].hidden);
  const visibleColIds = sortedColIds.filter(id => !colMap[id].hidden);

  const noop = () => {};
  const ctx = {
    sheet: doc.sheets[sheetId],
    sheetsMeta: null,
    computedValues: null,
    spillTargets: new Set<string>(),
    currentSheetId: sheetId,
    sortedRowIds,
    sortedColIds,
    visibleRowIds,
    visibleColIds,
    selectedCell: opts.selectedCell ?? null,
    selectionAnchor: opts.selectionAnchor ?? null,
    currentRowIndices: opts.currentRowIndices ?? [],
    currentColIndices: opts.currentColIndices ?? [],
    selectedRows: new Set(opts.selectedRows ?? []),
    selectedCols: new Set(opts.selectedCols ?? []),
    clipboardRef: { current: opts.clipboard ?? null },
    setClipboardSource: noop,
    mutate: (fn: (d: any, ...args: any[]) => void, args: unknown[]) => { fn(doc, ...args); },
    setSelectionAnchor: noop,
    setSelectedCell: noop,
    setContextMenu: noop,
    setSelectedRows: noop,
    setSelectedCols: noop,
    undo: noop,
    redo: noop,
    pasteEvent: opts.pasteEvent,
  } as unknown as GridCommandContext;

  const state: GridCommandState = {
    canUndo: false,
    canRedo: false,
    hasSelection: !!ctx.selectedCell,
    currentRowIndices: opts.currentRowIndices ?? [],
    currentColIndices: opts.currentColIndices ?? [],
    contextScope: null,
  };

  return { doc, sheet: doc.sheets[sheetId], ctx, state };
}

function runCommand(id: string, state: GridCommandState, ctx: GridCommandContext) {
  useGridCommands(state, ctx).resolveById(id).execute();
}

// ── H4: delete-rows ───────────────────────────────────────────────────────────

describe('delete-rows with a hidden row', () => {
  it('deletes the visible target row, not the hidden one before it', () => {
    // Visible order: [r0, r2, r3]; r1 is hidden between r0 and r2.
    const { doc, state, ctx } = makeHarness({
      rows: [
        { id: 'r0', index: 1 },
        { id: 'r1', index: 2, hidden: true },
        { id: 'r2', index: 3 },
        { id: 'r3', index: 4 },
      ],
      cols: [{ id: 'c0', index: 1 }],
      cells: { 'r0:c0': 'A', 'r1:c0': 'HIDDEN', 'r2:c0': 'C', 'r3:c0': 'D' },
      currentRowIndices: [1], // visible index 1 → r2
    });

    runCommand('delete-rows', state, ctx);

    // r2 (the visible target) must be gone; the hidden r1 must survive.
    expect(doc.sheets.s1.rows.r2).toBeUndefined();
    expect(doc.sheets.s1.rows.r1).toBeDefined();
    expect(doc.sheets.s1.cells['r2:c0']).toBeUndefined();
    expect(doc.sheets.s1.cells['r1:c0']).toEqual({ value: 'HIDDEN' });
  });

  it('regression: no hidden rows — deletes the selected row', () => {
    const { doc, state, ctx } = makeHarness({
      rows: [{ id: 'r0', index: 1 }, { id: 'r1', index: 2 }, { id: 'r2', index: 3 }],
      cols: [{ id: 'c0', index: 1 }],
      cells: { 'r0:c0': 'A', 'r1:c0': 'B', 'r2:c0': 'C' },
      currentRowIndices: [1],
    });
    runCommand('delete-rows', state, ctx);
    expect(doc.sheets.s1.rows.r1).toBeUndefined();
    expect(doc.sheets.s1.cells['r1:c0']).toBeUndefined();
    expect(doc.sheets.s1.rows.r0).toBeDefined();
    expect(doc.sheets.s1.rows.r2).toBeDefined();
  });
});

// ── H4: delete-cols ───────────────────────────────────────────────────────────

describe('delete-cols with a hidden column', () => {
  it('deletes the visible target column, not the hidden one', () => {
    const { doc, state, ctx } = makeHarness({
      rows: [{ id: 'r0', index: 1 }],
      cols: [
        { id: 'c0', index: 1 },
        { id: 'c1', index: 2, hidden: true },
        { id: 'c2', index: 3 },
      ],
      cells: { 'r0:c0': 'A', 'r0:c1': 'HIDDEN', 'r0:c2': 'C' },
      currentColIndices: [1], // visible index 1 → c2
    });

    runCommand('delete-cols', state, ctx);

    expect(doc.sheets.s1.columns.c2).toBeUndefined();
    expect(doc.sheets.s1.columns.c1).toBeDefined();
    expect(doc.sheets.s1.cells['r0:c2']).toBeUndefined();
    expect(doc.sheets.s1.cells['r0:c1']).toEqual({ value: 'HIDDEN' });
  });
});

// ── H4: insert-row-below ──────────────────────────────────────────────────────

describe('insert-row-below with a hidden row before the target', () => {
  it('inserts the new row directly below the visible target', () => {
    // Visible order: [r0, r2, r3]; select visible idx 1 (r2). New row must
    // sort AFTER r2 (index 3) and before r3 (index 4).
    const before = new Set(['r0', 'r1', 'r2', 'r3']);
    const { doc, state, ctx } = makeHarness({
      rows: [
        { id: 'r0', index: 1 },
        { id: 'r1', index: 2, hidden: true },
        { id: 'r2', index: 3 },
        { id: 'r3', index: 4 },
      ],
      cols: [{ id: 'c0', index: 1 }],
      currentRowIndices: [1],
    });

    runCommand('insert-row-below', state, ctx);

    const newId = Object.keys(doc.sheets.s1.rows).find(id => !before.has(id))!;
    const newIndex = doc.sheets.s1.rows[newId].index;
    expect(newIndex).toBeGreaterThan(3); // below r2
    expect(newIndex).toBeLessThan(4);    // above r3
  });
});

// ── H4: move-rows-down ────────────────────────────────────────────────────────

describe('move-rows-down with a hidden row after the selection', () => {
  it('moves the selected visible row below the next visible row, not the hidden one', () => {
    // Visible order: [r0, r2, r3]; select visible idx 0 (r0). Moving down should
    // reorder r0 below r2 (the next VISIBLE row), i.e. r2 ends up before r0.
    const { doc, state, ctx } = makeHarness({
      rows: [
        { id: 'r0', index: 1 },
        { id: 'r1', index: 2, hidden: true },
        { id: 'r2', index: 3 },
        { id: 'r3', index: 4 },
      ],
      cols: [{ id: 'c0', index: 1 }],
      selectedRows: [0],
    });

    runCommand('move-rows-down', state, ctx);

    // r2 now sorts before r0 (r0 moved down past it). The hidden row r1 is untouched.
    expect(doc.sheets.s1.rows.r2.index).toBeLessThan(doc.sheets.s1.rows.r0.index);
    expect(doc.sheets.s1.rows.r1.index).toBe(2);
  });
});

// ── H4: move-cols-right ───────────────────────────────────────────────────────

describe('move-cols-right with a hidden column after the selection', () => {
  it('moves the selected visible column past the next visible column', () => {
    const { doc, state, ctx } = makeHarness({
      rows: [{ id: 'r0', index: 1 }],
      cols: [
        { id: 'c0', index: 1 },
        { id: 'c1', index: 2, hidden: true },
        { id: 'c2', index: 3 },
        { id: 'c3', index: 4 },
      ],
      selectedCols: [0], // visible c0
    });

    runCommand('move-cols-right', state, ctx);

    expect(doc.sheets.s1.columns.c2.index).toBeLessThan(doc.sheets.s1.columns.c0.index);
    expect(doc.sheets.s1.columns.c1.index).toBe(2);
  });
});

// ── H4: internal paste ────────────────────────────────────────────────────────

describe('internal paste with a hidden row before the destination', () => {
  it('writes the pasted value into the visible target cell', () => {
    const { doc, state, ctx } = makeHarness({
      rows: [
        { id: 'r0', index: 1 },
        { id: 'r1', index: 2, hidden: true },
        { id: 'r2', index: 3 },
      ],
      cols: [{ id: 'c0', index: 1 }],
      selectedCell: [0, 1], // visible col 0, visible row 1 → r2
      clipboard: {
        values: [['X']],
        formats: [[undefined]],
        mode: 'copy',
        range: { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 },
      },
    });

    runCommand('paste', state, ctx);

    expect(doc.sheets.s1.cells['r2:c0']).toEqual({ value: 'X' });
    expect(doc.sheets.s1.cells['r1:c0']).toBeUndefined();
  });
});

// ── H5 + H4: external paste ───────────────────────────────────────────────────

describe('external paste (native ClipboardEvent)', () => {
  it('does not throw and lands the value in the visible target cell (H5)', () => {
    const { doc, state, ctx } = makeHarness({
      rows: [{ id: 'r0', index: 1 }],
      cols: [
        { id: 'c0', index: 1 },
        { id: 'c1', index: 2, hidden: true },
        { id: 'c2', index: 3 },
      ],
      selectedCell: [1, 0], // visible col 1 → c2
      clipboard: null,
      pasteEvent: {
        clipboardData: {
          getData: (type: string) => (type === 'text/plain' ? 'EXT' : ''),
        },
      },
    });

    expect(() => runCommand('paste', state, ctx)).not.toThrow();
    expect(doc.sheets.s1.cells['r0:c2']).toEqual({ value: 'EXT' });
    expect(doc.sheets.s1.cells['r0:c1']).toBeUndefined();
  });
});

// ── H4: delete-contents (Delete key) ──────────────────────────────────────────

describe('delete-contents with a hidden row before the selection', () => {
  it('clears the visible target cell, not the hidden one', () => {
    const { doc, state, ctx } = makeHarness({
      rows: [
        { id: 'r0', index: 1 },
        { id: 'r1', index: 2, hidden: true },
        { id: 'r2', index: 3 },
      ],
      cols: [{ id: 'c0', index: 1 }],
      cells: { 'r1:c0': 'HIDDEN', 'r2:c0': 'C' },
      selectedCell: [0, 1], // visible row 1 → r2
    });

    runCommand('delete-contents', state, ctx);

    expect(doc.sheets.s1.cells['r2:c0']).toBeUndefined();
    expect(doc.sheets.s1.cells['r1:c0']).toEqual({ value: 'HIDDEN' });
  });
});

// ── H4: commitReorder ─────────────────────────────────────────────────────────

describe('commitReorder with hidden rows', () => {
  it('reorders visible rows using visible indices', () => {
    // Visible: [r0, r2, r3]. Drag visible row 0 (r0) to drop position 2
    // (after r2). r0 should end up between r2 and r3 in visible order.
    const { doc, ctx } = makeHarness({
      rows: [
        { id: 'r0', index: 1 },
        { id: 'r1', index: 2, hidden: true },
        { id: 'r2', index: 3 },
        { id: 'r3', index: 4 },
      ],
      cols: [{ id: 'c0', index: 1 }],
    });

    commitReorder(ctx, 'row', [0], 2);

    // r0 now sorts after r2 and before r3; hidden r1 untouched.
    expect(doc.sheets.s1.rows.r0.index).toBeGreaterThan(doc.sheets.s1.rows.r2.index);
    expect(doc.sheets.s1.rows.r0.index).toBeLessThan(doc.sheets.s1.rows.r3.index);
    expect(doc.sheets.s1.rows.r1.index).toBe(2);
  });
});

// ── H4: commitAutofill ────────────────────────────────────────────────────────

describe('commitAutofill with a hidden row in the fill span', () => {
  it('fills visible target cells, never the hidden row', () => {
    // Visible: [r0, r2, r3]. Source = visible row 0 (r0), fill down to visible
    // rows 1..2 (r2, r3). The hidden row r1 must never receive a value.
    const { doc, ctx } = makeHarness({
      rows: [
        { id: 'r0', index: 1 },
        { id: 'r1', index: 2, hidden: true },
        { id: 'r2', index: 3 },
        { id: 'r3', index: 4 },
      ],
      cols: [{ id: 'c0', index: 1 }],
      cells: { 'r0:c0': '5' },
    });

    commitAutofill(
      ctx,
      { minCol: 0, maxCol: 0, minRow: 0, maxRow: 0 }, // source: visible r0
      { minCol: 0, maxCol: 0, minRow: 1, maxRow: 2 }, // fill: visible r2, r3
    );

    expect(doc.sheets.s1.cells['r2:c0']).toEqual({ value: '5' });
    expect(doc.sheets.s1.cells['r3:c0']).toEqual({ value: '5' });
    expect(doc.sheets.s1.cells['r1:c0']).toBeUndefined();
  });
});

// ── Ctrl+V must reach the paste command ─────────────────────────────────

describe('dispatchKey: paste', () => {
  const ctrlV = () => {
    let prevented = false;
    return {
      event: {
        key: 'v', shiftKey: false, altKey: false, ctrlKey: true, metaKey: false,
        preventDefault() { prevented = true; },
      } as unknown as KeyboardEvent,
      wasPrevented: () => prevented,
    };
  };

  const harness = () => {
    const h = makeHarness({
      rows: [{ id: 'r0', index: 1 }, { id: 'r1', index: 2 }],
      cols: [{ id: 'c0', index: 1 }, { id: 'c1', index: 2 }],
      cells: { 'r0:c0': 'Src' },
      selectedCell: [1, 1], // paste destination B2
      clipboard: {
        values: [['Src']],
        formats: [[undefined]],
        mode: 'copy',
        range: { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 },
      },
    });
    h.state.canEdit = true;
    return h;
  };

  it('Ctrl+V requests a paste instead of being dropped on the floor', () => {
    // `executePaste` used to be reachable ONLY from the grid's native paste-event
    // listener, and dispatchKey skipped the paste command outright. In any browser
    // or focus state where that event is not dispatched (Firefox fires no clipboard
    // event at a non-editable element; the listener is bound to a conditionally
    // rendered container), Ctrl+V therefore did nothing at all — while Ctrl+C,
    // handled entirely in keydown, kept working. That asymmetry is the bug.
    const { state, ctx } = harness();
    const onPasteShortcut = jest.fn();
    (ctx as any).onPasteShortcut = onPasteShortcut;
    const { event, wasPrevented } = ctrlV();

    const handled = useGridCommands(state, ctx).dispatchKey(event, true);

    expect(handled).toBe(true);
    expect(onPasteShortcut).toHaveBeenCalledTimes(1);
    // Must NOT preventDefault: that would suppress the browser's own paste event,
    // which is the better source when it is dispatched.
    expect(wasPrevented()).toBe(false);
  });

  it('the requested paste actually writes cells', () => {
    // What onPasteShortcut defers to, once no native event has shown up.
    const { doc, state, ctx } = harness();
    useGridCommands(state, ctx).executePaste();
    expect(doc.sheets.s1.cells['r1:c1']).toEqual({ value: 'Src' });
  });

  it('does nothing on Ctrl+V when the grid is read-only', () => {
    const { doc, state, ctx } = harness();
    state.canEdit = false;
    const onPasteShortcut = jest.fn();
    (ctx as any).onPasteShortcut = onPasteShortcut;
    const handled = useGridCommands(state, ctx).dispatchKey(ctrlV().event, true);
    expect(handled).toBe(false);
    expect(onPasteShortcut).not.toHaveBeenCalled();
    expect(doc.sheets.s1.cells['r1:c1']).toBeUndefined();
  });
});
