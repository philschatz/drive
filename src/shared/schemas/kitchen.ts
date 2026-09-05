import {
  type ValidationError, type DocSchemaPlugin,
  type UTCDateTime, type Duration,
  str, num, bool, obj, record, arr, union,
  UTC_DATE_TIME_RE, DURATION_RE,
  isParseableLocalDateTime, isParseableDuration, isDangerousUri,
} from './core';

/**
 * Kitchen: a collection of recipes, each a strict schema.org/Recipe — only
 * schema.org vocabulary inside recipe values, so a scraped JSON-LD card maps
 * near-verbatim. Everything gamification-shaped lives at the document level:
 *
 * - `inventory` holds what is OWNED (pantry staples bought, tools on hand,
 *   techniques learned), keyed by normalized name. The unlockable vocabulary is
 *   never stored — it is derived from the recipes' own `supply` / `tool` /
 *   `cookingMethod` fields, matched against inventory keys via `normName`.
 * - `cookLog` is the completion log: click-timestamp → recipe uid.
 * - `shopping` is the built-in grocery list (ingredients only, never tools).
 *
 * Deliberately STRICTER than schema.org (which requires nothing): most recipe
 * fields are required, and name/yield/ingredients/instructions must be
 * non-empty. There is no draft state in the document — the editor only writes a
 * recipe once every required field has a real value.
 *
 * Merge caveat: `recipeIngredient`/`recipeInstructions` are Automerge arrays
 * edited wholesale by the editor (one pane save replaces the list). Concurrent
 * edits to the same list resolve last-write-wins per element; acceptable for
 * rarely-edited text lines.
 */

export type InventoryKind = 'supply' | 'tool' | 'technique';

/**
 * A structured ingredient line — schema.org PropertyValue, exactly the shape
 * the schema.org/Recipe JSON-LD example mixes into `recipeIngredient`:
 *   { "@type": "PropertyValue", "value": "3/4", "name": "sugar", "unitCode": "G21" }
 * A line whose quantity cannot be parsed stays a plain string instead — a
 * PropertyValue with no value has no reason to exist.
 */
export interface IngredientValue {
  '@type': 'PropertyValue';
  /** The ingredient itself: "egg", "chopped English cucumber". */
  name: string;
  /** Integer quantities are numbers (1); fractions and ranges stay verbatim
   * Text ("3/4", "1 1/2", "1 to 1 1/2") so nothing is lossy. */
  value: number | string;
  /** UN/CEFACT common code — accepted for imported cards. */
  unitCode?: string;
  /** Human-readable unit ("cup", "teaspoon") — what our own parser emits. */
  unitText?: string;
}

export interface KitchenRecipe {
  '@type': 'Recipe';
  name: string;
  description: string;
  /** schema.org Text — "4", "8". */
  recipeYield: string;
  /** ISO 8601 durations. A no-cook recipe honestly says cookTime "PT0M". */
  prepTime: Duration;
  cookTime: Duration;
  totalTime: Duration;
  /** Ordered ingredient lines: verbatim Text, or PropertyValue where a
   * quantity+unit parsed out. Non-empty. */
  recipeIngredient: Array<string | IngredientValue>;
  /** Ordered steps (HowToStep objects are flattened to their text on import).
   * Non-empty. */
  recipeInstructions: string[];
  /** HowTo.supply: the shelf-stable staples that gate this recipe (fresh
   * ingredients are bought per-recipe and never gate). May be empty. */
  supply: string[];
  /** HowTo.tool. May be empty. */
  tool: string[];
  /** Techniques ("sautéing aromatics") — schema.org cookingMethod, used more
   * granularly than its "Frying, Steaming" examples. May be empty. */
  cookingMethod: string[];
  url?: string;
  image?: string;
  recipeCategory?: string;
  recipeCuisine?: string;
  keywords?: string;
}

export interface InventoryEntry {
  /** Display form; the map key must equal normName(name). */
  name: string;
  kind: InventoryKind;
  /** When it was bought / learned. Presence in the map == owned. */
  acquired: UTCDateTime;
}

export interface ShoppingItem {
  /** Display text exactly as listed: a (formatted) ingredient line or a staple
   * name. The map key must equal normName(name), so the same line wanted by two
   * recipes is naturally one grocery entry. */
  name: string;
  /** When it was added — the list's sort key (map keys sort alphabetically, not
   * chronologically). */
  added: UTCDateTime;
  /** Provenance: the recipe whose ingredient this is (first adder wins).
   * Powers the recipe view's checkbox state and the "for <recipe>" badge. */
  recipe?: string;
  /** True when the item IS a pantry staple from the gating vocabulary: buying
   * it upserts `inventory` (the key doubles as the inventory key) as kind
   * 'supply'. Tools are never shopping items. */
  staple?: boolean;
  /** Pending == absent. */
  bought?: UTCDateTime;
}

export interface KitchenDocument {
  '@type': 'Kitchen';
  name: string;
  description?: string;
  /** Keyed by any string; importers and the editor derive the key from the
   * recipe title via `slugifyRecipeId` (so URLs read `recipe/spanish-paella`).
   * The key is identity — renaming a recipe does not change it. */
  recipes: Record<string, KitchenRecipe>;
  inventory: Record<string, InventoryEntry>;
  cookLog: Record<string, string>;
  shopping: Record<string, ShoppingItem>;
}

/** The matching rule joining recipe requirement strings to inventory keys. */
export function normName(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * The recipe id an importer (or the editor) mints from a title: lowercased,
 * runs of non-alphanumerics collapsed to "-", trimmed. Callers must still
 * dedupe against the document ("-2", "-3", …) — two recipes may share a title.
 */
export function slugifyRecipeId(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'recipe';
}

export const ingredientValueSchema = obj({
  '@type': str({ enum: ['PropertyValue'] }),
  name: str(),
  value: union([num(), str()]),
  unitCode: str({ optional: true }),
  unitText: str({ optional: true }),
});

export const kitchenRecipeSchema = obj({
  '@type': str({ enum: ['Recipe'] }),
  name: str(),
  description: str(),
  recipeYield: str(),
  prepTime: str({ pattern: DURATION_RE }),
  cookTime: str({ pattern: DURATION_RE }),
  totalTime: str({ pattern: DURATION_RE }),
  recipeIngredient: arr(union([str(), ingredientValueSchema])),
  recipeInstructions: arr(str()),
  supply: arr(str()),
  tool: arr(str()),
  cookingMethod: arr(str()),
  url: str({ optional: true }),
  image: str({ optional: true }),
  recipeCategory: str({ optional: true }),
  recipeCuisine: str({ optional: true }),
  keywords: str({ optional: true }),
});

export const inventoryEntrySchema = obj({
  name: str(),
  kind: str({ enum: ['supply', 'tool', 'technique'] }),
  acquired: str({ pattern: UTC_DATE_TIME_RE }),
});

export const shoppingItemSchema = obj({
  name: str(),
  added: str({ pattern: UTC_DATE_TIME_RE }),
  recipe: str({ optional: true }),
  staple: bool({ optional: true }),
  bought: str({ pattern: UTC_DATE_TIME_RE, optional: true }),
});

export const kitchenDocumentSchema = obj({
  '@type': str({ enum: ['Kitchen'] }),
  name: str(),
  description: str({ optional: true }),
  recipes: record(kitchenRecipeSchema),
  inventory: record(inventoryEntrySchema),
  // Keys are click timestamps and values recipe uids — both checked in
  // checkKitchenDependencies (the DSL validates values' types, not keys).
  cookLog: record(str()),
  shopping: record(shoppingItemSchema),
});

/** UTC stamps ("2026-09-02T19:05:23.123Z") parse via their local-looking prefix;
 * the regex already vetted the trailing Z/offset. */
function stampParses(s: string): boolean {
  return isParseableLocalDateTime(s.substring(0, 19));
}

export function checkKitchenDependencies(doc: any, errors: ValidationError[]): void {
  const recipes = doc.recipes && typeof doc.recipes === 'object' ? doc.recipes : {};

  for (const [uid, recipe] of Object.entries(recipes)) {
    const r = recipe as any;
    const p = ['recipes', uid];

    // Stricter than schema.org: the fields that make a recipe cookable must
    // have real content, not just the right type.
    if (r.name === '') {
      errors.push({ path: [...p, 'name'], message: 'name must not be empty', kind: 'dependency' });
    }
    if (r.recipeYield === '') {
      errors.push({ path: [...p, 'recipeYield'], message: 'recipeYield must not be empty', kind: 'dependency' });
    }
    if (Array.isArray(r.recipeIngredient) && r.recipeIngredient.length === 0) {
      errors.push({ path: [...p, 'recipeIngredient'], message: 'a recipe needs at least one ingredient', kind: 'dependency' });
    }
    if (Array.isArray(r.recipeInstructions) && r.recipeInstructions.length === 0) {
      errors.push({ path: [...p, 'recipeInstructions'], message: 'a recipe needs at least one instruction', kind: 'dependency' });
    }

    // The duration regex admits degenerate forms like "P"; require Temporal to
    // agree, the same defense the calendar time fields use.
    for (const field of ['prepTime', 'cookTime', 'totalTime'] as const) {
      if (typeof r[field] === 'string' && !isParseableDuration(r[field])) {
        errors.push({ path: [...p, field], message: `${field} "${r[field]}" is not a valid ISO 8601 duration`, kind: 'dependency' });
      }
    }

    // url/image render as <a href>/<img src> — flag script-capable schemes.
    for (const field of ['url', 'image'] as const) {
      if (typeof r[field] === 'string' && isDangerousUri(r[field])) {
        errors.push({ path: [...p, field], message: `${field} uses a disallowed URI scheme`, kind: 'dependency' });
      }
    }

    if (Array.isArray(r.recipeIngredient)) {
      r.recipeIngredient.forEach((line: any, i: number) => {
        if (line && typeof line === 'object' && line.value === '') {
          errors.push({
            path: [...p, 'recipeIngredient', i, 'value'],
            message: 'a PropertyValue ingredient must carry a quantity (an unparsed line stays a plain string)',
            kind: 'dependency',
          });
        }
      });
    }
  }

  if (doc.inventory && typeof doc.inventory === 'object') {
    for (const [key, entry] of Object.entries(doc.inventory)) {
      const e = entry as any;
      if (typeof e.name === 'string' && key !== normName(e.name)) {
        errors.push({
          path: ['inventory', key],
          message: `inventory key "${key}" must be the normalized form of its name ("${normName(e.name)}")`,
          kind: 'dependency',
        });
      }
      if (typeof e.acquired === 'string' && !stampParses(e.acquired)) {
        errors.push({ path: ['inventory', key, 'acquired'], message: `acquired "${e.acquired}" is not a valid date/time`, kind: 'dependency' });
      }
    }
  }

  if (doc.cookLog && typeof doc.cookLog === 'object') {
    for (const [ts, uid] of Object.entries(doc.cookLog)) {
      if (!stampParses(ts)) {
        errors.push({ path: ['cookLog', ts], message: `cookLog key "${ts}" is not a valid date/time`, kind: 'dependency' });
      }
      if (typeof uid === 'string' && !(uid in recipes)) {
        errors.push({ path: ['cookLog', ts], message: `cookLog entry points at unknown recipe "${uid}"`, kind: 'dependency' });
      }
    }
  }

  if (doc.shopping && typeof doc.shopping === 'object') {
    for (const [key, item] of Object.entries(doc.shopping)) {
      const it = item as any;
      const p = ['shopping', key];
      if (typeof it.name === 'string' && key !== normName(it.name)) {
        errors.push({
          path: p,
          message: `shopping key "${key}" must be the normalized form of its name ("${normName(it.name)}")`,
          kind: 'dependency',
        });
      }
      for (const field of ['added', 'bought'] as const) {
        if (typeof it[field] === 'string' && !stampParses(it[field])) {
          errors.push({ path: [...p, field], message: `${field} "${it[field]}" is not a valid date/time`, kind: 'dependency' });
        }
      }
      if (typeof it.recipe === 'string' && !(it.recipe in recipes)) {
        errors.push({ path: [...p, 'recipe'], message: `shopping item points at unknown recipe "${it.recipe}"`, kind: 'dependency' });
      }
    }
  }
}

/** Worker-safe plugin core — registered in src/shared/schemas (validation) and
 * spread into the full kitchen plugin (src/client/ui/doc-plugins/kitchen/plugin.tsx). */
export const kitchenSchemaPlugin: DocSchemaPlugin = {
  type: 'Kitchen',
  schema: kitchenDocumentSchema,
  checkDeps: checkKitchenDependencies,
};
