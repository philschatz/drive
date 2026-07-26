import { useCallback } from 'preact/hooks';
import { updateDoc, deepAssign } from '../../worker-api';
import type { CalendarEvent } from './schema';
import type { EditorState } from './calendar-utils';

export function useEventMutations(setEditorState: (s: EditorState | null) => void) {
  const saveEvent = useCallback((uid: string, eventData: CalendarEvent, docId: string) => {
    updateDoc(docId, (d: any, deepAssign: any, uid: string, eventData: any) => {
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
  }, [setEditorState]);

  const saveOverride = useCallback((uid: string, recurrenceDate: string, overrideData: any, docId: string) => {
    updateDoc(docId, (d: any, deepAssign: any, uid: string, recurrenceDate: string, overrideData: any) => {
      if (!d.events[uid].recurrenceOverrides) d.events[uid].recurrenceOverrides = {};
      if (!d.events[uid].recurrenceOverrides[recurrenceDate]) {
        d.events[uid].recurrenceOverrides[recurrenceDate] = overrideData;
      } else {
        deepAssign(d.events[uid].recurrenceOverrides[recurrenceDate], overrideData);
      }
    }, deepAssign, uid, recurrenceDate, overrideData);
    setEditorState(null);
  }, [setEditorState]);

  const deleteEvent = useCallback((uid: string, docId: string) => {
    updateDoc(docId, (d: any, uid: string) => { delete d.events[uid]; }, uid);
    setEditorState(null);
  }, [setEditorState]);

  const deleteOccurrence = useCallback((uid: string, recurrenceDate: string, docId: string) => {
    saveOverride(uid, recurrenceDate, { excluded: true }, docId);
  }, [saveOverride]);

  return { saveEvent, saveOverride, deleteEvent, deleteOccurrence };
}
