/**
 * DeviceList — shared rendering of a user's linked devices.
 *
 * Used by the Settings page and the Link Device page. Renders the descriptive
 * blurb, the empty state, and a row per device (icon, truncated agent id, role,
 * "This device" badge, and a remove button for non-self devices).
 */

import { DeleteButton } from '@/components/ui/delete-button';
import type { DeviceInfo } from '@/shared/keyhive-api';
import type { DeviceStatus } from '@/shared/use-devices';

/**
 * Online/offline indicator. Follows the PeerDot convention (presence.tsx): a
 * FILLED dot means a direct WebRTC channel is open, a HOLLOW ring means the
 * device is reachable only via the relay — so a relayed connection is never
 * mistaken for P2P. Gray means offline.
 */
function DeviceStatusDot({ status }: { status?: DeviceStatus }) {
  const online = status?.online ?? false;
  const direct = status?.transport === 'direct';
  const cls = !online ? 'bg-muted-foreground/30'
    : direct ? 'bg-green-500'
    : 'border-2 border-green-500';
  return (
    <span
      className={`w-2 h-2 rounded-full inline-block shrink-0 box-border ${cls}`}
      title={online ? `Online — ${direct ? 'direct (P2P)' : 'via relay'}` : 'Offline'}
    />
  );
}

export function DeviceList({ devices, onRemove, statuses }: {
  devices: DeviceInfo[];
  onRemove: (agentId: string) => void;
  /** Live connectivity by agentId (from useDeviceStatuses); omit to hide status. */
  statuses?: Record<string, DeviceStatus>;
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
              {statuses && !dev.isMe && (
                <span className="flex items-center gap-1">
                  <DeviceStatusDot status={statuses[dev.agentId]} />
                  <span className="text-xs text-muted-foreground">
                    {statuses[dev.agentId]?.online ? 'Online' : 'Offline'}
                  </span>
                </span>
              )}
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
