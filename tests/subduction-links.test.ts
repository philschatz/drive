/**
 * The subduction links in isolation: who opens a link, when it counts as up,
 * and what happens to it when a peer leaves, comes back, or is not wanted.
 *
 * The secure channel below is a stand-in that delivers in order (which is what
 * the real one guarantees), and subduction above is a stand-in whose handshake
 * is each side telling the other its key — enough to exercise everything the
 * links decide. Real subduction over real links is tests/e2ee-*.test.ts.
 */
import { EventEmitter } from 'events';
import { startSubductionLinks, decodeLinkFrame, type SubductionLinks, type LinkedPeer } from '../src/shared/subduction-links';
import { RELAY_PEER_ID } from '../src/shared/relay-identity';

jest.setTimeout(20_000);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** The channel between devices: ordered delivery, and a record of what was sent. */
class Hub {
  sent: any[] = [];
  private ends = new Map<string, EventEmitter>();
  attach(peerId: string): any {
    const end = new EventEmitter() as any;
    end.send = (message: any) => {
      this.sent.push(message);
      setImmediate(() => this.ends.get(message.targetId)?.emit('message', message));
    };
    this.ends.set(peerId, end);
    return end;
  }
  announce(a: string, b: string): void {
    this.ends.get(a)?.emit('peer-candidate', { peerId: b });
    this.ends.get(b)?.emit('peer-candidate', { peerId: a });
  }
  gone(peerId: string, seenBy: string): void { this.ends.get(seenBy)?.emit('peer-disconnected', { peerId }); }
  inject(message: any): void { this.ends.get(message.targetId)?.emit('message', message); }
}

/** A stand-in for the Repo's subduction: the handshake is "here is my key". */
function fakeSubduction(myKey: Uint8Array, opts: { claimKey?: Uint8Array; failFirstConnect?: boolean } = {}) {
  const state = { connects: 0, accepts: 0, disconnectCallbacks: 0, failNext: !!opts.failFirstConnect };
  const sub = {
    state,
    transports: [] as any[],
    async connectTransport(t: any) {
      state.connects++;
      if (state.failNext) { state.failNext = false; throw new Error('handshake refused'); }
      sub.transports.push(t);
      t.onDisconnect(() => { state.disconnectCallbacks++; });
      await t.sendBytes(opts.claimKey ?? myKey);
      const theirs = await t.recvBytes();
      return { toBytes: () => new Uint8Array(theirs) };
    },
    async acceptTransport(t: any) {
      state.accepts++;
      sub.transports.push(t);
      t.onDisconnect(() => { state.disconnectCallbacks++; });
      const theirs = await t.recvBytes();
      await t.sendBytes(opts.claimKey ?? myKey);
      return { toBytes: () => new Uint8Array(theirs) };
    },
    disconnectFromPeer: jest.fn(async () => true),
  };
  return sub;
}

interface Device {
  peerId: string;
  key: Uint8Array;
  links: SubductionLinks;
  sub: ReturnType<typeof fakeSubduction>;
  up: LinkedPeer[];
  down: LinkedPeer[];
  datagrams: string[];
  wanted: { value: boolean };
}

const devices: Device[] = [];
function device(hub: Hub, opts: { key?: Uint8Array; sub?: Parameters<typeof fakeSubduction>[1]; wanted?: boolean } = {}): Device {
  const key = opts.key ?? crypto.getRandomValues(new Uint8Array(32));
  const peerId = `${Buffer.from(key).toString('base64')}-drive-${Math.random().toString(36).slice(2, 10)}`;
  const sub = fakeSubduction(key, opts.sub);
  const up: LinkedPeer[] = [];
  const down: LinkedPeer[] = [];
  const datagrams: string[] = [];
  const wanted = { value: opts.wanted ?? true };
  const links = startSubductionLinks({
    channel: hub.attach(peerId),
    relayPeerId: RELAY_PEER_ID,
    ready: Promise.resolve({ localPeerId: peerId, subduction: sub }),
    mayLink: async () => wanted.value,
    onLinkUp: (p) => up.push(p),
    onLinkDown: (p) => down.push(p),
    onDatagram: (p, payload) => datagrams.push(`${p.peerId === peerId ? 'self' : 'peer'}:${Buffer.from(payload).toString()}`),
    timings: { handshakeMs: 300, retryBaseMs: 20, retryMaxMs: 60 },
  });
  const d = { peerId, key, links, sub, up, down, datagrams, wanted };
  devices.push(d);
  return d;
}
afterEach(async () => { for (const d of devices.splice(0)) await d.links.stop(); });

/** Two devices in peerId order, so the first is the one that initiates. */
function pair(hub: Hub, opts: { low?: Parameters<typeof device>[1]; high?: Parameters<typeof device>[1] } = {}): [Device, Device] {
  for (;;) {
    const a = device(hub, opts.low);
    const b = device(hub, opts.high);
    if (a.peerId < b.peerId) return [a, b];
    // Wrong order for the options given: discard and draw again.
    devices.splice(devices.indexOf(a), 1); devices.splice(devices.indexOf(b), 1);
    void a.links.stop(); void b.links.stop();
  }
}

describe('opening a link', () => {
  it('has the lower peerId connect and the other accept, and reports the link up on both', async () => {
    const hub = new Hub();
    const [low, high] = pair(hub);
    hub.announce(low.peerId, high.peerId);
    await until(() => low.up.length === 1 && high.up.length === 1, 'both ends up');

    expect([low.sub.state.connects, low.sub.state.accepts]).toEqual([1, 0]);
    expect([high.sub.state.connects, high.sub.state.accepts]).toEqual([0, 1]);
    expect(low.links.linked().map((p) => p.peerId)).toEqual([high.peerId]);
    expect(Buffer.from(low.up[0].deviceKey).equals(Buffer.from(high.key))).toBe(true);
    expect(low.links.describe()).toEqual([{ peerId: high.peerId, state: 'up', framesOut: 1 }]);
    // Only the first frame of a link carries the open flag.
    const fromLow = hub.sent.filter((m) => m.senderId === low.peerId).map((m) => decodeLinkFrame(m.data)!.flags & 1);
    expect(fromLow[0]).toBe(1);
    expect(fromLow.slice(1).every((f) => f === 0)).toBe(true);
  });

  it('never links with the relay', async () => {
    const hub = new Hub();
    const a = device(hub);
    hub.attach(RELAY_PEER_ID);
    hub.announce(a.peerId, RELAY_PEER_ID);
    await sleep(50);
    expect(hub.sent).toEqual([]);
    expect(a.links.describe()).toEqual([]);
  });

  it('ignores frames from a peer the channel never announced', async () => {
    const hub = new Hub();
    const [low, high] = pair(hub);
    hub.inject({ type: 'subduction-connection', senderId: low.peerId, targetId: high.peerId, data: Uint8Array.from([1, 1, ...new Array(8).fill(9), 42]) });
    await sleep(50);
    expect(high.sub.state.accepts).toBe(0);
  });

  it('drops a link whose handshake reports a different key than the peerId\'s', async () => {
    const hub = new Hub();
    const [low, high] = pair(hub, { high: { sub: { claimKey: crypto.getRandomValues(new Uint8Array(32)) } } });
    hub.announce(low.peerId, high.peerId);
    await until(() => low.sub.state.connects >= 2, 'the initiator to have tried again');
    expect(low.up).toEqual([]);
    expect(low.links.linked()).toEqual([]);
    expect(low.sub.disconnectFromPeer).toHaveBeenCalled();
  });

  it('tries again when a handshake fails', async () => {
    const hub = new Hub();
    const [low, high] = pair(hub, { low: { sub: { failFirstConnect: true } } });
    hub.announce(low.peerId, high.peerId);
    await until(() => low.up.length === 1 && high.up.length === 1, 'the retry to succeed');
    expect(low.sub.state.connects).toBe(2);
  });

  it('does not link with a device that is not wanted, until it is', async () => {
    const hub = new Hub();
    const [low, high] = pair(hub, { low: { wanted: false } });
    hub.announce(low.peerId, high.peerId);
    await sleep(80);
    expect(hub.sent).toEqual([]);
    expect(low.links.describe()).toEqual([{ peerId: high.peerId, state: 'refused', framesOut: 0 }]);

    low.wanted.value = true;
    low.links.reevaluate();
    await until(() => low.up.length === 1 && high.up.length === 1, 'the link once wanted');
  });
});

describe('a link that is up', () => {
  it('carries a datagram to the peer and nowhere else', async () => {
    const hub = new Hub();
    const [low, high] = pair(hub);
    hub.announce(low.peerId, high.peerId);
    await until(() => low.up.length === 1 && high.up.length === 1, 'both ends up');

    expect(low.links.sendDatagram(high.peerId, Buffer.from('hello'))).toBe(true);
    expect(low.links.sendDatagram('somebody-else', Buffer.from('nope'))).toBe(false);
    await until(() => high.datagrams.length === 1, 'the datagram');
    expect(high.datagrams).toEqual(['peer:hello']);
    expect(low.links.bytesSent()).toBeGreaterThan(0);
  });

  it('ends honestly when the peer leaves: reads fail, subduction is told, the device is let go', async () => {
    const hub = new Hub();
    const [low, high] = pair(hub);
    hub.announce(low.peerId, high.peerId);
    await until(() => low.up.length === 1 && high.up.length === 1, 'both ends up');

    const pendingRead = low.sub.transports[0].recvBytes();
    hub.gone(high.peerId, low.peerId);
    await expect(pendingRead).rejects.toThrow(/closed/);
    await until(() => low.down.length === 1, 'the link to be reported down');
    expect(low.sub.state.disconnectCallbacks).toBe(1);
    expect(low.sub.disconnectFromPeer).toHaveBeenCalledTimes(1);
    expect(low.links.linked()).toEqual([]);
    await expect(low.sub.transports[0].sendBytes(Buffer.from('x'))).rejects.toThrow(/closed/);
  });

  it('is replaced when the device comes back under a new peerId', async () => {
    const hub = new Hub();
    const a = device(hub);
    const b1 = device(hub);
    hub.announce(a.peerId, b1.peerId);
    await until(() => a.up.length === 1, 'the first link');

    // The same device, rebooted: same key, new peerId. The old one has not been reported gone.
    const b2 = device(hub, { key: b1.key });
    hub.announce(a.peerId, b2.peerId);
    await until(() => a.up.length === 2, 'the second link');

    expect(a.down.map((p) => p.peerId)).toEqual([b1.peerId]);
    expect(a.links.linked().map((p) => p.peerId)).toEqual([b2.peerId]);
    // Subduction knows the device by key: it was let go before the new connection was made.
    expect(a.sub.disconnectFromPeer).toHaveBeenCalledTimes(1);
  });

  it('is dropped when the peer says it has dropped it', async () => {
    const hub = new Hub();
    const [low, high] = pair(hub);
    hub.announce(low.peerId, high.peerId);
    await until(() => low.up.length === 1 && high.up.length === 1, 'both ends up');

    await high.sub.transports[0].disconnect(); // subduction on the far side gives the link up
    await until(() => low.down.length === 1, 'the near side to hear of it');
    // …and the initiator opens a new one.
    await until(() => low.up.length === 2 && high.up.length === 2, 'a new link');
  });
});
