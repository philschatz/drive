import { useEffect, useState } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { SIZE_LIMITS, DEFAULT_ROW_HEIGHT, DEFAULT_COL_WIDTH } from './sheet-actions';

/**
 * Row-height / column-width picker (replaces the old window.prompt). Applies
 * as you step so the change is visible behind the sheet; "Reset" clears the
 * stored size back to the default.
 */
export function ResizeSheet({
  open,
  onOpenChange,
  kind,
  count,
  currentSize,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: 'row' | 'col';
  /** How many rows/columns the change applies to. */
  count: number;
  /** Stored size of the first affected item, or null when it uses the default. */
  currentSize: number | null;
  onApply: (size: number | null) => void;
}) {
  const limits = SIZE_LIMITS[kind];
  const fallback = kind === 'row' ? DEFAULT_ROW_HEIGHT : DEFAULT_COL_WIDTH;
  const [value, setValue] = useState(currentSize ?? fallback);

  // Re-sync when the sheet is opened for a different selection.
  useEffect(() => {
    if (open) setValue(currentSize ?? fallback);
  }, [open, kind, currentSize, fallback]);

  const commit = (next: number) => {
    const clamped = Math.max(limits.min, Math.min(limits.max, next));
    setValue(clamped);
    onApply(clamped);
  };

  const label = kind === 'row' ? 'Row height' : 'Column width';
  const target = count > 1
    ? `${count} ${kind === 'row' ? 'rows' : 'columns'}`
    : kind === 'row' ? '1 row' : '1 column';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[70vh] p-4">
        {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
        <div data-testid="resize-sheet">
          <SheetHeader>
            <SheetTitle>{label}</SheetTitle>
          </SheetHeader>
          <p className="md-body-medium text-on-surface-variant mt-1">Applies to {target}.</p>

          <div className="flex items-center justify-between mt-3">
            <div className="flex items-center gap-1">
              <button
                aria-label={`Decrease ${label.toLowerCase()}`}
                disabled={value <= limits.min}
                onClick={() => commit(value - limits.step)}
                className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer disabled:opacity-30"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 22 }}>remove</span>
              </button>
              <input
                type="number"
                data-testid="resize-input"
                className="w-20 text-center font-mono md-body-large bg-transparent border border-outline-variant rounded px-2 py-1 outline-none focus:border-primary"
                value={value}
                min={limits.min}
                max={limits.max}
                onInput={(e: any) => setValue(parseInt(e.currentTarget.value, 10) || 0)}
                onBlur={() => commit(value)}
                onKeyDown={(e: any) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              <span className="md-body-medium text-on-surface-variant">px</span>
              <button
                aria-label={`Increase ${label.toLowerCase()}`}
                disabled={value >= limits.max}
                onClick={() => commit(value + limits.step)}
                className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer disabled:opacity-30"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 22 }}>add</span>
              </button>
            </div>
            <button
              className="md-label-large px-3 h-10 rounded-full state-layer text-primary"
              onClick={() => { setValue(fallback); onApply(null); }}
            >
              Reset
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
