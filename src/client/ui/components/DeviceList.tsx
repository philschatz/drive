/**
 * DeviceList — the user's linked devices, as Material rows.
 *
 * Each row states the device: presence dot, name (or truncated id), how it is
 * reachable, and its access level. Tapping a row opens DeviceOptionsSheet, which
 * is where any of that *changes* — the same tap-row-opens-a-sheet idiom the
 * Sharing and Friends pages use, replacing the inline name field, role dropdown
 * and trash button this row used to carry.
 *
 * Role editing parallels the document Sharing page: an admin device can change
 * access on the devices it delegated. Which actions a row offers is decided by
 * DeviceOptionsSheet, which encodes keyhive's three limits (never yourself, never
 * the founder, only devices you delegated) as which rows exist.
 *
 * The role shown is the device's *real* access, `null` included — a device the
 * group revoked reads "No access" rather than being quietly presented as an admin.
 *
 * The sheets live here rather than in the calling page so the component's props
 * stay purely declarative. A rename needs no refresh callback: `useDevices`
 * already subscribes to `onDeviceNamesUpdated`, and the engine broadcasts that
 * after every successful write.
 */

import { useState } from 'preact/hooks';
import { showError } from '@/components/ui/toast';
import { accessTitle } from '@/components/AccessIcon';
import { RenameSheet } from '@/common/RenameSheet';
import { useConfirm } from '@/common/ConfirmSheet';
import { RolePickerSheet } from '../sharing/RolePickerSheet';
import { DeviceOptionsSheet } from './DeviceOptionsSheet';
import { getDeviceName, setDeviceName, removeDeviceName } from '../device-names';
import { PeerDot } from '@/common/PeerDot';
import type { DeviceInfo } from '@/common/keyhive-api';
import type { DeviceStatus } from '@/common/use-devices';

export function DeviceList({ devices, onRemove, onChangeRole, statuses }: {
  devices: DeviceInfo[];
  onRemove: (agentId: string) => void | Promise<void>;
  /** Change a device's access level (Read/Edit/Admin). Admin-only in the UI. */
  onChangeRole: (agentId: string, newRole: string) => void | Promise<void>;
  /** Live connectivity by agentId (from useDeviceStatuses); omit to hide status. */
  statuses?: Record<string, DeviceStatus>;
}) {
  // The current device is the "me" row; only an admin device can manage access —
  // mirrors the Sharing page's `myAccess === 'admin'` gate. Now that the role is
  // real rather than a hard-coded 'admin', a revoked or demoted device correctly
  // gets no management actions at all.
  const me = devices.find(d => d.isMe);
  const isAdmin = me?.role === 'admin';

  const [optionsFor, setOptionsFor] = useState<DeviceInfo | null>(null);
  const [renameFor, setRenameFor] = useState<DeviceInfo | null>(null);
  const [roleTarget, setRoleTarget] = useState<DeviceInfo | null>(null);
  // A role change is revoke-then-re-add with a full CGKA rotation, so it is slow
  // enough to need a guard against a second tap.
  const [busy, setBusy] = useState(false);
  const { confirm, confirmSheet } = useConfirm();

  const nameOf = (dev: DeviceInfo) => dev.name || `${dev.agentId.slice(0, 16)}…`;

  const mutate = async (fn: () => void | Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  // Close the options sheet BEFORE opening the next surface, so a picker or a
  // confirm is never stacked under a sheet that is still animating out.
  const handleRename = (dev: DeviceInfo) => { setOptionsFor(null); setRenameFor(dev); };
  const handleChangeRole = (dev: DeviceInfo) => { setOptionsFor(null); setRoleTarget(dev); };

  const handleResetName = (dev: DeviceInfo) => {
    setOptionsFor(null);
    removeDeviceName(dev.agentId).catch((err: any) =>
      showError('Could not reset the name: ' + (err?.message ?? 'storage error')));
  };

  const handleRemove = async (dev: DeviceInfo) => {
    setOptionsFor(null);
    if (!await confirm({
      title: `Remove ${nameOf(dev)}?`,
      body: 'That device loses access to your documents, and its keys are rotated out.',
      confirmLabel: 'Remove device',
      confirmIcon: 'phonelink_erase',
      destructive: true,
      'data-testid': 'remove-device-confirm',
    })) return;
    await mutate(() => onRemove(dev.agentId));
  };

  const saveName = (dev: DeviceInfo, name: string) => {
    setDeviceName(dev.agentId, name).catch((err: any) =>
      showError('Could not save the name: ' + (err?.message ?? 'storage error')));
  };

  return (
    <>
      <p className="md-body-medium text-on-surface-variant px-4 pt-2 pb-1">
        Each device has its own cryptographic key. Add devices so you can reach your documents from
        your phone, laptop, or tablet.
      </p>

      {devices.length === 0 ? (
        <p className="md-body-medium text-on-surface-variant px-4 py-4">No linked devices.</p>
      ) : (
        <md-list style={{ background: 'transparent' }}>
          {devices.map(dev => {
            const status = statuses?.[dev.agentId];
            return (
              <md-list-item
                key={dev.agentId}
                type="button"
                data-testid="device-row"
                onClick={() => setOptionsFor(dev)}
              >
                <span slot="start" className="inline-flex items-center justify-center w-6">
                  {dev.isMe || !statuses ? (
                    // Your own device is not a peer, so a PeerDot here would render
                    // the grey offline dot — a lie. A glyph instead.
                    <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: 20 }}>
                      {dev.isMe ? 'smartphone' : 'devices'}
                    </span>
                  ) : (
                    <PeerDot
                      identityKey={dev.agentId}
                      online={status?.online ?? false}
                      direct={status?.transport === 'direct'}
                      label={nameOf(dev)}
                      sizeClass="w-2.5 h-2.5"
                    />
                  )}
                </span>

                <div slot="headline" className={dev.name ? undefined : 'text-muted-foreground'} title={dev.agentId}>
                  {nameOf(dev)}
                </div>

                {dev.isMe && <div slot="supporting-text">This device</div>}

                <span slot="end" className="flex items-center gap-2">
                  {statuses && !dev.isMe && (
                    // Name the transport, not just reachability — same wording as
                    // the Sharing page, since the dot's fill alone can't say which
                    // of two online devices is direct.
                    <span className="text-xs text-muted-foreground whitespace-nowrap" data-testid="device-transport">
                      {!status?.online ? 'Offline' : status?.transport === 'direct' ? 'P2P' : 'Via relay'}
                    </span>
                  )}
                  {/* accessTitle already returns "Admin"/"Edit"/"Read", and "No
                      access" for null — so no `capitalize` and no null branch. */}
                  <span className="text-xs text-muted-foreground whitespace-nowrap" data-testid="device-role">
                    {accessTitle(dev.role)}
                  </span>
                </span>
              </md-list-item>
            );
          })}
        </md-list>
      )}

      <DeviceOptionsSheet
        device={optionsFor}
        displayName={optionsFor ? nameOf(optionsFor) : ''}
        hasStoredName={!!optionsFor && getDeviceName(optionsFor.agentId) !== undefined}
        isAdmin={isAdmin}
        iAmFounder={me?.isFounder === true}
        myAgentId={me?.agentId}
        busy={busy}
        onOpenChange={(open: boolean) => { if (!open) setOptionsFor(null); }}
        onRename={handleRename}
        onResetName={handleResetName}
        onChangeRole={handleChangeRole}
        onRemove={handleRemove}
      />

      {/* Seeded from `dev.name`, which for your own unnamed device is the generated
          default — so you edit "💻 Chrome" instead of typing from nothing. */}
      <RenameSheet
        open={!!renameFor}
        title="Rename device"
        label="Device name"
        value={renameFor?.name ?? ''}
        onRename={name => renameFor && saveName(renameFor, name)}
        onClose={() => setRenameFor(null)}
        data-testid="device-rename-sheet"
      />

      <RolePickerSheet
        open={!!roleTarget}
        onOpenChange={(open: boolean) => { if (!open) setRoleTarget(null); }}
        title="Device access"
        // `null` (no membership) is not a pickable role — leave the list unchecked.
        value={roleTarget?.role ?? undefined}
        onPick={role => {
          const target = roleTarget;
          setRoleTarget(null);
          if (target) mutate(() => onChangeRole(target.agentId, role));
        }}
      />

      {confirmSheet}
    </>
  );
}
