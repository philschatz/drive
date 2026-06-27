import { test, expect } from '@playwright/test';
import { newPeer, waitFor, type Peer } from './support/peer';

/**
 * Add a new device: link a second, fresh device into the same identity so both
 * devices share one user-group. Mirrors the two-leg handshake in LinkDevicePage.
 */
test('linking a new device converges both devices onto one user-group', async ({ browser }) => {
  let deviceA: Peer | undefined;
  let deviceB: Peer | undefined;
  try {
    deviceA = await newPeer(browser, 'deviceA');
    deviceB = await newPeer(browser, 'deviceB');

    // Sanity: two fully-isolated profiles = two distinct devices.
    const idA = await deviceA.call('getIdentity');
    const idB = await deviceB.call('getIdentity');
    expect(idA.deviceId).not.toEqual(idB.deviceId);

    // Device A is the original device with an established group.
    const a = await deviceA.call('getLinkPayload');
    expect(a.userGroupId).toBeTruthy();

    // --- Leg 1: on the NEW device, receive A's card and adopt its group ---
    const recvA = await deviceB.call('receiveContactCard', a.card, { isDevice: true });
    const leg1 = await deviceB.call(
      'linkDevice',
      recvA.agentId,
      a.userGroupId
    );
    expect(leg1.linked).toBe(false); // new device isn't a group member yet

    // --- Leg 2: back on the ORIGINAL device, receive B's card and add it ---
    const b = await deviceB.call('getLinkPayload');
    const recvB = await deviceA.call('receiveContactCard', b.card, { isDevice: true });
    const leg2 = await deviceA.call(
      'linkDevice',
      recvB.agentId,
      b.userGroupId
    );
    expect(leg2.linked).toBe(true); // handshake complete

    // Both devices now report the same user-group.
    await waitFor(
      () => deviceB!.call('getIdentity'),
      (id) => id.userGroupId === a.userGroupId,
      { label: 'deviceB adopts shared group' }
    );

    // Both devices appear in each device's device list.
    await waitFor(
      () => deviceA!.call('listDevices'),
      (devices) => devices.length >= 2,
      { label: 'deviceA sees both devices' }
    );
    await waitFor(
      () => deviceB!.call('listDevices'),
      (devices) => devices.length >= 2,
      { label: 'deviceB sees both devices' }
    );
  } finally {
    await deviceA?.close();
    await deviceB?.close();
  }
});

/**
 * Same convergence, but via the encrypted relay rendezvous (a single tiny QR, no
 * card embedded in the URL) — what the "Invite Another Device" UI now uses.
 */
test('linking a new device via rendezvous converges both onto one user-group', async ({ browser }) => {
  let deviceA: Peer | undefined;
  let deviceB: Peer | undefined;
  try {
    [deviceA, deviceB] = await Promise.all([newPeer(browser, 'deviceA'), newPeer(browser, 'deviceB')]);

    // Device A (original) creates the rendezvous and gets a tiny id+key for the QR.
    const a = await deviceA.call('getLinkPayload');
    expect(a.userGroupId).toBeTruthy();
    const { rendezvousId, key } = await deviceA.call('rendezvousCreateDeviceLink');
    expect(rendezvousId.length).toBeLessThan(64);
    expect(key.length).toBeLessThan(64);

    // A is notified once the handshake completes. The worker now emits a richer
    // progress stream (waiting → peer-joined → sending → … → linked), so wait for
    // the terminal status rather than the first event.
    const linkedPromise = deviceA.page.evaluate(
      (rid) => new Promise<string>((resolve) => {
        const off = (window as any).__drive.onRendezvousEvent((e: any) => {
          if (e.rendezvousId === rid && (e.status === 'linked' || e.status === 'error')) {
            off(); resolve(e.status);
          }
        });
      }),
      rendezvousId,
    );

    // Device B (new) joins via the same id+key (what opening the link does).
    await deviceB.call('rendezvousJoinDeviceLink', rendezvousId, key);
    expect(await linkedPromise).toBe('linked');

    // Both devices converge onto A's user-group and see each other.
    await waitFor(
      () => deviceB!.call('getIdentity'),
      (id) => id.userGroupId === a.userGroupId,
      { label: 'deviceB adopts shared group' },
    );
    await waitFor(
      () => deviceA!.call('listDevices'),
      (devices) => devices.length >= 2,
      { label: 'deviceA sees both devices' },
    );
    await waitFor(
      () => deviceB!.call('listDevices'),
      (devices) => devices.length >= 2,
      { label: 'deviceB sees both devices' },
    );
  } finally {
    await deviceA?.close();
    await deviceB?.close();
  }
});
