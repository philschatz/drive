/**
 * Timeline: a diary of a life, filled in retroactively and out of order.
 *
 * Tabs: the Timeline itself; Prompts (photo moments from an outside
 * photo feeder, and the emptiest stretches of life); Pin down (one
 * before/after question at a time, narrowing the vaguest dates); Revisit
 * (entries flagged to come back to).
 *
 * All date reasoning is in src/shared/timeline (order.ts, planner.ts); every
 * write is a self-contained function from changes.ts, so the same code serves
 * the worker and the CLI feeder.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { subscribeQuery, updateDoc } from '../../worker-api';
import { peerColor, peerDisplayName, usePresence, type PeerFieldInfo } from '../../common/presence';
import { DocumentTitleBar } from '../../common/DocumentTitleBar';
import { useDocumentHistory } from '../../common/useDocumentHistory';
import { useEditorUndoRedo } from '../../common/useUndoRedo';
import { useCanEdit } from '../../common/useCanEdit';
import { useFocusPathSync } from '../../common/useFocusPathSync';
import { HistorySlider } from '../../common/HistorySlider';
import { useConfirm } from '../../common/ConfirmSheet';
import { useDocumentValidation } from '../../common/useDocumentValidation';
import { DocLoader } from '../../common/useDocument';
import { PillTabs } from '../../common/PillTabs';
import { FieldSheet } from '../../common/FieldEditor';
import { ListRow } from '../../common/ListRow';
import { Fab } from '@/components/ui/fab';
import { MdTextField } from '@/components/ui/md-text-field';
import type { TimelineEvent, TimelinePrompt, Rel, ChapterKind } from '../../../../shared/schemas/timeline';
import * as changes from '../../../../shared/timeline/changes';
import { newEntryId } from '../../../../shared/timeline/ids';
import { effectiveBounds, displayOrder, type Conflict } from '../../../../shared/timeline/order';
import {
  chapterLayout, chapterSpans, chaptersAt, placeGaps, hasPlaces, chapterCards, type ChapterGap,
} from '../../../../shared/timeline/chapters';
import {
  nextDateQuestion, pinTargets, largestGaps, placeBetween, applyPivotAnswer, targetKey,
  type Question, type Target, type Gap,
} from '../../../../shared/timeline/planner';
import {
  calendarFields, todayDay, partialOf, parsePartial, bestDay, formatFuzzy, type FuzzyDate,
} from '../../../../shared/timeline/fuzzy-date';
import { TimelineList, chapterDates } from './TimelineList';
import { EntryEditor, PROP_TO_FIELDS, type EntryPatch, type ChapterOption } from './EntryEditor';
import { chapterColor, CHAPTER_KIND_META } from './chapter-kinds';

/** What a chapter card asks, by kind. */
const CHAPTER_QUESTION: Record<ChapterKind, string> = {
  place: 'What happened while you lived there?',
  people: 'What do you remember from that time together?',
  pursuit: 'What do you remember from it?',
  phase: 'What do you remember from that time?',
  other: 'What do you remember from that time?',
};
import { PromptCard, GapCard, PinDownCard, ConflictList, PlaceGapCard, ChapterCard, type ChapterChip } from './Cards';

const TIMELINE_QUERY =
  '{ name: (.name // "Timeline"), birth: (.birth // null), events: (.events // {}), prompts: (.prompts // {}) }';

type Tab = 'timeline' | 'prompts' | 'pin' | 'revisit';

interface EditorState {
  uid: string;
  entry: TimelineEvent;
  isNew: boolean;
  /** Pane to open an existing entry into. */
  pane?: string | null;
  /** Where a new entry came from — decides the change that creates it. */
  promptKey?: string;
  gap?: { key: string; prompt: TimelinePrompt };
  insert?: { earlier: string | null; later: string | null };
  /** A memory started from a chapter ("Add a memory during this chapter"): Enter keeps adding to it. */
  during?: string;
  /**
   * Keys the editor. The sheet reads its first pane only when it mounts, so
   * starting a new entry from inside an open sheet bumps this to remount it;
   * Enter-to-add-another keeps it (the title pane is already showing).
   */
  fresh?: number;
}

function generateUid(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 11);
}
const nowIso = () => new Date().toISOString();
const blank = (over: Partial<TimelineEvent> = {}): TimelineEvent => ({ '@type': 'Event', title: '', ...over });

/** Drop undefined keys: Automerge cannot store them. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function gapWhen(gap: Gap): FuzzyDate {
  return { earliest: partialOf(gap.lo, 'year'), latest: partialOf(gap.hi, 'year') };
}

export function Timeline({ docId, readOnly }: { docId?: string; rest?: string; readOnly?: boolean }) {
  const [name, setName] = useState('Timeline');
  const [birth, setBirth] = useState<string | undefined>(undefined);
  const [events, setEvents] = useState<Record<string, TimelineEvent>>({});
  const [prompts, setPrompts] = useState<Record<string, TimelinePrompt>>({});
  const [tab, setTab] = useState<Tab>('timeline');
  const [arranging, setArranging] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [birthOpen, setBirthOpen] = useState(false);
  const [notice, setNotice] = useState<{ uid: string; message: string } | null>(null);
  const [skip, setSkip] = useState<Set<string>>(() => new Set());
  const [pinTarget, setPinTarget] = useState<Target | null>(null);
  const today = useMemo(todayDay, []);

  const history = useDocumentHistory(docId!);
  const { undo, redo, canUndo, canRedo, onHeads } = useEditorUndoRedo(docId!, history);
  const validationErrors = useDocumentValidation(docId);
  const { canEdit, canEditRef, noAccess } = useCanEdit(docId, readOnly, history);
  const { confirm, confirmSheet } = useConfirm();
  const { peers, peerList, broadcast } = usePresence(docId);

  const docRef = useRef({ birth, events, prompts });
  docRef.current = { birth, events, prompts };
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    if (!docId) return;
    let mounted = true;
    const unsubscribe = subscribeQuery(docId, TIMELINE_QUERY, (result, heads) => {
      if (!mounted || !result) return;
      const evs = result.events || {};
      setEvents(evs);
      setPrompts(result.prompts || {});
      setBirth(result.birth || undefined);
      if (result.name) { setName(result.name); document.title = result.name + ' - Timeline'; }
      onHeads(heads);
      const ed = editorRef.current;
      if (ed) {
        const fresh = evs[ed.uid];
        if (fresh) setEditor(prev => (prev && prev.uid === ed.uid ? { ...prev, entry: fresh, isNew: false } : prev));
        else if (!ed.isNew) setEditor(null);
      }
    });
    return () => { mounted = false; unsubscribe(); };
  }, [docId]);

  const doc = useMemo(() => ({ birth, events, prompts }), [birth, events, prompts]);
  const bounds = useMemo(() => effectiveBounds(doc, today), [doc, today]);
  const order = useMemo(() => displayOrder(doc, bounds), [doc, bounds]);
  const layout = useMemo(() => chapterLayout(doc, bounds, order.ordered), [doc, bounds, order]);
  const titleOf = useCallback((uid: string) => events[uid]?.title ?? 'a deleted entry', [events]);

  const write = useCallback(<A extends unknown[]>(fn: (d: any, ...a: A) => unknown, ...args: A) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, fn as any, ...args);
  }, [docId]);

  // ── Presence ──────────────────────────────────────────────────────────────
  const [focusedPath, setFocusedPath] = useState<(string | number)[] | null>(null);
  const focusPath = focusedPath ?? (editor ? ['events', editor.uid] : undefined);
  useEffect(() => { if (!editor) setFocusedPath(null); }, [editor]);
  useFocusPathSync(focusPath, broadcast);

  const peerEditing = useMemo(() => {
    const out: Record<string, PeerFieldInfo> = {};
    for (const peer of Object.values(peers)) {
      const pf = peer.value?.focusedField;
      if (pf && pf[0] === 'events' && pf[1]) {
        out[pf[1] as string] = { color: peerColor(peer.peerId, peer.value?.userGroupId), peerId: peer.peerId, userGroupId: peer.value?.userGroupId };
      }
    }
    return out;
  }, [peers]);
  const peerFocusedFields = useMemo(() => {
    const out: Record<string, PeerFieldInfo> = {};
    if (!editor) return out;
    for (const peer of Object.values(peers)) {
      const pf = peer.value?.focusedField;
      if (!pf || pf[0] !== 'events' || pf[1] !== editor.uid || pf.length < 3) continue;
      for (const id of PROP_TO_FIELDS[pf[2] as string] ?? []) {
        out[id] = { color: peerColor(peer.peerId, peer.value?.userGroupId), peerId: peer.peerId, userGroupId: peer.value?.userGroupId };
      }
    }
    return out;
  }, [peers, editor]);

  // ── Entries ───────────────────────────────────────────────────────────────
  const openNew = useCallback((ctx: Partial<EditorState> = {}) => {
    setEditor({ uid: generateUid(), entry: ctx.entry ?? blank(), isNew: true, fresh: editorRef.current?.fresh, ...ctx } as EditorState);
  }, []);

  const createEntry = useCallback((uid: string, title: string, viaEnter: boolean, kind?: ChapterKind) => {
    const ed = editorRef.current;
    if (!ed || ed.uid !== uid || !canEditRef.current) return;
    const d = docRef.current;
    let entry: TimelineEvent = clean({ ...ed.entry, title, ...(kind ? { chapter: kind } : {}) });
    if (ed.insert) {
      const p = placeBetween(d, uid, ed.insert.earlier, ed.insert.later, today, entry);
      if (p.ok) {
        const rel: Record<string, Rel> = {};
        for (const r of p.add) if (r.owner === uid) rel[r.target] = r.rel;
        entry = { ...entry, rel, when: p.when };
      }
    }
    entry = clean({ ...entry, ...calendarFields(entry.when, entry.until) });
    // The editor's uid was a placeholder; the entry is named now, from its date,
    // place, people (or title) — shared/timeline/ids.ts.
    const id = newEntryId(entry, x => x in d.events);
    if (ed.promptKey) write(changes.answerPrompt, ed.promptKey, id, entry);
    else if (ed.gap) write(changes.answerGap, ed.gap.key, ed.gap.prompt, id, entry);
    else write(changes.addEntry, id, entry);

    if (!viaEnter) { setEditor(prev => (prev && prev.uid === uid ? { ...prev, uid: id, entry, isNew: false } : prev)); return; }
    // Rapid entry: the next one goes right after this one in time (just above
    // it in the newest-first list), or into the same stretch of time.
    if (ed.insert) openNew({ insert: { earlier: id, later: ed.insert.later } });
    else if (entry.chapter) openNew({ entry: blank({ chapter: entry.chapter }) });
    else if (ed.during) openNew({ during: ed.during, entry: blank({ rel: { [ed.during]: 'during' } }) });
    else if (ed.gap) openNew({ entry: blank({ when: ed.entry.when }) });
    else openNew();
  }, [today, write, openNew]);

  const patchEntry = useCallback((uid: string, patch: EntryPatch) => write(changes.patchEntry, uid, patch), [write]);
  const removeParticipant = useCallback((uid: string, participantId: string) => write(changes.removeParticipant, uid, participantId), [write]);
  const setEmotions = useCallback((uid: string, add: string[], remove: string[]) => write(changes.setEmotions, uid, add, remove), [write]);

  const setDate = useCallback((uid: string, field: 'when' | 'until', value: FuzzyDate | null) => {
    const ev = docRef.current.events[uid];
    if (!ev) return;
    const when = field === 'when' ? value ?? undefined : ev.when;
    const until = field === 'until' ? value ?? undefined : ev.until;
    write(changes.setWhen, uid, field, value, calendarFields(when, until));
  }, [write]);

  const deleteEntry = useCallback(async (uid: string) => {
    const ev = docRef.current.events[uid];
    if (!ev || !canEditRef.current) return;
    if (!await confirm({ title: `Delete “${ev.title}”?`, body: 'Its story and what other entries say relative to it go too.', confirmLabel: 'Delete', confirmIcon: 'delete', destructive: true })) return;
    write(changes.deleteEntry, uid);
    setEditor(null);
  }, [write, confirm]);

  const removeRelation = useCallback((owner: string, field: 'rel' | 'untilRel', target: string) =>
    write(changes.removeRelation, owner, field, target), [write]);

  // ── Chapters ──────────────────────────────────────────────────────────────
  const newChapter = useCallback((kind: ChapterKind = 'place', over: Partial<EditorState> = {}) =>
    openNew({ ...over, entry: blank({ chapter: kind, ...(over.entry ?? {}) }) }), [openNew]);
  const addDuring = useCallback((chapter: string) =>
    openNew({ during: chapter, entry: blank({ rel: { [chapter]: 'during' } }), fresh: (editorRef.current?.fresh ?? 0) + 1 }), [openNew]);
  const setChapter = useCallback((uid: string, kind: ChapterKind | null) => write(changes.setChapter, uid, kind), [write]);
  const setDuring = useCallback((uid: string, add: string[], remove: string[]) =>
    write(changes.setDuring, uid, add, remove), [write]);

  /** Ticking these chapters for this memory: the first that cannot hold it, said plainly. */
  const duringError = useCallback((uid: string, chosen: string[]): string | null => {
    const d = docRef.current;
    const me = d.events[uid];
    if (!me) return null;
    const rel: Record<string, Rel> = { ...(me.rel ?? {}) };
    for (const [c, r] of Object.entries(rel)) if (r === 'during' && !chosen.includes(c)) delete rel[c];
    for (const c of chosen) rel[c] = 'during';
    const trial = effectiveBounds({ birth: d.birth, events: { ...d.events, [uid]: { ...me, rel } } }, today);
    const bad = trial.entries.get(uid)?.conflicts.find(c => c.owner === uid && chosen.includes(c.target));
    if (!bad) return null;
    const c = d.events[bad.target];
    return `“${c?.title}” (${c ? chapterDates(c, d.birth) : ''}) doesn't fit this memory's date. Change one of the dates first.`;
  }, [today]);

  const chapterOptions = useMemo((): ChapterOption[] => {
    const spans = chapterSpans(doc, bounds);
    const colour = new Map(layout.bars.map(b => [b.uid, chapterColor(b.colorIndex)]));
    const range = editor ? bounds.entries.get(editor.uid)?.start : undefined;
    const overlaps = (uid: string) => {
      const s = spans.get(uid);
      return !!(s && range && s.from <= range.hi && range.lo <= s.to);
    };
    return Object.entries(events)
      .filter(([uid, e]) => e.chapter && uid !== editor?.uid)
      .sort(([a], [b]) => Number(overlaps(b)) - Number(overlaps(a))
        || (spans.get(a)?.from ?? Infinity) - (spans.get(b)?.from ?? Infinity) || (a < b ? -1 : 1))
      .map(([uid, e]) => ({ uid, title: e.title, kind: e.chapter!, color: colour.get(uid), dates: chapterDates(e, birth) }));
  }, [doc, bounds, layout, events, editor?.uid, birth]);

  const move = useCallback((uid: string, earlier: string | null, later: string | null) => {
    const d = docRef.current;
    const p = placeBetween(d, uid, earlier, later, today);
    if (!p.ok) { setNotice({ uid, message: p.reason }); return; }
    setNotice(null);
    write(changes.applyPlacement, uid, p.remove, p.add, p.when, calendarFields(p.when, d.events[uid]?.until));
  }, [today, write]);

  // ── Prompts & gaps ─────────────────────────────────────────────────────────
  const openPrompts = useMemo(() => Object.entries(prompts)
    .filter(([, p]) => p.source === 'photos' && !p.entry && !p.dismissed)
    .sort(([ka, a], [kb, b]) => (bestDay(b.when) ?? 0) - (bestDay(a.when) ?? 0) || (ka < kb ? -1 : 1)), [prompts]);
  const gaps = useMemo(() => largestGaps(doc, today).slice(0, 3), [doc, today]);

  // ── Chapter prompts ─────────────────────────────────────────────────────────
  const spans = useMemo(() => chapterSpans(doc, bounds), [doc, bounds]);
  const chipOf = useCallback((uid: string): ChapterChip => {
    const bar = layout.bars.find(b => b.uid === uid);
    const e = events[uid];
    return { uid, title: e?.title ?? '', icon: CHAPTER_KIND_META[e?.chapter ?? 'other'].icon, color: bar ? chapterColor(bar.colorIndex) : undefined };
  }, [layout, events]);
  /** One place card: the invitation (no places yet), or the stretch with nowhere to live most worth asking. */
  const placeCard = useMemo((): { gap: ChapterGap | null } | null => {
    if (!hasPlaces(doc)) return { gap: null };
    const top = placeGaps(doc, bounds, today)[0];
    return top ? { gap: top } : null;
  }, [doc, bounds, today]);
  const [chapterSkip, setChapterSkip] = useState<Set<string>>(() => new Set());
  const cards = useMemo(
    () => chapterCards(doc, bounds, order.ordered, layout, today).filter(c => !chapterSkip.has(c.uid)).slice(0, 2),
    [doc, bounds, order, layout, today, chapterSkip],
  );

  const placeGapPrompt = (gap: ChapterGap, extra: Partial<TimelinePrompt> = {}): TimelinePrompt => ({
    source: 'gap', chapter: 'place', when: { earliest: partialOf(gap.lo, 'month') }, until: { latest: partialOf(gap.hi, 'month') },
    added: nowIso(), ...extra,
  });
  const placeAdd = useCallback((gap: ChapterGap | null) => {
    if (!gap) { newChapter('place'); return; }
    // A first guess: the place filled the whole stretch. Its own dates are the user's to sharpen.
    const around = (day: number): FuzzyDate => ({ earliest: partialOf(day, 'year'), latest: partialOf(day, 'year'), best: partialOf(day, 'month') });
    newChapter('place', { gap: { key: 'gap-' + generateUid(), prompt: placeGapPrompt(gap) }, entry: blank({ when: around(gap.lo), until: around(gap.hi) }) });
  }, [newChapter]);
  const placeSkip = useCallback((gap: ChapterGap) => {
    write(changes.recordGap, 'gap-' + generateUid(), placeGapPrompt(gap, { dismissed: true }));
  }, [write]);

  const writePrompt = useCallback((key: string) => {
    const p = docRef.current.prompts[key];
    if (!p) return;
    openNew({
      promptKey: key,
      entry: clean(blank({
        when: p.when, until: p.until, location: p.location, coordinates: p.coordinates,
        links: p.links ? JSON.parse(JSON.stringify(p.links)) : undefined,
        participants: p.participants ? JSON.parse(JSON.stringify(p.participants)) : undefined,
      })),
    });
  }, [openNew]);

  const gapAdd = useCallback((gap: Gap) => {
    const when = gapWhen(gap);
    openNew({ gap: { key: 'gap-' + generateUid(), prompt: { source: 'gap', when, added: nowIso() } }, entry: blank({ when }) });
  }, [openNew]);
  const gapNothing = useCallback((gap: Gap) => {
    write(changes.recordGap, 'gap-' + generateUid(), { source: 'gap', when: gapWhen(gap), added: nowIso(), dismissed: true });
  }, [write]);

  // ── Pin down ───────────────────────────────────────────────────────────────
  const targets = useMemo(() => pinTargets(doc, today, bounds), [doc, today, bounds]);
  const question = useMemo(() => nextDateQuestion(doc, today, { skip, target: pinTarget ?? undefined }), [doc, today, skip, pinTarget]);
  useEffect(() => { if (pinTarget && !question) setPinTarget(null); }, [pinTarget, question]);
  const conflicts = useMemo(() => {
    const seen = new Map<string, Conflict>();
    for (const b of bounds.entries.values()) for (const c of b.conflicts) seen.set(`${c.owner}|${c.field}|${c.target}`, c);
    return [...seen.values()];
  }, [bounds]);

  const answer = useCallback((q: Question & { kind: 'anchor' }, rel: Rel) => {
    write(changes.answerRelation, q.uid, q.end === 'end' ? 'untilRel' : 'rel', q.anchor, rel);
  }, [write]);
  const pivot = useCallback((q: Question & { kind: 'pivot' }, ans: 'before' | 'after') => {
    const ev = docRef.current.events[q.uid];
    if (!ev) return;
    const field = q.end === 'end' ? 'until' : 'when';
    setDate(q.uid, field, applyPivotAnswer(ev[field], q.pivot, ans));
  }, [setDate]);
  const skipQuestion = useCallback((q: Question) => {
    if (pinTarget) setPinTarget(null);
    setSkip(prev => new Set(prev).add(targetKey(q)));
  }, [pinTarget]);
  const settle = useCallback((uid: string) => {
    if (pinTarget?.uid === uid) setPinTarget(null);
    patchEntry(uid, { settled: true });
  }, [pinTarget, patchEntry]);

  const revisit = useMemo(
    () => [...order.ordered, ...order.undated].filter(uid => events[uid]?.revisit !== undefined),
    [order, events],
  );

  const tabs = [
    { id: 'timeline', label: 'Timeline', count: Object.keys(events).length },
    { id: 'prompts', label: 'Prompts', count: (placeCard ? 1 : 0) + openPrompts.length + cards.length + gaps.length },
    { id: 'pin', label: 'Pin down', count: targets.length },
    { id: 'revisit', label: 'Revisit', count: revisit.length },
  ];

  return (
    <DocLoader docId={docId}>
    <>
      <DocumentTitleBar
        icon="timeline"
        title={name}
        titleEditable={canEdit}
        onRename={value => {
          if (!canEdit) return;
          const next = value.trim() || 'Timeline';
          setName(next);
          write(changes.rename, next);
        }}
        docId={docId}
        peers={peerList}
        peerTitle={peer => `${peerDisplayName(peer.peerId, peer.value?.userGroupId)}${peer.value?.focusedField ? ' (editing)' : ''}`}
        onToggleHistory={history.toggleHistory}
        historyActive={history.active}
        onUndo={canEdit ? undo : undefined}
        onRedo={canEdit ? redo : undefined}
        canUndo={canUndo}
        canRedo={canRedo}
        hasValidationErrors={validationErrors.length > 0}
        sourcePath={focusPath}
        action={canEdit && tab === 'timeline'
          ? { icon: 'swap_vert', label: arranging ? 'Done arranging' : 'Arrange', active: arranging, onSelect: () => setArranging(a => !a) }
          : undefined}
        overflow={[
          { icon: 'bookmark_add', label: 'New chapter', onSelect: () => newChapter(), disabled: !canEdit },
          { icon: 'cake', label: birth ? `Birth date (${formatFuzzy({ earliest: birth, latest: birth })})` : 'Set your birth date', onSelect: () => setBirthOpen(true), disabled: !canEdit },
        ]}
      />
      <HistorySlider history={history} />
      <div className="max-w-screen-md mx-auto w-full px-2 sm:px-4 pb-28" style={noAccess ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
        <PillTabs tabs={tabs} active={tab} onSelect={id => setTab(id as Tab)} data-testid="timeline-tabs" />

        {!birth && canEdit && (
          <button type="button" data-testid="timeline-birth-nudge"
            className="w-full text-left rounded-2xl border p-3 mb-2 text-sm state-layer" onClick={() => setBirthOpen(true)}>
            Add your birth date so the timeline can show ages and ask “before or after you turned 12?”
          </button>
        )}

        {notice && (
          <div className="rounded-xl border border-error p-3 mb-2 text-sm flex items-center gap-2" data-testid="timeline-move-refused">
            <span className="flex-1">{notice.message}</span>
            <button type="button" className="text-primary md-label-large" data-testid="timeline-widen"
              onClick={() => { const n = notice; setNotice(null); setEditor({ uid: n.uid, entry: events[n.uid], isNew: false, pane: 'tl-when' }); }}>
              Widen its date
            </button>
            <button type="button" aria-label="Dismiss" className="material-symbols-outlined" onClick={() => setNotice(null)}>close</button>
          </div>
        )}

        {tab === 'timeline' && (
          <TimelineList
            docId={docId}
            events={events}
            bounds={bounds}
            ordered={order.ordered}
            undated={order.undated}
            layout={layout}
            birth={birth}
            canEdit={canEdit}
            arranging={arranging}
            peerEditing={peerEditing}
            onOpen={uid => setEditor({ uid, entry: events[uid], isNew: false })}
            onInsert={(earlier, later) => openNew({ insert: { earlier, later } })}
            onMove={move}
            onGap={(lo, hi) => openNew({ entry: blank({ when: { earliest: String(lo), latest: String(hi) } }) })}
          />
        )}

        {tab === 'prompts' && (
          <div data-testid="timeline-prompts">
            {placeCard && <PlaceGapCard gap={placeCard.gap} birth={birth} canEdit={canEdit} onAdd={placeAdd} onSkip={placeSkip} />}
            {openPrompts.map(([key, p]) => (
              <PromptCard key={key} docId={docId} promptKey={key} prompt={p} birth={birth} canEdit={canEdit}
                onWrite={writePrompt} onSkip={k => write(changes.dismissPrompt, k)} />
            ))}
            {cards.map(c => (
              <ChapterCard key={c.uid} chip={chipOf(c.uid)} dates={chapterDates(events[c.uid], birth)} memories={c.memories}
                question={CHAPTER_QUESTION[events[c.uid].chapter!]} canEdit={canEdit}
                onAdd={addDuring} onLater={uid => setChapterSkip(prev => new Set(prev).add(uid))} />
            ))}
            {gaps.map(g => (
              <GapCard key={`${g.lo}-${g.hi}`} gap={g} birth={birth} canEdit={canEdit} onAdd={gapAdd} onNothing={gapNothing}
                backThen={chaptersAt(spans, Math.floor((g.lo + g.hi) / 2)).map(c => chipOf(c.uid))} />
            ))}
            {!placeCard && openPrompts.length === 0 && cards.length === 0 && gaps.length === 0 && (
              <p className="text-sm text-muted-foreground py-4">No prompts right now.</p>
            )}
          </div>
        )}

        {tab === 'pin' && (
          <div data-testid="timeline-pin">
            <ConflictList conflicts={conflicts} titleOf={titleOf} canEdit={canEdit}
              onRemove={c => removeRelation(c.owner, c.field, c.target)} />
            <PinDownCard question={question} doc={doc} birth={birth} canEdit={canEdit}
              onAnswer={answer} onPivot={pivot} onSkip={skipQuestion} onSettle={settle} />
          </div>
        )}

        {tab === 'revisit' && (
          <md-list style={{ background: 'transparent' }} data-testid="timeline-revisit">
            {revisit.map(uid => (
              <ListRow key={uid} data-testid="revisit-row" onTap={() => setEditor({ uid, entry: events[uid], isNew: false })}>
                <span slot="start" aria-hidden="true" className="material-symbols-outlined text-lg">flag</span>
                <div slot="headline">{events[uid].title}</div>
                <div slot="supporting-text">{events[uid].revisit || formatFuzzy(events[uid].when, birth)}</div>
              </ListRow>
            ))}
            {revisit.length === 0 && <p className="text-sm text-muted-foreground py-4">Nothing flagged to revisit.</p>}
          </md-list>
        )}
      </div>

      {canEdit && tab === 'timeline' && <Fab icon="add" aria-label="New entry" onClick={() => openNew()} />}

      <EntryEditor
        key={editor?.fresh ?? 0}
        docId={docId}
        uid={editor?.uid ?? ''}
        entry={editor?.entry ?? blank()}
        isNew={editor?.isNew ?? false}
        opened={!!editor}
        canEdit={canEdit}
        birth={birth}
        bounds={editor ? bounds.entries.get(editor.uid) : undefined}
        titleOf={titleOf}
        initialPane={editor?.pane ?? null}
        onCreate={createEntry}
        chapters={chapterOptions}
        duringError={duringError}
        onSetChapter={setChapter}
        onSetDuring={setDuring}
        onAddDuring={addDuring}
        onPatch={patchEntry}
        onRemoveParticipant={removeParticipant}
        onSetEmotions={setEmotions}
        onSetDate={setDate}
        onDelete={deleteEntry}
        onPinDown={uid => { setEditor(null); setPinTarget({ uid, end: 'start' }); setTab('pin'); }}
        onRemoveConflict={removeRelation}
        onClose={() => setEditor(null)}
        onFieldFocus={setFocusedPath}
        peerFocusedFields={peerFocusedFields}
      />

      <FieldSheet
        open={birthOpen}
        title="Your birth date"
        data-testid="timeline-birth"
        fieldTestId="timeline-birth"
        value={birth ?? ''}
        validate={v => !v.trim() || !!parsePartial(v.trim())}
        onClose={() => setBirthOpen(false)}
        onSave={v => { write(changes.setBirth, v.trim() || null); setBirthOpen(false); }}
      >
        {({ value, onInput, save }) => (
          <MdTextField label="Birth date" supportingText="YYYY-MM-DD (or just YYYY)" data-testid="timeline-birth-input"
            value={value} onInput={onInput} onEnter={save} />
        )}
      </FieldSheet>

      {confirmSheet}
    </>
    </DocLoader>
  );
}
