import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import '@schedule-x/theme-default/dist/index.css';
import './calendar.css';
import type { PeerState } from '../../shared/automerge';
import { openDoc, subscribeQuery, updateDoc, queryDoc, deepAssign, fetchDocList } from '../../worker-api';
import { initPresence, colorForKey, type PresenceState } from '../../shared/presence';
import { DocumentTitleBar } from '../../shared/DocumentTitleBar';
import type { CalendarEvent } from './schema';
import { mapMultiCalToSXEvents, createMultiCalSXCalendar } from './schedule-x';
import type { MultiCalEventLookupMap, CalendarSource } from './schedule-x';
import { initDragDrop } from './drag-drop';
import { EventEditor } from './EventEditor';
import { CalendarSettings } from './CalendarSettings';
import { calendarQuery, expandRange } from './calendar-query';
import { useCalendarEditor } from './useCalendarEditor';
import { useEventMutations } from './useEventMutations';
import { usePeerFocusedFields } from './usePeerFocusedFields';
import { getInitialDateRange, makeSXCallbacks } from './calendar-utils';

interface LoadedCalendar {
  docId: string;
  name: string;
  color: string;
  description: string;
  timeZone: string;
  events: Record<string, CalendarEvent>;
}

const defaultTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Doc @types the aggregate view renders. Both keep an `events` map of
 *  `@type: 'Event'` items schedule-x can lay out; counter events without a
 *  concrete `start` (recurring/time-of-day only) are skipped per-event by the
 *  schedule-x mapper rather than blanking the view. */
const CALENDARISH_TYPES = new Set(['Calendar', 'Calendar+Counters']);

export function AllCalendars({ path }: { path?: string }) {
  const [calendars, setCalendars] = useState<LoadedCalendar[]>([]);
  const [status, setStatus] = useState('Loading calendars...');
  const [settingsDocId, setSettingsDocId] = useState<string | null>(null);
  const [peerStates, setPeerStates] = useState<Record<string, PeerState<PresenceState>>>({});

  const calendarsRef = useRef<LoadedCalendar[]>([]);
  calendarsRef.current = calendars;
  const eventLookupRef = useRef<MultiCalEventLookupMap>({});
  const currentRangeRef = useRef({ start: '', end: '' });
  const queryRangeRef = useRef({ start: '', end: '' });
  const eventsPluginRef = useRef<any>(null);
  const calendarSXRef = useRef<any>(null);
  const presenceMapRef = useRef<Map<string, { broadcast: (key: keyof PresenceState, value: any) => void; cleanup: () => void }>>(new Map());

  const findCalendar = useCallback((docId: string) => {
    return calendarsRef.current.find(c => c.docId === docId) || null;
  }, []);

  const getEvents = useCallback((calDocId?: string) => {
    if (calDocId) {
      const cal = findCalendar(calDocId);
      return cal ? cal.events : {};
    }
    const all: Record<string, CalendarEvent> = {};
    for (const c of calendarsRef.current) {
      for (const [k, v] of Object.entries(c.events)) all[k] = v;
    }
    return all;
  }, [findCalendar]);

  const { editorState, setEditorState, editorStateRef, openEditor, refreshEditorFromEvents } = useCalendarEditor(getEvents);
  const mutations = useEventMutations(setEditorState);
  const peerFocusedFields = usePeerFocusedFields(peerStates, editorState);

  const refreshCalendar = useCallback(() => {
    const range = currentRangeRef.current;
    if (!range.start || !range.end) return;
    const sources: CalendarSource[] = calendarsRef.current.map(c => ({
      '@type': 'Calendar' as const,
      docId: c.docId,
      name: c.name,
      color: c.color,
      description: c.description,
      timeZone: c.timeZone,
      events: c.events,
    }));
    const { sxEvents, eventLookup, sxCalendars } = mapMultiCalToSXEvents(sources, range.start, range.end);
    eventLookupRef.current = eventLookup;
    if (eventsPluginRef.current) {
      eventsPluginRef.current.set(sxEvents);
    }
    // Update calendar color definitions dynamically
    if (calendarSXRef.current) {
      for (const [calId, calDef] of Object.entries(sxCalendars)) {
        try { calendarSXRef.current.calendarEvents.set(calId, calDef); } catch {}
      }
    }
  }, []);

  const moveEvent = useCallback((uid: string, eventData: CalendarEvent, targetDocId: string) => {
    const es = editorStateRef.current;
    if (!es) return;

    // Delete from source
    updateDoc(es.calDocId!, (d: any, uid: string) => { delete d.events[uid]; }, uid);

    // Create in target with same UID
    updateDoc(targetDocId, (d: any, uid: string, eventData: any) => {
      const clean: any = {};
      for (const key in eventData) {
        if ((eventData as any)[key] !== undefined) clean[key] = (eventData as any)[key];
      }
      d.events[uid] = clean;
    }, uid, eventData);

    setEditorState(null);
  }, [editorStateRef, setEditorState]);

  const activeCalDocId = useMemo(() => {
    if (editorState?.calDocId) return editorState.calDocId;
    return calendars[0]?.docId || '';
  }, [editorState, calendars]);

  // Broadcast presence focus field changes
  useEffect(() => {
    if (!editorState) {
      for (const { broadcast } of presenceMapRef.current.values()) {
        broadcast('focusedField', null);
      }
    }
  }, [editorState]);

  const handleFieldFocus = useCallback((path: (string | number)[] | null) => {
    const es = editorStateRef.current;
    if (!es) return;
    const entry = presenceMapRef.current.get(es.calDocId!);
    entry?.broadcast('focusedField', path);
  }, [editorStateRef]);

  const calendarListForEditor = useMemo(() => {
    return calendars.map(c => ({ docId: c.docId, name: c.name, color: c.color }));
  }, [calendars]);

  // Load all calendar documents
  useEffect(() => {
    let mounted = true;
    const unsubscribes: (() => void)[] = [];
    let dragCleanup: (() => void) | null = null;

    (async () => {
      const allIds = (await fetchDocList()).map(e => e.id);

      const initRange = getInitialDateRange();
      currentRangeRef.current = initRange;
      const initExpanded = expandRange(initRange.start, initRange.end);
      queryRangeRef.current = initExpanded;
      const initQuery = calendarQuery(initExpanded.start, initExpanded.end);

      const loaded: LoadedCalendar[] = [];
      await Promise.all(allIds.map(async (id) => {
        try {
          const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000));
          await Promise.race([openDoc(id), timeout]);
          const { result: doc } = await queryDoc(id, initQuery);
          if (!doc || !CALENDARISH_TYPES.has(doc['@type'])) return;
          if (!mounted) return;
          loaded.push({
            docId: id,
            name: doc.name || 'Untitled',
            color: doc.color || colorForKey(id),
            description: doc.description || '',
            timeZone: doc.timeZone || defaultTZ,
            events: doc.events || {},
          });
        } catch {}
      }));

      if (!mounted) return;
      if (loaded.length === 0) {
        setStatus('No calendars found. Create one from the home page.');
        return;
      }

      setCalendars(loaded);
      calendarsRef.current = loaded;
      setStatus('');
      document.title = 'All Calendars';

      // Set up presence for each calendar
      for (const cal of loaded) {
        const { broadcast, cleanup } = initPresence<PresenceState>(
          cal.docId,
          () => ({ viewing: true, focusedField: null }),
          (states) => {
            if (!mounted) return;
            // Merge peer states from all calendars
            setPeerStates(prev => {
              const next = { ...prev };
              for (const key of Object.keys(next)) {
                if (key.startsWith(cal.docId + ':')) delete next[key];
              }
              for (const [key, val] of Object.entries(states)) {
                next[cal.docId + ':' + key] = val;
              }
              return next;
            });
          },
        );
        presenceMapRef.current.set(cal.docId, { broadcast, cleanup });
      }

      // Initialize schedule-x calendar
      const sources: CalendarSource[] = loaded.map(c => ({
        '@type': 'Calendar' as const,
        docId: c.docId,
        name: c.name,
        color: c.color,
        description: c.description,
        timeZone: c.timeZone,
        events: c.events,
      }));
      const { sxEvents, eventLookup, sxCalendars } = mapMultiCalToSXEvents(sources, currentRangeRef.current.start, currentRangeRef.current.end);
      eventLookupRef.current = eventLookup;

      function resubscribeAll(visibleStart: string, visibleEnd: string) {
        for (const unsub of unsubscribes) unsub();
        unsubscribes.length = 0;
        const expanded = expandRange(visibleStart, visibleEnd);
        queryRangeRef.current = expanded;
        const query = calendarQuery(expanded.start, expanded.end);
        for (const cal of calendarsRef.current) {
          const unsub = subscribeQuery(cal.docId, query, (result) => onCalResult(cal, result));
          unsubscribes.push(unsub);
        }
      }

      const calEl = document.getElementById('sx-cal')!;
      const { calendar, eventsPlugin } = createMultiCalSXCalendar(calEl, sxEvents, defaultTZ, sxCalendars,
        makeSXCallbacks({
          eventLookupRef, openEditor, currentRangeRef, queryRangeRef,
          getDefaultCalDocId: () => calendarsRef.current[0]?.docId,
          resubscribe: resubscribeAll, refreshCalendar,
        }),
      );
      calendarSXRef.current = calendar;
      eventsPluginRef.current = eventsPlugin;

      function onCalResult(cal: LoadedCalendar, result: any) {
        if (!result || !mounted) return;
        cal.events = result.events || {};
        cal.name = result.name || 'Untitled';
        cal.color = result.color || colorForKey(cal.docId);
        cal.description = result.description || '';

        setCalendars(prev => prev.map(c =>
          c.docId === cal.docId ? { ...c, name: cal.name, color: cal.color, description: cal.description, events: cal.events } : c
        ));

        refreshEditorFromEvents(cal.events, cal.docId);
        refreshCalendar();
      }

      resubscribeAll(initRange.start, initRange.end);

      // Set up drag-drop
      dragCleanup = initDragDrop(
        calEl,
        () => eventLookupRef.current,
        () => {
          const all: Record<string, any> = {};
          for (const c of calendarsRef.current) {
            for (const [k, v] of Object.entries(c.events)) all[k] = v;
          }
          return all;
        },
        (uid, data, eventId) => {
          const item = eventLookupRef.current[eventId];
          if (!item) return;
          updateDoc(item.calDocId, (dd: any, deepAssign: any, uid: string, data: any) => {
            if (!dd.events[uid]) dd.events[uid] = data;
            else deepAssign(dd.events[uid], data);
          }, deepAssign, uid, data);
        },
        (uid, recDate, data, eventId) => {
          const item = eventLookupRef.current[eventId];
          if (!item) return;
          updateDoc(item.calDocId, (dd: any, deepAssign: any, uid: string, recDate: string, data: any) => {
            if (!dd.events[uid].recurrenceOverrides) dd.events[uid].recurrenceOverrides = {};
            if (!dd.events[uid].recurrenceOverrides[recDate]) dd.events[uid].recurrenceOverrides[recDate] = data;
            else deepAssign(dd.events[uid].recurrenceOverrides[recDate], data);
          }, deepAssign, uid, recDate, data);
        },
        refreshCalendar
      );
    })();

    return () => {
      mounted = false;
      dragCleanup?.();
      for (const unsub of unsubscribes) unsub();
      calendarSXRef.current?.destroy();
      calendarSXRef.current = null;
      for (const { cleanup } of presenceMapRef.current.values()) cleanup();
      presenceMapRef.current.clear();
    };
  }, [openEditor, refreshCalendar, findCalendar, refreshEditorFromEvents]);

  const settingsCal = settingsDocId ? findCalendar(settingsDocId) : null;

  return (
    <div className="calendar-page">
      <DocumentTitleBar
        icon="calendar_month"
        title="All Calendars"
        showSourceLink={false}
      />
      <div className="flex items-center gap-2 mb-1 flex-wrap px-1">
        {calendars.map(c => (
          <button
            key={c.docId}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-sm border border-border hover:bg-accent"
            onClick={() => setSettingsDocId(c.docId)}
          >
            <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
            {c.name || 'Untitled'}
          </button>
        ))}
      </div>
      {status && <p className="text-sm text-muted-foreground my-1">{status}</p>}
      <div id="sx-cal" />
      <EventEditor
        uid={editorState?.uid || ''}
        event={editorState?.event || { '@type': 'Event', title: '', start: '', duration: 'PT1H', timeZone: null }}
        masterEvent={editorState?.masterEvent || null}
        recurrenceDate={editorState?.recurrenceDate || null}
        isNew={editorState?.isNew || false}
        opened={!!editorState}
        onSave={(uid, data) => mutations.saveEvent(uid, data, activeCalDocId)}
        onSaveOverride={(uid, recDate, patch) => mutations.saveOverride(uid, recDate, patch, activeCalDocId)}
        onDelete={(uid) => mutations.deleteEvent(uid, activeCalDocId)}
        onDeleteOccurrence={(uid, recDate) => mutations.deleteOccurrence(uid, recDate, activeCalDocId)}
        onClose={() => setEditorState(null)}
        onEditAll={(uid) => {
          const es = editorStateRef.current;
          if (!es) return;
          const cal = findCalendar(es.calDocId!);
          if (!cal) return;
          const master = cal.events[uid];
          if (master) openEditor(uid, master, null, null, es.calDocId);
        }}
        onFieldFocus={handleFieldFocus}
        peerFocusedFields={peerFocusedFields}
        calendars={calendarListForEditor}
        calDocId={activeCalDocId}
        onMoveToCalendar={moveEvent}
      />
      <CalendarSettings
        opened={!!settingsDocId}
        docId={settingsDocId}
        name={settingsCal?.name || ''}
        description={settingsCal?.description || ''}
        color={settingsCal?.color || '#039be5'}
        onClose={() => setSettingsDocId(null)}
      />
    </div>
  );
}
