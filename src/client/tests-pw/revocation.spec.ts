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
 * Archive a doc I was granted — the home page's "remove this from my list".
 *
 * keyhive lets a member revoke only what it has standing over, and only an
 * ADMIN of a doc has that: a reader or editor cannot revoke anything, its own
 * grant included. So what archiving does depends on the role that was shared:
 *
 *  - admin grant → bob really revokes his user-group; his access is gone.
 *  - edit grant  → keyhive is not changed at all; the doc is hidden by a local
 *    tombstone and bob's access is still there (alice can still see him, and
 *    re-sharing is detected against the tombstone's baseline).
 *
 * Either way the doc leaves bob's list and the owner is untouched.
 */
test('archiving a doc shared as admin revokes my access and leaves the owner intact', async () => {
  const { alice, bob } = pair;
  const docId = await shareNewDoc(pair, 'admin');

  await waitFor(
    () => bob.call('getDocList'),
    (list) => list.some((e) => e.id === docId),
    { label: 'doc present before self-revoke' }
  );

  // bob removes himself (revokes his own user-group from the doc).
  const { status } = await bob.call('archiveDoc', docId);
  expect(status).toBe('revoked');

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

test('archiving a doc shared as edit hides it locally: an editor has no standing to revoke', async () => {
  const { alice, bob, bobGroup } = pair;
  const docId = await shareNewDoc(pair, 'edit');

  await waitFor(
    () => bob.call('getDocList'),
    (list) => list.some((e) => e.id === docId),
    { label: 'doc present before archive' }
  );

  const { status } = await bob.call('archiveDoc', docId);
  expect(status).toBe('no-authority');

  // Hidden from bob's list…
  await waitFor(
    () => bob.call('getDocList'),
    (list) => !list.some((e) => e.id === docId),
    { label: 'doc removed from bob list' }
  );

  // …and it STAYS hidden. That is a negative, so anchor the quiet period to
  // observed sync latency: once a different doc has round-tripped alice → bob,
  // the reconcile that could have put the archived one back has had its chance.
  const controlId = await shareNewDoc(pair, 'edit', { '@type': 'TaskList', name: 'Control', tasks: {} });
  await waitForDocName(bob, controlId, 'Control');
  expect((await bob.call('getDocList')).some((e) => e.id === docId)).toBe(false);

  // Nothing changed in keyhive: bob can still open it, and alice still lists him.
  expect((await bob.call('getMyAccess', docId))?.toLowerCase()).toBe('edit');
  const members = (await alice.call('getDocMembers', docId)).members;
  expect(members.some((m) => m.agentId === bobGroup)).toBe(true);
  expect(await alice.call('getMyAccess', docId)).not.toBeNull();
});
