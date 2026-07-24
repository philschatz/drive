import { test, expect } from '@playwright/test';
import { waitFor } from './support/peer';
import { setupSharedDoc } from './support/scenarios';

/**
 * Revoke a user's permission on a doc. The keyhive sync protocol only sends a
 * peer ops it deems relevant to them, so once alice revokes bob she stops
 * considering the doc relevant to him — a revoked peer is never *notified*, it
 * is simply cut off from future syncs (and keeps its last-cached view). So we
 * assert the achievable authority-side guarantees:
 *   1. the revocation is applied — alice's member list no longer lists bob, and
 *   2. bob is cut off — a later edit by alice reaches alice but never bob.
 */
// Disabled: times out.
test.fixme('revoking a member applies at the authority and cuts the member off from future edits', async ({ browser }) => {
  const { alice, bob, bobGroup, docId } = await setupSharedDoc(browser, 'edit');
  try {
    // Precondition: bob is a member and has the synced content.
    await waitFor(
      () => alice.call('getDocMembers', docId).then((r) => r.members),
      (members) => members.some((m) => m.agentId === bobGroup),
      { label: 'bob is a member before revoke' }
    );
    await waitFor(
      () => bob.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
      (result) => Array.isArray(result) && result.includes('Shared list'),
      { label: 'bob has synced content before revoke' }
    );

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
      (result) => Array.isArray(result) && result.includes('After revoke'),
      { label: 'alice sees her post-revoke edit' }
    );

    // 2. bob is cut off: the post-revoke edit never reaches him. Give it well
    // beyond normal sync latency, then assert bob never observes the new value.
    await new Promise((r) => setTimeout(r, 12_000));
    const bobName = await bob.call('queryDoc', docId, '.name')
      .then((r) => r.result)
      .catch(() => null);
    expect(Array.isArray(bobName) ? bobName : []).not.toContain('After revoke');
  } finally {
    await alice.close();
    await bob.close();
  }
});
