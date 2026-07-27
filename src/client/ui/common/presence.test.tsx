// Mock worker-api (presence.tsx imports it; the real module spins up a Worker).
jest.mock('../worker-api', () => ({
  subscribePresence: jest.fn(() => () => {}),
  setPresence: jest.fn(),
  usePeerTransports: jest.fn(() => ({})),
}));

import { renderHook, act } from '@testing-library/preact';
import { peerIdentityKey, peerDisplayName, peerColor, usePresence, type PresenceState } from './presence';
import { subscribePresence, setPresence } from '../worker-api';
import { applyFriendNamesFromWorker, getFriendName } from '../friend-names';

// A peerId is `<base64-device-verifying-key>-<suffix>`; base64 never contains '-',
// so device A and device B of the same user have different peerIds but share a group.
const GROUP = 'dXNlci1ncm91cC1pZA=='; // base64-ish user-group id
const PEER_A = 'AAAAdeviceKeyA=-drive';
const PEER_B = 'BBBBdeviceKeyB=-drive';

describe('presence identity helpers', () => {
  beforeEach(() => {
    applyFriendNamesFromWorker({});
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
      applyFriendNamesFromWorker({ [GROUP]: 'Alice' });
      // Same contact name regardless of which device sent the presence.
      expect(peerDisplayName(PEER_A, GROUP)).toBe('Alice');
      expect(peerDisplayName(PEER_B, GROUP)).toBe('Alice');
    });

    it('does NOT resolve when looking up by the device agentId (the old bug)', () => {
      applyFriendNamesFromWorker({ [GROUP]: 'Alice' });
      // contact-names is keyed by group id, so an agentId lookup misses → hash fallback.
      expect(getFriendName('AAAAdeviceKeyA=')).toBeUndefined();
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

describe('usePresence', () => {
  const mockSubscribe = subscribePresence as jest.Mock;
  const mockSetPresence = setPresence as jest.Mock;
  let lastCallback: ((states: any) => void) | null;
  let unsubscribe: jest.Mock;

  const peerState = (peerId: string, value: Partial<PresenceState> | undefined) =>
    ({ peerId, lastActiveAt: 1, lastUpdateAt: 1, value });

  beforeEach(() => {
    jest.clearAllMocks();
    lastCallback = null;
    unsubscribe = jest.fn();
    mockSubscribe.mockImplementation((_docId: string, cb: (states: any) => void) => {
      lastCallback = cb;
      return unsubscribe;
    });
  });

  it('subscribes once per docId and broadcasts the initial state', () => {
    renderHook(() => usePresence('doc-1'));
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscribe.mock.calls[0][0]).toBe('doc-1');
    expect(mockSetPresence).toHaveBeenCalledWith('doc-1', { viewing: true, focusedField: null });
  });

  it('does nothing for a falsy docId', () => {
    const { result } = renderHook(() => usePresence(undefined));
    expect(mockSubscribe).not.toHaveBeenCalled();
    act(() => result.current.broadcast('viewing', false));
    expect(mockSetPresence).not.toHaveBeenCalled();
    expect(result.current.peers).toEqual({});
  });

  it('populates peers from worker emissions and filters peerList on viewing', () => {
    const { result } = renderHook(() => usePresence('doc-1'));
    const states = {
      [PEER_A]: peerState(PEER_A, { viewing: true, focusedField: null }),
      [PEER_B]: peerState(PEER_B, { viewing: false, focusedField: null }),
      'CCCC=-drive': peerState('CCCC=-drive', undefined), // heartbeat-first, valueless
    };
    act(() => lastCallback!(states));
    expect(result.current.peers).toEqual(states);
    expect(result.current.peerList).toEqual([states[PEER_A]]);
  });

  it('broadcast forwards a single-channel patch to setPresence', () => {
    const { result } = renderHook(() => usePresence('doc-1'));
    act(() => result.current.broadcast('focusedField', ['tasks', 't1']));
    expect(mockSetPresence).toHaveBeenLastCalledWith('doc-1', { focusedField: ['tasks', 't1'] });
  });

  it('fires onRawUpdate on every emission', () => {
    const onRawUpdate = jest.fn();
    renderHook(() => usePresence('doc-1', { onRawUpdate }));
    const states = { [PEER_A]: peerState(PEER_A, { viewing: true, focusedField: null }) };
    act(() => lastCallback!(states));
    act(() => lastCallback!({}));
    expect(onRawUpdate).toHaveBeenNthCalledWith(1, states);
    expect(onRawUpdate).toHaveBeenNthCalledWith(2, {});
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => usePresence('doc-1'));
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('resubscribes and resets peers when docId changes', () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => usePresence(id), {
      initialProps: { id: 'doc-1' },
    });
    act(() => lastCallback!({ [PEER_A]: peerState(PEER_A, { viewing: true, focusedField: null }) }));
    expect(result.current.peerList).toHaveLength(1);

    rerender({ id: 'doc-2' });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenLastCalledWith('doc-2', expect.any(Function));
    expect(result.current.peers).toEqual({});
  });
});
