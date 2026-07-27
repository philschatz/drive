/**
 * Version history sheet — the only history-mode surface, opened via the
 * title-bar overflow's "View history" (see HistorySlider).
 *
 * Lists every version (newest first) with a relative time and a per-row Restore
 * button. Clicking a row previews that version live in the editor behind the
 * sheet (drives the slider); Restore applies it via the worker (a forward-only
 * change) and closes the sheet.
 */

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { relativeTime } from '../../../shared/relative-time';
import type { DocumentHistory } from './useDocumentHistory';

interface VersionHistorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  history: DocumentHistory;
}

export function VersionHistorySheet({ open, onOpenChange, history }: VersionHistorySheetProps) {
  const { entries, version, changeCount, restoreToVersion, onSliderChange } = history;
  const latestVersion = entries.length - 1;

  const handleRestore = async (target: number) => {
    if (
      !confirm(
        `Restore the document to Version ${target + 1}? ` +
        'This adds a new change that reverts everything after it.',
      )
    ) return;
    await restoreToVersion(target);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[35vh] flex flex-col">
        <SheetHeader>
          <SheetTitle>Version history ({changeCount})</SheetTitle>
        </SheetHeader>

        {/* Scrub through versions. Dragging the slider and clicking a row below
            both drive the same `version`, so the two stay in sync. */}
        {changeCount > 1 && (
          <div className="mt-3 flex items-center">
            <input
              type="range"
              className="flex-1 min-w-0 h-1 accent-primary"
              min={0}
              max={changeCount - 1}
              value={version}
              onInput={(e: any) => onSliderChange(parseInt(e.target.value))}
            />
          </div>
        )}

        <div className="mt-4 -mx-2 min-h-0 flex-1 overflow-y-auto divide-y divide-border">
          {/* Newest first — copy before reversing (entries is shared state). */}
          {[...entries].reverse().map((entry) => {
            const isCurrent = entry.version === version;
            const isLatest = entry.version === latestVersion;
            return (
              <div
                key={entry.version}
                className={cn('flex items-center gap-3 px-2 py-2', isCurrent && 'bg-muted/50 rounded')}
              >
                <button
                  className="flex-1 text-left hover:text-foreground"
                  onClick={() => onSliderChange(entry.version)}
                  title="Preview this version"
                >
                  <span className="text-sm font-medium tabular-nums">{entry.version + 1}</span>
                  {isLatest && <span className="ml-2 text-xs text-muted-foreground">(latest)</span>}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {relativeTime(new Date(entry.time * 1000))}
                  </span>
                </button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isLatest}
                  onClick={() => handleRestore(entry.version)}
                >
                  Restore
                </Button>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
