import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { MdTextField } from '@/components/ui/md-text-field';
import { MdSelect } from '@/components/ui/md-select';
import type { CalendarEvent } from '../../../shared/schemas/calendar';
import { PropertySheet, SheetActions, SheetActionItem } from '../../shared/PropertySheet';
import type { PropertyDef } from '../../shared/PropertySheet';
import type { PeerFieldInfo } from '../../shared/presence';
import { isAllDay, describeRecurrence } from './recurrence';

interface EventEditorProps {
  uid: string;
  event: CalendarEvent;
  masterEvent: CalendarEvent | null;
  recurrenceDate: string | null;
  isNew: boolean;
  opened: boolean;
  onSave: (uid: string, data: CalendarEvent) => void;
  onSaveOverride: (uid: string, recurrenceDate: string, patch: any) => void;
  onDelete: (uid: string) => void;
  onDeleteOccurrence: (uid: string, recurrenceDate: string) => void;
  onClose: () => void;
  onEditAll: (uid: string) => void;
  onFieldFocus?: (path: (string | number)[] | null) => void;
  peerFocusedFields?: Record<string, PeerFieldInfo>;
  calendars?: { docId: string; name: string; color: string }[];
  calDocId?: string;
  onMoveToCalendar?: (uid: string, data: CalendarEvent, targetDocId: string) => void;
}

const DAY_LABELS = [
  { key: 'su', label: 'S' }, { key: 'mo', label: 'M' }, { key: 'tu', label: 'T' },
  { key: 'we', label: 'W' }, { key: 'th', label: 'T' }, { key: 'fr', label: 'F' }, { key: 'sa', label: 'S' },
];
const FREQ_OPTIONS = [
  { value: '_none', label: 'None' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];
const END_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: 'count', label: 'After' },
  { value: 'until', label: 'On date' },
];
const FREQ_LABELS: Record<string, string> = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' };

const FIELD_TO_PROP: Record<string, string> = {
  'ed-title': 'title',
  'ed-date': 'start',
  'ed-time': 'start',
  'ed-allday': 'start',
  'ed-duration': 'duration',
  'ed-freq': 'recurrenceRule',
  'ed-location': 'location',
  'ed-desc': 'description',
};

/**
 * The two grouped property rows. Date / all-day / time / duration are one
 * decision ("when is this?") and all-day is a modality switch, so on separate
 * rows two of them would appear and disappear from the list as you toggle it.
 * The recurrence inputs are meaningless individually and all write one doc
 * property. Presence-wise each row unions its members' field ids, since peers
 * still broadcast at input granularity (see PATH_PROP_TO_FIELDS).
 */
const WHEN_FIELDS = ['ed-date', 'ed-time', 'ed-allday', 'ed-duration'];
const REPEAT_FIELDS = ['ed-freq', 'ed-interval', 'ed-bydays', 'ed-ends', 'ed-count', 'ed-until'];

function dateFrom(start?: string) { return start ? start.substring(0, 10) : ''; }
function timeFrom(start?: string) { return start && start.length > 10 ? start.substring(11, 16) : ''; }
function locationText(loc?: string | null) { return loc || ''; }
function byDayMap(rule?: any): Record<string, boolean> {
  const checked: Record<string, boolean> = {};
  if (rule?.byDay) rule.byDay.forEach((d: any) => { checked[d.day] = true; });
  return checked;
}

export function EventEditor({ uid, event, masterEvent, recurrenceDate, isNew, opened, onSave, onSaveOverride, onDelete, onDeleteOccurrence, onClose, onEditAll, onFieldFocus, peerFocusedFields, calendars, calDocId, onMoveToCalendar }: EventEditorProps) {
  const isRecurring = masterEvent && !!masterEvent.recurrenceRule;
  const editingOccurrence = isRecurring && !!recurrenceDate;

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

  const sourceEvent = editingOccurrence ? masterEvent! : event;
  const currentRule = sourceEvent.recurrenceRule || null;

  const [title, setTitle] = useState(event.title || '');
  const [date, setDate] = useState(() => dateFrom(event.start));
  const [allday, setAllday] = useState(isAllDay(event));
  const [time, setTime] = useState(() => timeFrom(event.start));
  const [duration, setDuration] = useState(event.duration || 'PT1H');
  const [location, setLocation] = useState(() => locationText(event.location));
  const [description, setDescription] = useState(event.description || '');
  const [selectedCalDocId, setSelectedCalDocId] = useState(calDocId || '');
  const [freq, setFreq] = useState(currentRule?.frequency || '');
  const [interval, setInterval] = useState(currentRule?.interval || 1);
  const [byDay, setByDay] = useState(() => byDayMap(currentRule));
  const [endType, setEndType] = useState(currentRule?.count ? 'count' : (currentRule?.until ? 'until' : 'never'));
  const [count, setCount] = useState(currentRule?.count || 10);
  const [until, setUntil] = useState(currentRule?.until ? currentRule.until.substring(0, 10) : '');

  const prevEventRef = useRef(event);
  const prevMasterRef = useRef(masterEvent);
  useEffect(() => {
    const prev = prevEventRef.current;
    const prevM = prevMasterRef.current;
    prevEventRef.current = event;
    prevMasterRef.current = masterEvent;

    if (prev.title !== event.title) setTitle(event.title || '');
    if (prev.start !== event.start) {
      setDate(dateFrom(event.start));
      setTime(timeFrom(event.start));
      setAllday(isAllDay(event));
    }
    if (prev.duration !== event.duration) setDuration(event.duration || 'PT1H');
    if (prev.description !== event.description) setDescription(event.description || '');
    if (prev.location !== event.location) {
      setLocation(locationText(event.location));
    }

    const source = (isRecurring && recurrenceDate) ? masterEvent : event;
    const prevSource = (isRecurring && recurrenceDate) ? prevM : prev;
    if (calDocId) setSelectedCalDocId(calDocId);

    if (JSON.stringify(prevSource?.recurrenceRule) !== JSON.stringify(source?.recurrenceRule)) {
      const rule = source?.recurrenceRule || null;
      setFreq(rule?.frequency || '');
      setInterval(rule?.interval || 1);
      setByDay(byDayMap(rule));
      setEndType(rule?.count ? 'count' : (rule?.until ? 'until' : 'never'));
      setCount(rule?.count || 10);
      setUntil(rule?.until ? rule.until.substring(0, 10) : '');
    }
  }, [event, masterEvent, isRecurring, recurrenceDate]);

  interface Draft {
    title: string; date: string; allday: boolean; time: string; duration: string;
    location: string; description: string; calDocId: string;
    freq: string; interval: number; byDay: Record<string, boolean>;
    endType: string; count: number; until: string;
  }

  /**
   * Auto-save, matching the task and counter editors: every field commits on
   * blur/change and the X is the only "done" gesture — there is no Save/Cancel.
   *
   * `overrides` carries a value that hasn't landed in state yet (a select fires
   * its handler before the re-render). A commit with no date is dropped rather
   * than warned about: an event without a start can't be written, and under
   * auto-save there is no button press to attach an alert to.
   */
  const commit = (overrides: Partial<Draft> = {}) => {
    const d: Draft = {
      title, date, allday, time, duration, location, description,
      calDocId: selectedCalDocId, freq, interval, byDay, endType, count, until,
      ...overrides,
    };
    if (!d.date) return;

    if (editingOccurrence) {
      const patch: any = {};
      if (d.title !== (masterEvent!.title || '')) patch.title = d.title || 'Untitled';
      const newStart = d.allday ? d.date : d.date + 'T' + (d.time || '09:00') + ':00';
      if (newStart !== recurrenceDate) patch.start = newStart;
      if (d.duration !== (masterEvent!.duration || 'PT1H')) patch.duration = d.duration || (d.allday ? 'P1D' : 'PT1H');
      // Patch whenever changed (including to ''), so clearing location sticks —
      // same behavior as description below.
      if (d.location !== locationText(masterEvent!.location)) {
        patch.location = d.location;
      }
      if (d.description !== (masterEvent!.description || '')) {
        patch.description = d.description;
      }
      if (Object.keys(patch).length === 0) return;
      onSaveOverride(uid, recurrenceDate!, patch);
      return;
    }

    const updated: any = { '@type': 'Event', title: d.title || 'Untitled' };
    if (d.allday) {
      updated.start = d.date;
      updated.duration = d.duration || 'P1D';
      updated.timeZone = null;
    } else {
      updated.start = d.date + 'T' + (d.time || '09:00') + ':00';
      updated.duration = d.duration || 'PT1H';
      updated.timeZone = null;
    }
    updated.location = d.location || undefined;
    updated.description = d.description || undefined;

    if (d.freq) {
      const newRule: any = { '@type': 'RecurrenceRule', frequency: d.freq };
      if (d.interval > 1) newRule.interval = d.interval;
      if (d.freq === 'weekly') {
        const selectedDays = Object.entries(d.byDay).filter(([, v]) => v).map(([k]) => ({ '@type': 'NDay', day: k }));
        if (selectedDays.length > 0) newRule.byDay = selectedDays;
      }
      if (d.endType === 'count') newRule.count = d.count || 10;
      else if (d.endType === 'until' && d.until) newRule.until = d.until;
      updated.recurrenceRule = newRule;
    } else {
      updated.recurrenceRule = undefined;
    }

    if (d.freq && masterEvent?.recurrenceOverrides) {
      updated.recurrenceOverrides = masterEvent.recurrenceOverrides;
    } else {
      updated.recurrenceOverrides = undefined;
    }

    // Only when the pick actually changed — otherwise every keystroke's commit
    // would re-run the cross-document move.
    if (onMoveToCalendar && d.calDocId && d.calDocId !== calDocId) {
      onMoveToCalendar(uid, updated, d.calDocId);
    } else {
      onSave(uid, updated);
    }
  };

  const handleDelete = () => {
    if (editingOccurrence) {
      if (!confirm('Delete this occurrence?')) return;
      onDeleteOccurrence(uid, recurrenceDate!);
    } else {
      if (!confirm('Delete this event' + (isRecurring ? ' and all occurrences' : '') + '?')) return;
      onDelete(uid);
    }
  };

  const heading = isNew ? 'New Event' : (editingOccurrence ? 'Edit Occurrence' : 'Edit Event');

  const selectedCalendar = calendars?.find(c => c.docId === selectedCalDocId);
  const whenSummary = !date
    ? ''
    : allday
      ? `${date} (all day)`
      : `${date}${time ? ` at ${time}` : ''}${duration ? ` for ${duration}` : ''}`;

  const properties: PropertyDef[] = [
    {
      id: 'ed-calendar',
      label: 'Calendar',
      icon: 'calendar_month',
      hidden: !calendars || calendars.length <= 1,
      summary: () => selectedCalendar?.name || 'Untitled',
      render: ({ back }) => (
        <MdSelect
          label="Calendar"
          id="ed-calendar"
          value={selectedCalDocId}
          options={(calendars ?? []).map(c => ({ value: c.docId, label: c.name || 'Untitled' }))}
          onValueChange={v => { setSelectedCalDocId(v); commit({ calDocId: v }); back(); }}
        />
      ),
    },
    {
      id: 'ed-title',
      label: 'Title',
      icon: 'edit',
      summary: () => title,
      render: ({ back }) => (
        <MdTextField
          label="Title"
          id="ed-title"
          value={title}
          onInput={setTitle}
          onFocus={() => focusField('ed-title')}
          onBlur={blurField}
          onCommit={v => commit({ title: v })}
          onEnter={v => { commit({ title: v }); back(); }}
        />
      ),
    },
    {
      id: 'ed-when',
      label: 'When',
      icon: 'schedule',
      presenceIds: WHEN_FIELDS,
      summary: () => whenSummary,
      render: () => (
        <div className="flex flex-col gap-4">
          <MdTextField
            label="Date"
            id="ed-date"
            type="date"
            value={date}
            onInput={setDate}
            onFocus={() => focusField('ed-date')}
            onBlur={blurField}
            onCommit={v => commit({ date: v })}
          />

          <div className="flex items-center gap-2">
            <Checkbox
              id="ed-allday"
              checked={allday}
              onCheckedChange={(checked: boolean) => {
                setAllday(checked);
                // All-day and timed events carry different duration shapes, so
                // the toggle rewrites it — and both go in the same commit.
                let nextDuration = duration;
                if (checked && !duration.includes('D')) nextDuration = 'P1D';
                if (!checked && !duration.includes('T')) nextDuration = 'PT1H';
                setDuration(nextDuration);
                commit({ allday: checked, duration: nextDuration });
              }}
              onFocus={() => focusField('ed-allday')}
              onBlur={blurField}
            />
            <Label>All day</Label>
          </div>

          {!allday && (
            <div id="time-fields" className="flex flex-col gap-4">
              <MdTextField
                label="Time"
                id="ed-time"
                type="time"
                value={time}
                onInput={setTime}
                onFocus={() => focusField('ed-time')}
                onBlur={blurField}
                onCommit={v => commit({ time: v })}
              />
              <MdTextField
                label="Duration"
                id="ed-duration"
                value={duration}
                onInput={setDuration}
                onFocus={() => focusField('ed-duration')}
                onBlur={blurField}
                onCommit={v => commit({ duration: v })}
              />
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'ed-repeat',
      label: 'Repeat',
      icon: 'repeat',
      // An occurrence override can't change the series' rule.
      hidden: !!editingOccurrence,
      presenceIds: REPEAT_FIELDS,
      summary: () => (freq ? describeRecurrence({ frequency: freq, interval, byDay: Object.entries(byDay).filter(([, v]) => v).map(([day]) => ({ day })) }) : 'Never'),
      render: () => (
        <div className="flex flex-col gap-4">
          <MdSelect
            label="Repeat"
            id="ed-freq"
            value={freq || '_none'}
            options={FREQ_OPTIONS}
            onFocus={() => focusField('ed-freq')}
            onValueChange={v => {
              const next = v === '_none' ? '' : v;
              setFreq(next);
              commit({ freq: next });
              blurField();
            }}
          />

          {freq && (
            <div id="recurrence-opts" className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <span className="text-sm">Every</span>
                <Input
                  id="ed-interval"
                  type="number"
                  min={1}
                  value={String(interval)}
                  onInput={(e: any) => setInterval(parseInt(e.currentTarget.value) || 1)}
                  onBlur={(e: any) => commit({ interval: parseInt(e.currentTarget.value) || 1 })}
                  className="w-16"
                />
                <span className="text-sm">{FREQ_LABELS[freq] || 'days'}</span>
              </div>

              {freq === 'weekly' && (
                <div id="weekly-days" className="flex items-center gap-1">
                  {DAY_LABELS.map(d => (
                    <button
                      key={d.key}
                      className={`day-btn inline-flex items-center justify-center h-8 w-8 rounded-full text-xs font-medium transition-colors ${byDay[d.key] ? 'active bg-primary text-primary-foreground' : 'border border-input hover:bg-accent'}`}
                      onClick={() => {
                        const next = { ...byDay, [d.key]: !byDay[d.key] };
                        setByDay(next);
                        commit({ byDay: next });
                      }}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              )}

              <MdSelect
                label="Ends"
                id="ed-ends"
                value={endType}
                options={END_OPTIONS}
                onValueChange={v => { setEndType(v || 'never'); commit({ endType: v || 'never' }); }}
              />

              {endType === 'count' && (
                <div id="end-count" className="flex items-center gap-2">
                  <Input
                    id="ed-count"
                    type="number"
                    min={1}
                    value={String(count)}
                    onInput={(e: any) => setCount(parseInt(e.currentTarget.value) || 10)}
                    onBlur={(e: any) => commit({ count: parseInt(e.currentTarget.value) || 10 })}
                    className="w-20"
                  />
                  <span className="text-sm">occurrences</span>
                </div>
              )}
              {endType === 'until' && (
                <div id="end-until">
                  <MdTextField
                    label="Until"
                    id="ed-until"
                    type="date"
                    value={until}
                    onInput={setUntil}
                    onCommit={v => commit({ until: v })}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'ed-location',
      label: 'Location',
      icon: 'location_on',
      summary: () => location,
      render: ({ back }) => (
        <MdTextField
          label="Location"
          id="ed-location"
          value={location}
          onInput={setLocation}
          onFocus={() => focusField('ed-location')}
          onBlur={blurField}
          onCommit={v => commit({ location: v })}
          onEnter={v => { commit({ location: v }); back(); }}
        />
      ),
    },
    {
      id: 'ed-desc',
      label: 'Description',
      icon: 'notes',
      summary: () => description,
      render: () => (
        <MdTextField
          label="Description"
          id="ed-desc"
          type="textarea"
          rows={4}
          value={description}
          onInput={setDescription}
          onFocus={() => focusField('ed-desc')}
          onBlur={blurField}
          onCommit={v => commit({ description: v })}
        />
      ),
    },
  ];

  return (
    <PropertySheet
      open={opened}
      title={heading}
      data-testid="event-editor"
      contentClassName="panel"
      properties={properties}
      peerFocusedFields={peerFocusedFields}
      initialDetailId={isNew ? 'ed-title' : null}
      onClose={onClose}
      flushOnClose
      // Switching to the whole series is a real mode change, not a footnote —
      // it gets a full-width row rather than an inline link.
      banner={editingOccurrence ? (
        <md-list style={{ background: 'transparent' }}>
          <md-list-item type="button" data-testid="ed-edit-all" onClick={() => onEditAll(uid)}>
            <md-icon slot="start">repeat</md-icon>
            <div slot="headline">Edit all events</div>
            <div slot="supporting-text">You're editing one occurrence of a recurring event</div>
            <md-icon slot="end" aria-hidden="true">chevron_right</md-icon>
          </md-list-item>
        </md-list>
      ) : undefined}
      // Delete sits with the properties rather than in the action bar: it acts on
      // the event, not on the pending edit, and an error-toned Material row reads
      // as destructive in a way a third button in a row of three does not.
      footer={!isNew ? (
        <SheetActions>
          <SheetActionItem
            icon="delete"
            destructive
            data-testid="ed-delete"
            label={editingOccurrence ? 'Delete occurrence' : ('Delete' + (isRecurring ? ' all' : ''))}
            onClick={handleDelete}
          />
        </SheetActions>
      ) : undefined}
    />
  );
}
