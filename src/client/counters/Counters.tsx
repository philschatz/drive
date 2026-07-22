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
import type { CounterEvent } from './schema';
import { sortedCounters, metMissedByWeek, type CounterEntry, type CounterStatus } from './occurrences';
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
  }, [docId]);

  const deleteCounter = useCallback((uid: string) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, uid) => { delete d.events[uid]; }, uid);
    setEditorState(null);
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

  const openEditor = useCallback((uid: string | null, event: CounterEvent | null) => {
    const isNew = !uid;
    if (isNew) {
      uid = generateUid();
      event = { '@type': 'Event', title: '' };
    }
    setEditorState({ uid: uid!, event: event!, isNew });
  }, []);

  const handleQuickAdd = useCallback(() => {
    const title = quickAddText.trim();
    if (!title) return;
    // Quick-added counters default to a daily habit (no time window).
    saveCounter(generateUid(), {
      '@type': 'Event',
      title,
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
    });
    setQuickAddText('');
  }, [quickAddText, saveCounter, now]);

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

  const sorted = sortedCounters(events, now);
  const stats = useMemo(() => metMissedByWeek(events, now), [events, now]);

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

      <MetMissedChart stats={stats} />

      {canEdit && (
        <div className="flex items-center gap-2 mb-3">
          <Input
            placeholder="Add a daily counter..."
            value={quickAddText}
            onInput={(e: any) => setQuickAddText(e.currentTarget.value)}
            onKeyDown={(e: any) => { if (e.key === 'Enter') handleQuickAdd(); }}
            className="flex-1"
          />
          <Button onClick={handleQuickAdd}>Add</Button>
          <Button variant="outline" onClick={() => openEditor(null, null)}>New…</Button>
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
                onClick={() => { if (canEdit) recordClick(uid); }}
                title={canEdit ? 'Click to record a completion' : undefined}
              >
                <span className="material-symbols-outlined text-lg" style={{ color: iconColor }}>
                  {icon}
                </span>
                <span className="text-sm flex-1">{ev.title || 'Untitled'}</span>
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
                <PresenceDot fieldId={uid} peerFocusedFields={peerEditingEvents} />
              </div>
            </>
          );
        })}
        {sorted.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">Nothing to count yet. Add something you'd like to do regularly.</p>
        )}
      </div>
      </div>

      <CounterEditor
        uid={editorState?.uid || ''}
        event={editorState?.event || { '@type': 'Event', title: '' }}
        isNew={editorState?.isNew || false}
        opened={!!editorState}
        onSave={saveCounter}
        onDelete={deleteCounter}
        onClose={() => setEditorState(null)}
      />
    </>
    </DocLoader>
  );
}
