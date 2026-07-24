import { generateDefaultDeviceName } from './lib/device-name';

/**
 * Per-device friendly names, keyed by device agentId.
 *
 * Direct twin of contact-names.ts, but keyed by *device* agentId rather than
 * user-group id: it holds this device's own name plus peer device names learned
 * during the device-link rendezvous. Same optimistic-cache + worker-dispatch
 * shape so a failed persist rolls back and surfaces instead of silently
 * diverging from the persisted store.
 */

// --- Dispatch hook (injected from worker-api.ts to avoid circular imports) ---

type DeviceNamesDispatch = (type: 'set-device-name' | 'remove-device-name', agentId: string, name?: string) => Promise<void>;
let dispatch: DeviceNamesDispatch | null = null;

export function setDeviceNamesDispatch(fn: DeviceNamesDispatch): void {
  dispatch = fn;
}

// --- In-memory cache (populated by worker via applyDeviceNamesFromWorker) ---

let cache: Record<string, string> = {};

/** Replace the entire cache. Called by worker-api.ts on `device-names-updated`. */
export function applyDeviceNamesFromWorker(names: Record<string, string>): void {
  cache = { ...names };
}

export function getDeviceName(agentId: string): string | undefined {
  return cache[agentId];
}

/** Return a snapshot of all saved device names (agentId → name). */
export function getAllDeviceNames(): Record<string, string> {
  return { ...cache };
}

/**
 * The effective name for a device: the stored name, else a generated default
 * (📱/💻 + browser). The generated default only describes *this* browser, so
 * pass `allowDefault: false` for a remote device whose name we haven't learned.
 */
export function resolveDeviceName(agentId: string, allowDefault = true): string | undefined {
  return cache[agentId] ?? (allowDefault ? generateDefaultDeviceName() : undefined);
}

/**
 * Persist a device name (see setContactName for the optimistic-cache contract).
 * A blank name delegates to removeDeviceName so it falls back to the default.
 */
export async function setDeviceName(agentId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    await removeDeviceName(agentId);
    return;
  }
  const prev = cache[agentId];
  cache[agentId] = trimmed;
  try {
    await dispatch?.('set-device-name', agentId, trimmed);
  } catch (err) {
    if (prev === undefined) delete cache[agentId];
    else cache[agentId] = prev;
    throw err;
  }
}

export async function removeDeviceName(agentId: string): Promise<void> {
  const prev = cache[agentId];
  delete cache[agentId];
  try {
    await dispatch?.('remove-device-name', agentId);
  } catch (err) {
    if (prev !== undefined) cache[agentId] = prev;
    throw err;
  }
}
