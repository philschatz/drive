import { useState, useEffect, useCallback } from 'preact/hooks';
import { getMyAccess, onKeyhiveStateChanged } from './keyhive-api';

export type AccessLevel = 'admin' | 'edit' | 'read' | 'relay' | null;

const ACCESS_CACHE_KEY = 'keyhive-access-cache';

function readAccessCache(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(ACCESS_CACHE_KEY) || '{}'); }
  catch { return {}; }
}

function writeAccessCache(docId: string, access: AccessLevel): void {
  const cache = readAccessCache();
  if (access === null) delete cache[docId];
  else cache[docId] = access;
  localStorage.setItem(ACCESS_CACHE_KEY, JSON.stringify(cache));
}

export function getCachedAccess(docId: string): AccessLevel {
  const cache = readAccessCache();
  return (cache[docId] as AccessLevel) ?? null;
}

/**
 * Query the current device's keyhive access level for a document.
 * Returns the access string (admin/edit/read/relay) or null if unknown/no keyhive.
 * `canEdit` is true when the access level permits writes (admin or edit).
 * `loaded` distinguishes "still fetching" from "confirmed no access".
 * Re-fetches automatically when keyhive state changes (e.g. member added/revoked).
 */
export function useAccess(docId: string | undefined): { access: AccessLevel; canEdit: boolean; loaded: boolean } {
  const cached = docId ? getCachedAccess(docId) : null;
  const [access, setAccess] = useState<AccessLevel>(cached);
  const [loaded, setLoaded] = useState(!!cached);

  const fetchAccess = useCallback(() => {
    if (!docId) {
      setAccess(null);
      setLoaded(true);
      return;
    }
    getMyAccess(docId).then(a => {
      const level = (a?.toLowerCase() ?? null) as AccessLevel;
      setAccess(level);
      setLoaded(true);
      writeAccessCache(docId, level);
    }).catch(() => {
      setAccess(null);
      setLoaded(true);
      writeAccessCache(docId, null);
    });
  }, [docId]);

  // Initial fetch
  useEffect(() => {
    setLoaded(false);
    fetchAccess();
  }, [fetchAccess]);

  // Re-fetch when keyhive state changes (membership/access updated)
  useEffect(() => {
    if (!docId) return;
    return onKeyhiveStateChanged(fetchAccess);
  }, [docId, fetchAccess]);

  if (!docId) {
    return { access: null, canEdit: true, loaded: true };
  }

  const canEdit = access === 'admin' || access === 'edit';
  return { access, canEdit, loaded };
}
