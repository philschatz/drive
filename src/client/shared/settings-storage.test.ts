/**
 * Tests for the typed settings registry in idb-storage.ts:
 *   - settingGet/settingSet: IndexedDB-backed source of truth, with defaults.
 *   - settingGetSync/settingSetSync/isDebugEnabled: synchronous localStorage mirror.
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
  isDebugEnabled,
  _resetConnectionForTest,
} from './idb-storage';

beforeEach(() => {
  store = {};
  _resetConnectionForTest();
});

describe('settings — IndexedDB source of truth', () => {
  it('returns the default when unset', async () => {
    await expect(settingGet('debug-enable')).resolves.toBe(false);
  });

  it('round-trips a value through IndexedDB', async () => {
    await settingSet('debug-enable', true);
    await expect(settingGet('debug-enable')).resolves.toBe(true);
    await settingSet('debug-enable', false);
    await expect(settingGet('debug-enable')).resolves.toBe(false);
  });

  it('keeps a stored `false` rather than falling back to the default', async () => {
    await settingSet('debug-enable', false);
    // ?? must not treat the stored `false` as missing.
    await expect(settingGet('debug-enable')).resolves.toBe(false);
  });
});

describe('settings — synchronous localStorage mirror', () => {
  it('defaults to false / cache enabled when unset', () => {
    expect(settingGetSync('debug-enable')).toBe(false);
    expect(isDebugEnabled()).toBe(false);
  });

  it('round-trips through the mirror and reflects in isDebugEnabled', () => {
    settingSetSync('debug-enable', true);
    expect(settingGetSync('debug-enable')).toBe(true);
    expect(isDebugEnabled()).toBe(true);
    expect(store['settings:debug-enable']).toBe('true');

    settingSetSync('debug-enable', false);
    expect(isDebugEnabled()).toBe(false);
  });

  it('falls back to the default on a corrupt mirror value', () => {
    store['settings:debug-enable'] = 'not-json';
    expect(settingGetSync('debug-enable')).toBe(false);
  });
});
