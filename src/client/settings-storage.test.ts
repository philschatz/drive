/**
 * Tests for the typed settings registry in idb-storage.ts:
 *   - settingGet/settingSet: IndexedDB-backed source of truth, with defaults.
 *   - settingGetSync/settingSetSync/isCacheDisabled: synchronous localStorage mirror.
 */

import 'fake-indexeddb/auto';

// Mock localStorage (node test env has none).
let store: Record<string, string> = {};
Object.defineProperty(global, 'localStorage', {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
  },
  configurable: true,
});

import {
  settingGet,
  settingSet,
  settingGetSync,
  settingSetSync,
  isCacheDisabled,
  _resetConnectionForTest,
} from './idb-storage';

beforeEach(() => {
  store = {};
  _resetConnectionForTest();
});

describe('settings — IndexedDB source of truth', () => {
  it('returns the default when unset', async () => {
    await expect(settingGet('cache-disabled')).resolves.toBe(false);
  });

  it('round-trips a value through IndexedDB', async () => {
    await settingSet('cache-disabled', true);
    await expect(settingGet('cache-disabled')).resolves.toBe(true);
    await settingSet('cache-disabled', false);
    await expect(settingGet('cache-disabled')).resolves.toBe(false);
  });

  it('keeps a stored `false` rather than falling back to the default', async () => {
    await settingSet('cache-disabled', false);
    // ?? must not treat the stored `false` as missing.
    await expect(settingGet('cache-disabled')).resolves.toBe(false);
  });
});

describe('settings — synchronous localStorage mirror', () => {
  it('defaults to false / cache enabled when unset', () => {
    expect(settingGetSync('cache-disabled')).toBe(false);
    expect(isCacheDisabled()).toBe(false);
  });

  it('round-trips through the mirror and reflects in isCacheDisabled', () => {
    settingSetSync('cache-disabled', true);
    expect(settingGetSync('cache-disabled')).toBe(true);
    expect(isCacheDisabled()).toBe(true);
    expect(store['settings:cache-disabled']).toBe('true');

    settingSetSync('cache-disabled', false);
    expect(isCacheDisabled()).toBe(false);
  });

  it('falls back to the default on a corrupt mirror value', () => {
    store['settings:cache-disabled'] = 'not-json';
    expect(settingGetSync('cache-disabled')).toBe(false);
  });
});
