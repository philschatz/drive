import type { Dispatch, StateUpdater } from 'preact/hooks';
import { ConditionalFormatSheet } from './ConditionalFormatSheet';
import { FormatSheet } from './FormatSheet';
import { ColorSheet, type ColorTarget } from './ColorSheet';
import { PickerSheet } from '@/common/PickerSheet';
import { NUMBER_FORMAT_OPTIONS, FONT_FAMILY_OPTIONS } from './format-presets';
import { FormulaInsertSheet } from './FormulaInsertSheet';
import { HeaderContextMenu, type HeaderMenuPage } from './HeaderContextMenu';
import { ResizeSheet } from './ResizeSheet';
import { SheetListSheet } from './SheetListSheet';
import { SheetOptionsSheet } from './SheetOptionsSheet';
import { applyFreezeCount, applyItemSize } from './sheet-actions';
import { applyFormatToSelection } from './commands';
import type { GridCommandContext, GridCommandsApi } from './commands';
import type { DataGridDocMeta } from './useDataGridDoc';
import type { DataGridCellFormat } from '../../../../shared/schemas/datagrid';

export type GridSelectionRange = { minCol: number; maxCol: number; minRow: number; maxRow: number } | null;
export type GridSheetOrder = { id: string; name: string; hidden?: boolean }[];
export type GridHeaderMenu = { kind: 'row' | 'col'; anchor: HTMLElement; page: HeaderMenuPage } | null;

/**
 * The stacked bottom sheets the datagrid can open (formatting, sheets, resize,
 * header menu, …). Pure pass-through — all open-state lives in DataGrid.
 */
export function GridSheets(props: {
  mutate: GridCommandContext['mutate'];
  commands: GridCommandsApi;
  commandCtxRef: { current: GridCommandContext | null };
  canEdit: boolean;
  canEditRef: { current: boolean };
  currentSheet: any;
  currentSheetId: string | null;
  effectiveSheetId: string | null;
  meta: DataGridDocMeta | null;
  sheetOrder: GridSheetOrder;
  visibleSheetIds: string[];
  sortedRowIds: string[];
  sortedColIds: string[];
  visibleRowIds: string[];
  visibleColIds: string[];
  selectedCell: [number, number] | null;
  selectionRange: GridSelectionRange;
  currentCellFormat: DataGridCellFormat | undefined;
  frozenRowCount: number;
  frozenColCount: number;
  resizeKind: 'row' | 'col' | null;
  resizeTargetIds: string[];
  resizeCurrentSize: number | null;
  formulaNames: string[];
  headerMenu: GridHeaderMenu;
  condFormatOpen: boolean;
  sheetListOpen: boolean;
  sheetOptionsOpen: boolean;
  formatSheetOpen: boolean;
  numFmtOpen: boolean;
  fontFamilyOpen: boolean;
  colorTarget: ColorTarget | null;
  formulaInsertOpen: boolean;
  onOpenChangeCondFormat: Dispatch<StateUpdater<boolean>>;
  onOpenChangeSheetList: Dispatch<StateUpdater<boolean>>;
  onOpenChangeSheetOptions: Dispatch<StateUpdater<boolean>>;
  onOpenChangeFormat: Dispatch<StateUpdater<boolean>>;
  onOpenChangeNumFmt: Dispatch<StateUpdater<boolean>>;
  onOpenChangeFontFamily: Dispatch<StateUpdater<boolean>>;
  onOpenChangeColor: Dispatch<StateUpdater<ColorTarget | null>>;
  onOpenChangeFormulaInsert: Dispatch<StateUpdater<boolean>>;
  onHeaderMenuChange: Dispatch<StateUpdater<GridHeaderMenu>>;
  onResizeKindChange: Dispatch<StateUpdater<'row' | 'col' | null>>;
  onContextMenuClose: () => void;
  onPickSheet: (id: string) => void;
  onUnhideSheet: (id: string) => void;
  onRenameSheet: (id: string, name: string) => void;
  onMoveSheet: (id: string, dir: -1 | 1) => void;
  onHideSheet: (id: string) => void;
  onDeleteSheet: (id: string) => void;
  onInsertFunction: (name: string) => void;
}) {
  const {
    mutate, commands, commandCtxRef, canEdit, canEditRef,
    currentSheet, currentSheetId, effectiveSheetId, meta,
    sheetOrder, visibleSheetIds, sortedRowIds, sortedColIds,
    visibleRowIds, visibleColIds, selectedCell, selectionRange, currentCellFormat,
    frozenRowCount, frozenColCount, resizeKind, resizeTargetIds, resizeCurrentSize,
    formulaNames, headerMenu,
    condFormatOpen, sheetListOpen, sheetOptionsOpen, formatSheetOpen,
    numFmtOpen, fontFamilyOpen, colorTarget, formulaInsertOpen,
    onOpenChangeCondFormat, onOpenChangeSheetList, onOpenChangeSheetOptions,
    onOpenChangeFormat, onOpenChangeNumFmt, onOpenChangeFontFamily,
    onOpenChangeColor, onOpenChangeFormulaInsert,
    onHeaderMenuChange, onResizeKindChange, onContextMenuClose,
    onPickSheet, onUnhideSheet, onRenameSheet,
    onMoveSheet, onHideSheet, onDeleteSheet, onInsertFunction,
  } = props;

  return (
    <>
      <ConditionalFormatSheet
        open={condFormatOpen}
        onOpenChange={onOpenChangeCondFormat}
        rules={currentSheet?.conditionalFormats}
        sortedRowIds={sortedRowIds}
        sortedColIds={sortedColIds}
        currentSheetId={currentSheetId ?? ''}
        mutate={mutate}
        selectedCell={selectedCell}
        selectionRange={selectionRange}
        visibleRowIds={visibleRowIds}
        visibleColIds={visibleColIds}
      />
      <FormulaInsertSheet
        open={formulaInsertOpen}
        onOpenChange={onOpenChangeFormulaInsert}
        customFunctionNames={formulaNames}
        onInsert={onInsertFunction}
      />
      {/* Row/column header menu — long-press (touch) or right-click. */}
      <HeaderContextMenu
        kind={headerMenu?.kind ?? 'row'}
        anchor={headerMenu?.anchor ?? null}
        page={headerMenu?.page ?? 'main'}
        onPageChange={(page) => onHeaderMenuChange(m => m && { ...m, page })}
        onClose={() => { onHeaderMenuChange(null); onContextMenuClose(); }}
        resolveCommand={commands.resolveById}
        onResize={() => { const k = headerMenu?.kind ?? 'row'; onHeaderMenuChange(null); onResizeKindChange(k); }}
      />
      <ResizeSheet
        open={resizeKind !== null}
        onOpenChange={(o) => { if (!o) onResizeKindChange(null); }}
        kind={resizeKind ?? 'row'}
        count={resizeTargetIds.length}
        currentSize={resizeCurrentSize}
        onApply={(size) => {
          if (effectiveSheetId && resizeKind) {
            applyItemSize(mutate, effectiveSheetId, resizeKind, resizeTargetIds, size);
          }
        }}
      />
      <FormatSheet
        open={formatSheetOpen}
        onOpenChange={onOpenChangeFormat}
        currentFormat={currentCellFormat}
        onApply={(patch) => {
          if (commandCtxRef.current) applyFormatToSelection(commandCtxRef.current, patch);
        }}
        onClear={() => commands.resolveById('clear-formatting').execute()}
        onOpenConditional={() => onOpenChangeCondFormat(true)}
        onOpenColor={onOpenChangeColor}
        onOpenNumberFormat={() => onOpenChangeNumFmt(true)}
        onOpenFontFamily={() => onOpenChangeFontFamily(true)}
      />
      {/* The two long single-selects, as sibling sheets over the format sheet — same
          arrangement as the colour picker, so the format sheet stays put behind them
          and formatting remains iterative. */}
      <PickerSheet
        open={numFmtOpen}
        onOpenChange={onOpenChangeNumFmt}
        title="Number format"
        options={NUMBER_FORMAT_OPTIONS}
        value={currentCellFormat?.numFmt ?? 'auto'}
        onPick={(v) => {
          if (commandCtxRef.current) {
            applyFormatToSelection(commandCtxRef.current, { numFmt: v === 'auto' ? undefined : v });
          }
        }}
        data-testid="number-format-sheet"
      />
      <PickerSheet
        open={fontFamilyOpen}
        onOpenChange={onOpenChangeFontFamily}
        title="Font"
        options={FONT_FAMILY_OPTIONS}
        value={currentCellFormat?.fontFamily ?? 'Default'}
        onPick={(v) => {
          if (commandCtxRef.current) {
            applyFormatToSelection(commandCtxRef.current, { fontFamily: v === 'Default' ? undefined : v });
          }
        }}
        data-testid="font-family-sheet"
      />
      {/* Colour-only picker, shared by the bottom bar and the format sheet. */}
      <ColorSheet
        target={colorTarget}
        onOpenChange={(o) => { if (!o) onOpenChangeColor(null); }}
        textColor={currentCellFormat?.textColor}
        bgColor={currentCellFormat?.bgColor}
        onApply={(target, color) => {
          if (!commandCtxRef.current) return;
          applyFormatToSelection(commandCtxRef.current,
            target === 'fill' ? { bgColor: color } : { textColor: color });
        }}
        onOpenConditional={() => onOpenChangeCondFormat(true)}
      />
      <SheetListSheet
        open={sheetListOpen}
        onOpenChange={onOpenChangeSheetList}
        sheets={sheetOrder}
        currentSheetId={effectiveSheetId ?? ''}
        readOnly={!canEdit}
        onPick={onPickSheet}
      />
      {effectiveSheetId && (
        <SheetOptionsSheet
          open={sheetOptionsOpen}
          onOpenChange={onOpenChangeSheetOptions}
          sheetId={effectiveSheetId}
          sheetName={meta?.sheets?.[effectiveSheetId]?.name ?? ''}
          onRename={onRenameSheet}
          canMoveLeft={visibleSheetIds.indexOf(effectiveSheetId) > 0}
          canMoveRight={visibleSheetIds.indexOf(effectiveSheetId) >= 0 && visibleSheetIds.indexOf(effectiveSheetId) < visibleSheetIds.length - 1}
          onMove={onMoveSheet}
          canHide={visibleSheetIds.length > 1}
          onHide={onHideSheet}
          canDelete={sheetOrder.length > 1}
          onDelete={onDeleteSheet}
          frozenRows={frozenRowCount}
          frozenCols={frozenColCount}
          maxFrozenRows={Math.max(0, visibleRowIds.length - 1)}
          maxFrozenCols={Math.max(0, visibleColIds.length - 1)}
          onSetFrozen={(kind, count) => {
            if (effectiveSheetId) applyFreezeCount(mutate, effectiveSheetId, kind, count);
          }}
        />
      )}
    </>
  );
}
