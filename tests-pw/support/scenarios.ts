import type { Browser } from '@playwright/test';
import { newPeer, waitFor, type Peer } from './peer';

export interface SharedDocSetup {
  alice: Peer;
  bob: Peer;
  aliceGroup: string;
  bobGroup: string;
  docId: string;
}

/**
 * Build the common starting state for the sharing/revocation specs:
 *   - two separate identities (alice, bob), each with a personal user-group
 *   - they add each other as friends (exchange contact cards)
 *   - alice creates a TaskList doc and shares it with bob's group at `role`
 *   - waits until bob's peer actually has `role` access (eventual sync)
 */
export async function setupSharedDoc(
  browser: Browser,
  role: 'read' | 'edit' | 'admin' = 'edit'
): Promise<SharedDocSetup> {
  const alice = await newPeer(browser, 'alice');
  const bob = await newPeer(browser, 'bob');

  const aliceGroup = (await alice.call<{ userGroupId: string }>('ensureUserGroup', { create: true })).userGroupId;
  const bobGroup = (await bob.call<{ userGroupId: string }>('ensureUserGroup', { create: true })).userGroupId;

  const aliceCard = await alice.call<string>('getContactCard');
  const bobCard = await bob.call<string>('getContactCard');

  // Add each other as friends (the group id is what makes a contact shareable).
  await alice.call('receiveContactCard', bobCard, { userGroupId: bobGroup });
  await bob.call('receiveContactCard', aliceCard, { userGroupId: aliceGroup });

  const { docId } = await alice.call<{ docId: string }>('createDoc', {
    '@type': 'TaskList',
    name: 'Shared list',
    tasks: {},
  });

  // Sharing with a contact's group requires that group's ops to have synced to
  // alice over the relay (alice only has bob's *individual* card so far). The
  // group propagates within a few keyhive sync rounds; addMember itself doesn't
  // wait, so retry until it resolves (each attempt triggers a keyhive sync).
  await waitFor(
    async () => {
      try {
        await alice.call('addMember', bobGroup, docId, role);
        return true;
      } catch (err) {
        if (/Agent not found/.test((err as Error).message)) return false;
        throw err;
      }
    },
    (ok) => ok === true,
    { label: 'alice shares with bob group', timeout: 60_000, interval: 3_000 }
  );

  // Wait for the membership op + key material to reach bob.
  await waitFor(
    () => bob.call<string | null>('getMyAccess', docId),
    (access) => access?.toLowerCase() === role,
    { label: `bob gains ${role} access`, timeout: 45_000 }
  );

  return { alice, bob, aliceGroup, bobGroup, docId };
}
