type DocType = 'Calendar' | 'TaskList' | 'DataGrid' | 'unknown';

interface DocEntry {
  id: string;
  type?: DocType;
  name?: string;
  /** If true, document content is encrypted via keyhive. */
  encrypted?: boolean;
  /** Keyhive document ID (base64-encoded bytes) for encryption/decryption. */
  khDocId?: string;
  /** Keyhive sharing group ID (base64-encoded). Needed to restore after reload. */
  sharingGroupId?: string;
}

const DOC_STORAGE_KEY = 'automerge-doc-ids';

export function getDocList(): DocEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DOC_STORAGE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    // Handle legacy string[] format
    if (raw.length > 0 && typeof raw[0] === 'string') {
      const entries: DocEntry[] = raw.map((id: string) => ({ id }));
      saveDocList(entries);
      return entries;
    }
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
}

export function removeDocId(id: string) {
  const list = getDocList().filter(e => e.id !== id);
  saveDocList(list);
}

export function touchDoc(id: string) {
  const list = getDocList();
  const idx = list.findIndex(e => e.id === id);
  if (idx <= 0) return; // not found or already first
  list.unshift(list.splice(idx, 1)[0]);
  saveDocList(list);
}

export function getDocEntry(id: string): DocEntry | undefined {
  return getDocList().find(e => e.id === id);
}


export function updateDocCache(id: string, cache: Omit<DocEntry, 'id'>) {
  const list = getDocList();
  const entry = list.find(e => e.id === id);
  if (!entry) return;
  Object.assign(entry, cache);
  saveDocList(list);
}
