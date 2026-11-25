/**
 * Who the relay introduces, and what it is told to do it — real keyhive, real
 * relay (src/shared/discovery-tokens.ts, src/relay/relay.ts).
 *
 * A device used to announce its user-group id and the group ids of everyone it
 * knew, in the clear: the relay was handed the social graph, and anyone who
 * had ever learned a group id could announce it and be introduced. Now a
 * device presents daily tokens, one per related device, each derived from a
 * secret the two devices compute from each other's keys and the relay never
 * sees.
 */
import {
  startRecordingRelay, startPeer, befriend, createSharedDoc, openDoc, waitFor,
  type RecordingRelay, type HarnessPeer,
} from './support/two-peer-harness';
import { decode } from 'cbor-x';
import { utcDay } from '../src/shared/discovery-tokens';

jest.setTimeout(240_000);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DAY = 86_400_000;

/** Every way a 32-byte id could sit in a frame: as bytes, and as the base64 text of them. */
function frameContains(bytes: Uint8Array, idBase64: string): boolean {
  const frame = Buffer.from(bytes);
  const raw = Buffer.from(idBase64, 'base64');
  const urlSafe = idBase64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return frame.includes(raw) || frame.includes(Buffer.from(idBase64)) || frame.includes(Buffer.from(urlSafe));
}

describe('discovery', () => {
  let relay: RecordingRelay;
  const peers: HarnessPeer[] = [];
  const start = async (...args: Parameters<typeof startPeer>) => {
    const peer = await startPeer(...args);
    peers.push(peer);
    return peer;
  };
  const stop = async (peer: HarnessPeer) => {
    peers.splice(peers.indexOf(peer), 1);
    await peer.close();
  };

  beforeEach(async () => { relay = await startRecordingRelay(); });
  afterEach(async () => {
    for (const peer of peers.splice(0)) await peer.close();
    await relay.close();
  });

  it('introduces friends, and the relay is never shown a group id', async () => {
    const alice = await start('alice', relay.url);
    const bob = await start('bob', relay.url);
    await befriend(alice, bob);
    const { docId, handle } = await createSharedDoc(alice, bob, { note: 'hello' });
    const bobs = await openDoc(bob, docId);
    handle.change((d: any) => { d.note = 'hello again'; });
    await waitFor(() => bobs.doc().note === 'hello again', 'bob to have the change');

    // What each declared is a list of opaque tokens and nothing else.
    const declarations = relay.frames.filter((f) => f.type === 'watch');
    expect(declarations.length).toBeGreaterThanOrEqual(2);
    for (const frame of declarations) {
      const decoded = decode(frame.bytes) as { type: string; v: number; tokens: string[] };
      expect(Object.keys(decoded).sort()).toEqual(['tokens', 'type', 'v']);
      expect(decoded.v).toBe(2);
      for (const token of decoded.tokens) expect(Buffer.from(token, 'base64')).toHaveLength(16);
    }
    // And no frame of any kind carries either user's group id.
    for (const groupId of [alice.groupId, bob.groupId]) {
      expect(relay.frames.filter((f) => frameContains(f.bytes, groupId)).map((f) => f.type)).toEqual([]);
    }
  });

  it('presents a different set of tokens each day', async () => {
    const alice = await start('alice', relay.url);
    const bob = await start('bob', relay.url);
    await befriend(alice, bob);
    const now = Date.now();
    const today = await alice.kr.discoveryTokens([], now);
    expect(today.sort()).toEqual(alice.declaredTokens().sort());
    expect(today.length).toBeGreaterThan(0);
    const dayAfterNext = await alice.kr.discoveryTokens([], now + 2 * DAY);
    expect(today.filter((t) => dayAfterNext.includes(t))).toEqual([]);
    // bob, a day ahead, still shares one with alice today.
    const bobTomorrow = await bob.kr.discoveryTokens([], now + DAY);
    expect(utcDay(now + DAY)).toBe(utcDay(now) + 1);
    expect(today.filter((t) => bobTomorrow.includes(t)).length).toBeGreaterThan(0);
  });

  it('does not introduce a device that knows the group id, or lists a user who does not list it', async () => {
    const alice = await start('alice', relay.url);
    const bob = await start('bob', relay.url);
    await befriend(alice, bob);

    // mallory has alice's contact card (it was once shown to her) and so knows
    // alice's group id and her device's key. alice has nothing of mallory's.
    const mallory = await start('mallory', relay.url);
    await mallory.kr.khOps.receiveContactCard(await alice.kr.khOps.getContactCard());
    mallory.watch([alice.groupId]);
    await waitFor(() => mallory.declaredTokens().length > 0, 'mallory to declare herself');
    // The old declaration, which used to be enough: "I am one of alice's devices".
    const eve = await start('eve', relay.url);
    eve.sendRelayFrame({ type: 'watch', group: alice.groupId, watch: [bob.groupId] });
    await sleep(2_000);

    expect(alice.connectedPeerIds()).toEqual([bob.peerId]);
    expect(mallory.connectedPeerIds()).toEqual([]);
    expect(eve.connectedPeerIds()).toEqual([]);
    // mallory does present a token for alice's device — the one alice would
    // present for mallory's, if alice listed her. She does not.
    expect(mallory.declaredTokens().filter((t) => alice.declaredTokens().includes(t))).toEqual([]);
  });

  it('a device just linked finds the one that linked it before keyhive lists it, and its siblings after', async () => {
    const phone = await start('phone', relay.url);
    phone.watch([]);
    const tablet = await start('tablet', relay.url, { deviceOf: phone });
    await waitFor(() => phone.kr.links.linked().length === 1, 'the phone and tablet to link');
    // The tablet is switched off. The laptop is linked from the phone meanwhile.
    await stop(tablet);
    const laptop = await start('laptop', relay.url, { deviceOf: phone });
    const [phoneKey, laptopKey] = await Promise.all([phone, laptop].map(async (p) => (await p.kr.khOps.getIdentity()).agentId));
    await waitFor(() => phone.kr.links.linked().length === 1 && laptop.kr.links.linked().length === 1, 'the phone and laptop to link');
    // What introduced them was the link itself; once keyhive lists the phone
    // on the laptop, that is what the laptop goes by, and the memory is dropped.
    await waitFor(async () => (await laptop.kr.relations.get()).get(phoneKey)?.own === true, 'the laptop to learn the phone is the user\'s');
    laptop.watch([]);
    await waitFor(() => Object.keys(laptop.linkedDevices()).length === 0, 'the laptop to stop remembering the phone');
    expect(laptop.connectedPeerIds()).toEqual([phone.peerId]);

    // The tablet comes back. It has never heard of the laptop: it has no key
    // for it, so no pair secret, and the two are strangers to the relay …
    const tabletAgain = await start('tablet', relay.url, { reloadOf: tablet });
    expect((await tabletAgain.kr.relations.get()).has(laptopKey)).toBe(false);
    tabletAgain.watch([]);
    // … until the phone, which knows both, has told it: then each lists the
    // other, and they meet.
    await waitFor(async () => (await tabletAgain.kr.relations.get()).get(laptopKey)?.own === true, 'the tablet to learn of the laptop from the phone');
    await waitFor(
      () => tabletAgain.connectedPeerIds().includes(laptop.peerId) && laptop.connectedPeerIds().includes(tabletAgain.peerId),
      'the relay to introduce the tablet and the laptop');
  });

  it('a removed device is no longer introduced', async () => {
    const phone = await start('phone', relay.url);
    phone.watch([]);
    const tablet = await start('tablet', relay.url, { deviceOf: phone });
    const laptop = await start('laptop', relay.url, { deviceOf: phone });
    laptop.watch([]);
    tablet.watch([]);
    await waitFor(
      () => [phone, tablet, laptop].every((p) => p.connectedPeerIds().length === 2),
      'all three devices to be introduced to each other');

    // The tablet is lost, and removed from the phone. Nothing has to be
    // rotated or told to anyone: the phone no longer lists the tablet, so it no
    // longer presents the token of that pair; the laptop hears of the removal
    // through keyhive and does the same.
    await phone.removeDevice(tablet);
    await waitFor(
      () => !phone.connectedPeerIds().includes(tablet.peerId) && !laptop.connectedPeerIds().includes(tablet.peerId),
      'the relay to stop introducing the tablet', 60_000);
    // A reconnect does not bring it back: the tablet still presents the tokens
    // of both pairs, and nobody presents them with it.
    tablet.dropSocket();
    await sleep(3_000);
    expect(phone.connectedPeerIds()).toEqual([laptop.peerId]);
    expect(laptop.connectedPeerIds()).toEqual([phone.peerId]);
    expect(tablet.declaredTokens().length).toBeGreaterThan(0);
    expect(tablet.declaredTokens().filter((t) => phone.declaredTokens().includes(t) || laptop.declaredTokens().includes(t))).toEqual([]);
  });
});
