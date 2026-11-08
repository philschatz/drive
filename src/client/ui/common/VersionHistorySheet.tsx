/**
 * Version history sheet — the only history-mode surface, opened via the
 * title-bar overflow's "View history" (see HistorySlider).
 *
 * Lists every version (newest first) with a relative time and a per-row Restore
 * button. The list is a scrubber: scrolling it, dragging the slider and tapping
 * a row all drive the one `version`, which the editor behind the sheet previews
 * live. Scrolling down hands the selection to the row at the top edge as the
 * selected row leaves (and to the oldest once the list hits bottom); scrolling
 * up hands it to the row at the bottom edge (and to the newest at the top) —
 * the rule is spelled out in version-scrub.ts. The slider does the same in
 * reverse: it scrolls the list so the row lands where scrolling would have put
 * it. Restore applies a version via the worker (a forward-only change) and
 * closes the sheet.
 */

import { useMemo } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { relativeTime } from '../../../shared/relative-time';
import type { DocumentHistory } from './useDocumentHistory';
import { useVersionScrub } from './useVersionScrub';
import { summarizeChanges, type ChangeKind } from '../../../shared/version-changes';

const LEGEND_KINDS: ChangeKind[] = ['added', 'changed', 'removed'];

interface VersionHistorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  history: DocumentHistory;
}

export function VersionHistorySheet({ open, onOpenChange, history }: VersionHistorySheetProps) {
  const { entries, version, changeCount, restoreToVersion, onSliderChange, changes } = history;
  const latestVersion = entries.length - 1;
  const { listRef, onScroll } = useVersionScrub(version, onSliderChange);
  const summary = useMemo(() => (changes ? summarizeChanges(changes) : null), [changes]);

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
          {/* What the version on screen changed — the same three colours the
              editor behind the sheet highlights with. */}
          {summary && (
            <p
              className="text-xs text-muted-foreground flex items-center justify-center sm:justify-start gap-3"
              data-testid="history-legend"
            >
              {LEGEND_KINDS.map(kind => (
                <span key={kind} className="inline-flex items-center gap-1">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ background: `var(--diff-${kind})` }}
                    aria-hidden="true"
                  />
                  {summary[kind]} {kind}
                </span>
              ))}
            </p>
          )}
        </SheetHeader>

        {/* The slider, the list's scroll position and a row tap all drive the
            same `version`, so none of them can disagree about what is shown. */}
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

        <div
          ref={listRef}
          onScroll={onScroll}
          data-testid="history-versions"
          className="mt-4 -mx-2 min-h-0 flex-1 overflow-y-auto overscroll-contain relative divide-y divide-border"
        >
          {/* Newest first — copy before reversing (entries is shared state). */}
          {[...entries].reverse().map((entry) => {
            const isCurrent = entry.version === version;
            const isLatest = entry.version === latestVersion;
            return (
              <div
                key={entry.version}
                data-version={entry.version}
                data-testid="history-row"
                className={cn(
                  'flex items-center gap-3 px-2 py-2',
                  // The selected row is no longer always at an edge, so the tint
                  // is the one thing saying which version is on screen.
                  isCurrent && 'bg-muted/50 rounded shadow-[inset_3px_0_0_var(--md-sys-color-primary)]',
                )}
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
