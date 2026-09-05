/**
 * The Kitchen engine: pure functions over (recipes, inventory, cookLog).
 * No DOM, no Preact, no worker — node-project Jest covers it directly.
 *
 * The unlock model (from the tmp-recipes prototype): a recipe's requirements
 * are its own `supply` ∪ `tool` ∪ `cookingMethod` strings; the unlockable
 * vocabulary is derived from the recipes, never stored; owning something means
 * an `inventory` entry exists under the requirement's normalized name.
 */

import { Temporal } from 'temporal-polyfill';
import {
  normName,
  type KitchenRecipe, type InventoryEntry, type InventoryKind,
} from '../../../../shared/schemas/kitchen';

export interface Requirement {
  /** Display form, exactly as the recipe spells it. */
  name: string;
  /** normName(name) — the inventory key it matches. */
  norm: string;
  kind: InventoryKind;
}

export interface RecipeState {
  /** ready: nothing missing. learnable: missing ONLY techniques — still
   * cookable, and cooking it learns them. locked: missing pantry/tools. */
  status: 'ready' | 'learnable' | 'locked';
  missing: Requirement[];
  /** The cook-to-learn subset of `missing`. */
  missingTechniques: Requirement[];
}

export interface RecipeEntry {
  id: string;
  recipe: KitchenRecipe;
  state: RecipeState;
}

const REQ_FIELDS: Array<[keyof Pick<KitchenRecipe, 'supply' | 'tool' | 'cookingMethod'>, InventoryKind]> = [
  ['supply', 'supply'],
  ['tool', 'tool'],
  ['cookingMethod', 'technique'],
];

export function recipeRequirements(r: KitchenRecipe): Requirement[] {
  const out: Requirement[] = [];
  for (const [field, kind] of REQ_FIELDS) {
    for (const name of r[field] ?? []) out.push({ name, norm: normName(name), kind });
  }
  return out;
}

/** The derived unlockable vocabulary: every requirement any recipe names,
 * keyed by normalized name. The first display form seen wins; the ids of the
 * recipes wanting it ride along for "unlocks N recipes" math. */
export function vocabulary(
  recipes: Record<string, KitchenRecipe>,
): Map<string, { name: string; kind: InventoryKind; recipeIds: string[] }> {
  const vocab = new Map<string, { name: string; kind: InventoryKind; recipeIds: string[] }>();
  for (const [id, r] of Object.entries(recipes)) {
    for (const req of recipeRequirements(r)) {
      const entry = vocab.get(req.norm);
      if (entry) entry.recipeIds.push(id);
      else vocab.set(req.norm, { name: req.name, kind: req.kind, recipeIds: [id] });
    }
  }
  return vocab;
}

export function recipeState(r: KitchenRecipe, inventory: Record<string, InventoryEntry>): RecipeState {
  const missing = recipeRequirements(r).filter(req => !(req.norm in inventory));
  const missingTechniques = missing.filter(req => req.kind === 'technique');
  const status = missing.length === 0 ? 'ready'
    : missing.length === missingTechniques.length ? 'learnable'
    : 'locked';
  return { status, missing, missingTechniques };
}

// ---------------------------------------------------------------------------
// Difficulty — computed, never stored. The tmp-recipes prototype's formula,
// verified to reproduce all 50 of its stored scores exactly.
// ---------------------------------------------------------------------------

export const FUSSY_METHODS: ReadonlySet<string> = new Set([
  'forming & pan-frying patties',
  'poaching eggs in sauce',
  'dredging in flour',
]);

export function totalMinutes(r: KitchenRecipe): number | undefined {
  try {
    return Math.round(Temporal.Duration.from(r.totalTime).total({ unit: 'minutes' }));
  } catch {
    /* fall through to prep + cook */
  }
  try {
    return Math.round(
      Temporal.Duration.from(r.prepTime).total({ unit: 'minutes' }) +
      Temporal.Duration.from(r.cookTime).total({ unit: 'minutes' }),
    );
  } catch {
    return undefined;
  }
}

export function difficultyScore(r: KitchenRecipe): number {
  const nIng = r.recipeIngredient?.length ?? 0;
  const steps = r.recipeInstructions?.length ?? 0;
  const nTech = r.cookingMethod?.length ?? 0;
  const min = totalMinutes(r) ?? 0;
  const fussy = (r.cookingMethod ?? []).some(t => FUSSY_METHODS.has(normName(t))) ? 1 : 0;
  return (
    Number(nIng > 8) + Number(nIng > 14) +
    Number(min > 30) + Number(min > 60) +
    Number(steps > 4) + Number(steps > 7) +
    Number(nTech > 2) + Number(nTech > 4) +
    fussy
  );
}

export function difficultyLabel(score: number): 'Easy' | 'Medium' | 'Hard' {
  return score <= 2 ? 'Easy' : score <= 5 ? 'Medium' : 'Hard';
}

// ---------------------------------------------------------------------------
// Cook log
// ---------------------------------------------------------------------------

/** Newest cook timestamp per recipe. ISO keys sort chronologically. */
export function lastCookedByRecipe(cookLog: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ts, id] of Object.entries(cookLog)) {
    if (out[id] === undefined || ts > out[id]) out[id] = ts;
  }
  return out;
}

export function cookCounts(cookLog: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of Object.values(cookLog)) out[id] = (out[id] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// Orderings & suggestions
// ---------------------------------------------------------------------------

/** "Next to unlock": fewest missing, then easiest, then quickest. */
export function sortLocked(entries: RecipeEntry[]): RecipeEntry[] {
  return [...entries].sort((a, b) =>
    a.state.missing.length - b.state.missing.length ||
    difficultyScore(a.recipe) - difficultyScore(b.recipe) ||
    (totalMinutes(a.recipe) ?? Infinity) - (totalMinutes(b.recipe) ?? Infinity) ||
    a.recipe.name.localeCompare(b.recipe.name) ||
    a.id.localeCompare(b.id));
}

/** "Cook again": never cooked first, then the stalest last cook. */
export function sortReady(entries: RecipeEntry[], cookLog: Record<string, string>): RecipeEntry[] {
  const last = lastCookedByRecipe(cookLog);
  return [...entries].sort((a, b) => {
    const la = last[a.id];
    const lb = last[b.id];
    if ((la === undefined) !== (lb === undefined)) return la === undefined ? -1 : 1;
    if (la !== undefined && lb !== undefined && la !== lb) return la < lb ? -1 : 1;
    return a.recipe.name.localeCompare(b.recipe.name) || a.id.localeCompare(b.id);
  });
}

export interface Purchase {
  name: string;
  norm: string;
  kind: 'supply' | 'tool';
  /** Locked recipes this single acquisition flips out of 'locked'. */
  unlocks: number;
}

/** The single unowned supply/tool whose acquisition unlocks the most recipes —
 * i.e. the locked recipes missing exactly that one physical thing (techniques
 * don't count against them: they're learnable by cooking). Null when no single
 * purchase flips anything. */
export function bestPurchase(
  recipes: Record<string, KitchenRecipe>,
  inventory: Record<string, InventoryEntry>,
): Purchase | null {
  const credits = new Map<string, Purchase>();
  for (const r of Object.values(recipes)) {
    const state = recipeState(r, inventory);
    if (state.status !== 'locked') continue;
    const physical = state.missing.filter(req => req.kind !== 'technique');
    if (physical.length !== 1) continue;
    const req = physical[0];
    const credit = credits.get(req.norm) ?? { name: req.name, norm: req.norm, kind: req.kind as 'supply' | 'tool', unlocks: 0 };
    credit.unlocks++;
    credits.set(req.norm, credit);
  }
  let best: Purchase | null = null;
  for (const c of credits.values()) {
    if (!best || c.unlocks > best.unlocks || (c.unlocks === best.unlocks && c.name.localeCompare(best.name) < 0)) {
      best = c;
    }
  }
  return best;
}
