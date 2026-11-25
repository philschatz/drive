/**
 * The engine's side of discovery (src/shared/engine-rendezvous.ts): what it
 * declares to the relay — tokens for the devices it is related to, and for the
 * other device of a link until keyhive lists it.
 */
import { DriveEngine } from '../src/shared/drive-engine';
import { KEYS } from '../src/shared/storage-keys';
import { LINKED_DEVICE_TTL_MS } from '../src/shared/discovery-tokens';

const key = (n: number) => Buffer.from(new Uint8Array(32).fill(n)).toString('base64');
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

function makeEngine() {
  const kv = new Map<string, any>();
  const sent: any[] = [];
  const engine: any = new DriveEngine({
    emit: () => {},
    network: { sendOverlayFrame: (frame: any) => sent.push(frame) },
    kv: {
      get: async (k: string) => kv.get(k) ?? null,
      set: async (k: string, v: any) => { kv.set(k, structuredClone(v)); },
      del: async (k: string) => { kv.delete(k); },
    },
  } as any);
  // The devices keyhive lists as related.
  const related = new Map<string, { own: boolean }>();
  engine.khOps = {};
  engine.khRepo = {
    relations: { get: async () => related, invalidate: () => {} },
    // Stands in for the real builder: one token per device.
    discoveryTokens: async (also: Iterable<string> = []) => [...new Set([...related.keys(), ...also])].map((d) => `pair:${d}`).sort(),
  };
  return { engine, kv, sent, related };
}

describe('the relay declaration', () => {
  it('is a list of tokens, one per related device', async () => {
    const { engine, sent, related } = makeEngine();
    related.set(key(1), { own: true });
    related.set(key(2), { own: false });
    await engine.refreshRelayWatch();
    expect(sent).toEqual([{ type: 'watch', v: 2, tokens: [`pair:${key(1)}`, `pair:${key(2)}`].sort() }]);
  });

  it('is not sent again while it would say the same, and is when it would not', async () => {
    const { engine, sent, related } = makeEngine();
    related.set(key(1), { own: true });
    await engine.refreshRelayWatch();
    await engine.refreshRelayWatch();
    expect(sent).toHaveLength(1);
    related.set(key(2), { own: false }); // a friend's new device became known
    await engine.refreshRelayWatch();
    expect(sent).toHaveLength(2);
    // A reopened socket has no declaration: the engine forgets what it sent.
    engine.lastRelayWatch = null;
    await engine.refreshRelayWatch();
    expect(sent).toHaveLength(3);
    // Related to nobody any more: that is declared too, once.
    related.clear();
    await engine.refreshRelayWatch();
    await engine.refreshRelayWatch();
    expect(sent.at(-1)).toEqual({ type: 'watch', v: 2, tokens: [] });
    expect(sent).toHaveLength(4);
  });

  it('is not made by a device related to nobody', async () => {
    const { engine, sent } = makeEngine();
    await engine.refreshRelayWatch();
    expect(sent).toEqual([]);
  });
});

describe('the other device of a link', () => {
  it('is declared at once, before keyhive lists it — that is how the two get introduced', async () => {
    const { engine, sent, kv } = makeEngine();
    await engine.rememberLinkedDevice(key(7));
    expect(Object.keys(kv.get(KEYS.linkedDevices))).toEqual([key(7)]);
    await tick(600); // the declaration is debounced
    expect(sent.at(-1)).toEqual({ type: 'watch', v: 2, tokens: [`pair:${key(7)}`] });
  });

  it('is forgotten once keyhive lists it: keyhive answers for it from then on', async () => {
    const { engine, sent, kv, related } = makeEngine();
    await engine.rememberLinkedDevice(key(7));
    await engine.refreshRelayWatch();
    related.set(key(7), { own: true }); // the group arrived
    await engine.refreshRelayWatch();
    expect(kv.get(KEYS.linkedDevices)).toEqual({});
    expect(sent.at(-1).tokens).toEqual([`pair:${key(7)}`]);
    // Removed from the group later: no longer listed, no longer remembered, no longer declared.
    related.delete(key(7));
    await engine.refreshRelayWatch();
    expect(sent.at(-1).tokens).toEqual([]);
  });

  it('is forgotten if the link never settled', async () => {
    const { engine, sent, kv } = makeEngine();
    kv.set(KEYS.linkedDevices, { [key(7)]: Date.now() - LINKED_DEVICE_TTL_MS - 1 });
    await engine.refreshRelayWatch();
    expect(sent).toEqual([]);
    expect(kv.get(KEYS.linkedDevices)).toEqual({});
  });
});
