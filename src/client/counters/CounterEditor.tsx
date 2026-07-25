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
}

export function CounterEditor({ uid, event, isNew, opened, canEdit = true, onSave, onDelete, onDeleteCompletion, onClose }: CounterEditorProps) {
  const [title, setTitle] = useState(event.title || '');
  const [startTime, setStartTime] = useState(event.startTime ? event.startTime.substring(0, 5) : '');
  const [duration, setDuration] = useState(event.duration || '');
  // A brand-new habit defaults to daily recurrence (so new users start with a
  // repeating habit); an existing schedule-less tally keeps 'none'.
  const [frequency, setFrequency] = useState(event.recurrenceRule?.frequency || (isNew ? 'daily' : 'none'));
  const [interval, setInterval] = useState(event.recurrenceRule?.interval || 1);
  const [byDay, setByDay] = useState<NDay['day'][]>((event.recurrenceRule?.byDay || []).map(d => d.day));

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

  const handleSave = () => {
    let recurrenceRule: RecurrenceRule | undefined;
    if (recurring) {
      recurrenceRule = { '@type': 'RecurrenceRule', frequency: frequency as RecurrenceRule['frequency'] };
      if (interval > 1) recurrenceRule.interval = interval;
      if (frequency === 'weekly' && byDay.length > 0) {
        recurrenceRule.byDay = byDay.map(day => ({ '@type': 'NDay', day }));
      }
      // Preserve an archive bound (recurrenceRule.until) the rebuild would drop,
      // so editing an archived habit doesn't silently un-archive it.
      if (event.recurrenceRule?.until) recurrenceRule.until = event.recurrenceRule.until;
    }
    onSave(uid, {
      '@type': 'Event',
      title: title || 'Untitled',
      // Recurring items get a date anchor so occurrences (and the chart) begin
      // when the item was created, not retroactively; a new one defaults to
      // today. A schedule-less tally has no start. Time-of-day is separate.
      start: recurring ? (event.start || Temporal.Now.plainDateISO().toString()) : undefined,
      startTime: recurring && startTime ? startTime + ':00' : undefined,
      duration: recurring && duration ? duration : undefined,
      recurrenceRule,
    });
  };

  const handleDelete = () => {
    if (!confirm('Delete this counter?')) return;
    onDelete(uid);
  };

  return (
    <Sheet open={opened} onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{isNew ? 'New Counter' : 'Edit Counter'}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 mt-4">
          <div>
            <Label>Title</Label>
            <Input value={title} onInput={(e: any) => setTitle(e.currentTarget.value)} autoFocus />
          </div>

          <div>
            <Label>Repeat</Label>
            <Select value={frequency} onValueChange={(v: string) => setFrequency((v || 'none') as any)}>
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
                      onCheckedChange={(checked: boolean) =>
                        setByDay(prev => checked ? [...prev, day] : prev.filter(d => d !== day))}
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
                <Input type="time" value={startTime} onInput={(e: any) => setStartTime(e.currentTarget.value)} />
                <p className="text-xs text-muted-foreground mt-1">When the window to do this opens each time. Leave blank for all day.</p>
              </div>

              <div>
                <Label>Duration (optional, e.g. PT30M)</Label>
                <Input value={duration} placeholder="PT1H" onInput={(e: any) => setDuration(e.currentTarget.value)} />
                <p className="text-xs text-muted-foreground mt-1">How long you have to do it before it counts as missed.</p>
              </div>
            </>
          )}

          <div className="flex items-center gap-2 mt-4">
            <Button onClick={handleSave}>Save</Button>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            {!isNew && <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={handleDelete}>Delete</Button>}
          </div>

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
