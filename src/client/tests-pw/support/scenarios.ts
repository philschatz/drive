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
 * Re-open a peer's page, which re-opens its relay socket and with it re-sends the
 * RELAY_WATCH declaration the relay pairs two sockets on. The only recovery when
 * a declaration went missing — nothing at the application layer can introduce two
 * sockets the relay has not matched.
 */
async function rejoinRelay(p: Peer): Promise<void> {
  await p.page.reload();
  await p.page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
  await p.page.evaluate(() => Promise.all([
    (window as any).__drive.workerReady,
    (window as any).__drive.keyhiveReady,
  ]));
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
  //
  // Polling this passively is a dead end, which is what made it flaky: `addMember`
  // is the thing that drives delivery (it persists, calls syncKeyhive, and
  // forceResyncAllPeers), so if that one round doesn't land — the relay hasn't
  // paired the two sockets yet, a sync debounce swallowed it — then nothing on
  // bob's side will ever produce the access and the wait just burns its timeout.
  // Re-issue it instead, but sparingly: each call is a real membership write, and
  // hammering it every poll would churn the group's key material.
  let lastNudge = Date.now();
  let nudges = 0;
  let rejoins = 0;
  let nudgeErr = '';
  try {
    await waitFor(
      async () => {
        const access = await bob.call('getMyAccess', docId);
        if (access?.toLowerCase() === role || Date.now() - lastNudge < 5_000) return access;
        lastNudge = Date.now();

        // Measured on a healthy share: `addMember` calls forceResyncAllPeers, and
        // both peers report a connected peer within ~200ms of it, with the access
        // landing about a second later. So BOTH still reporting none means the
        // relay never introduced the two sockets — and re-sharing cannot fix
        // that, because there is nobody to send to. It pairs on the RELAY_WATCH
        // declaration each side sends on socket open and on roster change, so a
        // reload (fresh socket, fresh declaration) is the recovery.
        const [ap, bp] = await Promise.all([
          alice.call('getConnectedPeers'), bob.call('getConnectedPeers'),
        ]);
        if (ap.length === 0 && bp.length === 0 && rejoins < 2) {
          rejoins++;
          await Promise.all([rejoinRelay(alice), rejoinRelay(bob)]);
        }

        nudges++;
        // Swallowed but RECORDED: a silent catch here collapses "alice could not
        // re-share" and "bob never received it" into the same opaque timeout,
        // which is what made this failure unreadable.
        await alice.call('addMember', bobGroup, docId, role)
          .catch((e: Error) => { nudgeErr = e.message; });
        return access;
      },
      (access) => access?.toLowerCase() === role,
      { label: `bob gains ${role} access`, timeout: 60_000 }
    );
  } catch (err) {
    throw new Error(
      `${(err as Error).message} [${nudges} re-share(s), ${rejoins} relay rejoin(s)`
      + `${nudgeErr ? `, last re-share error: ${nudgeErr}` : ', all re-shares resolved OK'}`
      + `; alice peers=${JSON.stringify(await alice.call('getConnectedPeers').catch(() => 'n/a'))}`
      + `, bob peers=${JSON.stringify(await bob.call('getConnectedPeers').catch(() => 'n/a'))}]`,
    );
  }

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
