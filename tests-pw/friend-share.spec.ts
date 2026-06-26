import { test, expect } from '@playwright/test';
import { waitFor } from './support/peer';
import { setupSharedDoc } from './support/scenarios';

/**
 * Add a friend and share a document with them: after alice shares, bob's peer
 * should asynchronously gain access, see the doc in its home list, and be able
 * to read the document content.
 *
 * BLOCKED (test.fixme): direct contact-group sharing isn't functional in the
 * current code. `addMember` → `resolveShareAgent` (keyhive-ops.ts) only resolves
 * a group this peer already holds or an existing doc member — there is no global
 * `kh.getAgent()` lookup, and a contact's personal user-group never syncs to a
 * non-member. This is the "addMember global lookup" refactor (see plan
 * rustling-noodling-snowglobe.md). Re-enable (test → test) once that lands.
 */
test.fixme('sharing a doc with a friend grants them access and syncs content', async ({ browser }) => {
  const { alice, bob, docId } = await setupSharedDoc(browser, 'edit');
  try {
    // The two peers are genuinely distinct identities.
    const idA = await alice.call<{ deviceId: string }>('getIdentity');
    const idB = await bob.call<{ deviceId: string }>('getIdentity');
    expect(idA.deviceId).not.toEqual(idB.deviceId);

    // bob's access (already awaited to 'edit' in setup) is confirmed here.
    expect((await bob.call<string | null>('getMyAccess', docId))?.toLowerCase()).toBe('edit');

    // The doc shows up in bob's home list (reconcileHomeDocs adds accessible docs).
    await waitFor(
      () => bob.call<Array<{ id: string }>>('getDocList'),
      (list) => list.some((e) => e.id === docId),
      { label: 'doc appears in bob home list' }
    );

    // bob can read the synced document content.
    const res = await bob.call<{ result: any }>('queryDoc', docId, '.name');
    expect(res.result).toBe('Shared list');

    // alice (the sharer/admin) sees bob as a member.
    const { members } = await alice.call<{ members: Array<{ agentId: string }> }>('getDocMembers', docId);
    expect(members.length).toBeGreaterThanOrEqual(2);
  } finally {
    await alice.close();
    await bob.close();
  }
});
