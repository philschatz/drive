import { EditableName } from './EditableName';
import { getFriendName, setFriendName } from '../friend-names';
import { onFriendNamesUpdated } from '../worker-api';
import type { DeviceStatus } from '../common/use-devices';

/**
 * Inline editor for a contact/user's name (each row in Contacts and the Share
 * access-control panel). Bound to the contact-name store, keyed by user-group id.
 * A blank field falls back to the truncated id. Pass `status` (the union of all
 * the user's devices — see mostConnectedStatus) to show a leading presence dot.
 */
export function EditableUserName({ agentId, suffix, status }: { agentId: string; suffix?: any; status?: DeviceStatus }) {
  return (
    <EditableName
      agentId={agentId}
      get={getFriendName}
      set={setFriendName}
      subscribe={onFriendNamesUpdated}
      placeholder={`${agentId.slice(0, 12)}…`}
      title={agentId}
      suffix={suffix}
      status={status}
    />
  );
}
