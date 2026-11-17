/**
 * One timeline entry in a PropertySheet: one property per row, one thing
 * edited at a time, one document change per Save.
 *
 * A brand-new entry opens straight in its title pane. Enter saves it and opens
 * the next blank one in the same place (so a run of memories can be typed in
 * order); the Save button lands on the property list instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { PropertySheet, type PropertyDef } from '../../common/PropertySheet';
import { FieldEditor, GroupEditor } from '../../common/FieldEditor';
import { SheetActions, SheetActionItem } from '../../common/SheetActionItem';
import { MdTextField } from '@/components/ui/md-text-field';
import { MdSelect } from '@/components/ui/md-select';
import { Checkbox } from '@/components/ui/checkbox';
import type { PeerFieldInfo } from '../../common/presence';
import type { TimelineEvent } from '../../../../shared/schemas/timeline';
import type { EntryBounds } from '../../../../shared/timeline/order';
import { formatFuzzy, formatDayRange, type FuzzyDate } from '../../../../shared/timeline/fuzzy-date';
import { Thumb } from './Thumb';
import { FuzzyDatePane as FuzzyDatePaneFor } from './FuzzyDatePane';

/** Editor input id → the entry property it edits (presence paths). */
export const FIELD_TO_PROP: Record<string, string> = {
  'tl-title': 'title',
  'tl-when': 'when',
  'tl-until': 'until',
  'tl-story': 'description',
  'tl-place': 'location',
  'tl-recall': 'recall',
  'tl-revisit': 'revisit',
};
export const PROP_TO_FIELDS: Record<string, string[]> = Object.fromEntries(
  Object.entries(FIELD_TO_PROP).map(([id, prop]) => [prop, [id]]),
);

const RECALL_OPTIONS = [
  { value: '', label: 'Not said' },
  { value: 'vivid', label: 'Vivid — I remember it clearly' },
  { value: 'hazy', label: 'Hazy — only roughly' },
];

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
  /** A new entry's title: creates it. `viaEnter` chains to another new entry. */
  onCreate: (uid: string, title: string, viaEnter: boolean) => void;
  onPatch: (uid: string, patch: EntryPatch) => void;
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
  const conflicts = bounds?.conflicts ?? [];

  const properties: PropertyDef[] = useMemo(() => [
    {
      id: 'tl-title',
      label: 'Title',
      icon: 'edit',
      summary: () => title,
      transactional: true,
      render: ({ back }) => (
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
            <MdTextField label="What happened?" data-testid="tl-title" value={value} onInput={onInput}
              onFocus={() => focusField('tl-title')} onBlur={blurField}
              onEnter={() => { viaEnter.current = true; save(); }} />
          )}
        </FieldEditor>
      ),
    },
    {
      id: 'tl-when',
      label: entry.until ? 'From' : 'When',
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
      label: 'Until (for a period of life)',
      icon: 'date_range',
      hidden: isNew,
      transactional: true,
      summary: () => (entry.until ? formatFuzzy(entry.until, birth) : ''),
      render: ({ back }) => (
        <FuzzyDatePaneFor idPrefix="tl-until" value={entry.until} birth={birth} hint={untilHint}
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
      summary: () => entry.location ?? '',
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
  ], [uid, isNew, entry, title, birth, whenHint, untilHint, focusField, blurField]);

  const banner = (photoIds.length > 0 || conflicts.length > 0) ? (
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
      title={isNew ? 'New entry' : (entry.title || 'Entry')}
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
