import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { subscribeQuery, updateDoc } from '../worker-api';
import { peerColor, peerDisplayName, usePresence, PresenceDot, type PeerFieldInfo } from '../shared/presence';
import { EditorTitleBar } from '../shared/EditorTitleBar';
import { useDocumentHistory } from '../shared/useDocumentHistory';
import { useCanEdit } from '../shared/useCanEdit';
import { replaceDocHash, encodeRestPath } from '../shared/doc-urls';
import { HistorySlider } from '../shared/HistorySlider';
import { useDocumentValidation } from '../shared/useDocumentValidation';
import { ValidationPanel } from '../shared/ValidationPanel';
import { DocLoader } from '../shared/useDocument';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { DeleteButton } from '@/components/ui/delete-button';
import type { CounterEvent } from './schema';
import { sortedCounters, metMissedByWeek, isArchived, type CounterEntry, type CounterStatus } from './occurrences';
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

export function Counters({ docId, rest, readOnly }: { docId?: string; rest?: string; readOnly?: boolean; path?: string }) {
  const eventId = rest?.startsWith('events/') ? rest.slice(7).split('/')[0] : undefined;
  const [listName, setListName] = useState('Counters');
  const [events, setEvents] = useState<Record<string, CounterEvent>>({});
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [quickAddText, setQuickAddText] = useState('');
  // Repeat cadence for the quick-add row. Defaults to 'daily' so a new user's
  // first habit recurs and they immediately see the occurrence tracking in
  // action. 'none' = a schedule-less tally, 'other' = open the full editor
  // (pre-filled) on Add/Enter. Sticky across adds.
  const [quickAddFreq, setQuickAddFreq] = useState<'none' | 'daily' | 'weekly' | 'monthly' | 'other'>('daily');
  // Set when the editor was opened from the quick-add "Other" flow so that
  // saving returns focus to the quick-add input (to add another item).
  const refocusAfterSaveRef = useRef(false);
  const [showValidation, setShowValidation] = useState(false);
  // Re-derive "today" when the clock is read; a minute tick keeps statuses fresh
  // across midnight without re-rendering on every click.
  const [now, setNow] = useState(nowLocal);
  useEffect(() => {
    const t = setInterval(() => setNow(nowLocal()), 60_000);
    return () => clearInterval(t);
  }, []);

  const history = useDocumentHistory(docId!);
  const onNewHeadsRef = useRef(history.onNewHeads);
  onNewHeadsRef.current = history.onNewHeads;
  const validationErrors = useDocumentValidation(docId);
  const { canEdit, canEditRef, noAccess } = useCanEdit(docId, readOnly, history);
  const { peers, peerList, broadcast } = usePresence(docId);
  const editorStateRef = useRef(editorState);
  editorStateRef.current = editorState;
  const titleFocusedRef = useRef(false);
  const pendingEventIdRef = useRef(eventId);

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
    setEditorState(null);
    // Quick-add "Other" flow: after saving, put focus back on the quick-add
    // input so the user can immediately type another item.
    if (refocusAfterSaveRef.current) {
      refocusAfterSaveRef.current = false;
      setTimeout(() => document.getElementById('counter-quick-add')?.focus(), 0);
    }
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

  // Open the editor for a brand-new item with its title pre-filled (the
  // quick-add "Other" flow). Flags refocus so saving returns to the input.
  const openEditorForNew = useCallback((title: string) => {
    refocusAfterSaveRef.current = true;
    setEditorState({ uid: generateUid(), event: { '@type': 'Event', title }, isNew: true });
  }, []);

  const handleQuickAdd = useCallback(() => {
    const title = quickAddText.trim();
    if (!title) return;
    if (quickAddFreq === 'other') {
      openEditorForNew(title);
      setQuickAddText('');
      return;
    }
    // 'none' = a schedule-less tally (no start, no rule). daily/weekly/monthly
    // create a bare recurrence anchored at today so history starts from creation;
    // the user can refine interval/weekdays later via the editor.
    const recurrenceRule = quickAddFreq === 'none'
      ? undefined
      : { '@type': 'RecurrenceRule' as const, frequency: quickAddFreq };
    saveCounter(generateUid(), {
      '@type': 'Event',
      title,
      start: recurrenceRule ? now.substring(0, 10) : undefined,
      recurrenceRule,
    });
    setQuickAddText('');
  }, [quickAddText, quickAddFreq, openEditorForNew, saveCounter, now]);

  // Presence + URL reflect the counter open in the editor.
  const focusPath: (string | number)[] | undefined = editorState ? ['events', editorState.uid] : undefined;
  useEffect(() => {
    broadcast('focusedField', focusPath ?? null);
    if (docId) replaceDocHash(docId, focusPath ? encodeRestPath(focusPath) : undefined);
  }, [editorState, docId, broadcast]);

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
      onNewHeadsRef.current(heads);

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

  let lastSection: CounterStatus | null = null;

  return (
    <DocLoader docId={docId}>
    <>
      <EditorTitleBar
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
        onToggleValidation={() => setShowValidation(v => !v)}
        validationActive={showValidation}
        validationCount={validationErrors.length}
        sourcePath={focusPath}
      />
      <HistorySlider history={history} />
      <div style={noAccess ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
      {showValidation && <ValidationPanel errors={validationErrors} docId={docId} />}

      {canEdit && (
        <div className="flex items-center gap-2 mb-3">
          <Input
            id="counter-quick-add"
            autoFocus
            placeholder="Add a todo/counter..."
            value={quickAddText}
            onInput={(e: any) => setQuickAddText(e.currentTarget.value)}
            onKeyDown={(e: any) => { if (e.key === 'Enter') handleQuickAdd(); }}
            className="flex-1"
          />
          <Select value={quickAddFreq} onValueChange={(v: string) => setQuickAddFreq((v || 'none') as any)}>
            <SelectTrigger className="w-36" aria-label="Repeat"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No repeat</SelectItem>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="other">Other…</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={handleQuickAdd}>Add</Button>
        </div>
      )}

      <div className="flex flex-col" data-testid="counter-list">
        {sorted.map((entry: CounterEntry) => {
          const { uid, ev, status } = entry;
          const header = status !== lastSection ? SECTION_LABELS[status] : null;
          lastSection = status;
          const clickCount = Object.keys(ev.completions || {}).length;
          const schedule = describeSchedule(ev);
          const iconColor = status === 'done' ? '#2563eb' : status === 'overdue' ? '#e11d48' : undefined;
          const icon = status === 'done' ? 'check_circle' : status === 'overdue' ? 'error' : status === 'tally' ? 'exposure_plus_1' : 'radio_button_unchecked';
          return (
            <>
              {header && (
                <h3 key={'h-' + status} className="text-xs font-semibold uppercase text-muted-foreground mt-3 mb-1">{header}</h3>
              )}
              <div
                key={uid}
                data-status={status}
                className="flex items-center gap-2 py-2 px-2 border-b border-border rounded-sm"
                style={{
                  cursor: canEdit ? 'pointer' : 'default',
                  opacity: peerEditingEvents[uid] ? 0.5 : status === 'done' ? 0.6 : 1,
                }}
                onClick={() => { if (canEdit) openEditor(uid, ev); }}
                title={canEdit ? 'Click to edit' : undefined}
              >
                {/* Icon + title: the completion-recording target (checkbox-style).
                    stopPropagation so it doesn't also open the editor. */}
                <div
                  className="flex items-center gap-2 min-w-0"
                  onClick={(e: any) => { if (canEdit) { e.stopPropagation(); recordClick(uid); } }}
                  title={canEdit ? 'Click to record a completion' : undefined}
                >
                  <span className="material-symbols-outlined text-lg" style={{ color: iconColor }}>
                    {icon}
                  </span>
                  <span className="text-sm truncate">{ev.title || 'Untitled'}</span>
                </div>
                {/* Stretch: clicking here (the rest of the row) opens the editor. */}
                <div className="flex-1" />
                {schedule && <Badge variant="secondary">{schedule}</Badge>}
                {clickCount > 0 && <Badge variant="outline" title={`${clickCount} recorded`}>{clickCount}×</Badge>}
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Edit counter"
                    onClick={(e: any) => { e.stopPropagation(); openEditor(uid, ev); }}
                  >
                    <span className="material-symbols-outlined text-base">edit</span>
                  </Button>
                )}
                {canEdit && ev.recurrenceRule && (
                  // Wrapper stops the row's click-to-record from also firing.
                  <span onClick={(e: any) => e.stopPropagation()}>
                    <DeleteButton
                      icon="archive"
                      tooltip="Archive"
                      confirmMessage={`Archive "${ev.title || 'Untitled'}" habit?`}
                      onConfirm={() => archiveCounter(uid)}
                    />
                  </span>
                )}
                <PresenceDot fieldId={uid} peerFocusedFields={peerEditingEvents} />
              </div>
            </>
          );
        })}
        {sorted.length === 0 && archived.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">Nothing to count yet. Add something you'd like to do regularly.</p>
        )}

        {archived.length > 0 && (
          <>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground mt-3 mb-1">Archived</h3>
            {archived.map(({ uid, ev, until }) => (
              <div key={uid} className="flex items-center gap-2 py-2 px-2 border-b border-border rounded-sm" style={{ opacity: 0.6 }}>
                <span className="material-symbols-outlined text-lg">inventory_2</span>
                <span className="text-sm flex-1">{ev.title || 'Untitled'}</span>
                <Badge variant="secondary">archived {until.substring(0, 10)}</Badge>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Unarchive"
                    onClick={() => unarchiveCounter(uid)}
                  >
                    <span className="material-symbols-outlined text-base">unarchive</span>
                  </Button>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      <MetMissedChart stats={stats} />
      </div>

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
      />
    </>
    </DocLoader>
  );
}
