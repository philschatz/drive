import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import '@schedule-x/theme-default/dist/index.css';
import './calendar.css';
import { subscribeQuery, updateDoc, deepAssign } from '../worker-api';
import type { PeerState } from '../shared/automerge';
import { peerDisplayName, initPresence, type PresenceState } from '../shared/presence';
import { EditorTitleBar } from '../shared/EditorTitleBar';
import { useDocumentHistory } from '../shared/useDocumentHistory';
import { useAccess } from '../shared/useAccess';
import { HistorySlider } from '../shared/HistorySlider';
import { getDocEntry } from '../doc-storage';
import type { CalendarEvent } from './schema';
import { rebuildExpanded } from './recurrence';
import { mapToSXEvents, createSXCalendar } from './schedule-x';
import type { EventLookupMap } from './schedule-x';
import { initDragDrop } from './drag-drop';
import { EventEditor } from './EventEditor';
import { useDocumentValidation } from '../shared/useDocumentValidation';
import { ValidationPanel } from '../shared/ValidationPanel';
import { DocLoader } from '../shared/useDocument';
import { calendarQuery, expandRange } from './calendar-query';
import { useCalendarEditor } from './useCalendarEditor';
import { useEventMutations } from './useEventMutations';
import { usePeerFocusedFields } from './usePeerFocusedFields';
import { getInitialDateRange, makeSXCallbacks } from './calendar-utils';

export function Calendar({ docId, rest, readOnly }: { docId?: string; rest?: string; readOnly?: boolean; path?: string }) {
  const eventId = rest?.startsWith('events/') ? rest.slice(7).split('/')[0] : undefined;
  return (
    <DocLoader docId={docId}>
      <CalendarInner docId={docId!} readOnly={readOnly} initialEventId={eventId} />
    </DocLoader>
  );
}

function CalendarInner({ docId, readOnly, initialEventId }: { docId: string; readOnly?: boolean; initialEventId?: string }) {
  const [calName, setCalName] = useState('Calendar');
  const [calDesc, setCalDesc] = useState('');
  const [calColor, setCalColor] = useState('#039be5');
  const [peerStates, setPeerStates] = useState<Record<string, PeerState<PresenceState>>>({});
  const [showValidation, setShowValidation] = useState(false);
  const history = useDocumentHistory(docId);
  const validationErrors = useDocumentValidation(docId);
  const encrypted = !!getDocEntry(docId)?.encrypted;
  const { access, canEdit: accessCanEdit, loaded: accessLoaded } = useAccess(encrypted ? docId : undefined);
  const canEdit = !readOnly && history.editable && accessCanEdit;
  const noAccess = encrypted && accessLoaded && access === null;
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
  const titleFocusedRef = useRef(false);
  const descFocusedRef = useRef(false);
  const pendingEventIdRef = useRef(initialEventId);

  const getEvents = useCallback(() => eventsRef.current, []);
  const { editorState, setEditorState, openEditor, refreshEditorFromEvents } = useCalendarEditor(getEvents);
  const mutations = useEventMutations(setEditorState);
  const peerFocusedFields = usePeerFocusedFields(peerStates, editorState);

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

  useEffect(() => {
    if (!editorState) broadcastRef.current?.('focusedField', null);
    // Sync editor state to URL
    const base = window.location.href.split('#')[0];
    if (editorState) {
      window.history.replaceState(null, '', `${base}#/calendars/${docId}/events/${editorState.uid}`);
    } else {
      window.history.replaceState(null, '', `${base}#/calendars/${docId}`);
    }
  }, [editorState, docId]);

  const [focusedPath, setFocusedPath] = useState<(string | number)[] | null>(null);
  const handleFieldFocus = useCallback((path: (string | number)[] | null) => {
    broadcastRef.current?.('focusedField', path);
    setFocusedPath(path);
  }, []);

  useEffect(() => {
    if (!docId) return;

    let mounted = true;

    const initRange = getInitialDateRange();
    currentRangeRef.current = initRange;

    function resubscribe(visibleStart: string, visibleEnd: string) {
      unsubQueryRef.current?.();
      const expanded = expandRange(visibleStart, visibleEnd);
      queryRangeRef.current = expanded;
      unsubQueryRef.current = subscribeQuery(docId, calendarQuery(expanded.start, expanded.end), onQueryResult);
    }

    const calEl = document.getElementById('sx-cal')!;
    const { calendar, eventsPlugin } = createSXCalendar(calEl, [], calTZRef.current, calColorRef.current,
      makeSXCallbacks({
        eventLookupRef, openEditor, currentRangeRef, queryRangeRef,
        resubscribe, refreshCalendar,
      }),
    );
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
      refreshEditorFromEvents(eventsRef.current);
      // Auto-open event from URL on first load
      if (pendingEventIdRef.current && result.events) {
        const ev = result.events[pendingEventIdRef.current];
        if (ev) openEditor(pendingEventIdRef.current, ev, null, null);
        pendingEventIdRef.current = undefined;
      }
    };

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
  }, [docId, openEditor, refreshCalendar, refreshEditorFromEvents]);

  const peerList = Object.values(peerStates).filter(p => p.value?.viewing);

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
        peerTitle={(peer) => `${peerDisplayName(peer.peerId)}${peer.value?.focusedField ? ' (editing)' : ''}`}
        onToggleHistory={history.toggleHistory}
        historyActive={history.active}
        onToggleValidation={() => setShowValidation(v => !v)}
        validationActive={showValidation}
        validationCount={validationErrors.length}
        docType="Calendar"
        sourcePath={focusedPath || (editorState ? ['events', editorState.uid] : undefined)}
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
      <div style={noAccess ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
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
      {showValidation && <ValidationPanel errors={validationErrors} docId={docId} docType="Calendar" />}
      <div id="sx-cal" />
      <EventEditor
        uid={editorState?.uid || ''}
        event={editorState?.event || { '@type': 'Event', title: '', start: '', duration: 'PT1H', timeZone: null }}
        masterEvent={editorState?.masterEvent || null}
        recurrenceDate={editorState?.recurrenceDate || null}
        isNew={editorState?.isNew || false}
        opened={!!editorState}
        onSave={(uid, data) => {
          if (!canEditRef.current) return;
          mutations.saveEvent(uid, data, docId);
        }}
        onSaveOverride={(uid, recDate, patch) => {
          if (!canEditRef.current) return;
          mutations.saveOverride(uid, recDate, patch, docId);
        }}
        onDelete={(uid) => {
          if (!canEditRef.current) return;
          mutations.deleteEvent(uid, docId);
        }}
        onDeleteOccurrence={(uid, recDate) => {
          if (!canEditRef.current) return;
          mutations.deleteOccurrence(uid, recDate, docId);
        }}
        onClose={() => setEditorState(null)}
        onEditAll={(uid) => {
          const master = eventsRef.current[uid];
          if (master) openEditor(uid, master, null, null);
        }}
        onFieldFocus={handleFieldFocus}
        peerFocusedFields={peerFocusedFields}
      />
      </div>
    </div>
  );
}
