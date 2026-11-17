/**
 * Can the relay read a document it forwards?
 *
 * Two real peers (real keyhive, real keyhive bridge, real Repo) are joined
 * through the real relay, which records every frame it receives. One peer puts
 * a marker string into a document and shares it with the other; once the other
 * has the document, no recorded frame may contain the marker — neither its
 * literal bytes nor in a sync message an outsider can decode on its own.
 *
 * The failure output lists each frame that leaked: its type, who sent it to
 * whom, its size, and the bytes around the marker.
 *
 * Before the secure channel (src/shared/secure-channel.ts) this failed: the
 * `sync` frame carrying the change held the marker verbatim.
 */
import {
  startRecordingRelay, startPeer, befriend, createSharedDoc, openDoc, findLeaks, waitFor,
  type RecordingRelay, type HarnessPeer,
} from './support/two-peer-harness';

jest.setTimeout(120_000);

// Short and high-entropy on purpose. Automerge DEFLATEs chunks over 256 bytes,
// so a long or repetitive document could hide its text from a literal byte
// search; this one cannot, and `findLeaks` decodes sync messages as well.
const MARKER = 'MARKER-7f3a9c41e2b85d06-readable-on-the-wire';

describe('document content in transit', () => {
  let relay: RecordingRelay;
  let alice: HarnessPeer;
  let bob: HarnessPeer;

  beforeAll(async () => {
    relay = await startRecordingRelay();
    alice = await startPeer('alice', relay.url);
    bob = await startPeer('bob', relay.url);
  });

  afterAll(async () => {
    await alice?.close();
    await bob?.close();
    await relay?.close();
  });

  it('is not readable by the relay that forwards it', async () => {
    const nameOf = (peerId: string) =>
      peerId === alice.peerId ? 'alice' : peerId === bob.peerId ? 'bob' : peerId ? 'relay' : '';

    await befriend(alice, bob);
    const { docId } = await createSharedDoc(alice, bob, { note: MARKER });

    // The control: the document really did travel from alice to bob through
    // the relay. Without this, "no leak" could just mean "nothing was sent".
    const bobsCopy = await openDoc(bob, docId);
    expect(bobsCopy.doc().note).toBe(MARKER);
    expect(relay.frames.some((f) => f.from === alice.peerId && f.targetId === bob.peerId)).toBe(true);

    expect(findLeaks(relay.frames, MARKER, alice.kr.Automerge, nameOf)).toEqual([]);
  });

  it('shows the relay nothing but who is talking to whom', async () => {
    await befriend(alice, bob);
    const { docId, handle: alicesCopy } = await createSharedDoc(alice, bob, { note: 'first' });
    const bobsCopy = await openDoc(bob, docId);
    bobsCopy.change((d: any) => { d.fromBob = MARKER; });
    await waitFor(() => alicesCopy.doc().fromBob === MARKER, 'alice to have bob\'s change');

    // Besides the relay's own protocol (join, and the discovery declaration),
    // every frame is a sealed one: no message type, document id or keyhive
    // operation is visible, in either direction.
    const types = new Set(relay.frames.map((f) => f.type));
    expect([...types].sort()).toEqual(['join', 'secure-channel', 'watch']);
    const sealed = relay.frames.filter((f) => f.type === 'secure-channel');
    expect(sealed.some((f) => f.from === alice.peerId)).toBe(true);
    expect(sealed.some((f) => f.from === bob.peerId)).toBe(true);
    for (const frame of sealed) {
      const bytes = Buffer.from(frame.bytes);
      expect(bytes.includes(docId)).toBe(false);
      expect(bytes.includes('keyhive-')).toBe(false);
    }
    expect(findLeaks(relay.frames, MARKER, alice.kr.Automerge)).toEqual([]);
  });

  it('keeps what it syncs from encrypted too: the sync store holds ciphertext', async () => {
    await befriend(alice, bob);
    const { docId } = await createSharedDoc(alice, bob, { note: MARKER });
    expect((await openDoc(bob, docId)).doc().note).toBe(MARKER);
    await alice.kr.repo.flush();
    await bob.kr.repo.flush();

    // A peer is handed blobs from this store, never the document itself. (The
    // Repo's own local copy of the document, under the document id, is plain.)
    for (const peer of [alice, bob]) {
      const blobs = [...peer.storage.store.values()].filter((e) => e.key[0] === 'subduction-interceptor' && e.key[1] === 'blobs');
      expect(blobs.length).toBeGreaterThan(0);
      for (const blob of blobs) expect(Buffer.from(blob.data).includes(MARKER)).toBe(false);
    }
  });
});
