import { test, expect } from '@playwright/test';
import { waitFor } from './support/peer';
import { setupSharedDoc } from './support/scenarios';

/**
 * Revoke a user's permission on a doc: after alice revokes bob, bob's peer
 * should asynchronously lose access and have the doc pruned from its home list.
 *
 * BLOCKED (test.fixme): depends on setupSharedDoc, which can't complete until
 * direct contact-group sharing works (see friend-share.spec.ts). Re-enable once
 * the addMember global-lookup refactor lands.
 */
test.fixme('revoking a member removes their access and prunes the doc', async ({ browser }) => {
  const { alice, bob, bobGroup, docId } = await setupSharedDoc(browser, 'edit');
  try {
    // Precondition: doc is in bob's list with access.
    await waitFor(
      () => bob.call<Array<{ id: string }>>('getDocList'),
      (list) => list.some((e) => e.id === docId),
      { label: 'doc present before revoke' }
    );

    // alice revokes bob's group (key rotation for remaining members).
    await alice.call('revokeMember', bobGroup, docId);

    // bob loses access.
    await waitFor(
      () => bob.call<string | null>('getMyAccess', docId),
      (access) => access === null,
      { label: 'bob loses access', timeout: 45_000 }
    );

    // ...and the (encrypted, now-inaccessible) doc is pruned from bob's home list.
    await waitFor(
      () => bob.call<Array<{ id: string }>>('getDocList'),
      (list) => !list.some((e) => e.id === docId),
      { label: 'doc pruned from bob home list', timeout: 45_000 }
    );

    // alice still has access.
    expect(await alice.call<string | null>('getMyAccess', docId)).not.toBeNull();
  } finally {
    await alice.close();
    await bob.close();
  }
});
