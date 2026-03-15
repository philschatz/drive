import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import '@schedule-x/theme-default/dist/index.css';
import './calendar.css';
import type { PeerState } from '../../shared/automerge';
import { openDoc, subscribeQuery, updateDoc, queryDoc } from '../worker-api';
import { getDocEntry } from '../doc-storage';
import { peerColor, initPresence, type PresenceState } from '../../shared/presence';
import { EditorTitleBar } from '../../shared/EditorTitleBar';
import { deepAssign } from '../../shared/deep-assign';
import type { CalendarDocument, CalendarEvent } from './schema';
import { toDateStr } from './recurrence';
import { mapMultiCalToSXEvents, createMultiCalSXCalendar } from './schedule-x';
import type { MultiCalEventLookupMap, CalendarSource } from './schedule-x';
import { initDragDrop } from './drag-drop';
import { EventEditor } from './EventEditor';
import { CalendarSettings } from './CalendarSettings';

import { calendarQuery, expandRange } from './calendar-query';

interface LoadedCalendar {
  docId: string;
  name: string;
  color: string;
  description: string;
  timeZone: string;
  events: Record<string, CalendarEvent>;
}

interface EditorState {
  uid: string;
  event: CalendarEvent;
  masterEvent: CalendarEvent | null;
  recurrenceDate: string | null;
  isNew: boolean;
  calDocId: string;
}

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

function getSavedIds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem('automerge-doc-ids') || '[]');
    if (!Array.isArray(raw)) return [];
    // Handle both legacy string[] and new DocEntry[] formats
    return raw.map((entry: any) => typeof entry === 'string' ? entry : entry.id).filter(Boolean);
  } catch { return []; }
}

const defaultTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function AllCalendars({ path }: { path?: string }) {
  const [calendars, setCalendars] = useState<LoadedCalendar[]>([]);
  const [status, setStatus] = useState('Loading calendars...');
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [settingsDocId, setSettingsDocId] = useState<string | null>(null);
  const [peerStates, setPeerStates] = useState<Record<string, PeerState<PresenceState>>>({});

  const calendarsRef = useRef<LoadedCalendar[]>([]);
  calendarsRef.current = calendars;
  const eventLookupRef = useRef<MultiCalEventLookupMap>({});
  const currentRangeRef = useRef({ start: '', end: '' });
  const queryRangeRef = useRef({ start: '', end: '' });
  const eventsPluginRef = useRef<any>(null);
  const calendarSXRef = useRef<any>(null);
  const editorStateRef = useRef(editorState);
  editorStateRef.current = editorState;
  const presenceMapRef = useRef<Map<string, { broadcast: (key: keyof PresenceState, value: any) => void; cleanup: () => void }>>(new Map());

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

  const findCalendar = useCallback((docId: string) => {
    return calendarsRef.current.find(c => c.docId === docId) || null;
  }, []);

  const saveEvent = useCallback((uid: string, eventData: CalendarEvent, calDocId: string) => {
    updateDoc(calDocId, (d: any) => {
      if (!d.events[uid]) {
        const clean: any = {};
        for (const key in eventData) {
          if ((eventData as any)[key] !== undefined) clean[key] = (eventData as any)[key];
        }
        d.events[uid] = clean;
      } else {
        deepAssign(d.events[uid], eventData);
      }
    }, { uid, eventData });
    setEditorState(null);
  }, []);

  const saveOverride = useCallback((uid: string, recurrenceDate: string, overrideData: any, calDocId: string) => {
    updateDoc(calDocId, (d: any) => {
      if (!d.events[uid].recurrenceOverrides) d.events[uid].recurrenceOverrides = {};
      if (!d.events[uid].recurrenceOverrides[recurrenceDate]) {
        d.events[uid].recurrenceOverrides[recurrenceDate] = overrideData;
      } else {
        deepAssign(d.events[uid].recurrenceOverrides[recurrenceDate], overrideData);
      }
    }, { uid, recurrenceDate, overrideData });
    setEditorState(null);
  }, []);

  const deleteEvent = useCallback((uid: string) => {
    const es = editorStateRef.current;
    if (!es) return;
    updateDoc(es.calDocId, (d: any) => { delete d.events[uid]; }, { uid });
    setEditorState(null);
  }, []);

  const deleteOccurrence = useCallback((uid: string, recurrenceDate: string) => {
    const es = editorStateRef.current;
    if (!es) return;
    saveOverride(uid, recurrenceDate, { excluded: true }, es.calDocId);
  }, [saveOverride]);

  const moveEvent = useCallback((uid: string, eventData: CalendarEvent, targetDocId: string) => {
    const es = editorStateRef.current;
    if (!es) return;

    // Delete from source
    updateDoc(es.calDocId, (d: any) => { delete d.events[uid]; }, { uid });

    // Create in target with same UID
    updateDoc(targetDocId, (d: any) => {
      const clean: any = {};
      for (const key in eventData) {
        if ((eventData as any)[key] !== undefined) clean[key] = (eventData as any)[key];
      }
      d.events[uid] = clean;
    }, { uid, eventData });

    setEditorState(null);
  }, []);

  const activeCalDocId = useMemo(() => {
    if (editorState?.calDocId) return editorState.calDocId;
    return calendars[0]?.docId || '';
  }, [editorState, calendars]);

  const openEditor = useCallback((uid: string | null, ev: CalendarEvent | null, defaultDate: string | null, recurrenceDate: string | null, calDocId: string) => {
    const isNew = !uid;
    const cal = findCalendar(calDocId);
    const masterEvent = uid && cal ? cal.events[uid] : null;

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
      calDocId,
    });
  }, [findCalendar]);

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
    const entry = presenceMapRef.current.get(es.calDocId);
    entry?.broadcast('focusedField', path);
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
        for (const id of inputIds) {
          result[id] = info;
        }
      }
    }
    return result;
  }, [peerStates, editorState]);

  const calendarListForEditor = useMemo(() => {
    return calendars.map(c => ({ docId: c.docId, name: c.name, color: c.color }));
  }, [calendars]);

  // Load all calendar documents
  useEffect(() => {
    let mounted = true;
    const unsubscribes: (() => void)[] = [];

    (async () => {
      const allIds = getSavedIds();

      // Compute initial date range for querying
      const now = new Date();
      const initStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const initEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0);
      currentRangeRef.current = { start: toDateStr(initStart), end: toDateStr(initEnd) };
      const initExpanded = expandRange(toDateStr(initStart), toDateStr(initEnd));
      queryRangeRef.current = initExpanded;
      const initQuery = calendarQuery(initExpanded.start, initExpanded.end);

      const loaded: LoadedCalendar[] = [];
      await Promise.all(allIds.map(async (id) => {
        try {
          const entry = getDocEntry(id);
          const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000));
          await Promise.race([openDoc(id, { secure: entry?.encrypted }), timeout]);
          const { result: doc } = await queryDoc(id, initQuery);
          if (!doc || doc['@type'] !== 'Calendar') return;
          if (!mounted) return;
          loaded.push({
            docId: id,
            name: doc.name || 'Untitled',
            color: doc.color || '#039be5',
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
              // Remove old states from this calendar's presence
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

      let lastRangeKey = '';
      const calEl = document.getElementById('sx-cal')!;
      const { calendar, eventsPlugin } = createMultiCalSXCalendar(calEl, sxEvents, defaultTZ, sxCalendars, {
        onEventClick: (event: any) => {
          const item = eventLookupRef.current[event.id];
          if (item) openEditor(item.uid, item.ev, null, item.recurrenceDate, item.calDocId);
        },
        onClickDate: (date: any) => {
          const firstDocId = calendarsRef.current[0]?.docId;
          if (firstDocId) openEditor(null, null, date.toString(), null, firstDocId);
        },
        onClickDateTime: (dateTime: any) => {
          const dt = new Date(dateTime.toString().substring(0, 19));
          dt.setMinutes(Math.round(dt.getMinutes() / 30) * 30, 0, 0);
          const iso = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0')
            + 'T' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0') + ':00';
          const firstDocId = calendarsRef.current[0]?.docId;
          if (firstDocId) openEditor(null, null, iso, null, firstDocId);
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
            resubscribeAll(start, end);
          }
          refreshCalendar();
        },
      });
      calendarSXRef.current = calendar;
      eventsPluginRef.current = eventsPlugin;

      // Subscribe to changes on each calendar via worker query subscriptions
      function onCalResult(cal: LoadedCalendar, result: any) {
        if (!result || !mounted) return;
        cal.events = result.events || {};
        cal.name = result.name || 'Untitled';
        cal.color = result.color || '#039be5';
        cal.description = result.description || '';

        // Update React state for the header chips
        setCalendars(prev => prev.map(c =>
          c.docId === cal.docId ? { ...c, name: cal.name, color: cal.color, description: cal.description, events: cal.events } : c
        ));

        // Update editor state if currently editing an event from this calendar
        const es = editorStateRef.current;
        if (es && !es.isNew && es.calDocId === cal.docId) {
          const fresh = cal.events[es.uid];
          if (fresh) {
            setEditorState(prev => {
              if (!prev || prev.uid !== es.uid) return prev;
              if (prev.recurrenceDate) {
                return { ...prev, masterEvent: fresh };
              }
              return { ...prev, event: fresh, masterEvent: fresh };
            });
          } else {
            setEditorState(null);
          }
        }

        refreshCalendar();
      }

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

      resubscribeAll(toDateStr(initStart), toDateStr(initEnd));

      // Set up drag-drop
      initDragDrop(
        calEl,
        () => eventLookupRef.current,
        () => {
          // Flatten all calendar events into one map (drag-drop only uses it for lookup)
          const all: Record<string, any> = {};
          for (const c of calendarsRef.current) {
            for (const [k, v] of Object.entries(c.events)) all[k] = v;
          }
          return all;
        },
        (uid, data, eventId) => {
          const item = eventLookupRef.current[eventId];
          if (!item) return;
          updateDoc(item.calDocId, (dd: any) => {
            if (!dd.events[uid]) dd.events[uid] = data;
            else deepAssign(dd.events[uid], data);
          }, { uid, data });
        },
        (uid, recDate, data, eventId) => {
          const item = eventLookupRef.current[eventId];
          if (!item) return;
          updateDoc(item.calDocId, (dd: any) => {
            if (!dd.events[uid].recurrenceOverrides) dd.events[uid].recurrenceOverrides = {};
            if (!dd.events[uid].recurrenceOverrides[recDate]) dd.events[uid].recurrenceOverrides[recDate] = data;
            else deepAssign(dd.events[uid].recurrenceOverrides[recDate], data);
          }, { uid, recDate, data });
        },
        refreshCalendar
      );
    })();

    return () => {
      mounted = false;
      for (const unsub of unsubscribes) unsub();
      calendarSXRef.current?.destroy();
      calendarSXRef.current = null;
      for (const { cleanup } of presenceMapRef.current.values()) cleanup();
      presenceMapRef.current.clear();
    };
  }, [openEditor, refreshCalendar, findCalendar]);

  const settingsCal = settingsDocId ? findCalendar(settingsDocId) : null;

  return (
    <div className="calendar-page">
      <EditorTitleBar
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
        onSave={(uid, data) => saveEvent(uid, data, activeCalDocId)}
        onSaveOverride={(uid, recDate, patch) => saveOverride(uid, recDate, patch, activeCalDocId)}
        onDelete={deleteEvent}
        onDeleteOccurrence={deleteOccurrence}
        onClose={() => setEditorState(null)}
        onEditAll={(uid) => {
          const es = editorStateRef.current;
          if (!es) return;
          const cal = findCalendar(es.calDocId);
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
