import { useMemo } from 'preact/hooks';
import { ListRow } from '../../common/ListRow';
import type { InventoryEntry, InventoryKind, KitchenRecipe } from '../../../../shared/schemas/kitchen';
import { vocabulary } from './logic';
import { relativeTime } from '../../../../shared/relative-time';

const GROUPS: Array<{ kind: InventoryKind; label: string; icon: string }> = [
  { kind: 'supply', label: 'Pantry staples', icon: 'grocery' },
  { kind: 'tool', label: 'Tools', icon: 'handyman' },
  { kind: 'technique', label: 'Techniques', icon: 'school' },
];

interface Row {
  norm: string;
  name: string;
  kind: InventoryKind;
  owned?: InventoryEntry;
  /** Recipes naming this requirement; 0 for an owned entry nothing needs anymore. */
  wantedBy: number;
}

/**
 * The gear ledger: the vocabulary DERIVED from the recipes, grouped by kind,
 * merged with what is owned. Tapping a row toggles owned — this is where tools
 * are marked "I have this" and techniques can be hand-marked learned.
 */
export function InventoryTab({ recipes, inventory, canEdit, onToggle }: {
  recipes: Record<string, KitchenRecipe>;
  inventory: Record<string, InventoryEntry>;
  canEdit: boolean;
  onToggle: (norm: string, name: string, kind: InventoryKind) => void;
}) {
  const rows = useMemo(() => {
    const vocab = vocabulary(recipes);
    const byKind = new Map<InventoryKind, Row[]>(GROUPS.map(g => [g.kind, []]));
    for (const [norm, v] of vocab) {
      byKind.get(v.kind)!.push({ norm, name: v.name, kind: v.kind, owned: inventory[norm], wantedBy: v.recipeIds.length });
    }
    // Owned entries the vocabulary no longer names (a recipe was edited away):
    // still listed, so ownership is never invisible.
    for (const [norm, entry] of Object.entries(inventory)) {
      if (!vocab.has(norm)) byKind.get(entry.kind)?.push({ norm, name: entry.name, kind: entry.kind, owned: entry, wantedBy: 0 });
    }
    for (const list of byKind.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return byKind;
  }, [recipes, inventory]);

  return (
    <div>
      {GROUPS.map(group => {
        const list = rows.get(group.kind)!;
        if (list.length === 0) return null;
        const ownedCount = list.filter(r => r.owned).length;
        return (
          <section key={group.kind}>
            <h3 className="flex items-center gap-2 px-4 pt-4 pb-1 text-sm font-medium text-muted-foreground">
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18 }}>{group.icon}</span>
              {group.label}
              <span className="ml-auto font-normal">{ownedCount}/{list.length}</span>
            </h3>
            <md-list style={{ background: 'transparent' }}>
              {list.map(row => (
                <ListRow
                  key={row.norm}
                  data-testid="inventory-row"
                  data-owned={row.owned ? 'true' : 'false'}
                  onTap={canEdit ? () => onToggle(row.norm, row.name, row.kind) : undefined}
                >
                  <md-checkbox
                    slot="start"
                    checked={!!row.owned}
                    disabled={!canEdit}
                    tabIndex={-1}
                    className="pointer-events-none"
                  />
                  <div slot="headline">{row.name}</div>
                  <div slot="supporting-text">
                    {row.owned
                      ? `${row.kind === 'technique' ? 'learned' : 'acquired'} ${relativeTime(row.owned.acquired)}`
                      : row.wantedBy > 0
                        ? `needed by ${row.wantedBy} recipe${row.wantedBy === 1 ? '' : 's'}`
                        : 'no recipe needs this anymore'}
                  </div>
                </ListRow>
              ))}
            </md-list>
          </section>
        );
      })}
    </div>
  );
}
