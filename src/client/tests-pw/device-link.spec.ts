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
