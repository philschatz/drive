import { useState, useEffect } from 'preact/hooks';
import { getMyAccess } from './keyhive-api';

export type AccessLevel = 'admin' | 'write' | 'read' | 'pull' | null;

/**
 * Query the current device's keyhive access level for a document.
 * Returns the access string (admin/write/read/pull) or null if unknown/no keyhive.
 * `canEdit` is true when the access level permits writes (admin or write).
 * When a khDocId exists but access hasn't been confirmed yet, defaults to read-only.
 */
export function useAccess(khDocId: string | undefined): { access: AccessLevel; canEdit: boolean } {
  const [access, setAccess] = useState<AccessLevel>(null);

  useEffect(() => {
    if (!khDocId) {
      setAccess(null);
      return;
    }
    let cancelled = false;
    getMyAccess(khDocId).then(a => {
      const level = (a?.toLowerCase() ?? null) as AccessLevel;
      console.log('[useAccess] khDocId=%s → access=%s canEdit=%s', khDocId, level, level === 'admin' || level === 'write');
      if (!cancelled) setAccess(level);
    }).catch((err) => {
      console.warn('[useAccess] failed for khDocId=%s:', khDocId, err);
      if (!cancelled) setAccess(null);
    });
  }, [khDocId]);

  if (!khDocId) {
    // No keyhive doc → unrestricted
    return { access: null, canEdit: true };
  }

  // keyhive doc exists: only allow edits if explicitly admin or write
  const canEdit = access === 'admin' || access === 'write';
  return { access, canEdit };
}
