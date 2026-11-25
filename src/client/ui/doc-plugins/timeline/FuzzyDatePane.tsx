/**
 * The "When" / "Until" pane: how precise the date is (a preset), then only the
 * fields that preset needs. Every field lives in one draft, so switching
 * presets keeps what was typed, and Save is one document change.
 *
 * `ongoing` (a chapter's end): "Still going" saves no `until` at all, and
 * "Unknown" becomes "Ended — not sure when", saved as `{}`.
 */
import { GroupEditor } from '../../common/FieldEditor';
import { MdSelect } from '@/components/ui/md-select';
import { MdTextField } from '@/components/ui/md-text-field';
import {
  type FuzzyDate, type PresetDraft, type PresetKind, type Season, PRESET_LABELS,
  draftOf, fromDraft, formatFuzzy,
} from '../../../../shared/timeline/fuzzy-date';

const MONTH_OPTIONS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'].map((label, i) => ({ value: String(i + 1), label }));
const SEASON_OPTIONS: { value: Season; label: string }[] = [
  { value: 'spring', label: 'Spring (Mar–May)' },
  { value: 'summer', label: 'Summer (Jun–Aug)' },
  { value: 'autumn', label: 'Autumn (Sep–Nov)' },
  { value: 'winter', label: 'Winter (Dec–Feb)' },
];
const PARTIAL_HINT = 'YYYY, YYYY-MM or YYYY-MM-DD';
export const ENDED_UNKNOWN = 'Ended — not sure when';

export function FuzzyDatePane({
  idPrefix, value, birth, hint, onSave, onCancel, allowAge = true, ongoing = false,
}: {
  /** 'tl-when' / 'tl-until': testids and ids, kept apart so the two panes never share a draft. */
  idPrefix: string;
  value: FuzzyDate | undefined;
  birth?: string;
  /** What the rest of the timeline already says, e.g. "Known: 2009–2011 (after “Moved”)". */
  hint?: string;
  /** null = clear the date. */
  onSave: (value: FuzzyDate | null) => void;
  onCancel: () => void;
  allowAge?: boolean;
  /** A chapter's end: offer "Still going". */
  ongoing?: boolean;
}) {
  const kinds = (Object.keys(PRESET_LABELS) as PresetKind[])
    .filter(k => (k !== 'age' || (allowAge && !!birth)) && (k !== 'ongoing' || ongoing));
  const label = (k: PresetKind) => (ongoing && k === 'unknown' ? ENDED_UNKNOWN : PRESET_LABELS[k]);
  const options = kinds.map(k => ({ value: k, label: label(k) }));
  const seed = ongoing && value === undefined ? { ...draftOf(undefined, birth), kind: 'ongoing' as PresetKind } : draftOf(value, birth);
  const field = (suffix: string) => `${idPrefix}-${suffix}`;

  return (
    <GroupEditor<PresetDraft>
      key={idPrefix}
      data-testid={idPrefix}
      value={seed}
      validate={d => fromDraft(d, birth) !== null}
      onCancel={onCancel}
      onSave={d => {
        const next = fromDraft(d, birth);
        if (next === null) return;
        onSave(ongoing && d.kind === 'unknown' ? {} : next ?? null);
      }}
    >
      {({ draft, patch }) => {
        const result = fromDraft(draft, birth);
        const year = (label = 'Year') => (
          <MdTextField label={label} type="number" data-testid={field('year')} value={draft.year}
            onInput={v => patch({ year: v })} />
        );
        return (
          <div className="flex flex-col gap-3" data-testid={`${idPrefix}-pane`}>
            {hint && <p className="text-sm text-muted-foreground" data-testid={field('hint')}>{hint}</p>}
            <MdSelect label="How precise?" data-testid={field('kind')} value={draft.kind} options={options}
              onValueChange={v => patch({ kind: v as PresetKind })} />
            {draft.kind === 'day' && (
              <MdTextField label="Date" type="date" data-testid={field('day')} value={draft.day}
                onInput={v => patch({ day: v })} />
            )}
            {draft.kind === 'month' && (
              <div className="flex gap-2">
                <MdSelect label="Month" data-testid={field('month')} value={draft.month} options={MONTH_OPTIONS}
                  onValueChange={v => patch({ month: v })} />
                {year()}
              </div>
            )}
            {draft.kind === 'season' && (
              <div className="flex gap-2">
                <MdSelect label="Season" data-testid={field('season')} value={draft.season} options={SEASON_OPTIONS}
                  onValueChange={v => patch({ season: v as Season })} />
                {year()}
              </div>
            )}
            {draft.kind === 'year' && year()}
            {draft.kind === 'decade' && year('First year of the decade (e.g. 1990)')}
            {draft.kind === 'around' && (
              <div className="flex gap-2">
                {year()}
                <MdTextField label="Give or take (years)" type="number" min={1} data-testid={field('spread')}
                  value={draft.spread} onInput={v => patch({ spread: v })} />
              </div>
            )}
            {draft.kind === 'age' && (
              <MdTextField label="Your age" type="number" min={0} data-testid={field('age')} value={draft.age}
                onInput={v => patch({ age: v })} />
            )}
            {(draft.kind === 'between' || draft.kind === 'after') && (
              <MdTextField label={draft.kind === 'after' ? 'After' : 'From'} supportingText={PARTIAL_HINT}
                data-testid={field('from')} value={draft.from} onInput={v => patch({ from: v })} />
            )}
            {(draft.kind === 'between' || draft.kind === 'before') && (
              <MdTextField label={draft.kind === 'before' ? 'Before' : 'To'} supportingText={PARTIAL_HINT}
                data-testid={field('to')} value={draft.to} onInput={v => patch({ to: v })} />
            )}
            <p className="text-sm" data-testid={field('preview')}>
              {result === null ? <span className="text-muted-foreground">Incomplete</span>
                : ongoing && (draft.kind === 'ongoing' || draft.kind === 'unknown') ? label(draft.kind) : formatFuzzy(result, birth)}
            </p>
          </div>
        );
      }}
    </GroupEditor>
  );
}
