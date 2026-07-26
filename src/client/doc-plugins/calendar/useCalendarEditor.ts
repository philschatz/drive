import { useState, useCallback, useRef } from 'preact/hooks';
import type { CalendarEvent } from './schema';
import { generateUid, type EditorState } from './calendar-utils';
import { toDateStr } from './recurrence';

export function useCalendarEditor(
  getEvents: (calDocId?: string) => Record<string, CalendarEvent>,
) {
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const editorStateRef = useRef(editorState);
  editorStateRef.current = editorState;

  const openEditor = useCallback((
    uid: string | null,
    ev: CalendarEvent | null,
    defaultDate: string | null,
    recurrenceDate: string | null,
    calDocId?: string,
  ) => {
    const isNew = !uid;
    const events = getEvents(calDocId);
    const masterEvent = uid ? events[uid] : null;

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
  }, [getEvents]);

  /**
   * Sync editor state when fresh event data arrives from a query subscription.
   * Call with the updated events map; optionally pass calDocId to only refresh
   * if the editor is currently editing an event from that specific calendar.
   */
  const refreshEditorFromEvents = useCallback((events: Record<string, CalendarEvent>, calDocId?: string) => {
    const es = editorStateRef.current;
    if (!es || es.isNew) return;
    if (calDocId !== undefined && es.calDocId !== calDocId) return;
    const fresh = events[es.uid];
    if (fresh) {
      setEditorState(prev => {
        if (!prev || prev.uid !== es.uid) return prev;
        if (prev.recurrenceDate) return { ...prev, masterEvent: fresh };
        return { ...prev, event: fresh, masterEvent: fresh };
      });
    } else {
      setEditorState(null);
    }
  }, []);

  return { editorState, setEditorState, editorStateRef, openEditor, refreshEditorFromEvents };
}
