/**
 * The secure channel: everything two devices say to each other, encrypted and
 * authenticated between those two devices.
 *
 * The relay forwards whatever it is handed, and before this existed it was
 * handed documents in the clear: automerge-repo's sync messages are plain
 * Automerge bytes, the keyhive bridge signs only its own `keyhive-*` messages,
 * and a peerId — the thing every access decision is made about — was whatever
 * a socket claimed it was. So the relay could read every document it carried,
 * and anyone able to present a member's peerId was sent that member's
 * documents.
 *
 * This adapter sits between the relay/WebRTC adapter and everything above it
 * (the keyhive bridge, and through it the Repo), and changes two things:
 *
 * - **A peer exists only once it has proved its key.** When the relay
 *   introduces a peer, the two devices exchange a fresh ECDH public key each,
 *   signed with their device (keyhive) keys — the key that IS the front of a
 *   peerId. A signature that does not verify against the peerId's key, or that
 *   is not about this pair and these two fresh keys, establishes nothing. Only
 *   when the exchange completes is the peer announced upward. So the access
 *   check the Repo makes for "this peerId" is about a device that holds that
 *   key, and a peer that cannot prove one never receives a byte.
 * - **Every message is sealed for that one device.** The exchange yields a
 *   session key per direction (HKDF over the ECDH secret, bound to both peerIds
 *   and both fresh keys). Each message — document sync, presence, keyhive's own
 *   sync — is CBOR-encoded and sealed with AES-256-GCM under it. What crosses
 *   the relay, and the WebRTC channel whose signaling the relay could have
 *   tampered with, is a frame naming the two peers and nothing else.
 *
 * The keys are per connection and never stored: a session ends when the peer
 * leaves, is introduced again, or the relay socket reopens, and the next one
 * starts from new ECDH keys.
 *
 * What this does not do: decide who may see a document, or keep a document
 * from a device that was once given it. The channel seals for a *device*. Who
 * is offered a document is keyhive's answer (subduction-policy.ts,
 * subduction-scope.ts), and what keeps a removed member from reading what is
 * written afterwards is the document's own key (subduction-interceptor.ts) —
 * both ride inside this channel.
 *
 * Size. A sealed frame is as long as the message in it, and the relay — or
 * anyone watching the connection — sees lengths. Unpadded, those told a lot:
 * one frame grew by exactly 8 bytes with every change made to a document (a
 * running change count, and a fingerprint of which document it was), and
 * another gave the size of each edit to the byte. So a message is padded before
 * it is sealed, to one of a few sizes (`paddedSize`): what shows is which
 * bucket, not the length.
 *
 * Order. A peer's route can switch between the relay and a direct channel
 * mid-stream, so a later frame can overtake an earlier one. Frames carry a
 * counter (which is also the cipher's nonce); an early one is held until the
 * gap fills, and a gap that does not fill restarts the session.
 */
import { Encoder, decode } from 'cbor-x';
import type { Message, NetworkAdapterInterface, PeerId, PeerMetadata } from '@automerge/automerge-repo';
import { agentIdOfPeerId } from './peer-id';
import { createLogger } from './logger';

const log = createLogger('channel');

/** The automerge-repo message type every sealed frame and handshake frame travels as. */
export const SECURE_CHANNEL_MESSAGE = 'secure-channel';

// ── Wire format ──────────────────────────────────────────────────────────────
//
//   byte 0   version (1)
//   byte 1   kind: 1 = hello, 2 = data
//
//   hello:   bytes 2-66     this side's fresh ECDH P-256 public key (raw, 65 bytes)
//            bytes 67-131   the peer's fresh key this side has seen, or zeros
//            bytes 132-195  Ed25519 signature by the sender's device key
//
//   data:    bytes 2-9      session id
//            bytes 10-17    counter (u64, big-endian), per direction, from 0
//            bytes 18-      AES-256-GCM ciphertext and tag
//
// A hello's signature covers a domain tag, both peerIds and every other byte of
// the frame. A data frame's associated data is the same, so a frame cannot be
// replayed into another pair, direction or session.
//
// The plaintext of a data frame is the CBOR of the message, with one extra map
// entry — a byte string of zeros under a `__pad` key — sized so the whole lands
// on a bucket (see `padEncodedMessage`). The receiver drops the entry. A build
// from before padding ignores an entry it does not know, so the two interwork.

const VERSION = 1;
const KIND_HELLO = 1;
const KIND_DATA = 2;
const ECDH_KEY_BYTES = 65;
const SIGNATURE_BYTES = 64;
const SESSION_ID_BYTES = 8;
const HELLO_BYTES = 2 + ECDH_KEY_BYTES * 2 + SIGNATURE_BYTES;
const DATA_HEADER_BYTES = 2 + SESSION_ID_BYTES + 8;

const text = new TextEncoder();
const HELLO_DOMAIN = text.encode('automerge-drive/secure-channel/v1/hello');
const DATA_DOMAIN = text.encode('automerge-drive/secure-channel/v1/data');
const KEY_DOMAIN = text.encode('automerge-drive/secure-channel/v1/keys');
const NO_KEY = new Uint8Array(ECDH_KEY_BYTES);
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

// Same CBOR settings as the relay and the WebRTC adapter, so `Message.data` round-trips.
const cbor = new Encoder({ tagUint8Array: false, useRecords: false });

// ── Padding ──────────────────────────────────────────────────────────────────

/** Bytes a data frame adds around its plaintext: the header and the GCM tag. */
export const DATA_FRAME_OVERHEAD_BYTES = DATA_HEADER_BYTES + 16;

/** The map key padding travels under. */
const PAD_KEY = '__pad';

/**
 * What the padding entry adds besides its zeros: the key (a short text string)
 * and a byte-string header whose length is always written in the 4-byte form.
 * A minimal header grows with the length it states, which would leave some
 * totals unreachable (a 23-byte string takes 24 bytes, a 24-byte one 26);
 * decoders read either form.
 */
const PAD_ENTRY_OVERHEAD = 1 + PAD_KEY.length + 5;

/** Small messages all look alike; these are the only sizes up to 16 KiB. */
const PAD_BUCKETS = [1024, 2048, 4096, 8192, 16384];

/**
 * The size a message of `n` bytes is padded to.
 *
 * Up to 16 KiB, the next of five sizes: the frames that say most — keyhive's
 * heartbeat, a sync round's opening summary, a keystroke's commit — all fall in
 * the first one or two. Above that a fixed set would cost too much (a 5 MB
 * first sync padded to 8 MB), so the size is rounded up to a multiple that
 * grows with it (Padmé: Nikitin et al., "Reducing Metadata Leakage from
 * Encrypted Files and Communication"): at most about 12% more, and the lengths
 * a message can have shrink from n to roughly log n of them.
 */
export function paddedSize(n: number): number {
  for (const bucket of PAD_BUCKETS) if (n <= bucket) return bucket;
  const e = Math.floor(Math.log2(n));
  const unit = 2 ** (e - (Math.floor(Math.log2(e)) + 1));
  return Math.ceil(n / unit) * unit;
}

/**
 * `encoded` — a message as this file's CBOR encoder writes it — with one more
 * map entry: zeros that bring it to `paddedSize`. Returns it unchanged if it is
 * not a map in the form expected (never a reason not to send).
 *
 * The entry is spliced on rather than encoded: cbor-x writes a plain object as
 * a map with a 16-bit entry count (0xb9, high, low), so one more entry is the
 * count plus one and the bytes appended, and a large message is not encoded
 * twice to be measured. secure-channel.test.ts holds this to the encoder.
 */
export function padEncodedMessage(encoded: Uint8Array): Uint8Array {
  if (encoded.length < 3 || encoded[0] !== 0xb9) return encoded;
  const count = (encoded[1] << 8) | encoded[2];
  if (count >= 0xffff) return encoded;
  const unpadded = encoded.length + PAD_ENTRY_OVERHEAD;
  const target = paddedSize(unpadded);
  const zeros = target - unpadded;
  const out = new Uint8Array(target); // the padding itself is the zeros already here
  out.set(encoded);
  out[1] = (count + 1) >> 8;
  out[2] = (count + 1) & 0xff;
  let at = encoded.length;
  out[at++] = 0x60 + PAD_KEY.length;
  for (let i = 0; i < PAD_KEY.length; i++) out[at++] = PAD_KEY.charCodeAt(i);
  out[at++] = 0x5a;
  out[at++] = (zeros >>> 24) & 0xff;
  out[at++] = (zeros >>> 16) & 0xff;
  out[at++] = (zeros >>> 8) & 0xff;
  out[at++] = zeros & 0xff;
  return out;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const short = (peerId: string) => `${peerId.slice(0, 8)}…${peerId.slice(-8)}`;
const buf = (bytes: Uint8Array) => bytes as BufferSource;

function concat(...parts: (Uint8Array | number)[]): Uint8Array {
  const size = parts.reduce<number>((n, p) => n + (typeof p === 'number' ? 1 : p.length), 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    if (typeof p === 'number') out[at++] = p;
    else { out.set(p, at); at += p.length; }
  }
  return out;
}

function u64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(n / 2 ** 32));
  view.setUint32(4, n >>> 0);
  return out;
}

function readU64(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
  return view.getUint32(0) * 2 ** 32 + view.getUint32(4);
}

/** The 32-byte Ed25519 verifying key in front of a peerId — the device's keyhive identity. */
export function deviceKeyOfPeerId(peerId: string): Uint8Array {
  return Uint8Array.from(atob(agentIdOfPeerId(peerId)), (c) => c.charCodeAt(0));
}

/** The bytes a hello's signature is over. */
export function helloSigningBytes(senderId: string, targetId: string, eph: Uint8Array, echo: Uint8Array): Uint8Array {
  return concat(HELLO_DOMAIN, 0, text.encode(senderId), 0, text.encode(targetId), 0, VERSION, eph, echo);
}

export function encodeHello(eph: Uint8Array, echo: Uint8Array, signature: Uint8Array): Uint8Array {
  return concat(VERSION, KIND_HELLO, eph, echo, signature);
}

export type Frame =
  | { kind: 'hello'; eph: Uint8Array; echo: Uint8Array; signature: Uint8Array }
  | { kind: 'data'; sessionId: Uint8Array; counter: number; header: Uint8Array; ciphertext: Uint8Array };

/** The frame in `data`, or null if it is not one this version understands. */
export function decodeFrame(data: unknown): Frame | null {
  if (!(data instanceof Uint8Array) || data.byteLength < 2 || data[0] !== VERSION) return null;
  if (data[1] === KIND_HELLO) {
    if (data.byteLength !== HELLO_BYTES) return null;
    return {
      kind: 'hello',
      eph: data.slice(2, 2 + ECDH_KEY_BYTES),
      echo: data.slice(2 + ECDH_KEY_BYTES, 2 + ECDH_KEY_BYTES * 2),
      signature: data.slice(2 + ECDH_KEY_BYTES * 2),
    };
  }
  if (data[1] === KIND_DATA) {
    if (data.byteLength <= DATA_HEADER_BYTES) return null;
    return {
      kind: 'data',
      sessionId: data.slice(2, 2 + SESSION_ID_BYTES),
      counter: readU64(data.subarray(2 + SESSION_ID_BYTES)),
      header: data.slice(0, DATA_HEADER_BYTES),
      ciphertext: data.slice(DATA_HEADER_BYTES),
    };
  }
  return null;
}

/** AES-GCM's 96-bit nonce: the frame's counter. Unique per key, since each direction of each session has its own. */
const nonceOf = (counter: number) => concat(new Uint8Array(4), u64(counter));
const associatedData = (senderId: string, targetId: string, header: Uint8Array) =>
  concat(DATA_DOMAIN, 0, text.encode(senderId), 0, text.encode(targetId), 0, header);

// ── Sessions ─────────────────────────────────────────────────────────────────

interface Ephemeral { publicRaw: Uint8Array; privateKey: CryptoKey }

async function newEphemeral(): Promise<Ephemeral> {
  const pair = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
  return { publicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)), privateKey: pair.privateKey };
}

interface Session {
  id: Uint8Array;
  sendKey: CryptoKey;
  recvKey: CryptoKey;
  sendCounter: number;
  recvCounter: number;
  /** Frames that arrived ahead of their turn, by counter. */
  held: Map<number, Extract<Frame, { kind: 'data' }>>;
  gapTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * The two session keys and the session id, from this side's fresh private key
 * and the peer's fresh public key. Both peerIds and both fresh keys go into the
 * derivation in a fixed order, so the two sides arrive at the same keys only
 * if they agree on all four.
 */
async function deriveSession(me: string, mine: Ephemeral, peerId: string, theirs: Uint8Array): Promise<Session> {
  const theirKey = await crypto.subtle.importKey('raw', buf(theirs), ECDH, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirKey }, mine.privateKey, 256);
  const iAmLow = me < peerId;
  const [loId, loEph, hiId, hiEph] = iAmLow ? [me, mine.publicRaw, peerId, theirs] : [peerId, theirs, me, mine.publicRaw];
  const salt = await crypto.subtle.digest('SHA-256', buf(concat(text.encode(loId), 0, loEph, text.encode(hiId), 0, hiEph)));
  const hkdf = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const okm = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: buf(KEY_DOMAIN) }, hkdf, (32 + 32 + SESSION_ID_BYTES) * 8));
  const aes = (bytes: Uint8Array, use: 'encrypt' | 'decrypt') => crypto.subtle.importKey('raw', buf(bytes), 'AES-GCM', false, [use]);
  const loToHi = okm.slice(0, 32);
  const hiToLo = okm.slice(32, 64);
  return {
    id: okm.slice(64),
    sendKey: await aes(iAmLow ? loToHi : hiToLo, 'encrypt'),
    recvKey: await aes(iAmLow ? hiToLo : loToHi, 'decrypt'),
    sendCounter: 0,
    recvCounter: 0,
    held: new Map(),
    gapTimer: null,
  };
}

// ── The adapter ──────────────────────────────────────────────────────────────

export interface SecureChannelTimings {
  /** How long before an unanswered hello is sent again; doubles each time. */
  helloRetryMs: number;
  helloRetryMaxMs: number;
  /** How long an early frame waits for the ones before it. */
  gapMs: number;
}

const DEFAULT_TIMINGS: SecureChannelTimings = { helloRetryMs: 1_000, helloRetryMaxMs: 15_000, gapMs: 2_000 };
/** Unanswered hellos after which a peer is worth a warning (an older build?). */
const WARN_AFTER_HELLOS = 5;
/** Frames held per peer, early or for a session not established yet. */
const MAX_HELD_FRAMES = 256;

/** A peer whose session is established. */
export interface ChannelPeer {
  peerId: string;
  /** The device's 32-byte Ed25519 key — its keyhive identity, proved in the handshake. */
  deviceKey: Uint8Array;
}

export interface SecureChannelOptions {
  /** The relay's own peerId: a router that cannot hold a session. Announced upward as today; nothing is sent to it. */
  relayPeerId: string;
  /** This device's Ed25519 signing key (the keyhive device key), once it exists. */
  privateKey: Promise<CryptoKey>;
  timings?: Partial<SecureChannelTimings>;
}

export interface SecureChannelControl {
  /** One line per introduced peer, for a debug surface. */
  describe(): Array<{ peerId: string; state: 'secure' | 'handshaking' }>;
  /** End every session and forget every peer; the relay re-introduces them (its socket reopened). */
  resetAll(): void;
  /** End everything and stop listening. */
  stop(): Promise<void>;
}

export type SecureChannelAdapter = NetworkAdapterInterface & { channel: SecureChannelControl };

/** Minimal shape of the automerge-repo `NetworkAdapter` base class we extend. */
type NetworkAdapterBase = new () => NetworkAdapterInterface & { emit: (event: string, payload?: unknown) => void };

interface Peer extends ChannelPeer {
  metadata: PeerMetadata;
  verifyKey: Promise<CryptoKey> | null;
  /** This side's fresh key for the handshake in progress (or the session it produced). */
  eph: Ephemeral;
  /** The peer's fresh key, once a valid hello has carried it. */
  theirEph: Uint8Array | null;
  /** The peer key echoed in the last hello sent — whether the peer has been told its key was seen. */
  echoed: Uint8Array | null;
  session: Session | null;
  /** Frames for a session this side has not established yet (the peer finished first). */
  early: Extract<Frame, { kind: 'data' }>[];
  sendChain: Promise<void>;
  hellos: number;
  helloTimer: ReturnType<typeof setTimeout> | null;
}

export function makeSecureChannelAdapter(
  Base: NetworkAdapterBase, raw: NetworkAdapterInterface, opts: SecureChannelOptions,
): SecureChannelAdapter {
  const timings = { ...DEFAULT_TIMINGS, ...opts.timings };
  const peers = new Map<string, Peer>();
  let stopped = false;
  let privateKey: CryptoKey | null = null;
  const ready = opts.privateKey.then((key) => { privateKey = key; });
  // Plaintext seen from a peer, by type, so a chatty old build is one line each.
  const reportedPlaintext = new Set<string>();

  class SecureChannel extends (Base as NetworkAdapterBase) {
    channel!: SecureChannelControl;

    connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
      this.peerId = peerId;
      this.peerMetadata = peerMetadata;
      raw.connect(peerId, peerMetadata);
    }

    send(message: Message): void {
      const peer = peers.get(message.targetId);
      const session = peer?.session;
      // No session: the relay, or a peer that left a moment ago. There is
      // nobody a plaintext copy could be for.
      if (!peer || !session) return;
      seal(peer, session, message);
    }

    disconnect(): void { raw.disconnect(); }
    isReady(): boolean { return raw.isReady(); }
    whenReady(): Promise<void> { return raw.whenReady(); }
    state() { return raw.state(); }
  }

  const adapter = new SecureChannel();
  const me = () => adapter.peerId as string;

  // Everything that arrives is handled one at a time, in arrival order: opening
  // a frame is asynchronous, and without this a later one could be delivered
  // before an earlier one.
  let inbound: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void> | void): void => {
    inbound = inbound.then(async () => {
      if (stopped) return;
      await ready;
      if (stopped) return;
      await work();
    }).catch((err) => log.warn('channel event failed:', err));
  };

  // ── sending ──

  function seal(peer: Peer, session: Session, message: Message): void {
    // Sealing is asynchronous; the chain keeps messages leaving in the order
    // they were sent, each with the next counter.
    peer.sendChain = peer.sendChain.then(async () => {
      if (peer.session !== session) return; // the session ended while this waited its turn
      const counter = session.sendCounter++;
      const header = concat(VERSION, KIND_DATA, session.id, u64(counter));
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: buf(nonceOf(counter)), additionalData: buf(associatedData(me(), peer.peerId, header)) },
        session.sendKey, buf(padEncodedMessage(cbor.encode(message) as Uint8Array)));
      raw.send({
        type: SECURE_CHANNEL_MESSAGE, senderId: me(), targetId: peer.peerId,
        data: concat(header, new Uint8Array(sealed)),
      } as unknown as Message);
    }).catch((err) => log.warn(`sealing a message for ${short(peer.peerId)} failed:`, err));
  }

  async function sendHello(peer: Peer): Promise<void> {
    const echo = peer.theirEph ?? NO_KEY;
    const signature = new Uint8Array(await crypto.subtle.sign(
      'Ed25519', privateKey!, buf(helloSigningBytes(me(), peer.peerId, peer.eph.publicRaw, echo))));
    peer.echoed = peer.theirEph;
    raw.send({
      type: SECURE_CHANNEL_MESSAGE, senderId: me(), targetId: peer.peerId,
      data: encodeHello(peer.eph.publicRaw, echo, signature),
    } as unknown as Message);
  }

  /** Keep saying hello until the session is up: the first one may have reached a peer not listening yet. */
  function scheduleHelloRetry(peer: Peer): void {
    if (peer.helloTimer || stopped) return;
    const delay = Math.min(timings.helloRetryMaxMs, timings.helloRetryMs * 2 ** peer.hellos);
    peer.helloTimer = setTimeout(() => {
      peer.helloTimer = null;
      enqueue(async () => {
        if (peers.get(peer.peerId) !== peer || peer.session) return;
        peer.hellos++;
        if (peer.hellos === WARN_AFTER_HELLOS) {
          log.warn(`no secure channel with ${short(peer.peerId)} after ${peer.hellos} attempts (an older build?)`);
        }
        await sendHello(peer);
        scheduleHelloRetry(peer);
      });
    }, delay * (0.75 + Math.random() * 0.5));
    (peer.helloTimer as any)?.unref?.();
  }

  // ── session lifecycle ──

  function endSession(peer: Peer, reason: string): void {
    const session = peer.session;
    if (!session) return;
    if (session.gapTimer) clearTimeout(session.gapTimer);
    peer.session = null;
    peer.early = [];
    log.info(`secure channel with ${short(peer.peerId)} down: ${reason}`);
    adapter.emit('peer-disconnected', { peerId: peer.peerId });
  }

  function forget(peer: Peer, reason: string): void {
    if (peer.helloTimer) { clearTimeout(peer.helloTimer); peer.helloTimer = null; }
    endSession(peer, reason);
    if (peers.get(peer.peerId) === peer) peers.delete(peer.peerId);
  }

  /** Start over with a peer: new keys on this side, and a hello that tells the peer to do the same. */
  async function restart(peer: Peer, reason: string): Promise<void> {
    endSession(peer, reason);
    peer.eph = await newEphemeral();
    peer.theirEph = null;
    peer.echoed = null;
    peer.hellos = 0;
    await sendHello(peer);
    scheduleHelloRetry(peer);
  }

  async function establish(peer: Peer): Promise<void> {
    peer.session = await deriveSession(me(), peer.eph, peer.peerId, peer.theirEph!);
    if (peer.helloTimer) { clearTimeout(peer.helloTimer); peer.helloTimer = null; }
    peer.hellos = 0;
    log.info(`secure channel with ${short(peer.peerId)} up`);
    // Only now does the peer exist for the layers above.
    adapter.emit('peer-candidate', { peerId: peer.peerId, peerMetadata: peer.metadata });
    // Frames the peer sent before this side had finished.
    const early = peer.early;
    peer.early = [];
    for (const frame of early) await onData(peer, frame);
  }

  // ── receiving ──

  async function onHello(peer: Peer, frame: Extract<Frame, { kind: 'hello' }>): Promise<void> {
    peer.verifyKey ??= crypto.subtle.importKey('raw', buf(peer.deviceKey), 'Ed25519', false, ['verify']);
    const genuine = await crypto.subtle.verify(
      'Ed25519', await peer.verifyKey, buf(frame.signature),
      buf(helloSigningBytes(peer.peerId, me(), frame.eph, frame.echo)));
    if (!genuine) {
      log.warn(`dropping a hello from ${short(peer.peerId)}: not signed by the key in its peerId`);
      return;
    }

    // The echo is what makes a hello fresh: it names the key this side made a
    // moment ago, so it cannot be a recording of an earlier exchange.
    const sawMine = sameBytes(frame.echo, peer.eph.publicRaw);

    if (!peer.theirEph || !sameBytes(peer.theirEph, frame.eph)) {
      // A fresh key from the peer: its first, or it has started over. A peer
      // that starts over echoes nothing (or, having heard this side since, this
      // side's current key). A different key that echoes some OTHER key of this
      // side is a hello from an exchange already superseded, arriving late —
      // acting on it would tear down the session that replaced it.
      if (peer.session && !sawMine && !sameBytes(frame.echo, NO_KEY)) return;
      // A session built on the peer's previous key is over; this side starts over with it.
      if (peer.session) {
        endSession(peer, 'the peer started a new handshake');
        peer.eph = await newEphemeral();
      }
      peer.theirEph = frame.eph;
      peer.echoed = null;
    }

    // Re-read: this side may just have made a new key above.
    const sawCurrent = sameBytes(frame.echo, peer.eph.publicRaw);
    if (sawCurrent && !peer.session) await establish(peer);
    // The peer needs the same from this side: a hello echoing its current key.
    if (!sawCurrent || !peer.echoed || !sameBytes(peer.echoed, peer.theirEph)) await sendHello(peer);
    if (!peer.session) scheduleHelloRetry(peer);
  }

  async function open(peer: Peer, session: Session, frame: Extract<Frame, { kind: 'data' }>): Promise<boolean> {
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: buf(nonceOf(frame.counter)), additionalData: buf(associatedData(peer.peerId, me(), frame.header)) },
        session.recvKey, buf(frame.ciphertext));
    } catch {
      log.warn(`dropping a frame from ${short(peer.peerId)} that does not open (altered, or not from that peer)`);
      return false;
    }
    let message: Message;
    try { message = decode(new Uint8Array(plain)) as Message; } catch { return true; }
    // Padding is the sender's business; what is passed on is the message it sealed.
    if (message && typeof message === 'object') delete (message as any)[PAD_KEY];
    // The frame proved who sent it; the message inside must not claim otherwise.
    if ((message as any)?.senderId !== peer.peerId || (message as any)?.targetId !== me()) {
      log.warn(`dropping a message from ${short(peer.peerId)} that names a different sender or target`);
      return true;
    }
    adapter.emit('message', message);
    return true;
  }

  async function onData(peer: Peer, frame: Extract<Frame, { kind: 'data' }>): Promise<void> {
    const session = peer.session;
    if (!session || !sameBytes(session.id, frame.sessionId)) {
      // The peer may have finished the handshake first and started talking: keep
      // the frame for the session about to exist. Anything else is a leftover.
      if (!session && peer.early.length < MAX_HELD_FRAMES) peer.early.push(frame);
      return;
    }
    if (frame.counter < session.recvCounter) return; // a duplicate, or a replay
    if (frame.counter > session.recvCounter) {
      // Early: an earlier frame is still on the slower route. Hold it.
      if (session.held.size >= MAX_HELD_FRAMES) { await restart(peer, 'too many frames arrived out of order'); return; }
      session.held.set(frame.counter, frame);
      if (!session.gapTimer) {
        session.gapTimer = setTimeout(() => {
          session.gapTimer = null;
          enqueue(() => (peer.session === session && session.held.size ? restart(peer, 'a frame went missing') : undefined));
        }, timings.gapMs);
        (session.gapTimer as any)?.unref?.();
      }
      return;
    }
    // A frame that does not open does not use up its counter: the real one still fits.
    if (!(await open(peer, session, frame))) return;
    session.recvCounter++;
    for (let next = session.held.get(session.recvCounter); next && peer.session === session; next = session.held.get(session.recvCounter)) {
      session.held.delete(session.recvCounter);
      if (!(await open(peer, session, next))) break;
      session.recvCounter++;
    }
    if (session.held.size === 0 && session.gapTimer) { clearTimeout(session.gapTimer); session.gapTimer = null; }
  }

  async function onCandidate(peerId: string, metadata: PeerMetadata): Promise<void> {
    if (peerId === me()) return;
    let deviceKey: Uint8Array;
    try { deviceKey = deviceKeyOfPeerId(peerId); } catch { return; }
    if (deviceKey.length !== 32) return;
    // An earlier boot of this very device, still joined at the relay.
    if (sameBytes(deviceKey, deviceKeyOfPeerId(me()))) return;

    // Introduced again: whatever session there was belongs to a previous socket.
    const previous = peers.get(peerId);
    if (previous) forget(previous, 'the peer was introduced again');

    const peer: Peer = {
      peerId, deviceKey, metadata, verifyKey: null,
      eph: await newEphemeral(), theirEph: null, echoed: null,
      session: null, early: [], sendChain: Promise.resolve(), hellos: 0, helloTimer: null,
    };
    peers.set(peerId, peer);
    await sendHello(peer);
    scheduleHelloRetry(peer);
  }

  // ── wiring ──

  const onMessage = (message: Message) => {
    const senderId = (message as any)?.senderId as string;
    if ((message as any)?.type !== SECURE_CHANNEL_MESSAGE) {
      // Not sealed: an older build, or something pretending to be a peer. Never passed on.
      const key = `${senderId}|${(message as any)?.type}`;
      if (!reportedPlaintext.has(key)) {
        reportedPlaintext.add(key);
        log.warn(`ignoring an unencrypted "${(message as any)?.type}" message from ${short(String(senderId))} (an older build?)`);
      }
      return;
    }
    if ((message as any).targetId !== me()) return;
    enqueue(async () => {
      // Only peers the relay introduced: a frame from anyone else starts nothing.
      const peer = peers.get(senderId);
      if (!peer) return;
      const frame = decodeFrame((message as any).data);
      if (!frame) return;
      if (frame.kind === 'hello') await onHello(peer, frame); else await onData(peer, frame);
    });
  };
  const onPeerCandidate = (p: { peerId: PeerId; peerMetadata: PeerMetadata }) => {
    // The relay is announced as it always was — the layers above know it by its
    // id and give it nothing — but it has no key, so no session and no traffic.
    if (p.peerId === opts.relayPeerId) { adapter.emit('peer-candidate', p); return; }
    enqueue(() => onCandidate(p.peerId, p.peerMetadata));
  };
  const onPeerDisconnected = (p: { peerId: PeerId }) => {
    if (p.peerId === opts.relayPeerId) { adapter.emit('peer-disconnected', p); return; }
    enqueue(() => { const peer = peers.get(p.peerId); if (peer) forget(peer, 'the peer left'); });
  };
  const onClose = () => adapter.emit('close');
  raw.on('message', onMessage as any);
  raw.on('peer-candidate', onPeerCandidate as any);
  raw.on('peer-disconnected', onPeerDisconnected as any);
  raw.on('close', onClose);

  adapter.channel = {
    describe: () => [...peers.values()].map((peer) => ({
      peerId: peer.peerId, state: peer.session ? 'secure' as const : 'handshaking' as const,
    })),
    resetAll: () => enqueue(() => { for (const peer of [...peers.values()]) forget(peer, 'the relay socket reopened'); }),
    stop: async () => {
      if (stopped) return;
      raw.off('message', onMessage as any);
      raw.off('peer-candidate', onPeerCandidate as any);
      raw.off('peer-disconnected', onPeerDisconnected as any);
      raw.off('close', onClose);
      await inbound;
      stopped = true;
      for (const peer of [...peers.values()]) forget(peer, 'stopping');
    },
  };

  return adapter as unknown as SecureChannelAdapter;
}
