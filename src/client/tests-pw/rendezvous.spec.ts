import { test, expect } from '@playwright/test';
import { newPeer, waitFor, type Peer } from './support/peer';

/**
 * Encrypted relay rendezvous: a sharer stages their (potentially large) contact
 * bundle behind a tiny {id,key}; the receiver fetches + ingests it over the relay
 * without the bundle ever touching the URL/QR.
 *
 * The exchange is bidirectional over the single rendezvous: the receiver replies
 * with its own bundle so both peers end up knowing each other from one scan — no
 * second "add me back" round-trip. Verifies both directions.
 */
test('rendezvous makes both peers contacts from a single exchange', async ({ browser }) => {
  let alice: Peer | undefined;
  let bob: Peer | undefined;
  try {
    [alice, bob] = await Promise.all([newPeer(browser, 'alice'), newPeer(browser, 'bob')]);

    // Alice stages a share and gets a tiny id+key for the QR.
    const { rendezvousId, key } = await alice.call('rendezvousCreateShare', 'Alice');
    expect(rendezvousId.length).toBeLessThan(64);
    expect(key.length).toBeLessThan(64);

    // Alice's flow now completes only once she has ingested Bob's reply: the
    // progress stream runs waiting → peer-joined → sending → receiving → received.
    const donePromise = alice.page.evaluate(
      (rid) => new Promise<string>((resolve) => {
        const off = (window as any).__drive.onRendezvousEvent((e: any) => {
          if (e.rendezvousId === rid && (e.status === 'received' || e.status === 'error')) {
            off(); resolve(e.status);
          }
        });
      }),
      rendezvousId,
    );

    // Bob receives over the rendezvous (resolves once Alice's bundle arrives) and
    // replies with his own bundle, passing his display name so Alice can label him.
    const received = await bob.call('rendezvousReceive', rendezvousId, key, 'Bob');
    expect(received.isOwnCard).toBe(false);
    expect(received.userGroupId).toBeTruthy();
    expect(received.displayName).toBe('Alice');

    expect(await donePromise).toBe('received');

    const aliceGroup = received.userGroupId!;
    const { userGroupId: bobGroup } = await bob.call('ensureUserGroup', { create: true });
    expect(bobGroup).toBeTruthy();

    // Direction 1: Bob knows Alice.
    await waitFor(
      () => bob!.call('getKnownContacts', ''),
      (list) => list.some((c: any) => c.agentId === aliceGroup),
      { label: 'bob knows alice', timeout: 30_000 },
    );

    // Direction 2: Alice knows Bob — the mutual half that used to require a second
    // QR/link exchange now happens automatically over the same rendezvous.
    await waitFor(
      () => alice!.call('getKnownContacts', ''),
      (list) => list.some((c: any) => c.agentId === bobGroup),
      { label: 'alice knows bob', timeout: 30_000 },
    );
  } finally {
    await Promise.all([alice?.close(), bob?.close()].filter(Boolean) as Promise<void>[]);
  }
});
