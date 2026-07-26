import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { subscribeQuery, updateDoc } from '../worker-api';
import { peerColor, peerDisplayName, usePresence, PresenceDot, type PeerFieldInfo } from '../shared/presence';
import { DocumentTitleBar } from '../shared/DocumentTitleBar';
import { useDocumentHistory } from '../shared/useDocumentHistory';
import { useEditorUndoRedo } from '../shared/useUndoRedo';
import { useHideOnScroll } from '../shared/useHideOnScroll';
import { useCanEdit } from '../shared/useCanEdit';
import { useFocusPathSync } from '../shared/useFocusPathSync';
import { HistorySlider } from '../shared/HistorySlider';
import { useLongPress } from '../shared/useLongPress';
import { useDocumentValidation } from '../shared/useDocumentValidation';
import { DocLoader } from '../shared/useDocument';
import { Badge } from '@/components/ui/badge';
import { Fab } from '@/components/ui/fab';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { CounterEvent } from './schema';
import { MATERIAL_ORANGE } from '../shared/categorical-colors';
import { sortedCounters, metMissedByWeek, isArchived, currentStreak, type CounterEntry, type CounterStatus } from './occurrences';
import { MetMissedChart } from './Chart';
import { CounterEditor } from './CounterEditor';

interface EditorState {
  uid: string;
  event: CounterEvent;
  isNew: boolean;
}

const COUNTERS_QUERY = '{ events: (.events // {}), name: (.name // "Counters") }';

const SECTION_LABELS: Record<CounterStatus, string> = {
  overdue: 'Overdue',
  pending: 'To do',
  upcoming: 'Upcoming',
  done: 'Done',
  tally: 'No schedule',
};

/** Which editor inputs highlight when a peer focuses a given event property.
 * The recurrence-rule cluster (freq/interval/weekdays) shares one doc path. */
const PATH_PROP_TO_FIELDS: Record<string, string[]> = {
  title: ['ced-title'],
  startTime: ['ced-time'],
  duration: ['ced-duration'],
  recurrenceRule: ['ced-freq', 'ced-interval', 'ced-bydays'],
};

function generateUid() {
  return Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

/** Local wall-clock timestamp, "YYYY-MM-DDTHH:mm:ss" (the doc's date format). */
function nowLocal(): string {
  return Temporal.Now.plainDateTimeISO().toString().substring(0, 19);
}

/** A completion key: millisecond precision so rapid clicks in the same second
 * don't collide on the same map key (and get lost). */
function clickKey(): string {
  return Temporal.Now.plainDateTimeISO().toString({ smallestUnit: 'millisecond' });
}

function describeSchedule(ev: CounterEvent): string | null {
  const rule = ev.recurrenceRule;
  if (!rule) return ev.start ? ev.start.substring(0, 10) : null;
  const every = rule.interval && rule.interval > 1 ? `every ${rule.interval} ` : '';
  const base = every ? { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' } : { daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' };
  const freq = (base as any)[rule.frequency] || rule.frequency;
  const days = rule.byDay?.length ? ' on ' + rule.byDay.map(d => d.day).join(', ') : '';
  const at = ev.startTime ? ' at ' + ev.startTime.substring(0, 5) : '';
  return every + freq + days + at;
}

/** Streak tooltip, e.g. "5-day streak" (unit follows the recurrence frequency). */
function streakTitle(streak: number, frequency?: string): string {
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[frequency || ''];
  return unit ? `${streak}-${unit} streak` : `${streak} in a row`;
}

/**
 * One counter row: tap opens the editor (which also holds Archive and Delete);
 * clicking the leading icon or the title records a completion. Long-press /
 * right-click / Shift+F10 / the trailing kebab open the editor too.
 */
function CounterListItem({ uid, ev, status, now, canEdit, peerEditingEvents, onRecord, onEdit }: {
  uid: string;
  ev: CounterEvent;
  status: CounterStatus;
  now: string;
  canEdit: boolean;
  peerEditingEvents: Record<string, PeerFieldInfo>;
  onRecord: (uid: string) => void;
  onEdit: (uid: string, ev: CounterEvent) => void;
}) {
  const clickCount = Object.keys(ev.completions || {}).length;
  const streak = ev.recurrenceRule ? currentStreak(ev, now) : 0;
  const schedule = describeSchedule(ev);
  const title = ev.title || 'Untitled';
  const iconColor = status === 'done'
    ? 'var(--md-sys-color-primary)'
    : status === 'overdue' ? 'var(--md-sys-color-error)' : undefined;
  const icon = status === 'done' ? 'check_circle' : status === 'overdue' ? 'error' : status === 'tally' ? 'exposure_plus_1' : 'radio_button_unchecked';
  const lp = useLongPress({
    onTap: () => { if (canEdit) onEdit(uid, ev); },
    onLongPress: () => { if (canEdit) onEdit(uid, ev); },
  });
  // Real <button>s so useLongPress ignores presses on them (interactive child)
  // and keyboard users can tab to the record action.
  const record = (e: MouseEvent) => { e.stopPropagation(); onRecord(uid); };

  return (
    <md-list-item
      type="button"
      data-status={status}
      data-testid="counter-row"
      style={{ opacity: peerEditingEvents[uid] ? 0.5 : status === 'done' ? 0.6 : 1 }}
      {...lp}
    >
      {canEdit ? (
        <button
          slot="start"
          aria-label={`Record completion for ${title}`}
          className="material-symbols-outlined text-lg state-layer rounded-full"
          style={{ color: iconColor }}
          onClick={record}
        >
          {icon}
        </button>
      ) : (
        <span slot="start" className="material-symbols-outlined text-lg" style={{ color: iconColor }}>
          {icon}
        </span>
      )}
      <div slot="headline">
        {canEdit ? (
          <button className="text-left" onClick={record}>{title}</button>
        ) : (
          title
        )}
      </div>
      <span slot="end" className="flex items-center gap-1.5">
        {schedule && <Badge variant="secondary">{schedule}</Badge>}
        {ev.recurrenceRule
          ? streak > 0 && (
              <Badge
                variant="default"
                title={streakTitle(streak, ev.recurrenceRule.frequency)}
                style={{ background: MATERIAL_ORANGE, color: '#000' }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>local_fire_department</span>
                {streak}
              </Badge>
            )
          : clickCount > 0 && <Badge variant="outline" title={`${clickCount} recorded`}>{clickCount}×</Badge>}
        <PresenceDot fieldId={uid} peerFocusedFields={peerEditingEvents} />
        {canEdit && (
          <button
            aria-label={`Edit ${title}`}
            title="Edit"
            className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer text-muted-foreground"
            onClick={(e: MouseEvent) => { e.stopPropagation(); onEdit(uid, ev); }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>more_vert</span>
          </button>
        )}
      </span>
    </md-list-item>
  );
}

export function Counters({ docId, rest, readOnly }: { docId?: string; rest?: string; readOnly?: boolean; path?: string }) {
  const eventId = rest?.startsWith('events/') ? rest.slice(7).split('/')[0] : undefined;
  const [listName, setListName] = useState('Counters');
  const [events, setEvents] = useState<Record<string, CounterEvent>>({});
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  // Re-derive "today" when the clock is read; a minute tick keeps statuses fresh
  // across midnight without re-rendering on every click.
  const [now, setNow] = useState(nowLocal);
  useEffect(() => {
    const t = setInterval(() => setNow(nowLocal()), 60_000);
    return () => clearInterval(t);
  }, []);

  const history = useDocumentHistory(docId!);
  const { undo, redo, canUndo, canRedo, onHeads } = useEditorUndoRedo(docId!, history);
  const hidden = useHideOnScroll();
  const validationErrors = useDocumentValidation(docId);
  const { canEdit, canEditRef, noAccess } = useCanEdit(docId, readOnly, history);
  const { peers, peerList, broadcast } = usePresence(docId);
  const editorStateRef = useRef(editorState);
  editorStateRef.current = editorState;
  const titleFocusedRef = useRef(false);
  const pendingEventIdRef = useRef(eventId);

  // Auto-save: commits arrive on field blur/change while the editor stays open
  // (dismissing the sheet is the only "done" gesture).
  const saveCounter = useCallback((uid: string, data: CounterEvent) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, uid, data) => {
      // Replace the event's definition but never the click log.
      const prev = d.events[uid];
      const completions = prev && prev.completions ? Object.assign({}, prev.completions) : null;
      const clean: any = {};
      for (const key in data) {
        if ((data as any)[key] !== undefined) clean[key] = (data as any)[key];
      }
      if (completions) clean.completions = completions;
      d.events[uid] = clean;
    }, uid, data);
  }, [docId]);

  const deleteCounter = useCallback((uid: string) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, uid) => { delete d.events[uid]; }, uid);
    setEditorState(null);
  }, [docId]);

  // Archive a habit by ending its recurrence as of now (its `until`); unarchive
  // by removing that bound. Only recurring items have a rule to end.
  const archiveCounter = useCallback((uid: string) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, uid, ts) => { const r = d.events[uid]?.recurrenceRule; if (r) r.until = ts; }, uid, nowLocal());
  }, [docId]);

  const unarchiveCounter = useCallback((uid: string) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, uid) => { const r = d.events[uid]?.recurrenceRule; if (r) delete r.until; }, uid);
  }, [docId]);

  const recordClick = useCallback((uid: string) => {
    if (!canEditRef.current || !docId) return;
    setNow(nowLocal());
    updateDoc(docId, (d, uid, key) => {
      const ev = d.events[uid];
      if (!ev) return;
      if (!ev.completions) ev.completions = {};
      ev.completions[key] = '';
    }, uid, clickKey());
  }, [docId]);

  // Remove a single recorded completion (a mis-click). This is its own mutation:
  // saveCounter re-attaches the completions map wholesale and never deletes keys.
  const deleteCompletion = useCallback((uid: string, key: string) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, uid, key) => {
      const ev = d.events[uid];
      if (ev?.completions) delete ev.completions[key];
    }, uid, key);
  }, [docId]);

  const openEditor = useCallback((uid: string | null, event: CounterEvent | null) => {
    const isNew = !uid;
    if (isNew) {
      uid = generateUid();
      event = { '@type': 'Event', title: '' };
    }
    setEditorState({ uid: uid!, event: event!, isNew });
  }, []);

  // Automerge path to the focused field (drives presence, URL, and Edit Source link)
  const [focusedPath, setFocusedPath] = useState<(string | number)[] | null>(null);
  const focusPath: (string | number)[] | undefined = focusedPath ?? (editorState ? ['events', editorState.uid] : undefined);

  const handleFieldFocus = useCallback((path: (string | number)[] | null) => {
    setFocusedPath(path);
  }, []);

  // Clear a stale field focus when the editor closes; sync presence + URL.
  useEffect(() => { if (!editorState) setFocusedPath(null); }, [editorState]);
  useFocusPathSync(docId, focusPath, broadcast);

  useEffect(() => {
    if (!docId) return;
    let mounted = true;
    const unsubscribe = subscribeQuery(docId, COUNTERS_QUERY, (result, heads) => {
      if (!mounted || !result) return;
      setEvents(result.events || {});
      if (result.name && !titleFocusedRef.current) {
        setListName(result.name);
        document.title = result.name + ' - Counters';
      }
      onHeads(heads);

      if (pendingEventIdRef.current && result.events) {
        const ev = result.events[pendingEventIdRef.current];
        if (ev) openEditor(pendingEventIdRef.current, ev);
        pendingEventIdRef.current = undefined;
      }

      const es = editorStateRef.current;
      if (es && !es.isNew) {
        const fresh = (result.events || {})[es.uid];
        if (fresh) {
          setEditorState(prev => (prev && prev.uid === es.uid) ? { ...prev, event: fresh } : prev);
        } else {
          setEditorState(null);
        }
      }
    });
    return () => { mounted = false; unsubscribe(); };
  }, [docId]);

  const peerEditingEvents = useMemo(() => {
    const result: Record<string, PeerFieldInfo> = {};
    for (const peer of Object.values(peers)) {
      const pf = peer.value?.focusedField;
      if (pf && pf[0] === 'events' && pf[1]) {
        const userGroupId = peer.value?.userGroupId;
        result[pf[1] as string] = { color: peerColor(peer.peerId, userGroupId), peerId: peer.peerId, userGroupId };
      }
    }
    return result;
  }, [peers]);

  // Per-field presence inside the open editor: map peers' focused doc paths
  // (['events', uid, prop]) onto the editor's input ids (mirrors Tasks).
  const peerFocusedFields = useMemo(() => {
    const result: Record<string, PeerFieldInfo> = {};
    if (!editorState) return result;
    for (const peer of Object.values(peers)) {
      const pf = peer.value?.focusedField;
      if (!pf || pf.length < 3) continue;
      if (pf[0] !== 'events' || pf[1] !== editorState.uid) continue;
      const prop = pf[2] as string;
      const inputIds = PATH_PROP_TO_FIELDS[prop];
      if (inputIds) {
        const userGroupId = peer.value?.userGroupId;
        const info = { color: peerColor(peer.peerId, userGroupId), peerId: peer.peerId, userGroupId };
        for (const id of inputIds) result[id] = info;
      }
    }
    return result;
  }, [peers, editorState]);

  // Archived habits (recurrence ended) drop out of the active list, the section
  // counts, and the chart — shown separately at the bottom, newest first.
  const [active, archived] = useMemo(() => {
    const a: Record<string, CounterEvent> = {};
    const arch: { uid: string; ev: CounterEvent; until: string }[] = [];
    for (const [uid, ev] of Object.entries(events)) {
      if (isArchived(ev)) arch.push({ uid, ev, until: ev.recurrenceRule!.until! });
      else a[uid] = ev;
    }
    arch.sort((x, y) => (x.until > y.until ? -1 : 1));
    return [a, arch] as const;
  }, [events]);

  const sorted = sortedCounters(active, now);
  const stats = useMemo(() => metMissedByWeek(active, now), [active, now]);

  // Group the sorted entries into contiguous status sections so each section
  // renders as a header + its own Material list.
  const sections: { status: CounterStatus; entries: CounterEntry[] }[] = [];
  for (const entry of sorted) {
    const last = sections[sections.length - 1];
    if (last && last.status === entry.status) last.entries.push(entry);
    else sections.push({ status: entry.status, entries: [entry] });
  }

  return (
    <DocLoader docId={docId}>
    <>
      <DocumentTitleBar
        icon="event_repeat"
        title={listName}
        titleEditable={canEdit}
        onTitleFocus={() => { titleFocusedRef.current = true; }}
        onTitleChange={setListName}
        onTitleBlur={(value) => {
          titleFocusedRef.current = false;
          if (!docId || !canEdit) return;
          const name = value.trim() || 'Counters';
          setListName(name);
          updateDoc(docId, (d, name) => { d.name = name; }, name);
          document.title = name + ' - Counters';
        }}
        docId={docId}
        peers={peerList}
        peerTitle={(peer) => `${peerDisplayName(peer.peerId, peer.value?.userGroupId)}${peer.value?.focusedField ? ' (editing)' : ''}`}
        onToggleHistory={history.toggleHistory}
        historyActive={history.active}
        onUndo={canEdit ? undo : undefined}
        onRedo={canEdit ? redo : undefined}
        canUndo={canUndo}
        canRedo={canRedo}
        hidden={hidden}
        hasValidationErrors={validationErrors.length > 0}
        sourcePath={focusPath}
        action={{ icon: 'bar_chart', label: 'Chart', onSelect: () => setChartOpen(true) }}
      />
      <HistorySlider history={history} />
      <div
        className="max-w-screen-md mx-auto w-full px-2 sm:px-4 pb-28"
        style={noAccess ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
      >

      <div data-testid="counter-list">
        {sections.map(({ status, entries }) => (
          <div key={status}>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground mt-3 mb-1">{SECTION_LABELS[status]}</h3>
            <md-list style={{ background: 'transparent' }}>
              {entries.map(({ uid, ev }) => (
                <CounterListItem
                  key={uid}
                  uid={uid}
                  ev={ev}
                  status={status}
                  now={now}
                  canEdit={canEdit}
                  peerEditingEvents={peerEditingEvents}
                  onRecord={recordClick}
                  onEdit={openEditor}
                />
              ))}
            </md-list>
          </div>
        ))}
        {sorted.length === 0 && archived.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">Nothing to count yet. Add something you'd like to do regularly.</p>
        )}

        {archived.length > 0 && (
          <>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground mt-3 mb-1">Archived</h3>
            <md-list style={{ background: 'transparent' }}>
              {archived.map(({ uid, ev, until }) => (
                <md-list-item key={uid} data-testid="archived-row" style={{ opacity: 0.6 }}>
                  <span slot="start" className="material-symbols-outlined text-lg">inventory_2</span>
                  <div slot="headline">{ev.title || 'Untitled'}</div>
                  <span slot="end" className="flex items-center gap-1.5">
                    <Badge variant="secondary">archived {until.substring(0, 10)}</Badge>
                    {canEdit && (
                      <button
                        aria-label="Unarchive"
                        title="Unarchive"
                        className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer text-muted-foreground"
                        onClick={() => unarchiveCounter(uid)}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 20 }}>unarchive</span>
                      </button>
                    )}
                  </span>
                </md-list-item>
              ))}
            </md-list>
          </>
        )}
      </div>

      </div>

      {/* Met/missed chart — opened from the title-bar overflow menu. */}
      <Sheet open={chartOpen} onOpenChange={setChartOpen}>
        <SheetContent side="bottom" className="max-h-[70vh]">
          <SheetHeader>
            <SheetTitle>Met vs missed per week</SheetTitle>
          </SheetHeader>
          <div className="mt-3">
            <MetMissedChart stats={stats} />
          </div>
        </SheetContent>
      </Sheet>

      {canEdit && (
        <Fab icon="add" aria-label="New counter" onClick={() => openEditor(null, null)} />
      )}

      <CounterEditor
        uid={editorState?.uid || ''}
        event={editorState?.event || { '@type': 'Event', title: '' }}
        isNew={editorState?.isNew || false}
        opened={!!editorState}
        canEdit={canEdit}
        onSave={saveCounter}
        onDelete={deleteCounter}
        onDeleteCompletion={deleteCompletion}
        onClose={() => setEditorState(null)}
        onAddAnother={() => openEditor(null, null)}
        onArchive={archiveCounter}
        onUnarchive={unarchiveCounter}
        onFieldFocus={handleFieldFocus}
        peerFocusedFields={peerFocusedFields}
      />
    </>
    </DocLoader>
  );
}
