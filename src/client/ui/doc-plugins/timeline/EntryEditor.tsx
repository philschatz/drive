/**
 * One timeline entry in a PropertySheet: one property per row, one thing
 * edited at a time, one document change per Save.
 *
 * A brand-new entry opens straight in its title pane. Enter saves it and opens
 * the next blank one in the same place (so a run of memories can be typed in
 * order); the Save button lands on the property list instead.
 *
 * A chapter is an entry too. A new one opens on a pane holding its kind and
 * name together (one Save, one change); an existing entry becomes a chapter,
 * or stops being one, from its "Chapter" dropdown. A memory's "During" pane
 * says which chapters it happened in — the order relation `during`, which
 * narrows its date.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { PropertySheet, type PropertyDef } from '../../common/PropertySheet';
import { FieldEditor, GroupEditor } from '../../common/FieldEditor';
import { SheetActions, SheetActionItem } from '../../common/SheetActionItem';
import { MdTextField } from '@/components/ui/md-text-field';
import { MdSelect } from '@/components/ui/md-select';
import { Checkbox } from '@/components/ui/checkbox';
import type { PeerFieldInfo } from '../../common/presence';
import { CHAPTER_KINDS, type ChapterKind, type TimelineEvent } from '../../../../shared/schemas/timeline';
import { isDated } from '../../../../shared/timeline/fuzzy-date';
import type { EntryBounds } from '../../../../shared/timeline/order';
import { formatFuzzy, formatDayRange, type FuzzyDate } from '../../../../shared/timeline/fuzzy-date';
import { Thumb } from './Thumb';
import { mapUrl, geoText } from './map-link';
import { FuzzyDatePane as FuzzyDatePaneFor, ENDED_UNKNOWN } from './FuzzyDatePane';
import { CHAPTER_KIND_META } from './chapter-kinds';
import {
  GENERIC_EMOTIONS, EMOTION_GROUPS, VOCABULARY_KEYS, normalizeEmotion, emotionLabel, sortEmotions,
} from '../../../../shared/timeline/emotions';

/** Editor input id → the entry property it edits (presence paths). */
export const FIELD_TO_PROP: Record<string, string> = {
  'tl-title': 'title',
  'tl-when': 'when',
  'tl-until': 'until',
  'tl-story': 'description',
  'tl-place': 'location',
  'tl-emotions': 'emotions',
  'tl-recall': 'recall',
  'tl-revisit': 'revisit',
  'tl-chapter': 'chapter',
  'tl-during': 'rel',
};
export const PROP_TO_FIELDS: Record<string, string[]> = Object.fromEntries(
  Object.entries(FIELD_TO_PROP).map(([id, prop]) => [prop, [id]]),
);

const RECALL_OPTIONS = [
  { value: '', label: 'Not said' },
  { value: 'vivid', label: 'Vivid — I remember it clearly' },
  { value: 'hazy', label: 'Hazy — only roughly' },
];

const CHAPTER_OPTIONS = [
  { value: '', label: 'Not a chapter' },
  ...CHAPTER_KINDS.map(k => ({ value: k, label: `${CHAPTER_KIND_META[k].label} — ${CHAPTER_KIND_META[k].hint}` })),
];
const NEW_KIND_OPTIONS = CHAPTER_KINDS.map(k => ({ value: k, label: `${CHAPTER_KIND_META[k].label} — ${CHAPTER_KIND_META[k].hint}` }));

/** A chapter the During pane can offer. */
export interface ChapterOption { uid: string; title: string; kind: ChapterKind; color?: string; dates: string }

/** Changes the editor asks for. `null` clears a field. */
export type EntryPatch = Partial<Record<'title' | 'description' | 'location' | 'recall' | 'revisit' | 'settled', string | true | null>>;

export interface EntryEditorProps {
  docId?: string;
  uid: string;
  entry: TimelineEvent;
  isNew: boolean;
  opened: boolean;
  canEdit: boolean;
  birth?: string;
  /** What the rest of the timeline says about this entry's dates. */
  bounds?: EntryBounds;
  /** Entry titles, for naming the entries a range or conflict comes from. */
  titleOf: (uid: string) => string;
  /** The pane to open into, for an existing entry (e.g. "Widen its date"). */
  initialPane?: string | null;
  /** A new entry's title (and a new chapter's kind): creates it. `viaEnter` chains to another new entry. */
  onCreate: (uid: string, title: string, viaEnter: boolean, kind?: ChapterKind) => void;
  /** Every chapter, the likeliest for this entry first (the During pane). */
  chapters?: ChapterOption[];
  /** Why ticking these chapters would contradict the entry's dates, or null. */
  duringError?: (uid: string, chapters: string[]) => string | null;
  onSetChapter?: (uid: string, kind: ChapterKind | null) => void;
  onSetDuring?: (uid: string, add: string[], remove: string[]) => void;
  /** A chapter's "Add a memory during this chapter". */
  onAddDuring?: (chapterUid: string) => void;
  onPatch: (uid: string, patch: EntryPatch) => void;
  /** Add and take away emotion keys (shared/timeline/emotions.ts). */
  onSetEmotions?: (uid: string, add: string[], remove: string[]) => void;
  /** Take one person off a saved entry. */
  onRemoveParticipant?: (uid: string, participantId: string) => void;
  onSetDate: (uid: string, field: 'when' | 'until', value: FuzzyDate | null) => void;
  onDelete: (uid: string) => void;
  onPinDown: (uid: string) => void;
  onRemoveConflict: (owner: string, field: 'rel' | 'untilRel', target: string) => void;
  onClose: () => void;
  onFieldFocus?: (path: (string | number)[] | null) => void;
  peerFocusedFields?: Record<string, PeerFieldInfo>;
}

export function EntryEditor(p: EntryEditorProps) {
  const { uid, entry, isNew, opened, canEdit, birth, bounds } = p;
  const chapters = p.chapters ?? [];
  const isChapterEntry = !!entry.chapter;
  const during = chapters.filter(c => entry.rel?.[c.uid] === 'during').map(c => c.uid);
  const [title, setTitle] = useState(entry.title || '');
  const prevUid = useRef(uid);
  useEffect(() => {
    if (prevUid.current !== uid) { prevUid.current = uid; setTitle(entry.title || ''); }
  }, [uid, entry.title]);
  useEffect(() => { if (!isNew) setTitle(entry.title || ''); }, [entry.title, isNew]);

  const focusField = useCallback((id: string) => {
    const prop = FIELD_TO_PROP[id];
    if (prop) p.onFieldFocus?.(['events', uid, prop]);
  }, [uid, p.onFieldFocus]);
  const blurField = useCallback(() => p.onFieldFocus?.(null), [p.onFieldFocus]);
  const viaEnter = useRef(false);

  const range = (r?: { lo: number; hi: number }) => (r ? formatDayRange(r.lo, r.hi) : '');
  const why = (r?: { loBy?: { uid: string; rel: string }; hiBy?: { uid: string; rel: string } }) => {
    const parts = [r?.loBy, r?.hiBy].filter(Boolean).map(b => `${b!.rel} “${p.titleOf(b!.uid)}”`);
    return [...new Set(parts)].join(', ');
  };
  const whenHint = bounds && bounds.placed && (bounds.start.loBy || bounds.start.hiBy)
    ? `Known from other entries: ${range(bounds.start)} (${why(bounds.start)})` : undefined;
  const untilHint = bounds?.end && (bounds.end.loBy || bounds.end.hiBy)
    ? `Known from other entries: ${range(bounds.end)} (${why(bounds.end)})` : undefined;

  const whenSummary = () => {
    const own = formatFuzzy(entry.when, birth);
    if (entry.when || !bounds?.placed) return own;
    return `≈ ${range(bounds.start)}`;
  };

  const photoIds = Object.keys(entry.links ?? {});
  const people = Object.entries(entry.participants ?? {});
  const conflicts = bounds?.conflicts ?? [];

  const properties: PropertyDef[] = useMemo(() => [
    {
      id: 'tl-title',
      label: isChapterEntry ? 'Name' : 'Title',
      icon: 'edit',
      summary: () => title,
      transactional: true,
      render: ({ back }) => isNew && isChapterEntry ? (
        <GroupEditor<{ kind: ChapterKind; title: string }>
          key={uid}
          data-testid="tl-title"
          value={{ kind: entry.chapter!, title }}
          validate={v => !!v.title.trim()}
          onCancel={back}
          onSave={v => {
            const enter = viaEnter.current;
            viaEnter.current = false;
            const t = v.title.trim();
            if (enter) setTitle(''); else setTitle(t);
            p.onCreate(uid, t, enter, v.kind);
            if (!enter) back();
          }}
        >
          {({ draft, patch, save }) => (
            <div className="flex flex-col gap-3">
              <MdSelect label="What kind of chapter?" data-testid="tl-chapter-kind" value={draft.kind}
                options={NEW_KIND_OPTIONS} onValueChange={v => patch({ kind: v as ChapterKind })} />
              <MdTextField label="Name this chapter" supportingText="e.g. Chicago apartment, Dating Jamie, Acme, The pandemic"
                data-testid="tl-title" value={draft.title} onInput={v => patch({ title: v })}
                onFocus={() => focusField('tl-title')} onBlur={blurField}
                onEnter={() => { viaEnter.current = true; save(); }} />
            </div>
          )}
        </GroupEditor>
      ) : (
        <FieldEditor
          key={uid}
          data-testid="tl-title"
          value={title}
          validate={v => !!v.trim()}
          onCancel={back}
          onSave={v => {
            const enter = viaEnter.current;
            viaEnter.current = false;
            const t = v.trim();
            if (isNew) {
              // Clear before the parent swaps the uid: the keyed remount would
              // otherwise seed the next entry's draft from this title.
              if (enter) setTitle(''); else setTitle(t);
              p.onCreate(uid, t, enter);
              if (!enter) back();
              return;
            }
            setTitle(t);
            p.onPatch(uid, { title: t });
            back();
          }}
        >
          {({ value, onInput, save }) => (
            <MdTextField label={isChapterEntry ? 'Name' : 'What happened?'} data-testid="tl-title" value={value} onInput={onInput}
              onFocus={() => focusField('tl-title')} onBlur={blurField}
              onEnter={() => { viaEnter.current = true; save(); }} />
          )}
        </FieldEditor>
      ),
    },
    {
      id: 'tl-when',
      label: isChapterEntry ? 'Began' : entry.until ? 'From' : 'When',
      icon: 'event',
      hidden: isNew,
      transactional: true,
      summary: whenSummary,
      render: ({ back }) => (
        <FuzzyDatePaneFor idPrefix="tl-when" value={entry.when} birth={birth} hint={whenHint}
          onCancel={back} onFocus={() => focusField('tl-when')} onBlur={blurField}
          onSave={v => { p.onSetDate(uid, 'when', v); back(); }} />
      ),
    },
    {
      id: 'tl-until',
      label: 'Until',
      icon: 'date_range',
      hidden: isNew,
      transactional: true,
      summary: () => (isChapterEntry
        ? (!entry.until ? 'Still going' : isDated(entry.until) ? formatFuzzy(entry.until, birth) : ENDED_UNKNOWN)
        : entry.until ? formatFuzzy(entry.until, birth) : ''),
      render: ({ back }) => (
        <FuzzyDatePaneFor idPrefix="tl-until" value={entry.until} birth={birth} hint={untilHint} ongoing={isChapterEntry}
          onCancel={back} onFocus={() => focusField('tl-until')} onBlur={blurField}
          onSave={v => { p.onSetDate(uid, 'until', v); back(); }} />
      ),
    },
    {
      id: 'tl-story',
      label: 'Story',
      icon: 'notes',
      hidden: isNew,
      transactional: true,
      summary: () => entry.description ?? '',
      render: ({ back }) => (
        <FieldEditor key={uid} data-testid="tl-story" value={entry.description ?? ''} onCancel={back}
          onSave={v => { p.onPatch(uid, { description: v.trim() ? v : null }); back(); }}>
          {({ value, onInput }) => (
            <MdTextField label="Story" type="textarea" rows={8} data-testid="tl-story" value={value} onInput={onInput}
              onFocus={() => focusField('tl-story')} onBlur={blurField} />
          )}
        </FieldEditor>
      ),
    },
    {
      id: 'tl-place',
      label: 'Place',
      icon: 'place',
      hidden: isNew,
      transactional: true,
      // The name you gave it; a place known only by its coordinates shows those.
      summary: () => entry.location || geoText(entry.coordinates),
      inline: () => {
        const map = mapUrl(entry.coordinates);
        return map && (
          <a href={map} target="_blank" rel="noopener noreferrer" title="Show on a map" aria-label="Show on a map"
            data-testid="tl-place-map" className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer"
            // The row opens the Place pane on click; the map link must not.
            onClick={(e: Event) => e.stopPropagation()}>
            <md-icon>map</md-icon>
          </a>
        );
      },
      render: ({ back }) => (
        <FieldEditor key={uid} data-testid="tl-place" value={entry.location ?? ''} onCancel={back}
          onSave={v => { p.onPatch(uid, { location: v.trim() || null }); back(); }}>
          {({ value, onInput, save }) => (
            <MdTextField label="Place" data-testid="tl-place" value={value} onInput={onInput} onEnter={save}
              onFocus={() => focusField('tl-place')} onBlur={blurField} />
          )}
        </FieldEditor>
      ),
    },
    {
      id: 'tl-emotions',
      label: 'Feelings',
      icon: 'mood',
      hidden: isNew,
      transactional: true,
      summary: () => sortEmotions(Object.keys(entry.emotions ?? {})).map(emotionLabel).join(', '),
      render: ({ back }) => {
        const saved = Object.keys(entry.emotions ?? {});
        return (
          <GroupEditor<{ set: string[]; own: string }>
            key={uid}
            data-testid="tl-emotions"
            value={{ set: saved, own: '' }}
            onCancel={back}
            onSave={v => {
              p.onSetEmotions?.(uid, v.set.filter(k => !saved.includes(k)), saved.filter(k => !v.set.includes(k)));
              back();
            }}
          >
            {({ draft, patch }) => {
              const toggle = (k: string) => patch({ set: draft.set.includes(k) ? draft.set.filter(x => x !== k) : [...draft.set, k] });
              const chip = (k: string, label: string) => {
                const on = draft.set.includes(k);
                return (
                  <button key={k} type="button" data-testid={`tl-emotion-${k}`} aria-pressed={on} onClick={() => toggle(k)}
                    className={'inline-flex items-center rounded-full px-3 h-8 md-label-large state-layer border' +
                      (on ? ' bg-secondary-container text-on-secondary-container border-transparent font-semibold' : ' text-muted-foreground')}>
                    {label}
                  </button>
                );
              };
              const own = sortEmotions(draft.set.filter(k => !VOCABULARY_KEYS.includes(k)));
              const typed = normalizeEmotion(draft.own);
              const add = () => { if (typed) patch({ set: draft.set.includes(typed) ? draft.set : [...draft.set, typed], own: '' }); };
              const group = (title: string, chips: preact.ComponentChildren) => (
                <section className="flex flex-col gap-1.5">
                  <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{title}</h3>
                  <div className="flex flex-wrap gap-1.5">{chips}</div>
                </section>
              );
              return (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">How did it feel? Pick as many as fit, broad or nuanced.</p>
                  {group('General', GENERIC_EMOTIONS.map(e => chip(e, emotionLabel(e))))}
                  {EMOTION_GROUPS.map(g => <div key={g.key}>{group(g.label, g.emotions.map(e => chip(`${g.key}:${e}`, emotionLabel(e))))}</div>)}
                  {own.length > 0 && group('Your own', own.map(k => chip(k, k)))}
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <MdTextField label="Add your own, e.g. relational:left-out" data-testid="tl-emotion-own" value={draft.own}
                        onInput={v => patch({ own: v })} onEnter={add}
                        onFocus={() => focusField('tl-emotions')} onBlur={blurField} />
                    </div>
                    <button type="button" data-testid="tl-emotion-add" disabled={!typed} onClick={add}
                      className="h-10 px-3 rounded-full text-primary md-label-large state-layer disabled:opacity-40">Add</button>
                  </div>
                  {draft.own.trim() && !typed && (
                    <p className="text-sm text-error" data-testid="tl-emotion-invalid">Up to three parts separated by ":", e.g. temporal:nostalgic:for-college</p>
                  )}
                </div>
              );
            }}
          </GroupEditor>
        );
      },
    },
    {
      id: 'tl-recall',
      label: 'How well you remember it',
      icon: 'psychology',
      hidden: isNew,
      summary: () => RECALL_OPTIONS.find(o => o.value === (entry.recall ?? ''))?.label.split(' —')[0] ?? '',
      render: ({ back }) => (
        <MdSelect label="How well you remember it" data-testid="tl-recall" value={entry.recall ?? ''}
          options={RECALL_OPTIONS} onFocus={() => focusField('tl-recall')}
          onValueChange={v => { p.onPatch(uid, { recall: v || null }); blurField(); back(); }} />
      ),
    },
    {
      id: 'tl-revisit',
      label: 'Revisit later',
      icon: 'flag',
      hidden: isNew,
      transactional: true,
      summary: () => (entry.revisit === undefined ? '' : entry.revisit || 'Yes'),
      render: ({ back }) => (
        <GroupEditor<{ on: boolean; note: string }>
          key={uid}
          data-testid="tl-revisit"
          value={{ on: entry.revisit !== undefined, note: entry.revisit ?? '' }}
          onCancel={back}
          onSave={v => { p.onPatch(uid, { revisit: v.on ? v.note.trim() : null }); back(); }}
        >
          {({ draft, patch }) => (
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox data-testid="tl-revisit-on" checked={draft.on}
                  onCheckedChange={(c: boolean | 'indeterminate') => patch({ on: c === true })} />
                Come back to this entry
              </label>
              <MdTextField label="What to add (optional)" data-testid="tl-revisit-note" value={draft.note}
                onInput={v => patch({ note: v, on: draft.on || !!v.trim() })}
                onFocus={() => focusField('tl-revisit')} onBlur={blurField} />
            </div>
          )}
        </GroupEditor>
      ),
    },
    {
      id: 'tl-during',
      label: 'During',
      icon: 'bookmarks',
      hidden: isNew || isChapterEntry || chapters.length === 0,
      transactional: true,
      summary: () => chapters.filter(c => during.includes(c.uid)).map(c => c.title).join(', '),
      render: ({ back }) => (
        <GroupEditor<{ set: string[] }>
          key={uid}
          data-testid="tl-during"
          value={{ set: during }}
          validate={v => !p.duringError?.(uid, v.set)}
          onCancel={back}
          onSave={v => {
            p.onSetDuring?.(uid, v.set.filter(c => !during.includes(c)), during.filter(c => !v.set.includes(c)));
            back();
          }}
        >
          {({ draft, patch }) => {
            const error = p.duringError?.(uid, draft.set);
            return (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">Which chapters of your life did this happen during?</p>
                {chapters.map(c => (
                  <label key={c.uid} className="flex items-center gap-2 text-sm">
                    <Checkbox data-testid={`tl-during-${c.uid}`} checked={draft.set.includes(c.uid)}
                      onCheckedChange={(on: boolean | 'indeterminate') => patch({
                        set: on === true ? [...draft.set, c.uid] : draft.set.filter(x => x !== c.uid),
                      })} />
                    <span aria-hidden="true" className="material-symbols-outlined text-lg" style={c.color ? { color: c.color } : undefined}>
                      {CHAPTER_KIND_META[c.kind].icon}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate">{c.title}</span>
                      <span className="block text-xs text-muted-foreground">{c.dates}</span>
                    </span>
                  </label>
                ))}
                {error && <p className="text-sm text-error" data-testid="tl-during-error">{error}</p>}
              </div>
            );
          }}
        </GroupEditor>
      ),
    },
    {
      id: 'tl-chapter',
      label: 'Chapter',
      icon: entry.chapter ? CHAPTER_KIND_META[entry.chapter].icon : 'bookmark',
      hidden: isNew,
      summary: () => (entry.chapter ? CHAPTER_KIND_META[entry.chapter].label : 'Not a chapter'),
      render: ({ back }) => (
        <MdSelect label="A chapter of your life?" data-testid="tl-chapter" value={entry.chapter ?? ''}
          options={CHAPTER_OPTIONS} onFocus={() => focusField('tl-chapter')}
          onValueChange={v => { p.onSetChapter?.(uid, (v || null) as ChapterKind | null); blurField(); back(); }} />
      ),
    },
  ], [uid, isNew, entry, title, birth, whenHint, untilHint, focusField, blurField, chapters, during.join('|'), p.duringError]);

  const banner = (photoIds.length > 0 || people.length > 0 || conflicts.length > 0) ? (
    <div className="flex flex-col gap-2">
      {photoIds.length > 0 && (
        <div className="flex gap-2 overflow-x-auto" data-testid="tl-photos">
          {photoIds.map(id => {
            const href = entry.links![id].href;
            return (
              <a key={id} href={href} target="_blank" rel="noopener noreferrer" title="Open the photo">
                <Thumb docId={p.docId} photoId={id} size={56} />
              </a>
            );
          })}
        </div>
      )}
      {people.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center text-sm" data-testid="tl-people">
          <span className="text-muted-foreground">With</span>
          {people.map(([pid, person]) => (
            <span key={pid} data-testid="tl-person" className="rounded-full border px-2 py-0.5 flex items-center gap-1">
              {person.name || 'Someone'}
              {canEdit && !isNew && p.onRemoveParticipant && (
                <button type="button" aria-label={`Remove ${person.name || 'this person'}`} data-testid="tl-person-remove"
                  className="material-symbols-outlined text-[16px] leading-none"
                  onClick={() => p.onRemoveParticipant!(uid, pid)}>close</button>
              )}
            </span>
          ))}
        </div>
      )}
      {conflicts.map(c => (
        <div key={`${c.owner}|${c.field}|${c.target}`} data-testid="tl-conflict"
          className="rounded-xl border border-error p-2 text-sm flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-error">error</span>
          <span className="flex-1">
            “{p.titleOf(c.owner)}” {c.field === 'untilRel' ? 'ended' : 'was'} {c.rel} “{p.titleOf(c.target)}”
            {c.reason === 'contradicts-answer' ? ' contradicts another answer.' : ' doesn’t fit their dates.'}
          </span>
          {canEdit && (
            <button type="button" className="text-primary md-label-large" data-testid="tl-conflict-remove"
              onClick={() => p.onRemoveConflict(c.owner, c.field, c.target)}>Remove</button>
          )}
        </div>
      ))}
    </div>
  ) : undefined;

  const footer = !isNew ? (
    <SheetActions>
      {canEdit && isChapterEntry && (
        <SheetActionItem icon="add" label="Add a memory during this chapter" data-testid="tl-add-during"
          onClick={() => p.onAddDuring?.(uid)} />
      )}
      {canEdit && !entry.settled && (
        <SheetActionItem icon="center_focus_strong" label="Pin down the date" data-testid="tl-pin" onClick={() => p.onPinDown(uid)} />
      )}
      {canEdit && (
        <SheetActionItem
          icon={entry.settled ? 'lock_open' : 'lock'}
          label={entry.settled ? 'Ask about this date again' : 'This date is as good as it gets'}
          data-testid="tl-settled"
          onClick={() => p.onPatch(uid, { settled: entry.settled ? null : true })}
        />
      )}
      {canEdit && (
        <SheetActionItem icon="delete" label="Delete" destructive data-testid="tl-delete" onClick={() => p.onDelete(uid)} />
      )}
    </SheetActions>
  ) : undefined;

  return (
    <PropertySheet
      open={opened}
      title={isNew ? (isChapterEntry ? 'New chapter' : 'New entry') : (entry.title || (isChapterEntry ? 'Chapter' : 'Entry'))}
      properties={canEdit ? properties : properties.map(d => ({ ...d, render: undefined }))}
      peerFocusedFields={p.peerFocusedFields}
      initialDetailId={isNew ? 'tl-title' : (p.initialPane ?? null)}
      onClose={p.onClose}
      footer={footer}
      banner={banner}
      data-testid="timeline-editor"
    />
  );
}
