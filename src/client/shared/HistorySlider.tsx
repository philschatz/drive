import { useEffect, useState } from 'preact/hooks';
import type { DocumentHistory } from './useDocumentHistory';
import { VersionHistorySheet } from './VersionHistorySheet';

export function HistorySlider({ history }: { history: DocumentHistory }) {
  const [showSheet, setShowSheet] = useState(false);

  // The slider now lives inside the sheet, so entering history mode opens it
  // (and leaving closes it). Closing while still in history mode is fine — the
  // bar's "Version N" button reopens it.
  useEffect(() => {
    setShowSheet(history.active);
  }, [history.active]);

  if (!history.active) return null;

  return (
    <div className="flex items-center gap-2 px-2 py-1 bg-muted/50 border-b text-xs shrink-0">
      {/* The version label is a button: it opens the version-history sheet, which
          holds the slider and lets you browse and restore any version. */}
      <button
        className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-muted-foreground whitespace-nowrap tabular-nums hover:bg-accent hover:text-accent-foreground"
        onClick={() => setShowSheet(true)}
        title="Browse version history"
      >
        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>history</span>
        Version {history.version + 1}
      </button>
      <VersionHistorySheet open={showSheet} onOpenChange={setShowSheet} history={history} />
    </div>
  );
}
