import 'temporal-polyfill/global';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

// In-memory + jq mock so the real Kitchen container runs in jsdom. md-* custom
// elements are NOT registered here, so rows are inert hosts driven by their own
// handlers and the two-mode Md* wrappers fall back to real inputs.
jest.mock('../../worker-api');
import * as api from '../../worker-api';
import { Kitchen } from './Kitchen';
import { normName, type KitchenDocument, type KitchenRecipe } from '../../../../shared/schemas/kitchen';

const mock = api as any;

// Guards the positional __mocks__ resolution: a drift would silently load the
// real module and fail everything below for unrelated-looking reasons.
it('uses the manual worker-api mock', () => expect(mock.__isMock).toBe(true));

const DOC = 'doc-kitchen';

const tap = (el: Element) => {
  fireEvent.pointerDown(el);
  fireEvent.pointerUp(el);
  fireEvent.click(el);
};
const tab = (id: string) => tap(document.querySelector(`[data-tab="${id}"]`)!);

const recipe = (over: Partial<KitchenRecipe> = {}): KitchenRecipe => ({
  '@type': 'Recipe',
  name: 'Plain Salad',
  description: 'Just a salad.',
  recipeYield: '2',
  prepTime: 'PT10M',
  cookTime: 'PT0M',
  totalTime: 'PT10M',
  recipeIngredient: ['1 head lettuce', { '@type': 'PropertyValue', value: 2, name: 'tomatoes' }],
  recipeInstructions: ['Chop.', 'Toss.'],
  supply: [],
  tool: [],
  cookingMethod: [],
  ...over,
});

const doc = (): KitchenDocument => ({
  '@type': 'Kitchen',
  name: 'Test Kitchen',
  recipes: {
    'plain-salad': recipe(),
    'poached-eggs': recipe({ name: 'Poached Eggs', cookingMethod: ['poaching eggs in sauce'] }),
    'paprika-stew': recipe({ name: 'Paprika Stew', supply: ['Smoked Paprika'], cookingMethod: ['simmering'] }),
  },
  inventory: {},
  cookLog: {},
  shopping: {},
});

const renderKitchen = async (recipeId?: string) => {
  const utils = render(<Kitchen docId={DOC} recipeId={recipeId} />);
  await waitFor(() => expect(document.querySelector('[data-testid="kitchen-tabs"], [data-testid="recipe-detail"], [data-testid="recipe-missing"]')).toBeTruthy());
  return utils;
};

describe('Kitchen container', () => {
  beforeEach(() => {
    mock.__reset();
    window.location.hash = '';
  });

  it('defaults to the Locked tab with fewest-missing ordering and status badges', async () => {
    mock.__setDoc(DOC, doc());
    await renderKitchen();

    // Locked is the default when nothing is pending on the shopping list.
    const rows = Array.from(document.querySelectorAll('[data-testid="recipe-row"]'));
    expect(rows.map(r => r.getAttribute('data-status'))).toEqual(['locked']);
    expect(screen.getByText('Paprika Stew')).toBeTruthy();

    // Ready hosts both cookable states: ready and learnable (cook to learn).
    tab('ready');
    const readyRows = Array.from(document.querySelectorAll('[data-testid="recipe-row"]'));
    expect(readyRows.map(r => r.getAttribute('data-status')).sort()).toEqual(['learnable', 'ready']);
    expect(screen.getByText('cook to learn')).toBeTruthy();
  });

  it('recipe rows are real links to recipe/<id>', async () => {
    mock.__setDoc(DOC, doc());
    await renderKitchen();
    tab('ready');
    const row = screen.getByText('Plain Salad').closest('md-list-item')!;
    expect(row.getAttribute('href')).toBe(`#/d/${DOC}/recipe/plain-salad`);
  });

  it('the best-purchase callout names the unlock and adds it to shopping', async () => {
    mock.__setDoc(DOC, doc());
    await renderKitchen();
    const callout = screen.getByTestId('best-purchase');
    expect(callout.textContent).toContain('Smoked Paprika');
    expect(callout.textContent).toContain('unlock 1 recipe');
    tap(screen.getByRole('button', { name: 'Add to list' }));
    const item = mock.__getDoc(DOC).shopping['smoked paprika'];
    expect(item).toMatchObject({ name: 'Smoked Paprika', staple: true });
  });

  it('toggling an inventory row acquires and un-acquires', async () => {
    mock.__setDoc(DOC, doc());
    await renderKitchen();
    tab('inventory');
    const row = screen.getByText('Smoked Paprika').closest('md-list-item')!;
    tap(row);
    expect(mock.__getDoc(DOC).inventory['smoked paprika']).toMatchObject({ name: 'Smoked Paprika', kind: 'supply' });
    tap(screen.getByText('Smoked Paprika').closest('md-list-item')!);
    expect(mock.__getDoc(DOC).inventory['smoked paprika']).toBeUndefined();
  });

  describe('recipe page', () => {
    it('cooking a learnable recipe logs the cook AND learns its techniques in one change', async () => {
      mock.__setDoc(DOC, doc());
      await renderKitchen('poached-eggs');
      expect(screen.getByText(/Cooking this teaches/)).toBeTruthy();

      tap(screen.getByTestId('cook-button'));
      const d = mock.__getDoc(DOC);
      expect(Object.values(d.cookLog)).toEqual(['poached-eggs']);
      expect(d.inventory['poaching eggs in sauce']).toMatchObject({ kind: 'technique' });
      // The learn timestamp IS the cook timestamp — one gesture, one moment.
      expect(d.inventory['poaching eggs in sauce'].acquired).toBe(Object.keys(d.cookLog)[0]);
    });

    it('a locked recipe cannot be cooked', async () => {
      mock.__setDoc(DOC, doc());
      await renderKitchen('paprika-stew');
      expect((screen.getByTestId('cook-button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('tapping an ingredient toggles it on the shopping list; Shop for this recipe adds the rest', async () => {
      mock.__setDoc(DOC, doc());
      await renderKitchen('plain-salad');

      const lettuce = screen.getByText('1 head lettuce').closest('md-list-item')!;
      tap(lettuce);
      expect(mock.__getDoc(DOC).shopping[normName('1 head lettuce')]).toMatchObject({
        name: '1 head lettuce', recipe: 'plain-salad',
      });

      // Un-check removes the pending item.
      tap(screen.getByText('1 head lettuce').closest('md-list-item')!);
      expect(mock.__getDoc(DOC).shopping[normName('1 head lettuce')]).toBeUndefined();

      tap(screen.getByTestId('shop-recipe'));
      const keys = Object.keys(mock.__getDoc(DOC).shopping).sort();
      expect(keys).toEqual(['1 head lettuce', '2 tomatoes']);
    });

    it('a missing staple chip goes to the shopping list; a missing tool chip marks it owned', async () => {
      const d = doc();
      d.recipes['paprika-stew'].tool = ['Dutch oven'];
      mock.__setDoc(DOC, d);
      await renderKitchen('paprika-stew');

      tap(screen.getByRole('button', { name: /Smoked Paprika/ }));
      expect(mock.__getDoc(DOC).shopping['smoked paprika']).toMatchObject({ staple: true, recipe: 'paprika-stew' });

      tap(screen.getByRole('button', { name: /Dutch oven/ }));
      expect(mock.__getDoc(DOC).inventory['dutch oven']).toMatchObject({ kind: 'tool' });
    });

    it('a deleted recipe id renders the not-found block', async () => {
      mock.__setDoc(DOC, doc());
      await renderKitchen('gone');
      expect(screen.getByTestId('recipe-missing')).toBeTruthy();
    });
  });

  describe('shopping as the main page', () => {
    it('pending items make Shopping the default tab; buying a staple acquires it; Clear bought sweeps', async () => {
      const d = doc();
      d.shopping = {
        'smoked paprika': { name: 'Smoked Paprika', added: '2026-08-30T10:00:00Z', staple: true },
        '1 head lettuce': { name: '1 head lettuce', added: '2026-08-30T10:00:01Z', recipe: 'plain-salad' },
      };
      mock.__setDoc(DOC, d);
      await renderKitchen();

      // The requirement: things to buy ARE the main page while any are pending.
      expect(screen.getByText('2 to buy')).toBeTruthy();
      expect(screen.getByText('for Plain Salad')).toBeTruthy();

      tap(screen.getByText('Smoked Paprika').closest('md-list-item')!);
      let stored = mock.__getDoc(DOC);
      expect(stored.shopping['smoked paprika'].bought).toBeTruthy();
      expect(stored.inventory['smoked paprika']).toMatchObject({ kind: 'supply' });

      tap(screen.getByRole('button', { name: 'Clear bought' }));
      stored = mock.__getDoc(DOC);
      expect(stored.shopping['smoked paprika']).toBeUndefined();
      expect(stored.shopping['1 head lettuce']).toBeTruthy(); // still pending
      expect(stored.inventory['smoked paprika']).toBeTruthy(); // acquisition survives the sweep
    });

    it('un-buying a staple un-acquires it (mistake correction is symmetric)', async () => {
      const d = doc();
      d.shopping = { 'smoked paprika': { name: 'Smoked Paprika', added: '2026-08-30T10:00:00Z', staple: true, bought: '2026-08-31T09:00:00Z' } };
      d.inventory = { 'smoked paprika': { name: 'Smoked Paprika', kind: 'supply', acquired: '2026-08-31T09:00:00Z' } };
      mock.__setDoc(DOC, d);
      await renderKitchen();

      // Nothing is pending, so Shopping is not the default tab — but it still
      // exists while any item (bought included) is on the list.
      tab('shopping');
      tap(screen.getByText('Smoked Paprika').closest('md-list-item')!);
      const stored = mock.__getDoc(DOC);
      expect(stored.shopping['smoked paprika'].bought).toBeUndefined();
      expect(stored.inventory['smoked paprika']).toBeUndefined();
    });
  });

  describe('creating a recipe (no quick-add)', () => {
    it('Create stays disabled with a what is-missing hint until every required field is filled, and dismissing early writes nothing', async () => {
      mock.__setDoc(DOC, doc());
      await renderKitchen();

      fireEvent.click(document.querySelector('md-fab')!);
      // New recipes open straight into the Name pane; saving it only updates
      // the DRAFT (nothing reaches the document without Create).
      fireEvent.input(screen.getByTestId('red-name'), { target: { value: 'Simple Soup' } });
      fireEvent.click(screen.getByTestId('red-name-save'));

      expect((screen.getByTestId('red-create') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId('red-missing').textContent).toContain('description');
      expect(Object.keys(mock.__getDoc(DOC).recipes)).toHaveLength(3);

      // Dismiss early: still nothing written.
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(Object.keys(mock.__getDoc(DOC).recipes)).toHaveLength(3);
    });

    it('a fully-filled draft creates one complete recipe under a title-derived id', async () => {
      mock.__setDoc(DOC, doc());
      await renderKitchen();

      fireEvent.click(document.querySelector('md-fab')!);
      fireEvent.input(screen.getByTestId('red-name'), { target: { value: 'Simple Soup' } });
      fireEvent.click(screen.getByTestId('red-name-save'));

      const fill = (rowId: string, fields: Record<string, string>, saveId = rowId) => {
        fireEvent.click(screen.getByTestId(`${rowId}-row`));
        for (const [testId, value] of Object.entries(fields)) {
          fireEvent.input(screen.getByTestId(testId), { target: { value } });
        }
        fireEvent.click(screen.getByTestId(`${saveId}-save`));
      };
      fill('red-desc', { 'red-desc': 'Warm.' });
      fill('red-yield', { 'red-yield': '4' });
      fill('red-times', { 'red-prep': '10', 'red-cook': '20', 'red-total': '30' });
      fill('red-ingredients', { 'red-ingredients': '2 cups broth\n1 onion' });
      fill('red-instructions', { 'red-instructions': 'Simmer.\nServe.' });

      const create = screen.getByTestId('red-create') as HTMLButtonElement;
      expect(create.disabled).toBe(false);
      fireEvent.click(create);

      const stored = mock.__getDoc(DOC).recipes['simple-soup'];
      expect(stored).toMatchObject({
        '@type': 'Recipe',
        name: 'Simple Soup',
        description: 'Warm.',
        recipeYield: '4',
        prepTime: 'PT10M',
        cookTime: 'PT20M',
        totalTime: 'PT30M',
        recipeInstructions: ['Simmer.', 'Serve.'],
      });
      // Quantities were extracted on the way in (the schema.org mixed array).
      expect(stored.recipeIngredient).toEqual([
        { '@type': 'PropertyValue', value: 2, unitText: 'cups', name: 'broth' },
        { '@type': 'PropertyValue', value: 1, name: 'onion' },
      ]);
    });
  });

  it('editing an existing recipe saves per pane and refuses to empty a required field', async () => {
    mock.__setDoc(DOC, doc());
    await renderKitchen('plain-salad');

    fireEvent.click(document.querySelector('md-fab')!); // the Edit FAB on the detail page
    fireEvent.click(screen.getByTestId('red-name-row'));

    const input = screen.getByTestId('red-name');
    fireEvent.input(input, { target: { value: '' } });
    expect((screen.getByTestId('red-name-save') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.input(input, { target: { value: 'Plainer Salad' } });
    fireEvent.click(screen.getByTestId('red-name-save'));
    expect(mock.__getDoc(DOC).recipes['plain-salad'].name).toBe('Plainer Salad');
    // The id is identity — renaming must not move the map key.
    expect(mock.__getDoc(DOC).recipes['plainer-salad']).toBeUndefined();
  });
});
