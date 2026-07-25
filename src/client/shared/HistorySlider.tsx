import type { DocumentHistory } from './useDocumentHistory';
import { VersionHistorySheet } from './VersionHistorySheet';

/**
 * History mode UI: just the version-history bottom sheet — no persistent bar.
 * Entering history mode ("View history" in the title-bar menu) opens the sheet;
 * scrubbing previews the selected version in the editor behind it; dismissing
 * the sheet exits history mode (back to latest, editable again).
 *
 * (Name kept from the old bar-based UI so editor call sites stay unchanged.)
 */
export function HistorySlider({ history }: { history: DocumentHistory }) {
  if (!history.active) return null;

  return (
    <VersionHistorySheet
      open={history.active}
      onOpenChange={(open) => {
        // Restore already exits history mode itself — only toggle when the
        // dismissal happens while still active, so we don't re-enter.
        if (!open && history.active) history.toggleHistory();
      }}
      history={history}
    />
  );
}
