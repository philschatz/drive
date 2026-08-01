import { test, expect } from '@playwright/test';
import { waitFor } from './support/peer';
import { setupFriendPair, shareNewDoc, waitForDocName, type FriendPair } from './support/scenarios';

/**
 * The full lifecycle of shared access, all real keyhive revocation that no
 * mocked test reaches: the grant (a friend gains edit access and reads the doc),
 * the authority revoking a member, and a member revoking itself (the "archive"
 * flow). The grant half absorbed the assertions that used to live in
 * friend-share.spec.ts.
 *
 * One friend pair for all of it, with a doc per test — a revoked doc is no use
 * to the next case, and sharing the pair is what the boot cost is in.
 */
test.describe.configure({ mode: 'serial' });

let pair: FriendPair;

test.beforeAll(async ({ browser }) => {
  pair = await setupFriendPair(browser);
});

test.afterAll(async () => {
  await Promise.all([pair?.alice.close(), pair?.bob.close()]);
});

/**
 * The keyhive sync protocol only sends a peer ops it deems relevant to them, so
 * once alice revokes bob she stops considering the doc relevant to him — a revoked
 * peer is never *notified*, it is simply cut off from future syncs (and keeps its
 * last-cached view). So this asserts the achievable authority-side guarantees:
 * the revocation is applied, and a later edit by alice reaches alice but not bob.
 */
test('granting edit access lets a friend read the doc; revoking cuts them off', async () => {
  const { alice, bob, bobGroup } = pair;
  const docId = await shareNewDoc(pair, 'edit');

  // The two peers are genuinely distinct identities.
  const idA = await alice.call('getIdentity');
  const idB = await bob.call('getIdentity');
  expect(idA.deviceId).not.toEqual(idB.deviceId);

  // Precondition: bob is a member with 'edit' access and the synced content,
  // and the doc shows up in his home list; alice sees 2+ members.
  expect((await bob.call('getMyAccess', docId))?.toLowerCase()).toBe('edit');
  await waitFor(
    () => alice.call('getDocMembers', docId).then((r) => r.members),
    (members) => members.some((m) => m.agentId === bobGroup) && members.length >= 2,
    { label: 'bob is a member before revoke' }
  );
  await waitFor(
    () => bob.call('getDocList'),
    (list) => list.some((e) => e.id === docId),
    { label: 'doc appears in bob home list' }
  );
  await waitForDocName(bob, docId, 'Shared list');

  // alice revokes bob's group.
  await alice.call('revokeMember', bobGroup, docId);

  // 1. Revocation applied at the authority: alice no longer lists bob.
  await waitFor(
    () => alice.call('getDocMembers', docId).then((r) => r.members),
    (members) => !members.some((m) => m.agentId === bobGroup),
    { label: 'alice no longer lists bob', timeout: 45_000 }
  );

  // alice makes a post-revoke edit (the updater runs in-page so it can be a
  // real function for updateDoc).
  await alice.page.evaluate((id) =>
    (window as any).__drive.updateDoc(id, (d: any) => { d.name = 'After revoke'; }), docId);

  // alice sees her own edit.
  await waitFor(
    () => alice.call('queryDoc', docId, '.name').then((r) => r.result),
    (result) => result === 'After revoke',
    { label: 'alice sees her post-revoke edit' }
  );

  // 2. bob is cut off. This is a negative, so it needs a quiet period rather than
  // a poll — but anchor that period to observed sync latency instead of a flat
  // sleep: once bob has round-tripped a *different* doc with alice after the
  // revoke, the sync path is demonstrably live and the absence means something.
  const controlId = await shareNewDoc(pair, 'edit', {
    '@type': 'TaskList', name: 'Still syncing', tasks: {},
  });
  await waitForDocName(bob, controlId, 'Still syncing');

  const bobName = await bob.call('queryDoc', docId, '.name')
    .then((r) => r.result)
    .catch(() => null);
  expect(bobName).not.toBe('After revoke');
});

/**
 * Archive a doc I was granted: bob revokes his own access. bob's doc disappears
 * and access drops, while alice retains hers.
 */
test('archiving a doc drops my access but leaves the owner intact', async () => {
  const { alice, bob } = pair;
  const docId = await shareNewDoc(pair, 'edit');

  // Precondition: bob has the doc.
  await waitFor(
    () => bob.call('getDocList'),
    (list) => list.some((e) => e.id === docId),
    { label: 'doc present before self-revoke' }
  );

  // bob removes himself (revokes his own user-group from the doc).
  await bob.call('archiveDoc', docId);

  // bob no longer has the doc in his list, and his access is gone.
  await waitFor(
    () => bob.call('getDocList'),
    (list) => !list.some((e) => e.id === docId),
    { label: 'doc removed from bob list' }
  );
  await waitFor(
    () => bob.call('getMyAccess', docId),
    (access) => access === null,
    { label: 'bob self-revoked access', timeout: 45_000 }
  );

  // alice still owns/accesses the doc (queryDoc returns jq output as an array).
  expect(await alice.call('getMyAccess', docId)).not.toBeNull();
  expect((await alice.call('queryDoc', docId, '.name')).result).toContain('Shared list');
});
