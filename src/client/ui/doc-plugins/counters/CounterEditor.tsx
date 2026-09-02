import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { MdTextField } from '@/components/ui/md-text-field';
import { MdSelect } from '@/components/ui/md-select';
import { showToast } from '@/components/ui/toast';
import { PropertySheet, SheetActions, SheetActionItem } from '../../common/PropertySheet';
import type { PropertyDef } from '../../common/PropertySheet';
import { FieldEditor, GroupEditor } from '../../common/FieldEditor';
import type { PeerFieldInfo } from '../../common/presence';
import { describeRecurrence } from '../calendar/recurrence';
import { parseReward, formatReward, windowEndTime, windowDuration, createdStampFor, lastCompletionAnchor } from './occurrences';
import type { CounterEvent } from '../../../../shared/schemas/counters';
import type { RecurrenceRule, NDay } from '../../../../shared/schemas/calendar';

/** Editor input id → Automerge doc path (relative props filled with uid below).
 * The recurrence cluster (freq/interval/weekdays) maps to the rule itself. */
const FIELD_TO_PROP: Record<string, string> = {
  'ced-title': 'title',
  'ced-freq': 'recurrenceRule',
  'ced-interval': 'recurrenceRule',
  'ced-bydays': 'recurrenceRule',
  'ced-due': 'start',
  'ced-time': 'startTime',
  'ced-end': 'duration',
  'ced-reward': 'description',
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

/** The Repeat pane's whole value — one draft, one change. */
interface RepeatDraft {
  frequency: string;
  /** Blank means "every one" — the rule simply carries no interval. */
  interval: number | null;
  byDay: NDay['day'][];
}

/** The Reward pane's whole value; both halves live in `description`. */
interface RewardDraft {
  goal: string;
  text: string;
}

/** What the duplicate redirect did to the existing item — see `onUseExisting`. */
export type UseExistingOutcome = 'armed' | 'listed' | 'unarchived';

/** One row of the New-Counter title pane's suggestion list. Display-ready —
 * built by the container, so this file needs none of its status/icon tables. */
export interface CounterSuggestion {
  uid: string;
  /** Stored title, original casing. */
  title: string;
  /** material-symbols glyph for the leading slot. */
  icon: string;
  /** Resolved CSS color for the glyph. */
  color: string;
  /** Status line: "Due" | "Done — back in 3 days" | "Archived" | … */
  label: string;
  /** Same title as the typed draft — saving redirects here instead of creating. */
  exact: boolean;
}

/** The inline/toast line confirming where a redirected title went. */
const REDIRECT_NOTICE: Record<UseExistingOutcome, (title: string) => string> = {
  armed: t => `Added "${t}" to To do`,
  listed: t => `"${t}" is already on the list`,
  unarchived: t => `Unarchived "${t}"`,
};

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
  /** A new counter now exists in the document — stop treating it as new. */
  onCreated?: (uid: string) => void;
  /** End/resume the recurrence (recurring items only). */
  onArchive?: (uid: string) => void;
  onUnarchive?: (uid: string) => void;
  /** Broadcast which field the local user is editing (per-field presence). */
  onFieldFocus?: (path: (string | number)[] | null) => void;
  /** Peers' focused fields keyed by editor input id (see FIELD_TO_PROP). */
  peerFocusedFields?: Record<string, PeerFieldInfo>;
  /** Ranked existing-item matches for the New-Counter title being typed. */
  suggestCounters?: (query: string) => CounterSuggestion[];
  /** Route the typed/picked title to an existing item instead of creating a
   * duplicate; undefined = it vanished meanwhile, so create normally. */
  onUseExisting?: (uid: string) => UseExistingOutcome | undefined;
}

export function CounterEditor({ uid, event, isNew, opened, canEdit = true, onSave, onDelete, onShowCompletions, onClose, onAddAnother, onCreated, onArchive, onUnarchive, onFieldFocus, peerFocusedFields, suggestCounters, onUseExisting }: CounterEditorProps) {
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

  // A non-recurring counter's `start` is its due date — the day it is wanted.
  // (A recurring one's is the schedule anchor, which this pane never shows.)
  // A brand-new counter is a one-off wanted today, so it starts on the to-do
  // list rather than in Anytime — clear Due to opt out, or pick a repeat.
  const seedStartDate = () =>
    event.recurrenceRule ? '' : (event.start || (isNew ? Temporal.Now.plainDateISO().toString() : '')).substring(0, 10);

  const [title, setTitle] = useState(event.title || '');
  const [startDate, setStartDate] = useState(seedStartDate);
  const [startTime, setStartTime] = useState(event.startTime ? event.startTime.substring(0, 5) : '');
  const [duration, setDuration] = useState(event.duration || '');
  const [description, setDescription] = useState(event.description || '');
  const [frequency, setFrequency] = useState(event.recurrenceRule?.frequency || 'none');
  const [interval, setInterval] = useState<number | null>(event.recurrenceRule?.interval ?? null);
  const [byDay, setByDay] = useState<NDay['day'][]>((event.recurrenceRule?.byDay || []).map(d => d.day));

  // Feedback when a typed title was routed to an existing item (title pane).
  // Lives here, not in FieldEditor: the keyed remount when Enter chains to
  // another new counter is exactly the moment it is set.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (!opened) setNotice(null); }, [opened]);

  const prevRef = useRef(event);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = event;
    if (prev === event) return;
    setTitle(event.title || '');
    setStartDate(seedStartDate());
    setStartTime(event.startTime ? event.startTime.substring(0, 5) : '');
    setDuration(event.duration || '');
    setDescription(event.description || '');
    setFrequency(event.recurrenceRule?.frequency || 'none');
    setInterval(event.recurrenceRule?.interval ?? null);
    setByDay((event.recurrenceRule?.byDay || []).map(d => d.day));
  }, [event]);

  const recurring = frequency !== 'none';
  // A window needs something to hang itself on: a schedule, or a due date. Read
  // off the DRAFT rather than the saved event, or the panes would not appear
  // until after the change that should have revealed them.
  const hasWindow = recurring || !!startDate;
  const completionCount = Object.keys(event.completions ?? {}).length;
  // The document stores a duration (calendar spec); the editor edits an end time.
  const endTime = windowEndTime(startTime, duration);
  const reward = parseReward(description);

  /**
   * Write the full current field set, with optional not-yet-in-state overrides —
   * one document change per pane Save. A NEW counter is only created once it has a title, so
   * dismissing an untouched editor never creates anything (and a repeat or reward
   * chosen first rides along with the title itself, out of local state).
   */
  const change = (overrides: Partial<{
    title: string;
    startDate: string;
    startTime: string;
    duration: string;
    description: string;
    frequency: string;
    interval: number | null;
    byDay: NDay['day'][];
  }> = {}) => {
    const effTitle = ((overrides.title ?? title) || '').trim();
    if (isNew && !effTitle) return;
    const effFrequency = overrides.frequency ?? frequency;
    // `interval`, `startDate` and `duration` are clearable, so an explicit override
    // of any must win even when it is null/'' — `??` would fall through to the old
    // value, and clearing a due date would silently leave the item on the to-do list.
    const effInterval = 'interval' in overrides ? overrides.interval! : interval;
    const effByDay = overrides.byDay ?? byDay;
    const effStartDate = 'startDate' in overrides ? overrides.startDate! : startDate;
    const effStartTime = overrides.startTime ?? startTime;
    const effDuration = 'duration' in overrides ? overrides.duration! : duration;
    const effDescription = overrides.description ?? description;
    const isRecurring = effFrequency !== 'none';

    let recurrenceRule: RecurrenceRule | undefined;
    if (isRecurring) {
      recurrenceRule = { '@type': 'RecurrenceRule', frequency: effFrequency as RecurrenceRule['frequency'] };
      if (effInterval && effInterval > 1) recurrenceRule.interval = effInterval;
      if (effFrequency === 'weekly' && effByDay.length > 0) {
        recurrenceRule.byDay = effByDay.map(day => ({ '@type': 'NDay', day }));
      }
      // Preserve an archive bound (recurrenceRule.until) the rebuild would drop,
      // so editing an archived habit doesn't silently un-archive it.
      if (event.recurrenceRule?.until) recurrenceRule.until = event.recurrenceRule.until;
    }
    onSave(uid, {
      '@type': 'Event',
      // Stamped once, never edited: the occurrence grid is anchored here, so the
      // habit's history survives `start` moving with each completion.
      created: event.created || createdStampFor(event),
      title: effTitle || 'Untitled',
      // `start` carries the two meanings the kinds give it. Recurring: the
      // *schedule* anchor — the day of the most recent completion, which the
      // schema checks. Deriving it rather than carrying it through covers the one
      // case that would otherwise break the invariant: a checklist item with
      // clicks being given a schedule. A brand-new recurring counter has no anchor until
      // it is first done. Non-recurring: the due date this pane edits, so a habit
      // demoted to a one-off drops its anchor and starts from the date entered
      // (blank, and it is simply not on the to-do list).
      start: isRecurring ? (lastCompletionAnchor(event) ?? event.start) : (effStartDate || undefined),
      // Not gated on recurrence any more: an armed one-off has a window too, and
      // `startTime` + `duration` are what decide when it goes overdue.
      startTime: effStartTime ? effStartTime + ':00' : undefined,
      duration: effDuration ? effDuration : undefined,
      description: effDescription || undefined,
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

  // Enter in the title pane chains into another new counter; the Save button
  // lands on the property list so the schedule and reward can be set as part of
  // creating it. Both arrive through the one FieldEditor `onSave`.
  const titleViaEnterRef = useRef(false);

  const properties: PropertyDef[] = [
    {
      id: 'ced-title',
      label: 'Title',
      icon: 'edit',
      summary: () => title,
      transactional: true,
      render: ({ back }) => (
        // key={uid}: onAddAnother swaps in a fresh blank counter without closing
        // this pane, and a still-mounted FieldEditor would keep the old draft.
        <FieldEditor
          key={uid}
          data-testid="ced-title"
          value={title}
          validate={v => !!v.trim()} // no accidental empty counters
          onCancel={back}
          onSave={v => {
            const viaEnter = titleViaEnterRef.current;
            titleViaEnterRef.current = false;
            // A title naming an existing item routes there instead of creating
            // a twin — the container arms/unarchives it as appropriate.
            const existing = isNew ? suggestCounters?.(v).find(s => s.exact) : undefined;
            const outcome = existing ? onUseExisting?.(existing.uid) : undefined;
            if (existing && outcome) {
              if (viaEnter) {
                // Chain like a normal rapid-entry create; the notice under the
                // field says where the title went.
                setNotice(REDIRECT_NOTICE[outcome](existing.title));
                setTitle('');
                onAddAnother?.();
                return;
              }
              // Save button: close to the list, where the row now is. Landing on
              // the existing item's property list would silently turn "add" into
              // "edit", and nothing was created, so onCreated must not fire. The
              // toast (stacked under the sheet's scrim while open) is visible now.
              showToast(REDIRECT_NOTICE[outcome](existing.title));
              onClose();
              return;
            }
            // No match — or it vanished meanwhile (outcome undefined): create.
            change({ title: v });
            if (isNew && viaEnter) {
              // Rapid entry: keep the sheet open on a fresh blank counter. Clear
              // `title` here rather than leaving it to the per-uid reset effect —
              // that effect runs *after* the keyed remount, which would seed the
              // new draft from the old title.
              setTitle('');
              onAddAnother?.();
              return;
            }
            setTitle(v);
            // The counter exists in the document now, so the rest of the editor
            // (and its footer) applies to a real item.
            if (isNew) onCreated?.(uid);
            back();
          }}
        >
          {({ value, onInput, save }) => (
            <>
              <MdTextField
                label="Title"
                data-testid="ced-title"
                value={value}
                onInput={v => { setNotice(null); onInput(v); }}
                onFocus={() => focusField('ced-title')}
                onBlur={blurField}
                onEnter={() => { titleViaEnterRef.current = true; save(); }}
              />
              {isNew && suggestCounters && (
                <TitleSuggestions
                  suggestions={suggestCounters(value)}
                  onPick={s => {
                    const outcome = onUseExisting?.(s.uid);
                    if (!outcome) return; // vanished meanwhile — the row is stale
                    setNotice(REDIRECT_NOTICE[outcome](s.title));
                    setTitle('');
                    onAddAnother?.(); // tap = chain, the same gesture as Enter
                  }}
                />
              )}
              {notice && (
                <p data-testid="ced-title-notice" className="mt-2 text-sm text-muted-foreground">{notice}</p>
              )}
            </>
          )}
        </FieldEditor>
      ),
    },
    {
      // One row for the whole rule. Split across rows, "Every" and "On days"
      // would appear and vanish from the list as the frequency changes —
      // exactly the jitter the property list exists to remove. One draft, so
      // ticking three weekdays is one document change, not three.
      id: 'ced-repeat',
      label: 'Repeat',
      icon: 'repeat',
      presenceIds: REPEAT_FIELDS,
      transactional: true,
      summary: () =>
        recurring
          ? describeRecurrence({ frequency, interval: interval ?? undefined, byDay: byDay.map(day => ({ day })) })
          : 'No repeat',
      render: ({ back }) => (
        <GroupEditor<RepeatDraft>
          key={uid}
          data-testid="ced-repeat"
          value={{ frequency, interval, byDay }}
          onCancel={back}
          onSave={v => {
            // State first: while a new counter has no title `change` writes
            // nothing, and the title pane's save then carries these along.
            setFrequency(v.frequency);
            setInterval(v.interval);
            setByDay(v.byDay);
            change(v);
            back();
          }}
        >
          {({ draft, patch }) => (
            <div className="flex flex-col gap-4">
              <MdSelect
                label="Repeat"
                data-testid="ced-freq"
                value={draft.frequency}
                options={FREQ_OPTIONS}
                onFocus={() => focusField('ced-freq')}
                onValueChange={v => patch({ frequency: (v || 'none') as any })}
              />

              {draft.frequency !== 'none' && (
                <MdTextField
                  label="Every"
                  type="number"
                  min={1}
                  data-testid="ced-interval"
                  value={draft.interval === null ? '' : String(draft.interval)}
                  supportingText="Leave blank to repeat every time."
                  onInput={v => {
                    const n = parseInt(v, 10);
                    patch({ interval: Number.isFinite(n) && n >= 1 ? n : null });
                  }}
                  onFocus={() => focusField('ced-interval')}
                  onBlur={blurField}
                />
              )}

              {draft.frequency === 'weekly' && (
                <div data-testid="ced-bydays">
                  <Label className="mb-1 block">On days</Label>
                  <div className="flex flex-wrap gap-3 mt-1">
                    {WEEKDAYS.map(({ day, label }) => (
                      <label key={day} className="flex items-center gap-1 text-sm">
                        <Checkbox
                          checked={draft.byDay.includes(day)}
                          onFocus={() => focusField('ced-bydays')}
                          onBlur={blurField}
                          onCheckedChange={(checked: boolean) => {
                            patch({ byDay: checked ? [...draft.byDay, day] : draft.byDay.filter(d => d !== day) });
                          }}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </GroupEditor>
      ),
    },
    {
      // A one-off's due date: setting it is what puts the counter on the to-do
      // list, and recording a completion clears it again. Hidden for a habit,
      // whose `start` is a schedule anchor the user must not hand-edit.
      id: 'ced-due',
      label: 'Due',
      icon: 'event',
      hidden: recurring,
      summary: () => startDate,
      transactional: true,
      render: ({ back }) => (
        <FieldEditor
          data-testid="ced-due"
          value={startDate}
          onCancel={back}
          onSave={v => { setStartDate(v); change({ startDate: v }); back(); }}
        >
          {({ value, onInput }) => (
            <MdTextField
              label="Due"
              type="date"
              data-testid="ced-due"
              value={value}
              supportingText="When you want this done. Leave blank to keep it off the to-do list."
              onInput={onInput}
              onFocus={() => focusField('ced-due')}
              onBlur={blurField}
            />
          )}
        </FieldEditor>
      ),
    },
    {
      id: 'ced-time',
      label: 'Start time',
      icon: 'schedule',
      hidden: !hasWindow,
      summary: () => startTime,
      transactional: true,
      render: ({ back }) => (
        <FieldEditor
          data-testid="ced-time"
          value={startTime}
          onCancel={back}
          onSave={v => { setStartTime(v); change({ startTime: v }); back(); }}
        >
          {({ value, onInput }) => (
            <MdTextField
              label="Start time"
              type="time"
              data-testid="ced-time"
              value={value}
              supportingText="When the window to do this opens each time. Leave blank for all day."
              onInput={onInput}
              onFocus={() => focusField('ced-time')}
              onBlur={blurField}
            />
          )}
        </FieldEditor>
      ),
    },
    {
      // Stored as a duration (calendar spec), edited as the clock time the
      // window shuts. Moving the start time therefore shifts the whole window;
      // only this pane changes how long it is.
      id: 'ced-end',
      label: 'End time',
      icon: 'timelapse',
      hidden: !hasWindow,
      summary: () => endTime,
      transactional: true,
      render: ({ back }) => (
        <FieldEditor
          data-testid="ced-end"
          value={endTime}
          onCancel={back}
          onSave={v => {
            const next = windowDuration(startTime, v);
            setDuration(next);
            change({ duration: next });
            back();
          }}
        >
          {({ value, onInput }) => (
            <MdTextField
              label="End time"
              type="time"
              data-testid="ced-end"
              value={value}
              supportingText="When the window shuts and it counts as missed. Leave blank for the rest of the day."
              onInput={onInput}
              onFocus={() => focusField('ced-end')}
              onBlur={blurField}
            />
          )}
        </FieldEditor>
      ),
    },
    {
      // Both halves live in `description`, encoded "<goal>: <reward>" — with no
      // goal it is just a note on the habit.
      id: 'ced-reward',
      label: 'Reward',
      icon: 'redeem',
      hidden: !recurring,
      summary: () => (reward ? `${reward.text || 'Reward'} at ${reward.goal} in a row` : description),
      transactional: true,
      render: ({ back }) => (
        <GroupEditor<RewardDraft>
          key={uid}
          data-testid="ced-reward"
          value={{ goal: reward ? String(reward.goal) : '', text: reward ? reward.text : description }}
          onCancel={back}
          onSave={v => {
            const next = formatReward(parseInt(v.goal, 10) || null, v.text);
            setDescription(next);
            change({ description: next });
            back();
          }}
        >
          {({ draft, patch }) => (
            <div className="flex flex-col gap-4">
              <MdTextField
                label="Unlock after a streak of"
                type="number"
                min={1}
                data-testid="ced-reward-goal"
                value={draft.goal}
                supportingText="How many in a row it takes. Leave blank for a plain note."
                onInput={v => patch({ goal: v })}
                onFocus={() => focusField('ced-reward')}
                onBlur={blurField}
              />
              <MdTextField
                label="Reward"
                data-testid="ced-reward-text"
                value={draft.text}
                placeholder="Ice cream"
                onInput={v => patch({ text: v })}
                onFocus={() => focusField('ced-reward')}
                onBlur={blurField}
              />
            </div>
          )}
        </GroupEditor>
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
      // No flushOnClose: every pane here is transactional and writes on its own
      // Save, so there is nothing pending for a blur-on-close to rescue.
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

/**
 * The existing items the typed title matches, under the New-Counter title field
 * — a plain filtered list on the pane itself (the LevelList idiom), not an
 * md-menu: a popover would clip against the sheet and is inert under jsdom,
 * where these rows must stay drivable. Tapping one hands the title to the
 * existing item and chains to the next blank counter, the same rhythm as Enter.
 */
function TitleSuggestions({ suggestions, onPick }: {
  suggestions: CounterSuggestion[];
  onPick: (s: CounterSuggestion) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div data-testid="ced-title-suggestions" className="mt-2">
      <p className="text-xs text-muted-foreground">Already on this list — tap to use:</p>
      <md-list style={{ background: 'transparent' }}>
        {suggestions.map(s => (
          <md-list-item key={s.uid} type="button" data-testid="counter-suggestion" onClick={() => onPick(s)}>
            <span slot="start" aria-hidden="true" className="material-symbols-outlined text-lg" style={{ color: s.color }}>
              {s.icon}
            </span>
            <div slot="headline">{s.title}</div>
            <div slot="supporting-text">{s.label}</div>
          </md-list-item>
        ))}
      </md-list>
    </div>
  );
}
