import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import '@schedule-x/theme-default/dist/index.css';
import './calendar.css';
import { repo } from '../../shared/automerge';
import type { DocHandle, PeerState, Presence } from '../../shared/automerge';
import { peerColor, initPresence, PresenceBar, type PresenceState } from '../../shared/presence';
import { deepAssign } from '../../shared/deep-assign';
import type { CalendarDocument, CalendarEvent } from './schema';
import { toDateStr } from './recurrence';
import { mapMultiCalToSXEvents, createMultiCalSXCalendar } from './schedule-x';
import type { MultiCalEventLookupMap, CalendarSource } from './schedule-x';
import { initDragDrop } from './drag-drop';
import { EventEditor } from './EventEditor';
import { CalendarSettings } from './CalendarSettings';

interface LoadedCalendar {
  docId: string;
  handle: DocHandle<CalendarDocument>;
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
  try { return JSON.parse(localStorage.getItem('automerge-doc-ids') || '[]'); } catch { return []; }
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
  const eventsPluginRef = useRef<any>(null);
  const calendarSXRef = useRef<any>(null);
  const editorStateRef = useRef(editorState);
  editorStateRef.current = editorState;
  const presenceMapRef = useRef<Map<string, { presence: Presence<PresenceState, CalendarDocument>; cleanup: () => void }>>(new Map());

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
    const cal = findCalendar(calDocId);
    if (!cal) return;
    cal.handle.change((d: any) => {
      if (!d.events[uid]) {
        const clean: any = {};
        for (const key in eventData) {
          if ((eventData as any)[key] !== undefined) clean[key] = (eventData as any)[key];
        }
        d.events[uid] = clean;
      } else {
        deepAssign(d.events[uid], eventData);
      }
    });
    cal.events = cal.handle.doc()?.events || {};
    setEditorState(null);
    refreshCalendar();
  }, [findCalendar, refreshCalendar]);

  const saveOverride = useCallback((uid: string, recurrenceDate: string, overrideData: any, calDocId: string) => {
    const cal = findCalendar(calDocId);
    if (!cal) return;
    cal.handle.change((d: any) => {
      if (!d.events[uid].recurrenceOverrides) d.events[uid].recurrenceOverrides = {};
      if (!d.events[uid].recurrenceOverrides[recurrenceDate]) {
        d.events[uid].recurrenceOverrides[recurrenceDate] = overrideData;
      } else {
        deepAssign(d.events[uid].recurrenceOverrides[recurrenceDate], overrideData);
      }
    });
    cal.events = cal.handle.doc()?.events || {};
    setEditorState(null);
    refreshCalendar();
  }, [findCalendar, refreshCalendar]);

  const deleteEvent = useCallback((uid: string) => {
    const es = editorStateRef.current;
    if (!es) return;
    const cal = findCalendar(es.calDocId);
    if (!cal) return;
    cal.handle.change((d: any) => { delete d.events[uid]; });
    cal.events = cal.handle.doc()?.events || {};
    setEditorState(null);
    refreshCalendar();
  }, [findCalendar, refreshCalendar]);

  const deleteOccurrence = useCallback((uid: string, recurrenceDate: string) => {
    const es = editorStateRef.current;
    if (!es) return;
    saveOverride(uid, recurrenceDate, { excluded: true }, es.calDocId);
  }, [saveOverride]);

  const moveEvent = useCallback((uid: string, eventData: CalendarEvent, targetDocId: string) => {
    const es = editorStateRef.current;
    if (!es) return;
    const sourceCal = findCalendar(es.calDocId);
    const targetCal = findCalendar(targetDocId);
    if (!sourceCal || !targetCal) return;

    // Delete from source
    sourceCal.handle.change((d: any) => { delete d.events[uid]; });
    sourceCal.events = sourceCal.handle.doc()?.events || {};

    // Create in target with same UID
    targetCal.handle.change((d: any) => {
      const clean: any = {};
      for (const key in eventData) {
        if ((eventData as any)[key] !== undefined) clean[key] = (eventData as any)[key];
      }
      d.events[uid] = clean;
    });
    targetCal.events = targetCal.handle.doc()?.events || {};

    setEditorState(null);
    refreshCalendar();
  }, [findCalendar, refreshCalendar]);

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
      ev = { '@type': 'Event', title: '', start: (defaultDate || toDateStr(new Date())) + 'T09:00:00', duration: 'PT1H', timeZone: null };
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
      for (const { presence } of presenceMapRef.current.values()) {
        if (presence.running) presence.broadcast('focusedField', null);
      }
    }
  }, [editorState]);

  const handleFieldFocus = useCallback((path: (string | number)[] | null) => {
    const es = editorStateRef.current;
    if (!es) return;
    const entry = presenceMapRef.current.get(es.calDocId);
    if (entry?.presence?.running) entry.presence.broadcast('focusedField', path);
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

    (async () => {
      const savedIds = getSavedIds();
      let serverIds: string[] = [];
      try {
        const res = await fetch('/api/docs');
        const list: { documentId: string }[] = await res.json();
        serverIds = list.map(d => d.documentId);
      } catch {}
      const allIds = [...new Set([...savedIds, ...serverIds])];

      const loaded: LoadedCalendar[] = [];
      await Promise.all(allIds.map(async (id) => {
        try {
          const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000));
          const handle = await Promise.race([repo.find<CalendarDocument>(id as any), timeout]);
          const doc = handle.doc();
          if (!doc || doc['@type'] !== 'Calendar') return;
          if (!mounted) return;
          loaded.push({
            docId: id,
            handle,
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
      const allPeerStates: Record<string, PeerState<PresenceState>> = {};
      for (const cal of loaded) {
        const { presence, cleanup } = initPresence<PresenceState>(
          cal.handle,
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
        presenceMapRef.current.set(cal.docId, { presence, cleanup });
      }

      // Initialize schedule-x calendar
      const now = new Date();
      const initStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const initEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0);
      currentRangeRef.current = { start: toDateStr(initStart), end: toDateStr(initEnd) };

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
          const firstDocId = calendarsRef.current[0]?.docId;
          if (firstDocId) openEditor(null, null, dateTime.toPlainDate().toString(), null, firstDocId);
        },
        onRangeUpdate: (range: any) => {
          const start = range.start.toString().substring(0, 10);
          const end = range.end.toString().substring(0, 10);
          const key = start + ':' + end;
          if (key === lastRangeKey) return;
          lastRangeKey = key;
          currentRangeRef.current = { start, end };
          refreshCalendar();
        },
      });
      calendarSXRef.current = calendar;
      eventsPluginRef.current = eventsPlugin;

      // Subscribe to changes on each calendar
      for (const cal of loaded) {
        cal.handle.on('change', () => {
          const d = cal.handle.doc();
          if (!d) return;
          cal.events = d.events || {};
          cal.name = d.name || 'Untitled';
          cal.color = d.color || '#039be5';
          cal.description = d.description || '';

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
        });
      }

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
          const cal = findCalendar(item.calDocId);
          if (!cal) return;
          cal.handle.change((dd: any) => {
            if (!dd.events[uid]) dd.events[uid] = data;
            else deepAssign(dd.events[uid], data);
          });
          cal.events = cal.handle.doc()?.events || {};
        },
        (uid, recDate, data, eventId) => {
          const item = eventLookupRef.current[eventId];
          if (!item) return;
          const cal = findCalendar(item.calDocId);
          if (!cal) return;
          cal.handle.change((dd: any) => {
            if (!dd.events[uid].recurrenceOverrides) dd.events[uid].recurrenceOverrides = {};
            if (!dd.events[uid].recurrenceOverrides[recDate]) dd.events[uid].recurrenceOverrides[recDate] = data;
            else deepAssign(dd.events[uid].recurrenceOverrides[recDate], data);
          });
          cal.events = cal.handle.doc()?.events || {};
        },
        refreshCalendar
      );
    })();

    return () => {
      mounted = false;
      calendarSXRef.current?.destroy();
      calendarSXRef.current = null;
      for (const { cleanup } of presenceMapRef.current.values()) cleanup();
      presenceMapRef.current.clear();
    };
  }, [openEditor, refreshCalendar, findCalendar]);

  const peerList = useMemo(() => {
    // Deduplicate peers across calendars by peerId
    const seen = new Map<string, PeerState<PresenceState>>();
    for (const peer of Object.values(peerStates)) {
      const existing = seen.get(peer.peerId);
      if (!existing || peer.value.focusedField) {
        seen.set(peer.peerId, peer);
      }
    }
    return [...seen.values()].filter(p => p.value.viewing);
  }, [peerStates]);

  const settingsCal = settingsDocId ? findCalendar(settingsDocId) : null;

  return (
    <>
      <div className="flex items-center gap-1 mb-1">
        <a href="#/" className="inline-flex items-center justify-center h-10 w-10 rounded-md hover:bg-accent hover:text-accent-foreground">
          <span className="material-symbols-outlined">arrow_back</span>
        </a>
        <h1 className="text-xl font-bold flex-1">All Calendars</h1>
      </div>
      <div className="flex items-center gap-2 mb-1 flex-wrap">
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
      <PresenceBar
        peers={peerList}
        peerTitle={(peer) => `Peer ${peer.peerId.slice(0, 8)}${peer.value.focusedField ? ' (editing)' : ''}`}
      />
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
        handle={settingsCal?.handle || null}
        name={settingsCal?.name || ''}
        description={settingsCal?.description || ''}
        color={settingsCal?.color || '#039be5'}
        onClose={() => setSettingsDocId(null)}
      />
    </>
  );
}
