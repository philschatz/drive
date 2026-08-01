import { Fragment } from 'preact';
import { colIndexToLetter } from './helpers';

export type ColDef = { id: string; width?: number };
export type ColHiddenGap = { beforeVisualIndex: number; hiddenIds: string[] };

/**
 * The grid's column header row: the select-all corner cell, one <th> per
 * visible column (with hidden-column gaps inserted), the resize handles, and
 * the trailing unhide cell. Pure pass-through — all state lives in DataGrid.
 */
export function GridHeaderRow(props: {
  columnDefs: ColDef[];
  visibleColOriginalIndices: number[];
  frozenColOffsets: number[];
  frozenColCount: number;
  frozenRowCount: number;
  selectedCols: Set<number>;
  selectedCell: [number, number] | null;
  colHiddenGaps: ColHiddenGap[];
  dropIndicator: { type: 'row' | 'col'; index: number } | null;
  resizingCol: { index: number; width: number } | null;
  onSelectAll: () => void;
  onHeaderClick: (type: 'row' | 'col', index: number, e: MouseEvent) => void;
  onHeaderContextMenu: (type: 'row' | 'col', index: number, e: MouseEvent) => void;
  onHeaderMouseDown: (type: 'row' | 'col', index: number, e: MouseEvent) => void;
  headerLongPress: (kind: 'row' | 'col', index: number) => Record<string, (e: any) => void>;
  onUnhideLines: (kind: 'row' | 'col', ids: string[]) => void;
  onResizeMouseDown: (ci: number, e: MouseEvent) => void;
  onAutoFitColumn: (ci: number) => void;
}) {
  const {
    columnDefs, visibleColOriginalIndices, frozenColOffsets, frozenColCount, frozenRowCount,
    selectedCols, selectedCell, colHiddenGaps, dropIndicator, resizingCol,
    onSelectAll, onHeaderClick, onHeaderContextMenu, onHeaderMouseDown,
    headerLongPress, onUnhideLines, onResizeMouseDown, onAutoFitColumn,
  } = props;

  return (
    <>
      <th
        className="datagrid-row-header datagrid-corner-header"
        style={frozenColCount > 0 || frozenRowCount > 0 ? { position: 'sticky', left: 0, top: 0, zIndex: 4 } : undefined}
        title="Select all cells"
        onClick={onSelectAll}
      />
      {columnDefs.map((col, ci) => {
        const isColSelected = selectedCols.has(ci);
        let dropClass = '';
        if (dropIndicator?.type === 'col') {
          if (dropIndicator.index === ci) dropClass = ' drop-left';
          else if (dropIndicator.index === ci + 1 && ci === columnDefs.length - 1) dropClass = ' drop-right';
        }
        const isFrozenCol = ci < frozenColCount;
        const isLastFrozenCol = ci === frozenColCount - 1;
        const gap = colHiddenGaps.find(g => g.beforeVisualIndex === ci);
        const frozenStyle = isFrozenCol ? { position: 'sticky' as const, left: frozenColOffsets[ci], zIndex: 3 } : undefined;
        return (
          <Fragment key={`th-${ci}`}>
            {gap && (
              <th key={`unhide-col-${ci}`} className="datagrid-col-unhide" onClick={() => onUnhideLines('col', gap.hiddenIds)} title={`Show ${gap.hiddenIds.length} hidden column${gap.hiddenIds.length > 1 ? 's' : ''}`}>
                <span className="material-symbols-outlined" style={{ fontSize: '0.75rem' }}>unfold_more</span>
              </th>
            )}
            <th
              key={col.id}
              className={'datagrid-col-header' + (isColSelected ? ' selected' : selectedCell && selectedCell[0] === ci ? ' active' : '') + dropClass + (isLastFrozenCol ? ' frozen-col-last' : '')}
              style={{ width: (resizingCol?.index === ci ? resizingCol.width : col.width) || 100, ...frozenStyle }}
              data-col-index={ci}
              onClick={(e: any) => onHeaderClick('col', ci, e)}
              onContextMenu={(e: any) => onHeaderContextMenu('col', ci, e)}
              onMouseDown={(e: any) => onHeaderMouseDown('col', ci, e)}
              {...headerLongPress('col', ci)}
            >
              {colIndexToLetter(visibleColOriginalIndices[ci])}
              <div className="col-resize-handle" onMouseDown={(e: any) => onResizeMouseDown(ci, e)} onDblClick={(e: any) => { e.stopPropagation(); onAutoFitColumn(ci); }} />
            </th>
          </Fragment>
        );
      })}
      {/* Trailing unhide button if columns are hidden at the end */}
      {colHiddenGaps.find(g => g.beforeVisualIndex === columnDefs.length) && (
        <th className="datagrid-col-unhide" onClick={() => onUnhideLines('col', colHiddenGaps.find(g => g.beforeVisualIndex === columnDefs.length)!.hiddenIds)}>
          <span className="material-symbols-outlined" style={{ fontSize: '0.75rem' }}>unfold_more</span>
        </th>
      )}
    </>
  );
}
