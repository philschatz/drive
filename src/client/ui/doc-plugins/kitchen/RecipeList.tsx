import { ListRow } from '../../common/ListRow';
import { Badge } from '@/components/ui/badge';
import { docUrl } from '../../common/doc-urls';
import { relativeTime } from '../../../../shared/relative-time';
import { difficultyLabel, difficultyScore, totalMinutes, type RecipeEntry } from './logic';
import type { ChangeKind } from '../../../../shared/version-changes';

function meta(entry: RecipeEntry): string {
  const parts: string[] = [difficultyLabel(difficultyScore(entry.recipe))];
  const min = totalMinutes(entry.recipe);
  if (min !== undefined) parts.push(`${min} min`);
  if (entry.recipe.recipeCuisine) parts.push(entry.recipe.recipeCuisine);
  return parts.join(' · ');
}

function missingSummary(entry: RecipeEntry): string {
  const names = entry.state.missing.map(m => m.name);
  const shown = names.slice(0, 3).join(', ');
  return `Missing ${shown}${names.length > 3 ? ` +${names.length - 3}` : ''}`;
}

/**
 * One recipe row. A real link (Cmd/middle-click, Back, status bar all work),
 * never an onTap that assigns the hash. In history mode `diff` tints it with
 * what the version on screen did, and a `ghost` is a recipe that version
 * removed, rendered from its old value — no link, there is nowhere to go.
 */
export function RecipeRow({ docId, entry, cooked, last, diff, ghost }: {
  docId: string;
  entry: RecipeEntry;
  /** How many times it has been cooked (0 = never). */
  cooked: number;
  /** Newest cook timestamp, when cooked > 0. */
  last?: string;
  diff?: ChangeKind;
  ghost?: boolean;
}) {
  const { status } = entry.state;
  const icon = status === 'locked' ? 'lock' : status === 'learnable' ? 'school' : 'skillet';
  return (
    <ListRow
      href={ghost ? undefined : docUrl(docId, `recipe/${encodeURIComponent(entry.id)}`)}
      data-testid="recipe-row"
      data-status={status}
      data-diff={diff}
      data-ghost={ghost ? '' : undefined}
    >
      <md-icon slot="start" className={status === 'locked' ? 'text-muted-foreground' : ''}>{icon}</md-icon>
      <div slot="headline">{entry.recipe.name}</div>
      <div slot="supporting-text">
        {status === 'locked' ? `${missingSummary(entry)} · ${meta(entry)}` : meta(entry)}
      </div>
      <span slot="end" className="flex items-center gap-1.5">
        {status === 'locked' && <Badge variant="outline">{entry.state.missing.length} missing</Badge>}
        {status === 'learnable' && <Badge variant="outline">cook to learn</Badge>}
        {cooked > 0 && <Badge variant="secondary">{cooked}× · {relativeTime(last)}</Badge>}
      </span>
    </ListRow>
  );
}

export function RecipeList({ docId, entries, cookCounts, lastCooked, emptyText, diff, ghosts }: {
  docId: string;
  entries: RecipeEntry[];
  cookCounts: Record<string, number>;
  lastCooked: Record<string, string>;
  emptyText: string;
  /** History mode: per recipe id, what the version on screen did to it. */
  diff?: Map<string, ChangeKind>;
  /** History mode: the recipes that version removed, present only for display. */
  ghosts?: ReadonlySet<string>;
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">{emptyText}</p>;
  }
  return (
    <md-list style={{ background: 'transparent' }}>
      {entries.map(entry => (
        <RecipeRow
          key={entry.id}
          docId={docId}
          entry={entry}
          cooked={cookCounts[entry.id] ?? 0}
          last={lastCooked[entry.id]}
          diff={diff?.get(entry.id)}
          ghost={ghosts?.has(entry.id)}
        />
      ))}
    </md-list>
  );
}
