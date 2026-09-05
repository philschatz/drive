import { useState } from 'preact/hooks';
import { ListRow } from '../../common/ListRow';
import { Button } from '@/components/ui/button';
import { Fab } from '@/components/ui/fab';
import { docUrl } from '../../common/doc-urls';
import type { KitchenRecipe, ShoppingItem } from '../../../../shared/schemas/kitchen';
import { normName } from '../../../../shared/schemas/kitchen';
import { formatIngredient } from './ingredients';
import { difficultyLabel, difficultyScore, totalMinutes, type RecipeState, type Requirement } from './logic';
import { relativeTime } from '../../../../shared/relative-time';

/** The shopping-map key an ingredient line lands under. */
export function lineKey(entry: KitchenRecipe['recipeIngredient'][number]): string {
  return normName(formatIngredient(entry));
}

function Chip({ icon, label, title, onClick, owned }: {
  icon: string;
  label: string;
  title?: string;
  onClick?: () => void;
  owned?: boolean;
}) {
  const cls =
    'inline-flex items-center gap-1 rounded-full border px-2.5 h-7 text-sm shrink-0' +
    (owned
      ? ' bg-secondary-container text-on-secondary-container border-transparent'
      : ' text-muted-foreground') +
    (onClick ? ' state-layer' : '');
  const body = (
    <>
      <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 16 }}>{icon}</span>
      {label}
    </>
  );
  return onClick
    ? <button className={cls} title={title} onClick={onClick}>{body}</button>
    : <span className={cls} title={title}>{body}</span>;
}

/**
 * One recipe, full page: what you'll need (with the unlock affordances), the
 * cook button (which is also how techniques are learned), the ingredient
 * checklist feeding the shopping list, and the steps.
 */
export function RecipeDetail({
  docId, recipe, state, shopping, cookCount, lastCooked, canEdit,
  onCook, onToggleLine, onShopAll, onToggleStaple, onOwnTool, onEdit,
}: {
  docId: string;
  recipe: KitchenRecipe;
  state: RecipeState;
  shopping: Record<string, ShoppingItem>;
  cookCount: number;
  lastCooked?: string;
  canEdit: boolean;
  onCook: () => void;
  onToggleLine: (entry: KitchenRecipe['recipeIngredient'][number]) => void;
  onShopAll: () => void;
  onToggleStaple: (req: Requirement) => void;
  onOwnTool: (req: Requirement) => void;
  onEdit: () => void;
}) {
  const [imgBroken, setImgBroken] = useState(false);
  const pendingAt = (key: string) => !!shopping[key] && !shopping[key].bought;
  const cookable = state.status !== 'locked';
  const missingNorms = new Set(state.missing.map(m => m.norm));

  const metaChips = [
    recipe.recipeCategory,
    recipe.recipeCuisine,
    `Serves ${recipe.recipeYield}`,
    totalMinutes(recipe) !== undefined ? `${totalMinutes(recipe)} min` : undefined,
    difficultyLabel(difficultyScore(recipe)),
  ].filter(Boolean) as string[];

  return (
    <div data-testid="recipe-detail">
      <a href={docUrl(docId)} className="inline-flex items-center gap-1 px-1 py-2 text-sm text-primary state-layer rounded-full">
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18 }}>arrow_back</span>
        All recipes
      </a>

      {recipe.image && !imgBroken && (
        <img
          src={recipe.image}
          alt=""
          className="w-full max-h-64 object-cover rounded-2xl"
          loading="lazy"
          onError={() => setImgBroken(true)}
        />
      )}

      <h1 className="md-headline-small pt-3">{recipe.name}</h1>
      {recipe.description && <p className="text-sm text-muted-foreground pt-1">{recipe.description}</p>}
      <div className="flex flex-wrap items-center gap-1.5 pt-2 text-sm text-muted-foreground">
        {metaChips.join(' · ')}
        {recipe.url && (
          <a href={recipe.url} target="_blank" rel="noreferrer" className="text-primary underline">source</a>
        )}
      </div>

      {(recipe.supply.length > 0 || recipe.tool.length > 0 || recipe.cookingMethod.length > 0) && (
        <section className="pt-4">
          <h3 className="text-sm font-medium text-muted-foreground pb-2">You’ll need</h3>
          <div className="flex flex-wrap gap-1.5" data-testid="requirement-chips">
            {([['supply', recipe.supply], ['tool', recipe.tool], ['technique', recipe.cookingMethod]] as const).flatMap(([kind, names]) =>
              names.map(name => {
                const norm = normName(name);
                const req = { name, norm, kind } as Requirement;
                if (!missingNorms.has(norm)) {
                  return <Chip key={norm} icon="check" label={name} owned title={kind === 'technique' ? 'learned' : 'owned'} />;
                }
                if (kind === 'supply') {
                  const inCart = pendingAt(norm);
                  return (
                    <Chip
                      key={norm}
                      icon={inCart ? 'shopping_cart_checkout' : 'add_shopping_cart'}
                      label={name}
                      title={inCart ? 'In the shopping list — tap to remove' : 'Add to shopping list'}
                      onClick={canEdit ? () => onToggleStaple(req) : undefined}
                    />
                  );
                }
                if (kind === 'tool') {
                  return (
                    <Chip
                      key={norm}
                      icon="handyman"
                      label={name}
                      title="Tap when you have this tool"
                      onClick={canEdit ? () => onOwnTool(req) : undefined}
                    />
                  );
                }
                return <Chip key={norm} icon="school" label={name} title="Learn it by cooking this recipe" />;
              }),
            )}
          </div>
        </section>
      )}

      <section className="pt-4">
        <div className="rounded-2xl border p-4 flex flex-col gap-2" data-testid="cook-card">
          <div className="text-sm">
            {state.status === 'ready' && 'Ready to cook.'}
            {state.status === 'learnable' && (
              <>Cooking this teaches: <strong>{state.missingTechniques.map(t => t.name).join(', ')}</strong></>
            )}
            {state.status === 'locked' && `Missing ${state.missing.length} thing${state.missing.length === 1 ? '' : 's'} — see above.`}
          </div>
          <div className="flex items-center gap-3">
            <Button
              disabled={!canEdit || !cookable}
              onClick={() => onCook()}
              data-testid="cook-button"
            >
              I cooked this
            </Button>
            {cookCount > 0 && (
              <span className="text-sm text-muted-foreground">
                Cooked {cookCount}× · {relativeTime(lastCooked)}
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="pt-4">
        <div className="flex items-center pb-1">
          <h3 className="text-sm font-medium text-muted-foreground">Ingredients</h3>
          {canEdit && (
            <button
              className="ml-auto inline-flex items-center gap-1 text-sm text-primary state-layer rounded-full px-3 h-8"
              onClick={onShopAll}
              data-testid="shop-recipe"
            >
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18 }}>add_shopping_cart</span>
              Shop for this recipe
            </button>
          )}
        </div>
        <md-list style={{ background: 'transparent' }}>
          {recipe.recipeIngredient.map((entry, i) => {
            const key = lineKey(entry);
            const checked = pendingAt(key);
            return (
              <ListRow
                key={i}
                data-testid="ingredient-row"
                data-in-cart={checked ? 'true' : 'false'}
                onTap={canEdit ? () => onToggleLine(entry) : undefined}
              >
                {/* Checked == on the shopping list (pending purchase); unchecked by default. */}
                <md-checkbox
                  slot="start"
                  checked={checked}
                  disabled={!canEdit}
                  tabIndex={-1}
                  className="pointer-events-none"
                />
                <div slot="headline" className="whitespace-normal">{formatIngredient(entry)}</div>
              </ListRow>
            );
          })}
        </md-list>
      </section>

      <section className="pt-4 pb-4">
        <h3 className="text-sm font-medium text-muted-foreground pb-1">Instructions</h3>
        <ol className="list-decimal pl-6 flex flex-col gap-2 text-sm leading-relaxed">
          {recipe.recipeInstructions.map((step, i) => <li key={i}>{step}</li>)}
        </ol>
      </section>

      {canEdit && <Fab icon="edit" aria-label="Edit recipe" onClick={onEdit} />}
    </div>
  );
}
