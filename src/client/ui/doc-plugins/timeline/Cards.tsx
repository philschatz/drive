/**
 * The cards on the Prompts and Pin down tabs: a photo moment to write up, an
 * empty stretch of life to fill, and one before/after question at a time.
 */
import { Button } from '@/components/ui/button';
import type { TimelineDocument, TimelinePrompt, Rel } from '../../../../shared/schemas/timeline';
import type { Question } from '../../../../shared/timeline/planner';
import type { Gap } from '../../../../shared/timeline/planner';
import type { Conflict } from '../../../../shared/timeline/order';
import { formatFuzzy, formatDayRange, formatPartial, partialOf, fromDay, parsePartial } from '../../../../shared/timeline/fuzzy-date';
import { Thumb } from './Thumb';

const card = 'rounded-2xl border p-4 mb-3 flex flex-col gap-3';

export function PromptCard({ docId, promptKey, prompt, birth, canEdit, onWrite, onSkip }: {
  docId?: string;
  promptKey: string;
  prompt: TimelinePrompt;
  birth?: string;
  canEdit: boolean;
  onWrite: (key: string) => void;
  onSkip: (key: string) => void;
}) {
  const photos = Object.keys(prompt.links ?? {});
  const extra = (prompt.count ?? photos.length) - 1;
  const cover = prompt.cover ?? photos[0];
  const href = cover ? prompt.links?.[cover]?.href : undefined;
  return (
    <div className={card} data-testid="timeline-prompt" data-key={promptKey}>
      <div className="flex gap-3 items-start">
        {cover && (
          href
            ? <a href={href} target="_blank" rel="noopener noreferrer" title="Open the photo"><Thumb docId={docId} photoId={cover} size={96} /></a>
            : <Thumb docId={docId} photoId={cover} size={96} />
        )}
        <div className="flex-1 text-sm">
          <div className="font-semibold">
            {formatFuzzy(prompt.when, birth)}{prompt.until ? ` – ${formatFuzzy(prompt.until, birth)}` : ''}
          </div>
          {prompt.location && <div className="text-muted-foreground">{prompt.location}</div>}
          {extra > 0 && <div className="text-muted-foreground">+{extra} more photo{extra === 1 ? '' : 's'}</div>}
          <div className="mt-1">What was happening here?</div>
        </div>
      </div>
      {canEdit && (
        <div className="flex gap-2 justify-end">
          <Button variant="outline" data-testid="prompt-skip" onClick={() => onSkip(promptKey)}>Skip</Button>
          <Button data-testid="prompt-write" onClick={() => onWrite(promptKey)}>Write entry</Button>
        </div>
      )}
    </div>
  );
}

export function GapCard({ gap, birth, canEdit, onAdd, onNothing }: {
  gap: Gap;
  birth?: string;
  canEdit: boolean;
  onAdd: (gap: Gap) => void;
  onNothing: (gap: Gap) => void;
}) {
  const b = birth ? parsePartial(birth) : null;
  const lo = fromDay(gap.lo);
  const hi = fromDay(gap.hi);
  const ages = b ? ` — you were ${Math.max(0, lo.year - b.first.year)} to ${hi.year - b.first.year}` : '';
  return (
    <div className={card} data-testid="timeline-gap-card">
      <div className="text-sm">
        {/* Month precision: a gap's ends are best guesses, not known days. */}
        <div className="font-semibold">Nothing between {formatPartial(partialOf(gap.lo, 'month'))} and {formatPartial(partialOf(gap.hi, 'month'))} yet{ages}.</div>
        <div className="mt-1">What do you remember from around {fromDay(Math.floor((gap.lo + gap.hi) / 2)).year}?</div>
      </div>
      {canEdit && (
        <div className="flex gap-2 justify-end">
          <Button variant="outline" data-testid="gap-nothing" onClick={() => onNothing(gap)}>Nothing comes to mind</Button>
          <Button data-testid="gap-add" onClick={() => onAdd(gap)}>Add a memory</Button>
        </div>
      )}
    </div>
  );
}

const REL_LABELS: Record<Rel, string> = {
  before: 'Before', after: 'After', during: 'During it', near: 'About the same time', unsure: 'Not sure',
};

export function PinDownCard({ question, doc, birth, canEdit, onAnswer, onPivot, onSkip, onSettle }: {
  question: Question | null;
  doc: Pick<TimelineDocument, 'events'>;
  birth?: string;
  canEdit: boolean;
  onAnswer: (q: Question & { kind: 'anchor' }, rel: Rel) => void;
  onPivot: (q: Question & { kind: 'pivot' }, answer: 'before' | 'after') => void;
  onSkip: (q: Question) => void;
  onSettle: (uid: string) => void;
}) {
  if (!question) {
    return (
      <p className="text-sm text-muted-foreground py-4" data-testid="pin-done">
        Every date is pinned down as well as it needs to be. Recent years ask for more precision than early ones.
      </p>
    );
  }
  const me = doc.events[question.uid];
  const verb = question.end === 'end' ? 'end' : me.until ? 'begin' : 'happen';
  const now = formatDayRange(question.range.lo, question.range.hi);
  let text: string;
  if (question.kind === 'anchor') {
    const a = doc.events[question.anchor];
    const aDate = formatFuzzy(a.when, birth);
    text = `Did “${me.title}” ${verb} before or after “${a.title}”${aDate === 'Undated' ? '' : ` (${aDate})`}?`;
  } else {
    text = `Did “${me.title}” ${verb} before or after ${question.label}?`;
  }
  return (
    <div className={card} data-testid="pin-question" data-kind={question.kind}>
      <div className="text-sm">
        <div className="font-semibold">{text}</div>
        <div className="text-muted-foreground mt-1" data-testid="pin-range">Now known: {now}</div>
      </div>
      {canEdit && (
        <div className="flex flex-wrap gap-2 justify-end">
          {question.kind === 'anchor'
            ? question.options.map(rel => (
              <Button key={rel} variant={rel === 'unsure' ? 'outline' : 'default'} data-testid={`pin-${rel}`}
                onClick={() => onAnswer(question, rel)}>{REL_LABELS[rel]}</Button>
            ))
            : (<>
              <Button data-testid="pin-before" onClick={() => onPivot(question, 'before')}>Before</Button>
              <Button data-testid="pin-after" onClick={() => onPivot(question, 'after')}>After</Button>
              <Button variant="outline" data-testid="pin-unsure" onClick={() => onSkip(question)}>Not sure</Button>
            </>)}
          <Button variant="outline" data-testid="pin-settle" onClick={() => onSettle(question.uid)}>Close enough</Button>
        </div>
      )}
    </div>
  );
}

export function ConflictList({ conflicts, titleOf, canEdit, onRemove }: {
  conflicts: Conflict[];
  titleOf: (uid: string) => string;
  canEdit: boolean;
  onRemove: (c: Conflict) => void;
}) {
  if (!conflicts.length) return null;
  return (
    <div className="mb-3 flex flex-col gap-2" data-testid="pin-conflicts">
      {conflicts.map(c => (
        <div key={`${c.owner}|${c.field}|${c.target}`} className="rounded-xl border border-error p-2 text-sm flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-error">error</span>
          <span className="flex-1">
            You said “{titleOf(c.owner)}” {c.field === 'untilRel' ? 'ended' : 'was'} {c.rel} “{titleOf(c.target)}”, which
            {c.reason === 'contradicts-answer' ? ' contradicts another answer.' : ' doesn’t fit their dates.'}
          </span>
          {canEdit && <button type="button" className="text-primary md-label-large" onClick={() => onRemove(c)}>Remove</button>}
        </div>
      ))}
    </div>
  );
}
