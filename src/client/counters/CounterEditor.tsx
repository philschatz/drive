import { useState, useEffect, useRef } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { DeleteButton } from '@/components/ui/delete-button';
import { relativeTime } from '../../shared/relative-time';
import type { CounterEvent } from './schema';
import type { RecurrenceRule, NDay } from '../calendar/schema';

const FREQ_OPTIONS = [
  { value: 'none', label: 'No repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];

const WEEKDAYS: { day: NDay['day']; label: string }[] = [
  { day: 'mo', label: 'Mon' }, { day: 'tu', label: 'Tue' }, { day: 'we', label: 'Wed' },
  { day: 'th', label: 'Thu' }, { day: 'fr', label: 'Fri' }, { day: 'sa', label: 'Sat' },
  { day: 'su', label: 'Sun' },
];

interface CounterEditorProps {
  uid: string;
  event: CounterEvent;
  isNew: boolean;
  opened: boolean;
  /** Whether the current user may edit; gates the per-completion delete buttons. */
  canEdit?: boolean;
  onSave: (uid: string, data: CounterEvent) => void;
  onDelete: (uid: string) => void;
  onDeleteCompletion: (uid: string, key: string) => void;
  onClose: () => void;
  /** Rapid entry: after saving a NEW counter via Enter, reopen a fresh blank one. */
  onAddAnother?: () => void;
  /** End/resume the recurrence (recurring items only). */
  onArchive?: (uid: string) => void;
  onUnarchive?: (uid: string) => void;
}

export function CounterEditor({ uid, event, isNew, opened, canEdit = true, onSave, onDelete, onDeleteCompletion, onClose, onAddAnother, onArchive, onUnarchive }: CounterEditorProps) {
  const [title, setTitle] = useState(event.title || '');
  const [startTime, setStartTime] = useState(event.startTime ? event.startTime.substring(0, 5) : '');
  const [duration, setDuration] = useState(event.duration || '');
  // A brand-new habit defaults to daily recurrence (so new users start with a
  // repeating habit); an existing schedule-less tally keeps 'none'.
  const [frequency, setFrequency] = useState(event.recurrenceRule?.frequency || (isNew ? 'daily' : 'none'));
  const [interval, setInterval] = useState(event.recurrenceRule?.interval || 1);
  const [byDay, setByDay] = useState<NDay['day'][]>((event.recurrenceRule?.byDay || []).map(d => d.day));

  // Focus the title whenever the editor opens or moves to another counter
  // (including the fresh blank after Enter-to-add-another).
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (opened) titleRef.current?.focus();
  }, [opened, uid]);

  const prevRef = useRef(event);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = event;
    if (prev === event) return;
    setTitle(event.title || '');
    setStartTime(event.startTime ? event.startTime.substring(0, 5) : '');
    setDuration(event.duration || '');
    setFrequency(event.recurrenceRule?.frequency || (isNew ? 'daily' : 'none'));
    setInterval(event.recurrenceRule?.interval || 1);
    setByDay((event.recurrenceRule?.byDay || []).map(d => d.day));
  }, [event]);

  // Re-render every 30s while open so relative completion times stay current
  // ("just now" → "a minute ago") without needing a new click.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!opened) return;
    // window.* — the `interval` state setter above shadows the global setInterval.
    const t = window.setInterval(() => setTick(n => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [opened]);

  const recurring = frequency !== 'none';

  // Recorded completions, newest first. Keys are lexicographically-sortable
  // local-datetime strings, so a reverse string sort is chronological.
  const completionKeys = Object.keys(event.completions ?? {}).sort((a, b) => (a < b ? 1 : -1));

  /**
   * Auto-save: commit the full current field set (with optional not-yet-in-state
   * overrides, e.g. a Select's fresh value). Called on field blur/change — there
   * are no Save/Cancel buttons. A NEW counter is only created once it has a
   * title, so dismissing an untouched editor never creates anything.
   */
  const commit = (overrides: Partial<{
    title: string;
    startTime: string;
    duration: string;
    frequency: string;
    interval: number;
    byDay: NDay['day'][];
  }> = {}) => {
    const effTitle = ((overrides.title ?? title) || '').trim();
    if (isNew && !effTitle) return;
    const effFrequency = overrides.frequency ?? frequency;
    const effInterval = overrides.interval ?? interval;
    const effByDay = overrides.byDay ?? byDay;
    const effStartTime = overrides.startTime ?? startTime;
    const effDuration = overrides.duration ?? duration;
    const isRecurring = effFrequency !== 'none';

    let recurrenceRule: RecurrenceRule | undefined;
    if (isRecurring) {
      recurrenceRule = { '@type': 'RecurrenceRule', frequency: effFrequency as RecurrenceRule['frequency'] };
      if (effInterval > 1) recurrenceRule.interval = effInterval;
      if (effFrequency === 'weekly' && effByDay.length > 0) {
        recurrenceRule.byDay = effByDay.map(day => ({ '@type': 'NDay', day }));
      }
      // Preserve an archive bound (recurrenceRule.until) the rebuild would drop,
      // so editing an archived habit doesn't silently un-archive it.
      if (event.recurrenceRule?.until) recurrenceRule.until = event.recurrenceRule.until;
    }
    onSave(uid, {
      '@type': 'Event',
      title: effTitle || 'Untitled',
      // Recurring items get a date anchor so occurrences (and the chart) begin
      // when the item was created, not retroactively; a new one defaults to
      // today. A schedule-less tally has no start. Time-of-day is separate.
      start: isRecurring ? (event.start || Temporal.Now.plainDateISO().toString()) : undefined,
      startTime: isRecurring && effStartTime ? effStartTime + ':00' : undefined,
      duration: isRecurring && effDuration ? effDuration : undefined,
      recurrenceRule,
    });
  };

  const handleDelete = () => {
    if (!confirm('Delete this counter?')) return;
    onDelete(uid);
  };

  const handleArchive = () => {
    if (!confirm(`Archive "${event.title || 'Untitled'}" habit?`)) return;
    onArchive?.(uid);
  };

  const isArchivedNow = !!event.recurrenceRule?.until;

  return (
    <Sheet open={opened} onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[85vh]">
        <SheetHeader>
          <SheetTitle>{isNew ? 'New Counter' : 'Edit Counter'}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 mt-4">
          <div>
            <Label>Title</Label>
            <Input
              ref={titleRef}
              data-testid="ced-title"
              value={title}
              onInput={(e: any) => setTitle(e.currentTarget.value)}
              onBlur={(e: any) => commit({ title: e.currentTarget.value })}
              onKeyDown={(e: any) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (!title.trim()) return; // no accidental empty counters
                commit();
                // Rapid entry: keep the sheet open on a fresh blank counter.
                if (isNew) onAddAnother?.();
              }}
            />
          </div>

          <div>
            <Label>Repeat</Label>
            <Select
              value={frequency}
              onValueChange={(v: string) => {
                const next = (v || 'none') as any;
                setFrequency(next);
                commit({ frequency: next });
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {FREQ_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {frequency !== 'none' && (
            <div>
              <Label>Every</Label>
              <Input
                type="number"
                min={1}
                value={String(interval)}
                onInput={(e: any) => setInterval(Math.max(1, parseInt(e.currentTarget.value) || 1))}
                onBlur={(e: any) => commit({ interval: Math.max(1, parseInt(e.currentTarget.value) || 1) })}
              />
            </div>
          )}

          {frequency === 'weekly' && (
            <div>
              <Label>On days</Label>
              <div className="flex flex-wrap gap-3 mt-1">
                {WEEKDAYS.map(({ day, label }) => (
                  <label key={day} className="flex items-center gap-1 text-sm">
                    <Checkbox
                      checked={byDay.includes(day)}
                      onCheckedChange={(checked: boolean) => {
                        const next = checked ? [...byDay, day] : byDay.filter(d => d !== day);
                        setByDay(next);
                        commit({ byDay: next });
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          )}

          {recurring && (
            <>
              <div>
                <Label>Time of day (optional)</Label>
                <Input
                  type="time"
                  value={startTime}
                  onInput={(e: any) => setStartTime(e.currentTarget.value)}
                  onBlur={(e: any) => commit({ startTime: e.currentTarget.value })}
                />
                <p className="text-xs text-muted-foreground mt-1">When the window to do this opens each time. Leave blank for all day.</p>
              </div>

              <div>
                <Label>Duration (optional, e.g. PT30M)</Label>
                <Input
                  value={duration}
                  placeholder="PT1H"
                  onInput={(e: any) => setDuration(e.currentTarget.value)}
                  onBlur={(e: any) => commit({ duration: e.currentTarget.value })}
                />
                <p className="text-xs text-muted-foreground mt-1">How long you have to do it before it counts as missed.</p>
              </div>
            </>
          )}

          {/* Auto-save: fields commit on blur/change — no Save/Cancel. */}
          {!isNew && (
            <div className="flex items-center justify-end gap-2 mt-4">
              {canEdit && event.recurrenceRule && !isArchivedNow && (
                <Button variant="outline" onClick={handleArchive}>
                  <span aria-hidden="true" className="material-symbols-outlined mr-1" style={{ fontSize: 16 }}>archive</span>
                  Archive
                </Button>
              )}
              {canEdit && isArchivedNow && (
                <Button variant="outline" onClick={() => onUnarchive?.(uid)}>
                  <span aria-hidden="true" className="material-symbols-outlined mr-1" style={{ fontSize: 16 }}>unarchive</span>
                  Unarchive
                </Button>
              )}
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={handleDelete}>Delete</Button>
            </div>
          )}

          {!isNew && (
            <div className="mt-6 border-t border-border pt-4">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
                Completions ({completionKeys.length})
              </h3>
              {completionKeys.length === 0 ? (
                <p className="text-sm text-muted-foreground">No completions yet.</p>
              ) : (
                <ul className="flex flex-col">
                  {completionKeys.map(key => (
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
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
