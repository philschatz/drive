/**
 * useDevices — shared device-list data hook.
 *
 * Owns the device list: the initial `listDevices()` fetch, a live refresh on
 * rendezvous-link completion and keyhive state changes, and a remove handler.
 * Callers pass `onError`/`onMessage` so each page keeps control of its own
 * alert UI (the Settings page, for instance, shares those alerts with
 * name-saving and the cache toggle, so the hook must not own that state).
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
import { usePeerList, usePeerTransports, type PeerTransport } from '../worker-api';

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
      setDevices(await listDevices());
    } catch (err: any) {
      cb.current?.onError?.(err.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Refresh when a link completes or membership syncs over the relay.
  useEffect(() => {
    const offRdv = onRendezvousEvent((e) => { if (e.status === 'linked') refresh(); });
    const offState = onKeyhiveStateChanged(() => refresh());
    return () => { offRdv(); offState(); };
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
