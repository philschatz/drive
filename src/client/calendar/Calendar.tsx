import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import '@schedule-x/theme-default/dist/index.css';
import './calendar.css';
import { findDocWithProgress } from '../../shared/automerge';
import type { DocHandle, PeerState, Presence } from '../../shared/automerge';
import { peerColor, initPresence, PresenceBar, type PresenceState } from '../../shared/presence';
import { deepAssign } from '../../shared/deep-assign';
import type { CalendarDocument, CalendarEvent } from './schema';
import { rebuildExpanded, toDateStr } from './recurrence';
import { mapToSXEvents, createSXCalendar } from './schedule-x';
import type { EventLookupMap } from './schedule-x';
import { initDragDrop } from './drag-drop';
import { EventEditor } from './EventEditor';
import { useDocumentValidation } from '../../shared/useDocumentValidation';
import { ValidationPanel } from '../../shared/ValidationPanel';
import { Progress } from '@/components/ui/progress';
import { addDocId } from '@/doc-storage';


interface EditorState {
  uid: string;
  event: CalendarEvent;
  masterEvent: CalendarEvent | null;
  recurrenceDate: string | null;
  isNew: boolean;
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

export function Calendar({ docId }: { docId?: string; path?: string }) {
  const [status, setStatus] = useState('Loading calendar...');
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [calName, setCalName] = useState('Calendar');
  const [calDesc, setCalDesc] = useState('');
  const [calColor, setCalColor] = useState('#039be5');
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [peerStates, setPeerStates] = useState<Record<string, PeerState<PresenceState>>>({});

  const [validationHandle, setValidationHandle] = useState<DocHandle<CalendarDocument> | null>(null);
  const validationErrors = useDocumentValidation(validationHandle);
  const handleRef = useRef<DocHandle<CalendarDocument> | null>(null);
  const eventsRef = useRef<Record<string, CalendarEvent>>({});
  const eventLookupRef = useRef<EventLookupMap>({});
  const currentRangeRef = useRef({ start: '', end: '' });
  const eventsPluginRef = useRef<any>(null);
  const calendarRef = useRef<any>(null);
  const calColorRef = useRef('#039be5');
  const calTZRef = useRef(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const presenceRef = useRef<Presence<PresenceState, CalendarDocument> | null>(null);
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
    const handle = handleRef.current;
    if (!handle) return;
    handle.change((d: any) => {
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
    eventsRef.current = handle.doc()?.events || {};
    setEditorState(null);
    refreshCalendar();
  }, [refreshCalendar]);

  const saveOverride = useCallback((uid: string, recurrenceDate: string, overrideData: any) => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.change((d: any) => {
      if (!d.events[uid].recurrenceOverrides) d.events[uid].recurrenceOverrides = {};
      if (!d.events[uid].recurrenceOverrides[recurrenceDate]) {
        d.events[uid].recurrenceOverrides[recurrenceDate] = overrideData;
      } else {
        deepAssign(d.events[uid].recurrenceOverrides[recurrenceDate], overrideData);
      }
    });
    eventsRef.current = handle.doc()?.events || {};
    setEditorState(null);
    refreshCalendar();
  }, [refreshCalendar]);

  const deleteEvent = useCallback((uid: string) => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.change((d: any) => { delete d.events[uid]; });
    eventsRef.current = handle.doc()?.events || {};
    setEditorState(null);
    refreshCalendar();
  }, [refreshCalendar]);

  const deleteOccurrence = useCallback((uid: string, recurrenceDate: string) => {
    saveOverride(uid, recurrenceDate, { excluded: true });
  }, [saveOverride]);

  const openEditor = useCallback((uid: string | null, ev: CalendarEvent | null, defaultDate: string | null, recurrenceDate: string | null) => {
    const isNew = !uid;
    const masterEvent = uid ? eventsRef.current[uid] : null;

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
    });
  }, []);

  useEffect(() => {
    const p = presenceRef.current;
    if (!p || !p.running) return;
    if (!editorState) {
      p.broadcast('focusedField', null);
    }
  }, [editorState]);

  const handleFieldFocus = useCallback((path: (string | number)[] | null) => {
    const p = presenceRef.current;
    if (!p || !p.running) return;
    p.broadcast('focusedField', path);
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

  useEffect(() => {
    if (!docId) {
      setStatus('No document ID. Go to the home page to select a calendar.');
      return;
    }

    let mounted = true;

    (async () => {
      setLoadProgress(0);
      const handle = await findDocWithProgress<CalendarDocument>(docId, setLoadProgress);
      const doc = handle.doc();
      if (!mounted) return;
      if (!doc) { setStatus('Document not found. Check the URL.'); return; }

      addDocId(docId, { type: 'Calendar', name: doc.name });
      handleRef.current = handle;
      setValidationHandle(handle);
      eventsRef.current = doc.events || {};
      if (doc.timeZone) calTZRef.current = doc.timeZone;
      if (doc.color) {
        calColorRef.current = doc.color;
        setCalColor(doc.color);
        document.documentElement.style.setProperty('--cal-color', doc.color);
      }
      if (doc.name) setCalName(doc.name);
      if (doc.description) setCalDesc(doc.description);
      document.title = (doc.name || 'Calendar') + ' - Calendar';
      setStatus('');

      const { presence, cleanup: presenceCleanup } = initPresence<PresenceState>(
        handle,
        () => ({ viewing: true, focusedField: null }),
        (states) => { if (mounted) setPeerStates(states); },
      );
      presenceRef.current = presence;
      presenceCleanupRef.current = presenceCleanup;

      const now = new Date();
      const initStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const initEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0);
      currentRangeRef.current = { start: toDateStr(initStart), end: toDateStr(initEnd) };

      const expanded = rebuildExpanded(eventsRef.current, currentRangeRef.current.start, currentRangeRef.current.end);
      const { sxEvents, eventLookup } = mapToSXEvents(expanded, calTZRef.current, calColorRef.current);
      eventLookupRef.current = eventLookup;

      let lastRangeKey = '';
      const calEl = document.getElementById('sx-cal')!;
      const { calendar, eventsPlugin } = createSXCalendar(calEl, sxEvents, calTZRef.current, calColorRef.current, {
        onEventClick: (event: any) => {
          const item = eventLookupRef.current[event.id];
          if (item) openEditor(item.uid, item.ev, null, item.recurrenceDate);
        },
        onClickDate: (date: any) => {
          openEditor(null, null, date.toString(), null);
        },
        onClickDateTime: (dateTime: any) => {
          openEditor(null, null, dateTime.toPlainDate().toString(), null);
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
      calendarRef.current = calendar;
      eventsPluginRef.current = eventsPlugin;

      handle.on('change', () => {
        const d = handle.doc();
        if (!d) return;
        eventsRef.current = d.events || {};
        if (d.name && !titleFocusedRef.current) {
          setCalName(d.name);
          document.title = d.name + ' - Calendar';
        }
        if (!descFocusedRef.current) setCalDesc(d.description || '');
        if (d.color && d.color !== calColorRef.current) {
          calColorRef.current = d.color;
          setCalColor(d.color);
          document.documentElement.style.setProperty('--cal-color', d.color);
        }

        const es = editorStateRef.current;
        if (es && !es.isNew) {
          const fresh = eventsRef.current[es.uid];
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

      initDragDrop(
        calEl,
        () => eventLookupRef.current,
        () => eventsRef.current,
        (uid, data) => {
          handle.change((dd: any) => {
            if (!dd.events[uid]) dd.events[uid] = data;
            else deepAssign(dd.events[uid], data);
          });
          eventsRef.current = handle.doc()?.events || {};
        },
        (uid, recDate, data) => {
          handle.change((dd: any) => {
            if (!dd.events[uid].recurrenceOverrides) dd.events[uid].recurrenceOverrides = {};
            if (!dd.events[uid].recurrenceOverrides[recDate]) dd.events[uid].recurrenceOverrides[recDate] = data;
            else deepAssign(dd.events[uid].recurrenceOverrides[recDate], data);
          });
          eventsRef.current = handle.doc()?.events || {};
        },
        refreshCalendar
      );
    })().catch((err) => {
      if (!mounted) return;
      const msg = err?.message || 'Failed to load document';
      setStatus(msg);
      setLoadProgress(null);
      alert(`Document unavailable: ${msg}`);
    });

    return () => {
      mounted = false;
      setValidationHandle(null);
      calendarRef.current?.destroy();
      calendarRef.current = null;
      presenceCleanupRef.current?.();
      presenceRef.current = null;
      presenceCleanupRef.current = null;
    };
  }, [docId, openEditor, refreshCalendar]);

  const peerList = Object.values(peerStates).filter(p => p.value.viewing);

  return (
    <>
      <div className="flex items-center gap-1 mb-1">
        <a href="#/" className="inline-flex items-center justify-center h-10 w-10 rounded-md hover:bg-accent hover:text-accent-foreground">
          <span className="material-symbols-outlined">arrow_back</span>
        </a>
        <a href={`#/source/${docId}`} className="inline-flex items-center justify-center h-10 w-10 rounded-md hover:bg-accent hover:text-accent-foreground" title="View Source">
          <span className="material-symbols-outlined">code</span>
        </a>
        <input
          className="border-0 bg-transparent text-xl font-bold outline-none flex-1"
          value={calName}
          onFocus={() => { titleFocusedRef.current = true; }}
          onInput={(e: any) => setCalName(e.currentTarget.value)}
          onBlur={(e: any) => {
            titleFocusedRef.current = false;
            const name = e.currentTarget.value.trim() || 'Calendar';
            setCalName(name);
            const handle = handleRef.current;
            if (handle) {
              handle.change((d: any) => { d.name = name; });
              document.title = name + ' - Calendar';
            }
          }}
          onKeyDown={(e: any) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
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
          onChange={(e: any) => {
            const color = e.currentTarget.value;
            const handle = handleRef.current;
            if (handle) {
              handle.change((d: any) => { d.color = color; });
            }
          }}
        />
      </div>
      <input
        className="border-0 bg-transparent text-sm text-muted-foreground outline-none w-full"
        placeholder="Add a description..."
        value={calDesc}
        onFocus={() => { descFocusedRef.current = true; }}
        onInput={(e: any) => setCalDesc(e.currentTarget.value)}
        onBlur={(e: any) => {
          descFocusedRef.current = false;
          const desc = e.currentTarget.value.trim();
          setCalDesc(desc);
          const handle = handleRef.current;
          if (handle) {
            handle.change((d: any) => { d.description = desc || undefined; });
          }
        }}
        onKeyDown={(e: any) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      <PresenceBar
        peers={peerList}
        peerTitle={(peer) => `Peer ${peer.peerId.slice(0, 8)}${peer.value.focusedField ? ' (editing)' : ''}`}
      />
      <ValidationPanel errors={validationErrors} docId={docId} />
      {loadProgress !== null && (
        <Progress className="my-1" value={loadProgress} />
      )}
      {status && <p className="text-sm text-muted-foreground my-1">{status}</p>}
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
    </>
  );
}
