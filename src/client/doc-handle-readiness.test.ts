/**
 * Tests that DocHandle.doc() throws when not ready, proving that using it
 * as a truthiness check (if (handle.doc())) silently breaks subscriptions.
 *
 * The automerge-worker subscribe-query handler must use handle.isReady()
 * instead of handle.doc() to check readiness.
 */

// Mock handle matching real DocHandle behavior: doc() throws when not ready
function mockHandle(ready: boolean, doc: any = null) {
  const listeners: Record<string, Function[]> = {};
  let _ready = ready;
  let _doc = doc;
  let _resolve: (() => void) | null = null;

  return {
    isReady() { return _ready; },
    doc() {
      if (!_ready) throw new Error('DocHandle is not ready');
      return _doc;
    },
    whenReady() {
      if (_ready) return Promise.resolve();
      return new Promise<void>(resolve => { _resolve = resolve; });
    },
    on(event: string, fn: Function) { (listeners[event] ??= []).push(fn); },
    heads() { return []; },
    // Simulate becoming ready (e.g. after network sync or decryption)
    makeReady(newDoc: any) {
      _ready = true;
      _doc = newDoc;
      if (_resolve) _resolve();
      (listeners['change'] ?? []).forEach(fn => fn());
    },
  };
}

describe('DocHandle.doc() throws when not ready', () => {
  it('doc() throws instead of returning null for a not-ready handle', () => {
    const handle = mockHandle(false);

    // The old code did: if (handle.doc()) { pushToSubscriptions(); }
    // This throws instead of returning falsy, so the catch handler sends
    // an error query-result. The Home page callback ignores errors, so
    // loading stays true forever.
    expect(() => handle.doc()).toThrow('DocHandle is not ready');
  });

  it('isReady() safely returns false without throwing', () => {
    const handle = mockHandle(false);
    expect(handle.isReady()).toBe(false);
  });

  it('doc() works on a ready handle', () => {
    const doc = { '@type': 'Calendar', name: 'Test', events: {} };
    const handle = mockHandle(true, doc);
    expect(handle.isReady()).toBe(true);
    expect(handle.doc()).toEqual(doc);
  });
});

describe('subscribe-query readiness pattern', () => {
  // Simulates the subscribe-query + pushToSubscriptions logic

  it('BUG: old pattern (handle.doc() as truthiness check) throws for not-ready handle', () => {
    const handle = mockHandle(false);
    const messages: any[] = [];

    // Simulate the old subscribe-query handler with try/catch
    try {
      // Old code: if (handle.doc()) { push immediately }
      if (handle.doc()) {
        messages.push({ type: 'query-result', result: 'data' });
      }
    } catch (err: any) {
      // Error caught — sends error result, callback ignores it
      messages.push({ type: 'query-result', error: err.message });
    }

    // The error result means the callback never fires, loading stays true
    expect(messages).toEqual([{ type: 'query-result', error: 'DocHandle is not ready' }]);
  });

  it('FIX: new pattern (isReady check) does not throw, waits for whenReady', async () => {
    const handle = mockHandle(false);
    const messages: any[] = [];
    const doc = { '@type': 'Calendar', name: 'Test' };

    // Fixed subscribe-query handler pattern
    const isReady = handle.isReady();
    if (isReady) {
      messages.push({ type: 'query-result', result: handle.doc() });
    } else {
      handle.whenReady().then(() => {
        messages.push({ type: 'query-result', result: handle.doc() });
      });
    }

    // Not ready yet — no messages
    expect(messages).toEqual([]);

    // Simulate doc becoming ready (network sync / keyhive decryption)
    handle.makeReady(doc);
    await new Promise(r => setTimeout(r, 0));

    // Now the whenReady callback fired and pushed the result
    expect(messages).toEqual([{ type: 'query-result', result: doc }]);
  });

  it('FIX: ready handle pushes immediately without whenReady', () => {
    const doc = { '@type': 'Calendar', name: 'Test' };
    const handle = mockHandle(true, doc);
    const messages: any[] = [];

    if (handle.isReady()) {
      messages.push({ type: 'query-result', result: handle.doc() });
    }

    expect(messages).toEqual([{ type: 'query-result', result: doc }]);
  });

  it('BUG: old pushToSubscriptions pattern throws on not-ready handle', () => {
    const handle = mockHandle(false);

    // Old pushToSubscriptions code:
    //   const rawDoc = handle.doc();
    //   if (!rawDoc) return;
    // This throws instead of returning — unhandled in the change listener
    expect(() => {
      const rawDoc = handle.doc();
      if (!rawDoc) return 'skipped';
      return 'pushed';
    }).toThrow('DocHandle is not ready');
  });

  it('FIX: new pushToSubscriptions guards with isReady before doc()', () => {
    const handle = mockHandle(false);

    // Fixed code:
    //   if (handle.isReady && !handle.isReady()) return;
    //   const rawDoc = handle.doc();
    const result = (() => {
      if (handle.isReady && !handle.isReady()) return 'skipped';
      const rawDoc = handle.doc();
      if (!rawDoc) return 'no-doc';
      return 'pushed';
    })();

    expect(result).toBe('skipped');
  });
});
