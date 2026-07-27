/**
 * Tests for idb-storage.ts error handling.
 *
 * Regression: idbGet/idbSet swallowed a failure to open the database, turning it
 * into a silent `null`/no-op. That silently dropped writes (e.g. a saved contact
 * name never persisting) and produced empty reads with no error to surface — the
 * Share & Permissions panel then showed "You have no contacts yet" for a contact
 * that had actually been added. IndexedDB errors must propagate; only a genuinely
 * absent `indexedDB` is an intentional no-op.
 */

import { idbGet, idbSet, _resetConnectionForTest } from './idb-storage';

const realIndexedDB = (global as any).indexedDB;

function setIndexedDB(value: unknown): void {
  Object.defineProperty(global, 'indexedDB', { value, configurable: true, writable: true });
}

afterEach(() => {
  setIndexedDB(realIndexedDB);
  _resetConnectionForTest();
});

describe('idb-storage error handling', () => {
  it('no-ops when indexedDB is genuinely unavailable', async () => {
    setIndexedDB(undefined);
    _resetConnectionForTest();
    await expect(idbGet('k')).resolves.toBeNull();
    await expect(idbSet('k', 'v')).resolves.toBeUndefined();
  });

  it('propagates a failure to open the database instead of swallowing it', async () => {
    const openError = new Error('open blocked');
    setIndexedDB({
      open() {
        const req: any = {};
        // Fire asynchronously like the real IndexedDB API.
        Promise.resolve().then(() => { req.error = openError; req.onerror?.(); });
        return req;
      },
    });

    _resetConnectionForTest();
    await expect(idbGet('k')).rejects.toThrow('open blocked');

    _resetConnectionForTest();
    await expect(idbSet('k', 'v')).rejects.toThrow('open blocked');
  });
});
