/**
 * Builds a jq query that filters calendar events to a date range,
 * always including recurring events (which may have occurrences in range).
 */

/** Expand a visible range by ±1 month, returning ISO date strings. */
export function expandRange(start: string, end: string): { start: string; end: string } {
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  s.setMonth(s.getMonth() - 1);
  e.setMonth(e.getMonth() + 1);
  const fmt = (d: Date) =>
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return { start: fmt(s), end: fmt(e) };
}

/**
 * Build a jq filter string that returns only events relevant to a date range.
 *
 * Non-recurring: start date falls within [rangeStart, rangeEnd], OR it lasts
 *            more than a day and starts no later than rangeEnd — it may still
 *            be running in the range (a week's trip, a Timeline chapter that
 *            spans years). jq here cannot add a duration to a date, so every
 *            such earlier multi-day event is sent and the calendar view shows
 *            only the ones that overlap.
 * Recurring: start date <= rangeEnd (could produce occurrences in range)
 *            AND until date (if set) >= rangeStart (hasn't ended before range).
 */
export function calendarQuery(rangeStart: string, rangeEnd: string): string {
  // Recurring event condition: starts no later than rangeEnd, and
  // either has no until (infinite) or until >= rangeStart
  const recurring =
    '.value.recurrenceRule != null and .value.start[:10] <= "' + rangeEnd +
    '" and ((.value.recurrenceRule.until // null) == null or .value.recurrenceRule.until[:10] >= "' + rangeStart + '")';
  // "P2D", "P1W", "P1DT2H": more than a day. "P1D" and "PT…" are not.
  const multiDay = '(.value.duration // "P1D") != "P1D" and (.value.duration // "PT")[:2] != "PT"';
  const nonRecurring =
    '.value.recurrenceRule == null and .value.start[:10] <= "' + rangeEnd +
    '" and (.value.start[:10] >= "' + rangeStart + '" or (' + multiDay + '))';
  return (
    '{ "@type": .["@type"], events: (.events // {} | to_entries | map(select((' + recurring + ') or (' + nonRecurring +
    '))) | from_entries), name: (.name // "Calendar"), description: (.description // ""), color: .color, timeZone: .timeZone }'
  );
}
