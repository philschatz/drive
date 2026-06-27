/**
 * Tests for doc-storage.ts localStorage helpers.
 */

const STORAGE_KEY = 'automerge-doc-ids';

// Mock localStorage
let store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { store = {}; },
};
Object.defineProperty(global, 'localStorage', { value: localStorageMock });

import { getDocList, addDocId, removeDocId, updateDocCache, applyDocListFromWorker, onDocListUpdated, setDocListDispatch, _resetPendingForTesting } from './doc-storage';

beforeEach(() => {
  store = {};
  _resetPendingForTesting();
});

describe('getDocList', () => {
  it('returns empty array when nothing stored', () => {
    expect(getDocList()).toEqual([]);
  });

  it('returns entries when stored as array of objects', () => {
    store[STORAGE_KEY] = JSON.stringify([{ id: 'doc-1', type: 'Calendar', name: 'Work' }, { id: 'doc-2' }]);
    expect(getDocList()).toEqual([{ id: 'doc-1', type: 'Calendar', name: 'Work' }, { id: 'doc-2' }]);
  });

  it('returns empty array for invalid JSON', () => {
    store[STORAGE_KEY] = 'not-json!!!';
    expect(getDocList()).toEqual([]);
  });

  it('returns empty array for non-array value', () => {
    store[STORAGE_KEY] = JSON.stringify({ 'doc-1': {} });
    expect(getDocList()).toEqual([]);
  });
});

describe('addDocId', () => {
  it('adds a new doc at the front', () => {
    addDocId('doc-1', { type: 'Calendar', name: 'Work' });
    expect(getDocList()).toEqual([{ id: 'doc-1', type: 'Calendar', name: 'Work' }]);
  });

  it('adds new docs at the front', () => {
    addDocId('doc-1');
    addDocId('doc-2');
    expect(getDocList().map(e => e.id)).toEqual(['doc-2', 'doc-1']);
  });

  it('moves existing doc to front when re-added', () => {
    addDocId('doc-1');
    addDocId('doc-2');
    addDocId('doc-1', { type: 'Calendar' });
    expect(getDocList()).toEqual([{ id: 'doc-1', type: 'Calendar' }, { id: 'doc-2' }]);
  });

  it('preserves existing cache when adding without cache', () => {
    addDocId('doc-1', { type: 'Calendar', name: 'Work' });
    addDocId('doc-1');
    expect(getDocList()).toEqual([{ id: 'doc-1', type: 'Calendar', name: 'Work' }]);
  });

  it('stores type when adding with metadata', () => {
    addDocId('inv-1', { type: 'Calendar' as any });
    const entry = getDocList().find(e => e.id === 'inv-1');
    expect(entry?.type).toBe('Calendar');
  });
});

describe('removeDocId', () => {
  it('removes an existing doc', () => {
    addDocId('doc-1');
    addDocId('doc-2');
    removeDocId('doc-1');
    expect(getDocList()).toEqual([{ id: 'doc-2' }]);
  });

  it('does nothing when removing non-existent doc', () => {
    addDocId('doc-1');
    removeDocId('doc-999');
    expect(getDocList()).toEqual([{ id: 'doc-1' }]);
  });
});

describe('updateDocCache', () => {
  it('merges cache for existing doc', () => {
    addDocId('doc-1', { type: 'Calendar' });
    updateDocCache('doc-1', { name: 'Updated' });
    expect(getDocList()).toEqual([{ id: 'doc-1', type: 'Calendar', name: 'Updated' }]);
  });

  it('does nothing for non-existent doc', () => {
    addDocId('doc-1');
    updateDocCache('doc-999', { name: 'Ghost' });
    expect(getDocList()).toEqual([{ id: 'doc-1' }]);
  });

  it('dispatches to worker so IDB stays in sync', () => {
    const messages: Array<{ msgType: string; docId: string; metadata: any }> = [];
    setDocListDispatch((msgType, docId, metadata) => {
      messages.push({ msgType, docId, metadata });
    });

    addDocId('doc-1', { type: 'Calendar', name: 'Old' });
    messages.length = 0; // clear the addDocId dispatch

    updateDocCache('doc-1', { name: 'New Title' });

    expect(messages).toHaveLength(1);
    expect(messages[0].msgType).toBe('add-doc-to-list');
    expect(messages[0].docId).toBe('doc-1');
    expect(messages[0].metadata).toEqual({ name: 'New Title' });

    setDocListDispatch(null as any);
  });

  it('does not dispatch for non-existent doc', () => {
    const messages: any[] = [];
    setDocListDispatch((msgType, docId, metadata) => {
      messages.push({ msgType, docId, metadata });
    });

    updateDocCache('doc-999', { name: 'Ghost' });
    expect(messages).toHaveLength(0);

    setDocListDispatch(null as any);
  });
});

describe('applyDocListFromWorker', () => {
  it('writes list to localStorage and notifies listeners', () => {
    const listener = jest.fn();
    const unsub = onDocListUpdated(listener);
    const list = [{ id: 'doc-a', type: 'Calendar' as const, name: 'Work' }];
    applyDocListFromWorker(list);
    expect(getDocList()).toEqual(list);
    expect(listener).toHaveBeenCalledWith(list);
    unsub();
  });

  it('unsubscribe stops notifications', () => {
    const listener = jest.fn();
    const unsub = onDocListUpdated(listener);
    unsub();
    applyDocListFromWorker([{ id: 'doc-b' }]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('dispatch message shape', () => {
  afterEach(() => {
    setDocListDispatch(null as any);
  });

  it('addDocId dispatches message type and metadata separately', () => {
    const messages: Array<{ msgType: string; docId: string; metadata: any }> = [];
    setDocListDispatch((msgType, docId, metadata) => {
      messages.push({ msgType, docId, metadata });
    });

    addDocId('doc-1', { type: 'Calendar', name: 'Work' });

    expect(messages).toHaveLength(1);
    expect(messages[0].msgType).toBe('add-doc-to-list');
    expect(messages[0].docId).toBe('doc-1');
    expect(messages[0].metadata).toEqual({ type: 'Calendar', name: 'Work' });
  });

  it('metadata.type does not collide with message type when building worker message', () => {
    // Simulates what automerge.ts does: builds a postMessage payload from dispatch args.
    // The old bug: { type: msgType, docId, ...metadata } would let metadata.type overwrite msgType.
    const posted: any[] = [];
    setDocListDispatch((msgType, docId, metadata) => {
      // Current (fixed) pattern: metadata is nested
      posted.push({ type: msgType, docId, metadata });
    });

    addDocId('doc-1', { type: 'Calendar', name: 'Test' });

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('add-doc-to-list');
    expect(posted[0].metadata?.type).toBe('Calendar');
  });

  it('removeDocId dispatches without metadata', () => {
    const messages: Array<{ msgType: string; docId: string; metadata: any }> = [];
    setDocListDispatch((msgType, docId, metadata) => {
      messages.push({ msgType, docId, metadata });
    });

    addDocId('doc-1');
    removeDocId('doc-1');

    expect(messages).toHaveLength(2);
    expect(messages[1].msgType).toBe('remove-me-from-doc');
    expect(messages[1].docId).toBe('doc-1');
  });

  it('simulated IDB round-trip preserves all metadata needed for reload', () => {
    // When the worker stores metadata to IDB and reloads on refresh, all fields
    // (type/name, shown on homepage before doc subscription resolves) must survive.
    const posted: any[] = [];
    setDocListDispatch((msgType, docId, metadata) => {
      posted.push({ type: msgType, docId, metadata });
    });

    addDocId('doc-1', { type: 'TaskList', name: 'Tasks' });
    addDocId('doc-2', { type: 'Calendar', name: 'Work' });

    // Simulate what the worker does: store to IDB, then reload on refresh
    const idbList = posted.map(msg => ({ id: msg.docId, ...msg.metadata }));

    // Simulate refresh: worker sends IDB list back, client applies it
    applyDocListFromWorker(idbList);
    const reloaded = getDocList();

    expect(reloaded).toHaveLength(2);
    expect(reloaded[0]).toEqual({ id: 'doc-1', type: 'TaskList', name: 'Tasks' });
    expect(reloaded[1]).toEqual({ id: 'doc-2', type: 'Calendar', name: 'Work' });
  });
});
