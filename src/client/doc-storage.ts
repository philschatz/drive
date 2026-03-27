type DocType = 'Calendar' | 'TaskList' | 'DataGrid' | 'unknown';

interface DocEntry {
  id: string;
  type?: DocType;
  name?: string;
  /** If true, document content is encrypted via keyhive. */
  encrypted?: boolean;
  /** Keyhive sharing group ID (base64-encoded). Needed to restore after reload. */
  sharingGroupId?: string;
}

const DOC_STORAGE_KEY = 'automerge-doc-ids';

// --- Dispatch hook (injected from automerge.ts to avoid circular imports) ---

type DocListDispatch = (type: 'add-doc-to-list' | 'remove-doc-from-list', docId: string, metadata?: Partial<DocEntry>) => void;
let dispatch: DocListDispatch | null = null;

export function setDocListDispatch(fn: DocListDispatch): void {
  dispatch = fn;
}

// --- Pending-add tracking ---
// Docs added locally but not yet confirmed by the worker's IDB list.
// Protects against stale doc-list-updated messages overwriting recent adds.
const pendingAdds = new Map<string, DocEntry>();

// --- Listener mechanism ---

type DocListListener = (list: DocEntry[]) => void;
const listeners = new Set<DocListListener>();

export function onDocListUpdated(fn: DocListListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Called by worker-api.ts when the worker pushes a new doc list. */
export function applyDocListFromWorker(list: DocEntry[]): void {
  const workerIds = new Set(list.map(e => e.id));

  // Clear confirmed entries from pending
  for (const id of pendingAdds.keys()) {
    if (workerIds.has(id)) pendingAdds.delete(id);
  }

  // Merge still-pending entries the worker's stale list may have omitted
  const merged = [...list];
  for (const [id, entry] of pendingAdds) {
    if (!workerIds.has(id)) merged.unshift(entry);
  }

  saveDocList(merged);
  for (const fn of listeners) fn(merged);
}

// --- Core storage (reads/writes localStorage as sync cache) ---

export function getDocList(): DocEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DOC_STORAGE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw;
  } catch { return []; }
}

function saveDocList(list: DocEntry[]) {
  localStorage.setItem(DOC_STORAGE_KEY, JSON.stringify(list));
}

export function addDocId(id: string, cache?: Omit<DocEntry, 'id'>) {
  const list = getDocList();
  const idx = list.findIndex(e => e.id === id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...cache, id };
    // Move to front (most recent)
    list.unshift(list.splice(idx, 1)[0]);
  } else {
    list.unshift({ id, ...cache });
  }
  saveDocList(list);
  pendingAdds.set(id, list[0]);
  dispatch?.('add-doc-to-list', id, cache);
}

export function removeDocId(id: string) {
  pendingAdds.delete(id);
  const list = getDocList().filter(e => e.id !== id);
  saveDocList(list);
  dispatch?.('remove-doc-from-list', id);
}

export function getDocEntry(id: string): DocEntry | undefined {
  return getDocList().find(e => e.id === id);
}


/** @internal Clear pending-add state (for tests only). */
export function _resetPendingForTesting() { pendingAdds.clear(); }

export function updateDocCache(id: string, cache: Omit<DocEntry, 'id'>) {
  const list = getDocList();
  const entry = list.find(e => e.id === id);
  if (!entry) return;
  Object.assign(entry, cache);
  saveDocList(list);
  dispatch?.('add-doc-to-list', id, cache);
}
