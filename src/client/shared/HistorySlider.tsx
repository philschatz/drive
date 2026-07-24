import { useRef, useEffect } from 'preact/hooks';
import type { DocumentHistory } from './useDocumentHistory';

export function HistorySlider({ history }: { history: DocumentHistory }) {
  const sliderRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (history.active) sliderRef.current?.focus();
  }, [history.active]);

  if (!history.active) return null;

  return (
    <div className="flex items-center gap-2 px-2 py-1 bg-muted/50 border-b text-xs shrink-0">
      {history.changeCount > 1 && (
        <input
          ref={sliderRef}
          type="range"
          className="flex-1 min-w-0 h-1 accent-primary"
          min={0}
          max={history.changeCount - 1}
          value={history.version}
          onInput={(e: any) => history.onSliderChange(parseInt(e.target.value))}
        />
      )}
      {/* Fixed-width right group: the version number plus a reserved undo slot,
          so the slider's width never changes as the version or buttons change. */}
      <div className="flex items-center justify-end gap-2 shrink-0 ml-auto">
        <span className="text-muted-foreground whitespace-nowrap tabular-nums text-right min-w-[4.5rem]">
          Version {history.version + 1}
        </span>
        {/* The undo button lives in a fixed-width slot that is always reserved, so the
            version number doesn't move between the editable and view-only states. */}
        <div className="flex items-center justify-end w-6 shrink-0">
          {!history.editable && (
            <button
              className="inline-flex items-center justify-center h-6 w-6 rounded-md hover:bg-accent hover:text-accent-foreground text-muted-foreground"
              onClick={() => { if (confirm('Revert the document to this version? This cannot be undone.')) history.undoToVersion(); }}
              title="Undo to this version"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>undo</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
