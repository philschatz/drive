import type { EventLookupMap } from './schedule-x';
import { parseDuration, toDateStr } from './recurrence';

interface DragState {
  el: HTMLElement;
  eventId: string;
  dayCol: HTMLElement;
  isMonthGrid: boolean;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  origWidth: number;
  origHeight: number;
  origTop: number;
  origBottom: number;
  resizeEdge: 'top' | 'bottom' | null;
  started: boolean;
  ghost: HTMLElement | null;
}

export function initDragDrop(
  calEl: HTMLElement,
  getEventLookup: () => EventLookupMap,
  getEvents: () => Record<string, any>,
  saveEvent: (uid: string, data: any, eventId: string) => void,
  saveOverride: (uid: string, recurrenceDate: string, data: any, eventId: string) => void,
  refreshCalendar: () => void
) {
  let dragState: DragState | null = null;
  const THRESHOLD = 5;
  const RESIZE_EDGE = 8;
  let didDrag = false;

  calEl.addEventListener('mousemove', (e: MouseEvent) => {
    if (dragState) return;
    const eventEl = (e.target as HTMLElement).closest('[data-event-id]') as HTMLElement | null;
    if (!eventEl || !eventEl.closest('.sx__time-grid-day')) return;
    const rect = eventEl.getBoundingClientRect();
    const edge = Math.min(RESIZE_EDGE, rect.height / 3);
    if (e.clientY - rect.top < edge || rect.bottom - e.clientY < edge) {
      eventEl.classList.add('resize-cursor');
    } else {
      eventEl.classList.remove('resize-cursor');
    }
  }, true);

  calEl.addEventListener('click', (e: MouseEvent) => {
    if (didDrag) {
      e.stopImmediatePropagation();
      e.preventDefault();
      didDrag = false;
    }
  }, true);

  calEl.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    const eventEl = (e.target as HTMLElement).closest('[data-event-id]') as HTMLElement | null;
    if (!eventEl) return;
    const dayCol = eventEl.closest('.sx__time-grid-day') as HTMLElement | null;
    const monthCell = !dayCol ? eventEl.closest('.sx__month-grid-day') as HTMLElement | null : null;
    if (!dayCol && !monthCell) return;
    const isMonthGrid = !!monthCell;

    const rect = eventEl.getBoundingClientRect();
    const edge = Math.min(RESIZE_EDGE, rect.height / 3);
    let resizeEdge: 'top' | 'bottom' | null = null;
    if (!isMonthGrid) {
      if (e.clientY - rect.top < edge) resizeEdge = 'top';
      else if (rect.bottom - e.clientY < edge) resizeEdge = 'bottom';
    }

    dragState = {
      el: eventEl,
      eventId: eventEl.dataset.eventId!,
      dayCol: (dayCol || monthCell)!,
      isMonthGrid,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      origWidth: rect.width,
      origHeight: rect.height,
      origTop: rect.top,
      origBottom: rect.bottom,
      resizeEdge,
      started: false,
      ghost: null,
    };
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.started) {
      if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
      dragState.started = true;
      dragState.el.classList.add('drag-source');
      const ghost = dragState.el.cloneNode(true) as HTMLElement;
      ghost.classList.add('drag-ghost');
      ghost.style.width = dragState.origWidth + 'px';
      ghost.style.height = dragState.origHeight + 'px';
      document.body.appendChild(ghost);
      dragState.ghost = ghost;
      document.body.classList.add('dragging', dragState.resizeEdge ? 'dragging--resize' : 'dragging--move');
    }
    if (!dragState.ghost) return;

    if (dragState.isMonthGrid) {
      const monthDays = calEl.querySelectorAll('.sx__month-grid-day');
      monthDays.forEach(d => d.classList.remove('sx__month-grid-day--dragover'));
      for (let i = 0; i < monthDays.length; i++) {
        const mr = monthDays[i].getBoundingClientRect();
        if (e.clientX >= mr.left && e.clientX <= mr.right && e.clientY >= mr.top && e.clientY <= mr.bottom) {
          monthDays[i].classList.add('sx__month-grid-day--dragover');
          break;
        }
      }
      dragState.ghost.style.left = (e.clientX - dragState.offsetX) + 'px';
      dragState.ghost.style.top = (e.clientY - dragState.offsetY) + 'px';
    } else if (dragState.resizeEdge) {
      const colRect = dragState.dayCol.getBoundingClientRect();
      const mh = colRect.height / 1440;
      const snap15 = mh * 15;
      if (dragState.resizeEdge === 'bottom') {
        const fixedTop = Math.round((dragState.origTop - colRect.top) / snap15) * 15;
        let botMin = Math.round((e.clientY - colRect.top) / snap15) * 15;
        if (botMin <= fixedTop) botMin = fixedTop + 15;
        if (botMin > 1440) botMin = 1440;
        dragState.ghost.style.left = colRect.left + 'px';
        dragState.ghost.style.top = (colRect.top + fixedTop * mh) + 'px';
        dragState.ghost.style.height = ((botMin - fixedTop) * mh) + 'px';
        dragState.ghost.style.width = colRect.width + 'px';
      } else {
        const fixedBot = Math.round((dragState.origBottom - colRect.top) / snap15) * 15;
        let topMin = Math.round((e.clientY - colRect.top) / snap15) * 15;
        if (topMin < 0) topMin = 0;
        if (topMin >= fixedBot) topMin = fixedBot - 15;
        dragState.ghost.style.left = colRect.left + 'px';
        dragState.ghost.style.top = (colRect.top + topMin * mh) + 'px';
        dragState.ghost.style.height = ((fixedBot - topMin) * mh) + 'px';
        dragState.ghost.style.width = colRect.width + 'px';
      }
    } else {
      const days = calEl.querySelectorAll('.sx__time-grid-day');
      let snapCol: Element | null = null;
      for (let i = 0; i < days.length; i++) {
        const sr = days[i].getBoundingClientRect();
        if (e.clientX >= sr.left && e.clientX <= sr.right) { snapCol = days[i]; break; }
      }
      if (snapCol) {
        const colRect = snapCol.getBoundingClientRect();
        const minuteHeight = colRect.height / 1440;
        const relY = e.clientY - colRect.top - dragState.offsetY;
        let snappedMin = Math.round(relY / (minuteHeight * 15)) * 15;
        if (snappedMin < 0) snappedMin = 0;
        if (snappedMin > 1425) snappedMin = 1425;
        dragState.ghost.style.left = colRect.left + 'px';
        dragState.ghost.style.top = (colRect.top + snappedMin * minuteHeight) + 'px';
        dragState.ghost.style.width = colRect.width + 'px';
      } else {
        dragState.ghost.style.left = (e.clientX - dragState.offsetX) + 'px';
        dragState.ghost.style.top = (e.clientY - dragState.offsetY) + 'px';
      }
    }
  });

  document.addEventListener('mouseup', (e: MouseEvent) => {
    if (!dragState) return;
    const state = dragState;
    dragState = null;
    document.body.classList.remove('dragging', 'dragging--move', 'dragging--resize');

    if (!state.started) return;
    didDrag = true;
    state.el.classList.remove('drag-source');
    if (state.ghost) state.ghost.remove();

    const eventLookup = getEventLookup();
    const events = getEvents();
    const item = eventLookup[state.eventId];
    if (!item) return;

    if (state.isMonthGrid) {
      calEl.querySelectorAll('.sx__month-grid-day--dragover').forEach(d => d.classList.remove('sx__month-grid-day--dragover'));
      const monthDays = calEl.querySelectorAll('.sx__month-grid-day');
      let targetDate: string | null = null;
      for (let i = 0; i < monthDays.length; i++) {
        const mr = monthDays[i].getBoundingClientRect();
        if (e.clientX >= mr.left && e.clientX <= mr.right && e.clientY >= mr.top && e.clientY <= mr.bottom) {
          targetDate = monthDays[i].getAttribute('data-date');
          break;
        }
      }
      if (!targetDate) return;
      const origStart = item.ev.start || '';
      const timePart = origStart.length > 10 ? origStart.substring(10) : '';
      const newStart = targetDate + timePart;
      if (item.isRecurring && item.recurrenceDate) {
        saveOverride(item.uid, item.recurrenceDate, { start: newStart }, state.eventId);
      } else {
        const ev = events[item.uid] || item.ev;
        saveEvent(item.uid, { ...ev, start: newStart }, state.eventId);
      }
      refreshCalendar();
      return;
    }

    if (state.resizeEdge) {
      const colRect = state.dayCol.getBoundingClientRect();
      const mh = colRect.height / 1440;
      const snap15 = mh * 15;
      const origStartStr = item.ev.start || '';
      const origTime = origStartStr.length > 10 ? origStartStr.substring(11, 16) : '00:00';
      const origParts = origTime.split(':');
      const origStartMin = parseInt(origParts[0]) * 60 + parseInt(origParts[1]);
      const origDur = parseDuration(item.ev.duration || 'PT1H');
      const origDurMin = origDur.days * 1440 + origDur.hours * 60 + origDur.minutes;
      const origEndMin = origStartMin + origDurMin;

      let newStartMin: number, newEndMin: number;
      if (state.resizeEdge === 'bottom') {
        newStartMin = origStartMin;
        newEndMin = Math.round((e.clientY - colRect.top) / snap15) * 15;
        if (newEndMin <= newStartMin) newEndMin = newStartMin + 15;
        if (newEndMin > 1440) newEndMin = 1440;
      } else {
        newEndMin = origEndMin;
        newStartMin = Math.round((e.clientY - colRect.top) / snap15) * 15;
        if (newStartMin < 0) newStartMin = 0;
        if (newStartMin >= newEndMin) newStartMin = newEndMin - 15;
      }

      const newDurMin = newEndMin - newStartMin;
      const durH = Math.floor(newDurMin / 60);
      const durM = newDurMin % 60;
      let durStr = 'PT' + (durH ? durH + 'H' : '') + (durM ? durM + 'M' : '');
      if (!durH && !durM) durStr = 'PT15M';

      const dateStr = origStartStr.substring(0, 10);
      const newTimeStr = String(Math.floor(newStartMin / 60)).padStart(2, '0') + ':' + String(newStartMin % 60).padStart(2, '0');
      const newStart = dateStr + 'T' + newTimeStr + ':00';

      if (item.isRecurring && item.recurrenceDate) {
        const overrideData: any = { duration: durStr };
        if (state.resizeEdge === 'top') overrideData.start = newStart;
        saveOverride(item.uid, item.recurrenceDate, overrideData, state.eventId);
      } else {
        const ev = events[item.uid] || item.ev;
        const updated: any = { ...ev, duration: durStr };
        if (state.resizeEdge === 'top') updated.start = newStart;
        saveEvent(item.uid, updated, state.eventId);
      }
      refreshCalendar();
    } else {
      const days = calEl.querySelectorAll('.sx__time-grid-day');
      if (!days.length) return;

      let dropDay: Element | null = null;
      let dropDayIndex = -1;
      for (let i = 0; i < days.length; i++) {
        const r = days[i].getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right) {
          dropDay = days[i];
          dropDayIndex = i;
          break;
        }
      }
      if (!dropDay) return;

      let origDayIndex = -1;
      for (let j = 0; j < days.length; j++) {
        if (days[j] === state.dayCol) { origDayIndex = j; break; }
      }
      if (origDayIndex === -1) return;

      const dayRect = dropDay.getBoundingClientRect();
      const relY = e.clientY - dayRect.top - state.offsetY;
      let totalMinutes = Math.round((relY / dayRect.height) * 1440 / 15) * 15;
      if (totalMinutes < 0) totalMinutes = 0;
      if (totalMinutes > 1425) totalMinutes = 1425;
      const hours = Math.floor(totalMinutes / 60);
      const mins = totalMinutes % 60;

      const dayDiff = dropDayIndex - origDayIndex;
      const origStartStr = item.ev.start || '';
      const origDate = new Date(origStartStr.length <= 10 ? origStartStr + 'T00:00:00' : origStartStr);
      const newDate = new Date(origDate);
      newDate.setDate(newDate.getDate() + dayDiff);
      const newDateStr = toDateStr(newDate);
      const newTimeStr = String(hours).padStart(2, '0') + ':' + String(mins).padStart(2, '0');
      const newStart = newDateStr + 'T' + newTimeStr + ':00';

      if (item.isRecurring && item.recurrenceDate) {
        saveOverride(item.uid, item.recurrenceDate, { start: newStart }, state.eventId);
      } else {
        const ev = events[item.uid] || item.ev;
        saveEvent(item.uid, { ...ev, start: newStart }, state.eventId);
      }
      refreshCalendar();
    }
  });
}
