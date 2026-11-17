/**
 * A document's history must be readable, in full, by a member added later —
 * from whichever device they happen to reach.
 *
 * Each commit is encrypted when it is written, under the keys of that moment;
 * a later member holds only the current key and reads back through the chain
 * of keys each commit carries for its parents. And a device serves a document
 * from its sync store, not from the document itself. So this is where two
 * things would show: a broken key chain, and a sync store that has fallen
 * behind its document (which automerge-repo's compaction can cause on the
 * encrypted path — see src/shared/subduction-storage-guard.ts). Either leaves
 * the newcomer with a document that never finishes loading.
 */
import {
  startRecordingRelay, startPeer, createDoc, shareDoc, openDoc, waitFor, missingFromSyncStore,
  type RecordingRelay, type HarnessPeer,
} from './support/two-peer-harness';

jest.setTimeout(300_000);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const headsOf = (peer: HarnessPeer, handle: any) => [...peer.kr.Automerge.getHeads(handle.doc())].sort().join(',');

/** Changes in bursts, with pauses, so they are saved and synced as they would be while someone types. */
async function edit(handle: any, count: number, field: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    handle.change((d: any) => { d[field] = (d[field] ?? 0) + 1; });
    if (i % 50 === 49) await sleep(120);
  }
}

describe('a member added later', () => {
  let relay: RecordingRelay;
  let alice: HarnessPeer;
  let bob: HarnessPeer;
  let carol: HarnessPeer;

  const friends = async (a: HarnessPeer, b: HarnessPeer) => {
    await a.kr.khOps.receiveContactCard(await b.kr.khOps.getContactCard());
    await b.kr.khOps.receiveContactCard(await a.kr.khOps.getContactCard());
  };
  /** Announce who each peer wants to meet; pairs that both name each other are introduced. */
  const introduce = (pairs: [HarnessPeer, HarnessPeer][]) => {
    const wants = new Map<HarnessPeer, string[]>();
    for (const [a, b] of pairs) {
      wants.set(a, [...(wants.get(a) ?? []), b.groupId]);
      wants.set(b, [...(wants.get(b) ?? []), a.groupId]);
    }
    for (const peer of [alice, bob, carol]) peer.watch(wants.get(peer) ?? []);
  };

  beforeEach(async () => {
    relay = await startRecordingRelay();
    alice = await startPeer('alice', relay.url);
    bob = await startPeer('bob', relay.url);
    carol = await startPeer('carol', relay.url);
    await friends(alice, bob); await friends(alice, carol); await friends(bob, carol);
  });

  afterEach(async () => {
    await alice?.close();
    await bob?.close();
    await carol?.close();
    await relay?.close();
  });

  it('reads everything written before it joined, across key changes', async () => {
    introduce([[alice, bob], [alice, carol]]);
    await waitFor(() => alice.kr.links.linked().length === 2, 'alice to be linked to both');

    const { docId, khDocId, handle } = await createDoc(alice, { a: 0 });
    await edit(handle, 300, 'a');
    // bob joins, writes (a member's first write starts a new key epoch), and is removed again.
    await shareDoc(alice, bob, khDocId);
    const bobsCopy = await openDoc(bob, docId);
    await waitFor(() => bobsCopy.doc().a === 300, 'bob to have the document');
    await edit(bobsCopy, 100, 'b');
    await waitFor(() => handle.doc().b === 100, 'alice to have bob\'s changes');
    await alice.kr.khOps.revokeMember(bob.groupId, khDocId);
    await edit(handle, 200, 'a');
    await alice.kr.repo.flush();

    await shareDoc(alice, carol, khDocId);
    const carolsCopy = await openDoc(carol, docId, 60_000);
    await waitFor(() => headsOf(carol, carolsCopy) === headsOf(alice, handle), 'carol to have the whole history', 60_000);
    expect(carolsCopy.doc()).toEqual({ a: 500, b: 100 });
  });

  it.each(['alice', 'bob'] as const)(
    'can get the whole document from %s alone, after it was written by two people at once',
    async (survivorName) => {
      introduce([[alice, bob]]);
      await waitFor(() => alice.kr.links.linked().length === 1 && bob.kr.links.linked().length === 1, 'alice and bob to be linked');

      // A long history written by one, then both writing at once: the receiving
      // side takes commits in bursts while it is also saving its own.
      const { docId, khDocId, handle } = await createDoc(alice, { a: 0, b: 0 });
      await shareDoc(alice, bob, khDocId);
      const bobsCopy = await openDoc(bob, docId);
      await edit(handle, 1_200, 'a');
      await waitFor(() => bobsCopy.doc().a === 1_200, 'bob to have the long history', 60_000);
      await Promise.all([edit(handle, 150, 'a'), edit(bobsCopy, 150, 'b')]);
      await waitFor(() => headsOf(alice, handle) === headsOf(bob, bobsCopy), 'alice and bob to converge', 60_000);
      await alice.kr.repo.flush();
      await bob.kr.repo.flush();
      await sleep(1_000); // compaction is not awaited by a flush

      // carol becomes a member, and then only one of the two is there to give her the document.
      await shareDoc(alice, carol, khDocId);
      await sleep(1_500); // long enough for bob to hear that carol is a member
      const survivor = survivorName === 'alice' ? alice : bob;
      const leaver = survivorName === 'alice' ? bob : alice;
      const expected = headsOf(alice, handle);
      // The direct form of what carol is about to depend on: everything the
      // survivor's document is made of is in the store it serves her from.
      const survivorsCopy = survivorName === 'alice' ? handle : bobsCopy;
      await waitFor(
        () => missingFromSyncStore(survivor, survivorsCopy).length === 0,
        `${survivorName}'s sync store to hold everything its document is made of`, 15_000,
      );
      await leaver.close();
      introduce([[survivor, carol]]);

      const carolsCopy = await openDoc(carol, docId, 90_000);
      await waitFor(() => headsOf(carol, carolsCopy) === expected, `carol to have the whole document from ${survivorName}`, 90_000);
      expect(carolsCopy.doc()).toEqual({ a: 1_350, b: 150 });
    },
  );
});
