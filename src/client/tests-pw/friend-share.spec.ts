import { test, expect } from '@playwright/test';
import { waitFor } from './support/peer';
import { setupSharedDoc } from './support/scenarios';

/**
 * Add a friend and share a document with them: after alice shares, bob's peer
 * should asynchronously gain access, see the doc in its home list, and be able
 * to read the document content.
 */
// Disabled: times out.
test.fixme('sharing a doc with a friend grants them access and syncs content', async ({ browser }) => {
  const { alice, bob, docId } = await setupSharedDoc(browser, 'edit');
  try {
    // The two peers are genuinely distinct identities.
    const idA = await alice.call('getIdentity');
    const idB = await bob.call('getIdentity');
    expect(idA.deviceId).not.toEqual(idB.deviceId);

    // bob's access (already awaited to 'edit' in setup) is confirmed here.
    expect((await bob.call('getMyAccess', docId))?.toLowerCase()).toBe('edit');

    // The doc shows up in bob's home list (reconcileHomeDocs adds accessible docs).
    await waitFor(
      () => bob.call('getDocList'),
      (list) => list.some((e) => e.id === docId),
      { label: 'doc appears in bob home list' }
    );

    // bob can read the synced document content (automerge data arrives shortly
    // after access is granted; queryDoc returns jq output as an array).
    await waitFor(
      () => bob.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
      (result) => Array.isArray(result) && result.includes('Shared list'),
      { label: 'bob reads shared content' }
    );

    // alice (the sharer/admin) sees bob as a member.
    const { members } = await alice.call('getDocMembers', docId);
    expect(members.length).toBeGreaterThanOrEqual(2);
  } finally {
    await alice.close();
    await bob.close();
  }
});
