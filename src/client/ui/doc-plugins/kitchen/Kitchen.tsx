import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { subscribeQuery, updateDoc } from '../../worker-api';
import { peerColor, peerDisplayName, usePresence, type PeerFieldInfo } from '../../common/presence';
import { DocumentTitleBar } from '../../common/DocumentTitleBar';
import { useDocumentHistory } from '../../common/useDocumentHistory';
import { useEditorUndoRedo } from '../../common/useUndoRedo';
import { useCanEdit } from '../../common/useCanEdit';
import { useFocusPathSync } from '../../common/useFocusPathSync';
import { HistorySlider } from '../../common/HistorySlider';
import { useDocumentValidation } from '../../common/useDocumentValidation';
import { DocLoader } from '../../common/useDocument';
import { Fab } from '@/components/ui/fab';
import { Button } from '@/components/ui/button';
import { docUrl } from '../../common/doc-urls';
import {
  normName, slugifyRecipeId,
  type InventoryEntry, type InventoryKind, type KitchenRecipe, type ShoppingItem,
} from '../../../../shared/schemas/kitchen';
import {
  recipeState, sortLocked, sortReady, bestPurchase, cookCounts, lastCookedByRecipe,
  type RecipeEntry, type Requirement,
} from './logic';
import { formatIngredient } from './ingredients';
import { PillTabs, type PillTab } from './PillTabs';
import { RecipeList } from './RecipeList';
import { InventoryTab } from './InventoryTab';
import { ShoppingList } from './ShoppingList';
import { RecipeDetail, lineKey } from './RecipeDetail';
import { RecipeEditor, RECIPE_FIELD_TO_PROP } from './RecipeEditor';

const KITCHEN_QUERY =
  '{ name: (.name // "Kitchen"), recipes: (.recipes // {}), inventory: (.inventory // {}), cookLog: (.cookLog // {}), shopping: (.shopping // {}) }';

const PATH_PROP_TO_FIELDS: Record<string, string[]> = Object.entries(RECIPE_FIELD_TO_PROP)
  .reduce((acc, [fieldId, prop]) => {
    (acc[prop] ??= []).push(fieldId);
    return acc;
  }, {} as Record<string, string[]>);

const nowIso = () => new Date().toISOString();

interface EditorState {
  /** null = creating (nothing exists in the document until Create). */
  id: string | null;
  recipe: KitchenRecipe | null;
}

export function Kitchen({ docId, recipeId, readOnly }: {
  docId?: string;
  recipeId?: string;
  readOnly?: boolean;
}) {
  const [name, setName] = useState('Kitchen');
  const [recipes, setRecipes] = useState<Record<string, KitchenRecipe>>({});
  const [inventory, setInventory] = useState<Record<string, InventoryEntry>>({});
  const [cookLog, setCookLog] = useState<Record<string, string>>({});
  const [shopping, setShopping] = useState<Record<string, ShoppingItem>>({});
  const [docLoaded, setDocLoaded] = useState(false);
  const [userTab, setUserTab] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const history = useDocumentHistory(docId!);
  const { undo, redo, canUndo, canRedo, onHeads } = useEditorUndoRedo(docId!, history);
  const validationErrors = useDocumentValidation(docId);
  const { canEdit, canEditRef, noAccess } = useCanEdit(docId, readOnly, history);
  const { peers, peerList, broadcast } = usePresence(docId);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const shoppingRef = useRef(shopping);
  shoppingRef.current = shopping;

  useEffect(() => {
    if (!docId) return;
    let mounted = true;
    const unsubscribe = subscribeQuery(docId, KITCHEN_QUERY, (result, heads) => {
      if (!mounted || !result) return;
      setRecipes(result.recipes || {});
      setInventory(result.inventory || {});
      setCookLog(result.cookLog || {});
      setShopping(result.shopping || {});
      setDocLoaded(true);
      if (result.name) {
        setName(result.name);
        document.title = result.name + ' - Kitchen';
      }
      onHeads(heads);
      // Refresh (or close) the editor when the recipe changes under it.
      const es = editorRef.current;
      if (es && es.id) {
        const fresh = (result.recipes || {})[es.id];
        setEditor(prev => {
          if (!prev || prev.id !== es.id) return prev;
          return fresh ? { ...prev, recipe: fresh } : null;
        });
      }
    });
    return () => { mounted = false; unsubscribe(); };
  }, [docId]);

  // ------------------------------------------------------------------
  // Mutations. Change callbacks are serialized — no closures, no Temporal;
  // timestamps and derived values computed here and passed as arguments.
  // ------------------------------------------------------------------

  const toggleOwned = useCallback((norm: string, itemName: string, kind: InventoryKind) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, norm, itemName, kind, ts) => {
      if (d.inventory[norm]) delete d.inventory[norm];
      else d.inventory[norm] = { name: itemName, kind, acquired: ts };
    }, norm, itemName, kind, nowIso());
  }, [docId]);

  /** Cook-to-learn: the cook-log entry and the newly-learned techniques are one
   * change, so one undo takes both back. */
  const recordCook = useCallback((id: string, learned: Array<{ norm: string; name: string }>) => {
    if (!canEditRef.current || !docId) return;
    const key = nowIso();
    updateDoc(docId, (d, id, key, learned) => {
      d.cookLog[key] = id;
      for (const t of learned) {
        if (!d.inventory[t.norm]) d.inventory[t.norm] = { name: t.name, kind: 'technique', acquired: key };
      }
    }, id, key, learned);
  }, [docId]);

  const addShoppingItems = useCallback((items: Array<{ key: string; item: ShoppingItem }>) => {
    if (!canEditRef.current || !docId || items.length === 0) return;
    updateDoc(docId, (d, items) => {
      for (const { key, item } of items) {
        const existing = d.shopping[key];
        if (existing && !existing.bought) continue; // already pending
        d.shopping[key] = item; // fresh, or re-adding something bought before
      }
    }, items);
  }, [docId]);

  const removeShopping = useCallback((key: string) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, key) => { delete d.shopping[key]; }, key);
  }, [docId]);

  /** Tap on an ingredient line: checked == a pending shopping item exists. */
  const toggleLine = useCallback((id: string, entry: KitchenRecipe['recipeIngredient'][number]) => {
    const key = lineKey(entry);
    const existing = shoppingRef.current[key];
    if (existing && !existing.bought) removeShopping(key);
    else addShoppingItems([{ key, item: { name: formatIngredient(entry), added: nowIso(), recipe: id } }]);
  }, [addShoppingItems, removeShopping]);

  const shopRecipe = useCallback((id: string, recipe: KitchenRecipe) => {
    addShoppingItems(recipe.recipeIngredient.map(entry => ({
      key: lineKey(entry),
      item: { name: formatIngredient(entry), added: nowIso(), recipe: id },
    })));
  }, [addShoppingItems]);

  const toggleStaple = useCallback((req: Requirement, id?: string) => {
    const existing = shoppingRef.current[req.norm];
    if (existing && !existing.bought) removeShopping(req.norm);
    else addShoppingItems([{ key: req.norm, item: { name: req.name, added: nowIso(), staple: true, ...(id ? { recipe: id } : {}) } }]);
  }, [addShoppingItems, removeShopping]);

  /** Buying a staple is what acquires it; un-buying un-acquires the same way,
   * so a mistaken tap is symmetric. */
  const toggleBought = useCallback((key: string) => {
    if (!canEditRef.current || !docId) return;
    const item = shoppingRef.current[key];
    if (!item) return;
    if (item.bought) {
      updateDoc(docId, (d, key) => {
        const it = d.shopping[key];
        if (!it) return;
        delete it.bought;
        if (it.staple) delete d.inventory[key];
      }, key);
    } else {
      updateDoc(docId, (d, key, ts) => {
        const it = d.shopping[key];
        if (!it) return;
        it.bought = ts;
        if (it.staple && !d.inventory[key]) d.inventory[key] = { name: it.name, kind: 'supply', acquired: ts };
      }, key, nowIso());
    }
  }, [docId]);

  const clearBought = useCallback(() => {
    if (!canEditRef.current || !docId) return;
    const keys = Object.entries(shoppingRef.current).filter(([, it]) => it.bought).map(([k]) => k);
    if (keys.length === 0) return;
    updateDoc(docId, (d, keys) => { for (const k of keys) delete d.shopping[k]; }, keys);
  }, [docId]);

  /** One atomic change: the recipe, its cook-log entries, and its shopping
   * provenance — checkDeps forbids dangling recipe ids at any commit boundary. */
  const deleteRecipe = useCallback((id: string) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, id) => {
      delete d.recipes[id];
      for (const ts of Object.keys(d.cookLog)) if (d.cookLog[ts] === id) delete d.cookLog[ts];
      for (const k of Object.keys(d.shopping)) if (d.shopping[k].recipe === id) delete d.shopping[k].recipe;
    }, id);
    setEditor(null);
    if (recipeId === id) window.location.hash = docUrl(docId);
  }, [docId, recipeId]);

  const saveRecipe = useCallback((id: string, recipe: KitchenRecipe) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, (d, id, recipe) => {
      const existing = d.recipes[id];
      if (!existing) { d.recipes[id] = recipe; return; }
      // Wholesale per-field assignment: array fields replace rather than
      // element-merge, and an absent optional field deletes.
      for (const k of Object.keys(recipe)) existing[k] = recipe[k];
      for (const k of Object.keys(existing)) if (!(k in recipe)) delete existing[k];
    }, id, recipe);
  }, [docId]);

  /** Create = mint a title-derived id (no uuids) and write the complete,
   * fully-filled recipe in one change. */
  const createRecipe = useCallback((recipe: KitchenRecipe) => {
    if (!canEditRef.current || !docId) return;
    const base = slugifyRecipeId(recipe.name);
    let id = base;
    for (let n = 2; id in recipes; n++) id = `${base}-${n}`;
    saveRecipe(id, recipe);
    setEditor(null);
    window.location.hash = docUrl(docId, `recipe/${encodeURIComponent(id)}`);
  }, [docId, recipes, saveRecipe]);

  // ------------------------------------------------------------------
  // Presence: what is being viewed/edited, and which editor fields peers hold.
  // ------------------------------------------------------------------

  const [focusedPath, setFocusedPath] = useState<(string | number)[] | null>(null);
  const focusPath: (string | number)[] | undefined =
    focusedPath ??
    (editor?.id ? ['recipes', editor.id] : recipeId ? ['recipes', recipeId] : undefined);
  useEffect(() => { if (!editor) setFocusedPath(null); }, [editor]);
  useFocusPathSync(focusPath, broadcast);

  const peerFocusedFields = useMemo(() => {
    const result: Record<string, PeerFieldInfo> = {};
    if (!editor?.id) return result;
    for (const peer of Object.values(peers)) {
      const pf = peer.value?.focusedField;
      if (!pf || pf.length < 3 || pf[0] !== 'recipes' || pf[1] !== editor.id) continue;
      const inputIds = PATH_PROP_TO_FIELDS[pf[2] as string];
      if (!inputIds) continue;
      const userGroupId = peer.value?.userGroupId;
      const info = { color: peerColor(peer.peerId, userGroupId), peerId: peer.peerId, userGroupId };
      for (const fieldId of inputIds) result[fieldId] = info;
    }
    return result;
  }, [peers, editor]);

  // ------------------------------------------------------------------
  // Derived view state
  // ------------------------------------------------------------------

  const entries: RecipeEntry[] = useMemo(
    () => Object.entries(recipes).map(([id, recipe]) => ({ id, recipe, state: recipeState(recipe, inventory) })),
    [recipes, inventory],
  );
  const locked = useMemo(() => sortLocked(entries.filter(e => e.state.status === 'locked')), [entries]);
  const ready = useMemo(() => sortReady(entries.filter(e => e.state.status !== 'locked'), cookLog), [entries, cookLog]);
  const counts = useMemo(() => cookCounts(cookLog), [cookLog]);
  const last = useMemo(() => lastCookedByRecipe(cookLog), [cookLog]);
  const purchase = useMemo(() => bestPurchase(recipes, inventory), [recipes, inventory]);

  const pendingCount = Object.values(shopping).filter(it => !it.bought).length;
  const hasShopping = Object.keys(shopping).length > 0;
  const tabs: PillTab[] = [
    ...(hasShopping ? [{ id: 'shopping', label: 'To buy', count: pendingCount }] : []),
    { id: 'locked', label: 'Locked', count: locked.length },
    { id: 'ready', label: 'Ready', count: ready.length },
    { id: 'inventory', label: 'Inventory' },
  ];
  // Pending purchases make Shopping the main page (Phil's rule); otherwise
  // Locked — the "what could I unlock next" view — is the default.
  const activeTab =
    userTab && tabs.some(t => t.id === userTab) ? userTab : pendingCount > 0 ? 'shopping' : 'locked';

  const detail = recipeId !== undefined ? entries.find(e => e.id === recipeId) : undefined;

  const rename = (value: string) => {
    if (!docId || !canEdit) return;
    const newName = value.trim() || 'Kitchen';
    setName(newName);
    updateDoc(docId, (d, name) => { d.name = name; }, newName);
    document.title = newName + ' - Kitchen';
  };

  return (
    <DocLoader docId={docId}>
      <>
        <DocumentTitleBar
          icon="skillet"
          title={name}
          titleEditable={canEdit}
          onRename={rename}
          docId={docId}
          peers={peerList}
          peerTitle={peer => `${peerDisplayName(peer.peerId, peer.value?.userGroupId)}${peer.value?.focusedField ? ' (editing)' : ''}`}
          onToggleHistory={history.toggleHistory}
          historyActive={history.active}
          onUndo={canEdit ? undo : undefined}
          onRedo={canEdit ? redo : undefined}
          canUndo={canUndo}
          canRedo={canRedo}
          hasValidationErrors={validationErrors.length > 0}
          sourcePath={focusPath}
        />
        <HistorySlider history={history} />
        <div
          className="max-w-screen-md mx-auto w-full px-2 sm:px-4 pb-28"
          style={noAccess ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
        >
          {detail ? (
            <RecipeDetail
              docId={docId!}
              recipe={detail.recipe}
              state={detail.state}
              shopping={shopping}
              cookCount={counts[detail.id] ?? 0}
              lastCooked={last[detail.id]}
              canEdit={canEdit}
              onCook={() => recordCook(detail.id, detail.state.missingTechniques.map(({ norm, name }) => ({ norm, name })))}
              onToggleLine={entry => toggleLine(detail.id, entry)}
              onShopAll={() => shopRecipe(detail.id, detail.recipe)}
              onToggleStaple={req => toggleStaple(req, detail.id)}
              onOwnTool={req => toggleOwned(req.norm, req.name, 'tool')}
              onEdit={() => setEditor({ id: detail.id, recipe: detail.recipe })}
            />
          ) : recipeId !== undefined && docLoaded ? (
            <div className="py-8 text-center text-sm text-muted-foreground" data-testid="recipe-missing">
              <p>This recipe doesn’t exist anymore.</p>
              <a href={docUrl(docId!)} className="text-primary underline">Back to the kitchen</a>
            </div>
          ) : recipeId !== undefined ? null : (
            <>
              <PillTabs tabs={tabs} active={activeTab} onSelect={setUserTab} />
              {activeTab === 'shopping' && (
                <ShoppingList
                  shopping={shopping}
                  recipes={recipes}
                  canEdit={canEdit}
                  onToggleBought={toggleBought}
                  onRemove={removeShopping}
                  onClearBought={clearBought}
                />
              )}
              {activeTab === 'locked' && (
                <>
                  {purchase && canEdit && (
                    <div className="rounded-2xl border p-4 mb-2 flex items-center gap-3" data-testid="best-purchase">
                      <span className="material-symbols-outlined text-primary" aria-hidden="true">
                        {purchase.kind === 'supply' ? 'add_shopping_cart' : 'handyman'}
                      </span>
                      <div className="text-sm flex-1">
                        Get <strong>{purchase.name}</strong> to unlock {purchase.unlocks} recipe{purchase.unlocks === 1 ? '' : 's'}.
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => purchase.kind === 'supply'
                          ? toggleStaple({ name: purchase.name, norm: purchase.norm, kind: 'supply' })
                          : toggleOwned(purchase.norm, purchase.name, 'tool')}
                      >
                        {purchase.kind === 'supply' ? 'Add to list' : 'I have one'}
                      </Button>
                    </div>
                  )}
                  <RecipeList
                    docId={docId!}
                    entries={locked}
                    cookCounts={counts}
                    lastCooked={last}
                    emptyText={entries.length === 0 ? 'No recipes yet — add one with the + button.' : 'Nothing is locked — your kitchen can cook it all.'}
                  />
                </>
              )}
              {activeTab === 'ready' && (
                <RecipeList
                  docId={docId!}
                  entries={ready}
                  cookCounts={counts}
                  lastCooked={last}
                  emptyText="Nothing is cookable yet — check the Locked tab for the cheapest unlock."
                />
              )}
              {activeTab === 'inventory' && (
                <InventoryTab
                  recipes={recipes}
                  inventory={inventory}
                  canEdit={canEdit}
                  onToggle={toggleOwned}
                />
              )}
            </>
          )}
        </div>

        {canEdit && !detail && recipeId === undefined && (
          <Fab icon="add" aria-label="New recipe" onClick={() => setEditor({ id: null, recipe: null })} />
        )}

        <RecipeEditor
          opened={!!editor}
          id={editor?.id ?? null}
          recipe={editor?.recipe ?? null}
          onCreate={createRecipe}
          onSave={saveRecipe}
          onDelete={deleteRecipe}
          onClose={() => setEditor(null)}
          onFieldFocus={setFocusedPath}
          editingPathBase={editor?.id ? ['recipes', editor.id] : null}
          peerFocusedFields={peerFocusedFields}
        />
      </>
    </DocLoader>
  );
}
