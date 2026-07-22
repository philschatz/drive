import { test, expect } from '@playwright/test';
import { waitFor } from './support/peer';
import { setupSharedDoc } from './support/scenarios';

/**
 * Archive a doc I was granted: bob revokes his own access (the "archive-doc"
 * flow). bob's doc disappears and access drops, while alice retains access.
 */
test('archiving a doc drops my access but leaves the owner intact', async ({ browser }) => {
  const { alice, bob, docId } = await setupSharedDoc(browser, 'edit');
  try {
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
  } finally {
    await alice.close();
    await bob.close();
  }
});
