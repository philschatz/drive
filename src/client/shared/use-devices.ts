/**
 * useDevices — shared device-list data hook.
 *
 * Owns the device list: the initial `listDevices()` fetch, a live refresh on
 * rendezvous-link completion and keyhive state changes, and a remove handler.
 * Callers pass `onError`/`onMessage` so each page keeps control of its own
 * alert UI (the Settings page, for instance, shares those alerts with
 * name-saving and the cache toggle, so the hook must not own that state).
 */

import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import {
  listDevices,
  removeDevice as apiRemoveDevice,
  onKeyhiveStateChanged,
  onRendezvousEvent,
  type DeviceInfo,
} from './keyhive-api';

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

  return { devices, refresh, removeDevice };
}
