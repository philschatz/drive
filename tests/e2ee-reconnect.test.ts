/**
 * The secure channel across the things that end a session: a peer reloading
 * (it comes back under a new peerId, with the same device key) and the relay
 * socket dropping and reconnecting. Sessions are per connection and are never
 * resumed — each of these must end in a new one, with documents catching up.
 */
import {
  startRecordingRelay, startPeer, befriend, createSharedDoc, openDoc, waitFor,
  type RecordingRelay, type HarnessPeer,
} from './support/two-peer-harness';

jest.setTimeout(180_000);

describe('reconnecting', () => {
  let relay: RecordingRelay;
  let alice: HarnessPeer;
  let bob: HarnessPeer;

  beforeAll(async () => {
    relay = await startRecordingRelay();
    alice = await startPeer('alice', relay.url);
    bob = await startPeer('bob', relay.url);
    await befriend(alice, bob);
  });

  afterAll(async () => {
    await alice?.close();
    await bob?.close();
    await relay?.close();
  });

  it('catches a peer up after it reloads', async () => {
    const { docId, handle } = await createSharedDoc(alice, bob, { v: 0 });
    expect((await openDoc(bob, docId)).doc().v).toBe(0);

    const before = bob.peerId;
    await bob.close();
    await waitFor(() => !alice.connectedPeerIds().includes(before), 'alice to see bob leave');
    handle.change((d: any) => { d.v = 1; d.whileAway = true; });

    bob = await startPeer('bob', relay.url, { reloadOf: bob });
    expect(bob.peerId).not.toBe(before);
    bob.watch([alice.groupId]);
    await waitFor(() => alice.connectedPeerIds().includes(bob.peerId) && bob.connectedPeerIds().includes(alice.peerId), 'the reloaded peer to be connected');

    const bobsCopy = await openDoc(bob, docId);
    await waitFor(() => bobsCopy.doc().whileAway === true, 'the reloaded peer to catch up');
    bobsCopy.change((d: any) => { d.fromBob = 'after the reload'; });
    await waitFor(() => handle.doc().fromBob === 'after the reload', 'a change from the reloaded peer to arrive');
  });

  it('recovers when the relay socket drops and reconnects', async () => {
    const { docId, handle } = await createSharedDoc(alice, bob, { v: 0 });
    const bobsCopy = await openDoc(bob, docId);

    alice.dropSocket();
    await waitFor(() => !bob.connectedPeerIds().includes(alice.peerId), 'bob to see alice drop');
    handle.change((d: any) => { d.duringTheDrop = true; });
    await waitFor(() => bob.connectedPeerIds().includes(alice.peerId) && alice.connectedPeerIds().includes(bob.peerId), 'both to be connected again');

    await waitFor(() => bobsCopy.doc().duringTheDrop === true, 'the change made during the drop to arrive');
    bobsCopy.change((d: any) => { d.afterTheDrop = true; });
    await waitFor(() => handle.doc().afterTheDrop === true, 'a change in the other direction to arrive');
  });
});
