import { useRef, type MutableRef } from 'preact/hooks';
import { useAccess, type AccessLevel } from './useAccess';

/**
 * The one gate for whether a document view may mutate its document:
 * not forced read-only (older version / view-only route state), at the latest
 * version, and holding edit access. `canEditRef` is a stable ref mirror for
 * event callbacks captured by long-lived closures. `noAccess` is true once
 * access is confirmed absent (revoked / never granted) — views dim their body.
 */
export function useCanEdit(
  docId: string | undefined,
  readOnly: boolean | undefined,
  history: { editable: boolean },
): { access: AccessLevel; canEdit: boolean; canEditRef: MutableRef<boolean>; noAccess: boolean } {
  const { access, canEdit: accessCanEdit, loaded: accessLoaded } = useAccess(docId);
  const canEdit = !readOnly && history.editable && accessCanEdit;
  const noAccess = accessLoaded && access === null;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  return { access, canEdit, canEditRef, noAccess };
}
