import { useMemo } from 'preact/hooks';
import type { PeerState } from '../shared/automerge';
import { peerColor, type PresenceState } from '../shared/presence';
import { PATH_PROP_TO_FIELDS, type EditorState } from './calendar-utils';

export function usePeerFocusedFields(
  peerStates: Record<string, PeerState<PresenceState>>,
  editorState: EditorState | null,
): Record<string, { color: string; peerId: string }> {
  return useMemo(() => {
    const result: Record<string, { color: string; peerId: string }> = {};
    if (!editorState) return result;
    for (const peer of Object.values(peerStates)) {
      const pf = peer.value?.focusedField;
      if (!pf || pf.length < 3) continue;
      if (pf[0] !== 'events' || pf[1] !== editorState.uid) continue;
      const prop = pf[2] as string;
      const inputIds = PATH_PROP_TO_FIELDS[prop];
      if (inputIds) {
        const info = { color: peerColor(peer.peerId), peerId: peer.peerId };
        for (const id of inputIds) result[id] = info;
      }
    }
    return result;
  }, [peerStates, editorState]);
}
