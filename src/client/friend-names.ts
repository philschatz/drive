import type { MemberInfo } from './shared/keyhive-types';

// --- Dispatch hook (injected from automerge.ts to avoid circular imports) ---

type FriendNamesDispatch = (type: 'set-friend-name' | 'remove-friend-name', agentId: string, name?: string) => Promise<void>;
let dispatch: FriendNamesDispatch | null = null;

export function setFriendNamesDispatch(fn: FriendNamesDispatch): void {
  dispatch = fn;
}

// --- In-memory cache (populated by worker via applyFriendNamesFromWorker) ---

let cache: Record<string, string> = {};

/** Replace the entire cache. Called by automerge.ts on `friend-names-updated`. */
export function applyFriendNamesFromWorker(names: Record<string, string>): void {
  cache = { ...names };
}

export function getFriendName(agentId: string): string | undefined {
  return cache[agentId];
}

/** Return a snapshot of all saved contact names (agentId → name). */
export function getAllFriendNames(): Record<string, string> {
  return { ...cache };
}

/**
 * Merge locally-known (named) contacts into a list already surfaced from keyhive.
 *
 * A stored contact is always keyed by its user-group id (sharing is group-only), so
 * each cached entry becomes a group contact. Entries already present in `fromKeyhive`
 * or listed in `excludeIds` (e.g. members of the current document, or the current
 * user's own ids) are skipped. This mirrors the merge in Contacts.tsx so the Share
 * panel and the Contacts page show the same set of contacts even if the keyhive view
 * (read from IndexedDB in the worker) and the in-memory cache momentarily diverge.
 */
export function mergeCachedFriends(
  fromKeyhive: MemberInfo[],
  excludeIds: Iterable<string> = [],
): MemberInfo[] {
  const present = new Set(fromKeyhive.map(c => c.agentId));
  const exclude = new Set(excludeIds);
  const merged = [...fromKeyhive];
  for (const groupId of Object.keys(cache)) {
    if (present.has(groupId) || exclude.has(groupId)) continue;
    merged.push({
      agentId: groupId,
      displayId: groupId,
      type: 'group',
      isMe: false,
      deviceIds: [],
    });
  }
  return merged;
}

/**
 * Persist a contact name. The in-memory cache is updated optimistically for a snappy
 * UI, but the returned promise only resolves once the worker confirms the write was
 * persisted to IndexedDB. If persistence fails, the optimistic change is rolled back
 * and the promise rejects — so a failed save surfaces instead of silently diverging
 * from the persisted store.
 */
export async function setFriendName(agentId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    await removeFriendName(agentId);
    return;
  }
  const prev = cache[agentId];
  cache[agentId] = trimmed;
  try {
    await dispatch?.('set-friend-name', agentId, trimmed);
  } catch (err) {
    if (prev === undefined) delete cache[agentId];
    else cache[agentId] = prev;
    throw err;
  }
}

export async function removeFriendName(agentId: string): Promise<void> {
  const prev = cache[agentId];
  delete cache[agentId];
  try {
    await dispatch?.('remove-friend-name', agentId);
  } catch (err) {
    if (prev !== undefined) cache[agentId] = prev;
    throw err;
  }
}
