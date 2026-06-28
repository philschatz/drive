/**
 * DeviceList — shared rendering of a user's linked devices.
 *
 * Used by the Settings page and the Link Device page. Renders the descriptive
 * blurb, the empty state, and a row per device (icon, truncated agent id, role,
 * "This device" badge, and a remove button for non-self devices).
 */

import { DeleteButton } from '@/components/ui/delete-button';
import type { DeviceInfo } from '@/shared/keyhive-api';

export function DeviceList({ devices, onRemove }: {
  devices: DeviceInfo[];
  onRemove: (agentId: string) => void;
}) {
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
              <span className="text-sm flex-1 truncate font-mono" title={dev.agentId}>
                {dev.agentId.slice(0, 16)}...
              </span>
              <span className="text-xs text-muted-foreground capitalize">{dev.role}</span>
              {dev.isMe && <span className="text-xs bg-primary/10 text-primary px-1 rounded">This device</span>}
              {!dev.isMe && (
                <DeleteButton
                  tooltip="Remove device"
                  confirmMessage={`Remove device ${dev.agentId.slice(0, 16)}…?`}
                  onConfirm={() => onRemove(dev.agentId)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
