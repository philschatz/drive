import 'temporal-polyfill/global';
import {
  kitchenDocumentSchema, checkKitchenDependencies, slugifyRecipeId,
  type KitchenDocument, type KitchenRecipe,
} from './kitchen';
import { validateNode, type ValidationError } from './core';

// Composed directly (rather than through validateDocument) so this suite does
// not depend on registry membership; registration parity is doc-plugins.test.tsx.
const validate = (doc: unknown): ValidationError[] => {
  const errors: ValidationError[] = [];
  validateNode(doc, kitchenDocumentSchema, [], errors);
  checkKitchenDependencies(doc, errors);
  return errors;
};
const hard = (errors: ValidationError[]) => errors.filter(e => e.kind !== 'warning');

const recipe = (over: Partial<KitchenRecipe> = {}): KitchenRecipe => ({
  '@type': 'Recipe',
  name: 'Loaded Hummus Dip',
  description: 'The ultimate easy appetizer.',
  recipeYield: '4',
  prepTime: 'PT15M',
  cookTime: 'PT0M',
  totalTime: 'PT15M',
  recipeIngredient: [
    '3 or 4 ripe bananas, smashed',
    { '@type': 'PropertyValue', value: 1, name: 'egg' },
    { '@type': 'PropertyValue', value: '3/4', name: 'sugar', unitCode: 'G21' },
    { '@type': 'PropertyValue', value: '1/2', name: 'chopped English cucumber', unitText: 'cup' },
  ],
  recipeInstructions: ['Prepare the vegetables.', 'Spread the hummus and top.'],
  supply: ['artichoke hearts (jarred)', 'kalamata/green olives (jarred)'],
  tool: [],
  cookingMethod: [],
  url: 'https://www.acouplecooks.com/hummus-dip/',
  image: 'https://example.com/hummus.jpg',
  recipeCategory: 'Appetizer',
  recipeCuisine: 'Greek',
  ...over,
});

const validDoc = (): KitchenDocument => ({
  '@type': 'Kitchen',
  name: 'Mediterranean Kitchen',
  recipes: { 'hummus-dip': recipe() },
  inventory: {
    'smoked paprika': { name: 'Smoked Paprika', kind: 'supply', acquired: '2026-08-01T18:00:00Z' },
    'simmering': { name: 'simmering', kind: 'technique', acquired: '2026-08-10T19:05:00Z' },
  },
  cookLog: { '2026-08-20T19:05:23.123Z': 'hummus-dip' },
  shopping: {
    '1/2 cup chopped red onion': { name: '1/2 cup chopped red onion', added: '2026-08-30T10:00:00Z', recipe: 'hummus-dip' },
    'saffron': { name: 'Saffron', added: '2026-08-30T10:00:01Z', staple: true, bought: '2026-08-31T12:00:00Z' },
  },
});

describe('Kitchen schema', () => {
  it('accepts a valid document', () => {
    expect(validate(validDoc())).toEqual([]);
  });

  it('accepts a fresh empty document', () => {
    expect(validate({ '@type': 'Kitchen', name: 'Kitchen', recipes: {}, inventory: {}, cookLog: {}, shopping: {} })).toEqual([]);
  });

  it('requires the recipe fields schema.org leaves optional', () => {
    for (const field of ['description', 'recipeYield', 'prepTime', 'cookTime', 'totalTime',
                         'recipeIngredient', 'recipeInstructions', 'supply', 'tool', 'cookingMethod'] as const) {
      const doc = validDoc();
      delete (doc.recipes['hummus-dip'] as any)[field];
      expect(validate(doc).some(e => e.path.includes(field) && e.message.includes('missing'))).toBe(true);
    }
  });

  it('rejects empty content in the fields that make a recipe cookable', () => {
    const cases: Array<[keyof KitchenRecipe, unknown, string]> = [
      ['name', '', 'name must not be empty'],
      ['recipeYield', '', 'recipeYield must not be empty'],
      ['recipeIngredient', [], 'at least one ingredient'],
      ['recipeInstructions', [], 'at least one instruction'],
    ];
    for (const [field, value, message] of cases) {
      const doc = validDoc();
      (doc.recipes['hummus-dip'] as any)[field] = value;
      expect(validate(doc).some(e => e.message.includes(message))).toBe(true);
    }
  });

  it('allows empty supply/tool/cookingMethod — a dip needs no special gear', () => {
    const doc = validDoc();
    doc.recipes['hummus-dip'].supply = [];
    expect(validate(doc)).toEqual([]);
  });

  describe('recipeIngredient mixed array', () => {
    it('rejects a PropertyValue with no quantity', () => {
      const doc = validDoc();
      // Union scoring reports the str() branch's error on a tie, so assert on
      // the entry's path rather than a specific message.
      (doc.recipes['hummus-dip'].recipeIngredient as any[]).push({ '@type': 'PropertyValue', name: 'salt' });
      expect(hard(validate(doc)).some(e => e.path.includes('recipeIngredient') && e.path.includes(4))).toBe(true);
    });

    it('rejects a PropertyValue whose quantity is an empty string', () => {
      const doc = validDoc();
      (doc.recipes['hummus-dip'].recipeIngredient as any[]).push({ '@type': 'PropertyValue', name: 'salt', value: '' });
      expect(validate(doc).some(e => e.message.includes('must carry a quantity'))).toBe(true);
    });

    it('rejects a non-string, non-PropertyValue entry', () => {
      const doc = validDoc();
      (doc.recipes['hummus-dip'].recipeIngredient as any[]).push(42);
      expect(validate(doc).length).toBeGreaterThan(0);
    });
  });

  it('reports unmodeled schema.org properties as warnings, not errors', () => {
    const doc = validDoc();
    (doc.recipes['hummus-dip'] as any).nutrition = { calories: '260 calories' };
    const errors = validate(doc);
    expect(hard(errors)).toEqual([]);
    expect(errors.some(e => e.kind === 'warning' && e.path.includes('nutrition'))).toBe(true);
  });

  it('rejects durations Temporal cannot parse, even when the regex passes', () => {
    const doc = validDoc();
    doc.recipes['hummus-dip'].prepTime = 'P'; // passes DURATION_RE, not Temporal
    expect(validate(doc).some(e => e.message.includes('not a valid ISO 8601 duration'))).toBe(true);
    doc.recipes['hummus-dip'].prepTime = 'PT1X';
    expect(validate(doc).length).toBeGreaterThan(0);
  });

  it('rejects script-capable url/image schemes', () => {
    const doc = validDoc();
    doc.recipes['hummus-dip'].image = 'javascript:alert(1)';
    expect(validate(doc).some(e => e.message.includes('disallowed URI scheme'))).toBe(true);
  });

  describe('inventory', () => {
    it('rejects a key that is not the normalized name', () => {
      const doc = validDoc();
      doc.inventory['Smoked Paprika'] = { name: 'Smoked Paprika', kind: 'supply', acquired: '2026-08-01T18:00:00Z' };
      expect(validate(doc).some(e => e.message.includes('normalized form'))).toBe(true);
    });

    it('rejects an unparseable acquired stamp', () => {
      const doc = validDoc();
      doc.inventory['simmering'].acquired = '2026-13-45T00:00:00Z'; // passes the regex, not Temporal
      expect(validate(doc).some(e => e.message.includes('not a valid date/time'))).toBe(true);
    });
  });

  describe('cookLog', () => {
    it('rejects an unparseable key', () => {
      const doc = validDoc();
      doc.cookLog['last tuesday'] = 'hummus-dip';
      expect(validate(doc).some(e => e.message.includes('cookLog key'))).toBe(true);
    });

    it('rejects an entry pointing at a deleted recipe', () => {
      const doc = validDoc();
      doc.cookLog['2026-08-21T19:00:00Z'] = 'gone';
      expect(validate(doc).some(e => e.message.includes('unknown recipe "gone"'))).toBe(true);
    });
  });

  describe('shopping', () => {
    it('rejects provenance pointing at a deleted recipe', () => {
      const doc = validDoc();
      doc.shopping['1/2 cup chopped red onion'].recipe = 'gone';
      expect(validate(doc).some(e => e.message.includes('unknown recipe "gone"'))).toBe(true);
    });

    it('rejects a key that is not the normalized name', () => {
      const doc = validDoc();
      doc.shopping['Saffron '] = { name: 'Saffron ', added: '2026-08-30T10:00:01Z' };
      expect(validate(doc).some(e => e.message.includes('shopping key "Saffron "'))).toBe(true);
    });

    it('rejects unparseable timestamps', () => {
      const doc = validDoc();
      doc.shopping['saffron'].bought = '2026-02-30T12:00:00Z';
      expect(validate(doc).some(e => e.message.includes('not a valid date/time'))).toBe(true);
    });
  });

  it('slugifyRecipeId derives readable ids from titles', () => {
    expect(slugifyRecipeId('Spanish Paella Recipe')).toBe('spanish-paella-recipe');
    expect(slugifyRecipeId("  Mom's World-Famous Banana Bread!  ")).toBe('mom-s-world-famous-banana-bread');
    expect(slugifyRecipeId('北京烤鸭')).toBe('recipe'); // nothing sluggable → fallback, caller dedupes
  });
});
