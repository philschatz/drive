import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import '@schedule-x/theme-default/dist/index.css';
import './calendar.css';
import { subscribeQuery, updateDoc, deepAssign } from '../worker-api';
import type { PeerState } from '../../shared/automerge';
import { peerColor, initPresence, type PresenceState } from '../../shared/presence';
import { EditorTitleBar } from '../../shared/EditorTitleBar';
import { useDocumentHistory } from '../../shared/useDocumentHistory';
import { useAccess } from '../../shared/useAccess';
import { HistorySlider } from '../../shared/HistorySlider';
import { getDocEntry, updateDocCache } from '../doc-storage';
import type { CalendarDocument, CalendarEvent } from './schema';
import { rebuildExpanded, toDateStr } from './recurrence';
import { mapToSXEvents, createSXCalendar } from './schedule-x';
import type { EventLookupMap } from './schedule-x';
import { initDragDrop } from './drag-drop';
import { EventEditor } from './EventEditor';
import { useDocumentValidation } from '../../shared/useDocumentValidation';
import { ValidationPanel } from '../../shared/ValidationPanel';
import { DocLoader } from '../../shared/useDocument';


interface EditorState {
  uid: string;
  event: CalendarEvent;
  masterEvent: CalendarEvent | null;
  recurrenceDate: string | null;
  isNew: boolean;
}

import { calendarQuery, expandRange } from './calendar-query';

const PATH_PROP_TO_FIELDS: Record<string, string[]> = {
  title: ['ed-title'],
  start: ['ed-date', 'ed-time', 'ed-allday'],
  duration: ['ed-duration'],
  recurrenceRule: ['ed-freq'],
  location: ['ed-location'],
  description: ['ed-desc'],
};

function generateUid() {
  return Date.now() + '-' + Math.random().toString(36).substr(2, 9) + '_automerge';
}

export function Calendar({ docId, readOnly }: { docId?: string; readOnly?: boolean; path?: string }) {
  return (
    <DocLoader docId={docId}>
      <CalendarInner docId={docId!} readOnly={readOnly} />
    </DocLoader>
  );
}

function CalendarInner({ docId, readOnly }: { docId: string; readOnly?: boolean }) {
  const [calName, setCalName] = useState('Calendar');
  const [calDesc, setCalDesc] = useState('');
  const [calColor, setCalColor] = useState('#039be5');
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [peerStates, setPeerStates] = useState<Record<string, PeerState<PresenceState>>>({});
  const history = useDocumentHistory(docId);
  const validationErrors = useDocumentValidation(docId);
  const { canEdit: accessCanEdit } = useAccess(getDocEntry(docId)?.khDocId);
  const canEdit = !readOnly && history.editable && accessCanEdit;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const eventsRef = useRef<Record<string, CalendarEvent>>({});
  const eventLookupRef = useRef<EventLookupMap>({});
  const currentRangeRef = useRef({ start: '', end: '' });
  const queryRangeRef = useRef({ start: '', end: '' });
  const unsubQueryRef = useRef<(() => void) | null>(null);
  const eventsPluginRef = useRef<any>(null);
  const calendarRef = useRef<any>(null);
  const calColorRef = useRef('#039be5');
  const calTZRef = useRef(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const broadcastRef = useRef<((key: keyof PresenceState, value: any) => void) | null>(null);
  const presenceCleanupRef = useRef<(() => void) | null>(null);
  const editorStateRef = useRef(editorState);
  editorStateRef.current = editorState;
  const titleFocusedRef = useRef(false);
  const descFocusedRef = useRef(false);

  const refreshCalendar = useCallback(() => {
    const range = currentRangeRef.current;
    if (!range.start || !range.end) return;
    const expanded = rebuildExpanded(eventsRef.current, range.start, range.end);
    const { sxEvents, eventLookup } = mapToSXEvents(expanded, calTZRef.current, calColorRef.current);
    eventLookupRef.current = eventLookup;
    if (eventsPluginRef.current) {
      eventsPluginRef.current.set(sxEvents);
    }
  }, []);

  const saveEvent = useCallback((uid: string, eventData: CalendarEvent) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, deepAssign, uid, eventData) => {
      if (!d.events[uid]) {
        const clean: any = {};
        for (const key in eventData) {
          if ((eventData as any)[key] !== undefined) clean[key] = (eventData as any)[key];
        }
        d.events[uid] = clean;
      } else {
        deepAssign(d.events[uid], eventData);
      }
    }, deepAssign, uid, eventData);
    setEditorState(null);
  }, [docId]);

  const saveOverride = useCallback((uid: string, recurrenceDate: string, overrideData: any) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, deepAssign, uid, recurrenceDate, overrideData) => {
      if (!d.events[uid].recurrenceOverrides) d.events[uid].recurrenceOverrides = {};
      if (!d.events[uid].recurrenceOverrides[recurrenceDate]) {
        d.events[uid].recurrenceOverrides[recurrenceDate] = overrideData;
      } else {
        deepAssign(d.events[uid].recurrenceOverrides[recurrenceDate], overrideData);
      }
    }, deepAssign, uid, recurrenceDate, overrideData);
    setEditorState(null);
  }, [docId]);

  const deleteEvent = useCallback((uid: string) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, uid) => { delete d.events[uid]; }, uid);
    setEditorState(null);
  }, [docId]);

  const deleteOccurrence = useCallback((uid: string, recurrenceDate: string) => {
    saveOverride(uid, recurrenceDate, { excluded: true });
  }, [saveOverride]);

  const openEditor = useCallback((uid: string | null, ev: CalendarEvent | null, defaultDate: string | null, recurrenceDate: string | null) => {
    const isNew = !uid;
    const masterEvent = uid ? eventsRef.current[uid] : null;

    if (isNew) {
      uid = generateUid();
      const date = defaultDate || toDateStr(new Date());
      ev = { '@type': 'Event', title: '', start: date, duration: date.includes('T') ? 'PT1H' : 'P1D', timeZone: null };
    }

    setEditorState({
      uid: uid!,
      event: ev!,
      masterEvent,
      recurrenceDate,
      isNew,
    });
  }, []);

  useEffect(() => {
    if (!editorState) broadcastRef.current?.('focusedField', null);
  }, [editorState]);

  const handleFieldFocus = useCallback((path: (string | number)[] | null) => {
    broadcastRef.current?.('focusedField', path);
  }, []);

  const peerFocusedFields = useMemo(() => {
    const result: Record<string, { color: string; peerId: string }> = {};
    if (!editorState) return result;
    for (const peer of Object.values(peerStates)) {
      const pf = peer.value.focusedField;
      if (!pf || pf.length < 3) continue;
      if (pf[0] !== 'events' || pf[1] !== editorState.uid) continue;
      const prop = pf[2] as string;
      const inputIds = PATH_PROP_TO_FIELDS[prop];
      if (inputIds) {
        const info = { color: peerColor(peer.peerId), peerId: peer.peerId };
        for (const id of inputIds) result[id] = info;
      }
    }
    return result;
  }, [peerStates, editorState]);

  useEffect(() => {
    if (!docId) return;

    let mounted = true;

    // Initialize SX calendar synchronously (will be populated by subscription)
    const now = new Date();
    const initStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const initEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0);
    currentRangeRef.current = { start: toDateStr(initStart), end: toDateStr(initEnd) };

    const calEl = document.getElementById('sx-cal')!;
    let lastRangeKey = '';
    const { calendar, eventsPlugin } = createSXCalendar(calEl, [], calTZRef.current, calColorRef.current, {
      onEventClick: (event: any) => {
        const item = eventLookupRef.current[event.id];
        if (item) openEditor(item.uid, item.ev, null, item.recurrenceDate);
      },
      onClickDate: (date: any) => {
        openEditor(null, null, date.toString(), null);
      },
      onClickDateTime: (dateTime: any) => {
        const dt = new Date(dateTime.toString().substring(0, 19));
        dt.setMinutes(Math.round(dt.getMinutes() / 30) * 30, 0, 0);
        const iso = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0')
          + 'T' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0') + ':00';
        openEditor(null, null, iso, null);
      },
      onRangeUpdate: (range: any) => {
        const start = range.start.toString().substring(0, 10);
        const end = range.end.toString().substring(0, 10);
        const key = start + ':' + end;
        if (key === lastRangeKey) return;
        lastRangeKey = key;
        currentRangeRef.current = { start, end };
        // Resubscribe if the visible range has moved outside the queried range
        if (start < queryRangeRef.current.start || end > queryRangeRef.current.end) {
          resubscribe(start, end);
        }
        refreshCalendar();
      },
    });
    calendarRef.current = calendar;
    eventsPluginRef.current = eventsPlugin;

    initDragDrop(
      calEl,
      () => eventLookupRef.current,
      () => eventsRef.current,
      (uid, data) => {
        if (!canEditRef.current) return;
        updateDoc(docId, (d, deepAssign, uid, data) => {
          if (!d.events[uid]) d.events[uid] = data;
          else deepAssign(d.events[uid], data);
        }, deepAssign, uid, data);
      },
      (uid, recDate, data) => {
        if (!canEditRef.current) return;
        updateDoc(docId, (d, deepAssign, uid, recDate, data) => {
          if (!d.events[uid].recurrenceOverrides) d.events[uid].recurrenceOverrides = {};
          if (!d.events[uid].recurrenceOverrides[recDate]) d.events[uid].recurrenceOverrides[recDate] = data;
          else deepAssign(d.events[uid].recurrenceOverrides[recDate], data);
        }, deepAssign, uid, recDate, data);
      },
      refreshCalendar,
    );

    const { broadcast, cleanup: presenceCleanup } = initPresence<PresenceState>(
      docId,
      () => ({ viewing: true, focusedField: null }),
      (states) => { if (mounted) setPeerStates(states); },
    );
    broadcastRef.current = broadcast;
    presenceCleanupRef.current = presenceCleanup;

    const onQueryResult = (result: any, heads: string[]) => {
      if (!mounted || !result) return;
      eventsRef.current = result.events || {};
      if (result.timeZone) calTZRef.current = result.timeZone;
      if (result.color && result.color !== calColorRef.current) {
        calColorRef.current = result.color;
        setCalColor(result.color);
        document.documentElement.style.setProperty('--cal-color', result.color);
      }
      if (result.name && !titleFocusedRef.current) {
        setCalName(result.name);
        document.title = result.name + ' - Calendar';
      }
      if (!descFocusedRef.current) setCalDesc(result.description || '');
      history.onNewHeads(heads);
      refreshCalendar();

      const es = editorStateRef.current;
      if (es && !es.isNew) {
        const fresh = eventsRef.current[es.uid];
        if (fresh) {
          setEditorState(prev => {
            if (!prev || prev.uid !== es.uid) return prev;
            if (prev.recurrenceDate) return { ...prev, masterEvent: fresh };
            return { ...prev, event: fresh, masterEvent: fresh };
          });
        } else {
          setEditorState(null);
        }
      }
    };

    function resubscribe(visibleStart: string, visibleEnd: string) {
      unsubQueryRef.current?.();
      const expanded = expandRange(visibleStart, visibleEnd);
      queryRangeRef.current = expanded;
      unsubQueryRef.current = subscribeQuery(docId, calendarQuery(expanded.start, expanded.end), onQueryResult);
    }

    // Initial subscription with the initial range
    const initRange = currentRangeRef.current;
    resubscribe(initRange.start, initRange.end);

    return () => {
      mounted = false;
      calendarRef.current?.destroy();
      calendarRef.current = null;
      presenceCleanupRef.current?.();
      broadcastRef.current = null;
      presenceCleanupRef.current = null;
      unsubQueryRef.current?.();
      unsubQueryRef.current = null;
    };
  }, [docId, openEditor, refreshCalendar]);

  const peerList = Object.values(peerStates).filter(p => p.value.viewing);

  return (
    <div className="calendar-page">
      <EditorTitleBar
        icon="date_range"
        title={calName}
        titleEditable={canEdit}
        onTitleFocus={() => { titleFocusedRef.current = true; }}
        onTitleChange={setCalName}
        onTitleBlur={(value) => {
          titleFocusedRef.current = false;
          if (!docId || !canEdit) return;
          const name = value.trim() || 'Calendar';
          setCalName(name);
          updateDoc(docId, (d, name) => { d.name = name; }, name);
          document.title = name + ' - Calendar';
        }}
        docId={docId}
        peers={peerList}
        peerTitle={(peer) => `Peer ${peer.peerId.slice(0, 8)}${peer.value.focusedField ? ' (editing)' : ''}`}
        onToggleHistory={history.toggleHistory}
        historyActive={history.active}
        khDocId={getDocEntry(docId)?.khDocId}
        docType="Calendar"
        sharingGroupId={getDocEntry(docId)?.sharingGroupId}
        onSharingEnabled={(khDocId, groupId) => updateDocCache(docId, { khDocId, sharingGroupId: groupId })}
      >
        <input
          type="color"
          value={calColor}
          title="Calendar color"
          style={{ width: 28, height: 28, padding: 0, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none' }}
          onInput={(e: any) => {
            const color = e.currentTarget.value;
            setCalColor(color);
            calColorRef.current = color;
            document.documentElement.style.setProperty('--cal-color', color);
            refreshCalendar();
          }}
          disabled={!canEdit}
          onChange={(e: any) => {
            if (!canEdit || !docId) return;
            const color = e.currentTarget.value;
            updateDoc(docId, (d, color) => { d.color = color; }, color);
          }}
        />
      </EditorTitleBar>
      <HistorySlider history={history} />
      <input
        className="border-0 bg-transparent text-sm text-muted-foreground outline-none w-full"
        placeholder="Add a description..."
        value={calDesc}
        onFocus={() => { descFocusedRef.current = true; }}
        onInput={(e: any) => setCalDesc(e.currentTarget.value)}
        readOnly={!canEdit}
        onBlur={(e: any) => {
          descFocusedRef.current = false;
          if (!canEdit || !docId) return;
          const desc = e.currentTarget.value.trim();
          setCalDesc(desc);
          updateDoc(docId, (d, desc) => { d.description = desc || undefined; }, desc);
        }}
        onKeyDown={(e: any) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      <ValidationPanel errors={validationErrors} docId={docId} />
      <div id="sx-cal" />
      <EventEditor
        uid={editorState?.uid || ''}
        event={editorState?.event || { '@type': 'Event', title: '', start: '', duration: 'PT1H', timeZone: null }}
        masterEvent={editorState?.masterEvent || null}
        recurrenceDate={editorState?.recurrenceDate || null}
        isNew={editorState?.isNew || false}
        opened={!!editorState}
        onSave={saveEvent}
        onSaveOverride={saveOverride}
        onDelete={deleteEvent}
        onDeleteOccurrence={deleteOccurrence}
        onClose={() => setEditorState(null)}
        onEditAll={(uid) => {
          const master = eventsRef.current[uid];
          if (master) openEditor(uid, master, null, null);
        }}
        onFieldFocus={handleFieldFocus}
        peerFocusedFields={peerFocusedFields}
      />
    </div>
  );
}
