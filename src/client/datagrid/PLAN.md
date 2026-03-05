# DataGrid Implementation Plan

## 1. Data Model

### Automerge Document Schema

```ts
interface DataGridDocument {
  '@type': 'DataGrid';
  name: string;
  description?: string;
  columns: Record<string, DataGridColumn>;
  rows: Record<string, DataGridRow>;
  cells: Record<string, DataGridCell>;
}

interface DataGridColumn { index: number; name: string; width?: number; }
interface DataGridRow    { index: number; height?: number; }
interface DataGridCell   { value: string; }
```

**Key design decisions:**

- **Maps, not arrays.** `rows` and `columns` are `Record<string, T>` keyed by randomly-generated short IDs (e.g. `"k7x2p"`). Concurrent inserts never conflict — each peer inserts into its own key. Array indices would require OT-style position translation.

- **Float ordering.** Each row/column has a fractional `index` field. Display order is determined by sorting on this field, not by insertion order. This supports arbitrary reordering (including drag-and-drop) and insertion between existing items by interpolating between neighbouring index values, without renumbering.

- **Cell key format.** Cells are stored as `Record<"rowId:colId", DataGridCell>`. This avoids nested maps (Automerge performs better with flat maps) and makes it straightforward to delete all cells for a deleted row or column using prefix/suffix matching.

- **No stored identity.** The document doesn't store its own ID — identity comes from the Automerge handle URL.

### ID Generation

`shortId()` generates a 6-character random alphanumeric string. Short IDs keep cell key strings readable in source view and reduce document size. Collision probability at the scale of spreadsheet rows/columns is negligible.

---

## 2. Formula Storage Format

### The Problem

A1 formulas like `=B2+C3` contain position-dependent references. If rows or columns are reordered or inserted, `B2` must update. If stored literally, every reorder would require rewriting all affected cells.

### Solution: Canonical Internal Format

Formulas are stored using UUID-based references:

```
=SUM({{rowId_a,colId_x}}:{{rowId_b,colId_y}})
```

- `{{rowId,colId}}` is an absolute reference to a specific logical cell.
- Relative offsets are stored as signed integers: `{{-1,0}}` means "one row above, same column".
- Mixed references: `{{rowId,-1}}` (absolute row, relative column offset).

**Conversion functions** (`helpers.ts`):

| Function | Direction | Notes |
|---|---|---|
| `a1ToInternal(formula, row, col, rowIds, colIds)` | A1 → stored | Called on commit; resolves column letters and row numbers to IDs/offsets |
| `internalToA1(formula, row, col, rowIds, colIds)` | stored → A1 | Called for display in formula bar; re-derives column letters and row numbers |
| `internalToR1C1(formula, row, col, rowIds, colIds)` | stored → R1C1 | Used for clipboard (LibreOffice/Google Sheets interop); zero-offset parts omit `[0]` (e.g. `RC` not `R[0]C[0]`) |

**Why R1C1 for clipboard?** When pasting, the destination position is not known at copy time. R1C1 stores relative offsets that survive position changes, while A1 cell addresses are position-absolute. `data-sheets-formula` attributes in HTML clipboard carry R1C1.

---

## 3. HyperFormula Integration

HyperFormula (GPLv3) evaluates formulas client-side. It is initialized once on document load:

```ts
const hf = HyperFormula.buildFromArray(buildSheetData(doc, rowIds, colIds), { licenseKey: 'gpl-v3' });
```

`buildSheetData()` converts the Automerge document into a 2-D array of values/formulas in A1 format (which HyperFormula understands). On every mutation, `hf.setSheetContent(0, data)` resynchronizes the engine.

**`getDisplayValue(hf, rawValue, col, row)`** returns:
- For plain strings: the string itself
- For formulas: `hf.getCellValue({sheet:0, row, col})` stringified
- Handles type coercion: booleans → `"TRUE"`/`"FALSE"`, numbers → `String(n)`, errors → `"#REF!"` etc.

HyperFormula is also used live during editing to show a tooltip of the current formula's evaluated result.

**Sync timing:** `syncHyperFormula()` (called via `ctx.mutate()`) runs after every Automerge change and after the document's `change` event (for remote peer edits). It always derives fresh `rowIds`/`colIds` from the live document to handle structural changes (insert/delete/reorder).

---

## 4. Undo / Redo (`useUndoRedo`)

Uses Automerge's `handle.heads()` / `handle.view(heads).doc()` API rather than maintaining a separate history:

1. On each `change` event, push the **previous** heads onto the undo stack (not the current heads — you want to go back to before this change).
2. `undo()`: push current heads to redo stack, then call `handle.change(d => syncToTarget(d, targetDoc))` to restore the document to the target snapshot.
3. `redo()`: reverse.

**`syncToTarget(mutableDoc, targetSnapshot)`** recursively walks both objects, deleting keys not in target, setting or recursing into keys from target. This creates a single Automerge change that represents "revert to this state".

**`isUndoRedoRef`** flag prevents undo/redo operations from themselves being pushed onto the undo stack.

Max history: 100 entries (oldest dropped on overflow).

---

## 5. Presence System

Uses Automerge's native Presence API (`@automerge/automerge-repo`). All editors share:

```ts
type PresenceState = { viewing: boolean; focusedField: (string | number)[] | null };
```

For DataGrid, `focusedField` is `['cells', 'rowId:colId']` when a cell is selected.

**Peer rendering:**
- `peerCellMap` maps `"col:row"` → `{ color, peerId }` from peer states, resolving IDs to grid coordinates
- Cells with peer presence get an inset colored border via `boxShadow: inset 0 0 0 2px ${color}`
- `title` attribute shows truncated peer ID on hover

**`usePresenceLog`** captures join/leave/focus events for the activity log. Consecutive heartbeat events from the same peer are rolled up with a `×N` counter.

---

## 6. Command / Plugin System

Three files: `commands.ts`, `CommandBar.tsx`.

### Architecture

```
GridPlugin {
  id: string
  commands: GridCommand[]      // logic + keyboard shortcuts + icon + enabled predicate
  slots: Record<SlotId, SlotEntry[]>  // where in the UI each command appears
}
```

**Registration** is static (module-level): `ALL_PLUGINS` → `COMMAND_REGISTRY` map + `KEY_COMMANDS` array + `SLOT_LISTS` map. These never change at runtime.

**`useGridCommands(state, ctx)`** runs each render, resolving enabled/label/isChecked for the current state, returning:
- `toolbar: ResolvedEntry[]`
- `menus: ResolvedMenu[]` (Edit, Insert)
- `cellCtx / rowCtx / colCtx: ResolvedEntry[]`
- `dispatchKey(e, isMod): boolean`

### `GridCommandState` (for `isEnabled`/labels — pure, no side effects)
```ts
{ canUndo, canRedo, hasSelection, currentRowIndices, currentColIndices, contextScope }
```

`contextScope` distinguishes whether the context menu is showing for a row header, column header, or cell — so `rowIndices(state)` returns context-menu indices when a row context menu is open, or the current selected rows otherwise. This makes the same `delete-rows` command work correctly in both the menubar (affects selected rows) and the right-click row context menu (affects right-clicked rows).

### `GridCommandContext` (for `execute` bodies — has side effects)
```ts
{
  doc: DataGridDocument | null,   // immutable snapshot for reads
  hf, sortedRowIds, sortedColIds,
  selectedCell, selectionAnchor,
  currentRowIndices, currentColIndices,
  selectedRows, selectedCols,
  clipboardRef, setClipboardSource,
  mutate: (fn: (doc: DataGridDocument) => void) => void,  // change + syncHF
  setSelectionAnchor, setSelectedCell, setContextMenu,
  setSelectedRows, setSelectedCols,
  undo, redo
}
```

`mutate` combines `handle.change(fn)` + `syncHyperFormula()` in one call. Commands that only read (copy, cut) don't call `mutate`.

### Shortcut System

```ts
interface Shortcut { key: string; mod?: boolean; shift?: boolean; alt?: boolean; display?: string }
```

One `Shortcut` object fully defines both the event match (`matchShortcut`) and the menu display string (`shortcutDisplay`). Commands declare `shortcuts?: Shortcut[]`; the first is shown in menus, all are dispatched in `dispatchKey`.

### `dispatchKey` / `handleKeyDown` bridge

`handleKeyDown` is defined early in the component (as a `useCallback`), but `commands.dispatchKey` is built near the `return`. A `dispatchKeyRef` bridges the gap: `handleKeyDown` calls `dispatchKeyRef.current?.(e, mod)`, and `dispatchKeyRef.current = commands.dispatchKey` is set each render before `return`.

### Plugins

| Plugin | Commands | Slots |
|---|---|---|
| `history` | undo, redo | edit-menu (first group), toolbar |
| `clipboard` | copy, cut, paste, delete-contents | edit-menu (second group), toolbar, cell-ctx |
| `row` | insert-row-above/below, move-rows-up/down, delete-rows | insert-menu, toolbar, row-ctx |
| `column` | insert-col-left/right, move-cols-left/right, delete-cols | insert-menu, toolbar, col-ctx |

---

## 7. Cell Editing

### State
- `selectedCell: [col, row] | null` — the active cell (keyboard focus)
- `selectionAnchor: [col, row] | null` — start of a multi-cell selection drag
- `editingCell: [col, row] | null` — cell with an open editor
- `editValue: string` — live text in the in-cell editor

### Edit lifecycle
1. **Start:** `startEditing(col, row)` — reads raw stored value, converts formulas back to A1 display form (`internalToA1`), sets `editingCell` + `editValue`.
2. **Commit:** `commitEdit()` — converts A1 back to internal (`a1ToInternal`), calls `handle.change(...)` + `syncHyperFormula`.
3. **Cancel:** `cancelEdit()` — uses `editCancelledRef` flag so the subsequent blur event from the editor doesn't race and call `commitEdit`.

**Corner case:** When the formula bar editor causes the cell editor to mount (`editFromBarRef.current = true`), the in-cell CodeMirror is mounted with `autoFocus={false}` — otherwise it would steal focus from the formula bar.

**Blur timing:** Both the formula bar and in-cell editor use `setTimeout(..., 0)` in `onBlur` to allow focus to move between the two editors without triggering a premature commit. It checks `document.activeElement` after the timeout and only commits if focus has left both editor surfaces.

### Typing to start editing

Any printable character keypress on a selected (not editing) cell calls `startEditing` and then overwrites the edit value with the typed character (replacing the cell's current content). This matches spreadsheet UX conventions.

---

## 8. Formula Bar

A CodeMirror instance that mirrors the selected cell's value. When not editing, it shows the stored A1 formula (read-only). When focused, it starts editing the cell (`editFromBarRef.current = true`).

**Sync:** The formula bar and in-cell editor share `editValue` state. The formula bar receives `editingCell ? editValue : formulaBarValue` — so while editing, it shows the live typed value; while not editing, it shows the stored formula.

**Highlights:** Both editors emit `onHighlightsChange` which updates `formulaRefHighlights` (a list of `FormulaHighlight` objects — cell refs and ranges with colors). These are rendered as dashed colored borders on the grid cells using `refHighlightMap`.

---

## 9. Formula Reference Highlighting

While editing a formula, `extractHighlights(formula)` tokenizes it and returns cell/range references with:
- A color from a rotating 6-color palette (Google Sheets style)
- A position (`col, row` for single cells; `minCol/maxCol/minRow/maxRow` for ranges)
- An `active` flag for the reference under the cursor

Grid cells matching these references get:
- A dashed 2px colored border (outline effect, only on the matching edges for ranges)
- A faint background fill (`${color}18`) if `active`

---

## 10. Clipboard

### Internal (within the same tab)

State: `clipboardRef` (a React ref holding `{ values, mode, range }`) + `clipboardSource` (visual state for dashed border).

- **Copy:** Builds R1C1 values and writes to OS clipboard via `navigator.clipboard.write([ClipboardItem])` with both `text/plain` (TSV) and `text/html` (table with `data-sheets-formula` attributes).
- **Cut:** Same, but `mode: 'cut'`. On paste, source cells are deleted.
- **Paste (internal):** Uses `clipboardRef.current` (R1C1 values), converts back to A1 at the destination position via `a1ToInternal`. Row/col bounds computed from snapshot IDs.

### External paste

Reads via `navigator.clipboard.read()` (preferred — gets `text/html` with `data-sheets-formula` R1C1 formulas from LibreOffice/Google Sheets) or falls back to `navigator.clipboard.readText()` for plain TSV. Fresh `rowIds/colIds` are derived inside the `mutate` callback to stay in sync with the live document at mutation time.

### Cell write helper (`setCell`)

Automerge's `change` callback returns `undefined` for missing Record keys despite TypeScript saying `DataGridCell`. `setCell(d, key, stored)` handles this:
- Empty stored value → `delete d.cells[key]` if it exists
- New non-empty value → `d.cells[key] = { value: stored }` (full object assignment)
- Existing non-equal value → `existing.value = stored` (in-place update, better CRDT semantics)

The in-place update (`existing.value = stored`) is preferred over replacement because it preserves the CRDT history of that sub-object.

---

## 11. Autofill

The small square handle in the bottom-right corner of the selected cell/range.

### State
- `autofillDragRef` — active drag source range (set on mousedown of handle)
- `autofillTarget` — computed fill region shown as a dashed preview

### Drag behavior
On mousemove, determines direction by whichever axis the mouse has moved furthest beyond the source range. Snaps to either vertical or horizontal fill.

### `generateAutofillValues(strip, fillCount, direction)`
For each column-strip (vertical fill) or row-strip (horizontal fill):
1. **Constant sequence** (single value, or all identical) → repeat
2. **Arithmetic sequence** (e.g. 1, 3, 5 → continue with step 2) → extrapolate. Backward fill reverses.
3. **Formulas** → convert to R1C1 first, cycle through formula strips applying position offsets
4. **Text** → cycle through values

Formulas are converted to R1C1 before cycling (position-independent), then converted back to A1 at each fill position.

---

## 12. Selection

- **Single cell:** click a cell or navigate with arrow keys
- **Multi-cell range:** shift-click or shift-arrow; `selectionAnchor` + `selectedCell` define the corners; `selectionRange` is the normalized bounding box
- **Row selection:** click row header (multi-select with shift); sets `selectedRows: Set<number>`
- **Column selection:** click column header; sets `selectedCols: Set<number>`
- Cell selection and header selection are mutually exclusive (selecting cells clears row/col selection and vice versa)

**`cellDragRef`**: On cell mousedown, starts tracking a cell-drag for range selection. Document mousemove events update `selectionAnchor` + `selectedCell`.

---

## 13. Drag-to-Reorder

### State
- `dragRef`: `{ type, indices }` — what is being dragged
- `dropIndicator`: `{ type, index }` — visual line between rows/columns
- `justDraggedRef`: prevents the mouseup from also triggering a header click

### `commitReorder(ctx, type, draggedIndices, dropIndex)`
Exported from `commands.ts`, called via `commandCtxRef.current` from the drag handler:
1. Sort dragged indices
2. Compute `remaining` entries (all entries not being moved)
3. Adjust `dropIndex` for the fact that dragged items below the drop point have been removed
4. Interpolate target index values between the neighbours at the adjusted drop position
5. Call `ctx.mutate(d => ...)` to write new `index` values
6. Update `selectedRows`/`selectedCols` to reflect the new positions

**Corner case:** Drop within the dragged range is a no-op (detected by checking if `dropIndex` is strictly between the first and last dragged index).

---

## 14. Column Resize

`handleResizeMouseDown` on the resize handle div at the column header edge:
1. On mousedown, records `startX` and `startWidth`
2. `resizingCol` state provides a live preview width during drag
3. On mouseup, writes final width to `d.columns[colId].width` via `handle.change`

Note: Column resize does NOT call `syncHyperFormula` — HyperFormula doesn't need to know about column widths.

---

## 15. Insert / Delete Rows and Columns

### Insert
Inserts `count` new rows/columns by interpolating float index values between the two neighbours of the insertion point. Uses `shortId()` for new keys.

**Corner case:** Insert at position 0 — no left/top neighbour, so use `hi - count` as the lower bound.

### Delete
1. Collect IDs to delete
2. Compute formula rewrites: `updateFormulasForDeletion` scans all cells for references to the deleted rows/cols
   - Single-cell refs to a deleted cell → rewrite to `#REF!`
   - Range refs that span deleted rows/cols → shrink the range to exclude them (using "nearest surviving neighbour" logic)
3. Apply rewrites and deletions atomically in a single `mutate` call
4. Clear row/col selection

---

## 16. Validation

`useDocumentValidation(handle)` subscribes to document changes and runs `checkDataGridDependencies` on each update. Errors are displayed in `<ValidationPanel>` above the grid, with links that jump to the relevant document section.

**Dependency checks:**
- Duplicate `index` values in rows or columns
- Cell keys referencing non-existent row or column IDs
- Formula `{{id,...}}` references to non-existent IDs

---

## 17. Context Menus

A fixed-position `<div>` positioned at the mouse coordinates at right-click time. Closed on:
- Any click outside (document click listener added when open, removed when closed)
- Any scroll (captures scroll events with `true` for capture phase)
- Selecting a menu item (`setContextMenu(null)` inside each command's execute)

Three flavors: `cell-ctx`, `row-ctx`, `col-ctx` — determined by which element was right-clicked. The `contextScope` in `GridCommandState` lets commands know which context they're running in.

---

## 18. Key Corner Cases Encountered

| Issue | Solution |
|---|---|
| Formula bar `onBlur` fires before in-cell editor gets focus | `setTimeout(..., 0)` in blur handlers; re-check `document.activeElement` after delay |
| `editCancelledRef` race between cancel keydown and subsequent blur | Set `editCancelledRef.current = true` on cancel; blur handler checks the flag |
| `dispatchKeyRef` needed because `handleKeyDown` is defined before `commands` | Ref updated each render just before `return`; handler reads through ref |
| `commitReorder` needed in drag handler (defined early) but uses `commandCtx` (built late) | `commandCtxRef` updated each render; `doReorder` reads through it |
| Autofill mouseup needs current `autofillTarget` but is in a stale closure | `setAutofillTarget(prev => { commitAutofill(src, prev); return null; })` — functional update reads current state |
| Drag-end mouseup needs current `dropIndicator` for same reason | Same functional update pattern |
| CodeMirror loaded lazily — must not load at page startup | FormulaEditor uses dynamic `import()` inside a `useEffect` |
| Automerge `Record<string, T>[key]` returns `undefined` for missing keys at runtime | `getCell()` helper casts to `T \| undefined`; `setCell()` handles all three cases |
| New columns require `name: string` but the field has no meaningful default | Insert commands set `name: ''`; column header shows letter (A, B, …) derived from sort position, not the name field |
| HyperFormula must be destroyed on unmount to avoid memory leaks | `hfRef.current?.destroy()` in the useEffect cleanup |
| Remote peer changes must also re-sync HyperFormula | `handle.on('change', ...)` listener calls `hf.setSheetContent(0, newData)` |
| `justDraggedRef` prevents drag-end from also firing a header click | Set to `true` on drag end, cleared with `setTimeout(..., 0)` |
| R1C1 compact notation: `R[0]C[0]` serialized as `RC` | Zero offsets omit the `[0]` bracket in `internalToR1C1` |

---

## 19. File Map

```
src/client/datagrid/
  DataGrid.tsx        Main component — state, events, JSX rendering
  commands.ts         Plugin registry, useGridCommands hook, commitReorder
  CommandBar.tsx      CommandMenuBar, CommandToolbar, CommandContextMenu renderers
  clipboard.ts        buildClipboardData, writeClipboard, parseHtmlClipboard, getEffectiveRange
  FormulaEditor.tsx   CodeMirror wrapper with A1 tokenizer + reference highlighting
  helpers.ts          sortedEntries, colIndexToLetter, a1ToInternal, internalToA1,
                      internalToR1C1, buildSheetData, getDisplayValue, shortId,
                      generateAutofillValues, updateFormulasForDeletion
  datagrid.css        All grid-specific styles

src/shared/
  useUndoRedo.ts      Head-based undo/redo via Automerge view()
  schemas/datagrid.ts DataGridDocument type + validation schema + dependency checker

tests/
  datagrid.test.ts    Unit tests for helpers (formula conversion, autofill, deletion rewrites)

cypress/e2e/
  datagrid.cy.ts      E2E tests (cell editing, navigation, formulas, formula bar)
```
