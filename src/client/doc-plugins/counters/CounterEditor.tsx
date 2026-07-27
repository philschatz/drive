import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { MdTextField } from '@/components/ui/md-text-field';
import { MdSelect } from '@/components/ui/md-select';
import { PropertySheet, SheetActions, SheetActionItem } from '../../shared/PropertySheet';
import type { PropertyDef } from '../../shared/PropertySheet';
import type { PeerFieldInfo } from '../../shared/presence';
import { describeRecurrence } from '../calendar/recurrence';
import type { CounterEvent } from './schema';
import type { RecurrenceRule, NDay } from '../calendar/schema';

/** Editor input id → Automerge doc path (relative props filled with uid below).
 * The recurrence cluster (freq/interval/weekdays) maps to the rule itself. */
const FIELD_TO_PROP: Record<string, string> = {
  'ced-title': 'title',
  'ced-freq': 'recurrenceRule',
  'ced-interval': 'recurrenceRule',
  'ced-bydays': 'recurrenceRule',
  'ced-time': 'startTime',
  'ced-duration': 'duration',
};

/** The freq/interval/weekday inputs all live behind the one "Repeat" row. */
const REPEAT_FIELDS = ['ced-freq', 'ced-interval', 'ced-bydays'];

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
  /** Open the completions log, which lives in its own sheet. */
  onShowCompletions?: (uid: string) => void;
  onClose: () => void;
  /** Rapid entry: after saving a NEW counter via Enter, reopen a fresh blank one. */
  onAddAnother?: () => void;
  /** End/resume the recurrence (recurring items only). */
  onArchive?: (uid: string) => void;
  onUnarchive?: (uid: string) => void;
  /** Broadcast which field the local user is editing (per-field presence). */
  onFieldFocus?: (path: (string | number)[] | null) => void;
  /** Peers' focused fields keyed by editor input id (see FIELD_TO_PROP). */
  peerFocusedFields?: Record<string, PeerFieldInfo>;
}

export function CounterEditor({ uid, event, isNew, opened, canEdit = true, onSave, onDelete, onShowCompletions, onClose, onAddAnother, onArchive, onUnarchive, onFieldFocus, peerFocusedFields }: CounterEditorProps) {
  const fieldToPath = useMemo(() => {
    const map: Record<string, (string | number)[]> = {};
    for (const [inputId, prop] of Object.entries(FIELD_TO_PROP)) {
      map[inputId] = ['events', uid, prop];
    }
    return map;
  }, [uid]);

  const focusField = useCallback((fieldId: string) => {
    if (onFieldFocus && fieldToPath[fieldId]) onFieldFocus(fieldToPath[fieldId]);
  }, [onFieldFocus, fieldToPath]);
  const blurField = useCallback(() => {
    if (onFieldFocus) onFieldFocus(null);
  }, [onFieldFocus]);

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

  const recurring = frequency !== 'none';
  const completionCount = Object.keys(event.completions ?? {}).length;

  /**
   * Auto-save: commit the full current field set (with optional not-yet-in-state
   * overrides, e.g. a select's fresh value). Called on field blur/change — there
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

  const properties: PropertyDef[] = [
    {
      id: 'ced-title',
      label: 'Title',
      icon: 'edit',
      summary: () => title,
      render: ({ back }) => (
        <MdTextField
          label="Title"
          data-testid="ced-title"
          value={title}
          onInput={setTitle}
          onFocus={() => focusField('ced-title')}
          onBlur={blurField}
          onCommit={v => commit({ title: v })}
          onEnter={() => {
            if (!title.trim()) return; // no accidental empty counters
            commit();
            // Rapid entry: keep the sheet open on a fresh blank counter.
            if (isNew) onAddAnother?.();
            else back();
          }}
        />
      ),
    },
    {
      // One row for the whole rule. Split across rows, "Every" and "On days"
      // would appear and vanish from the list as the frequency changes —
      // exactly the jitter the property list exists to remove.
      id: 'ced-repeat',
      label: 'Repeat',
      icon: 'repeat',
      presenceIds: REPEAT_FIELDS,
      summary: () =>
        recurring
          ? describeRecurrence({ frequency, interval, byDay: byDay.map(day => ({ day })) })
          : 'No repeat',
      render: () => (
        <div className="flex flex-col gap-4">
          <MdSelect
            label="Repeat"
            data-testid="ced-freq"
            value={frequency}
            options={FREQ_OPTIONS}
            onFocus={() => focusField('ced-freq')}
            onValueChange={v => {
              const next = (v || 'none') as any;
              setFrequency(next);
              commit({ frequency: next });
              blurField();
            }}
          />

          {recurring && (
            <MdTextField
              label="Every"
              type="number"
              min={1}
              data-testid="ced-interval"
              value={String(interval)}
              onInput={v => setInterval(Math.max(1, parseInt(v) || 1))}
              onFocus={() => focusField('ced-interval')}
              onBlur={blurField}
              onCommit={v => commit({ interval: Math.max(1, parseInt(v) || 1) })}
            />
          )}

          {frequency === 'weekly' && (
            <div data-testid="ced-bydays">
              <Label className="mb-1 block">On days</Label>
              <div className="flex flex-wrap gap-3 mt-1">
                {WEEKDAYS.map(({ day, label }) => (
                  <label key={day} className="flex items-center gap-1 text-sm">
                    <Checkbox
                      checked={byDay.includes(day)}
                      onFocus={() => focusField('ced-bydays')}
                      onBlur={blurField}
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
        </div>
      ),
    },
    {
      id: 'ced-time',
      label: 'Time of day',
      icon: 'schedule',
      hidden: !recurring,
      summary: () => startTime,
      render: () => (
        <MdTextField
          label="Time of day"
          type="time"
          data-testid="ced-time"
          value={startTime}
          supportingText="When the window to do this opens each time. Leave blank for all day."
          onInput={setStartTime}
          onFocus={() => focusField('ced-time')}
          onBlur={blurField}
          onCommit={v => commit({ startTime: v })}
        />
      ),
    },
    {
      id: 'ced-duration',
      label: 'Duration',
      icon: 'timelapse',
      hidden: !recurring,
      summary: () => duration,
      render: () => (
        <MdTextField
          label="Duration"
          data-testid="ced-duration"
          value={duration}
          placeholder="PT1H"
          supportingText="How long you have to do it before it counts as missed (e.g. PT30M)."
          onInput={setDuration}
          onFocus={() => focusField('ced-duration')}
          onBlur={blurField}
          onCommit={v => commit({ duration: v })}
        />
      ),
    },
  ];

  return (
    <PropertySheet
      open={opened}
      title={isNew ? 'New Counter' : 'Edit Counter'}
      data-testid="counter-editor"
      properties={properties}
      peerFocusedFields={peerFocusedFields}
      initialDetailId={isNew ? 'ced-title' : null}
      onClose={onClose}
      flushOnClose
      footer={!isNew ? (
        <SheetActions>
          <SheetActionItem
            icon="history"
            label={`Completions (${completionCount})`}
            data-testid="ced-completions"
            onClick={() => onShowCompletions?.(uid)}
          />
          {canEdit && event.recurrenceRule && !isArchivedNow && (
            <SheetActionItem icon="archive" label="Archive" data-testid="ced-archive" onClick={handleArchive} />
          )}
          {canEdit && isArchivedNow && (
            <SheetActionItem icon="unarchive" label="Unarchive" data-testid="ced-unarchive" onClick={() => onUnarchive?.(uid)} />
          )}
          <SheetActionItem icon="delete" label="Delete" destructive data-testid="ced-delete" onClick={handleDelete} />
        </SheetActions>
      ) : undefined}
    />
  );
}
