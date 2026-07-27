/**
 * DeviceList — shared rendering of a user's linked devices.
 *
 * Used by the Settings page and the Link Device page. Renders the descriptive
 * blurb, the empty state, and a row per device (icon, truncated agent id, role,
 * "This device" badge, and a remove button for non-self devices).
 *
 * Role editing parallels the document Sharing page (`sharing/SharingPage`):
 * an admin device sees a Read/Edit/Admin Select per device (with a self-demotion
 * confirmation); a non-admin device sees a static role label with no controls.
 */

import { DeleteButton } from '@/components/ui/delete-button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EditableDeviceName } from '@/components/EditableDeviceName';
import { StatusDot } from '@/common/presence';
import type { DeviceInfo } from '@/common/keyhive-api';
import type { DeviceStatus } from '@/common/use-devices';

export function DeviceList({ devices, onRemove, onChangeRole, statuses }: {
  devices: DeviceInfo[];
  onRemove: (agentId: string) => void;
  /** Change a device's access level (Read/Edit/Admin). Admin-only in the UI. */
  onChangeRole: (agentId: string, newRole: string) => void;
  /** Live connectivity by agentId (from useDeviceStatuses); omit to hide status. */
  statuses?: Record<string, DeviceStatus>;
}) {
  // The current device is the "me" row; only an admin device can manage access —
  // mirrors the Sharing page's `myAccess === 'admin'` gate.
  const isAdmin = devices.find(d => d.isMe)?.role === 'admin';

  const handleChangeRole = (dev: DeviceInfo, newRole: string) => {
    // Self-demotion from admin is hard to undo: without admin you can no longer
    // manage devices (or restore your own access from here). Make it deliberate.
    if (dev.isMe && dev.role === 'admin' && newRole !== 'admin') {
      const ok = confirm(
        `Reduce this device's access from admin to ${newRole}? ` +
        'You will no longer be able to manage devices or restore your own access from here.'
      );
      if (!ok) return; // controlled Select snaps back to the current role
    }
    onChangeRole(dev.agentId, newRole);
  };

  return (
    <>
      <p className="text-xs text-muted-foreground mb-2">
        Each device has its own cryptographic key. Add devices so you can reach your documents from your phone, laptop, or tablet.
      </p>
      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No linked devices.</p>
      ) : (
        <div className="space-y-1">
          {devices.map((dev, i) => (
            <div key={i} className="flex items-center gap-2 py-1 border-b border-border">
              <span className="material-symbols-outlined text-muted-foreground" style={{ fontSize: 16 }}>
                {dev.isMe ? 'smartphone' : 'devices'}
              </span>
              {/* Every device is inline-editable. Your own row defaults its
                  placeholder to the generated name (📱/💻 + browser); a remote
                  device's name (shared at link time) can be relabelled locally. */}
              <EditableDeviceName agentId={dev.agentId} isMe={dev.isMe} />
              {statuses && !dev.isMe && (
                <span className="flex items-center gap-1">
                  <StatusDot
                    online={statuses[dev.agentId]?.online ?? false}
                    direct={statuses[dev.agentId]?.transport === 'direct'}
                  />
                  <span className="text-xs text-muted-foreground">
                    {statuses[dev.agentId]?.online ? 'Online' : 'Offline'}
                  </span>
                </span>
              )}
              {isAdmin ? (
                <div className="flex items-center gap-1">
                  <Select value={dev.role} onValueChange={(val: string) => handleChangeRole(dev, val)}>
                    <SelectTrigger className="h-7 text-xs w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="read">Read</SelectItem>
                      <SelectItem value="edit">Edit</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                  {!dev.isMe && (
                    <DeleteButton
                      tooltip="Remove device"
                      confirmMessage={`Remove device ${dev.agentId.slice(0, 16)}…?`}
                      onConfirm={() => onRemove(dev.agentId)}
                    />
                  )}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground capitalize">{dev.role}</span>
              )}
              {dev.isMe && <span className="text-xs bg-primary/10 text-primary px-1 rounded">This device</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
