export interface SheetTabInfo {
  id: string;
  name: string;
  hidden?: boolean;
}

/**
 * Overview-mode bottom bar managing spreadsheets: a hamburger opening the
 * all-sheets list, an add-sheet button, and horizontally scrollable tabs.
 * The active tab is a highlighted pill with a dropdown arrow that opens the
 * sheet-options sheet (rename / hide / move / freeze).
 */
export function SheetTabsBar({
  sheets,
  currentSheetId,
  readOnly,
  onSelect,
  onAdd,
  onOpenList,
  onOpenOptions,
}: {
  sheets: SheetTabInfo[];
  currentSheetId: string;
  /** Read-only grid: switching sheets stays, all mutations go. */
  readOnly?: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  /** Open the all-sheets list (bottom sheet). */
  onOpenList: () => void;
  /** Open the options sheet for the active sheet. */
  onOpenOptions: (id: string) => void;
}) {
  const visibleSheets = sheets.filter(s => !s.hidden);

  return (
    <div className="sheet-tabs-bar items-center" data-testid="sheet-tabs-bar">
      <button
        className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
        aria-label="All sheets"
        title="All sheets"
        onClick={onOpenList}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 20 }}>menu</span>
      </button>
      {!readOnly && (
        <button
          className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
          aria-label="Add sheet"
          title="Add sheet"
          onClick={onAdd}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>add</span>
        </button>
      )}
      <div className="sheet-tabs-scroll items-center gap-1 px-1">
        {visibleSheets.map(sheet => {
          const isActive = sheet.id === currentSheetId;
          return (
            <button
              key={sheet.id}
              data-sheet-tab={sheet.id}
              className={
                'inline-flex items-center gap-0.5 rounded-full px-3 h-8 whitespace-nowrap md-label-large state-layer shrink-0' +
                (isActive ? ' bg-secondary-container text-on-secondary-container font-semibold' : '')
              }
              onClick={() => (isActive ? !readOnly && onOpenOptions(sheet.id) : onSelect(sheet.id))}
            >
              {sheet.name}
              {isActive && !readOnly && (
                <span className="material-symbols-outlined" style={{ fontSize: 20, marginRight: -6 }}>arrow_drop_down</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
