import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import type { CalendarEvent } from './schema';
import { PresenceDot } from '../../shared/presence';
import type { PeerFieldInfo } from '../../shared/presence';
import { isAllDay } from './recurrence';

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

  const pd = (id: string) => <PresenceDot fieldId={id} peerFocusedFields={peerFocusedFields} />;
  const peerOpacity = (id: string) => peerFocusedFields?.[id] ? 0.5 : undefined;

  const handleSave = () => {
    if (!date) { alert('Date is required'); return; }

    if (editingOccurrence) {
      const patch: any = {};
      if (title !== (masterEvent!.title || '')) patch.title = title || 'Untitled';
      const newStart = allday ? date : date + 'T' + (time || '09:00') + ':00';
      if (newStart !== recurrenceDate) patch.start = newStart;
      if (duration !== (masterEvent!.duration || 'PT1H')) patch.duration = duration || (allday ? 'P1D' : 'PT1H');
      if (location) {
        if (location !== locationText(masterEvent!.location)) patch.location = location;
      }
      if (description !== (masterEvent!.description || '')) {
        patch.description = description;
      }
      onSaveOverride(uid, recurrenceDate!, patch);
      return;
    }

    const updated: any = { '@type': 'Event', title: title || 'Untitled' };
    if (allday) {
      updated.start = date;
      updated.duration = duration || 'P1D';
      updated.timeZone = null;
    } else {
      updated.start = date + 'T' + (time || '09:00') + ':00';
      updated.duration = duration || 'PT1H';
      updated.timeZone = null;
    }
    updated.location = location || undefined;
    updated.description = description || undefined;

    if (freq) {
      const newRule: any = { '@type': 'RecurrenceRule', frequency: freq };
      if (interval > 1) newRule.interval = interval;
      if (freq === 'weekly') {
        const selectedDays = Object.entries(byDay).filter(([, v]) => v).map(([k]) => ({ '@type': 'NDay', day: k }));
        if (selectedDays.length > 0) newRule.byDay = selectedDays;
      }
      if (endType === 'count') newRule.count = count || 10;
      else if (endType === 'until' && until) newRule.until = until;
      updated.recurrenceRule = newRule;
    } else {
      updated.recurrenceRule = undefined;
    }

    if (freq && masterEvent?.recurrenceOverrides) {
      updated.recurrenceOverrides = masterEvent.recurrenceOverrides;
    } else {
      updated.recurrenceOverrides = undefined;
    }

    if (onMoveToCalendar && selectedCalDocId && selectedCalDocId !== calDocId) {
      onMoveToCalendar(uid, updated, selectedCalDocId);
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

  return (
    <Sheet open={opened} onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="panel">
        <SheetHeader>
          <SheetTitle>{heading}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 mt-4">
          {editingOccurrence && (
            <p className="text-xs text-muted-foreground">
              Recurring event. <a href="#" onClick={(e: any) => { e.preventDefault(); onEditAll(uid); }}>Edit all events</a>
            </p>
          )}

          {calendars && calendars.length > 1 && (
            <div>
              <Label>Calendar</Label>
              <Select value={selectedCalDocId} onValueChange={(v: string) => setSelectedCalDocId(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {calendars.map(c => (
                    <SelectItem key={c.docId} value={c.docId}>
                      <span className="flex items-center gap-2">
                        <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                        {c.name || 'Untitled'}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div style={{ opacity: peerOpacity('ed-title') }}>
            <Label className="flex items-center gap-1"><span>Title</span>{pd('ed-title')}</Label>
            <Input
              id="ed-title"
              value={title}
              onInput={(e: any) => setTitle(e.currentTarget.value)}
              onFocus={() => focusField('ed-title')}
              onBlur={blurField}
              autoFocus
            />
          </div>

          <div style={{ opacity: peerOpacity('ed-date') }}>
            <Label className="flex items-center gap-1"><span>Date</span>{pd('ed-date')}</Label>
            <Input
              id="ed-date"
              type="date"
              value={date}
              onInput={(e: any) => setDate(e.currentTarget.value)}
              onFocus={() => focusField('ed-date')}
              onBlur={blurField}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="ed-allday"
              checked={allday}
              onCheckedChange={(checked: boolean) => {
                setAllday(checked);
                if (checked && !duration.includes('D')) setDuration('P1D');
                if (!checked && !duration.includes('T')) setDuration('PT1H');
              }}
              onFocus={() => focusField('ed-allday')}
              onBlur={blurField}
            />
            <Label>All day</Label>
          </div>

          {!allday && (
            <div id="time-fields">
              <div style={{ opacity: peerOpacity('ed-time') }}>
                <Label className="flex items-center gap-1"><span>Time</span>{pd('ed-time')}</Label>
                <Input
                  id="ed-time"
                  type="time"
                  value={time}
                  onInput={(e: any) => setTime(e.currentTarget.value)}
                  onFocus={() => focusField('ed-time')}
                  onBlur={blurField}
                />
              </div>
              <div style={{ opacity: peerOpacity('ed-duration') }} className="mt-3">
                <Label className="flex items-center gap-1"><span>Duration</span>{pd('ed-duration')}</Label>
                <Input
                  id="ed-duration"
                  value={duration}
                  onInput={(e: any) => setDuration(e.currentTarget.value)}
                  onFocus={() => focusField('ed-duration')}
                  onBlur={blurField}
                />
              </div>
            </div>
          )}

          {!editingOccurrence && (
            <>
              <div style={{ opacity: peerOpacity('ed-freq') }}>
                <Label className="flex items-center gap-1"><span>Repeat</span>{pd('ed-freq')}</Label>
                <Select value={freq || '_none'} onValueChange={(v: string) => setFreq(v === '_none' ? '' : v)}>
                  <SelectTrigger
                    id="ed-freq"
                    onFocus={() => focusField('ed-freq')}
                    onBlur={blurField}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FREQ_OPTIONS.map(o => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {freq && (
                <div id="recurrence-opts">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">Every</span>
                    <Input
                      type="number"
                      min={1}
                      value={String(interval)}
                      onInput={(e: any) => setInterval(parseInt(e.currentTarget.value) || 1)}
                      className="w-16"
                    />
                    <span className="text-sm">{FREQ_LABELS[freq] || 'days'}</span>
                  </div>

                  {freq === 'weekly' && (
                    <div id="weekly-days" className="flex items-center gap-1 mt-3">
                      {DAY_LABELS.map(d => (
                        <button
                          key={d.key}
                          className={`day-btn inline-flex items-center justify-center h-8 w-8 rounded-full text-xs font-medium transition-colors ${byDay[d.key] ? 'active bg-primary text-primary-foreground' : 'border border-input hover:bg-accent'}`}
                          onClick={() => setByDay(prev => ({ ...prev, [d.key]: !prev[d.key] }))}
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="mt-3">
                    <Label>Ends</Label>
                    <Select value={endType} onValueChange={(v: string) => setEndType(v || 'never')}>
                      <SelectTrigger id="ed-ends">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {END_OPTIONS.map(o => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {endType === 'count' && (
                    <div id="end-count" className="flex items-center gap-2 mt-3">
                      <Input
                        id="ed-count"
                        type="number"
                        min={1}
                        value={String(count)}
                        onInput={(e: any) => setCount(parseInt(e.currentTarget.value) || 10)}
                        className="w-20"
                      />
                      <span className="text-sm">occurrences</span>
                    </div>
                  )}
                  {endType === 'until' && (
                    <div id="end-until" className="mt-3">
                      <Input
                        id="ed-until"
                        type="date"
                        value={until}
                        onInput={(e: any) => setUntil(e.currentTarget.value)}
                      />
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <div style={{ opacity: peerOpacity('ed-location') }}>
            <Label className="flex items-center gap-1"><span>Location</span>{pd('ed-location')}</Label>
            <Input
              id="ed-location"
              value={location}
              onInput={(e: any) => setLocation(e.currentTarget.value)}
              onFocus={() => focusField('ed-location')}
              onBlur={blurField}
            />
          </div>

          <div style={{ opacity: peerOpacity('ed-desc') }}>
            <Label className="flex items-center gap-1"><span>Description</span>{pd('ed-desc')}</Label>
            <Textarea
              id="ed-desc"
              value={description}
              onInput={(e: any) => setDescription(e.currentTarget.value)}
              onFocus={() => focusField('ed-desc')}
              onBlur={blurField}
              rows={3}
            />
          </div>

          <div className="flex items-center gap-2 mt-4">
            <Button id="ed-save" onClick={handleSave}>Save</Button>
            <Button id="ed-cancel" variant="outline" onClick={onClose}>Cancel</Button>
            {!isNew && (
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={handleDelete}>
                {editingOccurrence ? 'Delete occurrence' : ('Delete' + (isRecurring ? ' all' : ''))}
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
