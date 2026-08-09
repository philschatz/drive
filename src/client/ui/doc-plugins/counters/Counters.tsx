import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { subscribeQuery, updateDoc } from '../../worker-api';
import { peerColor, peerDisplayName, usePresence, type PeerFieldInfo } from '../../common/presence';
import { PresenceDot } from '../../common/PeerDot';
import { DocumentTitleBar } from '../../common/DocumentTitleBar';
import { useDocumentHistory } from '../../common/useDocumentHistory';
import { useEditorUndoRedo } from '../../common/useUndoRedo';
import { useCanEdit } from '../../common/useCanEdit';
import { useFocusPathSync } from '../../common/useFocusPathSync';
import { HistorySlider } from '../../common/HistorySlider';
import { ListRow } from '../../common/ListRow';
import { useConfirm } from '../../common/ConfirmSheet';
import { useDocumentValidation } from '../../common/useDocumentValidation';
import { DocLoader } from '../../common/useDocument';
import { Badge } from '@/components/ui/badge';
import { Fab } from '@/components/ui/fab';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { CounterEvent } from '../../../../shared/schemas/counters';
import { describeRecurrence } from '../calendar/recurrence';
import { relativeDuration } from '../../../../shared/relative-time';
import { MATERIAL_ORANGE } from '../../common/categorical-colors';
import { sortedCounters, metMissedByWeek, isArchived, lastCompletionAnchor, createdStampFor, counterKind, type CounterEntry, type CounterKind, type CounterStatus, type RewardProgress } from './occurrences';
import { MetMissedChart } from './Chart';
import { CounterEditor } from './CounterEditor';
import { CompletionsSheet } from './CompletionsSheet';

interface EditorState {
  uid: string;
  event: CounterEvent;
  isNew: boolean;
}

const COUNTERS_QUERY = '{ events: (.events // {}), name: (.name // "Counters") }';

/** What a row announces to assistive tech. More precise than its section: the
 * tone that separates `due` from `todo` visually is invisible to a screen
 * reader, so the row says which it is even though the heading above it doesn't. */
const STATUS_LABELS: Record<CounterStatus, string> = {
  overdue: 'Overdue',
  due: 'Due',
  todo: 'To do',
  done: 'Done',
  anytime: 'Anytime',
};

/**
 * Section headings. `due` and `todo` share one bucket — they behave identically
 * (both are owed, both can go overdue) and the list is ordered by deadline, so a
 * boundary between them would only repeat what the ordering already says. Which
 * of the two a row is still shows in its tone: full strength once its window is
 * open, muted while it is still ahead.
 *
 * `done` is what you achieved in the current window and empties as windows roll
 * over; `anytime` is where checklist items park between the times they are
 * wanted, so it grows without bound.
 */
const SECTION_LABELS: Record<CounterStatus, string> = { ...STATUS_LABELS, due: 'To do' };

/** Which editor inputs highlight when a peer focuses a given event property.
 * The recurrence-rule cluster (freq/interval/weekdays) shares one doc path. */
const PATH_PROP_TO_FIELDS: Record<string, string[]> = {
  title: ['ced-title'],
  start: ['ced-due'],
  startTime: ['ced-time'],
  duration: ['ced-end'],
  description: ['ced-reward'],
  recurrenceRule: ['ced-freq', 'ced-interval', 'ced-bydays'],
};

function generateUid() {
  return Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

/** Local wall-clock timestamp, "YYYY-MM-DDTHH:mm:ss" (the doc's date format). */
function nowLocal(): string {
  return Temporal.Now.plainDateTimeISO().toString().substring(0, 19);
}

/** A completion key: millisecond precision so rapid clicks in the same second
 * don't collide on the same map key (and get lost). */
function clickKey(): string {
  return Temporal.Now.plainDateTimeISO().toString({ smallestUnit: 'millisecond' });
}

function describeSchedule(ev: CounterEvent): string | null {
  if (!ev.recurrenceRule) return ev.start ? ev.start.substring(0, 10) : null;
  return describeRecurrence(ev.recurrenceRule, ev.startTime);
}

/**
 * A deadline as the user holds it. `windowEnd` returns the *next* day's midnight
 * for a habit with no duration, so rendering it literally shows a date a day
 * later than the day the habit belongs to.
 */
function describeDeadline(at: string): string {
  if (at.endsWith('T00:00:00')) {
    return 'end of ' + Temporal.PlainDate.from(at.substring(0, 10)).subtract({ days: 1 }).toString();
  }
  return at.substring(0, 16).replace('T', ' '); // seconds are noise on a deadline
}

type Tone = 'muted' | 'primary' | 'error';

/**
 * The row's leading glyph, in three independent channels — which is the whole
 * point: let any two of them share one and cells start colliding.
 *
 *   shape — what kind of thing is this?   box = checklist, circle = recurring.
 *           Never moves with the clock, so it always answers "what".
 *   fill  — do I owe anything right now?  empty = yes, ticked = no.
 *   tone  — how urgent?                   muted → primary → error.
 *
 * Every kind × status cell is therefore distinct, and the test asserts exactly
 * that. `tone` names a role rather than a colour, so this stays free of styling
 * and testable as a plain table.
 */
const KIND_SHAPE: Record<CounterKind, { owed: string; settled: string }> = {
  checklist: { owed: 'check_box_outline_blank', settled: 'check_box' },
  // `radio_button_unchecked` rather than `circle`: both exist in the local font,
  // but only this one is known-outlined at FILL 0, and a solid disc here would
  // collapse the fill channel.
  recurring: { owed: 'radio_button_unchecked', settled: 'check_circle' },
};

const STATUS_LOOK: Record<CounterStatus, { tone: Tone; settled: boolean }> = {
  overdue: { tone: 'error', settled: false },
  due: { tone: 'primary', settled: false },
  todo: { tone: 'muted', settled: false },
  done: { tone: 'primary', settled: true },
  anytime: { tone: 'muted', settled: true },
};

export function counterIcon(kind: CounterKind, status: CounterStatus): { icon: string; tone: Tone } {
  const { tone, settled } = STATUS_LOOK[status];
  return { icon: KIND_SHAPE[kind][settled ? 'settled' : 'owed'], tone };
}

const TONE_COLORS: Record<Tone, string> = {
  muted: 'var(--md-sys-color-on-surface-variant)',
  primary: 'var(--md-sys-color-primary)',
  error: 'var(--md-sys-color-error)',
};

/** Streak tooltip, e.g. "5-day streak" (unit follows the recurrence frequency). */
function streakTitle(streak: number, frequency?: string): string {
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[frequency || ''];
  return unit ? `${streak}-${unit} streak` : `${streak} in a row`;
}

/**
 * One counter row: tap anywhere records a completion — the thing you came to do.
 * A counter has two secondary actions, an editor (which also holds Archive and
 * Delete) and a completions log, so ListRow gives it a kebab rather than Tasks'
 * single pencil; a hold (or right-click, or Shift+F10) runs the first, Edit.
 */
function CounterListItem({ uid, ev, status, streak, reward, dueAt, canEdit, peerEditingEvents, onRecord, onEdit, onShowCompletions, onArm, onDisarm }: {
  uid: string;
  ev: CounterEvent;
  status: CounterStatus;
  /** These three come from the sorted entry, which has already computed them. */
  streak: number;
  reward?: RewardProgress;
  /** The deadline the status is about; always past when the status is overdue. */
  dueAt?: string;
  canEdit: boolean;
  peerEditingEvents: Record<string, PeerFieldInfo>;
  onRecord: (uid: string) => void;
  onEdit: (uid: string, ev: CounterEvent) => void;
  onShowCompletions: (uid: string) => void;
  /** Put a schedule-less counter on the to-do list, or take it back off. */
  onArm: (uid: string) => void;
  onDisarm: (uid: string) => void;
}) {
  const kind = counterKind(ev);
  // Only a checklist item has a to-do list to be on or off — a habit is always
  // on its own schedule, and `start` there is an anchor rather than an arm.
  const armable = kind === 'checklist';
  const clickCount = Object.keys(ev.completions || {}).length;
  const schedule = describeSchedule(ev);
  // Safe to word this off the status: `dueAt` is the moment the habit became
  // overdue (always past) for an overdue row, and the moment its window shuts
  // (always future) for a due one — see CounterEntry.dueAt.
  const late = status === 'overdue';
  const timing = dueAt && (late || status === 'due')
    ? { late, text: relativeDuration(dueAt) + (late ? ' overdue' : ' left') }
    : null;
  const title = ev.title || 'Untitled';
  const { icon, tone } = counterIcon(kind, status);
  const iconColor = TONE_COLORS[tone];

  return (
    <ListRow
      data-status={status}
      data-testid="counter-row"
      style={{ opacity: peerEditingEvents[uid] ? 0.5 : status === 'done' ? 0.6 : 1 }}
      onTap={canEdit ? () => onRecord(uid) : undefined}
      // Edit first: it is what a hold runs, and holding a row means "edit this"
      // everywhere else in the app.
      actions={canEdit ? [
        { icon: 'edit', label: 'Edit', title: `Edit ${title}`, onSelect: () => onEdit(uid, ev) },
        // Arming is the row's own gesture rather than a trip through the editor,
        // because wanting something is a passing thought.
        ...(armable && !ev.start ? [{
          icon: 'playlist_add',
          label: 'Add to To do',
          title: `Add ${title} to To do`,
          testId: 'counter-arm',
          onSelect: () => onArm(uid),
        }] : []),
        ...(armable && ev.start ? [{
          icon: 'schedule',
          label: 'Not now',
          title: `Take ${title} off To do`,
          testId: 'counter-disarm',
          onSelect: () => onDisarm(uid),
        }] : []),
        {
          icon: 'history',
          label: `Completions (${clickCount})`,
          title: `Completions for ${title}`,
          onSelect: () => onShowCompletions(uid),
        },
      ] : []}
      actionsLabel={`Actions for ${title}`}
      end={
        <>
          {/* Overdue and To-do rows answer "when?", not "how often?" — the
              recurrence moves into the tooltip and the clock takes its place. */}
          {timing ? (
            <Badge
              variant="secondary"
              data-testid="counter-due"
              className={'whitespace-nowrap' + (timing.late ? ' bg-error-container text-on-error-container' : '')}
              title={(schedule ? schedule + ' · ' : '')
                + (timing.late ? 'overdue since ' : 'due by ')
                + describeDeadline(dueAt!)}
            >
              {timing.text}
            </Badge>
          ) : schedule && <Badge variant="secondary">{schedule}</Badge>}
          {/* The treasure: how many more in a row until the reward unlocks. */}
          {reward && (
            <Badge
              variant={reward.unlocked ? 'default' : 'outline'}
              data-testid="counter-reward"
              title={reward.unlocked
                ? `Unlocked${reward.text ? ': ' + reward.text : ''}`
                : `${reward.remaining} more in a row${reward.text ? ' to unlock: ' + reward.text : ''}`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                {reward.unlocked ? 'emoji_events' : 'redeem'}
              </span>
              {!reward.unlocked && reward.remaining}
            </Badge>
          )}
          {ev.recurrenceRule
            ? streak > 1 && (
                <Badge
                  variant="default"
                  title={streakTitle(streak, ev.recurrenceRule.frequency)}
                  style={{ background: MATERIAL_ORANGE, color: '#000' }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>local_fire_department</span>
                  {streak}
                </Badge>
              )
            : clickCount > 0 && <Badge variant="outline" title={`${clickCount} recorded`}>{clickCount}×</Badge>}
          <PresenceDot fieldId={uid} peerFocusedFields={peerEditingEvents} />
        </>
      }
    >
      {/* Inert, like the checkbox on a task row, and now the only thing keeping
          it that way: the row owns the gesture, so a <button> here would make
          useLongPress skip the press as an interactive child and kill both tap
          and hold on the row's two biggest targets. The glyph is hidden from AT
          — it would otherwise be read as the literal ligature text
          ("check_circle") — and the status it encodes is carried instead by the
          same wording as the visible section heading. */}
      <span slot="start" className="flex items-center">
        <span aria-hidden="true" className="material-symbols-outlined text-lg" style={{ color: iconColor }}>
          {icon}
        </span>
        <span className="sr-only">{STATUS_LABELS[status]}</span>
      </span>
      <div slot="headline">{title}</div>
    </ListRow>
  );
}

export function Counters({ docId, rest, readOnly }: { docId?: string; rest?: string; readOnly?: boolean; path?: string }) {
  const eventId = rest?.startsWith('events/') ? rest.slice(7).split('/')[0] : undefined;
  const [listName, setListName] = useState('Counters');
  const [events, setEvents] = useState<Record<string, CounterEvent>>({});
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  /** Counter whose completions log is open, in its own sheet. */
  const [completionsUid, setCompletionsUid] = useState<string | null>(null);
  // Re-derive "today" when the clock is read; a minute tick keeps statuses fresh
  // across midnight without re-rendering on every click.
  const [now, setNow] = useState(nowLocal);
  useEffect(() => {
    const t = setInterval(() => setNow(nowLocal()), 60_000);
    return () => clearInterval(t);
  }, []);

  const history = useDocumentHistory(docId!);
  const { undo, redo, canUndo, canRedo, onHeads } = useEditorUndoRedo(docId!, history);
  const validationErrors = useDocumentValidation(docId);
  const { canEdit, canEditRef, noAccess } = useCanEdit(docId, readOnly, history);
  const { confirm, confirmSheet } = useConfirm();
  const { peers, peerList, broadcast } = usePresence(docId);
  const editorStateRef = useRef(editorState);
  editorStateRef.current = editorState;
  // The mutations below need the current event to compute anchors before handing
  // a plain value to the worker's change callback.
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const pendingEventIdRef = useRef(eventId);

  // One document change per pane Save in the editor (every pane is transactional).
  // Replaces the event definition wholesale, so the click log is re-attached below.
  const saveCounter = useCallback((uid: string, data: CounterEvent) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, uid, data) => {
      // Replace the event's definition but never the click log. `data.start` was
      // derived from this tab's snapshot, so a completion recorded by a peer
      // between the snapshot and this save leaves the anchor one behind until the
      // next click or edit — last-write-wins per field, self-healing.
      const prev = d.events[uid];
      const completions = prev && prev.completions ? Object.assign({}, prev.completions) : null;
      const clean: any = {};
      for (const key in data) {
        if ((data as any)[key] !== undefined) clean[key] = (data as any)[key];
      }
      if (completions) clean.completions = completions;
      d.events[uid] = clean;
    }, uid, data);
  }, [docId]);

  const deleteCounter = useCallback((uid: string) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, uid) => { delete d.events[uid]; }, uid);
    setEditorState(null);
  }, [docId]);

  // Archive a habit by ending its recurrence as of now (its `until`); unarchive
  // by removing that bound. Only recurring items have a rule to end.
  const archiveCounter = useCallback((uid: string) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, uid, ts) => { const r = d.events[uid]?.recurrenceRule; if (r) r.until = ts; }, uid, nowLocal());
  }, [docId]);

  // Asked here rather than at the row, because both routes to unarchiving — the
  // archived row's own icon and the editor's Unarchive action — come through
  // this one callback, and both deserve the same question. Not `destructive`:
  // that tone is for irreversible loss, and this is neither.
  const unarchiveCounter = useCallback(async (uid: string) => {
    if (!canEditRef.current || !docId) return;
    if (!await confirm({
      title: 'Unarchive this counter?',
      body: 'It returns to your active counters and starts tracking again.',
      confirmLabel: 'Unarchive',
      confirmIcon: 'unarchive',
    })) return;
    updateDoc(docId, (d, uid) => { const r = d.events[uid]?.recurrenceRule; if (r) delete r.until; }, uid);
  }, [docId, confirm]);

  const recordClick = useCallback((uid: string) => {
    if (!canEditRef.current || !docId) return;
    const key = clickKey();
    setNow(nowLocal());
    // Recording moves the schedule anchor to the day it was actually done, so
    // the recurrence restarts from there; `created` (stamped once) is what keeps
    // the history. Both are computed here because the change callback is
    // serialized into the worker, where Temporal isn't available. A checklist
    // item gets no anchor — that would move it out of Anytime and start booking
    // misses against it.
    const ev = eventsRef.current[uid];
    const recurring = !!ev?.recurrenceRule;
    // Over the log *including* this click, not the click alone: a completion
    // dated later than now (imported, or a peer's skewed clock) still owns the
    // anchor, and the schema requires `start` to match the most recent one.
    const anchor = recurring ? lastCompletionAnchor({ ...ev!, completions: { ...ev!.completions, [key]: '' } }) ?? null : null;
    const created = recurring && !ev!.created ? createdStampFor(ev!) : null;
    updateDoc(docId, (d, uid, key, anchor, created) => {
      const ev = d.events[uid];
      if (!ev) return;
      if (!ev.completions) ev.completions = {};
      ev.completions[key] = '';
      // Re-check against the document: a peer may have changed the schedule
      // since this tab's snapshot.
      if (!ev.recurrenceRule) {
        // Doing a one-off answers the want that armed it, so it retires itself:
        // `start` goes and it settles into Anytime, ready to be armed again.
        // The click log and the lifetime count stay, which is what lets the same
        // event be reused instead of recreated.
        if (ev.start) delete ev.start;
        return;
      }
      if (!anchor) return;
      if (created && !ev.created) ev.created = created;
      if (ev.start !== anchor) ev.start = anchor;
    }, uid, key, anchor, created);
  }, [docId]);

  // Arming is what puts a schedule-less counter on the to-do list: `start` is
  // the day it is wanted. Recording a completion clears it again (see
  // recordClick), so the pair is the whole want → do → forget cycle.
  const armCounter = useCallback((uid: string) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, uid, today) => {
      const ev = d.events[uid];
      // A habit is always on its own schedule; `start` there is the anchor, and
      // overwriting it with today would forge a completion.
      if (!ev || ev.recurrenceRule) return;
      ev.start = today;
    }, uid, nowLocal().substring(0, 10));
  }, [docId]);

  const disarmCounter = useCallback((uid: string) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, uid) => {
      const ev = d.events[uid];
      if (!ev || ev.recurrenceRule) return;
      delete ev.start;
    }, uid);
  }, [docId]);

  // Remove a single recorded completion (a mis-click). This is its own mutation:
  // saveCounter re-attaches the completions map wholesale and never deletes keys.
  const deleteCompletion = useCallback((uid: string, key: string) => {
    if (!canEditRef.current || !docId) return;
    // Rewind the schedule anchor to the completion before it, so removing a
    // mis-click doesn't leave the habit shifted with nothing explaining why.
    const ev = eventsRef.current[uid];
    let anchor: string | null = null;
    if (ev?.recurrenceRule) {
      const remaining = { ...ev.completions };
      delete remaining[key];
      anchor = lastCompletionAnchor({ ...ev, completions: remaining }) ?? null;
    }
    // With no completions left there is no anchor — unless `start` is a legacy
    // creation anchor that was never copied to `created`, which must not be lost.
    const clearStart = !anchor && !!ev?.recurrenceRule && !!ev.created;
    updateDoc(docId, (d, uid, key, anchor, clearStart) => {
      const ev = d.events[uid];
      if (!ev?.completions) return;
      delete ev.completions[key];
      if (!ev.recurrenceRule) return;
      if (anchor) { if (ev.start !== anchor) ev.start = anchor; }
      else if (clearStart) delete ev.start;
    }, uid, key, anchor, clearStart);
  }, [docId]);

  const openEditor = useCallback((uid: string | null, event: CounterEvent | null) => {
    const isNew = !uid;
    if (isNew) {
      uid = generateUid();
      event = { '@type': 'Event', title: '' };
    }
    setEditorState({ uid: uid!, event: event!, isNew });
  }, []);

  // Automerge path to the focused field (drives presence, URL, and Edit Source link)
  const [focusedPath, setFocusedPath] = useState<(string | number)[] | null>(null);
  const focusPath: (string | number)[] | undefined = focusedPath ?? (editorState ? ['events', editorState.uid] : undefined);

  const handleFieldFocus = useCallback((path: (string | number)[] | null) => {
    setFocusedPath(path);
  }, []);

  // Clear a stale field focus when the editor closes; sync presence.
  useEffect(() => { if (!editorState) setFocusedPath(null); }, [editorState]);
  useFocusPathSync(focusPath, broadcast);

  useEffect(() => {
    if (!docId) return;
    let mounted = true;
    const unsubscribe = subscribeQuery(docId, COUNTERS_QUERY, (result, heads) => {
      if (!mounted || !result) return;
      setEvents(result.events || {});
      if (result.name) {
        setListName(result.name);
        document.title = result.name + ' - Counters';
      }
      onHeads(heads);

      if (pendingEventIdRef.current && result.events) {
        const ev = result.events[pendingEventIdRef.current];
        if (ev) openEditor(pendingEventIdRef.current, ev);
        pendingEventIdRef.current = undefined;
      }

      const es = editorStateRef.current;
      if (es && !es.isNew) {
        const fresh = (result.events || {})[es.uid];
        if (fresh) {
          setEditorState(prev => (prev && prev.uid === es.uid) ? { ...prev, event: fresh } : prev);
        } else {
          setEditorState(null);
        }
      }
    });
    return () => { mounted = false; unsubscribe(); };
  }, [docId]);

  const peerEditingEvents = useMemo(() => {
    const result: Record<string, PeerFieldInfo> = {};
    for (const peer of Object.values(peers)) {
      const pf = peer.value?.focusedField;
      if (pf && pf[0] === 'events' && pf[1]) {
        const userGroupId = peer.value?.userGroupId;
        result[pf[1] as string] = { color: peerColor(peer.peerId, userGroupId), peerId: peer.peerId, userGroupId };
      }
    }
    return result;
  }, [peers]);

  // Per-field presence inside the open editor: map peers' focused doc paths
  // (['events', uid, prop]) onto the editor's input ids (mirrors Tasks).
  const peerFocusedFields = useMemo(() => {
    const result: Record<string, PeerFieldInfo> = {};
    if (!editorState) return result;
    for (const peer of Object.values(peers)) {
      const pf = peer.value?.focusedField;
      if (!pf || pf.length < 3) continue;
      if (pf[0] !== 'events' || pf[1] !== editorState.uid) continue;
      const prop = pf[2] as string;
      const inputIds = PATH_PROP_TO_FIELDS[prop];
      if (inputIds) {
        const userGroupId = peer.value?.userGroupId;
        const info = { color: peerColor(peer.peerId, userGroupId), peerId: peer.peerId, userGroupId };
        for (const id of inputIds) result[id] = info;
      }
    }
    return result;
  }, [peers, editorState]);

  // Archived habits (recurrence ended) drop out of the active list, the section
  // counts, and the chart — shown separately at the bottom, newest first.
  const [active, archived] = useMemo(() => {
    const a: Record<string, CounterEvent> = {};
    const arch: { uid: string; ev: CounterEvent; until: string }[] = [];
    for (const [uid, ev] of Object.entries(events)) {
      if (isArchived(ev)) arch.push({ uid, ev, until: ev.recurrenceRule!.until! });
      else a[uid] = ev;
    }
    arch.sort((x, y) => (x.until > y.until ? -1 : 1));
    return [a, arch] as const;
  }, [events]);

  const sorted = sortedCounters(active, now);
  const stats = useMemo(() => metMissedByWeek(active, now), [active, now]);

  // Group the sorted entries into contiguous sections so each renders as a
  // header + its own Material list. Keyed on the section LABEL, not the status:
  // `due` and `todo` share the To do bucket, and grouping by status would split
  // it into two headers reading the same thing.
  const sections: { label: string; entries: CounterEntry[] }[] = [];
  for (const entry of sorted) {
    const label = SECTION_LABELS[entry.status];
    const last = sections[sections.length - 1];
    if (last && last.label === label) last.entries.push(entry);
    else sections.push({ label, entries: [entry] });
  }

  return (
    <DocLoader docId={docId}>
    <>
      <DocumentTitleBar
        icon="event_repeat"
        title={listName}
        titleEditable={canEdit}
        onRename={(value) => {
          if (!docId || !canEdit) return;
          const name = value.trim() || 'Counters';
          setListName(name);
          updateDoc(docId, (d, name) => { d.name = name; }, name);
          document.title = name + ' - Counters';
        }}
        docId={docId}
        peers={peerList}
        peerTitle={(peer) => `${peerDisplayName(peer.peerId, peer.value?.userGroupId)}${peer.value?.focusedField ? ' (editing)' : ''}`}
        onToggleHistory={history.toggleHistory}
        historyActive={history.active}
        onUndo={canEdit ? undo : undefined}
        onRedo={canEdit ? redo : undefined}
        canUndo={canUndo}
        canRedo={canRedo}
        hasValidationErrors={validationErrors.length > 0}
        sourcePath={focusPath}
        action={{ icon: 'bar_chart', label: 'Chart', onSelect: () => setChartOpen(true) }}
      />
      <HistorySlider history={history} />
      <div
        className="max-w-screen-md mx-auto w-full px-2 sm:px-4 pb-28"
        style={noAccess ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
      >

      <div data-testid="counter-list">
        {sections.map(({ label, entries }) => (
          <div key={label}>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground mt-3 mb-1">{label}</h3>
            <md-list style={{ background: 'transparent' }}>
              {/* Per entry, not per section: To do holds both `due` and `todo`,
                  which the row tells apart by tone. */}
              {entries.map(({ uid, ev, status, streak, reward, dueAt }) => (
                <CounterListItem
                  key={uid}
                  uid={uid}
                  ev={ev}
                  status={status}
                  streak={streak}
                  reward={reward}
                  dueAt={dueAt}
                  canEdit={canEdit}
                  peerEditingEvents={peerEditingEvents}
                  onRecord={recordClick}
                  onEdit={openEditor}
                  onShowCompletions={setCompletionsUid}
                  onArm={armCounter}
                  onDisarm={disarmCounter}
                />
              ))}
            </md-list>
          </div>
        ))}
        {sorted.length === 0 && archived.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">Nothing to count yet. Add something you'd like to do regularly.</p>
        )}

        {archived.length > 0 && (
          <>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground mt-3 mb-1">Archived</h3>
            <md-list style={{ background: 'transparent' }}>
              {/* No onTap: an archived counter has nothing to record, so the row
                  has a secondary action and no primary one. One action, so
                  ListRow gives it that action's own glyph and a hold that runs
                  it — both landing on the same confirm. */}
              {archived.map(({ uid, ev, until }) => (
                <ListRow
                  key={uid}
                  data-testid="archived-row"
                  style={{ opacity: 0.6 }}
                  actions={canEdit
                    ? [{ icon: 'unarchive', label: 'Unarchive', onSelect: () => unarchiveCounter(uid) }]
                    : []}
                  end={<Badge variant="secondary">archived {until.substring(0, 10)}</Badge>}
                >
                  <span slot="start" className="material-symbols-outlined text-lg">inventory_2</span>
                  <div slot="headline">{ev.title || 'Untitled'}</div>
                </ListRow>
              ))}
            </md-list>
          </>
        )}
      </div>

      </div>

      {/* Met/missed chart — opened from the title-bar overflow menu. */}
      <Sheet open={chartOpen} onOpenChange={setChartOpen}>
        <SheetContent side="bottom" className="max-h-[70vh]">
          <SheetHeader>
            <SheetTitle>Met vs missed per week</SheetTitle>
          </SheetHeader>
          <div className="mt-3">
            <MetMissedChart stats={stats} />
          </div>
        </SheetContent>
      </Sheet>

      {canEdit && (
        <Fab icon="add" aria-label="New counter" onClick={() => openEditor(null, null)} />
      )}

      <CounterEditor
        uid={editorState?.uid || ''}
        event={editorState?.event || { '@type': 'Event', title: '' }}
        isNew={editorState?.isNew || false}
        opened={!!editorState}
        canEdit={canEdit}
        onSave={saveCounter}
        onDelete={deleteCounter}
        onShowCompletions={setCompletionsUid}
        onClose={() => setEditorState(null)}
        onAddAnother={() => openEditor(null, null)}
        // Saving a new counter's title creates it, so the rest of the editor
        // (schedule, reward, footer) now applies to a real document item.
        onCreated={() => setEditorState(prev => (prev ? { ...prev, isNew: false } : prev))}
        onArchive={archiveCounter}
        onUnarchive={unarchiveCounter}
        onFieldFocus={handleFieldFocus}
        peerFocusedFields={peerFocusedFields}
      />

      <CompletionsSheet
        open={!!completionsUid}
        uid={completionsUid || ''}
        event={completionsUid ? events[completionsUid] ?? null : null}
        canEdit={canEdit}
        onDeleteCompletion={deleteCompletion}
        onClose={() => setCompletionsUid(null)}
      />

      {confirmSheet}
    </>
    </DocLoader>
  );
}
