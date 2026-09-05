/**
 * Ingredient line parsing and display.
 *
 * `recipeIngredient` is a mixed array (see src/shared/schemas/kitchen.ts): a
 * line whose leading quantity parses becomes a schema.org PropertyValue, the
 * rest stay verbatim strings. This module is the single parser — the editor's
 * ingredients pane and the tmp-recipes migration script both use it, so the two
 * can never disagree about what parses.
 *
 * Round-trip contract (tested): `parseIngredient(formatIngredient(x))` is
 * value-identical to `x` for every entry this parser produces. Exact string
 * round-trips are NOT promised — "3/4 cup of sugar" formats back as
 * "3/4 cup sugar" — only stable values, so re-saving an untouched pane never
 * churns the document.
 */

import type { IngredientValue } from '../../../../shared/schemas/kitchen';

/** Units worth structuring, matched case-insensitively with optional plural.
 * Anything else stays part of the name ("1 egg", "2 large onions"). */
const UNIT_WORDS = [
  'cup', 'tablespoon', 'tbsp', 'teaspoon', 'tsp',
  'pound', 'lb', 'ounce', 'oz', 'gram', 'g', 'kg',
  'liter', 'litre', 'ml', 'quart', 'pint', 'gallon',
  'clove', 'can', 'jar', 'bunch', 'head', 'slice', 'pinch', 'dash',
  'sprig', 'stalk', 'stick', 'handful', 'package', 'bag', 'box',
];
const UNIT_RE = new RegExp(`^(${UNIT_WORDS.join('|')})(s|es)?$`, 'i');

/** Display words for the UN/CEFACT codes an imported card may carry. */
const UNIT_CODES: Record<string, string> = {
  G21: 'cup', G24: 'tablespoon', G25: 'teaspoon',
  GRM: 'g', KGM: 'kg', ONZ: 'oz', LBR: 'lb', LTR: 'l', MLT: 'ml',
};

const VULGAR: Record<string, string> = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4',
  '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5',
  '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};

/** "2", "1/2", or the mixed form "1 1/2". */
const AMOUNT = String.raw`\d+(?:\s+\d+/\d+)?(?:/\d+)?`;
/** A leading quantity: an amount, optionally ranged with "to" ("1 to 1 1/2"). */
const QUANTITY_RE = new RegExp(String.raw`^(${AMOUNT}(?:\s+to\s+${AMOUNT})?)\s+(.+)$`, 'i');

/**
 * Parse one ingredient line. Returns a PropertyValue when a leading quantity
 * (and optionally a known unit word) can be extracted, else the line verbatim.
 * Pure-integer quantities become numbers; fractions/ranges stay verbatim text
 * so "1 1/2" is never mangled into 1.5.
 */
export function parseIngredient(line: string): string | IngredientValue {
  const raw = line.trim();
  if (!raw) return line;
  let s = raw;
  for (const [glyph, ascii] of Object.entries(VULGAR)) {
    // "1½" is the mixed number one-and-a-half — restore its space.
    s = s.replace(new RegExp(`(?<=\\d)${glyph}`, 'g'), ` ${ascii}`).replaceAll(glyph, ascii);
  }
  s = s.replace(/\s+/g, ' ');

  const m = QUANTITY_RE.exec(s);
  if (!m) return raw;
  const quantity = m[1].replace(/\s+to\s+/i, ' to ');
  let rest = m[2].trim();
  // "3 or 4 ripe bananas" — an "or" range deliberately stays a plain string
  // (the schema.org example keeps exactly this line as text).
  if (/^or\s/i.test(rest)) return raw;

  let unitText: string | undefined;
  const firstWord = rest.split(' ', 1)[0];
  if (UNIT_RE.test(firstWord)) {
    unitText = firstWord;
    rest = rest.slice(firstWord.length).trim();
    if (rest.toLowerCase().startsWith('of ')) rest = rest.slice(3).trim();
  }

  if (!rest) return raw; // "2 cups" of nothing — keep the line as written
  const value = /^\d+$/.test(quantity) ? Number(quantity) : quantity;
  return { '@type': 'PropertyValue', name: rest, value, ...(unitText ? { unitText } : {}) };
}

/** The display line for either entry form. */
export function formatIngredient(entry: string | IngredientValue): string {
  if (typeof entry === 'string') return entry;
  const unit = entry.unitText ?? (entry.unitCode ? UNIT_CODES[entry.unitCode] : undefined);
  return [String(entry.value), unit, entry.name].filter(Boolean).join(' ');
}
