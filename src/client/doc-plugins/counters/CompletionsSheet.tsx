/**
 * A counter's recorded completions, in their own bottom sheet.
 *
 * Split out of CounterEditor: the log is a record of history, not a property of
 * the counter, so it doesn't belong in the property list — and giving it its own
 * surface is what earns the list row a real dropdown (Edit / Completions)
 * instead of a kebab with a single destination.
 */
import { useState, useEffect } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { DeleteButton } from '@/components/ui/delete-button';
import { relativeTime } from '../../../shared/relative-time';
import type { CounterEvent } from '../../../shared/schemas/counters';

export function CompletionsSheet({
  open,
  uid,
  event,
  canEdit = true,
  onDeleteCompletion,
  onClose,
}: {
  open: boolean;
  uid: string;
  event: CounterEvent | null;
  canEdit?: boolean;
  onDeleteCompletion: (uid: string, key: string) => void;
  onClose: () => void;
}) {
  // Re-render every 30s while open so relative times stay current
  // ("just now" → "a minute ago") without needing a new click.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => setTick(n => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [open]);

  if (!open || !event) return null;

  // Keys are lexicographically-sortable local-datetime strings, so a reverse
  // string sort is chronological — newest first.
  const keys = Object.keys(event.completions ?? {}).sort((a, b) => (a < b ? 1 : -1));

  return (
    <Sheet open onOpenChange={(o: boolean) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[85vh] p-4">
        <div data-testid="completions-sheet">
          <SheetHeader>
            <SheetTitle className="truncate pr-8">{event.title || 'Untitled'}</SheetTitle>
          </SheetHeader>
          <h3 className="text-xs font-semibold uppercase text-muted-foreground mt-3 mb-2">
            Completions ({keys.length})
          </h3>
          {/* Semantic ul/li: this is a list of records, not a menu. */}
          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No completions yet.</p>
          ) : (
            <ul className="flex flex-col">
              {keys.map(key => (
                <li key={key} className="flex items-center gap-2 py-1 border-b border-border">
                  <span className="text-sm flex-1" title={key}>{relativeTime(key)}</span>
                  {canEdit && (
                    <DeleteButton
                      tooltip="Delete completion"
                      confirmMessage={`Delete this completion (${relativeTime(key)})?`}
                      onConfirm={() => onDeleteCompletion(uid, key)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
