import { test, expect } from '@playwright/test';
import { newPeer, waitFor, type Peer } from './support/peer';
import { setupSharedDoc } from './support/scenarios';

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
 * Device names are exchanged both ways during the link rendezvous: each device
 * passes its own name in, and afterwards each device's device-name store holds
 * the OTHER device's name keyed by that device's agentId.
 */
test('linking a new device exchanges device names both ways', async ({ browser }) => {
  let deviceA: Peer | undefined;
  let deviceB: Peer | undefined;
  try {
    [deviceA, deviceB] = await Promise.all([newPeer(browser, 'deviceA'), newPeer(browser, 'deviceB')]);

    const idA = await deviceA.call('getIdentity');
    const idB = await deviceB.call('getIdentity');

    const NAME_A = '💻 Laptop A';
    const NAME_B = '📱 Phone B';

    // A (original) creates the rendezvous, passing its own device name.
    const { rendezvousId, key } = await deviceA.call('rendezvousCreateDeviceLink', NAME_A);
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

    // B (new) joins, passing its own device name.
    await deviceB.call('rendezvousJoinDeviceLink', rendezvousId, key, NAME_B);
    expect(await linkedPromise).toBe('linked');

    // A learned B's name (keyed by B's agentId) …
    await waitFor(
      () => deviceA!.call('getAllDeviceNames'),
      (names) => names[idB.agentId] === NAME_B,
      { label: 'deviceA learns deviceB name' },
    );
    // … and B learned A's name (keyed by A's agentId).
    await waitFor(
      () => deviceB!.call('getAllDeviceNames'),
      (names) => names[idA.agentId] === NAME_A,
      { label: 'deviceB learns deviceA name' },
    );

    // And the Settings device list renders the learned name in an editable field
    // (deviceA sees "Phone B" as an input value — every device row is editable).
    await deviceA.page.evaluate(() => { location.hash = '#/settings'; });
    await expect
      .poll(
        () => deviceA!.page.getByRole('textbox').evaluateAll(
          (els) => els.map((e) => (e as HTMLInputElement).value),
        ),
        { timeout: 15_000 },
      )
      .toContain(NAME_B);

    // A remote device row is editable: relabelling deviceB from deviceA's Settings
    // persists locally (the reported gap — other devices used to be read-only).
    const RENAMED_B = "Bob's phone";
    const bInput = deviceA.page.getByTitle(idB.agentId);
    await bInput.fill(RENAMED_B);
    await bInput.blur();
    await waitFor(
      () => deviceA!.call('getAllDeviceNames'),
      (names) => names[idB.agentId] === RENAMED_B,
      { label: 'deviceA relabels deviceB locally' },
    );

    // Device names must survive a reload: the worker seeds the main-thread cache
    // from IndexedDB on startup (else the field would fall back to a placeholder).
    await deviceA.page.goto('/');
    await deviceA.page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
    await deviceA.page.evaluate(() =>
      Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady]),
    );
    await waitFor(
      () => deviceA!.call('getAllDeviceNames'),
      (names) => names[idB.agentId] === RENAMED_B,
      { label: 'deviceA device name persists across reload' },
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

    // The device list marks a device online when the peer list contains its
    // peerId (`<agentId>-drive`) — assert that source signal from each side.
    const idB = await deviceB.call('getIdentity');
    const idA = await deviceA.call('getIdentity');
    await waitFor(
      () => deviceA!.call('getConnectedPeers'),
      (peers) => peers.includes(`${idB.agentId}-drive`),
      { label: 'deviceA sees deviceB online' },
    );
    await waitFor(
      () => deviceB!.call('getConnectedPeers'),
      (peers) => peers.includes(`${idA.agentId}-drive`),
      { label: 'deviceB sees deviceA online' },
    );

    // …and the Settings device list renders it: deviceB's row shows "Online".
    await deviceA.page.evaluate(() => { location.hash = '#/settings'; });
    await expect(deviceA.page.getByText(/^Online/).first()).toBeVisible({ timeout: 15_000 });

    // Disconnect deviceB entirely: the relay broadcasts a leave, deviceA's
    // worker translates it into peer-disconnected, and the row flips to Offline.
    await deviceB.close();
    deviceB = undefined;
    await waitFor(
      () => deviceA!.call('getConnectedPeers'),
      (peers) => !peers.includes(`${idB.agentId}-drive`),
      { label: 'deviceA drops the departed deviceB' },
    );
    await expect(deviceA.page.getByText('Offline').first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await deviceA?.close();
    await deviceB?.close();
  }
});

/**
 * Regression: a doc SHARED WITH the original device by a friend (access via
 * user-group membership, not authored locally) should also reach a newly linked
 * device once it adopts the shared group.
 */
test('a newly linked device loads a friend-shared document', async ({ browser }) => {
  let bob2: Peer | undefined;
  const { alice, bob, bobGroup, docId } = await setupSharedDoc(browser, 'edit');
  try {
    // bob (already has edit access to alice's doc) links a second device.
    bob2 = await newPeer(browser, 'bob2');
    const { rendezvousId, key } = await bob.call('rendezvousCreateDeviceLink');
    const linkedPromise = bob.page.evaluate(
      (rid) => new Promise<string>((resolve) => {
        const off = (window as any).__drive.onRendezvousEvent((e: any) => {
          if (e.rendezvousId === rid && (e.status === 'linked' || e.status === 'error')) {
            off(); resolve(e.status);
          }
        });
      }),
      rendezvousId,
    );
    await bob2.call('rendezvousJoinDeviceLink', rendezvousId, key);
    expect(await linkedPromise).toBe('linked');

    await waitFor(
      () => bob2!.call('getIdentity'),
      (id) => id.userGroupId === bobGroup,
      { label: 'bob2 adopts bob\'s group' },
    );

    // The friend-shared doc must reach bob's second device.
    await waitFor(
      () => bob2!.call('getDocList'),
      (list) => list.some((e) => e.id === docId),
      { label: 'bob2 loads the friend-shared doc', timeout: 45_000 },
    );
  } finally {
    await alice.close();
    await bob.close();
    await bob2?.close();
  }
});

/**
 * Regression: a newly linked device should load the ORIGINAL device's whole
 * library. The original's user-group administers its docs; once the new device
 * adopts that group, reconcileHomeDocs must surface those docs in its home list.
 */
test('a newly linked device loads the original device\'s documents', async ({ browser }) => {
  let deviceA: Peer | undefined;
  let deviceB: Peer | undefined;
  try {
    [deviceA, deviceB] = await Promise.all([newPeer(browser, 'deviceA'), newPeer(browser, 'deviceB')]);

    // Device A (original) has an established group and a document in its library.
    await deviceA.call('ensureUserGroup', { create: true });
    const { docId } = await deviceA.call('createDoc', {
      '@type': 'TaskList',
      name: 'My list',
      tasks: {},
    });
    const a = await deviceA.call('getLinkPayload');
    expect(a.userGroupId).toBeTruthy();

    // Link device B via the encrypted rendezvous (what the UI does).
    const { rendezvousId, key } = await deviceA.call('rendezvousCreateDeviceLink');
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
    await deviceB.call('rendezvousJoinDeviceLink', rendezvousId, key);
    expect(await linkedPromise).toBe('linked');

    await waitFor(
      () => deviceB!.call('getIdentity'),
      (id) => id.userGroupId === a.userGroupId,
      { label: 'deviceB adopts shared group' },
    );

    // The original device's document must appear in the new device's home list.
    await waitFor(
      () => deviceB!.call('getDocList'),
      (list) => list.some((e) => e.id === docId),
      { label: 'deviceB loads the original device\'s doc', timeout: 45_000 },
    );

    // …and its content must actually sync (not just be listed-but-unavailable).
    await waitFor(
      () => deviceB!.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
      (result) => Array.isArray(result) && result.includes('My list'),
      { label: 'deviceB reads the synced doc content', timeout: 45_000 },
    );

    // Reopen device B (close & reopen the app): docs must still load on a fresh
    // worker init — the startup path, gated by findDanglingUserGroup, must not
    // skip reconcile for a legitimately-adopted group.
    await deviceB.page.goto('/');
    await deviceB.page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
    await deviceB.page.evaluate(() =>
      Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady])
    );
    await waitFor(
      () => deviceB!.call('getDocList'),
      (list) => list.some((e) => e.id === docId),
      { label: 'deviceB still has the doc after reopen', timeout: 45_000 },
    );
  } finally {
    await deviceA?.close();
    await deviceB?.close();
  }
});
