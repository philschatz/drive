import { useEffect, useState } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Number stepper row: down/up buttons disable at the given bounds. */
function Stepper({
  label,
  value,
  max,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (next: number) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center justify-between py-1" data-testid={testId}>
      <span className="md-body-large">{label}</span>
      <div className="flex items-center gap-1">
        <button
          aria-label={`Decrease ${label.toLowerCase()}`}
          disabled={value <= 0}
          onClick={() => onChange(value - 1)}
          className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer disabled:opacity-30"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 22 }}>keyboard_arrow_down</span>
        </button>
        <span className="w-8 text-center font-mono md-body-large" data-testid={`${testId}-value`}>{value}</span>
        <button
          aria-label={`Increase ${label.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
          className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer disabled:opacity-30"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 22 }}>keyboard_arrow_up</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Options for the active sheet (opened from its tab's dropdown): rename,
 * move left/right in the tab order, hide, delete, and freeze row/column
 * steppers (bounded so at least one row/column stays scrollable).
 */
export function SheetOptionsSheet({
  open,
  onOpenChange,
  sheetId,
  sheetName,
  onRename,
  canMoveLeft,
  canMoveRight,
  onMove,
  canHide,
  onHide,
  canDelete,
  onDelete,
  frozenRows,
  frozenCols,
  maxFrozenRows,
  maxFrozenCols,
  onSetFrozen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetId: string;
  sheetName: string;
  onRename: (id: string, name: string) => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onMove: (id: string, dir: -1 | 1) => void;
  canHide: boolean;
  onHide: (id: string) => void;
  canDelete: boolean;
  onDelete: (id: string) => void;
  frozenRows: number;
  frozenCols: number;
  maxFrozenRows: number;
  maxFrozenCols: number;
  onSetFrozen: (kind: 'row' | 'col', count: number) => void;
}) {
  const [name, setName] = useState(sheetName);
  // Re-sync the draft when the sheet (or its synced name) changes
  useEffect(() => setName(sheetName), [sheetId, sheetName]);

  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== sheetName) onRename(sheetId, trimmed);
  };

  return (
    <Sheet open={open} onOpenChange={o => { if (!o) commitName(); onOpenChange(o); }}>
      <SheetContent side="bottom" className="max-h-[85vh] p-4">
        {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
        <div data-testid="sheet-options-sheet">
        <SheetHeader>
          <SheetTitle>Sheet options</SheetTitle>
        </SheetHeader>

        <div className="mt-2 flex flex-col gap-1">
          <Label htmlFor="sheet-name-input">Name</Label>
          <Input
            id="sheet-name-input"
            data-testid="sheet-name-input"
            value={name}
            onInput={(e: any) => setName(e.currentTarget.value)}
            onBlur={commitName}
            onKeyDown={(e: any) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
        </div>

        {/* Unavailable actions are omitted rather than shown disabled — a lone
            sheet has nowhere to move and can't be hidden or deleted. */}
        <md-list style={{ background: 'transparent' }} className="mt-2">
          {canMoveLeft && (
            <md-list-item type="button" onClick={() => onMove(sheetId, -1)}>
              <md-icon slot="start">chevron_left</md-icon>
              <div slot="headline">Move left</div>
            </md-list-item>
          )}
          {canMoveRight && (
            <md-list-item type="button" onClick={() => onMove(sheetId, 1)}>
              <md-icon slot="start">chevron_right</md-icon>
              <div slot="headline">Move right</div>
            </md-list-item>
          )}
          {canHide && (
            <md-list-item type="button" onClick={() => { onOpenChange(false); onHide(sheetId); }}>
              <md-icon slot="start">visibility_off</md-icon>
              <div slot="headline">Hide sheet</div>
            </md-list-item>
          )}
          {canDelete && (
            <md-list-item type="button" onClick={() => { onOpenChange(false); onDelete(sheetId); }}>
              <md-icon slot="start" style={{ color: 'var(--md-sys-color-error)' }}>delete</md-icon>
              <div slot="headline" style={{ color: 'var(--md-sys-color-error)' }}>Delete sheet</div>
            </md-list-item>
          )}
        </md-list>

        <md-divider role="separator" className="my-2" />

        <Stepper
          label="Frozen rows"
          value={frozenRows}
          max={maxFrozenRows}
          onChange={n => onSetFrozen('row', n)}
          testId="freeze-rows-stepper"
        />
        <Stepper
          label="Frozen columns"
          value={frozenCols}
          max={maxFrozenCols}
          onChange={n => onSetFrozen('col', n)}
          testId="freeze-cols-stepper"
        />
        </div>
      </SheetContent>
    </Sheet>
  );
}
