import type { Browser } from '@playwright/test';
import { newPeer, waitFor, type Peer } from './peer';

export interface FriendPair {
  alice: Peer;
  bob: Peer;
  aliceGroup: string;
  bobGroup: string;
}

export interface SharedDocSetup extends FriendPair {
  docId: string;
}

/**
 * Two separate identities who have added each other as friends: the boot every
 * two-peer spec starts from, and the expensive part of one — two browser contexts,
 * two keyhive inits, and a contact exchange.
 *
 * Split out from setupSharedDoc so a spec with several scenarios can pay for it
 * once in `beforeAll` and then call `shareNewDoc` per test.
 */
export async function setupFriendPair(browser: Browser): Promise<FriendPair> {
  const alice = await newPeer(browser, 'alice');
  const bob = await newPeer(browser, 'bob');

  // `ensureUserGroup({ create: true })` always mints an id, so userGroupId is non-null here.
  const aliceGroup = (await alice.call('ensureUserGroup', { create: true })).userGroupId!;
  const bobGroup = (await bob.call('ensureUserGroup', { create: true })).userGroupId!;

  const aliceCard = await alice.call('getContactCard');
  const bobCard = await bob.call('getContactCard');

  // Add each other as friends (the group id is what makes a contact shareable).
  await alice.call('receiveContactCard', bobCard, { userGroupId: bobGroup });
  await bob.call('receiveContactCard', aliceCard, { userGroupId: aliceGroup });

  return { alice, bob, aliceGroup, bobGroup };
}

/**
 * Alice creates a doc and shares it with bob's group at `role`, resolving once bob
 * actually has that access. Returns the new docId.
 */
export async function shareNewDoc(
  pair: FriendPair,
  role: 'read' | 'edit' | 'admin' = 'edit',
  initialDoc?: Record<string, unknown>,
): Promise<string> {
  const { alice, bob, bobGroup } = pair;
  const { docId } = await alice.call('createDoc', initialDoc ?? {
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
    // Poll briskly: each attempt triggers a keyhive sync round, and with the
    // test build's short syncRequestInterval the group ops arrive in well under a
    // second — the old 3s interval just added dead time between rounds.
    { label: 'alice shares with bob group', timeout: 60_000, interval: 500 }
  );

  // Wait for the membership op + key material to reach bob.
  await waitFor(
    () => bob.call('getMyAccess', docId),
    (access) => access?.toLowerCase() === role,
    { label: `bob gains ${role} access`, timeout: 45_000 }
  );

  return docId;
}

/**
 * Build the common starting state for the sharing/revocation specs: a friend pair
 * plus one doc alice has shared with bob at `role`.
 */
export async function setupSharedDoc(
  browser: Browser,
  role: 'read' | 'edit' | 'admin' = 'edit',
  initialDoc?: Record<string, unknown>,
): Promise<SharedDocSetup> {
  const pair = await setupFriendPair(browser);
  const docId = await shareNewDoc(pair, role, initialDoc);
  return { ...pair, docId };
}

/** Wait until `peer` can read the doc's name, i.e. it has synced and decrypts. */
export async function waitForDocName(peer: Peer, docId: string, name: string): Promise<void> {
  await waitFor(
    () => peer.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
    (r) => r === name,
    { label: `${peer.name} loads ${JSON.stringify(name)}`, timeout: 45_000 }
  );
}
