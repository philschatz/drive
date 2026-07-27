/**
 * Tests for friend-names.ts in-memory cache.
 */

import { getFriendName, setFriendName, removeFriendName, applyFriendNamesFromWorker, setFriendNamesDispatch, mergeCachedFriends } from './friend-names';
import type { MemberInfo } from '../shared/keyhive-types';

function group(agentId: string): MemberInfo {
  return { agentId, displayId: agentId, type: 'group', isMe: false, deviceIds: [] };
}

beforeEach(() => {
  // Reset cache
  applyFriendNamesFromWorker({});
});

describe('applyFriendNamesFromWorker', () => {
  it('replaces the cache', () => {
    applyFriendNamesFromWorker({ agent1: 'Alice', agent2: 'Bob' });
    expect(getFriendName('agent1')).toBe('Alice');
    expect(getFriendName('agent2')).toBe('Bob');
  });

  it('clears previous entries on replace', () => {
    applyFriendNamesFromWorker({ agent1: 'Alice' });
    applyFriendNamesFromWorker({ agent2: 'Bob' });
    expect(getFriendName('agent1')).toBeUndefined();
    expect(getFriendName('agent2')).toBe('Bob');
  });
});

describe('getFriendName', () => {
  it('returns undefined for unknown agent', () => {
    expect(getFriendName('unknown')).toBeUndefined();
  });
});

describe('setFriendName', () => {
  it('updates cache optimistically and dispatches', () => {
    const dispatch = jest.fn();
    setFriendNamesDispatch(dispatch);

    setFriendName('agent1', 'Alice');
    expect(getFriendName('agent1')).toBe('Alice');
    expect(dispatch).toHaveBeenCalledWith('set-friend-name', 'agent1', 'Alice');
  });

  it('trims whitespace', () => {
    setFriendName('agent1', '  Alice  ');
    expect(getFriendName('agent1')).toBe('Alice');
  });

  it('resolves when persistence succeeds', async () => {
    setFriendNamesDispatch(() => Promise.resolve());
    await expect(setFriendName('agent1', 'Alice')).resolves.toBeUndefined();
    expect(getFriendName('agent1')).toBe('Alice');
  });

  it('rejects and rolls back the optimistic cache update when persistence fails', async () => {
    setFriendNamesDispatch(() => Promise.reject(new Error('storage error')));
    await expect(setFriendName('agent1', 'Alice')).rejects.toThrow('storage error');
    // The optimistic write must not linger once persistence failed — otherwise the
    // cache (read by Settings → Contacts) would diverge from the persisted store
    // (read by the Share panel), which is exactly the reported bug.
    expect(getFriendName('agent1')).toBeUndefined();
  });

  it('restores the previous name when an overwrite fails to persist', async () => {
    setFriendNamesDispatch(() => Promise.resolve());
    await setFriendName('agent1', 'Alice');
    setFriendNamesDispatch(() => Promise.reject(new Error('storage error')));
    await expect(setFriendName('agent1', 'Bob')).rejects.toThrow('storage error');
    expect(getFriendName('agent1')).toBe('Alice');
  });

  it('removes name when set to empty string', () => {
    const dispatch = jest.fn();
    setFriendNamesDispatch(dispatch);

    setFriendName('agent1', 'Alice');
    dispatch.mockClear();

    setFriendName('agent1', '  ');
    expect(getFriendName('agent1')).toBeUndefined();
    expect(dispatch).toHaveBeenCalledWith('remove-friend-name', 'agent1');
  });
});

describe('mergeCachedFriends', () => {
  it('surfaces a cached contact that the keyhive view is missing (the reported bug)', () => {
    // A just-added contact lives in the cache but the keyhive/worker-IDB view came
    // back empty — the Share panel must still list it.
    applyFriendNamesFromWorker({ groupA: 'Alice' });
    const merged = mergeCachedFriends([]);
    expect(merged).toEqual([group('groupA')]);
  });

  it('does not duplicate a contact already present in the keyhive view', () => {
    applyFriendNamesFromWorker({ groupA: 'Alice' });
    const merged = mergeCachedFriends([group('groupA')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].agentId).toBe('groupA');
  });

  it('excludes ids already in the document and the current user', () => {
    applyFriendNamesFromWorker({ groupA: 'Alice', myGroup: 'Me', myDevice: 'My device' });
    const merged = mergeCachedFriends([], ['myGroup', 'myDevice']);
    expect(merged.map(c => c.agentId)).toEqual(['groupA']);
  });

  it('preserves keyhive contacts and appends cache-only ones', () => {
    applyFriendNamesFromWorker({ groupB: 'Bob' });
    const merged = mergeCachedFriends([group('groupA')]);
    expect(merged.map(c => c.agentId).sort()).toEqual(['groupA', 'groupB']);
  });
});

describe('removeFriendName', () => {
  it('removes from cache and dispatches', () => {
    const dispatch = jest.fn();
    setFriendNamesDispatch(dispatch);

    applyFriendNamesFromWorker({ agent1: 'Alice' });
    removeFriendName('agent1');
    expect(getFriendName('agent1')).toBeUndefined();
    expect(dispatch).toHaveBeenCalledWith('remove-friend-name', 'agent1');
  });
});
