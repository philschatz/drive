import { parseIngredient, formatIngredient } from './ingredients';

describe('parseIngredient', () => {
  it('structures quantity + unit + name', () => {
    expect(parseIngredient('1/2 cup chopped English cucumber')).toEqual({
      '@type': 'PropertyValue', value: '1/2', unitText: 'cup', name: 'chopped English cucumber',
    });
    expect(parseIngredient('2 tablespoons olive oil')).toEqual({
      '@type': 'PropertyValue', value: 2, unitText: 'tablespoons', name: 'olive oil',
    });
  });

  it('makes integer quantities numbers and keeps fractions as text', () => {
    expect(parseIngredient('1 egg')).toEqual({ '@type': 'PropertyValue', value: 1, name: 'egg' });
    expect((parseIngredient('3/4 cup sugar') as any).value).toBe('3/4');
    expect((parseIngredient('1 1/2 cups flour') as any).value).toBe('1 1/2');
  });

  it('drops a leading "of" after the unit', () => {
    expect(parseIngredient('3/4 cup of sugar')).toEqual({
      '@type': 'PropertyValue', value: '3/4', unitText: 'cup', name: 'sugar',
    });
  });

  it('keeps "to" ranges as verbatim text values', () => {
    expect(parseIngredient('1 to 1 1/2 cups hummus (10 to 15 ounces)')).toEqual({
      '@type': 'PropertyValue', value: '1 to 1 1/2', unitText: 'cups', name: 'hummus (10 to 15 ounces)',
    });
  });

  it('normalizes unicode vulgar fractions, including mixed numbers', () => {
    expect((parseIngredient('¾ cup Greek yogurt') as any).value).toBe('3/4');
    expect(parseIngredient('1½ cups flour')).toEqual({
      '@type': 'PropertyValue', value: '1 1/2', unitText: 'cups', name: 'flour',
    });
  });

  it('treats a non-unit first word as part of the name', () => {
    expect(parseIngredient('2 large eggs')).toEqual({ '@type': 'PropertyValue', value: 2, name: 'large eggs' });
  });

  it('leaves unparseable lines verbatim', () => {
    for (const line of [
      'Salt and pepper',
      'Olive oil, for drizzling',
      '3 or 4 ripe bananas, smashed', // "or" ranges deliberately stay text (the schema.org example keeps this one plain)
      'Pita chips, for serving',
      '2 cups', // a quantity of nothing
    ]) {
      expect(parseIngredient(line)).toBe(line);
    }
  });
});

describe('formatIngredient', () => {
  it('passes strings through and renders PropertyValues', () => {
    expect(formatIngredient('Salt and pepper')).toBe('Salt and pepper');
    expect(formatIngredient({ '@type': 'PropertyValue', value: 1, name: 'egg' })).toBe('1 egg');
    expect(formatIngredient({ '@type': 'PropertyValue', value: '3/4', name: 'sugar', unitText: 'cup' })).toBe('3/4 cup sugar');
  });

  it('maps known UN/CEFACT unitCodes for display', () => {
    expect(formatIngredient({ '@type': 'PropertyValue', value: '3/4', name: 'sugar', unitCode: 'G21' })).toBe('3/4 cup sugar');
    expect(formatIngredient({ '@type': 'PropertyValue', value: 200, name: 'feta', unitCode: 'GRM' })).toBe('200 g feta');
    expect(formatIngredient({ '@type': 'PropertyValue', value: 2, name: 'onions', unitCode: 'XXX' })).toBe('2 onions');
  });
});

describe('round-trip stability', () => {
  // The editor shows formatIngredient lines and re-parses on save; a value that
  // shifted on that trip would churn the document under an untouched pane.
  const LINES = [
    '1/2 cup chopped English cucumber',
    '1 to 1 1/2 cups hummus (10 to 15 ounces)',
    '3/4 cup of sugar',
    '1 egg',
    '2 large eggs',
    '2 tablespoons olive oil',
    '1/2 teaspoon each garlic powder, onion powder, dried oregano',
    '1½ cups flour',
    'Salt and pepper',
    'Olive oil, for drizzling',
    '1 (15-ounce) can chickpeas',
  ];

  it('parse(format(parse(line))) is value-identical to parse(line)', () => {
    for (const line of LINES) {
      const first = parseIngredient(line);
      expect(parseIngredient(formatIngredient(first))).toEqual(first);
    }
  });
});
