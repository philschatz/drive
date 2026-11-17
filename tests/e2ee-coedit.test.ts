/**
 * Two people typing in the same long document at once — a soak, and opt-in:
 *
 *     SOAK=1 npx jest tests/e2ee-coedit.test.ts          (a minute or two)
 *     SOAK=1 SOAK_SECONDS=60 SOAK_PRELOAD=0 npx jest tests/e2ee-coedit.test.ts
 *
 * Run it when automerge-repo or subduction is upgraded, and when
 * src/shared/subduction-storage-guard.ts or the pacing in subduction-scope.ts
 * changes. It is skipped otherwise because of what it takes to mean anything:
 * a history of thousands of changes, then half a minute of both peers writing.
 *
 * What it is for. With encrypted sync each peer receives the other's commits
 * in bursts while saving its own, and automerge-repo compacts its sync store
 * after every one of those. On this path that compaction deleted records the
 * document still needed (commits whose decryption was in flight; fragments
 * that became live between its listing and its deletes). Nothing looked wrong
 * — the documents converged, heads equal — but the sync store a peer serves
 * others from had holes, so a member added later could never finish loading.
 * This test is what found both, two runs in three, and only at this size:
 * with a short history there are no fragments to lose.
 * tests/e2ee-history.test.ts covers the consequence at a size that fits the
 * unit suite; this covers the conditions.
 *
 * It also measures what co-editing costs, so the peers run on PRODUCTION
 * timings (the harness's are shortened): the delay before one peer sees the
 * other's edit, and the traffic two typists generate — a sync round opens with
 * a summary proportional to the document's whole history, which is why
 * subduction-scope.ts paces rounds. The numbers are printed; the delay is also
 * asserted.
 */
import {
  startRecordingRelay, startPeer, befriend, createSharedDoc, openDoc, waitFor, missingFromSyncStore,
  type RecordingRelay, type HarnessPeer,
} from './support/two-peer-harness';

jest.setTimeout(900_000);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long both peers type for. */
const SECONDS = Number(process.env.SOAK_SECONDS ?? 30);
/** Changes written by one peer before the typing starts: the long history. */
const PRELOAD = Number(process.env.SOAK_PRELOAD ?? 4_000);
/** Each peer makes this many changes a second. */
const CHANGES_PER_SECOND = 5;
/** A co-editor's change must show on the other side within this, 19 times in 20. */
const MAX_P95_DELAY_MS = 2_000;

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

/** The records `peer`'s document is made of that its sync store lacks, by kind. */
function describeMissing(peer: HarnessPeer, handle: any): string[] {
  const fragments = new Set(
    (peer.kr.Automerge.getFragmentMetadata(handle.doc(), { start: 1 }) as { head: string }[]).map((m) => m.head),
  );
  return missingFromSyncStore(peer, handle).map((head) => `${fragments.has(head) ? 'fragment' : 'commit'} ${head.slice(0, 8)}`);
}

(process.env.SOAK ? describe : describe.skip)('two people typing in a long document', () => {
  let relay: RecordingRelay;
  let alice: HarnessPeer;
  let bob: HarnessPeer;

  beforeAll(async () => {
    relay = await startRecordingRelay();
    alice = await startPeer('alice', relay.url, { productionTimings: true });
    bob = await startPeer('bob', relay.url, { productionTimings: true });
  });
  afterAll(async () => {
    await alice?.close();
    await bob?.close();
    await relay?.close();
  });

  it(`converges, promptly, and leaves both sync stores complete (${PRELOAD} changes, then ${SECONDS} s of both typing)`, async () => {
    await befriend(alice, bob);
    const { docId, handle: alicesCopy } = await createSharedDoc(alice, bob, { a: {}, b: {} });
    const bobsCopy = await openDoc(bob, docId, 120_000);

    // The long history, written in bursts as it would be while someone types.
    for (let i = 0; i < PRELOAD; i++) {
      alicesCopy.change((d: any) => { d.history = i; });
      if (i % 50 === 49) await sleep(120);
    }
    if (PRELOAD) {
      await waitFor(() => bobsCopy.doc().history === PRELOAD - 1, 'bob to have the long history', 300_000);
      await sleep(2_000);
    }

    // Each change notes when it was made; the other side notes when it first shows.
    const madeAt = new Map<string, number>();
    const delays = { aliceSeesBob: [] as number[], bobSeesAlice: [] as number[] };
    const watch = (handle: any, field: 'a' | 'b', into: number[]) => {
      const seen = new Set<string>();
      handle.on('change', () => {
        const now = Date.now();
        for (const key of Object.keys(handle.doc()[field] ?? {})) {
          if (seen.has(key)) continue;
          seen.add(key);
          const at = madeAt.get(`${field}:${key}`);
          if (at !== undefined) into.push(now - at);
        }
      });
    };
    watch(alicesCopy, 'b', delays.aliceSeesBob);
    watch(bobsCopy, 'a', delays.bobSeesAlice);

    // Both type, alternating, each at CHANGES_PER_SECOND.
    const firstFrame = relay.frames.length;
    const each = SECONDS * CHANGES_PER_SECOND;
    const gap = 1_000 / CHANGES_PER_SECOND / 2;
    for (let i = 0; i < each; i++) {
      madeAt.set(`a:k${i}`, Date.now());
      alicesCopy.change((d: any) => { d.a[`k${i}`] = i; });
      await sleep(gap);
      madeAt.set(`b:k${i}`, Date.now());
      bobsCopy.change((d: any) => { d.b[`k${i}`] = i; });
      await sleep(gap);
    }
    const typed = relay.frames.slice(firstFrame);

    await waitFor(
      () => Object.keys(alicesCopy.doc().b).length === each && Object.keys(bobsCopy.doc().a).length === each,
      'each to have everything the other typed', 60_000,
    );
    const heads = (peer: HarnessPeer, handle: any) => [...peer.kr.Automerge.getHeads(handle.doc())].sort().join(',');
    await waitFor(() => heads(alice, alicesCopy) === heads(bob, bobsCopy), 'the two documents to be the same', 30_000);

    const summary = (values: number[]) => ({
      n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: percentile(values, 1),
    });
    const measured = {
      changesEach: each,
      delayMs: { aliceSeesBob: summary(delays.aliceSeesBob), bobSeesAlice: summary(delays.bobSeesAlice) },
      wire: {
        frames: typed.length,
        kbPerSecond: Math.round(typed.reduce((n, f) => n + f.bytes.byteLength, 0) / 1024 / SECONDS),
      },
    };
    console.log(`co-editing, ${PRELOAD} changes of history:\n${JSON.stringify(measured, null, 1)}`);

    expect(measured.delayMs.aliceSeesBob.p95).toBeLessThan(MAX_P95_DELAY_MS);
    expect(measured.delayMs.bobSeesAlice.p95).toBeLessThan(MAX_P95_DELAY_MS);

    // The part nothing else would show. Complete is the state at rest — a save
    // and the compaction after it are separate steps — so wait for it; if it
    // never comes, say which records are gone.
    await alice.kr.repo.flush();
    await bob.kr.repo.flush();
    try {
      await waitFor(
        () => missingFromSyncStore(alice, alicesCopy).length === 0 && missingFromSyncStore(bob, bobsCopy).length === 0,
        'both sync stores to hold everything their documents are made of', 30_000,
      );
    } catch { /* reported by the assertions below, with what is missing */ }
    expect(describeMissing(alice, alicesCopy)).toEqual([]);
    expect(describeMissing(bob, bobsCopy)).toEqual([]);
  });
});
