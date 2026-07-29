/**
 * useDevices — shared device-list data hook.
 *
 * Owns the device list: the initial `listDevices()` fetch, a live refresh on
 * rendezvous-link completion and keyhive state changes, and a remove handler.
 * Callers pass `onError`/`onMessage` so each page keeps control of how results are
 * surfaced — the Settings page hands them straight to `showError`/`showToast`, but
 * the hook must not assume that.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import {
  listDevices,
  removeDevice as apiRemoveDevice,
  changeDeviceRole as apiChangeDeviceRole,
  onKeyhiveStateChanged,
  onRendezvousEvent,
  type DeviceInfo,
} from './keyhive-api';
import { usePeerList, usePeerTransports, onDeviceNamesUpdated, type PeerTransport } from '../worker-api';
import { getDeviceName } from '../device-names';
import { generateDefaultDeviceName } from '../lib/device-name';

export function useDevices(opts?: {
  onError?: (msg: string) => void;
  onMessage?: (msg: string) => void;
}) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  // Keep callbacks in a ref so refresh stays stable and the subscription
  // effect doesn't re-run every render.
  const cb = useRef(opts);
  cb.current = opts;

  const refresh = useCallback(async () => {
    try {
      const list = await listDevices();
      // Enrich each row with its friendly name from the device-names cache. A
      // remote device only has a name if we learned it at link time (no default
      // — we can't sniff another device's browser); our own row falls back to a
      // generated default so it always reads as "💻 Chrome" until renamed.
      setDevices(list.map(d => ({
        ...d,
        name: getDeviceName(d.agentId) || (d.isMe ? generateDefaultDeviceName() : undefined),
      })));
    } catch (err: any) {
      cb.current?.onError?.(err.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Refresh when a link completes, membership syncs over the relay, or a device
  // name arrives (the peer's name is pushed just after linkDevice on both sides).
  useEffect(() => {
    const offRdv = onRendezvousEvent((e) => { if (e.status === 'linked') refresh(); });
    const offState = onKeyhiveStateChanged(() => refresh());
    const offNames = onDeviceNamesUpdated(() => refresh());
    return () => { offRdv(); offState(); offNames(); };
  }, [refresh]);

  const removeDevice = useCallback(async (agentId: string) => {
    try {
      await apiRemoveDevice(agentId);
      cb.current?.onMessage?.('Device removed.');
      await refresh();
    } catch (err: any) {
      cb.current?.onError?.('Failed to remove device: ' + err.message);
    }
  }, [refresh]);

  const changeDeviceRole = useCallback(async (agentId: string, newRole: string) => {
    try {
      await apiChangeDeviceRole(agentId, newRole);
      cb.current?.onMessage?.('Device access updated.');
      await refresh();
    } catch (err: any) {
      cb.current?.onError?.('Failed to change device access: ' + err.message);
    }
  }, [refresh]);

  return { devices, refresh, removeDevice, changeDeviceRole };
}

export interface DeviceStatus {
  online: boolean;
  /** Transport when online: 'direct' WebRTC channel or via the relay. */
  transport?: PeerTransport;
}

/**
 * Collapse several devices' statuses into a single status for the user/group
 * that owns them, favouring the most-connected: any device on a direct (P2P)
 * channel wins, else any device online via the relay, else offline. Used to
 * summarise a user-group (all a contact's devices) as one presence dot.
 */
export function mostConnectedStatus(
  statuses: Record<string, DeviceStatus>,
  deviceIds: string[],
): DeviceStatus {
  let best: DeviceStatus = { online: false };
  for (const id of deviceIds) {
    const s = statuses[id];
    if (!s?.online) continue;
    if (s.transport === 'direct') return { online: true, transport: 'direct' };
    best = { online: true, transport: 'relay' };
  }
  return best;
}

/**
 * Live per-device connectivity, keyed by base64 agentId. A device is online iff
 * the relay's peer list contains a peerId whose prefix is that agentId (a peerId
 * is `<base64 agentId>-drive`; base64 never contains '-', so the split is exact).
 * The map covers every connected peer, not just the user's own devices — callers
 * look up by agentId, so extra keys are harmless. Absent key = offline.
 */
export function useDeviceStatuses(): Record<string, DeviceStatus> {
  const peers = usePeerList();
  const transports = usePeerTransports();
  return useMemo(() => {
    const statuses: Record<string, DeviceStatus> = {};
    for (const peerId of peers) {
      statuses[peerId.split('-')[0]] = { online: true, transport: transports[peerId] ?? 'relay' };
    }
    return statuses;
  }, [peers, transports]);
}
