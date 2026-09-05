import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { Temporal } from 'temporal-polyfill';
import { MdTextField } from '@/components/ui/md-text-field';
import { Button } from '@/components/ui/button';
import { PropertySheet, SheetActions, SheetActionItem } from '../../common/PropertySheet';
import type { PropertyDef } from '../../common/PropertySheet';
import { FieldEditor, GroupEditor } from '../../common/FieldEditor';
import type { PeerFieldInfo } from '../../common/presence';
import type { KitchenRecipe } from '../../../../shared/schemas/kitchen';
import { parseIngredient, formatIngredient } from './ingredients';

export const RECIPE_FIELD_TO_PROP: Record<string, string> = {
  'red-name': 'name',
  'red-desc': 'description',
  'red-yield': 'recipeYield',
  'red-prep': 'prepTime',
  'red-cook': 'cookTime',
  'red-total': 'totalTime',
  'red-category': 'recipeCategory',
  'red-cuisine': 'recipeCuisine',
  'red-ingredients': 'recipeIngredient',
  'red-instructions': 'recipeInstructions',
  'red-supply': 'supply',
  'red-tool': 'tool',
  'red-methods': 'cookingMethod',
};

const minutesFromIso = (iso: string | undefined): string => {
  if (!iso) return '';
  try {
    return String(Math.round(Temporal.Duration.from(iso).total({ unit: 'minutes' })));
  } catch {
    return '';
  }
};
const isoFromMinutes = (min: string): string => `PT${parseInt(min, 10) || 0}M`;
const isMinutes = (v: string) => /^\d+$/.test(v.trim());

const splitLines = (text: string): string[] => text.split('\n').map(s => s.trim()).filter(Boolean);

interface Fields {
  name: string;
  description: string;
  yieldStr: string;
  prepMin: string;
  cookMin: string;
  totalMin: string;
  category: string;
  cuisine: string;
  ingredientsText: string;
  instructionsText: string;
  supplyText: string;
  toolText: string;
  methodsText: string;
}

const fieldsFrom = (recipe: KitchenRecipe | null): Fields => ({
  name: recipe?.name ?? '',
  description: recipe?.description ?? '',
  yieldStr: recipe?.recipeYield ?? '',
  prepMin: minutesFromIso(recipe?.prepTime),
  cookMin: minutesFromIso(recipe?.cookTime),
  totalMin: minutesFromIso(recipe?.totalTime),
  category: recipe?.recipeCategory ?? '',
  cuisine: recipe?.recipeCuisine ?? '',
  ingredientsText: (recipe?.recipeIngredient ?? []).map(formatIngredient).join('\n'),
  instructionsText: (recipe?.recipeInstructions ?? []).join('\n'),
  supplyText: (recipe?.supply ?? []).join('\n'),
  toolText: (recipe?.tool ?? []).join('\n'),
  methodsText: (recipe?.cookingMethod ?? []).join('\n'),
});

/**
 * The recipe editor, in the house PropertySheet idiom, with two modes:
 *
 * EDIT (id set): each pane is transactional — its Save assembles the complete
 * recipe and makes one document change; pane validators refuse to empty a
 * required field.
 *
 * CREATE (id null): the whole draft lives here, and NOTHING is written until
 * the footer's Create button — enabled only once every required field has a
 * real value — commits the complete recipe in one change. Dismissing the sheet
 * before that discards the draft; there is deliberately no quick-add.
 */
export function RecipeEditor({
  opened, id, recipe, onCreate, onSave, onDelete, onClose,
  onFieldFocus, editingPathBase, peerFocusedFields,
}: {
  opened: boolean;
  /** null = create mode. */
  id: string | null;
  recipe: KitchenRecipe | null;
  onCreate: (recipe: KitchenRecipe) => void;
  onSave: (id: string, recipe: KitchenRecipe) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onFieldFocus?: (path: (string | number)[] | null) => void;
  /** ['recipes', id] while editing; null while creating (nothing to point at). */
  editingPathBase?: (string | number)[] | null;
  peerFocusedFields?: Record<string, PeerFieldInfo>;
}) {
  const isNew = id === null;
  const [fields, setFields] = useState<Fields>(() => fieldsFrom(recipe));
  const set = useCallback(<K extends keyof Fields>(key: K, value: Fields[K]) =>
    setFields(f => ({ ...f, [key]: value })), []);

  // Re-seed when the edited recipe changes identity, and per-field when a
  // synced edit lands under the open editor (the TaskEditor idiom).
  const prevRef = useRef({ id, recipe });
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { id, recipe };
    if (prev.id !== id) {
      setFields(fieldsFrom(recipe));
      return;
    }
    if (!recipe || prev.recipe === recipe) return;
    const fresh = fieldsFrom(recipe);
    const old = fieldsFrom(prev.recipe);
    setFields(f => {
      const next = { ...f };
      for (const k of Object.keys(fresh) as Array<keyof Fields>) {
        if (old[k] !== fresh[k]) next[k] = fresh[k];
      }
      return next;
    });
  }, [id, recipe]);

  const focusField = useCallback((fieldId: string) => {
    if (onFieldFocus && editingPathBase) onFieldFocus([...editingPathBase, RECIPE_FIELD_TO_PROP[fieldId]]);
  }, [onFieldFocus, editingPathBase]);
  const blurField = useCallback(() => onFieldFocus?.(null), [onFieldFocus]);

  /** The complete recipe the current fields describe. Unedited properties
   * (url, image, keywords) ride through from the saved recipe. Cleared optional
   * fields are DELETED, never set to undefined — an undefined property would
   * reach the serialized change callback and throw inside Automerge. */
  const assemble = (f: Fields): KitchenRecipe => {
    const out: KitchenRecipe = {
      ...(recipe ?? ({} as KitchenRecipe)),
      '@type': 'Recipe',
      name: f.name.trim(),
      description: f.description.trim(),
      recipeYield: f.yieldStr.trim(),
      prepTime: isoFromMinutes(f.prepMin),
      cookTime: isoFromMinutes(f.cookMin),
      totalTime: isoFromMinutes(f.totalMin),
      recipeIngredient: splitLines(f.ingredientsText).map(parseIngredient),
      recipeInstructions: splitLines(f.instructionsText),
      supply: splitLines(f.supplyText),
      tool: splitLines(f.toolText),
      cookingMethod: splitLines(f.methodsText),
    };
    if (f.category.trim()) out.recipeCategory = f.category.trim(); else delete out.recipeCategory;
    if (f.cuisine.trim()) out.recipeCuisine = f.cuisine.trim(); else delete out.recipeCuisine;
    return out;
  };

  /** EDIT mode: one pane save = one document change. No-op while creating. */
  const commit = (part: Partial<Fields>) => {
    const next = { ...fields, ...part };
    setFields(next);
    if (!isNew) onSave(id!, assemble(next));
  };

  /** What still blocks Create — also the disabled button's hint. */
  const missingForCreate = (f: Fields): string[] => {
    const missing: string[] = [];
    if (!f.name.trim()) missing.push('name');
    if (!f.description.trim()) missing.push('description');
    if (!f.yieldStr.trim()) missing.push('servings');
    if (!isMinutes(f.prepMin)) missing.push('prep time');
    if (!isMinutes(f.cookMin)) missing.push('cook time');
    if (!isMinutes(f.totalMin)) missing.push('total time');
    if (splitLines(f.ingredientsText).length === 0) missing.push('ingredients');
    if (splitLines(f.instructionsText).length === 0) missing.push('instructions');
    return missing;
  };
  const missing = missingForCreate(fields);

  const textPane = (
    fieldId: string, label: string, icon: string, key: keyof Fields,
    opts: { required?: boolean; textarea?: boolean; rows?: number; summary?: () => string } = {},
  ): PropertyDef => ({
    id: fieldId,
    label,
    icon,
    summary: opts.summary ?? (() => fields[key]),
    transactional: true,
    render: ({ back }) => (
      <FieldEditor
        key={id ?? 'new'}
        data-testid={fieldId}
        value={fields[key]}
        validate={opts.required && !isNew ? v => !!v.trim() : undefined}
        onCancel={back}
        onSave={v => { commit({ [key]: v } as Partial<Fields>); back(); }}
      >
        {({ value, onInput, save }) => (
          <MdTextField
            label={label}
            data-testid={fieldId}
            value={value}
            onInput={onInput}
            onFocus={() => focusField(fieldId)}
            onBlur={blurField}
            {...(opts.textarea
              ? { type: 'textarea' as const, rows: opts.rows ?? 6 }
              : { onEnter: save })}
          />
        )}
      </FieldEditor>
    ),
  });

  const lineCount = (text: string, noun: string) => {
    const n = splitLines(text).length;
    return n === 0 ? '' : `${n} ${noun}${n === 1 ? '' : 's'}`;
  };

  const properties: PropertyDef[] = [
    textPane('red-name', 'Name', 'edit', 'name', { required: true }),
    textPane('red-desc', 'Description', 'notes', 'description', { required: true, textarea: true, rows: 3 }),
    {
      id: 'red-times',
      label: 'Time',
      icon: 'schedule',
      presenceIds: ['red-prep', 'red-cook', 'red-total'],
      summary: () => {
        const parts = [];
        if (fields.prepMin) parts.push(`${fields.prepMin} min prep`);
        if (fields.cookMin) parts.push(`${fields.cookMin} min cook`);
        if (fields.totalMin) parts.push(`${fields.totalMin} min total`);
        return parts.join(' · ');
      },
      transactional: true,
      render: ({ back }) => (
        <GroupEditor<Pick<Fields, 'prepMin' | 'cookMin' | 'totalMin'>>
          key={id ?? 'new'}
          data-testid="red-times"
          value={{ prepMin: fields.prepMin, cookMin: fields.cookMin, totalMin: fields.totalMin }}
          validate={isNew ? undefined : d => isMinutes(d.prepMin) && isMinutes(d.cookMin) && isMinutes(d.totalMin)}
          onCancel={back}
          onSave={d => { commit(d); back(); }}
        >
          {({ draft, patch }) => (
            <div className="flex flex-col gap-3">
              {([['red-prep', 'Prep minutes', 'prepMin'], ['red-cook', 'Cook minutes (0 for no-cook)', 'cookMin'], ['red-total', 'Total minutes', 'totalMin']] as const).map(([fid, label, key]) => (
                <MdTextField
                  key={fid}
                  label={label}
                  type="number"
                  min={0}
                  data-testid={fid}
                  value={draft[key]}
                  onInput={v => patch({ [key]: v } as any)}
                  onFocus={() => focusField(fid)}
                  onBlur={blurField}
                />
              ))}
            </div>
          )}
        </GroupEditor>
      ),
    },
    textPane('red-yield', 'Servings', 'group', 'yieldStr', { required: true }),
    textPane('red-category', 'Category', 'category', 'category'),
    textPane('red-cuisine', 'Cuisine', 'public', 'cuisine'),
    textPane('red-ingredients', 'Ingredients', 'grocery', 'ingredientsText', {
      required: true, textarea: true, rows: 10,
      summary: () => lineCount(fields.ingredientsText, 'ingredient'),
    }),
    textPane('red-instructions', 'Instructions', 'list_alt', 'instructionsText', {
      required: true, textarea: true, rows: 10,
      summary: () => lineCount(fields.instructionsText, 'step'),
    }),
    textPane('red-supply', 'Pantry staples', 'kitchen', 'supplyText', {
      textarea: true, rows: 5,
      summary: () => lineCount(fields.supplyText, 'staple'),
    }),
    textPane('red-tool', 'Tools', 'handyman', 'toolText', {
      textarea: true, rows: 5,
      summary: () => lineCount(fields.toolText, 'tool'),
    }),
    textPane('red-methods', 'Techniques', 'school', 'methodsText', {
      textarea: true, rows: 5,
      summary: () => lineCount(fields.methodsText, 'technique'),
    }),
  ];

  return (
    <PropertySheet
      open={opened}
      title={isNew ? 'New recipe' : 'Edit recipe'}
      data-testid="recipe-editor"
      properties={properties}
      peerFocusedFields={peerFocusedFields}
      initialDetailId={isNew ? 'red-name' : null}
      onClose={onClose}
      footer={isNew ? (
        <div className="mt-4 flex items-center gap-3" data-testid="red-create-row">
          {missing.length > 0 && (
            <span className="text-xs text-muted-foreground flex-1" data-testid="red-missing">
              Still needed: {missing.join(', ')}
            </span>
          )}
          <Button
            className="ml-auto"
            disabled={missing.length > 0}
            data-testid="red-create"
            onClick={() => { if (missing.length === 0) onCreate(assemble(fields)); }}
          >
            Create
          </Button>
        </div>
      ) : (
        <SheetActions>
          <SheetActionItem
            icon="delete"
            label="Delete"
            destructive
            data-testid="red-delete"
            onClick={() => { if (confirm('Delete this recipe?')) onDelete(id!); }}
          />
        </SheetActions>
      )}
    />
  );
}
