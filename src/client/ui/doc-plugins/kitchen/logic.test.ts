import {
  recipeRequirements, vocabulary, recipeState,
  difficultyScore, difficultyLabel, totalMinutes,
  lastCookedByRecipe, cookCounts, sortLocked, sortReady, bestPurchase,
  type RecipeEntry,
} from './logic';
import type { KitchenRecipe, InventoryEntry } from '../../../../shared/schemas/kitchen';

const mk = (over: Partial<KitchenRecipe> = {}): KitchenRecipe => ({
  '@type': 'Recipe',
  name: 'Test Dish',
  description: 'd',
  recipeYield: '4',
  prepTime: 'PT10M',
  cookTime: 'PT5M',
  totalTime: 'PT15M',
  recipeIngredient: ['1 egg'],
  recipeInstructions: ['Cook it.'],
  supply: [],
  tool: [],
  cookingMethod: [],
  ...over,
});

const owned = (...entries: Array<[string, InventoryEntry['kind']]>): Record<string, InventoryEntry> =>
  Object.fromEntries(entries.map(([name, kind]) => [name, { name, kind, acquired: '2026-08-01T18:00:00Z' }]));

describe('recipeState', () => {
  const r = mk({
    supply: ['Smoked Paprika', 'saffron'],
    tool: ['paella pan (or 12-inch shallow skillet)'],
    cookingMethod: ['simmering', 'sautéing aromatics'],
  });

  it('is locked while any pantry/tool is missing', () => {
    const state = recipeState(r, owned(['smoked paprika', 'supply'], ['simmering', 'technique']));
    expect(state.status).toBe('locked');
    expect(state.missing.map(m => m.norm)).toEqual([
      'saffron', 'paella pan (or 12-inch shallow skillet)', 'sautéing aromatics',
    ]);
  });

  it('matches inventory case-insensitively (normName), like the prototype', () => {
    // "Smoked Paprika" in the recipe matches the "smoked paprika" inventory key.
    const inv = owned(['smoked paprika', 'supply'], ['saffron', 'supply'],
      ['paella pan (or 12-inch shallow skillet)', 'tool']);
    const state = recipeState(r, inv);
    expect(state.missing.every(m => m.kind === 'technique')).toBe(true);
  });

  it('is learnable when ONLY techniques are missing — cook it to learn them', () => {
    const inv = owned(['smoked paprika', 'supply'], ['saffron', 'supply'],
      ['paella pan (or 12-inch shallow skillet)', 'tool']);
    const state = recipeState(r, inv);
    expect(state.status).toBe('learnable');
    expect(state.missingTechniques.map(m => m.norm)).toEqual(['simmering', 'sautéing aromatics']);
  });

  it('is ready when everything is owned (a no-requirements recipe is born ready)', () => {
    expect(recipeState(mk(), {}).status).toBe('ready');
  });
});

describe('vocabulary', () => {
  it('derives the unlockables from the recipes, first display form winning', () => {
    const vocab = vocabulary({
      a: mk({ supply: ['Smoked Paprika'], cookingMethod: ['simmering'] }),
      b: mk({ supply: ['smoked paprika '], tool: ['dutch oven'] }),
    });
    expect(vocab.get('smoked paprika')).toEqual({ name: 'Smoked Paprika', kind: 'supply', recipeIds: ['a', 'b'] });
    expect(vocab.get('simmering')?.kind).toBe('technique');
    expect(vocab.size).toBe(3);
  });
});

describe('difficulty', () => {
  it('scores real dataset shapes exactly', () => {
    // Loaded Hummus Dip: 10 ingredients, 15 min, 2 steps, 0 techniques → 1.
    const hummus = mk({
      totalTime: 'PT15M',
      recipeIngredient: Array(10).fill('x'),
      recipeInstructions: Array(2).fill('x'),
    });
    expect(difficultyScore(hummus)).toBe(1);
    expect(difficultyLabel(1)).toBe('Easy');

    // Spanish Paella: 16 ingredients, 40 min, 8 steps, 3 techniques → 6.
    const paella = mk({
      totalTime: 'PT40M',
      recipeIngredient: Array(16).fill('x'),
      recipeInstructions: Array(8).fill('x'),
      cookingMethod: ['sautéing aromatics', 'simmering', 'cooking whole grains & legumes'],
    });
    expect(difficultyScore(paella)).toBe(6);
    expect(difficultyLabel(6)).toBe('Hard');
  });

  it('adds the fussy-technique bonus', () => {
    const base = mk({ recipeInstructions: Array(4).fill('x') });
    expect(difficultyScore(base)).toBe(0);
    expect(difficultyScore({ ...base, cookingMethod: ['Dredging in Flour'] })).toBe(1);
  });

  it('labels the boundaries', () => {
    expect(difficultyLabel(2)).toBe('Easy');
    expect(difficultyLabel(3)).toBe('Medium');
    expect(difficultyLabel(5)).toBe('Medium');
  });
});

describe('totalMinutes', () => {
  it('reads totalTime, falling back to prep + cook', () => {
    expect(totalMinutes(mk({ totalTime: 'PT1H5M' }))).toBe(65);
    expect(totalMinutes(mk({ totalTime: '' }))).toBe(15);
    expect(totalMinutes(mk({ totalTime: '', prepTime: '', cookTime: '' }))).toBeUndefined();
  });
});

describe('cook log', () => {
  const log = {
    '2026-08-01T19:00:00Z': 'a',
    '2026-08-10T19:00:00Z': 'a',
    '2026-08-05T19:00:00Z': 'b',
  };

  it('finds the newest cook per recipe', () => {
    expect(lastCookedByRecipe(log)).toEqual({ a: '2026-08-10T19:00:00Z', b: '2026-08-05T19:00:00Z' });
  });

  it('counts cooks', () => {
    expect(cookCounts(log)).toEqual({ a: 2, b: 1 });
  });
});

describe('orderings', () => {
  const entry = (id: string, over: Partial<KitchenRecipe>, inv: Record<string, InventoryEntry> = {}): RecipeEntry => {
    const recipe = mk({ name: id, ...over });
    return { id, recipe, state: recipeState(recipe, inv) };
  };

  it('sortLocked: fewest missing, then easier, then quicker', () => {
    const two = entry('two-missing', { supply: ['a', 'b'] });
    const oneHard = entry('one-hard', { supply: ['a'], recipeIngredient: Array(16).fill('x'), recipeInstructions: Array(8).fill('x'), totalTime: 'PT90M' });
    const oneQuick = entry('one-quick', { supply: ['a'], totalTime: 'PT10M' });
    const oneSlow = entry('one-slow', { supply: ['a'], totalTime: 'PT25M' });
    expect(sortLocked([two, oneHard, oneSlow, oneQuick]).map(e => e.id))
      .toEqual(['one-quick', 'one-slow', 'one-hard', 'two-missing']);
  });

  it('sortReady: never cooked first, then stalest', () => {
    const never = entry('never', {});
    const stale = entry('stale', {});
    const fresh = entry('fresh', {});
    const log = { '2026-08-01T19:00:00Z': 'stale', '2026-08-20T19:00:00Z': 'fresh' };
    expect(sortReady([fresh, stale, never], log).map(e => e.id)).toEqual(['never', 'stale', 'fresh']);
  });
});

describe('bestPurchase', () => {
  it('picks the single physical item that flips the most locked recipes', () => {
    const recipes = {
      a: mk({ supply: ['smoked paprika'] }),
      b: mk({ supply: ['Smoked Paprika'], cookingMethod: ['simmering'] }), // technique missing too — still flips (learnable)
      c: mk({ supply: ['smoked paprika', 'saffron'] }),                    // needs two things — no single-item credit
      d: mk({ tool: ['dutch oven'] }),
    };
    expect(bestPurchase(recipes, {})).toEqual({ name: 'smoked paprika', norm: 'smoked paprika', kind: 'supply', unlocks: 2 });
  });

  it('ignores technique-only gaps and returns null when nothing flips', () => {
    const recipes = { a: mk({ cookingMethod: ['simmering'] }) };
    expect(bestPurchase(recipes, {})).toBeNull();
  });
});
