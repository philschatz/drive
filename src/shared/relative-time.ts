/**
 * Shared "time ago" formatter used by the Home doc list and the CLI `list` command,
 * so both render timestamps the same way (e.g. "3 hours ago").
 */
import dayjs from 'dayjs';
import relativeTimePlugin from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTimePlugin);

/**
 * Human "time ago" for any timestamp dayjs understands — an ISO string, a `Date`,
 * or epoch **milliseconds**. Returns '' for null/undefined. Note: epoch *seconds*
 * (e.g. Automerge change times) must be converted first: `relativeTime(new Date(sec * 1000))`.
 */
export function relativeTime(ts: string | number | Date | null | undefined): string {
  if (ts == null) return '';
  return dayjs(ts).fromNow();
}
