import { useRef } from 'preact/hooks';
import { EditableName } from './EditableName';
import { getDeviceName, setDeviceName } from '../device-names';
import { onDeviceNamesUpdated } from '../worker-api';
import { generateDefaultDeviceName } from '../lib/device-name';

/**
 * Inline editor for a device's name (each row in DeviceList). Bound to the
 * device-name store; any device can be relabelled locally (a rename of a remote
 * device is a local label — like a contact name — and does not propagate).
 *
 * Placeholder: for THIS device (`isMe`) a blank field shows the generated
 * default (📱/💻 + browser) it will be called until overridden. For a remote
 * device we can't sniff its browser, so it falls back to the truncated id.
 */
export function EditableDeviceName({ agentId, isMe, suffix }: { agentId: string; isMe?: boolean; suffix?: any }) {
  // Stable placeholder: computing it once on mount avoids re-sniffing the
  // browser (generateDefaultDeviceName reads navigator) on every render.
  const placeholderRef = useRef<string>();
  if (!placeholderRef.current) {
    placeholderRef.current = isMe ? generateDefaultDeviceName() : `${agentId.slice(0, 16)}…`;
  }

  return (
    <EditableName
      agentId={agentId}
      get={getDeviceName}
      set={setDeviceName}
      subscribe={onDeviceNamesUpdated}
      placeholder={placeholderRef.current}
      title={agentId}
      suffix={suffix}
    />
  );
}
