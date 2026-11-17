// use-devices pulls in worker-api (import.meta, a real Worker); the pure
// function under test needs none of it.
jest.mock('../worker-api');

import { deviceStatusesFromPeers } from './use-devices';

const KEY = 'tUakwkAvGgclyhSdcw0sPKbDexSAguoN204IoFttT9M=';

describe('deviceStatusesFromPeers', () => {
  it('keys a device by its agentId, whatever the peerId suffix', () => {
    const statuses = deviceStatusesFromPeers([`${KEY}-drive-e74z497r`], {});
    expect(statuses).toEqual({ [KEY]: { online: true, transport: 'relay' } });
  });

  it('reports direct when either of a device\'s two peerIds is direct', () => {
    // After a peer reloads, its old peerId can linger beside the new one. The
    // last one iterated used to win, so a direct device could read as relayed.
    const stale = `${KEY}-drive-old00000`;
    const live = `${KEY}-drive-new00000`;
    const transports = { [live]: 'direct' as const, [stale]: 'relay' as const };

    expect(deviceStatusesFromPeers([live, stale], transports)[KEY].transport).toBe('direct');
    expect(deviceStatusesFromPeers([stale, live], transports)[KEY].transport).toBe('direct');
  });

  it('leaves a device with no connected peerId out of the map (offline)', () => {
    expect(deviceStatusesFromPeers([], {})).toEqual({});
  });
});
