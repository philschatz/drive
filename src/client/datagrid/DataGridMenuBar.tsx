import { useState } from 'react';
import type { Model } from '@ironcalc/workbook';
import {
  Menubar, MenubarMenu, MenubarTrigger, MenubarContent, MenubarItem, MenubarSeparator,
  MenubarSub, MenubarSubTrigger, MenubarSubContent,
} from '@/components/ui/menubar';

const MAX_ROW = 1048576, MAX_COL = 16384;

/**
 * App-level menu bar over the IronCalc grid: Insert rows/columns, Format cells,
 * and View → conditional formatting. Insert/delete go through IronCalc's Model
 * (the bridge mirrors them to the doc); formatting uses `updateRangeStyle` and is
 * session-only (like IronCalc's own toolbar), so we bump `onRefresh` to redraw.
 */
export function DataGridMenuBar({ model, onRefresh, onOpenConditionalFormat }: {
  model: Model;
  onRefresh: () => void;
  onOpenConditionalFormat: () => void;
}) {
  const m = model as any;

  // Classify the current selection so the Insert menu only offers relevant ops:
  // a full-width selection = whole row(s); a full-height selection = whole column(s).
  const [selKind, setSelKind] = useState<'row' | 'col' | 'cell'>('cell');
  const classifySelection = (): 'row' | 'col' | 'cell' => {
    try {
      const [r0, c0, r1, c1] = model.getSelectedView().range;
      const allCols = c0 <= 1 && c1 >= MAX_COL;
      const allRows = r0 <= 1 && r1 >= MAX_ROW;
      if (allCols && !allRows) return 'row';
      if (allRows && !allCols) return 'col';
      return 'cell';
    } catch { return 'cell'; }
  };

  /** Current selection as { sheet, row, column, area } (1-based), or null. */
  const sel = () => {
    try {
      const v = model.getSelectedView();
      const [r0, c0, r1, c1] = v.range;
      const row = Math.min(r0, r1), column = Math.min(c0, c1);
      const area = { sheet: v.sheet, row, column, width: Math.abs(c1 - c0) + 1, height: Math.abs(r1 - r0) + 1 };
      return { sheet: v.sheet, row: v.row, column: v.column, area };
    } catch { return null; }
  };

  const insertRows = (offset: number) => { const s = sel(); if (s) { try { m.insertRow(s.sheet, s.row + offset); } catch { /* ignore */ } } };
  const insertCols = (offset: number) => { const s = sel(); if (s) { try { m.insertColumn(s.sheet, s.column + offset); } catch { /* ignore */ } } };
  const deleteRow = () => { const s = sel(); if (s) { try { m.deleteRow(s.sheet, s.row); } catch { /* ignore */ } } };
  const deleteCol = () => { const s = sel(); if (s) { try { m.deleteColumn(s.sheet, s.column); } catch { /* ignore */ } } };

  /** Toggle a boolean font style across the selection based on the active cell. */
  const toggleFont = (path: 'b' | 'i' | 'u' | 'strike') => {
    const s = sel(); if (!s) return;
    let cur = false;
    try { cur = !!(model.getCellStyle(s.sheet, s.row, s.column) as any).font?.[path]; } catch { /* default false */ }
    style(`font.${path}`, String(!cur));
  };

  /** Set a style path over the whole selection, then redraw. */
  const style = (path: string, value: string) => {
    const s = sel(); if (!s) return;
    try { m.updateRangeStyle(s.area, path, value); } catch { /* ignore */ }
    onRefresh();
  };

  const numFmt = (fmt: string) => style('num_fmt', fmt);

  const clearFormatting = () => {
    const s = sel(); if (!s) return;
    const { sheet, row, column, width, height } = s.area;
    try { model.rangeClearFormatting(sheet, row, column, row + height - 1, column + width - 1); } catch { /* ignore */ }
    onRefresh();
  };

  // Column width / row height — prompt for a pixel value, apply to the selection.
  const setColumnWidth = () => {
    const s = sel(); if (!s) return;
    const v = window.prompt('Column width (px):', '120');
    const w = v && Number(v); if (!w || w <= 0) return;
    try { m.setColumnsWidth(s.sheet, s.area.column, s.area.column + s.area.width - 1, w); } catch { /* ignore */ }
    onRefresh();
  };
  const setRowHeight = () => {
    const s = sel(); if (!s) return;
    const v = window.prompt('Row height (px):', '24');
    const h = v && Number(v); if (!h || h <= 0) return;
    try { m.setRowsHeight(s.sheet, s.area.row, s.area.row + s.area.height - 1, h); } catch { /* ignore */ }
    onRefresh();
  };

  // Freeze panes — freeze up to (and including) the active cell's row/column.
  const freezeRows = () => { const s = sel(); if (!s) return; try { m.setFrozenRowsCount(s.sheet, s.row); } catch { /* ignore */ } onRefresh(); };
  const freezeCols = () => { const s = sel(); if (!s) return; try { m.setFrozenColumnsCount(s.sheet, s.column); } catch { /* ignore */ } onRefresh(); };
  const unfreezeRows = () => { const s = sel(); if (!s) return; try { m.setFrozenRowsCount(s.sheet, 0); } catch { /* ignore */ } onRefresh(); };
  const unfreezeCols = () => { const s = sel(); if (!s) return; try { m.setFrozenColumnsCount(s.sheet, 0); } catch { /* ignore */ } onRefresh(); };

  const showRowOps = selKind !== 'col';
  const showColOps = selKind !== 'row';

  return (
    <Menubar
      className="rounded-none border-x-0 border-t-0 shrink-0"
      onValueChange={(open) => { if (open) setSelKind(classifySelection()); }}
    >
      <MenubarMenu>
        <MenubarTrigger>Insert</MenubarTrigger>
        <MenubarContent>
          {showRowOps && <MenubarItem onSelect={() => insertRows(0)}>Row above</MenubarItem>}
          {showRowOps && <MenubarItem onSelect={() => insertRows(1)}>Row below</MenubarItem>}
          {showRowOps && showColOps && <MenubarSeparator />}
          {showColOps && <MenubarItem onSelect={() => insertCols(0)}>Column left</MenubarItem>}
          {showColOps && <MenubarItem onSelect={() => insertCols(1)}>Column right</MenubarItem>}
          <MenubarSeparator />
          {showRowOps && <MenubarItem onSelect={deleteRow}>Delete row</MenubarItem>}
          {showColOps && <MenubarItem onSelect={deleteCol}>Delete column</MenubarItem>}
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Format</MenubarTrigger>
        <MenubarContent>
          <MenubarItem onSelect={() => toggleFont('b')}>Bold</MenubarItem>
          <MenubarItem onSelect={() => toggleFont('i')}>Italic</MenubarItem>
          <MenubarItem onSelect={() => toggleFont('u')}>Underline</MenubarItem>
          <MenubarItem onSelect={() => toggleFont('strike')}>Strikethrough</MenubarItem>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger>Number</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem onSelect={() => numFmt('general')}>Automatic</MenubarItem>
              <MenubarItem onSelect={() => numFmt('#,##0.00')}>Number</MenubarItem>
              <MenubarItem onSelect={() => numFmt('$#,##0.00')}>Currency</MenubarItem>
              <MenubarItem onSelect={() => numFmt('0.00%')}>Percent</MenubarItem>
              <MenubarItem onSelect={() => numFmt('yyyy-mm-dd')}>Date</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarItem onSelect={setColumnWidth}>Column width…</MenubarItem>
          <MenubarItem onSelect={setRowHeight}>Row height…</MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={clearFormatting}>Clear formatting</MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>View</MenubarTrigger>
        <MenubarContent>
          <MenubarItem onSelect={freezeRows}>Freeze rows to selection</MenubarItem>
          <MenubarItem onSelect={unfreezeRows}>Unfreeze rows</MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={freezeCols}>Freeze columns to selection</MenubarItem>
          <MenubarItem onSelect={unfreezeCols}>Unfreeze columns</MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={onOpenConditionalFormat}>Conditional formatting…</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
}
