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

import { getDocList, addDocId, removeDocId, updateDocCache, applyDocListFromWorker, onDocListUpdated } from './doc-storage';

beforeEach(() => {
  store = {};
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

  it('stores type, encrypted, and khDocId from invite claim', () => {
    addDocId('inv-1', { encrypted: true, khDocId: 'kh-1', type: 'Calendar' as any });
    const entry = getDocList().find(e => e.id === 'inv-1');
    expect(entry?.type).toBe('Calendar');
    expect(entry?.encrypted).toBe(true);
    expect(entry?.khDocId).toBe('kh-1');
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
