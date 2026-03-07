import { useRef, useEffect } from 'preact/hooks';
import type { DocumentHistory } from './useDocumentHistory';

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function HistorySlider<T>({ history, dismissable = true }: { history: DocumentHistory<T>; dismissable?: boolean }) {
  const sliderRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (history.active) sliderRef.current?.focus();
  }, [history.active]);

  if (!history.active) return null;

  return (
    <div className="flex items-center gap-2 px-2 py-1 bg-muted/50 border-b text-xs shrink-0">
      <span className="text-muted-foreground whitespace-nowrap">
        {history.version + 1} / {history.changeCount}
      </span>
      {history.changeCount > 1 && (
        <input
          ref={sliderRef}
          type="range"
          className="flex-1 h-1 accent-primary"
          min={0}
          max={history.changeCount - 1}
          value={history.version}
          onInput={(e: any) => history.onSliderChange(parseInt(e.target.value))}
        />
      )}
      {history.time ? (
        <span className="text-muted-foreground whitespace-nowrap">{formatTime(history.time)}</span>
      ) : null}
      {history.editable ? (
        <span className="text-[0.7rem] px-1.5 py-0.5 rounded bg-green-100 text-green-800 font-medium">Editing</span>
      ) : (
        <>
          <span className="text-[0.7rem] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">View only</span>
          <button
            className="inline-flex items-center justify-center h-6 w-6 rounded-md hover:bg-accent hover:text-accent-foreground text-muted-foreground"
            onClick={history.jumpToLatest}
            title="Jump to latest"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>fast_forward</span>
          </button>
          <button
            className="inline-flex items-center justify-center h-6 w-6 rounded-md hover:bg-accent hover:text-accent-foreground text-muted-foreground"
            onClick={() => { if (confirm('Revert the document to this version? This cannot be undone.')) history.undoToVersion(); }}
            title="Undo to this version"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>undo</span>
          </button>
        </>
      )}
      {dismissable && (
        <button
          className="text-muted-foreground hover:text-foreground ml-auto"
          onClick={history.toggleHistory}
          title="Close history"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
        </button>
      )}
    </div>
  );
}
