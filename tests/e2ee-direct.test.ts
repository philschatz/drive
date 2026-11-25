/**
 * Who gets a direct (WebRTC) connection, and what the relay sees of it.
 *
 * Negotiating a direct connection tells the other side this device's network
 * addresses — its ICE candidates name the LAN address and, with STUN, the
 * public one. It used to start the moment the relay introduced a socket, with
 * the offer and candidates crossing the relay in the clear: the relay read
 * them, and so did anything that could get itself introduced (it only had to
 * know a user-group id, and hold no key at all).
 *
 * Now a device negotiates only with a peer that has proved its key AND that it
 * is related to, and the negotiation travels sealed inside the secure channel.
 * These run the real stack with a real RTC implementation (werift, host
 * candidates only) through the real relay, which records every frame.
 */
import WebSocket from 'ws';
import { Encoder, decode } from 'cbor-x';
import {
  startRecordingRelay, startPeer, befriend, createSharedDoc, openDoc, waitFor,
  type RecordingRelay, type HarnessPeer,
} from './support/two-peer-harness';

jest.setTimeout(180_000);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const cbor = new Encoder({ tagUint8Array: false, useRecords: false });
const maybeIt = process.env.DRIVE_SKIP_LOOPBACK_TEST ? it.skip : it;

/** Whether any frame the relay received carries session-description or candidate text. */
function relaySawNegotiation(relay: RecordingRelay): string[] {
  const seen: string[] = [];
  for (const f of relay.frames) {
    const text = Buffer.from(f.bytes).toString('latin1');
    for (const marker of ['a=ice-ufrag', 'a=fingerprint', 'typ host', 'typ srflx', 'candidate:']) {
      if (text.includes(marker)) seen.push(`frame ${f.index} (${f.type}): ${marker}`);
    }
  }
  return seen;
}

describe('direct connections', () => {
  let relay: RecordingRelay;
  const peers: HarnessPeer[] = [];
  const start = async (name: string) => {
    const peer = await startPeer(name, relay.url, { webrtc: true });
    peers.push(peer);
    return peer;
  };

  beforeEach(async () => { relay = await startRecordingRelay(); });
  afterEach(async () => {
    for (const peer of peers.splice(0)) await peer.close();
    await relay.close();
  });

  maybeIt('two friends move onto a direct channel, and the relay sees none of the negotiation', async () => {
    const alice = await start('alice');
    const bob = await start('bob');
    await befriend(alice, bob);

    await waitFor(
      () => alice.transportOf(bob.peerId) === 'direct' && bob.transportOf(alice.peerId) === 'direct',
      'alice and bob to reach a direct channel', 60_000);

    // Documents sync over it.
    const { docId, handle } = await createSharedDoc(alice, bob, { note: 'first' });
    const bobsCopy = await openDoc(bob, docId);
    handle.change((d: any) => { d.note = 'over the data channel'; });
    await waitFor(() => bobsCopy.doc().note === 'over the data channel', 'bob to have the change');

    // The relay carried the negotiation, and could read none of it.
    expect([...new Set(relay.frames.map((f) => f.type))].sort()).toEqual(['join', 'secure-channel', 'watch']);
    expect(relaySawNegotiation(relay)).toEqual([]);
  });

  maybeIt('negotiates with nothing it is not related to: no key, or a key of its own', async () => {
    const alice = await start('alice');
    alice.watch([]);

    // Something that holds no key at all, and only knows alice's group id.
    const received: any[] = [];
    const sock = new WebSocket(relay.url);
    await new Promise<void>((resolve) => sock.on('open', () => resolve()));
    sock.on('message', (raw: Buffer) => { try { received.push(decode(new Uint8Array(raw))); } catch { /* not a frame */ } });
    sock.send(cbor.encode({ type: 'join', senderId: `${'z'.repeat(43)}=-nokey`, peerMetadata: {}, supportedProtocolVersions: ['1'] }));
    await sleep(200);
    sock.send(cbor.encode({ type: 'watch', group: alice.groupId, watch: [] }));

    // A real device with a key of its own, announcing alice's group as its own.
    const mallory = await start('mallory');
    mallory.sendRelayFrame({ type: 'watch', group: alice.groupId, watch: [] });
    await waitFor(
      () => alice.kr.channel.describe().some((p) => p.peerId === mallory.peerId && p.state === 'secure'),
      'mallory to prove its own key to alice');

    // …and it pushes: an offer of its own, sealed and delivered.
    const fromMallory = () => relay.frames.filter((f) => f.from === mallory.peerId && f.targetId === alice.peerId).length;
    const before = fromMallory();
    mallory.forceDirectOffer(alice.peerId);
    await waitFor(() => fromMallory() > before, 'mallory\'s offer to cross the relay');
    await sleep(2_000);

    // Alice's RTC stack was never touched: nothing asked it to connect, and
    // nothing handed it a signal. So no candidate of hers was ever produced.
    expect(alice.directAttempts()).toEqual([]);
    expect(alice.transportOf(mallory.peerId)).toBe('relay');
    expect(received.filter((m) => m?.type === 'wrtc-signal')).toEqual([]);
    expect(received.some((m) => m?.type === 'peer')).toBe(true); // it WAS introduced
    sock.close();
  });
});
