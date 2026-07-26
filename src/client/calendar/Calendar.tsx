import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import '@schedule-x/theme-default/dist/index.css';
import './calendar.css';
import { subscribeQuery, updateDoc, deepAssign } from '../worker-api';
import { peerDisplayName, usePresence } from '../shared/presence';
import { EditorTitleBar } from '../shared/EditorTitleBar';
import { useDocumentHistory } from '../shared/useDocumentHistory';
import { useCanEdit } from '../shared/useCanEdit';
import { replaceDocHash, encodeRestPath } from '../shared/doc-urls';
import { HistorySlider } from '../shared/HistorySlider';
import type { CalendarEvent } from './schema';
import { rebuildExpanded } from './recurrence';
import { mapToSXEvents, createSXCalendar } from './schedule-x';
import type { EventLookupMap } from './schedule-x';
import { initDragDrop } from './drag-drop';
import { EventEditor } from './EventEditor';
import { CalendarSettings } from './CalendarSettings';
import { Fab } from '@/components/ui/fab';
import { useDocumentValidation } from '../shared/useDocumentValidation';
import { ValidationPanel } from '../shared/ValidationPanel';
import { DocLoader } from '../shared/useDocument';
import { calendarQuery, expandRange } from './calendar-query';
import { useCalendarEditor } from './useCalendarEditor';
import { useEventMutations } from './useEventMutations';
import { usePeerFocusedFields } from './usePeerFocusedFields';
import { getInitialDateRange, makeSXCallbacks } from './calendar-utils';
import { HEX_COLOR_RE } from '../../shared/schemas/core';

const DEFAULT_CAL_COLOR = '#039be5';

/** A hostile document can put anything in `color`; only let valid hex reach CSS. */
function safeCalColor(color: unknown): string {
  return typeof color === 'string' && HEX_COLOR_RE.test(color) ? color : DEFAULT_CAL_COLOR;
}

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
  const [showValidation, setShowValidation] = useState(false);
  const [calSettingsOpen, setCalSettingsOpen] = useState(false);
  const history = useDocumentHistory(docId);
  // Route new heads through a ref so the (deps-stable) subscription effect always
  // calls the current onNewHeads, not the active:false version captured at mount.
  const onNewHeadsRef = useRef(history.onNewHeads);
  onNewHeadsRef.current = history.onNewHeads;
  const validationErrors = useDocumentValidation(docId);
  const { canEdit, canEditRef, noAccess } = useCanEdit(docId, readOnly, history);
  const eventsRef = useRef<Record<string, CalendarEvent>>({});
  const eventLookupRef = useRef<EventLookupMap>({});
  const currentRangeRef = useRef({ start: '', end: '' });
  const queryRangeRef = useRef({ start: '', end: '' });
  const unsubQueryRef = useRef<(() => void) | null>(null);
  const eventsPluginRef = useRef<any>(null);
  const calendarRef = useRef<any>(null);
  const calColorRef = useRef('#039be5');
  const calTZRef = useRef(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const titleFocusedRef = useRef(false);
  const pendingEventIdRef = useRef(initialEventId);

  const getEvents = useCallback(() => eventsRef.current, []);
  const { editorState, setEditorState, openEditor, refreshEditorFromEvents } = useCalendarEditor(getEvents);
  const mutations = useEventMutations(setEditorState);
  const { peers, peerList, broadcast } = usePresence(docId);
  const peerFocusedFields = usePeerFocusedFields(peers, editorState);

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

  // Automerge path to the focused field (drives presence, URL, and Edit Source link)
  const [focusedPath, setFocusedPath] = useState<(string | number)[] | null>(null);
  const focusPath: (string | number)[] | undefined = focusedPath ?? (editorState ? ['events', editorState.uid] : undefined);

  const handleFieldFocus = useCallback((path: (string | number)[] | null) => {
    setFocusedPath(path);
  }, []);

  // Sync selection → presence broadcast + URL (all derived from focusPath).
  // focusPath is rebuilt every render, so dedupe by value — otherwise every
  // render (e.g. each incoming peer-presence update) re-sends set-presence,
  // and two open editors ping-pong broadcasts at each other forever.
  const lastBroadcastRef = useRef<string | null>('');
  useEffect(() => {
    if (!editorState) setFocusedPath(null);
    const key = focusPath ? JSON.stringify(focusPath) : null;
    if (lastBroadcastRef.current === key) return;
    lastBroadcastRef.current = key;
    broadcast('focusedField', focusPath ?? null);
    replaceDocHash(docId, focusPath ? encodeRestPath(focusPath) : undefined);
  }, [editorState, focusPath, docId, broadcast]);

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

    const dragCleanup = initDragDrop(
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

    const onQueryResult = (result: any, heads: string[]) => {
      if (!mounted || !result) return;
      eventsRef.current = result.events || {};
      if (result.timeZone) calTZRef.current = result.timeZone;
      if (result.color && result.color !== calColorRef.current) {
        const color = safeCalColor(result.color);
        calColorRef.current = color;
        setCalColor(color);
        document.documentElement.style.setProperty('--cal-color', color);
      }
      if (result.name && !titleFocusedRef.current) {
        setCalName(result.name);
        document.title = result.name + ' - Calendar';
      }
      setCalDesc(result.description || '');
      onNewHeadsRef.current(heads);
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
      dragCleanup();
      calendarRef.current?.destroy();
      calendarRef.current = null;
      unsubQueryRef.current?.();
      unsubQueryRef.current = null;
    };
  }, [docId, openEditor, refreshCalendar, refreshEditorFromEvents]);

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
        peerTitle={(peer) => `${peerDisplayName(peer.peerId, peer.value?.userGroupId)}${peer.value?.focusedField ? ' (editing)' : ''}`}
        onToggleHistory={history.toggleHistory}
        historyActive={history.active}
        onUndo={canEdit ? history.undoLastChange : undefined}
        onToggleValidation={() => setShowValidation(v => !v)}
        validationActive={showValidation}
        validationCount={validationErrors.length}
        sourcePath={focusPath}
        overflow={canEdit
          ? [{ icon: 'palette', label: 'Calendar settings', onSelect: () => setCalSettingsOpen(true) }]
          : []}
      />
      <HistorySlider history={history} />
      <div style={noAccess ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
      {showValidation && <ValidationPanel errors={validationErrors} docId={docId} />}
      <div id="sx-cal" />
      {/* Name / color / description live in the Calendar-settings sheet (overflow menu). */}
      <CalendarSettings
        opened={calSettingsOpen}
        docId={docId}
        name={calName}
        description={calDesc}
        color={calColor}
        onClose={() => setCalSettingsOpen(false)}
      />
      {canEdit && (
        <Fab icon="add" aria-label="New event" onClick={() => openEditor(null, null, null, null)} />
      )}
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
