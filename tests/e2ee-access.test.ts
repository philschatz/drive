/**
 * Who a document reaches, and whose changes are taken — with real peers
 * through the real relay.
 *
 * The secure channel (src/shared/secure-channel.ts) makes "which device is
 * this?" a proven fact, so keyhive's answer to "may it?" finally means
 * something. These are the cases that depended on it:
 *
 * - a device that is not a member asks for a document, and gets nothing;
 * - something joins the relay under a member's peerId, without the member's
 *   key, and gets nothing;
 * - a read-only member's changes are not taken by an editor;
 * - a member who is removed stops receiving, and stops being listened to —
 *   from the device that removed them at once, and from the others as soon as
 *   they have heard.
 *
 * What a removed member already has, it keeps; and a member who has not yet
 * heard of a removal still sends to the removed device. Neither is something a
 * channel between two devices can change.
 */
import WebSocket from 'ws';
import { Encoder, decode } from 'cbor-x';
import {
  startRecordingRelay, startPeer, createDoc, shareDoc, createSharedDoc, openDoc, waitFor,
  type RecordingRelay, type HarnessPeer,
} from './support/two-peer-harness';
import { decodeFrame } from '../src/shared/secure-channel';

jest.setTimeout(180_000);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const cbor = new Encoder({ tagUint8Array: false, useRecords: false });

/** Everything `peer` has stored for a document: the classic store keys it by document id. */
const storedFor = (peer: HarnessPeer, docId: string) =>
  [...peer.storage.store.values()].filter((e) => e.key[0] === docId).length;

describe('who a document reaches', () => {
  let relay: RecordingRelay;
  let alice: HarnessPeer;
  let bob: HarnessPeer;
  let carol: HarnessPeer;

  beforeAll(async () => {
    relay = await startRecordingRelay();
    alice = await startPeer('alice', relay.url);
    bob = await startPeer('bob', relay.url);
    carol = await startPeer('carol', relay.url);
    // Three friends, all introduced to each other.
    const everyone = [alice, bob, carol];
    for (const a of everyone) {
      for (const b of everyone) {
        if (a !== b) await a.kr.khOps.receiveContactCard(await b.kr.khOps.getContactCard());
      }
    }
    for (const peer of everyone) peer.watch(everyone.filter((p) => p !== peer).map((p) => p.groupId));
    await waitFor(() => everyone.every((p) => p.connectedPeerIds().length === 2), 'all three to be connected to each other');
  });

  afterAll(async () => {
    await alice?.close();
    await bob?.close();
    await carol?.close();
    await relay?.close();
  });

  it('gives nothing to a connected friend who is not a member and asks for the document', async () => {
    const { docId, handle } = await createSharedDoc(alice, bob, { note: 'for alice and bob' });
    await openDoc(bob, docId);
    handle.change((d: any) => { d.more = 1; });

    // carol knows the id (say bob told her) and asks.
    await expect(openDoc(carol, docId, 4_000)).rejects.toThrow(/could not open/);
    expect(storedFor(carol, docId)).toBe(0);
    // The control: bob, who is a member, has it stored.
    expect(storedFor(bob, docId)).toBeGreaterThan(0);
  });

  it('tells a connected friend nothing about a document they are not in: not one frame', async () => {
    const framesToCarol = () => alice.kr.links.describe().find((l) => l.peerId === carol.peerId)!.framesOut;
    await waitFor(() => alice.kr.links.linked().length === 2, 'alice to be linked to bob and carol');
    await sleep(500); // let the links' own handshakes settle
    const before = framesToCarol();

    const { docId, handle } = await createSharedDoc(alice, bob, { v: 0 });
    const bobsCopy = await openDoc(bob, docId);
    for (let i = 1; i <= 5; i++) {
      handle.change((d: any) => { d.v = i; });
      bobsCopy.change((d: any) => { d[`b${i}`] = i; });
      await sleep(100);
    }
    await waitFor(() => bobsCopy.doc().v === 5 && handle.doc().b5 === 5, 'alice and bob to converge');
    await sleep(500);

    // Stock subduction would have asked carol about the document on every sync,
    // showing her its id and commit ids. She is linked to alice the whole time,
    // and is sent nothing.
    expect(framesToCarol()).toBe(before);
  });

  it('does not take a read-only member\'s changes, and keeps sending it everyone else\'s', async () => {
    const { docId, khDocId, handle } = await createDoc(alice, { v: 1 });
    await shareDoc(alice, bob, khDocId, 'read');
    const bobsCopy = await openDoc(bob, docId);
    expect(bobsCopy.doc().v).toBe(1);

    bobsCopy.change((d: any) => { d.scribble = 'by a reader'; });
    await sleep(2_500);
    expect(handle.doc().scribble).toBeUndefined();

    handle.change((d: any) => { d.v = 2; });
    await waitFor(() => bobsCopy.doc().v === 2, 'the reader to receive a later change');
    expect(handle.doc().scribble).toBeUndefined();
  });

  it('stops sending to a removed member at once, and stops listening to it', async () => {
    const { docId, khDocId, handle } = await createSharedDoc(alice, bob, { log: ['start'] });
    const bobsCopy = await openDoc(bob, docId);
    bobsCopy.change((d: any) => { d.log.push('bob while a member'); });
    await waitFor(() => handle.doc().log.length === 2, 'bob\'s change to reach alice');

    await alice.kr.khOps.revokeMember(bob.groupId, khDocId);
    // The very next change, with no pause: the removal must already hold.
    handle.change((d: any) => { d.log.push('alice after removing bob'); });
    bobsCopy.change((d: any) => { d.log.push('bob after being removed'); });
    await sleep(2_500);

    expect(bobsCopy.doc().log).toEqual(['start', 'bob while a member', 'bob after being removed']);
    expect(handle.doc().log).toEqual(['start', 'bob while a member', 'alice after removing bob']);
  });

  it('has the other members stop too, once they have heard of the removal', async () => {
    const { docId, khDocId, handle } = await createSharedDoc(alice, bob, { log: ['start'] });
    await shareDoc(alice, carol, khDocId);
    const bobsCopy = await openDoc(bob, docId);
    const carolsCopy = await openDoc(carol, docId);
    await carol.kr.khOps.registerSharingGroup(khDocId);
    const carolListsBob = async () => (await carol.kr.khOps.getDocMembers(khDocId)).some((m) => m.agentId === bob.groupId);
    await waitFor(carolListsBob, 'carol to know bob is a member');

    await alice.kr.khOps.revokeMember(bob.groupId, khDocId);
    // Until carol hears of it she would still pass changes on to bob — that
    // window is real, and is why nothing is written here until it has closed.
    await waitFor(async () => !(await carolListsBob()), 'carol to hear that bob was removed');

    carolsCopy.change((d: any) => { d.log.push('carol after bob was removed'); });
    await waitFor(() => handle.doc().log.length === 2, 'alice to have carol\'s change');
    handle.change((d: any) => { d.log.push('alice after removing bob'); });
    await waitFor(() => carolsCopy.doc().log.length === 3, 'carol to have alice\'s change');
    bobsCopy.change((d: any) => { d.log.push('bob after being removed'); });
    await sleep(2_500);

    expect(bobsCopy.doc().log).toEqual(['start', 'bob after being removed']);
    expect(handle.doc().log).toEqual(['start', 'carol after bob was removed', 'alice after removing bob']);
    expect(carolsCopy.doc().log).toEqual(handle.doc().log);
  });

  it('gives nothing to something that joins the relay under a member\'s peerId without the member\'s key', async () => {
    const { docId, handle } = await createSharedDoc(alice, bob, { note: 'MARKER-for-the-real-bob-5512' });
    await openDoc(bob, docId);

    // bob goes offline; the impostor takes his place at the relay: his peerId,
    // and the tokens he declared. Knowing bob's group id would get it nowhere
    // (tests/e2ee-discovery.test.ts) — the tokens are what someone who had
    // watched the relay's traffic today, or the relay itself, could replay.
    const bobsPeerId = bob.peerId;
    const bobsTokens = bob.declaredTokens();
    expect(bobsTokens.length).toBeGreaterThan(0);
    await bob.close();
    await waitFor(() => !alice.connectedPeerIds().includes(bobsPeerId), 'alice to see bob leave');

    const received: any[] = [];
    const socket = new WebSocket(relay.url);
    await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
    socket.on('message', (raw: Buffer) => { try { received.push(decode(new Uint8Array(raw))); } catch { /* ignore */ } });
    socket.send(cbor.encode({ type: 'join', senderId: bobsPeerId, supportedProtocolVersions: ['1'] }));
    socket.send(cbor.encode({ type: 'watch', v: 2, tokens: bobsTokens }));
    try {
      // The relay believes it: alice is introduced to "bob" again.
      await waitFor(() => received.some((m) => m.type === 'peer' && m.senderId === alice.peerId), 'the relay to introduce alice to the impostor');
      handle.change((d: any) => { d.later = 'MARKER-written-while-the-impostor-listens-7781'; });
      await sleep(2_500);

      // alice never treats it as a peer…
      expect(alice.connectedPeerIds()).not.toContain(bobsPeerId);
      // …and all it was ever sent is the start of a handshake it cannot finish:
      // a fresh public key, signed. No document, no keyhive state, nothing sealed.
      const fromAlice = received.filter((m) => m.senderId === alice.peerId && m.type !== 'peer');
      expect(fromAlice.length).toBeGreaterThan(0);
      for (const message of fromAlice) {
        expect(message.type).toBe('secure-channel');
        expect(decodeFrame(message.data)?.kind).toBe('hello');
      }
    } finally {
      socket.terminate();
    }
  });
});
