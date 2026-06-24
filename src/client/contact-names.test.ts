/**
 * Tests for contact-names.ts in-memory cache.
 */

import { getContactName, setContactName, removeContactName, applyContactNamesFromWorker, setContactNamesDispatch, mergeCachedContacts } from './contact-names';
import type { MemberInfo } from './shared/keyhive-types';

function group(agentId: string): MemberInfo {
  return { agentId, displayId: agentId, type: 'group', isMe: false, deviceIds: [] };
}

beforeEach(() => {
  // Reset cache
  applyContactNamesFromWorker({});
});

describe('applyContactNamesFromWorker', () => {
  it('replaces the cache', () => {
    applyContactNamesFromWorker({ agent1: 'Alice', agent2: 'Bob' });
    expect(getContactName('agent1')).toBe('Alice');
    expect(getContactName('agent2')).toBe('Bob');
  });

  it('clears previous entries on replace', () => {
    applyContactNamesFromWorker({ agent1: 'Alice' });
    applyContactNamesFromWorker({ agent2: 'Bob' });
    expect(getContactName('agent1')).toBeUndefined();
    expect(getContactName('agent2')).toBe('Bob');
  });
});

describe('getContactName', () => {
  it('returns undefined for unknown agent', () => {
    expect(getContactName('unknown')).toBeUndefined();
  });
});

describe('setContactName', () => {
  it('updates cache optimistically and dispatches', () => {
    const dispatch = jest.fn();
    setContactNamesDispatch(dispatch);

    setContactName('agent1', 'Alice');
    expect(getContactName('agent1')).toBe('Alice');
    expect(dispatch).toHaveBeenCalledWith('set-contact-name', 'agent1', 'Alice');
  });

  it('trims whitespace', () => {
    setContactName('agent1', '  Alice  ');
    expect(getContactName('agent1')).toBe('Alice');
  });

  it('resolves when persistence succeeds', async () => {
    setContactNamesDispatch(() => Promise.resolve());
    await expect(setContactName('agent1', 'Alice')).resolves.toBeUndefined();
    expect(getContactName('agent1')).toBe('Alice');
  });

  it('rejects and rolls back the optimistic cache update when persistence fails', async () => {
    setContactNamesDispatch(() => Promise.reject(new Error('storage error')));
    await expect(setContactName('agent1', 'Alice')).rejects.toThrow('storage error');
    // The optimistic write must not linger once persistence failed — otherwise the
    // cache (read by Settings → Contacts) would diverge from the persisted store
    // (read by the Share panel), which is exactly the reported bug.
    expect(getContactName('agent1')).toBeUndefined();
  });

  it('restores the previous name when an overwrite fails to persist', async () => {
    setContactNamesDispatch(() => Promise.resolve());
    await setContactName('agent1', 'Alice');
    setContactNamesDispatch(() => Promise.reject(new Error('storage error')));
    await expect(setContactName('agent1', 'Bob')).rejects.toThrow('storage error');
    expect(getContactName('agent1')).toBe('Alice');
  });

  it('removes name when set to empty string', () => {
    const dispatch = jest.fn();
    setContactNamesDispatch(dispatch);

    setContactName('agent1', 'Alice');
    dispatch.mockClear();

    setContactName('agent1', '  ');
    expect(getContactName('agent1')).toBeUndefined();
    expect(dispatch).toHaveBeenCalledWith('remove-contact-name', 'agent1');
  });
});

describe('mergeCachedContacts', () => {
  it('surfaces a cached contact that the keyhive view is missing (the reported bug)', () => {
    // A just-added contact lives in the cache but the keyhive/worker-IDB view came
    // back empty — the Share panel must still list it.
    applyContactNamesFromWorker({ groupA: 'Alice' });
    const merged = mergeCachedContacts([]);
    expect(merged).toEqual([group('groupA')]);
  });

  it('does not duplicate a contact already present in the keyhive view', () => {
    applyContactNamesFromWorker({ groupA: 'Alice' });
    const merged = mergeCachedContacts([group('groupA')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].agentId).toBe('groupA');
  });

  it('excludes ids already in the document and the current user', () => {
    applyContactNamesFromWorker({ groupA: 'Alice', myGroup: 'Me', myDevice: 'My device' });
    const merged = mergeCachedContacts([], ['myGroup', 'myDevice']);
    expect(merged.map(c => c.agentId)).toEqual(['groupA']);
  });

  it('preserves keyhive contacts and appends cache-only ones', () => {
    applyContactNamesFromWorker({ groupB: 'Bob' });
    const merged = mergeCachedContacts([group('groupA')]);
    expect(merged.map(c => c.agentId).sort()).toEqual(['groupA', 'groupB']);
  });
});

describe('removeContactName', () => {
  it('removes from cache and dispatches', () => {
    const dispatch = jest.fn();
    setContactNamesDispatch(dispatch);

    applyContactNamesFromWorker({ agent1: 'Alice' });
    removeContactName('agent1');
    expect(getContactName('agent1')).toBeUndefined();
    expect(dispatch).toHaveBeenCalledWith('remove-contact-name', 'agent1');
  });
});
