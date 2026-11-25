// Mock worker-api (presence.tsx imports it; the real module spins up a Worker).
jest.mock('../worker-api', () => ({
  subscribePresence: jest.fn(() => () => {}),
  setPresence: jest.fn(),
  usePeerTransports: jest.fn(() => ({})),
}));

import { render, renderHook, act } from '@testing-library/preact';
import {
  peerIdentityKey, peerDisplayName, peerColor, usePresence, useFocusPath, usePeersAt, ViewingPresence,
  type FocusLayer, type FocusPath, type PresenceState,
} from './presence';
import { subscribePresence, setPresence } from '../worker-api';
import { applyFriendNamesFromWorker, getFriendName } from '../friend-names';
import { applyDeviceNamesFromWorker } from '../device-names';

// A peerId is `<base64-device-verifying-key>-<suffix>`; base64 never contains '-',
// so device A and device B of the same user have different peerIds but share a group.
const GROUP = 'dXNlci1ncm91cC1pZA=='; // base64-ish user-group id
const PEER_A = 'AAAAdeviceKeyA=-drive';
const PEER_B = 'BBBBdeviceKeyB=-drive';

describe('presence identity helpers', () => {
  beforeEach(() => {
    applyFriendNamesFromWorker({});
    applyDeviceNamesFromWorker({});
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

    // Home lists bare repo peerIds (no presence, so no group id): the key is the
    // device agentId, which is exactly how device names are keyed.
    it('names a bare peerId by its device name', () => {
      applyDeviceNamesFromWorker({ AAAAdeviceKeyA: 'Phone' });
      const peer = 'AAAAdeviceKeyA-drive-x1y2z3w4';
      expect(peerDisplayName(peer)).toBe('Phone');
      expect(peerDisplayName(PEER_B)).toBe('BBBBdevi…');
    });

    it('prefers the friend name when the peer carries its group id', () => {
      applyFriendNamesFromWorker({ [GROUP]: 'Alice' });
      applyDeviceNamesFromWorker({ AAAAdeviceKeyA: 'Phone' });
      expect(peerDisplayName('AAAAdeviceKeyA-drive-x1y2z3w4', GROUP)).toBe('Alice');
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

describe('the presence store', () => {
  const mockSubscribe = subscribePresence as jest.Mock;
  const mockSetPresence = setPresence as jest.Mock;
  let lastCallback: ((states: any) => void) | null;
  let unsubscribe: jest.Mock;

  const peerState = (peerId: string, value: Partial<PresenceState> | undefined) =>
    ({ peerId, lastActiveAt: 1, lastUpdateAt: 1, value });

  /** Every patch sent for a doc, in order. */
  const sent = (docId = 'doc-1') =>
    mockSetPresence.mock.calls.filter(c => c[0] === docId).map(c => c[1]);
  /** The `focusedField` values sent for a doc, in order. */
  const focusSent = (docId = 'doc-1') =>
    sent(docId).filter(p => 'focusedField' in p).map(p => p.focusedField);

  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  };

  const focusHook = (initial: FocusPath | null, layer: FocusLayer = 'view', docId = 'doc-1') =>
    renderHook(({ path }: { path: FocusPath | null }) => useFocusPath(docId, path, layer), {
      initialProps: { path: initial },
    });

  beforeEach(() => {
    jest.clearAllMocks();
    lastCallback = null;
    unsubscribe = jest.fn();
    mockSubscribe.mockImplementation((_docId: string, cb: (states: any) => void) => {
      lastCallback = cb;
      return unsubscribe;
    });
  });

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  describe('usePresence', () => {
    it('subscribes and announces the initial state', () => {
      renderHook(() => usePresence('doc-1'));
      expect(mockSubscribe).toHaveBeenCalledTimes(1);
      expect(mockSubscribe.mock.calls[0][0]).toBe('doc-1');
      expect(sent()).toEqual([{ viewing: true, focusedField: null }]);
    });

    it('does nothing for a falsy docId', () => {
      const { result } = renderHook(() => usePresence(undefined));
      expect(mockSubscribe).not.toHaveBeenCalled();
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

    it('shares one subscription and one announcement between every caller', () => {
      const a = renderHook(() => usePresence('doc-1'));
      const b = renderHook(() => usePresence('doc-1'));
      expect(mockSubscribe).toHaveBeenCalledTimes(1);
      expect(sent()).toHaveLength(1);

      a.unmount();
      expect(unsubscribe).not.toHaveBeenCalled();
      b.unmount();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    // The title bar and the editor sheet mount after the view has focused
    // something; each used to re-send the initial `focusedField: null`.
    it('a later caller does not reset the focused field', () => {
      focusHook(['tasks', 't1']);
      renderHook(() => usePresence('doc-1'));
      expect(focusSent()).toEqual([null, ['tasks', 't1']]);
    });

    it('hands a late caller the peers the store already holds', () => {
      renderHook(() => usePresence('doc-1'));
      const states = { [PEER_A]: peerState(PEER_A, { viewing: true, focusedField: null }) };
      act(() => lastCallback!(states));
      const late = renderHook(() => usePresence('doc-1'));
      expect(late.result.current.peers).toEqual(states);
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

    it('re-announces the whole state, focus included, to a peer that joins later', () => {
      renderHook(() => usePresence('doc-1'));
      focusHook(['tasks', 't1']);
      mockSetPresence.mockClear();
      const states = { [PEER_A]: peerState(PEER_A, { viewing: true, focusedField: null }) };
      act(() => lastCallback!(states));
      expect(sent()).toEqual([{ viewing: true, focusedField: ['tasks', 't1'] }]);
      // The same peer again is not a newcomer.
      act(() => lastCallback!({ ...states }));
      expect(sent()).toHaveLength(1);
    });
  });

  describe('ViewingPresence', () => {
    it('announces viewing for as long as it is mounted', () => {
      const { unmount } = render(<ViewingPresence docId="doc-1" />);
      expect(sent()).toEqual([{ viewing: true, focusedField: null }]);
      unmount();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('useFocusPath', () => {
    it('announces the path, by value, and replaces it without a null in between', () => {
      const { rerender } = focusHook(['tasks', 't1']);
      expect(focusSent()).toEqual([null, ['tasks', 't1']]);
      rerender({ path: ['tasks', 't1'] }); // a fresh array, the same path
      expect(focusSent()).toHaveLength(2);
      rerender({ path: ['tasks', 't2'] });
      expect(focusSent()).toEqual([null, ['tasks', 't1'], ['tasks', 't2']]);
      rerender({ path: null });
      expect(focusSent()).toEqual([null, ['tasks', 't1'], ['tasks', 't2'], null]);
    });

    it('withdraws its path on unmount while the document stays open', () => {
      renderHook(() => usePresence('doc-1'));
      const { unmount } = focusHook(['tasks', 't1']);
      unmount();
      expect(focusSent()).toEqual([null, ['tasks', 't1'], null]);
      expect(unsubscribe).not.toHaveBeenCalled();
    });

    // Another tab can keep the engine's entry alive after this one leaves, so a
    // path must not be left behind in the shared slot.
    it('clears the path before unsubscribing when it is the last to leave', () => {
      const { unmount } = focusHook(['tasks', 't1']);
      mockSetPresence.mockClear();
      mockSetPresence.mockImplementation(() => { expect(unsubscribe).not.toHaveBeenCalled(); });
      unmount();
      mockSetPresence.mockImplementation(() => {});
      expect(focusSent()).toEqual([null]);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('an open item editor outranks the view behind it, and hands back on close', () => {
      focusHook(['recipes', 'r1']);
      const item = focusHook(['recipes', 'r1', 'name'], 'item');
      expect(focusSent()).toEqual([null, ['recipes', 'r1'], ['recipes', 'r1', 'name']]);
      item.unmount();
      expect(focusSent()).toEqual([null, ['recipes', 'r1'], ['recipes', 'r1', 'name'], ['recipes', 'r1']]);
    });

    it('one writer closing leaves another’s focus alone', () => {
      const first = focusHook(['events', 'e1'], 'item');
      focusHook(['birth'], 'item');
      expect(focusSent()).toEqual([null, ['events', 'e1'], ['birth']]);
      first.unmount();
      expect(focusSent()).toHaveLength(3);
    });

    it('does nothing for a falsy docId', () => {
      renderHook(() => useFocusPath(undefined, ['tasks', 't1']));
      expect(mockSubscribe).not.toHaveBeenCalled();
      expect(mockSetPresence).not.toHaveBeenCalled();
    });
  });

  // All tabs of a device share one presence state, so `focusedField` is a single
  // slot: only the tab in front of the user may write it.
  describe('a hidden tab', () => {
    it('announces viewing on mount but leaves the focused field alone', () => {
      setVisibility('hidden');
      focusHook(['tasks', 't1']);
      expect(sent()).toEqual([{ viewing: true }]);
    });

    it('answers a newcomer with viewing only', () => {
      focusHook(['tasks', 't1']);
      setVisibility('hidden');
      mockSetPresence.mockClear();
      act(() => lastCallback!({ [PEER_A]: peerState(PEER_A, { viewing: true, focusedField: null }) }));
      expect(sent()).toEqual([{ viewing: true }]);
    });

    it('re-asserts its path on becoming visible, changed or not', () => {
      const { rerender } = focusHook(['tasks', 't1']);
      setVisibility('hidden');
      mockSetPresence.mockClear();
      rerender({ path: ['tasks', 't2'] });
      expect(sent()).toEqual([]);
      setVisibility('visible');
      expect(sent()).toEqual([{ focusedField: ['tasks', 't2'] }]);
      // Unchanged since, but another tab may have written the slot meanwhile.
      setVisibility('hidden');
      setVisibility('visible');
      expect(sent()).toEqual([{ focusedField: ['tasks', 't2'] }, { focusedField: ['tasks', 't2'] }]);
    });

    it('does not clear a slot it was not writing when it leaves', () => {
      const { unmount } = focusHook(['tasks', 't1']);
      setVisibility('hidden');
      mockSetPresence.mockClear();
      unmount();
      expect(sent()).toEqual([]);
    });
  });

  describe('usePeersAt', () => {
    const states = {
      [PEER_A]: peerState(PEER_A, { viewing: true, focusedField: ['events', 'e1', 'title'], userGroupId: GROUP }),
      [PEER_B]: peerState(PEER_B, { viewing: true, focusedField: ['events', 'e2'] }),
      'CCCC=-drive': peerState('CCCC=-drive', { viewing: true, focusedField: ['tasks', 't1'] }),
    };

    it('keys the peers under a path by the segment that follows it', () => {
      const { result } = renderHook(() => usePeersAt('doc-1', ['events']));
      act(() => lastCallback!(states));
      expect(Object.keys(result.current).sort()).toEqual(['e1', 'e2']);
      expect(result.current.e1).toEqual({ color: peerColor(PEER_A, GROUP), peerId: PEER_A, userGroupId: GROUP });
    });

    it('leaves out a peer focused on the path itself', () => {
      const { result } = renderHook(() => usePeersAt('doc-1', ['events', 'e2']));
      act(() => lastCallback!(states));
      expect(result.current).toEqual({});
    });

    it('is empty without a path', () => {
      const { result } = renderHook(() => usePeersAt('doc-1', null));
      act(() => lastCallback!(states));
      expect(result.current).toEqual({});
    });
  });
});
