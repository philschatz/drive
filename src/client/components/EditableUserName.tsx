import { EditableName } from './EditableName';
import { getContactName, setContactName } from '../contact-names';
import { onContactNamesUpdated } from '../worker-api';

/**
 * Inline editor for a contact/user's name (each row in Contacts and the Share
 * access-control panel). Bound to the contact-name store, keyed by user-group id.
 * A blank field falls back to the truncated id.
 */
export function EditableUserName({ agentId, suffix }: { agentId: string; suffix?: any }) {
  return (
    <EditableName
      agentId={agentId}
      get={getContactName}
      set={setContactName}
      subscribe={onContactNamesUpdated}
      placeholder={`${agentId.slice(0, 12)}…`}
      title={agentId}
      suffix={suffix}
    />
  );
}
