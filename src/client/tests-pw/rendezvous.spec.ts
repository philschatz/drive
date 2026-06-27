import { test, expect } from '@playwright/test';
import { newPeer, waitFor, type Peer } from './support/peer';

/**
 * Encrypted relay rendezvous: a sharer stages their (potentially large) contact
 * bundle behind a tiny {id,key}; the receiver fetches + ingests it over the relay
 * without the bundle ever touching the URL/QR. Verifies the receiver ends up with
 * the sharer as a known contact, and that the sharer is notified the payload sent.
 */
test('rendezvous transfers a contact without embedding it in a URL', async ({ browser }) => {
  let alice: Peer | undefined;
  let bob: Peer | undefined;
  try {
    [alice, bob] = await Promise.all([newPeer(browser, 'alice'), newPeer(browser, 'bob')]);

    // Alice stages a share and gets a tiny id+key for the QR.
    const { rendezvousId, key } = await alice.call('rendezvousCreateShare', 'Alice');
    expect(rendezvousId.length).toBeLessThan(64);
    expect(key.length).toBeLessThan(64);

    // Alice should be told when the payload has been sent. The worker now emits a
    // richer progress stream (waiting → peer-joined → sending → sent), so wait for
    // the terminal status rather than the first event.
    const sentPromise = alice.page.evaluate(
      (rid) => new Promise<string>((resolve) => {
        const off = (window as any).__drive.onRendezvousEvent((e: any) => {
          if (e.rendezvousId === rid && (e.status === 'sent' || e.status === 'error')) {
            off(); resolve(e.status);
          }
        });
      }),
      rendezvousId,
    );

    // Bob receives over the rendezvous (resolves once Alice's bundle arrives).
    const received = await bob.call('rendezvousReceive', rendezvousId, key);
    expect(received.isOwnCard).toBe(false);
    expect(received.userGroupId).toBeTruthy();
    expect(received.displayName).toBe('Alice');

    expect(await sentPromise).toBe('sent');

    // Bob now knows Alice as a contact (the thing that was broken in the UI).
    const aliceGroup = received.userGroupId!;
    const contacts = await waitFor(
      () => bob!.call('getKnownContacts', ''),
      (list) => list.some((c: any) => c.agentId === aliceGroup),
      { label: 'bob knows alice', timeout: 30_000 },
    );
    expect(contacts.some((c: any) => c.agentId === aliceGroup)).toBe(true);
  } finally {
    await Promise.all([alice?.close(), bob?.close()].filter(Boolean) as Promise<void>[]);
  }
});
