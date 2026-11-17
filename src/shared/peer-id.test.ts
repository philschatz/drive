import { agentIdOfPeerId, newestPeerPerAgent } from './peer-id';

const KEY = 'tUakwkAvGgclyhSdcw0sPKbDexSAguoN204IoFttT9M=';

describe('agentIdOfPeerId', () => {
  it('is the base64 verifying key in front of the first "-"', () => {
    expect(agentIdOfPeerId(`${KEY}-drive`)).toBe(KEY);
  });

  it('ignores the per-boot random component the bridge appends', () => {
    // automerge-repo-keyhive >= 0.4 builds `<key>-<label>-<8 random chars>`,
    // new on every engine boot, so only the prefix identifies the device.
    expect(agentIdOfPeerId(`${KEY}-drive-e74z497r`)).toBe(KEY);
    expect(agentIdOfPeerId(`${KEY}-caldav-server-9nimq520`)).toBe(KEY);
  });

  it('returns a bare id unchanged (the relay has no suffix)', () => {
    expect(agentIdOfPeerId(KEY)).toBe(KEY);
  });
});

describe('newestPeerPerAgent', () => {
  it('keeps one peerId per device: the most recently seen', () => {
    // A peer that reloads comes back under a new peerId while its old one is
    // still inside the presence stale window; only the new one is the device.
    const lastSeen = new Map([
      [`${KEY}-drive-old00000`, 1000],
      [`${KEY}-drive-new00000`, 5000],
      ['OTHERKEY=-drive-aaaaaaaa', 2000],
    ]);
    const kept = newestPeerPerAgent(lastSeen.keys(), lastSeen);
    expect([...kept].sort()).toEqual(['OTHERKEY=-drive-aaaaaaaa', `${KEY}-drive-new00000`].sort());
  });

  it('only considers the peers it is given (already-stale ids stay out)', () => {
    const lastSeen = new Map([
      [`${KEY}-drive-old00000`, 9000],
      [`${KEY}-drive-new00000`, 5000],
    ]);
    // The caller passes the fresh set; an id not in it can never be picked,
    // even if its lastSeen is newer.
    expect([...newestPeerPerAgent([`${KEY}-drive-new00000`], lastSeen)]).toEqual([`${KEY}-drive-new00000`]);
  });

  it('is a no-op when every device has a single peerId', () => {
    const lastSeen = new Map([['A=-drive', 1], ['B=-drive', 2]]);
    expect([...newestPeerPerAgent(lastSeen.keys(), lastSeen)].sort()).toEqual(['A=-drive', 'B=-drive']);
  });
});
