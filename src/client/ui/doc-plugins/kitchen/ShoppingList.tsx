import { ListRow } from '../../common/ListRow';
import type { KitchenRecipe, ShoppingItem } from '../../../../shared/schemas/kitchen';

/**
 * The grocery list. A row's tap toggles bought (a bought row stays, greyed and
 * struck through, until "Clear bought" sweeps it — the Tasks delete-completed
 * idiom), so an accidental check is one tap to undo.
 */
export function ShoppingList({ shopping, recipes, canEdit, onToggleBought, onRemove, onClearBought }: {
  shopping: Record<string, ShoppingItem>;
  recipes: Record<string, KitchenRecipe>;
  canEdit: boolean;
  onToggleBought: (key: string) => void;
  onRemove: (key: string) => void;
  onClearBought: () => void;
}) {
  const entries = Object.entries(shopping);
  const pending = entries.filter(([, it]) => !it.bought)
    .sort(([, a], [, b]) => a.added.localeCompare(b.added));
  const bought = entries.filter(([, it]) => it.bought)
    .sort(([, a], [, b]) => b.bought!.localeCompare(a.bought!));

  const provenance = (item: ShoppingItem): string | undefined => {
    if (item.recipe) {
      const r = recipes[item.recipe];
      if (r) return `for ${r.name}`;
    }
    return item.staple ? 'pantry staple' : undefined;
  };

  const row = ([key, item]: [string, ShoppingItem]) => {
    const isBought = !!item.bought;
    return (
      <ListRow
        key={key}
        data-testid="shopping-row"
        data-bought={isBought ? 'true' : 'false'}
        onTap={canEdit ? () => onToggleBought(key) : undefined}
        actions={canEdit ? [{ icon: 'close', label: 'Remove', title: `Remove ${item.name}`, onSelect: () => onRemove(key) }] : []}
      >
        <md-checkbox
          slot="start"
          checked={isBought}
          disabled={!canEdit}
          tabIndex={-1}
          className="pointer-events-none"
        />
        <div slot="headline" style={{ textDecoration: isBought ? 'line-through' : 'none', opacity: isBought ? 0.5 : 1 }}>
          {item.name}
        </div>
        {provenance(item) && <div slot="supporting-text">{provenance(item)}</div>}
      </ListRow>
    );
  };

  return (
    <div>
      <div className="flex items-center px-4 pt-4 pb-1">
        <h3 className="text-sm font-medium text-muted-foreground">
          {pending.length === 0 ? 'Nothing to buy' : `${pending.length} to buy`}
        </h3>
        {canEdit && bought.length > 0 && (
          <button
            className="ml-auto text-sm text-primary state-layer rounded-full px-3 h-8"
            onClick={onClearBought}
          >
            Clear bought
          </button>
        )}
      </div>
      <md-list style={{ background: 'transparent' }}>
        {pending.map(row)}
        {bought.map(row)}
      </md-list>
    </div>
  );
}
