// Mock worker-api (presence.tsx imports it; the real module spins up a Worker).
jest.mock('../worker-api', () => ({
  subscribePresence: jest.fn(() => () => {}),
  setPresence: jest.fn(),
  usePeerTransports: jest.fn(() => ({})),
}));

import { peerIdentityKey, peerDisplayName, peerColor } from './presence';
import { applyContactNamesFromWorker, getContactName } from '../contact-names';

// A peerId is `<base64-device-verifying-key>-<suffix>`; base64 never contains '-',
// so device A and device B of the same user have different peerIds but share a group.
const GROUP = 'dXNlci1ncm91cC1pZA=='; // base64-ish user-group id
const PEER_A = 'AAAAdeviceKeyA=-drive';
const PEER_B = 'BBBBdeviceKeyB=-drive';

describe('presence identity helpers', () => {
  beforeEach(() => {
    applyContactNamesFromWorker({});
  });

  describe('peerIdentityKey', () => {
    it('prefers the user-group id when present', () => {
      expect(peerIdentityKey(PEER_A, GROUP)).toBe(GROUP);
    });

    it('falls back to the per-device agentId (peerId prefix) without a group', () => {
      expect(peerIdentityKey(PEER_A)).toBe('AAAAdeviceKeyA=');
      expect(peerIdentityKey(PEER_A, null)).toBe('AAAAdeviceKeyA=');
    });
  });

  describe('peerDisplayName', () => {
    it('resolves a contact name via the user-group id (how contact-names is keyed)', () => {
      applyContactNamesFromWorker({ [GROUP]: 'Alice' });
      // Same contact name regardless of which device sent the presence.
      expect(peerDisplayName(PEER_A, GROUP)).toBe('Alice');
      expect(peerDisplayName(PEER_B, GROUP)).toBe('Alice');
    });

    it('does NOT resolve when looking up by the device agentId (the old bug)', () => {
      applyContactNamesFromWorker({ [GROUP]: 'Alice' });
      // contact-names is keyed by group id, so an agentId lookup misses → hash fallback.
      expect(getContactName('AAAAdeviceKeyA=')).toBeUndefined();
      expect(peerDisplayName(PEER_A)).not.toBe('Alice');
    });

    it('falls back to a short hash when the identity is unknown', () => {
      expect(peerDisplayName(PEER_A, GROUP)).toBe(`${GROUP.slice(0, 8)}…`);
    });
  });

  describe('peerColor', () => {
    it('is stable across a user’s devices (same group ⇒ same color)', () => {
      expect(peerColor(PEER_A, GROUP)).toBe(peerColor(PEER_B, GROUP));
    });

    it('returns a color from the palette', () => {
      expect(peerColor(PEER_A, GROUP)).toMatch(/^#[0-9a-f]{6}$/);
    });
  });
});
