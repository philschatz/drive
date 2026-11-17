/**
 * The secure channel in isolation: real WebCrypto, real device keys, and a wire
 * the test controls — it sees every frame, and can hold, reorder, alter, replay
 * or invent them, which is what the relay in the middle could do.
 *
 * (Two real peers through the real relay are tests/e2ee-transit.test.ts and
 * tests/e2ee-access.test.ts. Here the layers above the channel are a list of
 * what it announced and delivered.)
 */
import { EventEmitter } from 'events';
import {
  makeSecureChannelAdapter, decodeFrame, encodeHello, helloSigningBytes, SECURE_CHANNEL_MESSAGE,
  type SecureChannelAdapter,
} from '../src/shared/secure-channel';
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

/** Minimal stand-in for automerge-repo's NetworkAdapter base (just needs emit). */
class FakeBase extends EventEmitter {
  peerId?: string;
  peerMetadata?: unknown;
}

interface WireFrame { type: string; senderId: string; targetId: string; data?: Uint8Array; [k: string]: unknown }

/** The wire between devices: everything sent is recorded, then delivered unless `intercept` says otherwise. */
class Wire {
  frames: WireFrame[] = [];
  private ends = new Map<string, EventEmitter>();
  /** Return false to swallow a frame; the test delivers it (or not) itself. */
  intercept: (frame: WireFrame) => boolean = () => true;

  attach(peerId: string): any {
    const raw = new EventEmitter() as any;
    raw.connect = () => {};
    raw.disconnect = () => {};
    raw.isReady = () => true;
    raw.whenReady = () => Promise.resolve();
    raw.state = () => ({ value: 'ready' });
    raw.send = (frame: WireFrame) => {
      this.frames.push(frame);
      if (this.intercept(frame)) this.deliver(frame);
    };
    this.ends.set(peerId, raw);
    return raw;
  }
  deliver(frame: WireFrame): void { setImmediate(() => this.ends.get(frame.targetId)?.emit('message', frame)); }
  introduce(a: string, b: string): void {
    this.ends.get(a)?.emit('peer-candidate', { peerId: b, peerMetadata: {} });
    this.ends.get(b)?.emit('peer-candidate', { peerId: a, peerMetadata: {} });
  }
  leave(gone: string, seenBy: string): void { this.ends.get(seenBy)?.emit('peer-disconnected', { peerId: gone }); }
  raw(peerId: string): EventEmitter { return this.ends.get(peerId)!; }
}

interface Device {
  peerId: string;
  keys: CryptoKeyPair;
  adapter: SecureChannelAdapter;
  /** What the layers above were told, in order: `+peer`, `-peer`, or a delivered message. */
  log: string[];
  messages: any[];
}

async function newKeys(): Promise<{ keys: CryptoKeyPair; peerId: string }> {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  return { keys, peerId: `${Buffer.from(raw).toString('base64')}-drive-${Math.random().toString(36).slice(2, 10)}` };
}

async function device(wire: Wire, opts: { gapMs?: number } = {}): Promise<Device> {
  const { keys, peerId } = await newKeys();
  const log: string[] = [];
  const messages: any[] = [];
  const adapter = makeSecureChannelAdapter(FakeBase as any, wire.attach(peerId), {
    relayPeerId: RELAY_PEER_ID,
    privateKey: Promise.resolve(keys.privateKey),
    timings: { helloRetryMs: 50, helloRetryMaxMs: 200, gapMs: opts.gapMs ?? 150 },
  });
  adapter.on('peer-candidate', (p: any) => log.push(`+${p.peerId}`));
  adapter.on('peer-disconnected', (p: any) => log.push(`-${p.peerId}`));
  adapter.on('message', (m: any) => { messages.push(m); log.push(`msg:${m.data ? Buffer.from(m.data).toString() : m.type}`); });
  adapter.connect(peerId as any);
  return { peerId, keys, adapter, log, messages };
}

const say = (from: Device, to: Device, text: string, extra: Record<string, unknown> = {}) =>
  from.adapter.send({ type: 'sync', senderId: from.peerId, targetId: to.peerId, documentId: 'doc-1', data: Buffer.from(text), ...extra } as any);

async function pair(wire: Wire, a: Device, b: Device): Promise<void> {
  wire.introduce(a.peerId, b.peerId);
  await until(() => a.log.includes(`+${b.peerId}`) && b.log.includes(`+${a.peerId}`), 'both sides to be secure');
}

const devices: Device[] = [];
const make = async (wire: Wire, opts?: Parameters<typeof device>[1]) => { const d = await device(wire, opts); devices.push(d); return d; };
afterEach(async () => { for (const d of devices.splice(0)) await d.adapter.channel.stop(); });

describe('a session', () => {
  it('announces a peer only once it is secure, then carries messages both ways in order', async () => {
    const wire = new Wire();
    const [a, b] = [await make(wire), await make(wire)];
    expect(a.log).toEqual([]);
    await pair(wire, a, b);
    expect(a.adapter.channel.describe()).toEqual([{ peerId: b.peerId, state: 'secure' }]);

    for (let i = 0; i < 20; i++) say(a, b, `a${i}`);
    for (let i = 0; i < 20; i++) say(b, a, `b${i}`);
    await until(() => b.messages.length === 20 && a.messages.length === 20, 'all messages to arrive');
    expect(b.messages.map((m) => Buffer.from(m.data).toString())).toEqual(Array.from({ length: 20 }, (_, i) => `a${i}`));
    expect(a.messages.map((m) => Buffer.from(m.data).toString())).toEqual(Array.from({ length: 20 }, (_, i) => `b${i}`));
    // The message that arrives is the message that was sent.
    expect(b.messages[0]).toMatchObject({ type: 'sync', senderId: a.peerId, targetId: b.peerId, documentId: 'doc-1' });
  });

  it('puts nothing readable on the wire: not the contents, not the type, not the document id', async () => {
    const wire = new Wire();
    const [a, b] = [await make(wire), await make(wire)];
    await pair(wire, a, b);
    say(a, b, 'MARKER-the-contents-0123456789');
    await until(() => b.messages.length === 1, 'the message to arrive');

    expect(new Set(wire.frames.map((f) => f.type))).toEqual(new Set([SECURE_CHANNEL_MESSAGE]));
    for (const frame of wire.frames) {
      expect(Object.keys(frame).sort()).toEqual(['data', 'senderId', 'targetId', 'type']);
      const bytes = Buffer.from(frame.data!);
      expect(bytes.includes('MARKER-the-contents')).toBe(false);
      expect(bytes.includes('doc-1')).toBe(false);
      expect(bytes.includes('sync')).toBe(false);
    }
  });

  it('gives the two directions different keys, and each session new ones', async () => {
    const wire = new Wire();
    const [a, b] = [await make(wire), await make(wire)];
    await pair(wire, a, b);
    say(a, b, 'same words');
    say(b, a, 'same words');
    await until(() => a.messages.length === 1 && b.messages.length === 1, 'both to arrive');
    const first = wire.frames.filter((f) => decodeFrame(f.data)?.kind === 'data');
    expect(Buffer.from(first[0].data!).subarray(18).equals(Buffer.from(first[1].data!).subarray(18))).toBe(false);

    // Introduced again: a new session, so the same message seals differently.
    wire.introduce(a.peerId, b.peerId);
    await until(() => a.log.filter((l) => l === `+${b.peerId}`).length === 2 && b.log.filter((l) => l === `+${a.peerId}`).length === 2, 'the second session');
    say(a, b, 'same words');
    await until(() => b.messages.length === 2, 'the message on the second session');
    const all = wire.frames.filter((f) => f.senderId === a.peerId && decodeFrame(f.data)?.kind === 'data');
    expect(Buffer.from(all[0].data!).equals(Buffer.from(all[1].data!))).toBe(false);
  });

  it('ends when the peer leaves, and nothing more is sent to it', async () => {
    const wire = new Wire();
    const [a, b] = [await make(wire), await make(wire)];
    await pair(wire, a, b);
    wire.leave(b.peerId, a.peerId);
    await until(() => a.log.includes(`-${b.peerId}`), 'the departure to be announced');
    const before = wire.frames.length;
    say(a, b, 'into the void');
    await sleep(50);
    expect(wire.frames.length).toBe(before);
  });

  it('ends every session when the relay socket reopens', async () => {
    const wire = new Wire();
    const [a, b, c] = [await make(wire), await make(wire), await make(wire)];
    await pair(wire, a, b);
    await pair(wire, a, c);
    a.adapter.channel.resetAll();
    await until(() => a.log.includes(`-${b.peerId}`) && a.log.includes(`-${c.peerId}`), 'both sessions to end');
    expect(a.adapter.channel.describe()).toEqual([]);
  });

  it('announces the relay as it always was, and sends it nothing', async () => {
    const wire = new Wire();
    const a = await make(wire);
    wire.raw(a.peerId).emit('peer-candidate', { peerId: RELAY_PEER_ID, peerMetadata: {} });
    expect(a.log).toEqual([`+${RELAY_PEER_ID}`]);
    a.adapter.send({ type: 'keyhive-sync-request', senderId: a.peerId, targetId: RELAY_PEER_ID, data: Buffer.from('x') } as any);
    await sleep(30);
    expect(wire.frames).toEqual([]);
  });
});

describe('a peer that cannot prove its key', () => {
  it('is never announced and never sent anything, whatever peerId it claims', async () => {
    const wire = new Wire();
    const a = await make(wire);
    const victim = await newKeys();   // the member whose peerId is claimed
    const impostor = await newKeys(); // holds a different key
    const raw = wire.attach(victim.peerId);
    // The impostor answers every hello it is sent, signing with the only key it has.
    raw.on('message', async (frame: WireFrame) => {
      const hello = decodeFrame(frame.data);
      if (hello?.kind !== 'hello') return;
      const eph = new Uint8Array(await crypto.subtle.exportKey('raw',
        (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])).publicKey));
      const signature = new Uint8Array(await crypto.subtle.sign(
        'Ed25519', impostor.keys.privateKey, helloSigningBytes(victim.peerId, a.peerId, eph, hello.eph)));
      raw.send({ type: SECURE_CHANNEL_MESSAGE, senderId: victim.peerId, targetId: a.peerId, data: encodeHello(eph, hello.eph, signature) });
    });
    wire.raw(a.peerId).emit('peer-candidate', { peerId: victim.peerId, peerMetadata: {} });
    await sleep(400);

    expect(a.log).toEqual([]);
    expect(a.adapter.channel.describe()).toEqual([{ peerId: victim.peerId, state: 'handshaking' }]);
    say(a, { peerId: victim.peerId } as Device, 'a document for the member');
    await sleep(50);
    // All `a` ever sent the impostor is hellos: its own fresh public key, signed.
    expect(wire.frames.filter((f) => f.senderId === a.peerId).every((f) => decodeFrame(f.data)?.kind === 'hello')).toBe(true);
  });

  it('gets nowhere by replaying a real hello from an earlier exchange', async () => {
    const wire = new Wire();
    const [a, b] = [await make(wire), await make(wire)];
    await pair(wire, a, b);
    const recorded = wire.frames.filter((f) => f.senderId === b.peerId && decodeFrame(f.data)?.kind === 'hello');
    expect(recorded.length).toBeGreaterThan(0);

    // b goes; later something joins under b's peerId and plays b's hellos back.
    wire.leave(b.peerId, a.peerId);
    await until(() => a.log.includes(`-${b.peerId}`), 'b to be gone');
    await b.adapter.channel.stop();
    const replayer = wire.attach(b.peerId);
    replayer.on('message', () => { for (const frame of recorded) wire.deliver(frame); });
    wire.raw(a.peerId).emit('peer-candidate', { peerId: b.peerId, peerMetadata: {} });
    await sleep(400);

    // The recordings are genuinely b's, but they echo a key `a` no longer uses.
    expect(a.log.filter((l) => l === `+${b.peerId}`)).toHaveLength(1);
    expect(a.adapter.channel.describe()).toEqual([{ peerId: b.peerId, state: 'handshaking' }]);
  });

  it('is ignored when it speaks without the channel at all (an older build)', async () => {
    const wire = new Wire();
    const [a, b] = [await make(wire), await make(wire)];
    await pair(wire, a, b);
    wire.deliver({ type: 'sync', senderId: b.peerId, targetId: a.peerId, data: Buffer.from('plaintext') });
    await sleep(50);
    expect(a.messages).toEqual([]);
  });
});

describe('a wire that misbehaves', () => {
  it('drops an altered frame, and still delivers the real one', async () => {
    const wire = new Wire();
    const [a, b] = [await make(wire), await make(wire)];
    await pair(wire, a, b);
    wire.intercept = (frame) => {
      if (frame.senderId !== a.peerId || decodeFrame(frame.data)?.kind !== 'data') return true;
      const altered = Uint8Array.from(frame.data!);
      altered[altered.length - 1] ^= 1;
      wire.deliver({ ...frame, data: altered }); // the forgery arrives first…
      return true;                               // …then the real frame
    };
    say(a, b, 'the real message');
    await until(() => b.messages.length === 1, 'the real message');
    expect(Buffer.from(b.messages[0].data).toString()).toBe('the real message');
  });

  it('delivers a replayed frame only once', async () => {
    const wire = new Wire();
    const [a, b] = [await make(wire), await make(wire)];
    await pair(wire, a, b);
    say(a, b, 'once');
    await until(() => b.messages.length === 1, 'the message');
    const frame = wire.frames.find((f) => f.senderId === a.peerId && decodeFrame(f.data)?.kind === 'data')!;
    wire.deliver(frame);
    wire.deliver(frame);
    await sleep(50);
    expect(b.messages).toHaveLength(1);
  });

  it('puts frames that overtook each other back in order', async () => {
    const wire = new Wire();
    const [a, b] = [await make(wire), await make(wire)];
    await pair(wire, a, b);
    const held: WireFrame[] = [];
    wire.intercept = (frame) => {
      if (frame.senderId === a.peerId && decodeFrame(frame.data)?.kind === 'data') { held.push(frame); return false; }
      return true;
    };
    for (let i = 0; i < 5; i++) say(a, b, `m${i}`);
    await until(() => held.length === 5, 'the frames to be sent');
    for (const frame of [held[3], held[1], held[4], held[0], held[2]]) wire.deliver(frame);
    await until(() => b.messages.length === 5, 'all five');
    expect(b.messages.map((m) => Buffer.from(m.data).toString())).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('starts the session over when a frame goes missing for good', async () => {
    const wire = new Wire();
    const [a, b] = [await make(wire), await make(wire)];
    await pair(wire, a, b);
    let dropped = false;
    wire.intercept = (frame) => {
      if (!dropped && frame.senderId === a.peerId && decodeFrame(frame.data)?.kind === 'data') { dropped = true; return false; }
      return true;
    };
    say(a, b, 'lost');
    say(a, b, 'stranded behind the gap');
    await until(
      () => b.log.filter((l) => l === `+${a.peerId}`).length === 2 && a.log.filter((l) => l === `+${b.peerId}`).length === 2,
      'a fresh session on both sides');
    expect(b.log).toContain(`-${a.peerId}`);
    expect(a.log).toContain(`-${b.peerId}`);
    // …and the new session works.
    say(a, b, 'after');
    await until(() => b.messages.some((m) => Buffer.from(m.data).toString() === 'after'), 'a message on the new session');
    expect(b.messages.map((m) => Buffer.from(m.data).toString())).toEqual(['after']);
  });
});

describe('what a sealed message may claim', () => {
  it('drops a message that names a different sender than the device that sealed it', async () => {
    const wire = new Wire();
    const [a, b, c] = [await make(wire), await make(wire), await make(wire)];
    await pair(wire, a, b);
    say(a, b, 'as someone else', { senderId: c.peerId });
    say(a, b, 'as myself');
    await until(() => b.messages.length === 1, 'the honest message');
    expect(Buffer.from(b.messages[0].data).toString()).toBe('as myself');
  });
});
